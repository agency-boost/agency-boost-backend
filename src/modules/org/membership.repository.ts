import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Membership, MembershipDocument } from './membership.schema';

/**
 * The first concrete tenant-scoped repository.
 *
 * It adds exactly one operation the base class does not have — the subtree re-splice
 * below — and no escape hatch to the raw model. Adding one would defeat the chokepoint,
 * and nothing in this module has needed it.
 */
@Injectable()
export class MembershipRepository extends TenantScopedRepository<MembershipDocument> {
  constructor(@InjectModel(Membership.name) model: Model<MembershipDocument>) {
    super(model, 'memberships');
  }

  /**
   * Is this leader code already taken, anywhere?
   *
   * **Deliberately unscoped, and named so.** Leader codes are unique across every office
   * because a joiner presents one before they belong to any — so asking within a tenant
   * would let two offices hold the same code and hand the second joiner to the wrong
   * leader. Invariant §1 asks that a cross-tenant read be an explicitly named method
   * rather than an absent filter, and this is one.
   *
   * Live rows only, matching the partial index: a soft-deleted membership releases its
   * code.
   */
  /**
   * The live membership of one person, in whichever office holds it.
   *
   * **Deliberately unscoped, and named so.** A Super Admin deciding whether they may
   * impersonate somebody has to know which office that person is in and whether they
   * administer it — and the Super Admin is in no office, so there is no tenant to ask
   * within. Invariant §1 asks that a cross-tenant read be an explicitly named method
   * rather than an absent filter, and this is one.
   *
   * v1 allows one live membership per person, so this is a single row or none.
   */
  async liveForUserAnywhere(userId: string): Promise<MembershipDocument | null> {
    return this.model
      .findOne({ userId, status: { $ne: 'removed' }, deletedAt: null })
      .exec();
  }

  /**
   * Who these memberships belong to, in whichever office holds each one.
   *
   * **Deliberately unscoped, and named so.** The Super Admin's audit console shows platform
   * rows from every office at once, and resolving `memberships/68f3…` to a person is the whole
   * reason that screen is readable. The reader is in no tenant, so there is no tenant to ask
   * within — invariant §1 asks that such a read be an explicitly named method rather than an
   * absent filter, and this is one.
   *
   * Soft-deleted rows are **included**: an audit row about a membership that has since been
   * removed still has to say whose it was, which is exactly when somebody is reading the log.
   */
  async byIdsAnywhereForAudit(
    ids: string[],
  ): Promise<{ _id: string; userId: string; agentCode: string | null }[]> {
    if (ids.length === 0) return [];
    const rows = await this.model
      .find({ _id: { $in: ids } }, { userId: 1, agentCode: 1 })
      .lean()
      .exec();
    return rows.map((r) => ({
      _id: String(r._id),
      userId: String(r.userId),
      agentCode: (r as { agentCode?: string | null }).agentCode ?? null,
    }));
  }

  async existsWithLeaderCode(code: string): Promise<boolean> {
    return (await this.model.exists({ leaderCode: code, deletedAt: null })) !== null;
  }

  /**
   * The membership a leader code belongs to, wherever it is.
   *
   * The other half of the same escape, and the only way `POST /join/redeem` can work:
   * the caller has no office, so there is no context to scope by.
   */
  async findByLeaderCode(code: string): Promise<MembershipDocument | null> {
    return this.model.findOne({ leaderCode: code, deletedAt: null }).exec();
  }

  /**
   * Re-point a whole subtree's materialised ancestors in one operation.
   *
   * Every descendant needs a *different* new array — its own tail spliced onto the moved
   * member's new path — so a plain `updateMany` cannot express it. The alternative was a
   * loop of one update per descendant: at the stated 500-member budget and Atlas
   * latency that is measured in seconds, for an operation a leader does from a modal.
   *
   * An aggregation-pipeline update does the splice server-side, so it stays one round
   * trip. It lives here rather than at the call site because it is still a bulk write,
   * and a bulk write with a hand-built filter is the one that leaks furthest.
   */
  async respliceSubtree(
    ctx: RequestContext,
    movedId: string,
    newAncestors: string[],
    oldPathLength: number,
    depthShift: number,
  ): Promise<number> {
    const result = await this.model
      .updateMany(this.scope(ctx, 'respliceSubtree', { ancestorIds: movedId }), [
        {
          $set: {
            ancestorIds: {
              $concatArrays: [
                [...newAncestors, movedId],
                // Everything below the moved member is unchanged — only the path above
                // it moved, so this is a splice rather than a re-walk of the tree.
                { $slice: ['$ancestorIds', oldPathLength, { $size: '$ancestorIds' }] },
              ],
            },
            depth: { $add: ['$depth', depthShift] },
            updatedBy: ctx.membershipId,
          },
        },
      ])
      .exec();
    return result.modifiedCount;
  }
}
