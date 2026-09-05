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
