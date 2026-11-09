import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { isLeaderClass } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { can } from '@/modules/rbac/permissions';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { displayNameOf } from '@/modules/users/display-name';
import { User, UserDocument } from '@/modules/users/user.schema';
import { ApprovalsService } from './approvals.service';
import { HierarchyService } from './hierarchy.service';
import { countLeadersUsed, countLeadersUsedPerOffice, leaderLimitRequestStale } from './leader-limit';
import {
  LEADER_LIMIT_MESSAGES, LEADER_LIMIT_REFUSALS, STALE_REASONS, type StaleReason,
} from './leader-limit.messages';
import {
  LeaderLimitAction, LeaderLimitRequestDocument, LeaderLimitRequestStatus,
} from './leader-limit-request.schema';
import { MembershipRepository } from './membership.repository';
import { MembershipDocument } from './membership.schema';
import { ORG_MESSAGES, ORG_REFUSALS } from './org.messages';
import { LeaderLimitRequestRepository } from './org.repositories';
import { RoleChangeService } from './role-change.service';

/** One request, as the office's screens and the Super Admin's queue read it. */
export interface LeaderLimitRequestRow {
  requestId: string;
  kpmId: string;
  /** The office, as the console names it: its code and branch. */
  kpmCode: string;
  kpmBranchName: string;
  subjectMembershipId: string;
  subjectName: string;
  subjectAgentCode: string;
  action: LeaderLimitAction;
  /** The rung the subject stood on when asked, by code. */
  fromOrgLevelCode: string;
  /** `promote`: the rung asked for. `null` for an activation, which keeps the rung they stand on. */
  toOrgLevelCode: string | null;
  /** `promote`: the reason the office gave, which the role change log keeps when it is made. */
  reason: string | null;
  requestedByMembershipId: string;
  requestedByName: string;
  status: LeaderLimitRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  /** The Super Admin's reason, or that it no longer applied. */
  declineReason: string | null;
  /** The office's limit and *Leaders used* now, so the decision is taken against the count it changes. */
  maxLeaders: number | null;
  leadersUsed: number;
}

/** Pending first, because that is what needs deciding; then newest first. */
const RANK: Record<LeaderLimitRequestStatus, number> = { pending: 0, approved: 1, declined: 2, cancelled: 3 };

/**
 * **A leader past the office's limit waits for AgencyBoost's approval** (ADR-0157, amending ADR-0113 §2).
 *
 * The two single-member writes the leader limit refuses — a role change onto a leader rung, and letting in a
 * pending member who stands on one — become a request instead of a dead end: the office asks, the Super Admin
 * decides, and an approval **carries the act out past the limit** under the office's leader lease, after
 * checking it still applies. The quota does not move, so an approved request is an office reading above it.
 *
 * The office asks only for what it could do itself: `RoleChangeService.assertMayAsk` and
 * `ApprovalsService.activationFor` meet every refusal the write would, in its words, and refuse an ask the
 * limit would not stop. Nothing about the member changes while it waits.
 */
@Injectable()
export class LeaderLimitRequestService {
  constructor(
    private readonly requests: LeaderLimitRequestRepository,
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly roles: RoleChangeService,
    private readonly approvals: ApprovalsService,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  private requireMember(ctx: RequestContext): string {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(ErrorCode.TENANT_NO_MEMBERSHIP, ORG_REFUSALS.TENANT_NO_MEMBERSHIP.notInOffice, HttpStatus.FORBIDDEN);
    }
    return ctx.membershipId;
  }

  private isTenantAdmin(ctx: RequestContext): boolean {
    return Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
  }

  /**
   * **Ask AgencyBoost to approve one leader past the limit** (AC-3): `promote` names the rung and keeps the
   * reason; `activate` lets in a pending member on the rung they stand on. One open request per subject.
   */
  async create(
    ctx: RequestContext,
    membershipId: string,
    input: { action: LeaderLimitAction; orgLevelCode?: string; reason?: string },
  ): Promise<LeaderLimitRequestRow> {
    const me = this.requireMember(ctx);

    let target: MembershipDocument;
    const fields: Partial<LeaderLimitRequestDocument> = {};
    if (input.action === 'promote') {
      if (!input.orgLevelCode?.trim()) {
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          LEADER_LIMIT_REFUSALS.VALIDATION_FAILED.nameTheRung,
          HttpStatus.BAD_REQUEST,
          { field: 'orgLevelCode' },
        );
      }
      const asked = await this.roles.assertMayAsk(ctx, membershipId, input.orgLevelCode.trim());
      target = asked.target;
      fields.toOrgLevelCode = asked.toCode;
      fields.reason = input.reason?.trim() || null;
    } else {
      const asked = await this.approvals.activationFor(ctx, membershipId);
      target = asked.target;
      fields.joinRequestId = asked.joinRequestId;
      fields.leaderMembershipId = asked.leaderMembershipId;
    }

