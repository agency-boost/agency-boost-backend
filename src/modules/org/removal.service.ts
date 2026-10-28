import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { HierarchyService } from './hierarchy.service';
import { MembershipHistoryRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import type { MembershipDocument } from './membership.schema';
import { MemberDeparture } from './member-departure.port';
import { visibleTo } from './reader-visibility';
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
  private readonly logger = new Logger(RemovalService.name);

  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly roles: RoleChangeService,
    private readonly history: MembershipHistoryRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
    /**
     * What the rest of the product does when somebody leaves (D-leave): the calendar's future entries.
     * Optional so a spec of removal alone builds it without the calendar.
     *
     * **Injected by its token, named** (found 2026-10-03, Phase 13): a parameter typed `MemberDeparture |
     * null` is emitted to the container as `Object`, so `@Optional()` alone resolved nothing in the running
     * app and the hook never ran there — while every spec, which builds this by hand, passed.
     * `app.module.int.spec.ts` now asserts each optional port is wired.
     */
    @Optional() @Inject(MemberDeparture) private readonly departures: MemberDeparture | null = null,
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

    await this.refuseTheOffice(ctx, target);

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

      /**
       * **The destination has to be somewhere this actor can already reach.**
       *
       * `reparent` checks that it exists in the tenant, is not removed, and would not
       * make a cycle — all true of a *peer's* membership. Without this, an AB removing
       * their own AAB could name a peer AB as the destination and hand that peer a unit
       * they never led: a write at `own-unit` changing what a different `own-unit` reader
       * can see, through `ancestorIds`, on every screen built on it.
       *
       * `visibleTo` is the same function the roster and the tree read through, so "where
       * you may put people" and "who you can see" cannot drift apart. A tenant admin gets
       * `{}` and may name anybody in the office.
       *
       * **404, not 403** — a destination outside your reach reads exactly like one that
       * does not exist, which is the rule everywhere else in this module.
       */
      if (destination) {
        const reachable = await this.members.findOne(ctx, {
          $and: [{ _id: destination }, visibleTo(ctx, 'member:remove_from_team')],
        });
        if (!reachable) throw new NotFoundException('Membership');
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

    await this.depart(ctx, target, {
      at: this.clock.now(),
      reason: input.reason?.trim() ?? null,
      after: { subtree: reports.length > 0 ? (input.subtree ?? null) : null, reportsMoved: reports.length },
    });

    return this.roles.team(ctx);
  }

  /**
   * **Nobody leaves who holds the office up** — `remove`'s two rules, shared with every other way out of the office
   * that ends in `depart` (*Mark left*, `Activation3MService.markLeft`; the P18.96 exit review, M1), so none of them can
   * take out somebody `remove` would refuse. `403 ORG_REMOVAL_NOT_PERMITTED` for both.
   */
  async refuseTheOffice(ctx: RequestContext, target: MembershipDocument): Promise<void> {
    const membershipId = String(target._id);
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

    /**
     * **The office's owner cannot be removed from inside the office.**
     *
     * The root check above catches them *usually*, because `ensureOwnerMembership`
     * creates an owner with no leader. It does not catch the ordinary transfer case: when
     * ownership moves to somebody who is already a member, their existing row keeps its
     * `leaderId`. A KPM Admin could then remove them — leaving `kpms.ownerUserId` naming
     * somebody with no membership, so nobody resolves as Owner, and `kpm_admin:grant` is
     * Owner-reserved. The office would have no working administration until a Super Admin
     * re-ran `assignOwner`.
     */
    if (await this.hierarchy.ownsTheOffice(ctx, target)) {
      throw new DomainException(
        ErrorCode.ORG_REMOVAL_NOT_PERMITTED,
        'They own this office. Transfer it first — only the platform can do that.',
        HttpStatus.FORBIDDEN,
        { membershipId },
      );
    }
  }

  /**
   * **The removal itself, once every rule above has let it through** (P18.96-T6): the status and `removedAt`, the open
   * edge closed and a `removed` event opened, the leader's counts, the person's notice, the audit row and the departure
   * hook — **never with reports**, whom the caller has moved first. `remove` calls it after its own checks; *Mark left*
   * (`Activation3MService.markLeft`, ADR-0173 §3 as amended) calls it for a new hire who leads nobody, after
   * `refuseTheOffice`, so a leaver leaves every count of people through the one path ADR-0136's leaver counting reads.
   */
  async depart(
    ctx: RequestContext,
    target: MembershipDocument,
    input: { at: Date; reason: string | null; after?: Record<string, unknown> },
  ): Promise<void> {
    const me = ctx.membershipId!;
    const membershipId = String(target._id);
    const now = input.at;
    const formerLeaderId = target.leaderId;

    await this.members.updateById(ctx, membershipId, {
      $set: { status: 'removed', removedAt: now },
    });

    // Append-only. The open edge — whichever event opened it — is closed, and a
    // `removed` event opened in its place. Their agent code, role and leader at the
    // moment of removal all stay on the row; nothing is blanked.
    await this.history.updateMany(ctx, { membershipId, validTo: null }, { $set: { validTo: now } });
    await this.history.create(ctx, {
      membershipId,
      eventType: 'removed',
      fromRole: target.role,
      fromLeaderId: formerLeaderId,
      validFrom: now,
      validTo: null,
      actorMembershipId: me,
      actorUserId: ctx.auditActors.actorUserId,
      reason: input.reason || null,
    });

    await this.hierarchy.refreshCounts(ctx, formerLeaderId);

    await this.notifications.send({
      userId: target.userId,
      kpmId: ctx.kpmId!,
      templateId: NotificationTemplate.MEMBER_REMOVED,
      payload: {
        reason: input.reason ?? null,
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
      after: { status: 'removed', reason: input.reason ?? null, subtree: null, reportsMoved: 0, ...(input.after ?? {}) },
    });

    // D-leave: the modules that keep per-member records, after the removal is written. Never its failure.
    if (this.departures) {
      try {
        await this.departures.left(ctx, membershipId);
      } catch (err) {
        this.logger.error({ err, membershipId }, 'failed to settle a departing member’s records');
      }
    }
  }
}
