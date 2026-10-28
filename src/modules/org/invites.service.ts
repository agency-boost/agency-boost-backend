import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, INVITES } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { scopeFor } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { isEnded } from '@/modules/tenants/subscription';
import { displayNameOf } from '@/modules/users/display-name';
import { User, UserDocument } from '@/modules/users/user.schema';
import { ActivationStarter, startActivation } from './activation-starter.port';
import { ApprovalsService } from './approvals.service';
import { HierarchyService } from './hierarchy.service';
import { MemberInviteDocument } from './member-invite.schema';
import { MemberNames } from './member-names.service';
import { MembershipRepository } from './membership.repository';
import { MembershipDocument } from './membership.schema';
import { JoinRequestRepository, MemberInviteRepository } from './org.repositories';
import { TransfersService, type RequestedTransferView } from './transfers.service';

const DAY_MS = 86_400_000;
/** 24 random bytes: 192 bits, written in base64url after the office's id. Guessing one is not a plan. */
const TOKEN_BYTES = 24;

/** The token's SHA-256, which is all a row keeps of it. */
export const inviteTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** What *+ Add agent* sends (ADR-0170 §1): the four fields, and — for the Owner or an Admin — whose unit. */
export interface AddAgentInput {
  agentCode: string;
  fullName: string;
  phone: string;
  /** An office date; the office's today when omitted (ADR-0169). */
  joinDate?: string;
  /** The Owner's or an Admin's choice of unit. A leader's own unit is theirs whether or not it is named. */
  leaderMembershipId?: string;
}

/** One invite as `/new-hires` draws it, *Invited, waiting to join* or *Invite expired*. Never its link. */
export interface InviteView {
  inviteId: string;
  fullName: string;
  agentCode: string;
  phone: string;
  joinDate: LocalDate;
  status: 'pending' | 'expired';
  expiresAt: string;
  invitedAt: string;
  leader: { membershipId: string; name: string };
  /** An account holds the code: the link opens the signed-in page, where they accept with one button. */
  existingAccount: boolean;
}

/** An invite with the link that carries it — only ever in the answer that made the token. */
export interface SharedInvite {
  invite: InviteView;
  link: string;
}

/** What *+ Add agent* did (ADR-0170 §2, §4): one of three, and what it made. */
export type AddAgentResult =
  | ({ outcome: 'invited' } & SharedInvite)
  | { outcome: 'linked'; member: { membershipId: string; fullName: string } }
  | { outcome: 'transfer_requested'; transfer: RequestedTransferView };

/** The banner a link opens (AC-4), before anybody is signed in: who, where, and what is filled in for them. */
export interface InviteBanner {
  leaderName: string;
  kpm: { code: string; branchName: string };
  companyId: string;
  companyName: string;
  agentCode: string;
  joinDate: LocalDate;
  fullName: string;
  existingAccount: boolean;
  expiresAt: string;
}

