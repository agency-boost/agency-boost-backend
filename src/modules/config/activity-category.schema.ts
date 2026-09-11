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
