import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NoMembershipException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import {
  INVITES, isLeaderClass, normalisePhone, roleClassOf, shortOfRung, tierOfRung, type RoleClass,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { ORG_REFUSALS } from '@/modules/org/org.messages';
import { JoinRequestRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { UserInvitationRepository } from '@/modules/org/user-invitation.repository';
import {
  userInvitationStateOf, type UserInvitationDocument, type UserInvitationState,
} from '@/modules/org/user-invitation.schema';
import { can } from '@/modules/rbac/permissions';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { ADD_USER_REFUSALS } from './add-user.messages';
import { Company, type CompanyDocument } from './company.schema';
import { isOwnerOf } from './kpm-owners';
import { KpmOwnersService, type AddOwnerOptions } from './kpm-owners.service';
import { Kpm, type KpmDocument } from './kpm.schema';
import { OrgLevelService, type OrgLevelRow } from './org-level.service';
import { isEnded } from './subscription';
import { TenantService } from './tenant.service';

const SAY = ADD_USER_REFUSALS;
/** The token's random part: 192 bits, as a member invite's and an owner claim's. */
const TOKEN_BYTES = 24;
/** How many new links one invitation may be given an hour — a runaway button, not a person correcting a number. */
export const USER_INVITATION_RESEND_LIMIT = 10;

/** A rung of the KPM's company ladder, as the sheet's *Peran* chips draw it. */
export interface RungChoice {
  code: string;
  label: string;
  /** `ab` and `aab` draw the orange label (ADR-0156). */
  class: RoleClass;
}

/** A leader the sheet's *Leader* list offers: an active AB or AAB of the KPM, test accounts never. */
export interface LeaderChoice {
  membershipId: string;
  fullName: string;
  role: RungChoice;
  isOwner: boolean;
  photoUrl: string | null;
}

/** *Pilih KPM*'s next step: who the person can be in that KPM (`GET /user-invitations/options`). */
export interface AddUserOptions {
  kpm: { id: string; code: string; branch: string; company: { id: string; name: string } } | null;
  /** The company of a new KPM, when that is what was asked (`companyId`). */
  company: { id: string; name: string } | null;
  /** The ladder, junior rung first: *Agent · AAB · AB* on Prudential's. */
  roles: RungChoice[];
  /** The senior rung's code: the one with no leader, and a new KPM's first owner's. */
  seniorCode: string | null;
  leaders: LeaderChoice[];
  /** *Jadikan KPM Owner* is the reader's to switch: the Super Admin, or an owner of this KPM. Never a KPM Admin. */
  mayMakeOwner: boolean;
  /** *＋ KPM baru* is the reader's: the Super Admin alone (`kpm:create`). */
  mayMakeKpm: boolean;
}

/** An invitation as every answer names it. */
export interface UserInvitationView {
  id: string;
  kpmId: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: { code: string; class: RoleClass };
  leaderMembershipId: string | null;
  makeOwner: boolean;
  state: UserInvitationState;
  /** *Diundang · <date>*: when it was sent or last sent again, ISO. */
  invitedAt: string;
  expiresAt: string;
}

/** What a KPM an answer names says about it. */
export interface PlacedKpm {
  id: string;
  code: string;
  branch: string;
  /** Made in this step (*＋ KPM baru*). */
  created: boolean;
}

/** ***Tambah user***'s answer: the invitation, and the link the reader's own WhatsApp sends (OD-359). */
export interface UserInvited {
  outcome: 'invited';
  invitation: UserInvitationView;
  /** The one-time link, in this answer and nowhere else; never logged, never stored raw. */
  link: string;
  kpm: PlacedKpm;
}

/** ***Masukkan***'s answer: the membership, and what the notice's WhatsApp link needs (OD-442). */
export interface UserPlaced {
  outcome: 'placed';
  membershipId: string;
  kpm: PlacedKpm;
  person: { userId: string; fullName: string; phone: string | null; email: string };
  /** The app's address, for the WhatsApp message that goes with the in-app notice. */
  appLink: string;
}

/** The invitation link's banner (`GET /user-invites/:token`): which KPM, of which company, for whom. */
export interface UserInviteBanner {
  kpmName: string;
  kpmCode: string;
  companyName: string;
  fullName: string;
  roleLabel: string;
  makeOwner: boolean;
  expiresAt: string;
}

/** What accepting answers: the KPM the person is now an *Aktif* member of. */
export interface UserInviteAccepted {
  kpmId: string;
  kpmName: string;
  membershipId: string;
}

/** Where the person goes, settled before anything is written. */
interface Placement {
  rung: { code: string; label: string; class: RoleClass };
  leader: MembershipDocument | null;
  makeOwner: boolean;
}

interface PlacementInput {
  kpmId?: string;
  newKpm?: { branchName: string; companyId: string };
  role?: string;
  leaderMembershipId?: string;
  makeOwner?: boolean;
}

export const userInviteTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = (kpmId: string) => `${kpmId}.${randomBytes(TOKEN_BYTES).toString('base64url')}`;
/** Where a link points: the app's page that opens it. */
export const userInviteLink = (appOrigin: string, token: string) =>
  `${appOrigin.replace(/\/+$/, '')}/user-invite/${encodeURIComponent(token)}`;

/**
 * ***Tambah user* and *Masukkan*** (P19.28-T1; [ADR-0286](../../../../docs/04-adr/0286-tambah-user-and-masukkan-one-sheet-adds-and-places-people-in-any-kpm.md);
 * the 21 November brief, F-1). One sheet, three doors (Anggota, a KPM page's *Anggota* card, *All members*' *Undang
 * anggota*), and these writes behind it:
 *
 * - **`add`** — *Tambah user*: an invitation (`userInvitations`) carrying the placement, and its one-time link. The
 *   person's membership is made when they accept it (`accept`), *Aktif* at once. The Super Admin in any KPM; an Owner or
 *   a KPM Admin in their own (another is `404`).
 * - **`place`** — *Masukkan ke KPM*: an account that exists and is in no KPM (*Belum ada KPM*) placed now, *Aktif* at
 *   once — the account is theirs already — with an in-app notice (OD-442). The Super Admin's alone.
 * - **`newKpm`** on either: the KPM made from its company's template (`TenantService.createKpm`), the person on its
 *   senior rung, its first owner. **Nothing is left on a failure**: there are no transactions (ADR-0002), so every write
 *   pushes its undo, a failure runs them newest first and discards the KPM (`TenantService.discardHalfMade`) — the
 *   provisioning pattern.
 * - **`resend`** and **`cancel`**; **`banner`** and **`accept`** for the link.
 *
 * Every write is audited in the KPM's log: who, when, the KPM, before → after.
 */
@Injectable()
export class AddUserService {
  private readonly logger = new Logger(AddUserService.name);

  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly invitations: UserInvitationRepository,
    private readonly memberships: MembershipRepository,
    private readonly history: MembershipHistoryRepository,
    private readonly joinRequests: JoinRequestRepository,
    private readonly hierarchy: HierarchyService,
    private readonly orgLevels: OrgLevelService,
    private readonly tenants: TenantService,
    private readonly owners: KpmOwnersService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
  ) {}

  // ------------------------------------------------------------------ who may, and where

  /** The Super Admin as themselves — never in a support session, which only looks. */
  private platform(ctx: RequestContext): boolean {
    return ctx.isSuperAdmin && !ctx.isImpersonating;
  }

  /**
   * **The KPM a write lands in** (ADR-0286 §4): the Super Admin names any (or works inside one); an Owner or a KPM Admin
   * their own, and naming another is `404` — exactly as a KPM that is not there.
   */
  private reach(ctx: RequestContext, kpmId?: string): string {
    if (this.platform(ctx)) {
      const id = kpmId ?? ctx.kpmId;
      if (!id) throw new InvalidRequestException(SAY.VALIDATION_FAILED.kpmNeeded, { field: 'kpmId' });
      return id;
    }
    if (!ctx.kpmId) throw new NoMembershipException();
    const steward = ctx.membership?.status === 'active' && (ctx.membership.isKpmOwner || ctx.membership.isKpmAdmin);
    if (!steward || (kpmId !== undefined && kpmId !== ctx.kpmId)) throw new NotFoundException('KPM');
    return ctx.kpmId;
  }

  /** A context scoped to `kpmId`: the caller's own when it names that KPM, else the Super Admin's in it. */
  private inKpm(ctx: RequestContext, kpmId: string): RequestContext {
    return ctx.kpmId === kpmId && !ctx.isSuperAdmin
      ? ctx
      : RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);
  }

  private async liveKpm(kpmId: string): Promise<KpmDocument> {
    const kpm = isValidObjectId(kpmId) ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec() : null;
    // An archived KPM takes nobody, and reads as no KPM at all.
    if (!kpm || kpm.status === 'archived') throw new NotFoundException('KPM');
    return kpm;
  }

  private async companyNamed(companyId: string): Promise<CompanyDocument> {
    const company = isValidObjectId(companyId)
      ? await this.companies.findOne({ _id: companyId, deletedAt: null }).exec()
      : null;
    if (!company) throw new NotFoundException('Company');
    return company;
  }

  private async ladderOf(companyId: string): Promise<OrgLevelRow[]> {
    return (await this.orgLevels.laddersByCompany([companyId])).get(companyId) ?? [];
  }

  private rungOf(row: { code: string; label: string; leaderTier?: OrgLevelRow['leaderTier'] }): RungChoice {
    return { code: row.code, label: row.label, class: roleClassOf(tierOfRung(row)) };
  }

  /** *Jadikan KPM Owner* is the reader's: the Super Admin or an owner of the KPM (`kpm_owner:grant`), never a KPM Admin. */
  private mayMakeOwner(ctx: RequestContext, kpmId: string | null): boolean {
    if (!can(ctx, 'kpm_owner:grant')) return false;
    return this.platform(ctx) || (kpmId !== null && ctx.kpmId === kpmId && ctx.membership?.isKpmOwner === true);
  }

  /** `403 PERM_DENIED` for an owner-making step the reader may not take — a KPM Admin's (ADR-0285 §4; ADR-0286 §5). */
  private ownerIsOwners(): DomainException {
    return new DomainException(ErrorCode.PERM_DENIED, SAY.PERM_DENIED.ownerIsOwners, HttpStatus.FORBIDDEN, {
      permission: 'kpm_owner:grant',
    });
  }

  // ------------------------------------------------------------------ the sheet's choices

  /**
   * **Who the person can be in the chosen KPM** (`GET /user-invitations/options`): its company's ladder for *Peran*, its
   * active ABs and AABs for *Leader*, and what the reader may switch. With `companyId` and no `kpmId` — *＋ KPM baru*, the
   * Super Admin's — the company's ladder alone.
   */
  async options(ctx: RequestContext, query: { kpmId?: string; companyId?: string }): Promise<AddUserOptions> {
    if (query.companyId && !query.kpmId) {
      if (!can(ctx, 'kpm:create') || !this.platform(ctx)) throw new PermissionDeniedException('kpm:create');
      const company = await this.companyNamed(query.companyId);
      const ladder = await this.ladderOf(query.companyId);
      return {
        kpm: null,
        company: { id: String(company._id), name: company.name },
        roles: ladder.map((r) => this.rungOf(r)),
        seniorCode: ladder.find((r) => tierOfRung(r) === 'senior')?.code ?? null,
        leaders: [],
        mayMakeOwner: true,
        mayMakeKpm: true,
      };
    }
    const kpmId = this.reach(ctx, query.kpmId);
    const kpm = await this.liveKpm(kpmId);
    const company = await this.companies.findOne({ _id: kpm.companyId }).select('name').lean().exec() as { name?: string } | null;
    const ladder = await this.ladderOf(kpm.companyId);
    const rungs = new Map(ladder.map((r) => [r.code, this.rungOf(r)]));
    const leaders = await this.memberships.find(this.inKpm(ctx, kpmId), {
      status: 'active', role: { $in: ['ab', 'aab'] }, ...NOT_A_TEST_ACCOUNT,
    });
    const people = leaders.length === 0 ? [] : await this.users
      .find({ _id: { $in: leaders.map((l) => l.userId).filter((id) => isValidObjectId(id)) } })
      .select('fullName avatarUrl').lean().exec() as { _id: unknown; fullName: string; avatarUrl?: string | null }[];
    const byUser = new Map(people.map((p) => [String(p._id), p]));
    const photos = this.avatarLinks
      ? await this.avatarLinks.linksFor(people.map((p) => p.avatarUrl ?? null))
      : new Map<string, string>();
    const choices: LeaderChoice[] = leaders.map((l) => {
      const person = byUser.get(l.userId);
      return {
        membershipId: String(l._id),
        fullName: person?.fullName ?? '',
        role: rungs.get(l.orgLevelCode) ?? { code: l.orgLevelCode, label: l.orgLevelCode, class: l.role },
        isOwner: isOwnerOf(kpm, l.userId),
        photoUrl: person?.avatarUrl ? photos.get(person.avatarUrl) ?? null : null,
      };
    }).sort((a, b) => (a.role.class === b.role.class ? 0 : a.role.class === 'ab' ? -1 : 1)
      || a.fullName.localeCompare(b.fullName));
    return {
      kpm: {
        id: kpmId, code: kpm.code, branch: kpm.branchName, company: { id: kpm.companyId, name: company?.name ?? '' },
      },
      company: { id: kpm.companyId, name: company?.name ?? '' },
      roles: ladder.map((r) => this.rungOf(r)),
      seniorCode: ladder.find((r) => tierOfRung(r) === 'senior')?.code ?? null,
      leaders: choices,
      mayMakeOwner: this.mayMakeOwner(ctx, kpmId),
      mayMakeKpm: this.platform(ctx) && can(ctx, 'kpm:create'),
    };
  }

  // ------------------------------------------------------------------ the placement, settled before anything is written

  /**
   * **The rung, the leader and the owner switch**, checked against the KPM's company ladder and its members. A new KPM's
   * person is its senior rung, with no leader, and its first owner — whatever was sent.
   */
  private async settle(
    ctx: RequestContext, kpm: KpmDocument | null, companyId: string, input: PlacementInput,
  ): Promise<Placement> {
    const ladder = await this.ladderOf(companyId);
    if (input.newKpm) {
      const senior = ladder.find((r) => tierOfRung(r) === 'senior')
        ?? await this.orgLevels.resolveByCode(companyId, await this.orgLevels.entryRungCode(companyId, 'owner'));
      return { rung: this.rungOf(senior), leader: null, makeOwner: true };
    }
    if (!input.role) throw new InvalidRequestException(SAY.VALIDATION_FAILED.roleNeeded, { field: 'role' });
    // `ORG_LEVEL_NOT_ON_LADDER` for a code the company does not publish, the refusal every rung write meets.
    const rung = this.rungOf(await this.orgLevels.resolveByCode(companyId, input.role));
    const kpmId = String(kpm!._id);

    let leader: MembershipDocument | null = null;
    if (rung.class === 'ab') {
      if (input.leaderMembershipId) {
        throw new InvalidRequestException(
          SAY.VALIDATION_FAILED.noLeaderForSenior({ rung: shortOfRung(rung) }), { field: 'leaderMembershipId' },
        );
      }
    } else {
      if (!input.leaderMembershipId) {
        throw new InvalidRequestException(SAY.VALIDATION_FAILED.leaderNeeded, { field: 'leaderMembershipId' });
      }
      leader = await this.memberships.findById(this.inKpm(ctx, kpmId), input.leaderMembershipId);
      if (!leader || leader.status !== 'active' || !isLeaderClass(leader.role)) {
        throw new DomainException(
          ErrorCode.ORG_LEADER_NOT_IN_KPM, ORG_REFUSALS.ORG_LEADER_NOT_IN_KPM.notAMember, HttpStatus.UNPROCESSABLE_ENTITY,
          { leaderMembershipId: input.leaderMembershipId },
        );
      }
    }
    const makeOwner = input.makeOwner === true;
    if (makeOwner && !this.mayMakeOwner(ctx, kpmId)) throw this.ownerIsOwners();
    return { rung, leader, makeOwner };
  }

  /** The account a WhatsApp number or an email already names, if one does. */
  private async accountFor(phone: string, email: string | null): Promise<UserDocument | null> {
    const or: Record<string, unknown>[] = [{ phone }];
    if (email) or.push({ email });
    return this.users.findOne({ $or: or, deletedAt: null }).exec();
  }

  /**
   * **An account that cannot be added or placed** (ADR-0286 §3): the AgencyBoost team's, or one already *Aktif* in a KPM
   * — v1 is one live membership a person. Another KPM is named to the Super Admin alone. A *pending* membership — the
   * person registered to a KPM and nobody placed them (*Belum ada KPM*) — does not refuse: placing them ends it.
   */
  private async refuseAccount(
    ctx: RequestContext, account: UserDocument, kpmId: string | null,
  ): Promise<MembershipDocument | null> {
    const refuse = (sentence: Sentence<'ORG_AGENT_ALREADY_TAGGED'>, details: Record<string, unknown> = {}) =>
      new DomainException(ErrorCode.ORG_AGENT_ALREADY_TAGGED, sentence, HttpStatus.CONFLICT, details);
    if (account.platformRole === 'super_admin') throw refuse(SAY.ORG_AGENT_ALREADY_TAGGED.notThisPerson);
    const live = await this.memberships.liveForUserAnywhere(String(account._id));
    if (!live || live.status !== 'active') return live;
    if (live.kpmId === kpmId) {
      throw refuse(SAY.ORG_AGENT_ALREADY_TAGGED.memberHere({ name: account.fullName }), { reason: 'member_here' });
    }
    if (this.platform(ctx)) {
      const other = await this.kpms.findOne({ _id: live.kpmId }).select('branchName').lean().exec() as { branchName?: string } | null;
      throw refuse(
        SAY.ORG_AGENT_ALREADY_TAGGED.memberElsewhereNamed({ name: account.fullName, kpm: other?.branchName ?? live.kpmId }),
        { reason: 'member_elsewhere', kpmId: live.kpmId },
      );
    }
    throw refuse(SAY.ORG_AGENT_ALREADY_TAGGED.memberElsewhere, { reason: 'member_elsewhere' });
  }

  /** `409 TENANT_COMPANY_MISMATCH` unless the account is of the KPM's company and holds an agent code (ADR-0017). */
  private async refuseCompany(account: UserDocument, companyId: string): Promise<void> {
    if (account.companyId === companyId && account.agentCode) return;
    const sentence = !account.agentCode || !account.companyId
      ? SAY.TENANT_COMPANY_MISMATCH.noAgentCode({ name: account.fullName })
      : SAY.TENANT_COMPANY_MISMATCH.otherCompany({
        name: account.fullName,
        userCompany: (await this.companies.findOne({ _id: account.companyId }).select('name').lean().exec() as { name?: string } | null)?.name ?? '',
        kpmCompany: (await this.companies.findOne({ _id: companyId }).select('name').lean().exec() as { name?: string } | null)?.name ?? '',
      });
    throw new DomainException(ErrorCode.TENANT_COMPANY_MISMATCH, sentence, HttpStatus.CONFLICT, {
      userCompanyId: account.companyId ?? null, kpmCompanyId: companyId,
    });
  }

  // ------------------------------------------------------------------ Tambah user

  /**
   * ***Tambah user*** (P19.28-T1 AC-1, AC-3): an invitation to the KPM — or to a KPM made here — and its link. Refused
   * before anything is written: the number, the KPM, the rung, the leader, the owner switch, an account already *Aktif*
   * somewhere, an invitation already waiting for the number. With `newKpm`, a failure after the KPM was made discards it.
   */
  async add(
    ctx: RequestContext,
    input: PlacementInput & { fullName: string; phone: string; email?: string },
    appOrigin: string,
  ): Promise<UserInvited> {
    const phone = normalisePhone(input.phone);
    if (!phone) throw new InvalidRequestException(SAY.VALIDATION_FAILED.phone, { field: 'phone' });
    const email = input.email?.trim().toLowerCase() || null;
    if (input.kpmId && input.newKpm) throw new InvalidRequestException(SAY.VALIDATION_FAILED.kpmOrNewKpm, { field: 'newKpm' });
    if (input.newKpm && !(this.platform(ctx) && can(ctx, 'kpm:create'))) {
      throw new DomainException(ErrorCode.PERM_DENIED, SAY.PERM_DENIED.newKpmIsPlatforms, HttpStatus.FORBIDDEN, {
        permission: 'kpm:create',
      });
    }

    let kpm: KpmDocument | null = null;
    let companyId: string;
    if (input.newKpm) {
      companyId = String((await this.companyNamed(input.newKpm.companyId))._id);
    } else {
      kpm = await this.liveKpm(this.reach(ctx, input.kpmId));
      companyId = kpm.companyId;
    }
    const account = await this.accountFor(phone, email);
    if (account) await this.refuseAccount(ctx, account, kpm ? String(kpm._id) : null);
    const placement = await this.settle(ctx, kpm, companyId, input);
    if (kpm && await this.invitations.exists(this.inKpm(ctx, String(kpm._id)), { phone, status: 'pending' })) {
      throw this.numberWaiting();
    }

    let created = false;
    if (input.newKpm) {
      const made = await this.tenants.createKpm(ctx, { companyId, branchName: input.newKpm.branchName });
      kpm = await this.liveKpm(made._id);
      created = true;
    }
    const kpmId = String(kpm!._id);
    const scoped = this.inKpm(ctx, kpmId);
    const now = this.clock.now();
    const token = newToken(kpmId);
    let row: UserInvitationDocument;
    try {
      row = await this.invitations.create(scoped, {
        fullName: input.fullName.trim(),
        phone,
        email,
        userId: account ? String(account._id) : null,
        orgLevelCode: placement.rung.code,
        roleClass: placement.rung.class,
        leaderMembershipId: placement.leader ? String(placement.leader._id) : null,
        makeOwner: placement.makeOwner,
        newKpm: created,
        invitedByUserId: ctx.auditActors.actorUserId,
        invitedByMembershipId: ctx.membershipId,
        tokenHash: userInviteTokenHash(token),
        status: 'pending',
        invitedAt: now,
        expiresAt: this.expiryFrom(now),
      } as Partial<UserInvitationDocument>);
    } catch (err) {
      if (created) await this.tenants.discardHalfMade(ctx, kpmId, 'user_invitation.failed');
      // Two adds of one number at once both pass the check; the index stops the second, as the same 409.
      if ((err as { code?: number }).code === 11000) throw this.numberWaiting();
      throw err;
    }

    await this.audit.record(scoped, {
      action: 'user_invitation.created',
      targetCollection: 'userInvitations',
      targetId: String(row._id),
      before: null,
      // Who and where — never the number or the email (PDP, UU 27/2022).
      after: {
        kpmId, fullName: row.fullName, role: row.orgLevelCode, leaderMembershipId: row.leaderMembershipId,
        makeOwner: row.makeOwner, newKpm: created, existingAccount: row.userId !== null,
      },
    });
    return {
      outcome: 'invited',
      invitation: this.view(row, now),
      link: userInviteLink(appOrigin, token),
      kpm: { id: kpmId, code: kpm!.code, branch: kpm!.branchName, created },
    };
  }

  private numberWaiting(): DomainException {
    return new DomainException(ErrorCode.ORG_INVITE_PENDING, SAY.ORG_INVITE_PENDING.numberWaiting, HttpStatus.CONFLICT, {
      field: 'phone',
    });
  }

  private expiryFrom(at: Date): Date {
    return new Date(at.getTime() + INVITES.EXPIRY_DAYS * 24 * 60 * 60_000);
  }

  private view(row: UserInvitationDocument, now: Date): UserInvitationView {
    return {
      id: String(row._id),
      kpmId: row.kpmId,
      fullName: row.fullName,
      phone: row.phone,
      email: row.email ?? null,
      role: { code: row.orgLevelCode, class: row.roleClass },
      leaderMembershipId: row.leaderMembershipId ?? null,
      makeOwner: row.makeOwner === true,
      state: userInvitationStateOf(row, now),
      invitedAt: row.invitedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  // ------------------------------------------------------------------ Masukkan

  /**
   * ***Masukkan ke KPM*** (P19.28-T1 AC-2, AC-3): an account with no active membership — registered and not placed — is
   * placed now, *Aktif* at once, an existing agent (ADR-0169 §6: no activation starts). A membership they were waiting
   * in (registered to a KPM, nobody placed them) is ended and soft-deleted once the new one stands, and its open join
   * requests cancelled. The person is told in the app (OD-442). **One unit**: each write pushes its undo, and a failure
   * runs them — and discards a KPM made here — before the refusal is answered.
   */
  async place(ctx: RequestContext, userId: string, input: PlacementInput, appOrigin: string): Promise<UserPlaced> {
    if (!this.platform(ctx) || !can(ctx, 'member:place')) throw new PermissionDeniedException('member:place');
    if (input.kpmId && input.newKpm) throw new InvalidRequestException(SAY.VALIDATION_FAILED.kpmOrNewKpm, { field: 'newKpm' });
    if (input.newKpm && !can(ctx, 'kpm:create')) throw new PermissionDeniedException('kpm:create');
    const account = isValidObjectId(userId) ? await this.users.findOne({ _id: userId, deletedAt: null }).exec() : null;
    if (!account) throw new NotFoundException('User');

    let kpm: KpmDocument | null = null;
    let companyId: string;
    if (input.newKpm) {
      companyId = String((await this.companyNamed(input.newKpm.companyId))._id);
    } else {
      kpm = await this.liveKpm(this.reach(ctx, input.kpmId));
      companyId = kpm.companyId;
    }
    const waiting = await this.refuseAccount(ctx, account, kpm ? String(kpm._id) : null);
    await this.refuseCompany(account, companyId);
    const placement = await this.settle(ctx, kpm, companyId, input);

    const now = this.clock.now();
    const undo: Array<() => Promise<unknown>> = [];
    let created = false;
    let membership: MembershipDocument;
    const waitingCtx = waiting ? RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, waiting.kpmId) : null;
    try {
      if (input.newKpm) {
        const made = await this.tenants.createKpm(ctx, { companyId, branchName: input.newKpm.branchName });
        kpm = await this.liveKpm(made._id);
        created = true;
      }
      const kpmId = String(kpm!._id);
      const scoped = this.inKpm(ctx, kpmId);
      if (waiting && waitingCtx) {
        // Ended first — one live membership a person — and soft-deleted only once the new one stands.
        await this.memberships.updateById(waitingCtx, String(waiting._id), { $set: { status: 'removed', removedAt: now } });
        undo.push(() => this.memberships.updateById(waitingCtx, String(waiting._id), { $set: { status: 'pending', removedAt: null } }));
      }
      membership = await this.join(scoped, String(account._id), placement, null, undo);
    } catch (err) {
      await this.rollBack(undo);
      if (created && kpm) await this.tenants.discardHalfMade(ctx, String(kpm._id), 'member.place_failed');
      throw err;
    }

    const kpmId = String(kpm!._id);
    const scoped = this.inKpm(ctx, kpmId);
    if (waiting && waitingCtx) await this.retireWaiting(waitingCtx, waiting, now);
    await this.notifyPlaced(String(account._id), kpm!);
    await this.audit.record(scoped, {
      action: 'member.placed',
      targetCollection: 'memberships',
      targetId: String(membership._id),
      targetMembershipId: String(membership._id),
      before: waiting
        ? { kpmId: waiting.kpmId, membershipId: String(waiting._id), status: 'pending' }
        : { kpmId: null },
      after: {
        kpmId, userId: String(account._id), role: placement.rung.code,
        leaderMembershipId: placement.leader ? String(placement.leader._id) : null,
        makeOwner: placement.makeOwner, newKpm: created, status: 'active',
      },
    });
    return {
      outcome: 'placed',
      membershipId: String(membership._id),
      kpm: { id: kpmId, code: kpm!.code, branch: kpm!.branchName, created },
      person: { userId: String(account._id), fullName: account.fullName, phone: account.phone ?? null, email: account.email },
      appLink: appOrigin.replace(/\/+$/, ''),
    };
  }

  /**
   * **The membership, and the owner if asked** — the step `place` and `accept` share. An existing agent joined today
   * (ADR-0169 §6), under the leader settled; its undo, and `KpmOwnersService.add`'s, pushed onto `undo`.
   */
  private async join(
    scoped: RequestContext, userId: string, placement: Placement, registeredBy: string | null,
    undo: Array<() => Promise<unknown>>,
    /** For an owner granted through an invitation: who granted it, and the audit row's `via` (ADR-0286 §2). */
    granted: Pick<AddOwnerOptions, 'addedByUserId' | 'auditAfter'> = {},
  ): Promise<MembershipDocument> {
    const leaderId = placement.leader ? String(placement.leader._id) : null;
    const membership = await this.hierarchy.create(scoped, {
      userId,
      role: placement.rung.code,
      leaderId,
      status: 'active',
      registeredByMembershipId: registeredBy,
      joining: { joinedAs: 'existing_agent' },
    });
    const id = String(membership._id);
    undo.push(async () => {
      const at = this.clock.now();
      await this.history.updateMany(scoped, { membershipId: id }, { $set: { deletedAt: at } });
      await this.memberships.updateById(scoped, id, { $set: { status: 'removed', removedAt: at, deletedAt: at } });
      await this.hierarchy.refreshCounts(scoped, leaderId);
    });
    if (placement.makeOwner) await this.owners.add(scoped, scoped.kpmId as string, userId, { undo, ...granted });
    return membership;
  }

  /** Each undo, newest first. One that fails is logged and the rest still run: leave as little behind as can be left. */
  private async rollBack(undo: Array<() => Promise<unknown>>): Promise<void> {
    for (const step of [...undo].reverse()) {
      try {
        await step();
      } catch (err) {
        this.logger.error({ err }, 'an add or a placement could not undo one of its writes');
      }
    }
  }

  /** The membership they waited in, once the new one stands: soft-deleted, its history and open join requests closed. */
  private async retireWaiting(ctx: RequestContext, waiting: MembershipDocument, at: Date): Promise<void> {
    const id = String(waiting._id);
    await this.joinRequests.updateMany(ctx, { membershipId: id, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: at } });
    await this.history.updateMany(ctx, { membershipId: id }, { $set: { deletedAt: at } });
    await this.memberships.updateById(ctx, id, { $set: { deletedAt: at } });
  }

  /** ***Masukkan*'s notice** (OD-442): in the app. The WhatsApp half is the Super Admin's own link, on the screen. */
  private async notifyPlaced(userId: string, kpm: KpmDocument): Promise<void> {
    try {
      await this.notifications.send({
        userId,
        kpmId: String(kpm._id),
        templateId: NotificationTemplate.MEMBER_PLACED,
        payload: { kpmName: kpm.branchName, kpmCode: kpm.code },
      });
    } catch (err) {
      // The placement stands: the person sees their KPM on their next sign-in either way.
      this.logger.error({ err, kpmId: String(kpm._id) }, 'the placement notice could not be sent');
    }
  }

  // ------------------------------------------------------------------ Kirim ulang · Batalkan

  /** The invitation a write names: the Super Admin's in any KPM, an Owner's or an Admin's in their own (else `404`). */
  private async invitationFor(ctx: RequestContext, id: string): Promise<{ row: UserInvitationDocument; scoped: RequestContext }> {
    let row: UserInvitationDocument | null;
    if (this.platform(ctx)) {
      row = await this.invitations.findByIdAcrossTenants(ctx, id);
    } else {
      const kpmId = this.reach(ctx);
      row = await this.invitations.findById(this.inKpm(ctx, kpmId), id);
    }
    if (!row) throw new NotFoundException('Invite');
    return { row, scoped: this.inKpm(ctx, row.kpmId) };
  }

  private decided(row: UserInvitationDocument): DomainException {
    return new DomainException(
      ErrorCode.ORG_REQUEST_ALREADY_DECIDED,
      row.status === 'accepted' ? SAY.ORG_REQUEST_ALREADY_DECIDED.accepted : SAY.ORG_REQUEST_ALREADY_DECIDED.cancelled,
      HttpStatus.CONFLICT,
      { status: row.status },
    );
  }

  /**
   * ***Kirim ulang*** (P19.28-T1 AC-4): a new link and `INVITES.EXPIRY_DAYS` more; the old link opens nothing now; the
   * row reads *Diundang · hari ini*. An expired invitation is revived; an accepted or cancelled one is `409`.
   */
  async resend(ctx: RequestContext, id: string, appOrigin: string, limiter: (key: string) => void): Promise<{
    invitation: UserInvitationView; link: string;
  }> {
    const { row, scoped } = await this.invitationFor(ctx, id);
    // An owner-making link is the owners' to hand out again, never a KPM Admin's (S1 of the 19.28 permission review).
    if (row.makeOwner && !this.mayMakeOwner(ctx, row.kpmId)) throw this.ownerIsOwners();
    if (row.status !== 'pending') throw this.decided(row);
    limiter(`user-invitation-resend:${id}`);
    const now = this.clock.now();
    const token = newToken(row.kpmId);
    const set = { tokenHash: userInviteTokenHash(token), invitedAt: now, expiresAt: this.expiryFrom(now), resentAt: now };
    if (!(await this.invitations.updateIfWaiting(scoped, id, set))) {
      throw this.decided((await this.invitations.findById(scoped, id)) ?? row);
    }
    await this.audit.record(scoped, {
      action: 'user_invitation.resent',
      targetCollection: 'userInvitations',
      targetId: id,
      before: { invitedAt: row.invitedAt, expiresAt: row.expiresAt },
      after: { invitedAt: now, expiresAt: set.expiresAt },
    });
    Object.assign(row, set);
    return { invitation: this.view(row, now), link: userInviteLink(appOrigin, token) };
  }

  /** ***Batalkan***: its link opens nothing from now on. The row stays, cancelled — the record of who invited whom. */
  async cancel(ctx: RequestContext, id: string): Promise<{ invitation: UserInvitationView }> {
    const { row, scoped } = await this.invitationFor(ctx, id);
    if (row.makeOwner && !this.mayMakeOwner(ctx, row.kpmId)) throw this.ownerIsOwners();
    if (row.status !== 'pending') throw this.decided(row);
    const now = this.clock.now();
    const set = { status: 'cancelled', cancelledAt: now, cancelledByUserId: ctx.auditActors.actorUserId };
    if (!(await this.invitations.updateIfWaiting(scoped, id, set))) {
      throw this.decided((await this.invitations.findById(scoped, id)) ?? row);
    }
    await this.audit.record(scoped, {
      action: 'user_invitation.cancelled',
      targetCollection: 'userInvitations',
      targetId: id,
      before: { status: 'pending' },
      after: { status: 'cancelled' },
    });
    Object.assign(row, set);
    return { invitation: this.view(row, now) };
  }

  // ------------------------------------------------------------------ the link

  private dead(sentence: Sentence<'NOT_FOUND'>): DomainException {
    return new DomainException(ErrorCode.NOT_FOUND, sentence, HttpStatus.NOT_FOUND);
  }

  /** The invitation a live link opens, and its KPM — or the plain-words `404` that says why it opens nothing. */
  private async open(token: string): Promise<{ row: UserInvitationDocument; kpm: KpmDocument; read: RequestContext }> {
    const [kpmId, secret] = (token ?? '').split('.');
    if (!secret || !isValidObjectId(kpmId)) throw this.dead(SAY.NOT_FOUND.linkNotValid);
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    // A KPM archived, or ended past its grace, takes nobody: to the holder of the link it reads as a dead link.
    if (!kpm || kpm.status === 'archived' || isEnded(kpm, this.clock)) throw this.dead(SAY.NOT_FOUND.linkNotValid);
    const read = RequestContext.tenantRead(kpmId, 'user-invite');
    const row = await this.invitations.findOne(read, { tokenHash: userInviteTokenHash(token) });
    if (!row) throw this.dead(SAY.NOT_FOUND.linkNotValid);
    const state = userInvitationStateOf(row, this.clock.now());
    if (state === 'accepted') throw this.dead(SAY.NOT_FOUND.used);
    if (state === 'cancelled') throw this.dead(SAY.NOT_FOUND.cancelled);
    if (state === 'expired') throw this.dead(SAY.NOT_FOUND.expired);
    return { row, kpm, read };
  }

  /** **The link's banner** — public: the person opening it may have no account yet. A dead link is `404`. */
  async banner(token: string): Promise<UserInviteBanner> {
    const { row, kpm } = await this.open(token);
    const company = await this.companies.findOne({ _id: kpm.companyId }).select('name').lean().exec() as { name?: string } | null;
    const rung = (await this.ladderOf(kpm.companyId)).find((r) => r.code === row.orgLevelCode);
    return {
      kpmName: kpm.branchName,
      kpmCode: kpm.code,
      companyName: company?.name ?? '',
      fullName: row.fullName,
      roleLabel: rung?.label ?? row.orgLevelCode,
      makeOwner: row.makeOwner === true,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /**
   * **Accept, signed in** (P19.28-T1 AC-4): the membership the invitation carries, *Aktif* at once — and an owner when it
   * says so. Checked **before the link is spent**, so a refusal leaves it working: the account the invitation names (if
   * it names one), the KPM's company and an agent code, no active membership anywhere, the leader still a member. Then
   * the link is taken (single use) and the membership written; a failure there gives the link back.
   */
  async accept(ctx: RequestContext, token: string): Promise<UserInviteAccepted> {
    const { row, kpm, read } = await this.open(token);
    const refuse = (sentence: Sentence<'ORG_AGENT_ALREADY_TAGGED'>) =>
      new DomainException(ErrorCode.ORG_AGENT_ALREADY_TAGGED, sentence, HttpStatus.CONFLICT);
    if (ctx.isSuperAdmin) throw refuse(SAY.ORG_AGENT_ALREADY_TAGGED.notThisPerson);
    const user = isValidObjectId(ctx.userId) ? await this.users.findOne({ _id: ctx.userId, deletedAt: null }).exec() : null;
    if (!user) throw new NotFoundException('User');
    const userId = String(user._id);
    if (!this.isFor(row, user)) throw this.dead(SAY.NOT_FOUND.forSomebodyElse);
    if (user.companyId !== kpm.companyId || !user.agentCode) {
      const company = await this.companies.findOne({ _id: kpm.companyId }).select('name').lean().exec() as { name?: string } | null;
      throw new DomainException(
        ErrorCode.TENANT_COMPANY_MISMATCH, SAY.TENANT_COMPANY_MISMATCH.acceptOtherCompany({ company: company?.name ?? '' }),
        HttpStatus.CONFLICT,
      );
    }
    const live = await this.memberships.liveForUserAnywhere(userId);
    if (live?.status === 'active') throw refuse(SAY.ORG_AGENT_ALREADY_TAGGED.alreadyPlaced);

    const kpmId = String(kpm._id);
    // Somebody writing themselves into a KPM they are joining (`joiningTenant`), never a Super Admin's context.
    const scoped = RequestContext.joiningTenant(ctx, kpmId);
    let leader: MembershipDocument | null = null;
    if (row.leaderMembershipId) {
      leader = await this.memberships.findById(scoped, row.leaderMembershipId);
      if (!leader || leader.status !== 'active') {
        throw new DomainException(
          ErrorCode.ORG_LEADER_NOT_IN_KPM, ORG_REFUSALS.ORG_LEADER_NOT_IN_KPM.notAMember, HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    const rung = (await this.ladderOf(kpm.companyId)).find((r) => r.code === row.orgLevelCode)
      ?? await this.orgLevels.resolveByCode(kpm.companyId, row.orgLevelCode);
    // An owner is made only while whoever invited may still make one (ADR-0286 §2); else they join as a member.
    const makeOwner = row.makeOwner === true && await this.inviterMayStillMakeOwner(row, kpm, scoped);

    const now = this.clock.now();
    const id = String(row._id);
    if (!(await this.invitations.updateIfWaiting(read, id, { status: 'accepted', acceptedAt: now }))) {
      throw this.dead(SAY.NOT_FOUND.used);
    }
    const undo: Array<() => Promise<unknown>> = [];
    const waitingCtx = live ? RequestContext.joiningTenant(ctx, live.kpmId) : null;
    let membership: MembershipDocument;
    try {
      if (live && waitingCtx) {
        await this.memberships.updateById(waitingCtx, String(live._id), { $set: { status: 'removed', removedAt: now } });
        undo.push(() => this.memberships.updateById(waitingCtx, String(live._id), { $set: { status: 'pending', removedAt: null } }));
      }
      membership = await this.join(
        scoped, userId, { rung: this.rungOf(rung), leader, makeOwner }, row.invitedByMembershipId, undo,
        { addedByUserId: row.invitedByUserId, auditAfter: { via: 'user_invitation', invitationId: String(row._id), invitedByUserId: row.invitedByUserId } },
      );
    } catch (err) {
      await this.rollBack(undo);
      await this.invitations.updateById(read, id, { $set: { status: 'pending', acceptedAt: null } });
      throw err;
    }
    await this.invitations.updateById(read, id, { $set: { acceptedMembershipId: String(membership._id) } });
    if (live && waitingCtx) await this.retireWaiting(waitingCtx, live, now);
    // Their number, where the account has none: the one the invitation was sent to.
    if (!user.phone) await this.users.updateOne({ _id: userId, phone: null }, { $set: { phone: row.phone } }).exec();
    await this.audit.record(scoped, {
      action: 'user_invitation.accepted',
      targetCollection: 'userInvitations',
      targetId: id,
      targetMembershipId: String(membership._id),
      before: { status: 'pending' },
      after: {
        status: 'accepted', kpmId, userId, membershipId: String(membership._id), role: row.orgLevelCode,
        makeOwner,
        // Asked for, and not given: whoever invited can no longer make an owner (ADR-0286 §2).
        ...(row.makeOwner === true && !makeOwner ? { ownerDropped: 'inviter_may_not_make_owner' } : {}),
      },
    });
    return { kpmId, kpmName: kpm.branchName, membershipId: String(membership._id) };
  }

  /**
   * **Whether this account may take this link** (ADR-0286 §2; S2 of the 19.28 permission review):
   *
   * - an invitation bound to an account (the number or email named one): that account alone;
   * - **an owner-making invitation to somebody new**: the account the invitation reached — its WhatsApp number, or its
   *   email when the invitation has one — or an account made after the invitation, with no other number on file
   *   (somebody who signed up through the link; the invited number is written to it on acceptance). An existing account
   *   of somebody else is refused, as *"for another account"*;
   * - **an ordinary invitation to somebody new stays a bearer link**: whoever holds it and passes the checks below joins.
   */
  private isFor(row: UserInvitationDocument, user: UserDocument): boolean {
    if (row.userId) return row.userId === String(user._id);
    if (row.makeOwner !== true) return true;
    const phone = normalisePhone(user.phone);
    if (phone !== null && phone === row.phone) return true;
    if (row.email && user.email?.toLowerCase() === row.email) return true;
    const sent = (row as unknown as { createdAt?: Date }).createdAt;
    const made = (user as unknown as { createdAt?: Date }).createdAt;
    return phone === null && Boolean(sent && made) && made!.getTime() >= sent!.getTime();
  }

  /**
   * **Whether whoever invited may still make an owner** (ADR-0286 §2): the Super Admin who sent it, still one and still
   * active; or an owner of the KPM, still an owner and still an active member of it. Asked when the link is accepted, so
   * an owner demoted since, or gone, makes nobody an owner — the person joins as a member, and the audit row says why.
   */
  private async inviterMayStillMakeOwner(row: UserInvitationDocument, kpm: KpmDocument, scoped: RequestContext): Promise<boolean> {
    if (!isValidObjectId(row.invitedByUserId)) return false;
    const inviter = await this.users.findOne({ _id: row.invitedByUserId, deletedAt: null })
      .select('platformRole status').lean().exec() as { platformRole?: string; status?: string } | null;
    if (!inviter || inviter.status === 'deactivated') return false;
    if (inviter.platformRole === 'super_admin') return true;
    if (!isOwnerOf(kpm, row.invitedByUserId)) return false;
    return this.memberships.exists(scoped, { userId: row.invitedByUserId, status: 'active' });
  }
}
