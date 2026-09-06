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
      .exec();
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
    await this.members.updateById(ctx, String(member._id), {
      $set: {
        leaderId,
        ancestorIds: [...leader.ancestorIds, leaderId],
        depth: leader.depth + 1,
        status: 'active',
        joinedAt: member.joinedAt ?? this.clock.now(),
        recruitedByMembershipId: member.recruitedByMembershipId ?? leaderId,
      },
    });

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

    await this.hierarchy.refreshCounts(ctx, leaderId);

    await this.audit.record(ctx, {
      action: audit.action,
      targetCollection: 'memberships',
      targetId: String(member._id),
      targetMembershipId: String(member._id),
      after: { leaderId, requestId: audit.requestId },
    });
  }
}
