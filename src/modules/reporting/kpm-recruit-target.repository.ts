import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { KpmRecruitTarget, KpmRecruitTargetDocument } from './kpm-recruit-target.schema';

/**
 * **An office's recruitment targets, behind the chokepoint** (invariant §1): every read and write carries the
 * reader's own `kpmId`, so an office never reads or writes another's target.
 */
@Injectable()
export class KpmRecruitTargetRepository extends TenantScopedRepository<KpmRecruitTargetDocument> {
  constructor(@InjectModel(KpmRecruitTarget.name) model: Model<KpmRecruitTargetDocument>) {
    super(model, 'kpmRecruitTargets');
  }

  /**
   * **Set a month's target in one atomic write, and say what it replaced** (D-recruit; the Phase 18 exit review,
   * item 4): an upserting `findOneAndUpdate` that returns the row as it was **before** this write, so the audit's
   * *before* is what this write replaced — never a row read a moment earlier that a concurrent save had already
   * changed. `before` is `null` when this write created the month's row.
   *
   * Two first saves for a month can both find nothing and both insert; the unique partial index refuses the
   * second (E11000), which is retried once and then updates the row the first created, reporting it as *before*.
   */
  async setTarget(
    ctx: RequestContext, month: string, target: number,
  ): Promise<{ id: string; before: { month: string; target: number } | null }> {
    const write = async () => {
      const result = await this.model.findOneAndUpdate(
        this.scope(ctx, 'setTarget', { month }),
        {
          $set: { target, updatedBy: ctx.membershipId },
          $setOnInsert: { kpmId: ctx.kpmId, deletedAt: null, createdBy: ctx.membershipId },
        },
        { new: false, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
      ).exec();
      const before = result.value;
      return {
        id: String(before ? before._id : result.lastErrorObject!.upserted),
        before: before ? { month: before.month, target: before.target } : null,
      };
    };
    try {
      return await write();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      return write();
    }
  }

  /** The target that stands for a month: the month's own, or the latest earlier month's (D-recruit); `null` if none. */
  async standingFor(ctx: RequestContext, month: string): Promise<{ month: string; target: number } | null> {
    const [row] = await this.find(ctx, { month: { $lte: month } }, { sort: { month: -1 }, limit: 1 });
    return row ? { month: row.month, target: row.target } : null;
  }
}
