import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import type { StoredAbGroupTarget } from '@/domain/metrics/ab-group-targets';
import { AbGroupTarget, AbGroupTargetDocument } from './ab-group-target.schema';

const DUPLICATE_KEY = 11000;

/**
 * **`abGroupTargets` behind the chokepoint** (invariant §1; ADR-0270 §4): every read and write carries the caller's own
 * `kpmId`, so a KPM never reads or writes another's target.
 */
@Injectable()
export class AbGroupTargetRepository extends TenantScopedRepository<AbGroupTargetDocument> {
  constructor(@InjectModel(AbGroupTarget.name) model: Model<AbGroupTargetDocument>) {
    super(model, 'abGroupTargets');
  }

  /** Every row up to `month`, of the AB groups given — what a month's targets and its year's Rekrut YTD read — by AB. */
  async upTo(ctx: RequestContext, abMembershipIds: readonly string[], month: string): Promise<Map<string, StoredAbGroupTarget[]>> {
    const out = new Map<string, StoredAbGroupTarget[]>(abMembershipIds.map((id) => [id, []]));
    if (abMembershipIds.length === 0) return out;
    const rows = await this.find(
      ctx, { abMembershipId: { $in: [...abMembershipIds] }, month: { $lte: month } },
      { projection: { abMembershipId: 1, month: 1, activeAgentTarget: 1, rekrutTarget: 1 } },
    );
    for (const r of rows) {
      out.get(r.abMembershipId)?.push({ month: r.month, activeAgentTarget: r.activeAgentTarget, rekrutTarget: r.rekrutTarget });
    }
    return out;
  }

  /**
   * **Set one AB group's targets for one month in one atomic write, and say what they replaced** — `null` when this write
   * made the row. Two first saves racing both insert; the unique index refuses the second, which is retried once and
   * updates the row the first made.
   */
  async set(
    ctx: RequestContext, abMembershipId: string, month: string, targets: { activeAgentTarget: number; rekrutTarget: number },
  ): Promise<{ id: string; before: { activeAgentTarget: number; rekrutTarget: number } | null }> {
    const write = async () => {
      const result = await this.model.findOneAndUpdate(
        this.scope(ctx, 'set', { abMembershipId, month }),
        {
          $set: { ...targets, source: 'set', updatedBy: ctx.membershipId },
          $setOnInsert: { kpmId: ctx.kpmId, abMembershipId, month, deletedAt: null, createdBy: ctx.membershipId },
        },
        { new: false, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
      ).exec();
      const before = result.value;
      return {
        id: String(before ? before._id : result.lastErrorObject!.upserted),
        before: before ? { activeAgentTarget: before.activeAgentTarget, rekrutTarget: before.rekrutTarget } : null,
      };
    };
    try {
      return await write();
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
      return write();
    }
  }
}
