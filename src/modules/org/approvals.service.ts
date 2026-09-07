import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { HierarchyService } from './hierarchy.service';
import { JoinRequest, JoinRequestDocument } from './join-request.schema';
import { MembershipHistory, MembershipHistoryDocument } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, MembershipDocument } from './membership.schema';

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
    @InjectModel(JoinRequest.name) private readonly requests: Model<JoinRequestDocument>,
    @InjectModel(MembershipHistory.name)
    private readonly history: Model<MembershipHistoryDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  private requireLeader(ctx: RequestContext): string {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
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
      .find({
        kpmId: ctx.kpmId,
        deletedAt: null,
        status: 'pending',
        ...(this.isTenantAdmin(ctx)
          ? {}
          : { $or: [{ leaderMembershipId: me }, { routedToMembershipId: me }] }),
      })
      .sort({ createdAt: -1 })
      .exec();
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

    return rows
      .map((r) => {
        const membership = byId.get(r.membershipId);
        if (!membership) return null;
        const fullName = names.get(membership.userId)?.fullName ?? 'Unknown';
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
          leaderName: leaderName.get(r.leaderMembershipId) ?? 'Unknown',
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
    const open = await this.requests
      .find({
        kpmId: ctx.kpmId,
        deletedAt: null,
        status: 'pending',
        ...(this.isTenantAdmin(ctx)
          ? {}
          : { $or: [{ leaderMembershipId: me }, { routedToMembershipId: me }] }),
      })
      .exec();
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
    return units.map((u) => ({
      membershipId: String(u._id),
      fullName: names.get(u.userId)?.fullName ?? 'Unknown',
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
    const request = await this.requests
      .findOne({ _id: requestId, kpmId: ctx.kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
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
        `That request was already ${request.status}.`,
        HttpStatus.CONFLICT,
        { status: request.status, decidedAt: request.decidedAt },
      );
    }
    return request;
  }

  async approve(
    ctx: RequestContext,
    requestId: string,
    routeToMembershipId?: string,
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
          'You cannot send this request into somebody else’s unit.',
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
          'That is not one of your own units.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { routeToMembershipId },
        );
      }
      // An AB or AAB who asked for you is tagged to you directly — the prototype says
      // so outright, and it is right: routing is about placing an agent in a unit, and
      // a leader is not placed in one.
      if (joiner.role === 'agent') leaderId = routeToMembershipId;
    }

    await this.attach(ctx, joiner, leaderId, {
      action: 'leader_request.approved',
      requestId,
    });

    // `openRequest` has already proved this row is in `ctx.kpmId`, so the tenant clause
    // changes no outcome today. It is here because a write addressed by `_id` alone is
    // one refactor away from being reachable without that proof, and the invariant is
    // that a tenant-scoped write carries its tenant (`domain-invariants.md` §1).
    await this.requests
      .updateOne(
        { _id: requestId, kpmId: ctx.kpmId },
        {
          $set: {
            status: 'approved',
            decidedAt: this.clock.now(),
            decidedByMembershipId: me,
            routedToMembershipId: leaderId === requested ? null : leaderId,
          },
        },
      )
      .exec();

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

    await this.requests
      .updateOne(
        { _id: requestId, kpmId: ctx.kpmId },
        {
          $set: {
            status: 'declined',
            decidedAt: this.clock.now(),
            decidedByMembershipId: me,
            reason: reason?.trim() || null,
          },
        },
      )
      .exec();

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

    return candidates
      .map((r) => {
        const fullName = names.get(r.userId)?.fullName ?? 'Unknown';
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

  /** Pull an untagged person into your unit. No approval from them — Flow D. */
  async tag(ctx: RequestContext, membershipId: string): Promise<UntaggedMember[]> {
    const me = this.requireLeader(ctx);

    const target = await this.members.findById(ctx, membershipId);
    if (!target || target.status === 'removed') throw new NotFoundException('Membership');

    if (target.leaderId) {
      // Taking somebody out of another leader's unit is a re-parent, not a tag, and it
      // is not a thing you do from a search result.
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        'They already report to somebody. Moving them is a different operation.',
        HttpStatus.CONFLICT,
        { membershipId, leaderId: target.leaderId },
      );
    }
    if (membershipId === me) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED,
        'You cannot add yourself to your own unit.',
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
        'They lead the office. Nobody tags them into a unit.',
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
        'They lead a unit of their own. Only the office can place them.',
        HttpStatus.FORBIDDEN,
        { membershipId, directCount: target.directCounts?.total ?? 0 },
      );
    }

    await this.attach(ctx, target, me, { action: 'member.tagged_by_leader' });

    // Any request they had open is moot — they are in somebody's unit now.
    await this.requests
      .updateMany(
        { kpmId: ctx.kpmId, membershipId, status: 'pending' },
        { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
      )
      .exec();

    await this.notifications.send({
      userId: target.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.MEMBER_TAGGED_BY_LEADER,
      payload: { leaderMembershipId: me, via: 'tagged' },
    });

    return this.untagged(ctx);
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
    audit: { action: string; requestId?: string },
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

    await this.members.updateById(ctx, String(member._id), {
      $set: {
        status: 'active',
        joinedAt: member.joinedAt ?? this.clock.now(),
        recruitedByMembershipId: member.recruitedByMembershipId ?? leaderId,
      },
    });
    await this.hierarchy.moveUnder(ctx, String(member._id), leaderId);

    // The joined edge was opened when they registered; this closes it and opens the one
    // that names their leader. Nothing is overwritten.
    await this.history
      .updateMany(
        {
          kpmId: ctx.kpmId,
          membershipId: String(member._id),
          eventType: 'joined',
          validTo: null,
        },
        { $set: { validTo: this.clock.now() } },
      )
      .exec();
    await this.history.create({
      kpmId: ctx.kpmId,
      membershipId: String(member._id),
      eventType: wasPending ? 'joined' : 're_parented',
      toRole: member.role,
      fromLeaderId: member.leaderId,
      toLeaderId: leaderId,
      validFrom: this.clock.now(),
      validTo: null,
      actorMembershipId: ctx.membershipId,
      actorUserId: ctx.auditActors.actorUserId,
    });

    await this.audit.record(ctx, {
      action: audit.action,
      targetCollection: 'memberships',
      targetId: String(member._id),
      targetMembershipId: String(member._id),
      after: { leaderId, requestId: audit.requestId },
    });
  }
}
