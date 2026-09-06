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
}

export interface RoutingChoice {
  membershipId: string;
  fullName: string;
  unitSize: number;
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

    const routers = rows
      .filter((r) => r.routedToMembershipId === me && r.leaderMembershipId !== me)
      .map((r) => r.leaderMembershipId);
    const routerRows = routers.length
      ? await this.members.find(ctx, { _id: { $in: routers } })
      : [];

    const names = await this.named([
      ...memberships.map((m) => m.userId),
      ...routerRows.map((m) => m.userId),
    ]);
    const routerName = new Map(
      routerRows.map((m) => [String(m._id), names.get(m.userId)?.fullName ?? null]),
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
              ? (routerName.get(r.leaderMembershipId) ?? null)
              : null,
        };
      })
      .filter((r): r is PendingRequest => r !== null);
  }

  /**
   * The units an approver may send somebody into instead of their own.
   *
   * Their direct AABs, and only theirs. Empty for an AAB, whose reports are agents —
   * there is no sub-unit below them to route into, which is why the permission is AB
   * only rather than merely producing an empty list.
   */
  async routingChoices(ctx: RequestContext): Promise<RoutingChoice[]> {
    const me = this.requireLeader(ctx);
    if (!can(ctx, 'leader_request:route_to_sub_unit')) return [];

    const aabs = await this.members.find(
      ctx,
      { leaderId: me, role: 'aab', status: 'active' },
      { sort: { agentSeq: 1 } },
    );
    const names = await this.named(aabs.map((a) => a.userId));
    return aabs.map((a) => ({
      membershipId: String(a._id),
      fullName: names.get(a.userId)?.fullName ?? 'Unknown',
      unitSize: a.subtreeCount ?? 0,
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
      // Only into your *own* AABs. Anywhere else is somebody else's unit to staff.
      if (
        !destination ||
        destination.status !== 'active' ||
        destination.role !== 'aab' ||
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

    await this.requests
      .updateOne(
        { _id: requestId },
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
        { _id: requestId },
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
        { membershipId: String(member._id), eventType: 'joined', validTo: null },
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
