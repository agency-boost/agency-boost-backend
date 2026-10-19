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
import { User, UserDocument } from '@/modules/users/user.schema';
import { initialsOf } from './directory.service';
import { HierarchyService } from './hierarchy.service';
import { MembershipHistoryRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole } from './membership.schema';

export interface TeamMember {
  membershipId: string;
  fullName: string;
  initials: string;
  agentCode: string;
  role: HierarchyRole;
  directCount: number;
  /**
   * Whether this viewer may change *this* person's role. Sent rather than inferred,
   * because the rule is a server rule and the screen should not carry a second copy of
   * it that can drift.
   */
  canChangeRole: boolean;
}

export interface RoleChangeEntry {
  membershipId: string;
  fullName: string;
  agentCode: string;
  fromRole: HierarchyRole | null;
  toRole: HierarchyRole | null;
  reason: string | null;
  actorName: string | null;
  changedAt: string;
}

/**
 * Changing what somebody is.
 *
 * Two rules, and they come from different places. **Agent ⇄ AAB is the direct leader's
 * call** — they are the person who knows whether somebody is ready to lead. **Anything
 * involving AB is the Owner's or an Admin's**, because an AB sits at or near the root
 * and the shape of the office is not a unit-level decision.
 *
 * A role change never moves anybody. The prototype is explicit about this in its own
 * copy — *"they'll keep reporting to you"* — and it is right: promoting somebody is a
 * statement about them, not a reorganisation.
 */
