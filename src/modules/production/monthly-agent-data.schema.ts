import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type MonthlyAgentDataDocument = HydratedDocument<MonthlyAgentData>;

/**
 * Which writer a figure came from. The three the phase's exit criterion names.
 *
 * `imported` — the carrier's file. `corrected` — an owner's inline correction, which outranks the
 * file it corrects. `self_reported` — an agent's own entry, kept visibly separate (ADR-0008) and
 * overwritten by the next import for that month.
 */
export const PROVENANCES = ['imported', 'corrected', 'self_reported'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/**
 * One figure and where it came from.
 *
 * **Provenance is per cell, not per row**, because one row can hold all three: a carrier's APE, an
 * owner's corrected policy count, an agent's self-reported FYP. A row-level source would have to pick
 * one and lie about the other two.
 *
 * **`null` is not zero.** A cell nothing has written is `null` — *no data* — and a cell the carrier
 * reported as nothing is `0`. The prototype keeps that distinction for its derived MAA column and
 * loses it everywhere else; here it is the shape of every cell.
 */
@Schema({ _id: false })
export class MetricValue {
  @Prop({ type: Number, default: null })
  value!: number | null;

  @Prop({ type: String, enum: PROVENANCES, default: null })
  provenance!: Provenance | null;

  /** The import that wrote it, when one did — what revert reads. */
  @Prop({ type: String, default: null })
  sourceBatchId!: string | null;

  /**
   * A correction's who, when and why (P9-T5, ADR-0042) — `null` unless `provenance` is `corrected`.
   * The audit log holds every correction; these hold the one standing, so a figure can say where it
   * came from without a trip to the log (P9-T6).
   */
  @Prop({ type: String, default: null })
  correctedBy!: string | null;

  @Prop({ type: Date, default: null })
  correctedAt!: Date | null;

  @Prop({ type: String, default: null })
  reason!: string | null;

  /**
   * The figure the first correction in a chain replaced — the carrier's, usually (ADR-0053). A second
   * correction keeps the first one's: what the preview needs to say is *this file carries the figure
   * the correction replaced*, which is how a re-upload of the old file looks.
   */
  @Prop({ type: Number, default: null })
  replacedValue!: number | null;
}
export const MetricValueSchema = SchemaFactory.createForClass(MetricValue);

/**
 * **A cell read lean, as a hydrated row would hold it** (the forum's scorecard at 500 members, 2026-10-28). A lean read skips
 * Mongoose's hydration — and with it the defaults above, which this applies: a cell the row lacks is `cell()`'s `{}`
 * with every field `null`, a field the cell lacks is `null`, and a cell stored as `null` stays `null`, as hydration
 * leaves it. Every reader of a row's `values` and `ytdValues` reads a cell through it (`ProductionReadings`, the month
 * read), since a cell by kode is a plain object Mongoose applies no defaults to.
 */
export function cellAsHydrated(stored: Partial<MetricValue> | null | undefined): MetricValue | null {
  if (stored === null) return null;
  return {
    value: stored?.value ?? null,
    provenance: stored?.provenance ?? null,
    sourceBatchId: stored?.sourceBatchId ?? null,
    correctedBy: stored?.correctedBy ?? null,
    correctedAt: stored?.correctedAt ?? null,
    reason: stored?.reason ?? null,
    replacedValue: stored?.replacedValue ?? null,
  };
}

/**
 * **The six metrics' legacy names**, in the order the file carried them before P19.5-T2 — `ape` and so on, each a month
 * and a year to date (`apeMonthly`, `apeYtd`). **No row is written or read by them any more** (ADR-0214 §9): each is a
 * kode now (`KODE_OF_CELL`), and `upload-columns.ts`' `LEGACY_CELLS` maps the names. Kept for the seed's planned
 * figures, which are written by name and stored by kode (`byKode`), and for migration `upload-values-by-kode`.
 */
export const PRODUCTION_METRICS = [
  'ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount',
] as const;
export type ProductionMetric = (typeof PRODUCTION_METRICS)[number];

/** One figure per kode: what `values` and `ytdValues` hold. An absent kode is `null`, *no figure held*. */
export type CellsByKode = Record<string, MetricValue>;

/**
 * One agent's production for one month, as the carrier reported it (P9-T1) — **by the kodes of the KPM's template**
 * since P19.5-T2 (ADR-0214 §9; the Advanced analytics spec §4, *Stored row*).
 *
 * **The authoritative APE source.** Goal-versus-actual, unit rollups, MOC evaluation, production club
 * tiers and campaign qualification all read this row and nothing else — through `ProductionReadings` — which is why
 * the phase that writes it comes before every phase that reads it.
 *
 * - **`values`**: this month's figure per column, keyed by kode (`APE`, `POLICY_COUNT`, …), each a whole `MetricValue`
 *   so a figure keeps its provenance (ADR-0008). The spec's `number | null` is the cell's `.value`.
 * - **`ytdValues`**: the uploaded year to date of a `ytd: 'upload'` column, and — from migration `upload-values-by-kode`
 *   — the year to date the file used to carry for every column, **kept as a check and read by no figure**: a `ytd:
 *   'sum'` column's year to date is the sum of its months, computed on read and never stored (R4).
 * - **`templateId`, `templateVersion`**: the configuration the row was last written against (R6). Version 1 for every
 *   row the migration moved.
 * - **`asOf`**: for a month uploaded while it runs (D8), the office day its figures stand at — `YYYY-MM-DD`; `null` for a
 *   month's final upload.
 *
 * The cells it held before P19.5-T2 (`apeMonthly` … `unitPersistencyMonthly`) **stay on the document**, read by
 * nothing, until a later migration removes them once T5 has checked production's figures; this schema no longer names
 * them, so nothing can.
 *
 * **`agentCode` is a copy, `membershipId` is the key** (invariant §2). The code is what the file
 * carries and what the row was matched on; it is kept so the row still says what it was matched
 * against if the code is ever reissued, and the membership is what everything joins on.
 */
@Schema({ ...baseSchemaOptions, collection: 'monthlyAgentData' })
export class MonthlyAgentData {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, index: true })
  membershipId!: string;

  @Prop({ type: String, required: true })
  agentCode!: string;

  /** `YYYY-MM`, the office's calendar month. */
  @Prop({ type: String, required: true })
  month!: string;

  /** This month's figure per kode (ADR-0214 §9). */
  @Prop({ type: Object, default: () => ({}) })
  values!: CellsByKode;

  /** A `ytd: 'upload'` column's uploaded year to date, and the migrated year-to-date cells kept as a check (R4). */
  @Prop({ type: Object, default: () => ({}) })
  ytdValues!: CellsByKode;

  /** The named template the row was last written against; `null` for the platform's own configuration. */
  @Prop({ type: String, default: null })
  templateId!: string | null;

  /** Its published version (R6). */
  @Prop({ type: Number, default: null })
  templateVersion!: number | null;

  /** D8: the office day a running month's upload stands at, `YYYY-MM-DD`; `null` once the month's upload is final. */
  @Prop({ type: String, default: null })
  asOf!: string | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const MonthlyAgentDataSchema = SchemaFactory.createForClass(MonthlyAgentData);

/** One row per agent per month. Partial, so a soft-deleted row does not block a rewrite. */
MonthlyAgentDataSchema.index(
  { kpmId: 1, membershipId: 1, month: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The month table: every agent's row for one month. */
MonthlyAgentDataSchema.index({ kpmId: 1, month: 1, deletedAt: 1 });
