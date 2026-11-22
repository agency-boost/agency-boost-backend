import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ANNOUNCEMENT, type AnnouncementAudience } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can, type Permission } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { OWNERS_PROJECTION, ownerUserIdsOf, type WithOwners } from '@/modules/tenants/kpm-owners';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Announcement, AnnouncementDocument } from './announcement.schema';
import { ANNOUNCEMENTS_REFUSALS as SAY } from './announcements.messages';

/** Who an announcement goes to, as the request names it. */
export interface AudienceInput {
  audience: AnnouncementAudience;
  companyIds?: string[];
  kpmIds?: string[];
}

/** One person it reaches: their account, and the KPM their copy is filed under. */
export interface Recipient {
  userId: string;
  kpmId: string;
  membershipId: string | null;
}

/** One sent announcement, as the section lists it. */
export interface AnnouncementView {
  announcementId: string;
  message: string;
  audience: AnnouncementAudience;
  chosen: string[];
  recipientCount: number;
  sentBy: { userId: string; fullName: string | null };
  sentAt: string;
}

/** A KPM an announcement can reach: live and active — a suspended or archived KPM's people cannot read it. */
const REACHABLE_KPM = { deletedAt: null, status: 'active' } as const;

/**
 * ***Pengumuman*** (P19.23-T6 AC-4; ADR-0279; spec §10: *"to all owners, all members, or selected companies / KPMs;
 * preview, send"*).
 *
 * - **Who** (`ANNOUNCEMENT.AUDIENCES`): `owners` — the Owner of every live, active KPM; `members` — every active member
 *   of every live, active KPM; `selected` — every active member of the KPMs chosen and of every live, active KPM of the
 *   companies chosen. **Each person once**, however many of their KPMs it reaches (the inbox is a person's), filed
 *   under the first. **Test accounts are neither counted nor sent to** (ADR-0267 §1: they are never counted anywhere).
 * - **Preview** answers how many people that is now — *"Kirim ke 8 owner"* — and writes nothing.
 * - **Send** writes each person's notification (`platform.announcement`, in-app only) through `NotificationService`, so
 *   their muted templates apply as anywhere; then records the send (`announcements`) and audits `announcement.sent` in
 *   the platform's log with the audience, the count and the message. An audience of nobody is `409
 *   ANNOUNCEMENT_NO_RECIPIENTS` and nothing is sent or recorded.
 *
 * Platform-level: the KPMs and companies are the platform's own collections, and the members are read through the
 * repository's named cross-tenant method (invariant §1). The Super Admin's alone.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectModel(Announcement.name) private readonly announcements: Model<AnnouncementDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private require(ctx: RequestContext, permission: Permission): void {
    if (!can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  /** **`GET /admin/platform/announcements`**: the newest `ANNOUNCEMENT.LIST_SIZE` sent. */
  async list(ctx: RequestContext): Promise<AnnouncementView[]> {
    this.require(ctx, 'announcement:read');
    const rows = await this.announcements
      .find({ deletedAt: null })
      .sort({ sentAt: -1, _id: -1 })
      .limit(ANNOUNCEMENT.LIST_SIZE)
      .exec();
    return this.viewsOf(rows);
  }

  /** **`POST /admin/platform/announcements/preview`**: how many people the audience reaches now. Writes nothing. */
  async preview(ctx: RequestContext, input: AudienceInput): Promise<{ audience: AnnouncementAudience; recipients: number }> {
    this.require(ctx, 'announcement:send');
    return { audience: input.audience, recipients: (await this.recipients(ctx, input)).length };
  }

  /** **`POST /admin/platform/announcements`**: send it, record it, audit it. */
  async send(ctx: RequestContext, input: AudienceInput & { message: string }): Promise<AnnouncementView> {
    this.require(ctx, 'announcement:send');
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (message === '' || message.length > ANNOUNCEMENT.MESSAGE_MAX_LENGTH) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.message, { field: 'message' });
    }
    const people = await this.recipients(ctx, input);
    if (people.length === 0) {
      throw new DomainException(ErrorCode.ANNOUNCEMENT_NO_RECIPIENTS, SAY.ANNOUNCEMENT_NO_RECIPIENTS.nobody, HttpStatus.CONFLICT);
    }

    const sentAt = this.clock.now();
    const selected = input.audience === 'selected';
    const row = await this.announcements.create({
      message,
      audience: input.audience,
      companyIds: selected ? unique(input.companyIds) : [],
      kpmIds: selected ? unique(input.kpmIds) : [],
      recipientCount: people.length,
      sentByUserId: ctx.userId,
      sentAt,
      deletedAt: null,
    });
    const announcementId = String(row._id);
    for (const person of people) {
      await this.notifications.send({
        userId: person.userId,
        kpmId: person.kpmId,
        ...(person.membershipId ? { membershipId: person.membershipId } : {}),
        templateId: NotificationTemplate.PLATFORM_ANNOUNCEMENT,
        payload: { announcementId, message },
      });
    }
    await this.audit.record(ctx, {
      action: 'announcement.sent',
      targetCollection: 'announcements',
      targetId: announcementId,
      after: {
        audience: input.audience,
        companyIds: row.companyIds,
        kpmIds: row.kpmIds,
        recipientCount: people.length,
        message,
      },
    });
    return (await this.viewsOf([row]))[0];
  }

  /**
   * **The people an audience reaches, each once** — the order it is sent in: by KPM, then by person, so the same
   * audience reads the same way twice.
   */
  async recipients(ctx: RequestContext, input: AudienceInput): Promise<Recipient[]> {
    const companyIds = unique(input.companyIds);
    const kpmIds = unique(input.kpmIds);
    if (input.audience === 'selected' && companyIds.length === 0 && kpmIds.length === 0) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.chooseSome, { field: 'companyIds' });
    }
    const scope = input.audience === 'selected'
      ? { ...REACHABLE_KPM, $or: [{ _id: { $in: kpmIds } }, { companyId: { $in: companyIds } }] }
      : REACHABLE_KPM;
    const offices = await this.kpms.find(scope, OWNERS_PROJECTION).sort({ _id: 1 }).lean().exec() as unknown as
      ({ _id: unknown } & WithOwners)[];
    if (offices.length === 0) return [];

    const seen = new Set<string>();
    const once = (list: Recipient[]) => list.filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)));

    if (input.audience === 'owners') {
      // Every owner of every KPM (ADR-0285 §5), each once.
      const owners = offices.flatMap((o) => ownerUserIdsOf(o).map((userId) => ({ userId, kpmId: String(o._id) })));
      const accounts = await this.users
        .find(
          { _id: { $in: owners.map((o) => o.userId) }, deletedAt: null, status: { $ne: 'deactivated' }, ...NOT_A_TEST_ACCOUNT },
          { _id: 1 },
        )
        .lean()
        .exec();
      const live = new Set((accounts as unknown as { _id: unknown }[]).map((u) => String(u._id)));
      return once(owners.filter((o) => live.has(o.userId)).map((o) => ({ ...o, membershipId: null })));
    }

    const rows = await this.memberships.listMembershipsAcrossTenants(
      ctx, offices.map((o) => String(o._id)), { status: 'active', ...NOT_A_TEST_ACCOUNT },
    );
    const sorted = [...rows].sort((a, b) => String(a.kpmId).localeCompare(String(b.kpmId))
      || String(a.userId).localeCompare(String(b.userId)));
    return once(sorted.map((m) => ({ userId: String(m.userId), kpmId: String(m.kpmId), membershipId: String(m._id) })));
  }

  /** The list's lines: who sent each, and with `selected` the names of what was chosen. */
  private async viewsOf(rows: AnnouncementDocument[]): Promise<AnnouncementView[]> {
    const senderIds = [...new Set(rows.map((r) => r.sentByUserId))];
    const firmIds = [...new Set(rows.flatMap((r) => r.companyIds))];
    const officeIds = [...new Set(rows.flatMap((r) => r.kpmIds))];
    const [senders, firms, offices] = await Promise.all([
      senderIds.length ? this.users.find({ _id: { $in: senderIds } }, { fullName: 1 }).lean().exec() : [],
      firmIds.length ? this.companies.find({ _id: { $in: firmIds } }, { name: 1 }).lean().exec() : [],
      officeIds.length ? this.kpms.find({ _id: { $in: officeIds } }, { code: 1, branchName: 1 }).lean().exec() : [],
    ]);
    const nameOf = new Map((senders as unknown as { _id: unknown; fullName?: string }[]).map((u) => [String(u._id), u.fullName ?? null]));
    const firmName = new Map((firms as unknown as { _id: unknown; name?: string }[]).map((c) => [String(c._id), c.name ?? '']));
    const officeName = new Map((offices as unknown as { _id: unknown; code?: string; branchName?: string }[])
      .map((k) => [String(k._id), `KPM ${k.code ?? ''} · ${k.branchName ?? ''}`]));
    return rows.map((r) => ({
      announcementId: String(r._id),
      message: r.message,
      audience: r.audience,
      chosen: [
        ...r.companyIds.map((id) => firmName.get(id)).filter((n): n is string => Boolean(n)),
        ...r.kpmIds.map((id) => officeName.get(id)).filter((n): n is string => Boolean(n)),
      ],
      recipientCount: r.recipientCount,
      sentBy: { userId: r.sentByUserId, fullName: nameOf.get(r.sentByUserId) ?? null },
      sentAt: r.sentAt.toISOString(),
    }));
  }
}

/** The ids, once each, in the order given. */
function unique(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}