@Injectable()
export class RoleChangeService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly history: MembershipHistoryRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  private requireMember(ctx: RequestContext): string {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
        HttpStatus.FORBIDDEN,
      );
    }
    return ctx.membershipId;
  }

  /**
   * May this person change that person's role, and to what?
   *
   * One function, because the screen and the write both need the answer and two copies
   * would drift — which is exactly how a control ends up rendered for something the
   * server then refuses.
   */
  private permitted(
    ctx: RequestContext,
    target: { leaderId: string | null; role: HierarchyRole },
  ): { agentAndAab: boolean; anythingWithAb: boolean } {
    const tenantAdmin = Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
    return {
      // The direct leader, and only the direct leader.
      agentAndAab: tenantAdmin || target.leaderId === ctx.membershipId,
      anythingWithAb: tenantAdmin,
    };
  }

  /** The people who report to this leader, with what they may do to each. */
  async team(ctx: RequestContext): Promise<TeamMember[]> {
    const me = this.requireMember(ctx);

    const rows = await this.members.find(
      ctx,
      { leaderId: me, status: 'active' },
      { sort: { agentSeq: 1 } },
    );
    if (rows.length === 0) return [];

    const users = await this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).exec();
    const byUser = new Map(users.map((u) => [String(u._id), u]));

    return rows.map((r) => {
      const fullName = byUser.get(r.userId)?.fullName ?? 'Unknown';
      const rules = this.permitted(ctx, r);
      return {
        membershipId: String(r._id),
        fullName,
        initials: initialsOf(fullName),
        agentCode: r.agentCode,
        role: r.role,
        directCount: r.directCounts?.total ?? 0,
        // An AB report never gets the control, even for a leader who manages the rest —
        // AC-1. The prototype does the same, and it is the honest place to draw the line.
        canChangeRole: r.role === 'ab' ? rules.anythingWithAb : rules.agentAndAab,
      };
    });
  }

  async change(
    ctx: RequestContext,
    membershipId: string,
    toRole: HierarchyRole,
    reason?: string,
  ): Promise<TeamMember[]> {
    const me = this.requireMember(ctx);

    const target = await this.members.findById(ctx, membershipId);
    if (!target || target.status === 'removed') throw new NotFoundException('Membership');
    if (target.role === toRole) return this.team(ctx);

    // The same reasoning as removal: an Owner demoted out of AB keeps owning the office
    // while losing the rung that goes with it, and only the platform can reassign an
    // office. Refused for everybody, including the Owner themselves.
    if (await this.hierarchy.ownsTheOffice(ctx, target)) {
      throw new DomainException(
        ErrorCode.ORG_ROLE_CHANGE_NOT_PERMITTED,
        'They own this office. Transfer it first — only the platform can do that.',
        HttpStatus.FORBIDDEN,
        { membershipId, fromRole: target.role, toRole },
      );
    }

    const rules = this.permitted(ctx, target);
    const involvesAb = target.role === 'ab' || toRole === 'ab';
    if (involvesAb ? !rules.anythingWithAb : !rules.agentAndAab) {
      throw new DomainException(
        ErrorCode.ORG_ROLE_CHANGE_NOT_PERMITTED,
        involvesAb
          ? 'Only the office’s Owner or an Admin can make somebody an Agency Builder, or stop them being one.'
          : 'Only somebody’s direct leader can change their role.',
        HttpStatus.FORBIDDEN,
        { membershipId, fromRole: target.role, toRole },
      );
    }

    // AC-3. Demoting somebody who still leads people would leave those people reporting
    // to somebody who, by the role they now hold, cannot lead them. Refused with the
    // count, so the caller knows what has to happen first rather than being told "no".
    const demoting = target.role !== 'agent' && toRole === 'agent';
    const directCount = target.directCounts?.total ?? 0;
    if (demoting && directCount > 0) {
      throw new DomainException(
        ErrorCode.ORG_HAS_DIRECT_REPORTS,
        `${directCount} ${directCount === 1 ? 'person reports' : 'people report'} to them. Move them to another leader first.`,
        HttpStatus.CONFLICT,
        { membershipId, directCount },
      );
    }

    const fromRole = target.role;
    const fromOrgLevelId = target.orgLevelId;
    // Through the hierarchy service, which writes the reference and the enum together.
    // A `$set: { role }` here would leave `orgLevelId` on the rung they left.
    const moved = await this.hierarchy.setLevel(ctx, membershipId, toRole);

    // Append-only: the open edge is closed, and a new one opened. The Role change log
    // reads exactly these rows, and nothing else could reconstruct them.
    //
    // **Every open edge, not only an earlier role change** (P11-T3). This closed
    // `role_changed` rows alone, so a promotion left the edge they joined or moved on open
    // beside it: two current edges. The row carries the leader they keep, since a role
    // change moves nobody (ADR-0014), so the one open edge says all of where they stand.
    await this.history.openEdge(ctx, this.clock.now(), {
      membershipId,
      eventType: 'role_changed',
      fromRole,
      toRole,
      // The rungs those names referred to at the time. A company that later renames a
      // level leaves this row still legible.
      fromOrgLevelId,
      toOrgLevelId: moved.orgLevelId,
      toLeaderId: target.leaderId,
      actorMembershipId: me,
      reason: reason?.trim() || null,
    });

    // The leader's cached counts break down by role, so a promotion changes them even
    // though nobody moved.
    await this.hierarchy.refreshCounts(ctx, target.leaderId);

    await this.notifications.send({
      userId: target.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.ROLE_CHANGED,
      payload: { fromRole, toRole, reason: reason?.trim() ?? null },
    });

    await this.audit.record(ctx, {
      action: 'member.role_changed',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before: { role: fromRole },
      after: { role: toRole, reason: reason?.trim() ?? null },
    });

    return this.team(ctx);
  }

  /**
   * The Role change log — the only audit surface either prototype has.
   *
   * Read from `membershipHistory` rather than the audit log: this is a product screen
   * about people, not a security trail, and the history rows are the ones that carry
   * the before-and-after of a role.
   */
  async log(ctx: RequestContext, limit = 100): Promise<RoleChangeEntry[]> {
    this.requireMember(ctx);

    const rows = await this.history.find(
      ctx,
      { eventType: 'role_changed' },
      { sort: { validFrom: -1 }, limit },
    );
    if (rows.length === 0) return [];

    const memberships = await this.members.find(ctx, {
      _id: { $in: [...new Set([...rows.map((r) => r.membershipId), ...rows.map((r) => r.actorMembershipId).filter((a): a is string => !!a)])] },
    });
    const byMembership = new Map(memberships.map((m) => [String(m._id), m]));

    const users = await this.users
      .find({ _id: { $in: memberships.map((m) => m.userId) } })
      .exec();
    const nameOf = new Map(users.map((u) => [String(u._id), u.fullName]));
    const named = (membershipId: string | null) => {
      const membership = membershipId ? byMembership.get(membershipId) : null;
      return membership ? (nameOf.get(membership.userId) ?? null) : null;
    };

    return rows.map((r) => {
      const membership = byMembership.get(r.membershipId);
      return {
        membershipId: r.membershipId,
        fullName: named(r.membershipId) ?? 'Unknown',
        agentCode: membership?.agentCode ?? '',
        fromRole: r.fromRole,
        toRole: r.toRole,
        reason: r.reason,
        actorName: named(r.actorMembershipId),
        changedAt: r.validFrom.toISOString(),
      };
    });
  }
}
