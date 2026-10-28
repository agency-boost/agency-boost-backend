import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import {
  cellAsHydrated, MonthlyAgentData, MonthlyAgentDataDocument, type MetricValue, type MonthCellName,
} from './monthly-agent-data.schema';

/** A month row read lean (`findCells`): whose, which month, and the cells asked for, each as a hydrated row holds it. */
export type CellRow<C extends MonthCellName> = { membershipId: string; month: string } & { [K in C]: MetricValue | null };

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
   * **Month rows, the named cells only, read lean** (the forum's scorecard at 500 members, 2026-10-28): `find` in the
   * office, `deletedAt: null`, without Mongoose's hydration — which was most of that scorecard's time: its ten thousand
   * rows took ≈ 380 ms hydrated and ≈ 50 ms lean. Each cell asked for comes back with its defaults applied as hydration
   * applies them (`cellAsHydrated`), so a reader of these rows reads what it would of hydrated ones.
   */
  async findCells<C extends MonthCellName>(
    ctx: RequestContext, filter: FilterQuery<MonthlyAgentDataDocument>, cells: readonly C[],
  ): Promise<CellRow<C>[]> {
    const projection: Record<string, 1> = { membershipId: 1, month: 1 };
    for (const name of cells) projection[name] = 1;
    const rows = await this.model.find(this.scope(ctx, 'findCells', filter), projection).lean().exec();
    return (rows as unknown as Record<string, unknown>[]).map((row) => {
      const out: Record<string, unknown> = { membershipId: row.membershipId, month: row.month };
      for (const name of cells) out[name] = cellAsHydrated(row[name] as Partial<MetricValue> | null | undefined);
      return out as CellRow<C>;
    });
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
