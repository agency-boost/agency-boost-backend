import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { readerOf, type Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { isEnded } from '@/modules/tenants/subscription';
import { User, UserDocument } from '@/modules/users/user.schema';
import { HierarchyService } from './hierarchy.service';
import { JoinRequestRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { MembershipDocument } from './membership.schema';
import { ONBOARDING_REFUSALS } from './onboarding.messages';
import { ORG_MESSAGES } from './org.messages';

const SAY = ONBOARDING_REFUSALS;

/** How many offices one directory search answers. */
const DIRECTORY_PAGE = 50;

/**
 * The zone whose today is the earliest anywhere (UTC−12): an end date before **its** today has passed
 * in every office's zone, so the directory's query can drop it without knowing which zone an office
 * keeps (`Etc/GMT+12` is UTC−12 — the IANA sign is inverted).
 */
const EARLIEST_ZONE = 'Etc/GMT+12';

export interface KpmDirectoryEntry {
  kpmId: string;
  code: string;
  branchName: string;
  /**
   * The insurer, named and identified.
   *
   * The id travels because somebody whose branch is not on the platform has to say which
   * company they would belong to, and the directory is the only place a newcomer can
   * learn which companies exist. It names no office and leaks nothing an outsider could
   * not read from the list itself.
   */
  companyId: string;
  companyName: string;
  city: string | null;
}

export interface LeaderChoice {
  membershipId: string;
  fullName: string;
  role: 'ab' | 'aab';
  unitSize: number;
  isCurrentLeader: boolean;
  requestSent: boolean;
}

export interface JoinState {
  kpmId: string | null;
  kpmLabel: string | null;
  registeredAt: string | null;
  leaderMembershipId: string | null;
  leaderName: string | null;
  status: 'none' | 'pending' | 'active' | 'removed';
  pendingRequestTo: string | null;
}

/**
 * Joining an office: registering to one, then asking a leader to take you.
 *
 * The prototype gates these as a chain — the leader panel is *"locked entirely until a
 * KPM exists"* (`Overall.html:8824-8827`) — and so does this, but by state rather than
 * by hiding a card. Registering creates a **pending membership**, which is what gives
 * the request a tenant to be scoped to; without one there is no office to search.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly requests: JoinRequestRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  /**
   * The office directory — the one cross-tenant read a non-Super-Admin has.
   *
   * Deliberately projection-limited to code, branch name, company and city. Somebody
   * with no office can call this, because otherwise nobody could ever join one, so it
   * must reveal nothing an outsider should not see: no member counts, no production,
   * no owner name.
   *
   * `reader`: the request's, for the word written in place of a company with no name (P18.98-T5 AC-4).
   */
  async searchKpms(q?: string, reader: Reader = readerOf()): Promise<KpmDirectoryEntry[]> {
    const term = q?.trim();
    const filter: Record<string, unknown> = { deletedAt: null, status: 'active' };
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Code substring or branch-name substring, as the prototype's own filter does.
      filter.$or = [
        { code: new RegExp(escaped, 'i') },
        { branchName: new RegExp(escaped, 'i') },
      ];
    }

    /*
     * **An ended office is not offered** (ADR-0112 §3, P13.2-T3 AC-6): to an outsider it reads as a
     * suspended one does — absent. The exact rule is the office's own date in its own zone, which only
     * the clock port can say, so it is applied here, to each row.
     *
     * **Filtered before the fifty, not after** (P13.2 exit review). Cutting at fifty and then dropping
     * the ended ones hid active offices behind them: fifty ended offices answered an empty directory.
     * The query drops every office ended in **every** zone — an end date before today in the earliest
     * zone on Earth, not kept active — and the rows are then read one at a time until fifty pass the
     * exact rule, so the few it cannot settle (ended in Jakarta, not yet west of it) cost a row each.
     */
    filter.$nor = [{
      'subscription.keepActiveAfterEnd': { $ne: true },
      'subscription.endDate': { $lt: this.clock.localDateFor(EARLIEST_ZONE) },
    }];
    const offices: KpmDocument[] = [];
    for await (const office of this.kpms.find(filter).sort({ code: 1 }).cursor()) {
      if (isEnded(office, this.clock)) continue;
      offices.push(office);
      if (offices.length === DIRECTORY_PAGE) break;
    }
    if (offices.length === 0) return [];

    const companies = await this.companies
      .find({ _id: { $in: [...new Set(offices.map((o) => o.companyId))] } })
      .exec();
    const nameOf = new Map(companies.map((c) => [String(c._id), c.name]));

    return offices.map((o) => ({
      kpmId: String(o._id),
      code: o.code,
      branchName: o.branchName,
      companyId: o.companyId,
      companyName: nameOf.get(o.companyId) ?? render(ORG_MESSAGES.unknownName, reader),
      city: o.address,
    }));
  }

  /** Where the person asking stands: office, leader, and any outstanding request. */
  async myState(ctx: RequestContext): Promise<JoinState> {
    const empty: JoinState = {
      kpmId: null, kpmLabel: null, registeredAt: null,
      leaderMembershipId: null, leaderName: null, status: 'none', pendingRequestTo: null,
    };
    if (!ctx.membership) return empty;

    const membership = await this.members.findById(ctx, ctx.membershipId!);
    if (!membership) return empty;

    const kpm = await this.kpms.findOne({ _id: membership.kpmId, deletedAt: null }).exec();
    const company = kpm ? await this.companies.findOne({ _id: kpm.companyId }).exec() : null;

    // The caller may be in no office yet, so this reads by membership across offices —
    // the named cross-tenant escape rather than an absent filter (invariant §1).
    const request = await this.requests.pendingForMembership(
      membership.kpmId,
      String(membership._id),
    );

    return {
      kpmId: membership.kpmId,
      kpmLabel: kpm
        ? `${company?.name ?? render(ORG_MESSAGES.unknownName, ctx.reader)} — KPM ${kpm.code} · ${kpm.branchName}`
        : null,
      registeredAt: membership.get('createdAt')?.toISOString() ?? null,
      leaderMembershipId: membership.leaderId,
      leaderName: membership.leaderId ? await this.nameOfMembership(ctx, membership.leaderId) : null,
      status: membership.status,
      pendingRequestTo: request?.leaderMembershipId ?? null,
    };
  }

  private async nameOfMembership(ctx: RequestContext, membershipId: string): Promise<string | null> {
    const row = await this.members.findById(ctx, membershipId);
    if (!row) return null;
    const user = await this.users.findOne({ _id: row.userId }).exec();
    return user?.fullName ?? null;
  }

  /**
   * Attach yourself to an office.
   *
   * Creates a `pending` membership with no leader — the "unassigned agent" the
   * permission matrix describes: inside the tenant, in the untagged pool, with no
   * unit-scoped grants at all.
   *
   * It allocates an agent code even though nobody has approved them. A declined request
   * therefore leaves a gap in the office's numbering, which is the right trade: the
   * alternative is a membership row without a code, and `agentCode` being always
   * present is what lets every other collection rely on it.
   */
  async registerKpm(ctx: RequestContext, kpmId: string): Promise<JoinState> {
    if (ctx.membership) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        SAY.ORG_AGENT_ALREADY_TAGGED.alreadyRegistered,
        HttpStatus.CONFLICT,
        { kpmId: ctx.kpmId },
      );
    }

    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null, status: 'active' }).exec();
    // An office that is suspended, archived or absent all read the same to an outsider — and so
    // does one whose subscription has ended (ADR-0112 §3).
    if (!kpm || isEnded(kpm, this.clock)) throw new NotFoundException('KPM');

    const scoped = RequestContext.joiningTenant(ctx, kpmId);
    const membership = await this.hierarchy.create(scoped, {
      userId: ctx.userId,
      // The ladder's lowest rung that leads nobody: `AGENT` on the default ladder (ADR-0156).
      role: await this.hierarchy.entryRungCode(kpmId, 'joiner'),
      leaderId: null,
      status: 'pending',
    });

    await this.audit.record(scoped, {
      action: 'kpm_registration.created',
      targetCollection: 'memberships',
      targetId: String(membership._id),
      after: { userId: ctx.userId, kpmId },
    });

    // Resolve against the membership just made, so the caller sees their new state
    // rather than the one their token was issued under — written for the same reader.
    return this.myState(await this.contextFor(membership, ctx.reader));
  }

  private async contextFor(membership: MembershipDocument, reader: Reader): Promise<RequestContext> {
    return new RequestContext(membership.userId, 'none', {
      membershipId: String(membership._id),
      kpmId: membership.kpmId,
      orgLevelCode: membership.orgLevelCode,
      hierarchyRole: membership.role,
      status: membership.status,
      isKpmOwner: false,
      isKpmAdmin: false,
      directCount: membership.directCounts?.total ?? 0,
    }).withReader(reader);
  }

  /**
   * The leaders you may ask.
   *
   * Everyone in your office holding AB or AAB — by role, not by the graph. This is the
   * one place the role is the right question: you are asking who *may* take you on, and
   * someone with no reports yet has to be askable or a new AAB could never get their
   * first (OD-23 governs who *is* a leader, not who may become one).
   */
  async leaders(ctx: RequestContext, q?: string): Promise<LeaderChoice[]> {
    if (!ctx.kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        SAY.TENANT_NO_MEMBERSHIP.registerBeforeLooking,
        HttpStatus.FORBIDDEN,
      );
    }

    /*
     * **Never the reader, and never anybody below them** (ADR-0170 §6, P18.96-T3 AC-6; UI-006). Somebody in the
     * reader's downline carries the reader's membership in `ancestorIds`, and asking one of them to lead you is a loop
     * — refused when it was approved, and since T3 when it is sent; offering it was the defect. `$ne` on an array is
     * *no element equals*, so this is one indexed read, as the rest of the hierarchy's are.
     */
    const rows = await this.members.find(
      ctx,
      {
        role: { $in: ['ab', 'aab'] },
        status: 'active',
        ...(ctx.membershipId ? { ancestorIds: { $ne: ctx.membershipId } } : {}),
      },
      { sort: { agentSeq: 1 } },
    );
    const users = await this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).exec();
    const byUser = new Map(users.map((u) => [String(u._id), u]));

    const mine = ctx.membershipId
      ? await this.requests.findOne(ctx, { membershipId: ctx.membershipId, status: 'pending' })
      : null;
    const self = ctx.membershipId ? await this.members.findById(ctx, ctx.membershipId) : null;

    const term = q?.trim().toLowerCase();
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    return rows
      .map((r) => ({
        membershipId: String(r._id),
        fullName: byUser.get(r.userId)?.fullName ?? unknown,
        role: r.role as 'ab' | 'aab',
        unitSize: r.subtreeCount ?? 0,
        isCurrentLeader: self?.leaderId === String(r._id),
        requestSent: mine?.leaderMembershipId === String(r._id),
      }))
      // Name only, as the prototype's own filter does — code and role are not searchable
      // here, and adding them would diverge without a reason.
      .filter((l) => !term || l.fullName.toLowerCase().includes(term))
      .filter((l) => l.membershipId !== ctx.membershipId);
  }

  /** Ask a leader to take you. Notifies them; they decide (P3-T5). */
  async requestLeader(ctx: RequestContext, leaderMembershipId: string): Promise<JoinState> {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        SAY.TENANT_NO_MEMBERSHIP.registerBeforeAsking,
        HttpStatus.FORBIDDEN,
      );
    }

    /**
     * **This is the joining flow, and only the joining flow.**
     *
     * Nothing here checked whether the *caller* already had a leader, and `approve()`
     * checked the request's status rather than the member's — so an active member with a
     * unit of their own could ask a different leader, be approved, and be moved. That is
     * a re-parent by another name, reachable with no `member:remove_from_team` and no
     * re-parent permission, of which the matrix has none. Changing an established leader
     * is a decision the product has not designed; a side door is not the place to
     * discover that.
     */
    const mine = await this.members.findById(ctx, ctx.membershipId);
    if (mine?.leaderId) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        SAY.ORG_AGENT_ALREADY_TAGGED.youReport,
        HttpStatus.CONFLICT,
        { leaderId: mine.leaderId },
      );
    }

    // Checked first, and deliberately. Asking for yourself also fails the leader test
    // below — a pending agent is not a valid leader — but "you cannot report to
    // yourself" names the actual mistake, and the more specific message should win.
    if (leaderMembershipId === ctx.membershipId) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED,
        SAY.ORG_CYCLE_DETECTED.askYourself,
        HttpStatus.CONFLICT,
      );
    }

    const leader = await this.members.findById(ctx, leaderMembershipId);
    if (!leader || leader.status !== 'active' || !['ab', 'aab'].includes(leader.role)) {
      throw new DomainException(
        ErrorCode.ORG_LEADER_NOT_IN_KPM,
        SAY.ORG_LEADER_NOT_IN_KPM.notAvailable,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { leaderMembershipId },
      );
    }

    /*
     * **A loop is refused when it is asked, not only when it is approved** (ADR-0170 §6, P18.96-T3 AC-6). An orphan
     * who still leads a unit has no leader, so the check above lets them ask somebody in that unit; approving it was
     * refused by `assertCanMoveUnder`, after the leader had been notified of a request nobody could approve.
     */
    if (leader.ancestorIds.includes(ctx.membershipId)) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED,
        SAY.ORG_CYCLE_DETECTED.theyReportToYou,
        HttpStatus.CONFLICT,
        { leaderMembershipId },
      );
    }

    // Replace rather than stack: asking someone else is a change of mind, not a second
    // request, and two open rows would let two approvers both say yes.
    await this.requests.updateMany(
      ctx,
      { membershipId: ctx.membershipId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );

    await this.requests.create(ctx, {
      membershipId: ctx.membershipId,
      leaderMembershipId,
      status: 'pending',
      createdBy: ctx.membershipId,
    });

    const asker = await this.users.findOne({ _id: ctx.userId }).exec();
    await this.notifications.send({
      userId: leader.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.JOIN_REQUEST_RECEIVED,
      payload: {
        // No name, no word: the inbox writes its own for a notice with none, in its reader's language (P18.98-T5 AC-4).
        askerName: asker?.fullName ?? null,
        membershipId: ctx.membershipId,
      },
    });

    await this.audit.record(ctx, {
      action: 'leader_request.created',
      targetCollection: 'joinRequests',
      targetMembershipId: leaderMembershipId,
      after: { leaderMembershipId },
    });

    return this.myState(ctx);
  }

  /** Withdraw an outstanding ask. */
  async cancelRequest(ctx: RequestContext): Promise<JoinState> {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        SAY.TENANT_NO_MEMBERSHIP.noRequestToWithdraw,
        HttpStatus.FORBIDDEN,
      );
    }
    const cancelled = await this.requests.updateMany(
      ctx,
      { membershipId: ctx.membershipId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );
    if (cancelled === 0) throw new NotFoundException('Join request');
    return this.myState(ctx);
  }
}