    // One open ask per subject. The partial unique index is the guarantee; this turns it into a sentence.
    const open = await this.requests.findOne(ctx, { subjectMembershipId: membershipId, status: 'pending' });
    if (open) throw requestOpen(String(open._id));

    let created: LeaderLimitRequestDocument;
    try {
      created = await this.requests.create(ctx, {
        ...fields,
        subjectMembershipId: membershipId,
        action: input.action,
        fromOrgLevelCode: target.orgLevelCode,
        requestedByMembershipId: me,
        status: 'pending',
        decidedAt: null,
        decidedByUserId: null,
        declineReason: null,
      });
    } catch (err) {
      // Two asks at once: the index let one through, and the other is told so.
      if ((err as { code?: number }).code === 11000) {
        const winner = await this.requests.findOne(ctx, { subjectMembershipId: membershipId, status: 'pending' });
        throw requestOpen(winner ? String(winner._id) : null);
      }
      throw err;
    }

    await this.audit.record(ctx, {
      action: 'leader_limit_request.created',
      targetCollection: 'leaderLimitRequests',
      targetId: String(created._id),
      targetMembershipId: membershipId,
      after: {
        action: input.action,
        fromOrgLevelCode: target.orgLevelCode,
        toOrgLevelCode: fields.toOrgLevelCode ?? null,
        joinRequestId: fields.joinRequestId ?? null,
      },
    });

