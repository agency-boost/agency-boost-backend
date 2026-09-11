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
import { MembershipHistoryRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole } from './membership.schema';

export interface DelegatedAdmin {
  membershipId: string;
  fullName: string;
  initials: string;
  agentCode: string;
  /** Independent of admin rights — AC-2. Both seeded admins are ABs. */
  role: HierarchyRole;
  grantedAt: string | null;
  grantedByName: string | null;
  /** Whether the reader may take it away. False for the Owner's own row. */
  canRevoke: boolean;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  return (parts[0][0] + (parts[parts.length - 1][0] ?? '')).toUpperCase();
}

/**
 * Who the Owner has handed the office's administration to.
 *
 * **Orthogonal to hierarchy** (AC-2). Admin rights say what somebody may configure and
 * report on; the hierarchy role says who reports to them. A person can be an AB with a
 * unit of forty and also an Admin, and in the prototype's own seed both admins are ABs.
 * Nothing here reads or writes `role`, and nothing in the hierarchy reads `adminAccess`.
 *
 * **Only the Owner grants or revokes** (AC-1). That is enforced at the guard, from the
 * grant list itself: `kpm_admin:grant` names no tenant grantee but the Owner, so an
 * Admin is refused with `PERM_OWNER_ONLY` rather than a flat `PERM_DENIED` — they are
 * told the Owner reserved it, not that they picked the wrong screen.
 *
 * An Admin may still *read* the list. Knowing who else administers the office is not a
 * power, and hiding it would make the nav lie rather than make anything safer.
 */
@Injectable()
export class AdminDelegationService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly history: MembershipHistoryRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  private requireOffice(ctx: RequestContext): string {
    if (!ctx.kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
        HttpStatus.FORBIDDEN,
      );
    }
    return ctx.kpmId;
  }

  async list(ctx: RequestContext): Promise<DelegatedAdmin[]> {
    this.requireOffice(ctx);

    const rows = await this.members.find(
      ctx,
      { 'adminAccess.isKpmAdmin': true, status: { $ne: 'removed' } },
      { sort: { agentSeq: 1 } },
    );
    if (rows.length === 0) return [];

    const named = await this.namesFor([
      ...rows.map((r) => r.userId),
      ...rows.map((r) => r.adminAccess?.grantedByUserId).filter((u): u is string => !!u),
    ]);
    const isOwner = Boolean(ctx.membership?.isKpmOwner);

    return rows.map((row) => {
      const fullName = named.get(row.userId) ?? 'Unknown';
      const grantedBy = row.adminAccess?.grantedByUserId;
      return {
        membershipId: String(row._id),
        fullName,
        initials: initialsOf(fullName),
        agentCode: row.agentCode,
        role: row.role,
        grantedAt: row.adminAccess?.grantedAt?.toISOString() ?? null,
        // Null for the seeded Owner, who was never granted it by anybody.
        grantedByName: grantedBy ? (named.get(grantedBy) ?? 'Unknown') : null,
        canRevoke: isOwner && String(row._id) !== ctx.membershipId,
      };
    });
  }

  async grant(ctx: RequestContext, membershipId: string): Promise<DelegatedAdmin[]> {
    const kpmId = this.requireOffice(ctx);
    const target = await this.members.findById(ctx, membershipId);
    if (!target || target.status === 'removed') throw new NotFoundException('Membership');

    if (target.adminAccess?.isKpmAdmin) {
      throw new DomainException(
        ErrorCode.ORG_ALREADY_ADMIN,
        'They already administer this office.',
        HttpStatus.CONFLICT,
        { membershipId },
      );
    }

    // A pending member has not been let in yet. Handing them the office first would be
    // the one order of operations nobody intends.
    if (target.status !== 'active') {
      throw new DomainException(
        ErrorCode.ORG_ADMIN_TARGET_NOT_ACTIVE,
        'They have not joined the office yet.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { membershipId, status: target.status },
      );
    }

    const now = this.clock.now();
    await this.members.updateById(ctx, membershipId, {
      $set: {
        adminAccess: {
          isKpmAdmin: true,
          grantedByUserId: ctx.auditActors.actorUserId,
          grantedAt: now,
          revokedAt: null,
        },
      },
    });

    await this.record(ctx, membershipId, 'admin_granted', now);

    await this.notifications.send({
      userId: target.userId,
      kpmId,
      templateId: NotificationTemplate.ADMIN_ACCESS_CHANGED,
      payload: { granted: true },
    });

    // AC-3: both parties. `record` on the audit service already carries the actor; the
    // target is named explicitly so the trail answers "who did this to whom" from one
    // row rather than from a join.
    await this.audit.record(ctx, {
      action: 'kpm_admin.granted',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before: { isKpmAdmin: false },
      after: { isKpmAdmin: true, grantedByUserId: ctx.auditActors.actorUserId },
    });

    return this.list(ctx);
  }

  async revoke(ctx: RequestContext, membershipId: string): Promise<DelegatedAdmin[]> {
    const kpmId = this.requireOffice(ctx);
    const target = await this.members.findById(ctx, membershipId);
    if (!target) throw new NotFoundException('Membership');

    if (!target.adminAccess?.isKpmAdmin) {
      throw new DomainException(
        ErrorCode.ORG_NOT_AN_ADMIN,
        'They do not administer this office.',
        HttpStatus.CONFLICT,
        { membershipId },
      );
    }

    // The Owner's own rights come from being the Owner, not from a grant. Revoking them
    // would leave an office nobody could administer and nobody could fix. Only the Owner
    // reaches this route, so their own row is the one that matches the caller.
    if (membershipId === ctx.membershipId) {
      throw new DomainException(
        ErrorCode.PERM_OWNER_ONLY,
        'The Owner’s own access cannot be revoked. Transfer the office instead.',
        HttpStatus.FORBIDDEN,
        { membershipId },
      );
    }

    const now = this.clock.now();
    await this.members.updateById(ctx, membershipId, {
      $set: {
        'adminAccess.isKpmAdmin': false,
        'adminAccess.revokedAt': now,
      },
    });

    await this.record(ctx, membershipId, 'admin_revoked', now);

    await this.notifications.send({
      userId: target.userId,
      kpmId,
      templateId: NotificationTemplate.ADMIN_ACCESS_CHANGED,
      payload: { granted: false },
    });

    await this.audit.record(ctx, {
      action: 'kpm_admin.revoked',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before: { isKpmAdmin: true, grantedAt: target.adminAccess?.grantedAt ?? null },
      after: { isKpmAdmin: false },
    });

    return this.list(ctx);
  }

  /**
   * Append-only, like every other membership event.
   *
   * `adminAccess` on the row is the current answer; these rows are how the office answers
   * *"who could administer this in March"* — which nothing else can reconstruct once a
   * grant has been revoked and re-granted.
   */
  private async record(
    ctx: RequestContext,
    membershipId: string,
    eventType: 'admin_granted' | 'admin_revoked',
    at: Date,
  ): Promise<void> {
    await this.history.updateMany(
      ctx,
      {
        membershipId,
        eventType: { $in: ['admin_granted', 'admin_revoked'] },
        validTo: null,
      },
      { $set: { validTo: at } },
    );
    await this.history.create(ctx, {
      membershipId,
      eventType,
      validFrom: at,
      validTo: null,
      actorMembershipId: ctx.membershipId,
      actorUserId: ctx.auditActors.actorUserId,
    });
  }

  private async namesFor(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const found = await this.users.find({ _id: { $in: unique } }).exec();
    return new Map(found.map((u) => [String(u._id), u.fullName]));
  }
}
