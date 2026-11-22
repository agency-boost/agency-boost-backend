import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { AuditService } from '@/modules/audit/audit.service';
import { invitationStateOf } from '@/modules/org/invitation-state';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import type { HierarchyRole } from '@/modules/org/membership.schema';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { Kpm, type KpmDocument } from './kpm.schema';
import { HAS_NO_OWNER, isOwnerOf, ownerEntry, ownersInOrder, ownerUserIdsOf } from './kpm-owners';
import { KPM_OWNERS_REFUSALS } from './kpm-owners.messages';
import { TENANTS_MESSAGES } from './tenants.messages';

/** What `add` may be told beyond who and where. */
export interface AddOwnerOptions {
  /**
   * **A caller's undo stack** — provisioning's (`TenantService.createKpm`), and *Tambah user*'s new KPM with its first
   * owner (P19.28): when this wrote, it pushes the step that takes the owner off again, so the caller's rollback leaves
   * no owner behind. Nothing is pushed when nothing was written (the person was an owner already).
   */
  undo?: Array<() => Promise<unknown>>;
  /** Only while the KPM has no owner yet — a WhatsApp claim (OD-420): somebody else first, and nothing is written. */
  onlyWhileNone?: boolean;
  /** More for the audit row's `after`: `accountCreated`, `via: 'whatsapp_claim'`, … */
  auditAfter?: Record<string, unknown>;
  /**
   * **Who granted it, when that is not the caller** (P19.28; ADR-0286 §2): *Tambah user*'s invitation is accepted by the
   * invitee, whose own context makes the call, and the grant is the inviter's — `owners[].addedByUserId` names them, not
   * the invitee. Absent, the caller (`null` when they add themselves).
   */
  addedByUserId?: string | null;
}

/** **One owner as a screen lists them** (P19.27-T2 AC-1, T4 AC-1): *KPM Owner · n*'s row. */
export interface KpmOwnerView {
  userId: string;
  /** Their live membership in this KPM, or `null` for an owner who has none (a row from before ADR-0285, say). */
  membershipId: string | null;
  fullName: string;
  agentCode: string | null;
  /** Their class (`ab` · `aab` · `agent`) for the orange label, or `null` with no membership. */
  role: HierarchyRole | null;
  photoUrl: string | null;
  /** *Owner sejak <Mon YYYY>*: when they became an owner, ISO. */
  since: string;
  /**
   * `active` — signed in; `invited` — *Diundang*: invited and never signed in; `not_invited` — never invited, never
   * signed in (`invitationStateOf`, the one rule, ADR-0248 §4).
   */
  state: 'active' | 'invited' | 'not_invited';
}

/** `KpmOwnerView[]` and what the reader may do with them: the *KPM Owner · n* section's whole answer. */
export interface KpmOwnerList {
  owners: KpmOwnerView[];
  /** The reader may add and remove owners here: an owner of this KPM, or the Super Admin inside it. Never an Admin. */
  canManage: boolean;
}

/**
 * **A KPM's owners, added and removed** (P19.27-T1 AC-1, AC-4; [ADR-0285](../../../../docs/04-adr/0285-a-kpm-has-one-or-more-owners.md);
 * F-2 (21 Nov)). The one writer of `kpms.owners`.
 *
 * - **`add`** makes a member of the KPM one of its owners: idempotent (an owner already is answered as one, nothing
 *   written), refusing somebody who is not a member — active or invited (`pending`) — with `404`, as a person of
 *   another KPM is (a `403` would confirm them). Audited `kpm.owner_added`. It pushes its own undo onto a caller's stack
 *   (`AddOwnerOptions.undo`), the pattern provisioning uses, so a new KPM made with its first owner rolls back whole.
 * - **`remove`** takes one off, **never the last** (`409 KPM_LAST_OWNER`): one conditional update on the KPM row, so two
 *   owners removing each other at once leave one. Audited `kpm.owner_removed`. The person stays a member, their rung and
 *   leader as they were.
 *
 * **Who may call them** is the caller's: the routes (`kpm_owner:grant` / `kpm_owner:revoke`, an owner of the KPM or the
 * Super Admin inside it — never a KPM Admin, who meets `PERM_OWNER_ONLY` at the guard), provisioning (`kpm:create`), a
 * KPM request's approval (`kpm_request:decide`) and a WhatsApp claim (the person claiming). Every check that asks *"is
 * this person an owner"* reads `kpm-owners.ts`; nothing else writes the list.
 */
