import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type TrainingCategoryDocument = HydratedDocument<TrainingCategory>;

/**
 * The top of an office's training tree (P5-T1, ADR-0029).
 *
 * The office's own: seeded from its company's template, then created, edited and archived by
 * its Owner and Admins. Hardcoded as six in the prototype (`training.md` §3).
 */
@Schema({ ...configSchemaOptions, collection: 'trainingCategories' })
export class TrainingCategory {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** `SALES`. Stable, semantic, and never reused once saved (ADR-0006). */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** The subtitle an agent's category page shows. */
  @Prop({ type: String, default: null, trim: true })
  description!: string | null;

  /** Presentation only. Appended on create; nothing reads it back. */
  @Prop({ type: Number, required: true })
  displayOrder!: number;

  /** The domain's version (invariant §3), not Mongoose's — see `configSchemaOptions`. */
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

export const TrainingCategorySchema = SchemaFactory.createForClass(TrainingCategory);

/** One code per office, counting archived rows — a retired code never comes back meaning something else. */
TrainingCategorySchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The read order. */
TrainingCategorySchema.index({ kpmId: 1, displayOrder: 1 });