    return (await this.rows(ctx, [created]))[0];
  }

  /**
   * **The office's requests** (AC-3): every one for the Owner and an Admin; for an AB or AAB, those they asked.
   * Pending first. Another office's are never here — the repository scopes to the reader's office.
   */
  async list(ctx: RequestContext): Promise<LeaderLimitRequestRow[]> {
    const me = this.requireMember(ctx);
    const found = await this.requests.find(
      ctx,
      this.isTenantAdmin(ctx) ? {} : { requestedByMembershipId: me },
      { sort: { createdAt: -1 } },
    );
    return this.rows(ctx, ranked(found));
  }

  /**
   * **Withdraw an open request** (AC-3): whoever asked, or the Owner or an Admin. Another office's request, or
   * one this reader neither made nor administers, is not found.
   */
  async cancel(ctx: RequestContext, requestId: string): Promise<LeaderLimitRequestRow[]> {
    const me = this.requireMember(ctx);
    const request = await this.requests.findById(ctx, requestId);
    if (!request || !(request.requestedByMembershipId === me || this.isTenantAdmin(ctx))) {
      throw new NotFoundException('Leader-limit request');
    }
    assertPending(request);

    await this.requests.updateById(ctx, requestId, {
      $set: { status: 'cancelled', decidedAt: this.clock.now(), decidedByUserId: ctx.auditActors.actorUserId },
    });
    await this.audit.record(ctx, {
      action: 'leader_limit_request.cancelled',
      targetCollection: 'leaderLimitRequests',
      targetId: requestId,
      targetMembershipId: request.subjectMembershipId,
      before: { status: 'pending' },
      after: { status: 'cancelled' },
    });
    return this.list(ctx);
  }

  /** **The platform's queue** (AC-4): every office's requests, pending first. The Super Admin's alone. */
  async queue(ctx: RequestContext): Promise<LeaderLimitRequestRow[]> {
    this.requireDecider(ctx, 'leader_limit_request:read');
    const found = await this.requests.queueAcrossTenants(ctx);
    return this.rows(ctx, ranked(found));
  }

  /**
   * **Approve: carry the act out past the limit** (AC-4).
   *
   * The act is re-checked — the member live and on the rung they stood on when asked, still pending for an
   * activation, the rung asked for still a leader rung on the ladder — and then made by the same code the office
   * would have used, in the request's office and no other, with the leader lease held. A request that no longer
   * applies answers `409 LEADER_LIMIT_REQUEST_STALE` and is closed as declined, with what changed as its reason,
   * and the asker told.
   */
  async approve(ctx: RequestContext, requestId: string): Promise<LeaderLimitRequestRow[]> {
    this.requireDecider(ctx, 'leader_limit_request:decide');
    const request = await this.decidable(ctx, requestId);
    const office = RequestContext.superAdminInTenant(ctx.userId, request.kpmId);

    // Claimed before anything is done: of two Super Admins approving at once, one wins here and the other is told
    // it was decided — so a decision is never written over another (the permission review, 2026-10-26).
    await this.transitionOrDecided(office, request, 'pending', {
      status: 'approved', decidedAt: this.clock.now(), decidedByUserId: ctx.auditActors.actorUserId, declineReason: null,
    });

    const stillApplies = async (target: MembershipDocument | null): Promise<void> => {
      const why = staleReason(request, target) ?? (await this.askerReason(office, request, target));
      if (why) throw leaderLimitRequestStale(requestId, why);
    };

    try {
      if (request.action === 'promote') {
        await this.assertRungLeads(office, request);
        await this.roles.carryOutApproved(office, {
          requestId,
          subjectMembershipId: request.subjectMembershipId,
          toOrgLevelCode: request.toOrgLevelCode as string,
          reason: request.reason,
          requestedByMembershipId: request.requestedByMembershipId,
        }, stillApplies);
      } else {
        await this.approvals.carryOutApproved(office, {
          requestId,
          subjectMembershipId: request.subjectMembershipId,
          joinRequestId: request.joinRequestId,
          leaderMembershipId: request.leaderMembershipId as string,
          requestedByMembershipId: request.requestedByMembershipId,
        }, stillApplies);
      }
    } catch (err) {
      if (err instanceof DomainException && err.code === ErrorCode.LEADER_LIMIT_REQUEST_STALE) {
        // The sentence the refusal was given, both languages (`givenDetails`); the stored reason is written in the
        // deciding Super Admin's language, and shown as stored (P18.10-T5 AC-6).
        const why = (err.givenDetails as { why?: StaleReason } | undefined)?.why ?? STALE_REASONS.noLongerApplies;
        const reason = render(LEADER_LIMIT_MESSAGES.closedAsStale({ why }), ctx.reader);
        await this.close(ctx, office, request, 'declined', reason, 'stale', 'approved');
      } else {
        // Anything else left the act undone: the request goes back to waiting, to be decided again.
        await this.requests.transition(office, String(request._id), 'approved', {
          status: 'pending', decidedAt: null, decidedByUserId: null,
        });
      }
      throw err;
    }

    await this.close(ctx, office, request, 'approved', null, 'approved', 'approved');
    return this.queue(ctx);
  }

  /** **Decline** (AC-4): nothing about the member changes, and the reason travels back to whoever asked. */
  async decline(ctx: RequestContext, requestId: string, input: { reason: string }): Promise<LeaderLimitRequestRow[]> {
    this.requireDecider(ctx, 'leader_limit_request:decide');
    const reason = input.reason?.trim();
    if (!reason) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        LEADER_LIMIT_REFUSALS.VALIDATION_FAILED.sayWhy,
        HttpStatus.BAD_REQUEST,
        { field: 'reason' },
      );
    }
    const request = await this.decidable(ctx, requestId);
    const office = RequestContext.superAdminInTenant(ctx.userId, request.kpmId);
    await this.close(ctx, office, request, 'declined', reason, 'declined', 'pending');
    return this.queue(ctx);
  }

  /** The queue and the decisions are the platform's: an office's Owner holds `:read` for their own list only. */
  private requireDecider(ctx: RequestContext, permission: 'leader_limit_request:read' | 'leader_limit_request:decide'): void {
    if (!ctx.isSuperAdmin || !can(ctx, permission)) {
      throw new DomainException(
        ErrorCode.PERM_DENIED, LEADER_LIMIT_REFUSALS.PERM_DENIED.agencyBoostDecides, HttpStatus.FORBIDDEN, { permission },
      );
    }
  }

  /** The request, if it is still open. Deciding twice says which way the first went. */
  private async decidable(ctx: RequestContext, requestId: string): Promise<LeaderLimitRequestDocument> {
    const request = await this.requests.findByIdAcrossTenants(ctx, requestId);
    if (!request) throw new NotFoundException('Leader-limit request');
    assertPending(request);
    return request;
  }

  /** The conditional move; when it matches nothing, the request was decided meanwhile — say which way. */
  private async transitionOrDecided(
    office: RequestContext,
    request: LeaderLimitRequestDocument,
    from: 'pending' | 'approved',
    set: Record<string, unknown>,
  ): Promise<void> {
    if (await this.requests.transition(office, String(request._id), from, set)) return;
    const now = await this.requests.findById(office, String(request._id));
    assertPending(now ?? request);
    // Still pending although the move matched nothing: only a claim released between the two reads can do this.
    throw leaderLimitRequestStale(String(request._id), STALE_REASONS.changedWhileDeciding);
  }

  /**
   * **May whoever asked still make this change?** (the permission review, 2026-10-26). The asker's right was settled
   * when they asked; by the decision they may have left, lost the office's administration, or the member may have
   * moved to another leader's unit. An Owner or Admin still may; anyone else must still lead the member directly —
   * for a promotion, onto a rung that is not AB's class, as `RoleChangeService` allows; for an activation, as the
   * leader the request was routed to. `null` when they still may.
   */
  private async askerReason(
    office: RequestContext,
    request: LeaderLimitRequestDocument,
    target: MembershipDocument | null,
  ): Promise<StaleReason | null> {
    const asker = await this.members.findById(office, request.requestedByMembershipId);
    if (!asker || asker.status !== 'active') return STALE_REASONS.askerGone;
    const kpm = await this.kpms.findOne({ _id: request.kpmId, deletedAt: null }).exec();
    const tenantAdmin = asker.adminAccess?.isKpmAdmin === true || kpm?.ownerUserId === asker.userId;
    if (tenantAdmin) return null;
    if (request.action === 'activate') {
      return request.leaderMembershipId === String(asker._id) ? null : STALE_REASONS.notRoutedToAsker;
    }
    if (!target || target.leaderId !== String(asker._id)) return STALE_REASONS.noLongerReportsToAsker;
    const rung = await this.hierarchy.rungFor(office, request.toOrgLevelCode as string);
    return rung.role === 'ab' ? STALE_REASONS.abNeedsTheOffice : null;
  }

  /** A promotion's rung must still be on the ladder, and still lead: archived or re-tiered since, it is stale. */
  private async assertRungLeads(office: RequestContext, request: LeaderLimitRequestDocument): Promise<void> {
    const code = request.toOrgLevelCode as string;
    const rung = await this.hierarchy.rungFor(office, code).catch((err: unknown) => {
      if (err instanceof DomainException && err.code === ErrorCode.ORG_LEVEL_NOT_ON_LADDER) return null;
      throw err;
    });
    if (!rung) throw leaderLimitRequestStale(String(request._id), STALE_REASONS.rungOffTheLadder({ code }));
    if (!isLeaderClass(rung.role)) {
      throw leaderLimitRequestStale(String(request._id), STALE_REASONS.rungNoLongerLeads({ code }));
    }
  }

  /**
   * Write the decision, audit it, and tell whoever asked. `ctx` is the Super Admin's own, for the decider;
   * `office` the same person named in the request's office, where the row and its audit entry belong.
   */
  private async close(
    ctx: RequestContext,
    office: RequestContext,
    request: LeaderLimitRequestDocument,
    status: 'approved' | 'declined',
    declineReason: string | null,
    outcome: 'approved' | 'declined' | 'stale',
    // The status this decision found the request in: `pending` for a decline, `approved` once an approval has
    // claimed it. A request no longer in it was decided by somebody else, and nothing here is written twice.
    from: 'pending' | 'approved',
  ): Promise<void> {
    const requestId = String(request._id);
    await this.transitionOrDecided(office, request, from, {
      status, decidedAt: this.clock.now(), decidedByUserId: ctx.auditActors.actorUserId, declineReason,
    });
    await this.audit.record(office, {
      action: status === 'approved' ? 'leader_limit_request.approved' : 'leader_limit_request.declined',
      targetCollection: 'leaderLimitRequests',
      targetId: requestId,
      targetMembershipId: request.subjectMembershipId,
      before: { status: 'pending' },
      after: { status, declineReason, ...(outcome === 'stale' ? { stale: true } : {}) },
    });

    const [asker, subject] = await Promise.all([
      this.members.findById(office, request.requestedByMembershipId),
      this.members.findById(office, request.subjectMembershipId),
    ]);
    if (!asker || asker.status === 'removed') return;
    const subjectUser = subject ? await this.users.findById(subject.userId).exec() : null;
    await this.notifications.send({
      userId: asker.userId,
      membershipId: String(asker._id),
      kpmId: request.kpmId,
      templateId: status === 'approved'
        ? NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED
        : NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED,
      payload: {
        requestId,
        subjectName: displayNameOf(subjectUser),
        reason: declineReason,
      },
    });
  }

  /**
   * Requests as rows. Names come from each request's own office — read through the repository in that office,
   * named, for the Super Admin who is in none — and the limit and count from the office row and
   * `countLeadersUsedPerOffice`, so the queue shows what approving does to the number.
   */
  private async rows(ctx: RequestContext, found: LeaderLimitRequestDocument[]): Promise<LeaderLimitRequestRow[]> {
    if (found.length === 0) return [];
    const kpmIds = [...new Set(found.map((r) => r.kpmId))];
    const offices = await this.kpms.find({ _id: { $in: kpmIds } }).exec();
    const officeOf = new Map(offices.map((k) => [String(k._id), k]));

    const memberships = new Map<string, MembershipDocument>();
    for (const kpmId of kpmIds) {
      const scoped = ctx.kpmId === kpmId ? ctx : RequestContext.superAdminInTenant(ctx.userId, kpmId);
      const ids = [...new Set(found.filter((r) => r.kpmId === kpmId)
        .flatMap((r) => [r.subjectMembershipId, r.requestedByMembershipId]))];
      for (const m of await this.members.find(scoped, { _id: { $in: ids } })) memberships.set(String(m._id), m);
    }
    const users = await this.users.find({ _id: { $in: [...new Set([...memberships.values()].map((m) => m.userId))] } }).exec();
    const userOf = new Map(users.map((u) => [String(u._id), u]));
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    const nameOf = (membershipId: string): string => {
      const user = userOf.get(memberships.get(membershipId)?.userId ?? '');
      return displayNameOf(user) ?? unknown;
    };

    // The count: the office's own for its members, every office's named for the Super Admin.
    const used = ctx.isSuperAdmin
      ? await countLeadersUsedPerOffice(this.members, ctx, kpmIds)
      : new Map([[ctx.kpmId as string, await countLeadersUsed(this.members, ctx)]]);

    return found.map((r) => {
      const office = officeOf.get(r.kpmId);
      return {
        requestId: String(r._id),
        kpmId: r.kpmId,
        kpmCode: office?.code ?? '',
        kpmBranchName: office?.branchName ?? '',
        subjectMembershipId: r.subjectMembershipId,
        subjectName: nameOf(r.subjectMembershipId),
        subjectAgentCode: memberships.get(r.subjectMembershipId)?.agentCode ?? '',
        action: r.action,
        fromOrgLevelCode: r.fromOrgLevelCode,
        toOrgLevelCode: r.toOrgLevelCode,
        reason: r.reason,
        requestedByMembershipId: r.requestedByMembershipId,
        requestedByName: nameOf(r.requestedByMembershipId),
        status: r.status,
        requestedAt: r.get('createdAt')?.toISOString() ?? '',
        decidedAt: r.decidedAt?.toISOString() ?? null,
        declineReason: r.declineReason,
        maxLeaders: office?.subscription?.maxLeaders ?? null,
        leadersUsed: used.get(r.kpmId) ?? 0,
      };
    });
  }
}

