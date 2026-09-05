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
import { HierarchyService } from './hierarchy.service';
import { MembershipHistory, MembershipHistoryDocument } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { RoleChangeService, TeamMember } from './role-change.service';

/** Where the reports of somebody being removed are to go. */
export type SubtreeDisposition =
  | { action: 'reassign'; toMembershipId: string }
  | { action: 'orphan' };

/**
 * The confirmation word. Trimmed and upper-cased before comparison, exactly as the
 * prototype does it (`Overall.html:9089`).
 */
export const REMOVAL_CONFIRMATION = 'REMOVE';

/**
 * Removing somebody from the office.
 *
 * Three things make this different from every other write in the module.
 *
 * **It is confirmed, and confirmed here.** The prototype gates its button on typing
 * `REMOVE`. A gate that lives only in the screen is not a gate: the endpoint is reachable
 * without it. So the word arrives in the body and the service checks it — the screen's
 * copy of the check is a convenience, not the control.
 *
 * **Nothing is deleted.** `status: 'removed'` and a `removedAt`; the row, the agent code
 * and every history event stay with the tenant. The prototype splices the person out of
 * an array and they cease to have existed — the defect this exists to not rebuild.
 *
 * **Their reports have to go somewhere.** Removing a leader without saying where their
 * unit goes leaves people pointing at a membership that is no longer in the office. The
 * caller says: to somebody named, or unassigned. There is no default, because a default
 * here is a silent reorganisation.
 */
@Injectable()
export class RemovalService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly roles: RoleChangeService,
    @InjectModel(MembershipHistory.name)
    private readonly history: Model<MembershipHistoryDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  async remove(
    ctx: RequestContext,
    membershipId: string,
    input: { confirmation: string; reason?: string; subtree?: SubtreeDisposition },
  ): Promise<TeamMember[]> {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
        HttpStatus.FORBIDDEN,
      );
    }
    const me = ctx.membershipId;

    // AC-1, and before anything is read: a request that was never confirmed should not
    // even look up the person it names.
    if (input.confirmation?.trim().toUpperCase() !== REMOVAL_CONFIRMATION) {
      throw new DomainException(
        ErrorCode.ORG_REMOVAL_NOT_CONFIRMED,
        `Type ${REMOVAL_CONFIRMATION} to confirm.`,
        HttpStatus.BAD_REQUEST,
        { expected: REMOVAL_CONFIRMATION },
      );
    }

    const target = await this.members.findById(ctx, membershipId);
    if (!target) throw new NotFoundException('Membership');
    if (target.status === 'removed') {
      throw new DomainException(
        ErrorCode.ORG_ALREADY_REMOVED,
        'They have already been removed from this office.',
        HttpStatus.CONFLICT,
        { membershipId, removedAt: target.removedAt?.toISOString() ?? null },
      );
    }

    if (membershipId === me) {
      throw new DomainException(
        ErrorCode.ORG_REMOVAL_NOT_PERMITTED,
        'You cannot remove yourself from the office.',
        HttpStatus.FORBIDDEN,
        { membershipId },
      );
    }

    // The root has no leader, so removing it leaves the whole office pointing at nothing
    // and no one able to put it back. Transferring the office is a Super Admin operation
    // on the tenant, not a member operation inside it.
    if (target.leaderId === null) {
      throw new DomainException(
        ErrorCode.ORG_REMOVAL_NOT_PERMITTED,
        'The office’s root member cannot be removed. Reassign the office first.',
        HttpStatus.FORBIDDEN,
        { membershipId },
      );
    }

    const tenantAdmin = Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
    if (!tenantAdmin && target.leaderId !== me) {
      throw new DomainException(
        ErrorCode.ORG_REMOVAL_NOT_PERMITTED,
        'Only somebody’s direct leader can remove them.',
        HttpStatus.FORBIDDEN,
        { membershipId },
      );
    }

    // AC-3. The reports are moved first: if the disposition is refused, nothing has
    // happened yet and the caller is looking at the office they thought they had.
    const reports = await this.members.find(ctx, {
      leaderId: membershipId,
      status: { $ne: 'removed' },
    });
    if (reports.length > 0) {
      if (!input.subtree) {
        throw new DomainException(
          ErrorCode.ORG_SUBTREE_DISPOSITION_REQUIRED,
          `${reports.length} ${reports.length === 1 ? 'person reports' : 'people report'} to them. ` +
            'Say where they go before removing this leader.',
          HttpStatus.BAD_REQUEST,
          { membershipId, directCount: reports.length },
        );
      }

      const destination =
        input.subtree.action === 'reassign' ? input.subtree.toMembershipId : null;
      if (destination === membershipId) {
        throw new DomainException(
          ErrorCode.ORG_SUBTREE_DISPOSITION_REQUIRED,
          'Their reports cannot be moved to the person being removed.',
          HttpStatus.BAD_REQUEST,
          { membershipId, directCount: reports.length },
        );
      }

      for (const report of reports) {
        // `reparent` carries the cycle check and the re-splice, and writes the
        // `re_parented` history row — so the move is legible afterwards as its own
        // event rather than being inferred from a removal.
        await this.hierarchy.reparent(
          ctx,
          String(report._id),
          destination,
          `Leader removed from the office${input.reason?.trim() ? `: ${input.reason.trim()}` : ''}`,
        );
      }
    }

    const now = this.clock.now();
    const formerLeaderId = target.leaderId;

    await this.members.updateById(ctx, membershipId, {
      $set: { status: 'removed', removedAt: now },
    });

    // Append-only. The open edge — whichever event opened it — is closed, and a
    // `removed` event opened in its place. Their agent code, role and leader at the
    // moment of removal all stay on the row; nothing is blanked.
    await this.history
      .updateMany({ membershipId, validTo: null }, { $set: { validTo: now } })
      .exec();
    await this.history.create({
      kpmId: ctx.kpmId,
      membershipId,
      eventType: 'removed',
      fromRole: target.role,
      fromLeaderId: formerLeaderId,
      validFrom: now,
      validTo: null,
      actorMembershipId: me,
      actorUserId: ctx.auditActors.actorUserId,
      reason: input.reason?.trim() || null,
    });

    await this.hierarchy.refreshCounts(ctx, formerLeaderId);

    await this.notifications.send({
      userId: target.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.MEMBER_REMOVED,
      payload: {
        reason: input.reason?.trim() ?? null,
        // What the prototype's own copy tells them to do next.
        nextStep:
          'Search for a leader and request to join again if you want to come back.',
      },
    });

    await this.audit.record(ctx, {
      action: 'member.removed',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before: { status: target.status, leaderId: formerLeaderId, role: target.role },
      after: {
        status: 'removed',
        reason: input.reason?.trim() ?? null,
        subtree: reports.length > 0 ? (input.subtree ?? null) : null,
        reportsMoved: reports.length,
      },
    });

    return this.roles.team(ctx);
  }
}
