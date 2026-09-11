import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type RatioDefinitionDocument = HydratedDocument<RatioDefinition>;

export const RATIO_COMPARISONS = ['gte', 'band'] as const;
export type RatioComparison = (typeof RATIO_COMPARISONS)[number];

/**
 * One ratio the office measures its agents by (P4-T2).
 *
 * **The formula is a pair of code lists, not an expression.** `Overall.html` writes them
 * as `6 / (4+5)` — activity item *numbers* — and the same prototype lets an Owner reorder
 * those items, so an office that dragged a row would silently rebind every formula. Sums
 * of named codes over a division is the whole of what the five ratios need, and it cannot
 * express anything that would need parsing, validating or sandboxing.
 *
 * **`comparison` is a named rule, not an operator.** `gte` is "at or above the benchmark".
 * `band` is the balance ratio's `abs(sellingPct − 50) × 2 ≤ benchmark`, which is a
 * different shape entirely — storing `>=` and `<=` would have lost that.
 */
@Schema({ ...configSchemaOptions, collection: 'ratioDefinitions' })
export class RatioDefinition {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** Activity type codes summed for the numerator. Codes, never positions. */
  @Prop({ type: [String], required: true, default: [] })
  numerator!: string[];

  @Prop({ type: [String], required: true, default: [] })
  denominator!: string[];

  /**
   * The office's own value. Seeded from `RATIO_BENCHMARKS` and owned from then on — the
   * constants module stays the single source of the *default*, not of this number.
   */
  @Prop({ type: Number, required: true })
  benchmark!: number;

  @Prop({ type: String, required: true, enum: RATIO_COMPARISONS })
  comparison!: RatioComparison;

  @Prop({ type: Number, required: true })
  displayOrder!: number;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const RatioDefinitionSchema = SchemaFactory.createForClass(RatioDefinition);

RatioDefinitionSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

RatioDefinitionSchema.index({ kpmId: 1, displayOrder: 1 });
