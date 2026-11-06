import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type TrainingSkillDocument = HydratedDocument<TrainingSkill>;

/**
 * The middle of the training tree: a skill inside a category, the level modules hang off
 * (P5-T1, ADR-0029).
 *
 * **A collection, not an array on the category.** Each skill carries its own code, version and
 * archived state and is written on its own; embedded, every edit to one skill would version
 * its category, and restoring a skill would be a rewrite of its parent.
 *
 * **Not a Skill tracker item** — that is the capability catalog's (ADR-0025). Code says
 * `trainingSkill`, never a bare `skill`.
 */
@Schema({ ...configSchemaOptions, collection: 'trainingSkills' })
export class TrainingSkill {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  /** Its category, by code. Editable: a skill that moves takes its modules with it. */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  categoryCode!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /**
   * ***Deskripsi singkat*** (P19.6-T4, ADR-0220 §1; UI-161): the grey line under the name, at most
   * `TRAINING_TEXT.DESCRIPTION_MAX` characters of plain text, or `null`. The name stays `label`.
   */
  @Prop({ type: String, default: null, trim: true })
  description!: string | null;

  /** Within its category. */
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

export const TrainingSkillSchema = SchemaFactory.createForClass(TrainingSkill);

TrainingSkillSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The read order: a category's skills, as arranged. */
TrainingSkillSchema.index({ kpmId: 1, categoryCode: 1, displayOrder: 1 });
