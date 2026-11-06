import mongoose from 'mongoose';
import { LEGACY_CELLS, keyOfLegacy } from '@/modules/production/upload-columns';

/** One office's rows moved, as the deploy log reports them (ADR-0214 §9: *"the migration reports it"*). */
export interface UploadValuesByKodeOffice {
  kpmId: string;
  /** The template its rows were stamped with; `null` for the platform's own configuration. */
  templateId: string | null;
  rows: number;
  cells: number;
}

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface UploadValuesByKodeResult {
  /** `monthlyAgentData` rows moved this run: each cell by kode, stamped `templateVersion: 1`. */
  rows: number;
  /** Cells moved, whole — a month's or a year to date's. */
  cells: number;
  /** `dataUploadRows` whose `values` and `previousValues` were re-keyed by kode. */
  uploadRows: number;
  /** `dataUploadBatches` given `analyticsConfig: { templateId, version: 1 }`. */
  batches: number;
  offices: UploadValuesByKodeOffice[];
}

const BATCH = 500;
type Doc = Record<string, unknown> & { _id: mongoose.Types.ObjectId };

/**
 * **`upload-values-by-kode` — today's rows, by the kodes of the template** (P19.5-T2 AC-15; ADR-0214 §9).
 *
 * - **Each `monthlyAgentData` row's cells move by kode**: `apeMonthly` into `values.APE` and the other five metrics'
 *   month cells likewise; `unitPersistencyMonthly` into `values.UNIT_PERSISTENCY`; each `…Ytd` into `ytdValues[kode]`,
 *   kept as a check only and read by no figure (a `ytd: 'sum'` column's year to date is calculated, R4). **The whole
 *   `MetricValue` moves**, provenance and correction fields included; a cell with neither a value nor a provenance is
 *   left out — an absent kode is *no figure held* already. A kode the row already holds is never overwritten.
 * - **Each row is stamped** `templateVersion: 1` and its KPM's resolved `templateId` — the template it was made from when
 *   that is its company's own, else its company's default (as `AnalyticsConfigReader` resolves it), `null` with none.
 * - **`dataUploadRows.values` and `previousValues` are re-keyed the same way** (`apeMonthly` → `APE`, `apeYtd` →
 *   `APE_YTD`), so a revert of an import made before the migration still puts back what it replaced.
 * - **`dataUploadBatches` gain `analyticsConfig: { templateId, version: 1 }`**: the history's *v1*.
 *
 * A `productionMonths` row written before needs nothing: one with a revision and no `firstWrittenOn` is a month written
 * before P19.5-T2, and keeps its schedule (`ProductionMonths.state`).
 *
 * **The old cells stay on the document**, read by nothing, until a later migration removes them once T5 has checked
 * production's figures. **No stored figure changes.**
 *
 * **Idempotent**: a row with a `templateVersion` is done, a batch row keyed by kode has no legacy key left, a batch with
 * an `analyticsConfig` is left alone — a second run moves nothing (its test runs
 * twice).
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<UploadValuesByKodeResult> {
  void now;
  const result: UploadValuesByKodeResult = { rows: 0, cells: 0, uploadRows: 0, batches: 0, offices: [] };
  const templateOf = await templateResolver(db);
  const perOffice = new Map<string, UploadValuesByKodeOffice>();

  // ---- monthlyAgentData
  const rows = db.collection('monthlyAgentData');
  const cursor = rows.find({ templateVersion: { $exists: false } });
  let ops: mongoose.mongo.AnyBulkWriteOperation[] = [];
  const flush = async (col: mongoose.mongo.Collection) => {
    if (ops.length) await col.bulkWrite(ops, { ordered: false });
    ops = [];
  };
  for await (const raw of cursor) {
    const row = raw as Doc;
    const kpmId = String(row.kpmId);
    const templateId = await templateOf(kpmId);
    const set: Record<string, unknown> = { templateVersion: 1, templateId };
    let cells = 0;
    const values = (row.values ?? {}) as Record<string, unknown>;
    const ytdValues = (row.ytdValues ?? {}) as Record<string, unknown>;
    for (const [name, { kode, ytd }] of Object.entries(LEGACY_CELLS)) {
      const cell = row[name] as { value?: unknown; provenance?: unknown } | null | undefined;
      if (!cell || ((cell.value ?? null) === null && (cell.provenance ?? null) === null)) continue;
      if ((ytd ? ytdValues : values)[kode] !== undefined) continue;
      set[`${ytd ? 'ytdValues' : 'values'}.${kode}`] = cell;
      cells += 1;
    }
    if (row.asOf === undefined) set.asOf = null;
    ops.push({ updateOne: { filter: { _id: row._id, templateVersion: { $exists: false } }, update: { $set: set } } });
    result.rows += 1;
    result.cells += cells;
    const office = perOffice.get(kpmId) ?? { kpmId, templateId, rows: 0, cells: 0 };
    office.rows += 1;
    office.cells += cells;
    perOffice.set(kpmId, office);
    if (ops.length >= BATCH) await flush(rows);
  }
  await flush(rows);

  // ---- dataUploadRows: re-keyed by kode
  const uploadRows = db.collection('dataUploadRows');
  const legacyKeys = Object.keys(LEGACY_CELLS);
  const legacyFilter = {
    $or: legacyKeys.flatMap((k) => [{ [`values.${k}`]: { $exists: true } }, { [`previousValues.${k}`]: { $exists: true } }]),
  };
  for await (const raw of uploadRows.find(legacyFilter)) {
    const row = raw as Doc;
    const rekey = (record: unknown) => Object.fromEntries(Object.entries((record ?? {}) as Record<string, unknown>)
      .map(([k, v]) => [keyOfLegacy(k), v]));
    ops.push({
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { values: rekey(row.values), previousValues: rekey(row.previousValues) } },
      },
    });
    result.uploadRows += 1;
    if (ops.length >= BATCH) await flush(uploadRows);
  }
  await flush(uploadRows);

  // ---- dataUploadBatches: version 1 of the office's template
  const batches = db.collection('dataUploadBatches');
  for await (const raw of batches.find({ analyticsConfig: { $exists: false } })) {
    const batch = raw as Doc;
    const templateId = await templateOf(String(batch.kpmId));
    ops.push({ updateOne: { filter: { _id: batch._id }, update: { $set: { analyticsConfig: { templateId, version: 1 } } } } });
    result.batches += 1;
    if (ops.length >= BATCH) await flush(batches);
  }
  await flush(batches);

  result.offices = [...perOffice.values()].sort((a, b) => a.kpmId.localeCompare(b.kpmId));
  return result;
}

/**
 * **The template each office reads** (ADR-0214 §3), memoised: the one it was made from when that is one of its own
 * company's live templates, else its company's default, else `null` — the platform's own configuration.
 */
