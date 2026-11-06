import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import {
  cellAsHydrated, MonthlyAgentData, MonthlyAgentDataDocument, type MetricValue,
} from './monthly-agent-data.schema';

/**
 * A month row read lean (`findByKode`): whose, which month, and the kodes asked for — each month's figure from
 * `values`, each uploaded year to date from `ytdValues` — every cell as `cellAsHydrated` reads it; a kode the row lacks
 * is `null`, no figure held.
 */
export interface KodeRow {
  membershipId: string;
  month: string;
  values: Record<string, MetricValue | null>;
  ytdValues: Record<string, MetricValue | null>;
  asOf: string | null;
}

/**
 * Every month row, through the chokepoint (invariant §1).
 *
 * One unscoped method, named so (invariant §1): `kodesHeldInOfficesAcrossTenants`, which answers which columns hold a
 * figure — kodes and a month, never a figure or a row — for the Super Admin's template editor (P19.5-T1). The peer
 * median (ADR-0215 §5) will be the second, on the day it is needed.
 */
@Injectable()
export class MonthlyAgentDataRepository extends TenantScopedRepository<MonthlyAgentDataDocument> {
  constructor(@InjectModel(MonthlyAgentData.name) model: Model<MonthlyAgentDataDocument>) {
    super(model, 'monthlyAgentData');
  }

  /**
   * **Month rows, the named kodes only, read lean** (the forum's scorecard at 500 members, 2026-10-28; by kode since
   * P19.5-T2): `find` in the office, `deletedAt: null`, without Mongoose's hydration — which was most of that
   * scorecard's time: its ten thousand rows took ≈ 380 ms hydrated and ≈ 50 ms lean. Each cell comes back as
   * `cellAsHydrated` reads it, so every reader of these rows reads one shape.
   */
  async findByKode(
    ctx: RequestContext,
    filter: FilterQuery<MonthlyAgentDataDocument>,
    kodes: readonly string[],
    ytdKodes: readonly string[] = [],
    sort?: Record<string, 1 | -1>,
  ): Promise<KodeRow[]> {
    const projection: Record<string, 1> = { membershipId: 1, month: 1, asOf: 1 };
    for (const kode of kodes) projection[`values.${kode}`] = 1;
    for (const kode of ytdKodes) projection[`ytdValues.${kode}`] = 1;
    let query = this.model.find(this.scope(ctx, 'findByKode', filter), projection);
    if (sort) query = query.sort(sort);
    const rows = await query.lean().exec();
    return (rows as unknown as Record<string, unknown>[]).map((row) => toKodeRow(row, kodes, ytdKodes));
  }

  /**
   * **Which columns hold a figure in the offices named, and the earliest month each does** (P19.5-T1 AC-7; ADR-0214 §2,
   * §9): what locks a column's unit and start month in a template's editor (`ANALYTICS_UNIT_LOCKED`), and what version
   * 1's `effectiveFrom` is (the migration reads the same cells). A cell holds a figure when its `value` is not `null`.
   *
   * Read by kode: the row's `values` and `ytdValues` (the shape P19.5-T2 writes), each legacy cell `legacy` names —
   * `apeMonthly` as `APE` and so on, which a row the migration has not reached still holds — and, since P19.5-T2, the
   * *Belum terdaftar* rows of `unregisteredAgentData` (ADR-0214 §8): a held figure locks its column too.
   *
   * **Deliberately unscoped, and named so.** A template's KPMs are many offices, and the Super Admin who edits it is in
   * none. The caller must be a Super Admin; the read is narrowed to the offices named; it answers kodes and months —
   * never a figure, a person or an office.
   */
  async kodesHeldInOfficesAcrossTenants(
    ctx: RequestContext, kpmIds: readonly string[], legacy: Readonly<Record<string, string>>,
  ): Promise<Map<string, string>> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'kodesHeldInOfficesAcrossTenants');
    }
    const held = new Map<string, string>();
    if (kpmIds.length === 0) return held;
    const byKode = (path: string) => ({
      $map: { input: { $objectToArray: { $ifNull: [`$${path}`, {}] } }, in: { k: '$$this.k', v: '$$this.v.value' } },
    });
    const match = { $match: { kpmId: { $in: [...kpmIds] }, deletedAt: null } };
    const cellsOf = (withLegacy: boolean) => ({
      $project: {
        month: 1,
        cells: {
          $concatArrays: [
            byKode('values'),
            byKode('ytdValues'),
            ...(withLegacy ? [Object.entries(legacy).map(([cell, kode]) => ({ k: kode, v: `$${cell}.value` }))] : []),
          ],
        },
      },
    });
    const rows = await this.model.aggregate<{ _id: string; earliest: string }>([
      match,
      cellsOf(true),
      { $unionWith: { coll: 'unregisteredAgentData', pipeline: [match, cellsOf(false)] } },
      { $unwind: '$cells' },
      { $match: { 'cells.v': { $ne: null } } },
      { $group: { _id: '$cells.k', earliest: { $min: '$month' } } },
    ]).exec();
    for (const row of rows) held.set(String(row._id), String(row.earliest));
    return held;
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

/** A lean row as `findByKode` answers it. */
function toKodeRow(row: Record<string, unknown>, kodes: readonly string[], ytdKodes: readonly string[]): KodeRow {
  const values = (row.values ?? {}) as Record<string, Partial<MetricValue> | null | undefined>;
  const ytdValues = (row.ytdValues ?? {}) as Record<string, Partial<MetricValue> | null | undefined>;
  return {
    membershipId: String(row.membershipId),
    month: String(row.month),
    values: Object.fromEntries(kodes.map((k) => [k, values[k] === undefined ? null : cellAsHydrated(values[k])])),
    ytdValues: Object.fromEntries(ytdKodes.map((k) => [k, ytdValues[k] === undefined ? null : cellAsHydrated(ytdValues[k])])),
    asOf: typeof row.asOf === 'string' ? row.asOf : null,
  };
}
