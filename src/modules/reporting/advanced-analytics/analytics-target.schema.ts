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
 * - `kind: 'subgroup'`: one per `(kpmId, headMembershipId)` — the head's membership `_id` (invariant §2) — with
 *   `aaTarget` and `recTarget`; until written the template's `subgroupHeadDefaults` stand.
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

  /** A sub-group target's head of group: an AB's membership `_id`. */
  @Prop({ type: String, default: null })
  headMembershipId!: string | null;

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
/** One pair of sub-group targets per head of group. */
AnalyticsTargetSchema.index(
  { kpmId: 1, kind: 1, headMembershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null, kind: 'subgroup' } },
);