/**
 * **+ Add agent, and the invites it makes** (ADR-0170 §1–§4, P18.96-T3 AC-1 to AC-4; `functional/org-hierarchy.md`,
 * *Adding an agent*).
 *
 * **One entry point decides by the agent code**, within the office's company (the insurer issued it, ADR-0017):
 *
 * | The code is held by | It does |
 * |---|---|
 * | nobody | **invites** them: a link to registration, 14 days to accept |
 * | an account with a pending or leaderless membership here | **links** them under the leader now, with the join date given |
 * | an account reporting to another leader here | **asks for a transfer**, which the Owner and the Admins decide |
 * | an account with no membership here | **invites** them: a link to sign in and accept |
 * | the reader | refuses, `409 ORG_CYCLE_DETECTED` |
 *
 * **Reach** (`member:invite`): an AB and an AAB add to their own unit and read, resend and cancel the invites into it;
 * the Owner and an Admin add to any active member's unit, and handle every invite of the office. Outside it, 404.
 *
 * **An invite counts in nothing until accepted** — no membership exists — and a cancelled one leaves nothing behind.
 * Its token is kept only as a hash; *Resend* makes a new one and gives it 14 days more. **Accepting** — by registering
 * on its link, or by a signed-in account the code belongs to — places the person under the leader at once through
 * `HierarchyService.create`, classified by its join date (ADR-0169), starts a new hire's activation, and tells the
 * leader. Every outcome is audited.
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly invites: MemberInviteRepository,
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly approvals: ApprovalsService,
    private readonly transfers: TransfersService,
    private readonly requests: JoinRequestRepository,
    private readonly names: MemberNames,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
    /** OD-119: an invite accepted places its person under a leader, at the Agent rung — a hire. */
    @Optional() @Inject(ActivationStarter) private readonly activations: ActivationStarter | null = null,
  ) {}

  // ---------------------------------------------------------------- + Add agent

  /** **`POST /new-hires/agents`**: the one form's one entry point. See the class for what it decides. */
  async addAgent(ctx: RequestContext, input: AddAgentInput, appOrigin: string): Promise<AddAgentResult> {
    const leader = await this.leaderFor(ctx, input.leaderMembershipId);
    // The join date first, so a refused date leaves nothing behind (ADR-0169): the office's today when omitted.
    const { joinDate } = await this.hierarchy.joining(ctx, { joinDate: input.joinDate });
    const kpm = await this.office(ctx);
    const agentCode = input.agentCode.trim();

    const holder = await this.users.findOne({ companyId: kpm.companyId, agentCode, deletedAt: null }).exec();
    if (holder) {
      if (String(holder._id) === ctx.userId) {
        throw new DomainException(
          ErrorCode.ORG_CYCLE_DETECTED,
          'That is your own agent code. Nobody joins their own unit.',
          HttpStatus.CONFLICT,
          { agentCode },
        );
      }
      const membership = await this.members.findOne(ctx, {
        userId: String(holder._id), status: { $in: ['active', 'pending'] },
      });
      if (membership) return this.forMember(ctx, membership, leader, joinDate, holder, input.fullName);
    }
    return this.invite(ctx, kpm, leader, { ...input, agentCode, joinDate }, Boolean(holder), appOrigin);
  }

  /**
   * The three outcomes for somebody already in the office: linked, refused, or a transfer asked for. A transfer is
   * answered with the name the form was given, never the account's (the P18.96 exit review, M3): the code found
   * somebody in another leader's unit, and nothing of that unit is the asker's to learn from it.
   */
  private async forMember(
    ctx: RequestContext,
    membership: MembershipDocument,
    leader: MembershipDocument,
    joinDate: LocalDate,
    holder: UserDocument,
    typedName: string,
  ): Promise<AddAgentResult> {
    const membershipId = String(membership._id);
    const leaderId = String(leader._id);
    if (membership.leaderId === null) {
      // No leader here: linked at once, as a tag is — every refusal a tag meets, the leader in the tagger's place.
      await this.approvals.placeUnder(ctx, membershipId, leaderId, joinDate, 'add_agent');
      return { outcome: 'linked', member: { membershipId, fullName: displayNameOf(holder) ?? holder.fullName } };
    }
    if (membership.leaderId === leaderId) {
      const who = displayNameOf(holder);
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        who ? `${who} already reports to this leader.` : 'They already report to this leader.',
        HttpStatus.CONFLICT,
        { membershipId },
      );
    }
    // Reports to somebody else: a move, which no leader makes directly (ADR-0170 §4).
    return { outcome: 'transfer_requested', transfer: await this.transfers.request(ctx, membership, leader, typedName) };
  }

  /** Make an invite: the code checked across the company, a token made, the row written and audited. */
  private async invite(
    ctx: RequestContext,
    kpm: KpmDocument,
    leader: MembershipDocument,
    input: AddAgentInput & { joinDate: LocalDate },
    existingAccount: boolean,
    appOrigin: string,
  ): Promise<AddAgentResult> {
    const now = this.clock.now();
    await this.expireStale(ctx, { agentCode: input.agentCode });
    if (await this.invites.pendingCodeAcrossTenants(kpm.companyId, input.agentCode, now)) {
      throw invitePending(input.agentCode);
    }

    const token = newToken(String(kpm._id));
    let row: MemberInviteDocument;
    try {
      row = await this.invites.create(ctx, {
        companyId: kpm.companyId,
        leaderMembershipId: String(leader._id),
        invitedByMembershipId: ctx.membershipId!,
        agentCode: input.agentCode,
        fullName: input.fullName.trim(),
        phone: input.phone.trim(),
        joinDate: input.joinDate,
        tokenHash: inviteTokenHash(token),
        status: 'pending',
        expiresAt: new Date(now.getTime() + INVITES.EXPIRY_DAYS * DAY_MS),
        existingAccount,
      });
    } catch (err) {
      // Two forms at once for one code: the partial unique index lets one through.
      if ((err as { code?: number }).code === 11000) throw invitePending(input.agentCode);
      throw err;
    }

    await this.audit.record(ctx, {
      action: 'member_invite.created',
      targetCollection: 'memberInvites',
      targetId: String(row._id),
      targetMembershipId: String(leader._id),
      after: { leaderMembershipId: String(leader._id), agentCode: input.agentCode, joinDate: input.joinDate, existingAccount },
    });
    const [view] = await this.views(ctx, [row]);
    return { outcome: 'invited', invite: view, link: inviteLink(appOrigin, token, existingAccount) };
  }

  // ---------------------------------------------------------------- the leader's invites

  /** **`GET /new-hires/invites`**: the invites the reader reaches that wait — pending, or expired and resendable. */
  async list(ctx: RequestContext): Promise<{ today: LocalDate; invites: InviteView[] }> {
    await this.expireStale(ctx, {});
    const rows = await this.invites.find(
      ctx,
      { status: { $in: ['pending', 'expired'] }, ...this.reachFilter(ctx) },
      { sort: { createdAt: -1 } },
    );
    const kpm = await this.office(ctx);
    return { today: this.clock.localDateFor(kpm.timezone ?? DEFAULT_TENANT_TIMEZONE), invites: await this.views(ctx, rows) };
  }

  /** **`POST /new-hires/invites/:inviteId/resend`**: a new link, 14 days more. The old link opens nothing now. */
  async resend(ctx: RequestContext, inviteId: string, appOrigin: string): Promise<SharedInvite> {
    await this.expireStale(ctx, {});
    const row = await this.reach(ctx, inviteId);
    if (row.status === 'accepted' || row.status === 'cancelled') throw inviteDecided(row);
    const kpm = await this.office(ctx);
    const now = this.clock.now();
    if (row.status === 'expired' && (await this.invites.pendingCodeAcrossTenants(kpm.companyId, row.agentCode, now))) {
      throw invitePending(row.agentCode);
    }
    // An account may have come to hold the code since: its link then opens the signed-in page.
    const existingAccount = (await this.users.exists({ companyId: kpm.companyId, agentCode: row.agentCode, deletedAt: null })) !== null;
    const token = newToken(String(kpm._id));
    let updated: MemberInviteDocument | null;
    try {
      updated = await this.invites.updateById(ctx, inviteId, {
        $set: {
          tokenHash: inviteTokenHash(token),
          status: 'pending',
          expiresAt: new Date(now.getTime() + INVITES.EXPIRY_DAYS * DAY_MS),
          resentAt: now,
          existingAccount,
        },
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw invitePending(row.agentCode);
      throw err;
    }
    await this.audit.record(ctx, {
      action: 'member_invite.resent',
      targetCollection: 'memberInvites',
      targetId: inviteId,
      targetMembershipId: row.leaderMembershipId,
      before: { status: row.status, expiresAt: row.expiresAt },
      after: { status: 'pending', expiresAt: updated!.expiresAt },
    });
    const [view] = await this.views(ctx, [updated!]);
    return { invite: view, link: inviteLink(appOrigin, token, existingAccount) };
  }

  /** **`DELETE /new-hires/invites/:inviteId`**: *Cancel invite*. Its link opens nothing; nothing counted it anyway. */
  async cancel(ctx: RequestContext, inviteId: string): Promise<{ today: LocalDate; invites: InviteView[] }> {
    const row = await this.reach(ctx, inviteId);
    if (row.status === 'accepted' || row.status === 'cancelled') throw inviteDecided(row);
    await this.invites.updateById(ctx, inviteId, {
      $set: { status: 'cancelled', cancelledAt: this.clock.now(), cancelledByMembershipId: ctx.membershipId },
    });
    await this.audit.record(ctx, {
      action: 'member_invite.cancelled',
      targetCollection: 'memberInvites',
      targetId: inviteId,
      targetMembershipId: row.leaderMembershipId,
      before: { status: row.status },
      after: { status: 'cancelled' },
    });
    return this.list(ctx);
  }

  // ---------------------------------------------------------------- the invitee's side

  /** **`GET /invites/:token`**: the banner, for anybody holding the link. 404 for every link that opens nothing. */
  async banner(token: string): Promise<InviteBanner> {
    const { row, kpm } = await this.open(token);
    const ctx = RequestContext.tenantRead(String(kpm._id), 'invite-link');
    const leader = await this.members.findById(ctx, row.leaderMembershipId);
    const leaderUser = leader ? await this.users.findOne({ _id: leader.userId }).exec() : null;
    const company = await this.companies.findOne({ _id: kpm.companyId }).exec();
    return {
      leaderName: displayNameOf(leaderUser) ?? 'your leader',
      kpm: { code: kpm.code, branchName: kpm.branchName },
      companyId: kpm.companyId,
      companyName: company?.name ?? '',
      agentCode: row.agentCode,
      joinDate: row.joinDate as LocalDate,
      fullName: row.fullName,
      existingAccount: row.existingAccount,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /**
   * **What registration on an invite's link is held to** (AC-4): the office's insurer and the invite's agent code,
   * which the form shows read-only and the server takes from the invite whatever arrives. 404 for a link that opens
   * nothing, before any account is made.
   */
  async forRegistration(token: string): Promise<{ companyId: string; agentCode: string }> {
    const { row, kpm } = await this.open(token);
    return { companyId: kpm.companyId, agentCode: row.agentCode };
  }

  /**
   * **A new account, made on the invite's link, joins** (AC-4): its membership in the office is active under the
   * leader at once, with the invite's join date — whether or not the email is verified yet, which still gates
   * signing in.
   */
  async acceptForNewAccount(token: string, userId: string): Promise<void> {
    const { row, kpm } = await this.open(token);
    const scoped = RequestContext.joiningTenant(new RequestContext(userId, 'none', null), String(kpm._id));
    await this.join(scoped, row, userId);
  }

  /**
   * **`POST /invites/:token/accept`**: a signed-in account the code belongs to accepts with one button (ADR-0170 §4,
   * case d). An invite for another code is 404. Somebody already in an office is refused, as a leader's code refuses
   * them: moving between offices is not something a person does to themselves.
   */
  async acceptSignedIn(ctx: RequestContext, token: string): Promise<{ kpmId: string; leaderName: string }> {
    const { row, kpm } = await this.open(token);
    const user = await this.users.findOne({ _id: ctx.userId, deletedAt: null }).exec();
    if (!user || user.companyId !== row.companyId || user.agentCode !== row.agentCode) {
      throw new NotFoundException('Invite');
    }
    if (ctx.membership) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        'You already belong to an office, so this invite cannot add you. Ask whoever runs your office to move you.',
        HttpStatus.CONFLICT,
        { kpmId: ctx.kpmId },
      );
    }
    const scoped = RequestContext.joiningTenant(ctx, String(kpm._id));
    const leaderName = await this.join(scoped, row, ctx.userId);
    return { kpmId: String(kpm._id), leaderName };
  }

  /**
   * Place the person under the invite's leader, as an Agent, active, with its join date (ADR-0169), through
   * `HierarchyService.create` — the one path that writes a membership and its first edge. Then the invite is
   * accepted, the leader told, and a new hire's activation started.
   */
  private async join(scoped: RequestContext, row: MemberInviteDocument, userId: string): Promise<string> {
    const leader = await this.members.findById(scoped, row.leaderMembershipId);
    if (!leader || leader.status !== 'active') {
      throw new DomainException(
        ErrorCode.ORG_LEADER_NOT_IN_KPM,
        'The leader who invited you is no longer in the office. Ask the office for a new invite.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    // The code is checked again at acceptance (ADR-0170 §2): it belongs to this account and nobody else's.
    const clash = await this.users.findOne({
      companyId: row.companyId, agentCode: row.agentCode, deletedAt: null, _id: { $ne: userId },
    }).exec();
    if (clash) {
      throw new DomainException(
        ErrorCode.AGENT_CODE_TAKEN,
        `Agent code ${row.agentCode} is already registered to somebody else. Ask your office to sort it out.`,
        HttpStatus.CONFLICT,
        { field: 'agentCode', agentCode: row.agentCode },
      );
    }

    /*
     * **The invite is claimed before anybody is placed** (the P18.96 exit review, L3): one write, conditional on it still
     * waiting, so of two accepts at once — a double tap, two tabs — one goes on and the other is refused `409
     * ORG_REQUEST_ALREADY_DECIDED`, never a second membership's duplicate key as a `500`. A placement refused after the
     * claim puts the invite back, waiting.
     */
    const inviteId = String(row._id);
    const acceptedAt = this.clock.now();
    const claimed = await this.invites.updateMany(
      scoped, { _id: inviteId, status: 'pending' }, { $set: { status: 'accepted', acceptedAt } },
    );
    if (claimed === 0) {
      const now = await this.invites.findById(scoped, inviteId);
      throw inviteDecided({ status: now?.status ?? 'accepted' });
    }
    let membership: MembershipDocument;
    try {
      membership = await this.hierarchy.create(scoped, {
        userId,
        role: await this.hierarchy.entryRungCode(row.kpmId, 'joiner'),
        leaderId: String(leader._id),
        status: 'active',
        recruitedByMembershipId: String(leader._id),
        joining: { joinDate: row.joinDate },
      });
    } catch (err) {
      await this.invites.updateMany(
        scoped,
        { _id: inviteId, status: 'accepted', acceptedAt, acceptedMembershipId: null },
        { $set: { status: 'pending', acceptedAt: null } },
      );
      // They are in the office already — a join that raced this one: said so, never a duplicate key.
      if ((err as { code?: number }).code === 11000) {
        throw new DomainException(
          ErrorCode.ORG_AGENT_ALREADY_TAGGED,
          'You already belong to this office, so this invite cannot add you again.',
          HttpStatus.CONFLICT,
          { kpmId: row.kpmId },
        );
      }
      throw err;
    }
    const membershipId = String(membership._id);
    await this.invites.updateById(scoped, inviteId, { $set: { acceptedMembershipId: membershipId } });
    // Their number, from the invite, where the account has none yet.
    await this.users.updateOne({ _id: userId, phone: null }, { $set: { phone: row.phone } }).exec();
    await this.requests.updateMany(
      scoped, { membershipId, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );

    const joiner = await this.users.findOne({ _id: userId }).exec();
    await this.notifications.send({
      userId: leader.userId,
      kpmId: row.kpmId,
      templateId: NotificationTemplate.MEMBER_INVITE_ACCEPTED,
      payload: { joinerName: displayNameOf(joiner) ?? row.fullName, membershipId },
    });
    await this.audit.record(scoped, {
      action: 'member_invite.accepted',
      targetCollection: 'memberInvites',
      targetId: String(row._id),
      targetMembershipId: membershipId,
      after: { leaderMembershipId: String(leader._id), joinDate: membership.joinDate, joinedAs: membership.joinedAs },
    });
    // Their activation starts in the same call that placed them (OD-119), for a new hire, failing open.
    await startActivation(this.activations, scoped, membershipId);

    const leaderUser = await this.users.findOne({ _id: leader.userId }).exec();
    return displayNameOf(leaderUser) ?? 'your leader';
  }

  /**
   * **The invite a link names, if it opens anything** — in the office its token names, and only there. Every link that
   * opens nothing is 404, each saying plainly why: a token is 192 random bits, so telling its holder whether it was
   * used or ran out tells a prober nothing they could use.
   */
  private async open(token: string): Promise<{ row: MemberInviteDocument; kpm: KpmDocument }> {
    const notValid = (message: string) => new DomainException(ErrorCode.NOT_FOUND, message, HttpStatus.NOT_FOUND);
    const unknown = notValid('This invite link is not valid. Check you opened the whole link, or ask whoever sent it for a new one.');
    const [kpmId, secret] = (token ?? '').split('.');
    if (!secret || !isValidObjectId(kpmId)) throw unknown;
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    // A suspended or ended office admits nobody, and to an outsider it reads as no office at all (ADR-0112 §3).
    if (!kpm || kpm.status !== 'active' || isEnded(kpm, this.clock)) throw unknown;

    const ctx = RequestContext.tenantRead(kpmId, 'invite-link');
    const row = await this.invites.findOne(ctx, { tokenHash: inviteTokenHash(token) });
    if (!row || row.status === 'cancelled') throw unknown;
    if (row.status === 'accepted') throw notValid('This invite was already used. Sign in instead.');
    if (row.status === 'expired' || row.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw notValid('This invite has expired. Ask whoever sent it to send it again.');
    }
    return { row, kpm };
  }

  // ---------------------------------------------------------------- reach and views

  /**
   * **The unit a person is added to** (`member:invite`): an AB's or AAB's own, and nobody else's — naming another is
   * 404, as reaching outside a grant is everywhere; the Owner's and an Admin's choice of any active member, their own
   * when they name none.
   */
  private async leaderFor(ctx: RequestContext, given?: string): Promise<MembershipDocument> {
    const me = ctx.membershipId;
    if (!ctx.kpmId || !me) throw new NotFoundException('Membership');
    const office = scopeFor(ctx, 'member:invite') === 'own-kpm';
    if (!office && given && given !== me) throw new NotFoundException('Membership');
    const id = office ? (given ?? me) : me;
    const leader = await this.members.findById(ctx, id);
    if (!leader) throw new NotFoundException('Membership');
    if (leader.status !== 'active') {
      throw new DomainException(
        ErrorCode.ORG_LEADER_NOT_IN_KPM,
        'That leader is not an active member of this office.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { leaderMembershipId: id },
      );
    }
    return leader;
  }

  /** The invites the reader may see: the office's for the Owner and an Admin, their own unit's for a leader. */
  private reachFilter(ctx: RequestContext): Record<string, unknown> {
    return scopeFor(ctx, 'member:invite') === 'own-kpm' ? {} : { leaderMembershipId: ctx.membershipId };
  }

  private async reach(ctx: RequestContext, inviteId: string): Promise<MemberInviteDocument> {
    const row = await this.invites.findOne(ctx, { _id: inviteId, ...this.reachFilter(ctx) });
    if (!row) throw new NotFoundException('Invite');
    return row;
  }

  /** Pending invites past their 14 days are marked expired, so they never block a new invite for the code. */
  private async expireStale(ctx: RequestContext, filter: Record<string, unknown>): Promise<void> {
    await this.invites.updateMany(
      ctx,
      { ...filter, status: 'pending', expiresAt: { $lte: this.clock.now() } },
      { $set: { status: 'expired' } },
    );
  }

  private async office(ctx: RequestContext): Promise<KpmDocument> {
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');
    return kpm;
  }

  private async views(ctx: RequestContext, rows: MemberInviteDocument[]): Promise<InviteView[]> {
    if (rows.length === 0) return [];
    const names = await this.names.byMembershipId(ctx, rows.map((r) => r.leaderMembershipId));
    return rows.map((r) => ({
      inviteId: String(r._id),
      fullName: r.fullName,
      agentCode: r.agentCode,
      phone: r.phone,
      joinDate: r.joinDate as LocalDate,
      status: r.status === 'expired' ? 'expired' : 'pending',
      expiresAt: r.expiresAt.toISOString(),
      invitedAt: (r.get('createdAt') as Date | undefined)?.toISOString() ?? '',
      leader: { membershipId: r.leaderMembershipId, name: names.get(r.leaderMembershipId) ?? '' },
      existingAccount: r.existingAccount,
    }));
  }
}

/** `{kpmId}.{secret}`: the office it is opened in, and 192 random bits. */
function newToken(kpmId: string): string {
  return `${kpmId}.${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/**
 * **Where a shared invite points** (AC-4): registration for somebody with no account, the signed-in page for an account
 * the code belongs to. The app's origin, not the API's.
 */
export function inviteLink(appOrigin: string, token: string, existingAccount: boolean): string {
  const origin = appOrigin.replace(/\/+$/, '');
  return `${origin}${existingAccount ? '/join' : '/register'}?invite=${encodeURIComponent(token)}`;
}

function invitePending(agentCode: string): DomainException {
  return new DomainException(
    ErrorCode.ORG_INVITE_PENDING,
    `Agent code ${agentCode} already has an invite waiting to be accepted. Resend that one, or cancel it first.`,
    HttpStatus.CONFLICT,
    { agentCode },
  );
}

function inviteDecided(row: Pick<MemberInviteDocument, 'status'>): DomainException {
  return new DomainException(
    ErrorCode.ORG_REQUEST_ALREADY_DECIDED,
    `That invite was already ${row.status}.`,
    HttpStatus.CONFLICT,
    { status: row.status },
  );
}
