import { HttpStatus, Injectable, Optional, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { isLeaderClass } from '@/domain/constants';
import { ActivationStarter, startActivation } from './activation-starter.port';
import { HierarchyService, type JoiningFields } from './hierarchy.service';
import { JoinRequestDocument } from './join-request.schema';
import { leaderLimitRequestStale, type ApprovedPastLimit, type LeaderSeatOptions } from './leader-limit';
import { STALE_REASONS } from './leader-limit.messages';
import { JoinRequestRepository } from './org.repositories';
import { MembershipHistoryRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, MembershipDocument } from './membership.schema';
import { ONBOARDING_REFUSALS } from './onboarding.messages';
import { ORG_MESSAGES, ORG_REFUSALS } from './org.messages';

const SAY = ONBOARDING_REFUSALS;

export interface PendingRequest {
  requestId: string;
  membershipId: string;
  fullName: string;
  initials: string;
  email: string;
  agentCode: string;
  role: HierarchyRole;
  requestedAt: string;
  /** Set when somebody else's request was routed to this approver. */
  routedFromName: string | null;
  /**
   * The leader this request names — which is who the joiner joins if it is approved
   * with no destination, and whose sub-units are the destinations on offer.
   *
   * For a leader reading their own inbox this is always themselves. For the Owner or an
   * Admin reading the office queue it differs per row, and the screen cannot render the
   * destination list — or say plainly where an approval sends somebody — without it.
   */
  leaderMembershipId: string;
  leaderName: string;
}

export interface RoutingChoice {
  membershipId: string;
  fullName: string;
  unitSize: number;
  /**
   * The leader whose sub-unit this is.
   *
   * A leader's inbox holds only requests addressed to them, so one list served every
   * row. A tenant admin's inbox is the whole office, where each row names a different
   * leader — and `approve()` validates the destination against **the requested leader**,
   * not the actor. So a single list was not merely imprecise there, it was unusable:
   * every choice it offered was refused with `422`.
   */
  forLeaderMembershipId: string;
}

export interface UntaggedMember {
  membershipId: string;
  fullName: string;
  initials: string;
  email: string;
  agentCode: string;
  role: HierarchyRole;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  return (parts[0][0] + (parts[parts.length - 1][0] ?? '')).toUpperCase();
}

/**
 * The leader's side of joining: deciding who gets in, and pulling in somebody who is
 * already here.
 *
 * The two are asymmetric on purpose, and the prototype is right about it. Approving a
 * request the agent sent needs no consent from them — they asked. Tagging an *untagged*
 * agent needs none either, because the office already admitted them and being placed
 * under a leader is not a change they have standing to refuse. What neither may do is
 * take somebody out of another leader's unit; that is a re-parent, and it belongs to
 * P3-T6.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly requests: JoinRequestRepository,
    private readonly history: MembershipHistoryRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
    /*
     * OD-119, P13-T1 AC-1: a pending member made active under a leader — approved or tagged — is a hire,
     * and starts their activation in this same call. A port, as `MemberDeparture` is; optional, so a
     * harness that is not asking about activation builds this without it.
     */
    @Optional() @Inject(ActivationStarter) private readonly activations: ActivationStarter | null = null,
  ) {}

  private requireLeader(ctx: RequestContext): string {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        ORG_REFUSALS.TENANT_NO_MEMBERSHIP.notInOffice,
        HttpStatus.FORBIDDEN,
      );
    }
    return ctx.membershipId;
  }

  private isTenantAdmin(ctx: RequestContext): boolean {
    return Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
  }

  private async named(userIds: string[]): Promise<Map<string, UserDocument>> {
    const users = await this.users.find({ _id: { $in: userIds } }).exec();
    return new Map(users.map((u) => [String(u._id), u]));
  }

  /**
   * **How many requests are waiting on this approver** (UI V1, UI-085: the orange count on the *Pending Requests* tab,
   * read on all four User Management screens). The inbox's own filter — what was addressed or routed to them; the
   * office's whole queue for the Owner or an Admin — and, as the inbox drops a request whose member is gone, only
   * requests whose member is still in the office. Two narrow reads, ids only, never the names the inbox reads.
   */
  async waitingCount(ctx: RequestContext): Promise<{ count: number }> {
    const me = this.requireLeader(ctx);
    const rows = await this.requests.find(
      ctx,
      {
        status: 'pending',
        ...(this.isTenantAdmin(ctx) ? {} : { $or: [{ leaderMembershipId: me }, { routedToMembershipId: me }] }),
      },
      { projection: { membershipId: 1 } },
    );
    if (rows.length === 0) return { count: 0 };
    const present = new Set((await this.members.find(
      ctx,
      { _id: { $in: [...new Set(rows.map((r) => r.membershipId))] } },
      { projection: { _id: 1 } },
    )).map((m) => String(m._id)));
    return { count: rows.filter((r) => present.has(r.membershipId)).length };
  }

  /**
   * Everything waiting on this approver.
   *
   * Includes requests routed *to* them by somebody above: an AB may send an agent into
   * one of their AABs' units, and that AAB is then the one who decides.
   */
  async inbox(ctx: RequestContext): Promise<PendingRequest[]> {
    const me = this.requireLeader(ctx);

    // A leader sees what was addressed to them. The Owner and an Admin see the office's
    // whole queue — `leader_request:approve` grants them `own-kpm`, and a request nobody
    // answers is the failure this screen exists to prevent.
    const rows = await this.requests
      .find(
        ctx,
        {
          status: 'pending',
          ...(this.isTenantAdmin(ctx)
            ? {}
            : { $or: [{ leaderMembershipId: me }, { routedToMembershipId: me }] }),
        },
        { sort: { createdAt: -1 } },
      );
    if (rows.length === 0) return [];

    const memberships = await this.members.find(ctx, {
      _id: { $in: rows.map((r) => r.membershipId) },
    });
    const byId = new Map(memberships.map((m) => [String(m._id), m]));

    // Every leader named by a row, not only the ones who routed. The office queue shows
    // requests addressed to people other than the reader, and each has to be nameable.
    const leaderIds = [...new Set(rows.map((r) => r.leaderMembershipId))];
    const leaderRows = leaderIds.length
      ? await this.members.find(ctx, { _id: { $in: leaderIds } })
      : [];

    const names = await this.named([
      ...memberships.map((m) => m.userId),
      ...leaderRows.map((m) => m.userId),
    ]);
    const leaderName = new Map(
      leaderRows.map((m) => [String(m._id), names.get(m.userId)?.fullName ?? null]),
    );
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);

    return rows
      .map((r) => {
        const membership = byId.get(r.membershipId);
        if (!membership) return null;
        const fullName = names.get(membership.userId)?.fullName ?? unknown;
        return {
          requestId: String(r._id),
          membershipId: r.membershipId,
          fullName,
          initials: initialsOf(fullName),
          email: names.get(membership.userId)?.email ?? '',
          agentCode: membership.agentCode,
          role: membership.role,
          requestedAt: r.get('createdAt')?.toISOString() ?? '',
          routedFromName:
            r.routedToMembershipId === me && r.leaderMembershipId !== me
              ? (leaderName.get(r.leaderMembershipId) ?? null)
              : null,
          leaderMembershipId: r.leaderMembershipId,
          leaderName: leaderName.get(r.leaderMembershipId) ?? unknown,
        };
      })
      .filter((r): r is PendingRequest => r !== null);
  }

  /**
   * The sub-units a request may be sent into instead of the leader it names.
   *
   * **A destination is a direct report who can hold a unit, or already holds one.**
   *
   * This filtered `role: 'aab'` until 2026-09-06, which read the office as if a leader's
   * reports were all one level below them. They are not: an AB may report to an AB, the
   * seeded demo office contains exactly that, and ADR-0014 makes it ordinary by letting
   * a promotion keep its leader edge. Such a unit was never offered, and a caller who
   * knew the id was refused — so the sub-unit existed and was unreachable.
   *
   * The obvious repair, `directCounts.total > 0`, is wrong in the other direction, and a
   * test caught it: it excludes an AAB who leads nobody *yet*, which is exactly the
   * person you route a first agent to. Routing into an empty unit is how a unit starts.
   *
   * So the question is **capacity**, and capacity is a ladder question — which is not the
   * same question OD-23 answers. OD-23 says do not infer *"is a leader"* from the role;
   * leadership is the graph. *"May they hold a unit"* is about the rung, and the second
   * arm below keeps OD-23's answer available anyway: somebody who already leads people
   * has a unit whatever they are called. P3.5-T8 restates the first arm against the
   * ladder, where it becomes "not the bottom rung".
   *
   * Built per **requested leader**, not per actor: see `forLeaderMembershipId`.
   */
  async routingChoices(ctx: RequestContext): Promise<RoutingChoice[]> {
    const me = this.requireLeader(ctx);
    if (!can(ctx, 'leader_request:route_to_sub_unit')) return [];

    // Whose requests this reader is deciding — the same narrowing `inbox()` applies, so
    // the destinations always belong to a row the reader can actually see.
    const open = await this.requests.find(ctx, {
      status: 'pending',
      ...(this.isTenantAdmin(ctx)
        ? {}
        : { $or: [{ leaderMembershipId: me }, { routedToMembershipId: me }] }),
    });
    const leaders = [...new Set(open.map((r) => r.leaderMembershipId))];
    if (leaders.length === 0) return [];

    const units = await this.members.find(
      ctx,
      {
        leaderId: { $in: leaders },
        status: 'active',
        $or: [{ role: { $ne: 'agent' } }, { 'directCounts.total': { $gt: 0 } }],
      },
      { sort: { agentSeq: 1 } },
    );
    const names = await this.named(units.map((u) => u.userId));
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    return units.map((u) => ({
      membershipId: String(u._id),
      fullName: names.get(u.userId)?.fullName ?? unknown,
      unitSize: u.subtreeCount ?? 0,
      forLeaderMembershipId: String(u.leaderId),
    }));
  }

  /** The request, if it is this approver's to decide and still open. */
  private async openRequest(
    ctx: RequestContext,
    requestId: string,
    me: string,
  ): Promise<JoinRequestDocument> {
    // A malformed id is "not here", not a 500 — the repository answers `null` for an id
    // that cannot match anything, so the `catch` this used to carry went with it.
    const request = await this.requests.findOne(ctx, { _id: requestId });
    // Somebody else's request reads the same as one that does not exist — unless you
    // administer the office, in which case every request in it is yours to decide.
    const addressedToMe =
      request?.leaderMembershipId === me || request?.routedToMembershipId === me;
    if (!request || !(addressedToMe || this.isTenantAdmin(ctx))) {
      throw new NotFoundException('Join request');
    }
    if (request.status !== 'pending') {
      // Two leaders with the inbox open, or a double tap. Saying which way it went is
      // more use than saying "no".
      throw new DomainException(
        ErrorCode.ORG_REQUEST_ALREADY_DECIDED,
        SAY.ORG_REQUEST_ALREADY_DECIDED.request({ status: request.status }),
        HttpStatus.CONFLICT,
        { status: request.status, decidedAt: request.decidedAt },
      );
    }
    return request;
  }

  /**
   * Approve a join request — into the requested leader's unit, or one of their AABs'.
   *
   * **`joinDate`** (ADR-0169, P18.96-T2) is the day the person joined, as the approver gives it; omitted, the
   * office's today. It is checked before anything is written. It classifies them **once**, so for somebody who
   * already has a join date here — an active member whose request moves them — it changes nothing: their date is
   * corrected on their new hire's detail, never by a second approval.
   */
  async approve(
    ctx: RequestContext,
    requestId: string,
    routeToMembershipId?: string,
    joinDate?: string,
  ): Promise<PendingRequest[]> {
    const me = this.requireLeader(ctx);
    const request = await this.openRequest(ctx, requestId, me);

    const joiner = await this.members.findById(ctx, request.membershipId);
    if (!joiner) throw new NotFoundException('Membership');

    // **The leader they asked for**, not the actor. Identical while a leader decides
    // their own request; the moment an Owner decides Sari's, defaulting to the actor
    // would quietly move the joiner into the Owner's own unit.
    const requested = request.leaderMembershipId;
    let leaderId = requested;
    if (routeToMembershipId && routeToMembershipId !== requested) {
      // Routing is a separate grant, and it is checked here rather than only on the
      // list: a caller can name any id, and the list is a convenience.
      if (!can(ctx, 'leader_request:route_to_sub_unit')) {
        throw new DomainException(
          ErrorCode.PERM_DENIED,
          SAY.PERM_DENIED.routeElsewhere,
          HttpStatus.FORBIDDEN,
          { permission: 'leader_request:route_to_sub_unit' },
        );
      }
      const destination = await this.members.findById(ctx, routeToMembershipId);
      // The same test the list applies, for the same reason: the list is a convenience
      // and a caller can name any id, so the two must agree or one of them is decorative.
      if (
        !destination ||
        destination.status !== 'active' ||
        (destination.role === 'agent' && (destination.directCounts?.total ?? 0) === 0) ||
        // Into one of the *requested* leader's units. Routing places an agent inside the
        // unit they asked to join, which is not the same as the decider's unit.
        destination.leaderId !== requested
      ) {
        throw new DomainException(
          ErrorCode.ORG_LEADER_NOT_IN_KPM,
          SAY.ORG_LEADER_NOT_IN_KPM.notYourUnit,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { routeToMembershipId },
        );
      }
      // An AB or AAB who asked for you is tagged to you directly — the prototype says
      // so outright, and it is right: routing is about placing an agent in a unit, and
      // a leader is not placed in one.
      if (joiner.role === 'agent') leaderId = routeToMembershipId;
    }

    // ADR-0169: the join date and who it makes them, refused before anything is written.
    const joining = await this.joiningFor(ctx, joiner, joinDate);
    await this.attach(ctx, joiner, leaderId, {
      action: 'leader_request.approved',
      requestId,
    }, { requestable: true }, joining);

    // `openRequest` has already proved this row is in `ctx.kpmId`, so the tenant clause
    // changes no outcome today. It is here because a write addressed by `_id` alone is
    // one refactor away from being reachable without that proof, and the invariant is
    // that a tenant-scoped write carries its tenant (`domain-invariants.md` §1).
    await this.requests.updateById(ctx, requestId, {
      $set: {
        status: 'approved',
        decidedAt: this.clock.now(),
        decidedByMembershipId: me,
        routedToMembershipId: leaderId === requested ? null : leaderId,
      },
    });

    await this.notifications.send({
      userId: joiner.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.JOIN_REQUEST_APPROVED,
      payload: { leaderMembershipId: leaderId },
    });

    return this.inbox(ctx);
  }

  async decline(ctx: RequestContext, requestId: string, reason?: string): Promise<PendingRequest[]> {
    const me = this.requireLeader(ctx);
    const request = await this.openRequest(ctx, requestId, me);

    await this.requests.updateById(ctx, requestId, {
      $set: {
        status: 'declined',
        decidedAt: this.clock.now(),
        decidedByMembershipId: me,
        reason: reason?.trim() || null,
      },
    });

    // The membership stays `pending`. They are still registered to the office and may
    // ask somebody else — declining is not removal, and the prototype's version, which
    // simply drops the row, leaves them nowhere.
    const joiner = await this.members.findById(ctx, request.membershipId);
    if (joiner) {
      await this.notifications.send({
        userId: joiner.userId,
        kpmId: ctx.kpmId,
        templateId: NotificationTemplate.JOIN_REQUEST_DECLINED,
        payload: { reason: reason?.trim() ?? null },
      });
    }

    await this.audit.record(ctx, {
      action: 'leader_request.declined',
      targetCollection: 'joinRequests',
      targetId: requestId,
      targetMembershipId: request.membershipId,
      after: { reason: reason?.trim() ?? null },
    });

    return this.inbox(ctx);
  }

  /**
   * People in this office with no leader — registered, or left without one.
   *
   * Office-wide (`own-kpm`), because an untagged agent belongs to nobody yet and so
   * cannot be found by looking down anybody's tree.
   */
  async untagged(ctx: RequestContext, q?: string): Promise<UntaggedMember[]> {
    this.requireLeader(ctx);

    const rows = await this.members.find(
      ctx,
      { leaderId: null, status: { $ne: 'removed' }, _id: { $ne: ctx.membershipId } },
      { sort: { agentSeq: 1 } },
    );
    // The office's own root — its Owner — has no leader either, and is not somebody to
    // pull into a unit.
    const candidates = rows.filter((r) => r.role !== 'ab' || r.status === 'pending');

    const names = await this.named(candidates.map((r) => r.userId));
    const term = q?.trim().toLowerCase();
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);

    return candidates
      .map((r) => {
        const fullName = names.get(r.userId)?.fullName ?? unknown;
        return {
          membershipId: String(r._id),
          fullName,
          initials: initialsOf(fullName),
          email: names.get(r.userId)?.email ?? '',
          agentCode: r.agentCode,
          role: r.role,
        };
      })
      .filter((m) => !term || m.fullName.toLowerCase().includes(term));
  }

  /**
   * Pull an untagged person into your unit. No approval from them — Flow D.
   *
   * `joinDate` as `approve` takes it (ADR-0169): the day they joined, the office's today when omitted, and nothing
   * for somebody who already has one — an orphan picked up again keeps theirs.
   */
  async tag(ctx: RequestContext, membershipId: string, joinDate?: string): Promise<UntaggedMember[]> {
    const me = this.requireLeader(ctx);
    await this.placeUnder(ctx, membershipId, me, joinDate);
    return this.untagged(ctx);
  }

  /**
   * **Put a leaderless member of this office under `leaderId`, now** — a tag, and *+ Add agent* for an account that
   * has no leader here (ADR-0170 §4, P18.96-T3 AC-3). Every refusal a tag meets (`assertTaggable`), with the leader
   * in the caller's place: somebody already in a unit, the leader themselves, the office's root, an orphan who leads
   * a unit for anybody but the office. Then the join date (ADR-0169), the placement, any request they had open
   * cancelled, and their notice. `via` is what the audit row and the notice say brought them: a tag, or the form.
   */
  async placeUnder(
    ctx: RequestContext,
    membershipId: string,
    leaderId: string,
    joinDate?: string,
    via: 'tagged' | 'add_agent' = 'tagged',
  ): Promise<MembershipDocument> {
    this.requireLeader(ctx);
    const target = await this.members.findById(ctx, membershipId);
    if (!target || target.status === 'removed') throw new NotFoundException('Membership');
    await this.assertTaggable(ctx, target, leaderId);

    const joining = await this.joiningFor(ctx, target, joinDate);
    await this.attach(ctx, target, leaderId, { action: 'member.tagged_by_leader', via }, { requestable: true }, joining);

    // Any request they had open is moot — they are in somebody's unit now.
    await this.requests.updateMany(
      ctx,
      { membershipId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );

    await this.notifications.send({
      userId: target.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
      payload: { leaderMembershipId: leaderId, via: 'tagged' },
    });
    return (await this.members.findById(ctx, membershipId)) as MembershipDocument;
  }

  /**
   * **What letting this pending member in would be, if this reader may do it** (ADR-0157 §1) — for asking
   * AgencyBoost to approve it past the leader limit.
   *
   * Two acts can let a pending leader in, and the ask names whichever this reader could make: **approving their
   * join request**, when one is open and is theirs to decide (addressed to them, or the office's for the Owner
   * and an Admin), joining the leader it names; or else **tagging them** into the reader's own unit, refused
   * wherever `tag` would be. Anybody else's member is not found, as in the inbox. And only an act the limit
   * stops is asked about: a pending member whose rung leads nobody is let in directly.
   */
  async activationFor(
    ctx: RequestContext,
    membershipId: string,
  ): Promise<{ target: MembershipDocument; joinRequestId: string | null; leaderMembershipId: string }> {
    const me = this.requireLeader(ctx);
    const target = await this.members.findById(ctx, membershipId);
    if (!target || target.status === 'removed') throw new NotFoundException('Membership');
    if (target.status !== 'pending' || !isLeaderClass(target.role)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        SAY.VALIDATION_FAILED.letInDirectly,
        HttpStatus.BAD_REQUEST,
        { membershipId },
      );
    }

    const open = await this.requests.findOne(ctx, { membershipId, status: 'pending' });
    if (open) {
      const addressedToMe = open.leaderMembershipId === me || open.routedToMembershipId === me;
      if (!can(ctx, 'leader_request:approve') || !(addressedToMe || this.isTenantAdmin(ctx))) {
        throw new NotFoundException('Membership');
      }
      // A leader who asked is joined to the leader they asked for: routing places agents, never leaders.
      return { target, joinRequestId: String(open._id), leaderMembershipId: open.leaderMembershipId };
    }
    if (!can(ctx, 'member:add_untagged_to_unit')) throw new NotFoundException('Membership');
    await this.assertTaggable(ctx, target, me);
    return { target, joinRequestId: null, leaderMembershipId: me };
  }

  /**
   * **AgencyBoost approved it: the approval or the tag the office asked for, made past the limit** (ADR-0157 §3).
   *
   * `ctx` is the Super Admin acting in the request's office. The act is the one `approve` or `tag` makes — the
   * same `attach`, the join request decided by whoever asked, the member's notice — with `pastLimit`, so the
   * activation re-checks the request with the office's leader lease held and is not counted. A join request
   * decided since, a member placed since, or a leader who has left makes it stale, and nothing is written.
   */
  async carryOutApproved(
    ctx: RequestContext,
    request: {
      requestId: string;
      subjectMembershipId: string;
      joinRequestId: string | null;
      leaderMembershipId: string;
      requestedByMembershipId: string;
    },
    stillApplies: (target: MembershipDocument | null) => Promise<void>,
  ): Promise<void> {
    const target = await this.members.findById(ctx, request.subjectMembershipId);
    await stillApplies(target);
    const member = target as MembershipDocument;
    const pastLimit: ApprovedPastLimit = {
      approvedRequestId: request.requestId,
      stillApplies: async () => stillApplies(await this.members.findById(ctx, request.subjectMembershipId)),
    };

    const leader = await this.members.findById(ctx, request.leaderMembershipId);
    if (!leader || leader.status !== 'active') {
      throw leaderLimitRequestStale(request.requestId, STALE_REASONS.leaderGone);
    }

    if (request.joinRequestId) {
      const joinRequest = await this.requests.findOne(ctx, { _id: request.joinRequestId, status: 'pending' });
      if (!joinRequest) {
        throw leaderLimitRequestStale(request.requestId, STALE_REASONS.joinRequestDecided);
      }
      await this.attach(ctx, member, request.leaderMembershipId, {
        action: 'leader_request.approved',
        requestId: request.joinRequestId,
      }, { pastLimit }, await this.joiningFor(ctx, member));
      await this.requests.updateById(ctx, request.joinRequestId, {
        $set: {
          status: 'approved',
          decidedAt: this.clock.now(),
          // Whoever asked AgencyBoost decided it; the Super Admin is on the audit row.
          decidedByMembershipId: request.requestedByMembershipId,
          routedToMembershipId: null,
        },
      });
      await this.notifications.send({
        userId: member.userId,
        kpmId: ctx.kpmId,
        templateId: NotificationTemplate.JOIN_REQUEST_APPROVED,
        payload: { leaderMembershipId: request.leaderMembershipId },
      });
      return;
    }

    if (member.leaderId) {
      throw leaderLimitRequestStale(request.requestId, STALE_REASONS.placedSince);
    }
    await this.attach(ctx, member, request.leaderMembershipId, { action: 'member.tagged_by_leader' }, { pastLimit }, await this.joiningFor(ctx, member));
    await this.requests.updateMany(
      ctx,
      { membershipId: request.subjectMembershipId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );
    await this.notifications.send({
      userId: member.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
      payload: { leaderMembershipId: request.leaderMembershipId, via: 'tagged' },
    });
  }

  /**
   * Every refusal a tag meets, before anything is written: somebody already in a unit, yourself, the office's
   * root or Owner, and — for anybody but the office — an orphan who still leads a unit. Shared by `tag` and by
   * asking AgencyBoost to approve one past the leader limit (`activationFor`), so the ask is refused exactly
   * where the tag would be.
   */
  private async assertTaggable(ctx: RequestContext, target: MembershipDocument, me: string): Promise<void> {
    const membershipId = String(target._id);
    if (target.leaderId) {
      // Taking somebody out of another leader's unit is a re-parent, not a tag, and it
      // is not a thing you do from a search result.
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        SAY.ORG_AGENT_ALREADY_TAGGED.reportsToSomebody,
        HttpStatus.CONFLICT,
        { membershipId, leaderId: target.leaderId },
      );
    }
    if (membershipId === me) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED,
        SAY.ORG_CYCLE_DETECTED.addYourself,
        HttpStatus.CONFLICT,
      );
    }

    /**
     * **`untagged()` filters the list; this has to filter the argument.**
     *
     * The list excludes an active AB with no leader — the office root — and the caller
     * supplies the id, so the list was the only thing standing between an ordinary AAB
     * and `POST /join/untagged/<theOwnersMembershipId>`. It succeeded: the office's root
     * ended up reporting to a subordinate, and because `visibleTo` reads `ancestorIds`,
     * that subordinate could then read them.
     *
     * `approve()` writes this reasoning out at its own re-validation and then does it.
     * This did not.
     */
    const tenantAdmin = Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
    const isRoot = target.leaderId === null && target.role === 'ab' && target.status === 'active';
    if (isRoot || (await this.hierarchy.ownsTheOffice(ctx, target))) {
      throw new DomainException(
        ErrorCode.ORG_NOT_PERMITTED_TO_TAG,
        SAY.ORG_NOT_PERMITTED_TO_TAG.leadsTheOffice,
        HttpStatus.FORBIDDEN,
        { membershipId },
      );
    }

    /**
     * And the person has to be somebody this caller could already reach.
     *
     * `member:search_untagged_pool` is `own-kpm` — the pool is office-wide on purpose,
     * because an untagged person is in nobody's downline and would otherwise be
     * unreachable. But an **orphan who still leads a unit** is a different thing: a
     * leader could remove their own AAB with `orphan`, and a peer could then pick that
     * whole unit up. Nobody's removal should hand a peer a unit, which is the same
     * defect `RemovalService`'s destination check closes from the other side.
     */
    if (!tenantAdmin && (target.directCounts?.total ?? 0) > 0) {
      throw new DomainException(
        ErrorCode.ORG_NOT_PERMITTED_TO_TAG,
        SAY.ORG_NOT_PERMITTED_TO_TAG.leadsOwnUnit,
        HttpStatus.FORBIDDEN,
        { membershipId, directCount: target.directCounts?.total ?? 0 },
      );
    }
  }

  /**
   * **The join date and classification this placement writes, or none** (ADR-0169 §1, §3): for a member who has no
   * join date in this office yet — a pending one being let in — the date given or the office's today, checked, and
   * the classification it gives, once. Somebody who already has one keeps it: a move is not a join.
   */
  private async joiningFor(ctx: RequestContext, member: MembershipDocument, joinDate?: string): Promise<JoiningFields | null> {
    if (member.joinedAs) return null;
    return this.hierarchy.joining(ctx, { joinDate });
  }

  /**
   * Put somebody under a leader and make them active.
   *
   * Shared by approving and tagging because they end in the same place, and two copies
   * would eventually disagree about the history row — which is the part nothing can
   * reconstruct later.
   */
  private async attach(
    ctx: RequestContext,
    member: MembershipDocument,
    leaderId: string,
    audit: { action: string; requestId?: string; via?: 'tagged' | 'add_agent' },
    seat: LeaderSeatOptions = {},
    /** ADR-0169: written with the activation, for a member who had no join date yet. */
    joining: JoiningFields | null = null,
  ): Promise<void> {
    const leader = await this.members.findById(ctx, leaderId);
    if (!leader) throw new NotFoundException('Membership');

    const wasPending = member.status === 'pending';

    /**
     * **The graph move goes through `HierarchyService`, not through a `$set` here.**
     *
     * This used to write `leaderId`, `ancestorIds` and `depth` by hand, which is correct
     * only for somebody who leads nobody — the case its docstring assumed. Two live paths
     * reach it with a member who has a unit: an orphaned leader picked up from the
     * untagged pool, and an active member whose leader request is approved. Their
     * descendants kept the **old** ancestry, so the previous leader chain retained read
     * reach over a unit that had left it, the new leader could not see the unit they now
     * owned, and the old leader's counts were never refreshed.
     *
     * `moveUnder` carries the cycle check, the subtree re-splice and both `refreshCounts`.
     * The history row stays here, because joining is not the same event as being moved.
     */
    // **Ask before writing anything.** The order below is forced — `refreshCounts` counts
    // active members, so the status flip has to precede the move or the new leader reads
    // a count that does not include the person who just arrived. That left the refusal
    // inside `moveUnder` landing after a write it could not undo: an orphan who leads a
    // unit can ask a leader inside their own downline (`requestLeader` checks only that
    // the leader is an active AB or AAB), and approving it threw `ORG_CYCLE_DETECTED`
    // with the joiner already active, leaderless, and carrying a recruiter who never took
    // them on. There are no transactions to roll that back, so the refusal moves first.
    await this.hierarchy.assertCanMoveUnder(ctx, String(member._id), leaderId);

    /*
     * **The leader limit, at the activation** (ADR-0113 §2, P13.2 exit review). A pending member
     * promoted to AB or AAB was not counted, and this write made them count without asking: two of
     * them promoted at one below the limit and both approved made the office one over. Activating a
     * member who is not active goes through `HierarchyService.activate`, which takes the seat when the
     * row is not active at a leader rung — refused `409 LEADER_LIMIT_REACHED` before anything is
     * written, the request left open — and serves an Agent as it always did. Somebody already active
     * adds nobody.
     */
    const fields = {
      joinedAt: member.joinedAt ?? this.clock.now(),
      recruitedByMembershipId: member.recruitedByMembershipId ?? leaderId,
      ...(joining ?? {}),
    };
    if (member.status !== 'active') {
      // `seat`: refused here, an approval or a tag may be asked about instead, and comes back approved past the
      // limit (ADR-0157 §1, §3).
      await this.hierarchy.activate(ctx, String(member._id), fields, seat);
    } else {
      await this.members.updateById(ctx, String(member._id), { $set: { status: 'active', ...fields } });
    }
    await this.hierarchy.moveUnder(ctx, String(member._id), leaderId);

    // The joined edge was opened when they registered; this closes it and opens the one
    // that names their leader. Nothing is overwritten.
    //
    // **Every open edge, not only the joined one** (P11-T3). An orphan picked up from the
    // pool is open on the re-parent that orphaned them, and closing `joined` rows alone left
    // that one open beside the new edge.
    await this.history.openEdge(ctx, this.clock.now(), {
      membershipId: String(member._id),
      eventType: wasPending ? 'joined' : 're_parented',
      toRole: member.role,
      toOrgLevelId: member.orgLevelId,
      fromLeaderId: member.leaderId,
      toLeaderId: leaderId,
    });

    await this.audit.record(ctx, {
      action: audit.action,
      targetCollection: 'memberships',
      targetId: String(member._id),
      targetMembershipId: String(member._id),
      after: {
        leaderId,
        requestId: audit.requestId,
        // P18.96-T3: *+ Add agent* linking an account says so, beside a tag from the untagged pool.
        ...(audit.via === 'add_agent' ? { via: 'add_agent' } : {}),
        ...(joining ?? {}),
        ...(seat.pastLimit ? { leaderLimitRequestId: seat.pastLimit.approvedRequestId } : {}),
      },
    });

    /*
     * **Joining under a leader starts an activation** (OD-119): only a member who was pending — an
     * orphan picked up again, or an active member's leader request, is a move, not a join — and only for a
     * new hire at the Agent rung (ADR-0169), which the activation module decides. It fails open: the placement
     * above stands.
     */
    if (wasPending) await startActivation(this.activations, ctx, String(member._id));
  }
}
