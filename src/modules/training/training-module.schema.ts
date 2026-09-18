import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { TRAINING_PUBLISH_STATES, type TrainingPublishState } from '@/domain/constants';

export type TrainingModuleDocument = HydratedDocument<TrainingModule>;

/**
 * One uploaded file or short video inside a module.
 *
 * It holds a `storageKey` and never a URL: a URL is minted per request, signed, and expires in
 * 300 seconds (ADR-0032). A stored URL would be a permanent public link to a private file.
 */
@Schema({ _id: false })
export class TrainingContentFile {
  /** Stable for the life of the item, so an office's override can name what it replaces. */
  @Prop({ type: String, required: true })
  id!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  @Prop({ type: String, required: true })
  storageKey!: string;

  @Prop({ type: String, required: true })
  mimeType!: string;

  @Prop({ type: Number, required: true })
  bytes!: number;
}

export const TrainingContentFileSchema = SchemaFactory.createForClass(TrainingContentFile);

/** Anything longer than the 25 MB ceiling is a link, not an upload (ADR-0032). */
@Schema({ _id: false })
export class TrainingContentLink {
  @Prop({ type: String, required: true })
  id!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  @Prop({ type: String, required: true, trim: true })
  url!: string;
}

export const TrainingContentLinkSchema = SchemaFactory.createForClass(TrainingContentLink);

/** The three sections the prototype's modal names (`KPM_Owner.html:1618-1630`). */
@Schema({ _id: false })
export class TrainingContent {
  @Prop({ type: [TrainingContentFileSchema], default: [] })
  files!: TrainingContentFile[];

  @Prop({ type: [TrainingContentFileSchema], default: [] })
  videos!: TrainingContentFile[];

  @Prop({ type: [TrainingContentLinkSchema], default: [] })
  links!: TrainingContentLink[];
}

export const TrainingContentSchema = SchemaFactory.createForClass(TrainingContent);

/**
 * One thing an agent studies, taught under one skill (P5-T1, ADR-0029).
 *
 * **Its category is its skill's, and is not stored here.** Storing both would be two answers
 * to one question, and they would eventually disagree — which is the prototype's own defect,
 * where a module's skill options ignored its category (parity F-13).
 *
 * **What it contains is two fields, not one** (P5-T2, ADR-0032). `companyContent` is what
 * provisioning copied from the company's template — by **reference**, never by copying bytes, so a
 * new office opens with its company's material at no storage cost. `officeContent` is this office's
 * own replacement, and `null` means it has none and is using the company's.
 *
 * Two fields rather than one merged list, because the ADR requires the replacement to be
 * **reversible**: an office that removes its version falls back to the company's, and a single
 * list would have had to remember what it overwrote in order to put it back.
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

  /**
   * The company's material, referenced (ADR-0032).
   *
   * Its files are company-owned assets — `companyId`, no `kpmId` — that every office of the
   * company reads by reference. The office never edits this; new material is a new template
   * version, which reaches offices created afterwards and never reaches back (ADR-0018), so
   * nothing changes under an agent halfway through a module.
   */
  @Prop({ type: TrainingContentSchema, default: () => ({}) })
  companyContent!: TrainingContent;

  /**
   * This office's own replacement, or `null` when it is using the company's.
   *
   * `null` is the whole of the fallback rule: removing the replacement is writing `null`, and
   * the company's material is what the office shows again.
   */
  @Prop({ type: TrainingContentSchema, default: null })
  officeContent!: TrainingContent | null;

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
