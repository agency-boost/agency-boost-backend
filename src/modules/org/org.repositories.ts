import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Group, GroupDocument } from './group.schema';
import { JoinRequest, JoinRequestDocument } from './join-request.schema';
import { LeaderLimitRequest, LeaderLimitRequestDocument } from './leader-limit-request.schema';
import {
  EDGE_EVENTS, EdgeEvent, MembershipHistory, MembershipHistoryDocument,
} from './membership-history.schema';

/**
 * The tenant-scoped collections that were still reached with `@InjectModel` and a
 * hand-written filter (P4-T11).
 *
 * `raw-writes.tenancy.spec.ts` has held the **writes** since P3.5-T15 — it fails on any
 * write to a tenant-scoped model whose filter omits `kpmId`. That is a backstop, not a
 * structure: it can only see the shape of a call, so a read has nothing for it to check
 * and a correct-looking filter still has to be written by hand every time.
 *
 * A repository removes the chance rather than catching it. Invariant §1: *"a query built
 * without the repository is a defect even when it happens to be correct today."*
 */

/** An office's groups. */
@Injectable()
export class GroupRepository extends TenantScopedRepository<GroupDocument> {
  constructor(@InjectModel(Group.name) model: Model<GroupDocument>) {
    super(model, 'groups');
  }
}

/** Requests to join an office. */
@Injectable()
export class JoinRequestRepository extends TenantScopedRepository<JoinRequestDocument> {
  constructor(@InjectModel(JoinRequest.name) model: Model<JoinRequestDocument>) {
    super(model, 'joinRequests');
  }

  /**
   * A pending request for one membership, in an office the caller may not be scoped to.
   *
   * **Deliberately outside the scoped path, and named so.** `myJoinState` is read by
   * somebody whose session has no `kpmId` — they are waiting to be let into an office, and
   * the request is precisely what would give them one. The tenant is supplied explicitly
   * from the membership rather than taken from a context that has none. Invariant §1 asks
   * that this be a named method rather than an absent filter, and this is one.
   */
  async pendingForMembership(
    kpmId: string,
    membershipId: string,
  ): Promise<JoinRequestDocument | null> {
    return this.model
      .findOne({ kpmId, membershipId, status: 'pending', deletedAt: null })
      .exec();
  }
}

/**
 * The append-only record of what happened to a membership.
 *
 * Soft-delete is part of the base repository's default filter, which is right for
 * everything else and slightly odd here — nothing ever deletes a history row. It costs an
 * indexed equality on a field that is always `null`, and it means this collection cannot
 * become the one place a hand-written filter survives.
 */
@Injectable()
export class MembershipHistoryRepository
  extends TenantScopedRepository<MembershipHistoryDocument> {
  constructor(@InjectModel(MembershipHistory.name) model: Model<MembershipHistoryDocument>) {
    super(model, 'membershipHistory');
  }

  /** One membership's history, newest first. */
  async forMembership(
    ctx: RequestContext,
    membershipId: string,
  ): Promise<MembershipHistoryDocument[]> {
    return this.find(ctx, { membershipId }, { sort: { createdAt: -1 } });
  }

  /**
   * **Open a membership's next edge, and close every edge still open, whichever event opened it**
   * (P11-T3).
   *
   * The one way an edge after the first is written. Each writer used to close only rows of its
   * own kind: `HierarchyService.reparent` the `re_parented` rows, the role change the
   * `role_changed` rows, an approval the `joined` row. So a member's first re-parent left the edge
   * they joined on open beside the new one, a promotion left both open, and an orphan picked up
   * from the pool kept the re-parent that orphaned them. Roles §6.1 says a switch never makes two
   * open edges, and invariant §5 makes the open one the current state. One filter, here, is how
   * three writers stop choosing their own.
   *
   * **One instant** closes the old edge and opens the new (roles §6.1); the caller's clock gives
   * it. Append-only: closing writes `validTo`, and nothing is deleted or overwritten. The admin
   * chain is left alone (`ADMIN_EVENTS`). A removal closes both chains and writes its own row
   * (`RemovalService`).
   */
  async openEdge(
    ctx: RequestContext,
    at: Date,
    edge: Partial<MembershipHistory> & { membershipId: string; eventType: EdgeEvent },
  ): Promise<MembershipHistoryDocument> {
    await this.updateMany(
      ctx,
      { membershipId: edge.membershipId, eventType: { $in: [...EDGE_EVENTS] }, validTo: null },
      { $set: { validTo: at } },
    );
    return this.create(ctx, {
      actorMembershipId: ctx.membershipId,
      actorUserId: ctx.auditActors.actorUserId,
      ...edge,
      validFrom: at,
      validTo: null,
    });
  }
}

/**
 * **The leader-limit requests** (ADR-0157 §2): an office's asks to make a leader past its limit.
 *
 * Tenant-scoped like every other office record: the office reads, creates and cancels its own through the
 * inherited scoped methods. The Super Admin, who is in no office, decides them, and reads them through the two
 * named unscoped methods below — never an absent filter (invariant §1). Both refuse anybody but a Super Admin,
 * and `named-cross-tenant-reads.tenancy.spec.ts` fixes who calls them.
 */
@Injectable()
export class LeaderLimitRequestRepository extends TenantScopedRepository<LeaderLimitRequestDocument> {
  constructor(@InjectModel(LeaderLimitRequest.name) model: Model<LeaderLimitRequestDocument>) {
    super(model, 'leaderLimitRequests');
  }

  /**
   * **The platform's queue**: every office's live requests, newest first, for the Super Admin. A request is
   * small and few — one per member an office asks about — so it is read whole and ranked by the caller.
   */
  async queueAcrossTenants(ctx: RequestContext): Promise<LeaderLimitRequestDocument[]> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'queueAcrossTenants');
    }
    return this.model.find({ deletedAt: null }).sort({ createdAt: -1 }).exec();
  }

  /**
   * **One request, whichever office it is in**, for the Super Admin deciding it: the route names the request,
   * not the office, and the office it names is the one the decision then acts in — and only that one. A
   * malformed id is nothing found, as everywhere else.
   */
  async findByIdAcrossTenants(ctx: RequestContext, requestId: string): Promise<LeaderLimitRequestDocument | null> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'findByIdAcrossTenants');
    }
    if (!isValidObjectId(requestId)) return null;
    return this.model.findOne({ _id: requestId, deletedAt: null }).exec();
  }

  /**
   * **Move a request from one status to another, only if it still holds the first** — the one write a decision
   * makes. Of two Super Admins deciding one request at once, exactly one matches; the other is told it was decided.
   * Scoped like every write here: `ctx` names the request's office. `true` when it matched.
   */
  async transition(
    ctx: RequestContext,
    requestId: string,
    from: LeaderLimitRequestDocument['status'],
    set: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.model
      .updateOne(
        this.scope(ctx, 'transition', { _id: requestId, status: from } as never),
        { $set: { ...set, updatedBy: ctx.membershipId } },
      )
      .exec();
    return result.matchedCount === 1;
  }
}
