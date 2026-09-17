import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { RATIO_DISPLAY_UNITS, type RatioDisplayUnit } from '@/domain/constants';

export type RatioDefinitionDocument = HydratedDocument<RatioDefinition>;

export const RATIO_COMPARISONS = ['gte', 'band'] as const;
export type RatioComparison = (typeof RATIO_COMPARISONS)[number];

export const RATIO_ORIGINS = ['platform', 'office'] as const;
export type RatioOrigin = (typeof RATIO_ORIGINS)[number];

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

  /**
   * How `benchmark` is written for a reader (P4-T25): `percent` (`0.15` → `15.0%`),
   * `decimal` (`0.30` → `0.30`) or `points` (`30` → `±30 points`).
   *
   * Presentation, not arithmetic — the stored benchmark is compared exactly as before. It is
   * a column rather than something a screen works out because it cannot be worked out: the
   * value `0.30` is a percentage on one ratio and a plain number on another. Always
   * resolved against `comparison` by `resolveDisplayUnit`, so a band ratio is points and an
   * at-or-above ratio never is.
   */
  @Prop({ type: String, required: true, enum: RATIO_DISPLAY_UNITS, default: 'decimal' })
  displayUnit!: RatioDisplayUnit;

  /**
   * Whose formula this is (ADR-0021).
   *
   * `platform` is everything provisioning wrote — the platform defaults *and* a company's
   * published `ratio_set`. From the office's point of view both are vocabulary handed
   * down, exactly like the company ladder (ADR-0012) and the KPM template (ADR-0018), and
   * both are the ones a comparison across offices would ever want to put in one column.
   * Their `numerator` and `denominator` are not the tenant's to change; their `benchmark`
   * is, because a target is precisely the thing an office should set for itself.
   *
   * `office` is anything an Owner created. Free in every respect, and never comparable —
   * which costs nothing, because it never was.
   */
  @Prop({ type: String, required: true, enum: RATIO_ORIGINS, default: 'office' })
  origin!: RatioOrigin;

  /**
   * The formula this row was **provisioned with** (ADR-0024), or `null` on a ratio the
   * office created for itself.
   *
   * Recorded on the row rather than looked up, for three reasons. It is what the office was
   * seeded from, which is the comparison ADR-0024 names — and a company republishing its
   * `ratio_set` must not retroactively change what an existing office is said to diverge
   * from (ADR-0018). It makes divergence a pure comparison of a row against itself, with no
   * second collection to read on every settings load. And it lets the screen show an Owner
   * *what* they diverged from, not only that they did.
   *
   * `divergesFromStandard` is **derived** from this, never stored: two fields that must
   * agree are two fields that eventually will not.
   */
  @Prop({ type: [String], default: null })
  standardNumerator!: string[] | null;

  @Prop({ type: [String], default: null })
  standardDenominator!: string[] | null;

  /**
   * The ladder rungs this ratio is a question about (ADR-0020).
   *
   * **Empty means every rung**, so an office that never opens the control never has to
   * understand it. A member whose rung is absent does not see the ratio at all — hidden,
   * never shown as failed, because a plain agent reading 100% Selling on the balance ratio
   * is not doing badly at recruitment, they are not being asked about it.
   *
   * Rung **codes**, not the `role` enum (invariant §4, ADR-0012): a company publishing a
   * fourth rung gets a ratio that can name it, and P4-T9 removed the enum from every
   * authorisation path for exactly this reason.
   */
  @Prop({ type: [String], required: true, default: [] })
  appliesToOrgLevelCodes!: string[];

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