/** Pending first — `status: 1` would sort alphabetically, putting `approved` ahead of what needs deciding. */
function ranked(found: LeaderLimitRequestDocument[]): LeaderLimitRequestDocument[] {
  return [...found].sort((a, b) => RANK[a.status] - RANK[b.status]);
}

function requestOpen(requestId: string | null): DomainException {
  return new DomainException(
    ErrorCode.LEADER_LIMIT_REQUEST_OPEN,
    LEADER_LIMIT_REFUSALS.LEADER_LIMIT_REQUEST_OPEN.alreadyDeciding,
    HttpStatus.CONFLICT,
    { requestId },
  );
}

function assertPending(request: LeaderLimitRequestDocument): void {
  if (request.status === 'pending') return;
  throw new DomainException(
    ErrorCode.LEADER_LIMIT_REQUEST_DECIDED,
    LEADER_LIMIT_REFUSALS.LEADER_LIMIT_REQUEST_DECIDED.already({ status: request.status }),
    HttpStatus.CONFLICT,
    { requestId: String(request._id), status: request.status, decidedAt: request.decidedAt?.toISOString() ?? null },
  );
}

/**
 * **Does the act still apply?** (ADR-0157 §3) — asked with the office's leader lease held. `null` when it does;
 * otherwise what changed, in words the asker reads: a sentence, in both languages (`STALE_REASONS`).
 */
export function staleReason(
  request: Pick<LeaderLimitRequestDocument, 'action' | 'fromOrgLevelCode'>,
  target: Pick<MembershipDocument, 'status' | 'orgLevelCode'> | null,
): StaleReason | null {
  if (!target || target.status === 'removed') return STALE_REASONS.memberGone;
  if (target.orgLevelCode !== request.fromOrgLevelCode) return STALE_REASONS.movedRung;
  if (request.action === 'activate' && target.status !== 'pending') return STALE_REASONS.letInSince;
  return null;
}