@Injectable()
export class KpmOwnersService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /** Each owner's photo as a signed link. Optional: without it every row draws initials. */
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
  ) {}

  /** A context scoped to `kpmId` for its memberships: the caller's own when it names that KPM, else the Super Admin's. */
  private inKpm(ctx: RequestContext, kpmId: string): RequestContext {
    return ctx.kpmId === kpmId ? ctx : RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);
  }

  private async liveKpm(kpmId: string): Promise<KpmDocument> {
    const kpm = isValidObjectId(kpmId) ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec() : null;
    if (!kpm) throw new NotFoundException('KPM');
    return kpm;
  }

  /**
   * **Make `userId` an owner of `kpmId`** (ADR-0285 §1). `404 KPM` for a KPM that is not there; `404 Membership` for a
   * person with no live membership in it (an owner is a member — an invited one included). Answers whether it wrote:
   * `false` for somebody who was an owner already, or — `onlyWhileNone` — a KPM that had one meanwhile.
   */
  async add(ctx: RequestContext, kpmId: string, userId: string, options: AddOwnerOptions = {}): Promise<{ added: boolean }> {
    const kpm = await this.liveKpm(kpmId);
    const member = await this.memberships.findOne(this.inKpm(ctx, kpmId), {
      userId, status: { $in: ['active', 'pending'] },
    });
    if (!member) throw new NotFoundException('Membership');
    if (isOwnerOf(kpm, userId)) return { added: false };

    const before = ownerUserIdsOf(kpm);
    const entry = ownerEntry(userId, this.clock.now(), options.addedByUserId !== undefined
      ? options.addedByUserId
      : ctx.auditActors.actorUserId === userId ? null : ctx.auditActors.actorUserId);
    const written = await this.kpms.updateOne(
      { _id: kpmId, deletedAt: null, 'owners.userId': { $ne: userId }, ...(options.onlyWhileNone ? HAS_NO_OWNER : {}) },
      // An owner named with no email waited here (ADR-0212 §3); the KPM has one now, so the record goes — as it did when
      // the one owner was set.
      { $push: { owners: entry }, $set: { pendingOwner: null } },
    ).exec();
    if (written.modifiedCount === 0) return { added: false };
    options.undo?.push(() => this.kpms.updateOne({ _id: kpmId }, { $pull: { owners: { userId } } }).exec());

    const user = await this.users.findOne({ _id: userId }).select('email').lean().exec() as { email?: string } | null;
    await this.audit.record(ctx, {
      action: 'kpm.owner_added',
      targetCollection: 'kpms',
      targetId: kpmId,
      targetMembershipId: String(member._id),
      before: { owners: before },
      after: { owners: [...before, userId], userId, email: user?.email ?? null, ...options.auditAfter },
    });
    return { added: true };
  }

  /**
   * **Take `userId` off `kpmId`'s owners** (ADR-0285 §4). `404 KPM` for a KPM that is not there, `404 Membership` for
   * somebody who is not one of its owners, `409 KPM_LAST_OWNER` for the only one. They stay a member.
   */
  async remove(ctx: RequestContext, kpmId: string, userId: string): Promise<void> {
    const kpm = await this.liveKpm(kpmId);
    if (!isOwnerOf(kpm, userId)) throw new NotFoundException('Membership');
    const before = ownerUserIdsOf(kpm);
    const written = await this.kpms.updateOne(
      // At least two owners at the moment of the write — the guard and the write are one operation on the KPM row.
      { _id: kpmId, deletedAt: null, 'owners.userId': userId, 'owners.1': { $exists: true } },
      { $pull: { owners: { userId } } },
    ).exec();
    if (written.modifiedCount === 0) {
      const now = await this.liveKpm(kpmId);
      if (!isOwnerOf(now, userId)) throw new NotFoundException('Membership');
      const user = await this.users.findOne({ _id: userId }).select('fullName').lean().exec() as { fullName?: string } | null;
      throw new DomainException(
        ErrorCode.KPM_LAST_OWNER,
        KPM_OWNERS_REFUSALS.KPM_LAST_OWNER.lastOwner({ name: user?.fullName ?? render(TENANTS_MESSAGES.unknownPerson, ctx.reader) }),
        HttpStatus.CONFLICT,
        { kpmId, userId },
      );
    }
    const member = await this.memberships.findOne(this.inKpm(ctx, kpmId), { userId, status: { $in: ['active', 'pending'] } });
    await this.audit.record(ctx, {
      action: 'kpm.owner_removed',
      targetCollection: 'kpms',
      targetId: kpmId,
      targetMembershipId: member ? String(member._id) : null,
      before: { owners: before },
      after: { owners: before.filter((id) => id !== userId), userId },
    });
  }

  /**
   * **`POST /members/:membershipId/owner`** — *Jadikan owner* (P19.27-T2 AC-2, T4 AC-1): the member of the reader's KPM,
   * an owner. `404` for a membership that is not in it. Answers the owners as the section lists them.
   */
  async addMember(ctx: RequestContext, membershipId: string): Promise<KpmOwnerList> {
    const kpmId = this.requireOffice(ctx);
    const member = await this.memberships.findById(ctx, membershipId);
    if (!member || (member.status !== 'active' && member.status !== 'pending')) throw new NotFoundException('Membership');
    await this.add(ctx, kpmId, member.userId);
    return this.list(ctx, kpmId);
  }

  /**
   * **`DELETE /members/:membershipId/owner`** — *Hapus sebagai owner* (P19.27-T2 AC-3, T4 AC-1). An owner never removes
   * themselves (`403 PERM_OWNER_ONLY`, OD-452): another owner, or the Super Admin, does. `409 KPM_LAST_OWNER` for the last.
   */
  async removeMember(ctx: RequestContext, membershipId: string): Promise<KpmOwnerList> {
    const kpmId = this.requireOffice(ctx);
    const member = await this.memberships.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    if (!ctx.isSuperAdminInKpm && member.userId === ctx.auditActors.actorUserId) {
      throw new DomainException(
        ErrorCode.PERM_OWNER_ONLY, KPM_OWNERS_REFUSALS.PERM_OWNER_ONLY.ownOwnership, HttpStatus.FORBIDDEN, { membershipId },
      );
    }
    await this.remove(ctx, kpmId, member.userId);
    return this.list(ctx, kpmId);
  }

  /**
   * **The owners as *KPM Owner · n* lists them** (P19.27-T2 AC-1, T4 AC-1), in order of `since`: photo, class, NAME, since
   * when, and *Diundang* while they have not signed in. Read in the KPM's own scope — the reader's, or the Super Admin's
   * platform read of it.
   */
  async list(ctx: RequestContext, kpmId: string): Promise<KpmOwnerList> {
    const kpm = await this.liveKpm(kpmId);
    const owners = ownersInOrder(kpm);
    // `kpm_owner:grant`'s own answer: an owner of this KPM, or the Super Admin — never an Admin, never a support session.
    const canManage = can(ctx, 'kpm_owner:grant') && (ctx.isSuperAdmin || ctx.kpmId === kpmId);
    if (owners.length === 0) return { owners: [], canManage };
    const ids = owners.map((o) => o.userId);
    const [users, rows] = await Promise.all([
      this.users.find({ _id: { $in: ids.filter((id) => isValidObjectId(id)) } })
        .select('fullName lastLoginAt emailVerifiedAt avatarUrl').lean().exec() as Promise<{
          _id: unknown; fullName: string; lastLoginAt?: Date | null; emailVerifiedAt?: Date | null; avatarUrl?: string | null;
        }[]>,
      this.memberships.find(this.readScope(ctx, kpmId), { userId: { $in: ids }, status: { $in: ['active', 'pending'] } }),
    ]);
    const userOf = new Map(users.map((u) => [String(u._id), u]));
    const rowOf = new Map(rows.map((m) => [m.userId, m]));
    const photos = this.avatarLinks ? await this.avatarLinks.linksFor(users.map((u) => u.avatarUrl)) : new Map<string, string>();
    const unknown = render(TENANTS_MESSAGES.unknownPerson, ctx.reader);
    return {
      canManage,
      owners: owners.map((o) => {
        const user = userOf.get(o.userId);
        const row = rowOf.get(o.userId);
        const state = invitationStateOf(user, row?.invitedAt);
        return {
          userId: o.userId,
          membershipId: row ? String(row._id) : null,
          fullName: user?.fullName ?? unknown,
          agentCode: row?.agentCode ?? null,
          role: row?.role ?? null,
          photoUrl: user?.avatarUrl ? (photos.get(user.avatarUrl) ?? null) : null,
          since: new Date(o.since).toISOString(),
          state: state === 'signed_in' ? 'active' : state,
        };
      }),
    };
  }

  /** The KPM a tenant route acts in: the reader's own (`X-Kpm-Id` for the Super Admin inside it). */
  private requireOffice(ctx: RequestContext): string {
    if (!ctx.kpmId) throw new NotFoundException('KPM');
    return ctx.kpmId;
  }

  /** Reading a KPM's memberships: the reader's scope inside it, else the Super Admin's platform read of it. */
  private readScope(ctx: RequestContext, kpmId: string): RequestContext {
    if (ctx.kpmId === kpmId) return ctx;
    return ctx.isSuperAdmin ? RequestContext.platformRead(ctx, kpmId) : this.inKpm(ctx, kpmId);
  }
}