async function templateResolver(db: mongoose.mongo.Db): Promise<(kpmId: string) => Promise<string | null>> {
  const memo = new Map<string, string | null>();
  return async (kpmId) => {
    if (memo.has(kpmId)) return memo.get(kpmId)!;
    const kpm = await db.collection('kpms').findOne({ _id: { $in: ids([kpmId]) } }, { projection: { companyId: 1, startedFrom: 1 } });
    let templateId: string | null = null;
    if (kpm?.companyId) {
      const companyId = String(kpm.companyId);
      const from = kpm.startedFrom as { source?: string; templateId?: string | null; companyId?: string } | null | undefined;
      const own = from?.source === 'template' && from.templateId && (!from.companyId || from.companyId === companyId)
        ? await db.collection('templates').findOne({ _id: { $in: ids([String(from.templateId)]) }, companyId, deletedAt: null }, { projection: { _id: 1 } })
        : null;
      const template = own ?? await db.collection('templates').findOne({ companyId, isDefault: true, deletedAt: null }, { projection: { _id: 1 } });
      templateId = template ? String(template._id) : null;
    }
    memo.set(kpmId, templateId);
    return templateId;
  };
}

/** Ids as they may be stored: each as written, and as an ObjectId where it is one's hex. */
function ids(list: readonly string[]): mongoose.Types.ObjectId[] {
  return list.flatMap((id) => (/^[0-9a-f]{24}$/i.test(id)
    ? [id as unknown as mongoose.Types.ObjectId, new mongoose.Types.ObjectId(id)]
    : [id as unknown as mongoose.Types.ObjectId]));
}
