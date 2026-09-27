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

/** The six metrics the carrier's file carries, in the file's own order. */
export const PRODUCTION_METRICS = [
  'ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount',
] as const;
export type ProductionMetric = (typeof PRODUCTION_METRICS)[number];

/** Money among them, stored in minor units though the file says *Rp M*. */
export const MONEY_METRICS: readonly ProductionMetric[] = ['ape', 'fyp'];

const cell = () => ({ type: MetricValueSchema, required: true, default: () => ({}) });

/**
 * One agent's production for one month, as the carrier reported it (P9-T1).
 *
 * **The authoritative APE source.** Goal-versus-actual, unit rollups, MOC evaluation, production club
 * tiers and campaign qualification all read this row and nothing else — which is why the phase that
 * writes it comes before every phase that reads it.
 *
 * Six metrics, each **monthly** and **year-to-date**, twelve cells, one row per
 * `(membership, month)`. The file carries both cadences so one upload covers both, and the row keeps
 * them side by side for the same reason.
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

  @Prop(cell()) apeMonthly!: MetricValue;
  @Prop(cell()) apeYtd!: MetricValue;
  @Prop(cell()) persistencyMonthly!: MetricValue;
  @Prop(cell()) persistencyYtd!: MetricValue;
  @Prop(cell()) recruitmentMonthly!: MetricValue;
  @Prop(cell()) recruitmentYtd!: MetricValue;
  @Prop(cell()) newActiveAgentsMonthly!: MetricValue;
  @Prop(cell()) newActiveAgentsYtd!: MetricValue;
  @Prop(cell()) fypMonthly!: MetricValue;
  @Prop(cell()) fypYtd!: MetricValue;
  @Prop(cell()) policyCountMonthly!: MetricValue;
  @Prop(cell()) policyCountYtd!: MetricValue;

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
