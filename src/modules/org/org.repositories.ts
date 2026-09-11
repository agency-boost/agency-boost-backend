import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Group, GroupDocument } from './group.schema';
import { JoinRequest, JoinRequestDocument } from './join-request.schema';
import { MembershipHistory, MembershipHistoryDocument } from './membership-history.schema';

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
}
