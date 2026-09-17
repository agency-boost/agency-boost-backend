import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { TRAINING_PUBLISH_STATES, type TrainingPublishState } from '@/domain/constants';

export type TrainingModuleDocument = HydratedDocument<TrainingModule>;

/**
 * One thing an agent studies, taught under one skill (P5-T1, ADR-0029).
 *
 * **Its category is its skill's, and is not stored here.** Storing both would be two answers
 * to one question, and they would eventually disagree — which is the prototype's own defect,
 * where a module's skill options ignored its category (parity F-13).
 *
 * What it contains — files, videos, links — is P5-T2's (OD-59), and not on this schema yet.
 */
@Schema({ ...configSchemaOptions, collection: 'trainingModules' })
export class TrainingModule {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  skillCode!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  /**
   * Whether agents are offered this module **at all**. Not when: that is the office's own
   * publish (P4-T6). A draft never reaches an agent, whatever the office publishes.
   */
  @Prop({ type: String, enum: TRAINING_PUBLISH_STATES, required: true, default: 'draft' })
  publishState!: TrainingPublishState;

  /** Within its skill. */
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

export const TrainingModuleSchema = SchemaFactory.createForClass(TrainingModule);

TrainingModuleSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The read order: a skill's modules, as arranged. */
TrainingModuleSchema.index({ kpmId: 1, skillCode: 1, displayOrder: 1 });
