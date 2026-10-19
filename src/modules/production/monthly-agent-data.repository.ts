import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { MonthlyAgentData, MonthlyAgentDataDocument } from './monthly-agent-data.schema';

/**
 * Every month row, through the chokepoint (invariant §1).
 *
 * No unscoped method. The one cross-tenant reader this data will ever have is the company's own
 * benchmark analytics (OD-20, deferred), and that is a named method on the day it is needed — not
 * an absent filter today.
 */
@Injectable()
export class MonthlyAgentDataRepository extends TenantScopedRepository<MonthlyAgentDataDocument> {
  constructor(@InjectModel(MonthlyAgentData.name) model: Model<MonthlyAgentDataDocument>) {
    super(model, 'monthlyAgentData');
  }

  /**
   * **Several members' rows for one month, created or updated in one `bulkWrite`** (Phase 15, *Update
   * production*): what `upsertOne` does for one row — the office injected into every filter and every insert,
   * the writer stamped, what only a new row gets in `$setOnInsert` — for each, in one round trip and in order,
   * so a leader's save is never half-written by a request that failed between two rows.
   *
   * Answers each row's `_id`, by member, read back in the same office.
   */
  async upsertMonthRows(
    ctx: RequestContext,
    month: string,
    rows: readonly { membershipId: string; set: Record<string, unknown>; setOnInsert: Record<string, unknown> }[],
  ): Promise<Map<string, string>> {
    if (rows.length === 0) return new Map();
    const kpmId = ctx.kpmId as string;
    await this.model.bulkWrite(rows.map((row) => ({
      updateOne: {
        filter: this.scope(ctx, 'upsertMonthRows', { membershipId: row.membershipId, month } as FilterQuery<MonthlyAgentDataDocument>),
        update: {
          $set: { ...row.set, updatedBy: ctx.membershipId },
          $setOnInsert: { ...row.setOnInsert, kpmId, deletedAt: null, createdBy: ctx.membershipId },
        },
        upsert: true,
      },
    })), { ordered: true });
    const written = await this.find(ctx, { month, membershipId: { $in: rows.map((row) => row.membershipId) } }, { projection: { membershipId: 1 } });
    return new Map(written.map((row) => [row.membershipId, String(row._id)]));
  }
}
