import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type ActivityCategoryDocument = HydratedDocument<ActivityCategory>;

/**
 * A grouping of activity types, owned by one office (P4-T1).
 *
 * Hardcoded and global in the prototype (`activity-management.md:140`); per-KPM here,
 * because two offices may count different things and Phase 4 exists to let them.
 */
@Schema({ ...configSchemaOptions, collection: 'activityCategories' })
export class ActivityCategory {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** `SELLING`. Stable, semantic, and never reused once published (ADR-0006). */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** Optional, and shown under the heading. Mirrors `activityTypes.description`. */
  @Prop({ type: String, default: null, trim: true })
  description!: string | null;

  /**
   * The ladder rungs this whole section is a question for (ADR-0020, P4-T18).
   *
   * **Empty means every rung**, exactly as it does on `ratioDefinitions` — same field
   * name, same semantics, because a second spelling would be a second concept.
   *
   * **It cascades to the types inside it, and a type has no applicability of its own.**
   * One axis, not two: two would give four combinations and a reader would have to know
   * which one wins before they could read the screen. A member whose rung is absent does
   * not see the category or anything in it — hidden, never shown as failed.
   *
   * Rung **codes**, not the retired `role` enum (invariant §4, ADR-0012).
   */
  @Prop({ type: [String], required: true, default: [] })
  appliesToOrgLevelCodes!: string[];

  /**
   * The summary tile this section counts toward (ADR-0064, P10.1-T5): `DEVELOPMENT`.
   *
   * **Presentation, never a metric input.** The strips on `/activity/log` and
   * `/activity/dashboard` read it, and nothing else: every ratio, cascade binding and
   * compliance count is by type code (invariant §4), so regrouping moves a count between tiles
   * and never changes one.
   *
   * **Sections sharing a code share a tile; a section with none has a tile of its own**, under
   * its own label — so a section an office adds is always counted somewhere, which is what OD-63
   * was resolved to guarantee. Set together with `summaryGroupLabel` or not at all.
   */
  @Prop({ type: String, default: null, uppercase: true, trim: true })
  summaryGroupCode!: string | null;

  /**
   * The tile's label, **held on every section in the group and identical across them** — the
   * service refuses a write that would leave two disagreeing (`CONFIG_SUMMARY_GROUP_LABEL_MISMATCH`).
   * Configuration, never a frontend literal.
   */
  @Prop({ type: String, default: null, trim: true })
  summaryGroupLabel!: string | null;

  /** Presentation only, and reorderable — which is why nothing references it. */
  @Prop({ type: Number, required: true })
  displayOrder!: number;

  /**
   * The domain's version (invariant §3), not Mongoose's — `configSchemaOptions` hands the
   * internal counter back its default name so this one means what the rule says.
   */
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

export const ActivityCategorySchema = SchemaFactory.createForClass(ActivityCategory);

/**
 * One code per office, counting archived rows. Uniqueness among the merely active would
 * let a retired `SELLING` be recreated as something else, and every archived type still
 * pointing at it would quietly change meaning.
 */
ActivityCategorySchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The read order: an office's categories, as the Owner arranged them. */
ActivityCategorySchema.index({ kpmId: 1, displayOrder: 1 });
