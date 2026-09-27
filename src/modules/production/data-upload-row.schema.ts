import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import type { MetricValue } from './monthly-agent-data.schema';

export type DataUploadRowDocument = HydratedDocument<DataUploadRow>;

/**
 * A figure as it stood before an import — the whole cell, a correction's who, when and why included,
 * so a revert puts a correction back as a correction. `null` when there was no row to hold it.
 */
export type PreviousValue = Pick<
  MetricValue, 'value' | 'provenance' | 'sourceBatchId' | 'correctedBy' | 'correctedAt' | 'reason'
> | null;

/**
 * One line of an imported file, and what it did (P9-T4, AC-1).
 *
 * **This is what makes revert possible.** `values` is what the import wrote, keyed by the month row's
 * own field — `apeMonthly`, `persistencyYtd` — and `previousValues` is what each of those held a
 * moment before, provenance and source included. Written **before** a single figure changes, so the
 * way back exists before the way forward is taken.
 *
 * Every data row of the file is here, including those not taken: an unknown code, an agent listed
 * twice. `issues` says why, in the preview's own words, so the import can be read afterwards as it
 * was previewed.
 */
@Schema({ ...baseSchemaOptions, collection: 'dataUploadRows' })
export class DataUploadRow {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  batchId!: string;

  @Prop({ type: String, required: true })
  month!: string;

  /** The file's line, as a spreadsheet numbers it. */
  @Prop({ type: Number, required: true })
  line!: number;

  /** As the file has it. */
  @Prop({ type: String, required: true })
  agentCode!: string;

  /** `null` for a row no member answered to. */
  @Prop({ type: String, default: null })
  membershipId!: string | null;

  @Prop({ type: String, enum: ['ready', 'refused'], required: true })
  status!: 'ready' | 'refused';

  @Prop({ type: Object, default: () => ({}) })
  values!: Record<string, number>;

  @Prop({ type: Object, default: () => ({}) })
  previousValues!: Record<string, PreviousValue>;

  @Prop({ type: [Object], default: [] })
  issues!: { code: string; message: string; metric: string | null; cadence: string | null }[];

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const DataUploadRowSchema = SchemaFactory.createForClass(DataUploadRow);

/** A batch's rows — what revert and recovery read. */
DataUploadRowSchema.index({ kpmId: 1, batchId: 1, deletedAt: 1 });
