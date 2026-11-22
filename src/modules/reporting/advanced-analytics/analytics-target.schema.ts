import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type AnalyticsTargetDocument = HydratedDocument<AnalyticsTarget>;
export type AnalyticsTargetKind = 'mapa' | 'subgroup';

/**
 * **`analyticsTargets` — what a KPM still owns of *Advanced analytics*** (P19.5-T3 AC-4, AC-10; ADR-0215 §7; spec §2
 * *KPMs still own*): the MAPA driver's monthly targets and each head of group's AA and recruitment targets. Typed by the
 * Owner or an Admin (`advanced_analytics:write`), each write audited with its before and after.
 *
 * - `kind: 'mapa'`: one per `(kpmId, month, row)`, `value` in the row's unit — IDR minor units for `ape` (invariant §9) —
 *   or `null`, *TBD*.
 * - `kind: 'subgroup'`: one per `(kpmId, headMembershipId, year)` — a **leader's** membership `_id` (invariant §2), an
 *   AB or an AAB, and the year `YYYY` of the office's clock — with `aaTarget` and `recTarget`; until written the
 *   template's `subgroupHeadDefaults` stand. *Changed 2026-11-12 (P19.13-T3; ADR-0253 §4):* one per head of group, no
 *   year, until then; migration `0062-subgroup-targets-by-year` gave every row the year it was written in.
 *   **Retired 2026-11-20 (P19.17-T4; ADR-0270 §4):** nothing writes or reads them; the targets are per AB group per month
 *   (`abGroupTargets`), and migration `0069-ab-group-targets-by-month` carried an AB's year into its months. The rows stay
 *   as the record of what was typed.
 */
@Schema({ ...baseSchemaOptions, collection: 'analyticsTargets' })
export class AnalyticsTarget {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, enum: ['mapa', 'subgroup'], required: true })
  kind!: AnalyticsTargetKind;

  /** `YYYY-MM`, a MAPA target's month; `null` for a sub-group target. */
  @Prop({ type: String, default: null })
  month!: string | null;

  /** A MAPA row's key (the forum's `RowKey`); `null` for a sub-group target. */
  @Prop({ type: String, default: null })
  row!: string | null;

  /** A MAPA target, or `null` — *TBD*. */
  @Prop({ type: Number, default: null })
  value!: number | null;

  /** A sub-group target's leader: an AB's or an AAB's membership `_id`. */
  @Prop({ type: String, default: null })
  headMembershipId!: string | null;

  /** A sub-group target's year, `YYYY` on the office's clock; `null` for a MAPA target (ADR-0253 §4). */
  @Prop({ type: String, default: null })
  year!: string | null;

  @Prop({ type: Number, default: null, min: 0 })
  aaTarget!: number | null;

  @Prop({ type: Number, default: null, min: 0 })
  recTarget!: number | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const AnalyticsTargetSchema = SchemaFactory.createForClass(AnalyticsTarget);

/** One MAPA target per month and row. */
AnalyticsTargetSchema.index(
  { kpmId: 1, kind: 1, month: 1, row: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null, kind: 'mapa' } },
);
/**
 * One pair of sub-group targets per leader and year (ADR-0253 §4). Named, so `0062-subgroup-targets-by-year` can build it
 * before it drops `kpmId_1_kind_1_headMembershipId_1`, the one-per-head index it replaces.
 */
export const SUBGROUP_TARGET_INDEX = 'one_subgroup_target_per_leader_and_year';
AnalyticsTargetSchema.index(
  { kpmId: 1, kind: 1, headMembershipId: 1, year: 1 },
  { unique: true, name: SUBGROUP_TARGET_INDEX, partialFilterExpression: { deletedAt: null, kind: 'subgroup' } },
);
