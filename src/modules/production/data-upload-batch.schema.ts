import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type DataUploadBatchDocument = HydratedDocument<DataUploadBatch>;

/**
 * An import's life (P9-T4).
 *
 * `pending` → `committed` → `reverting` → `reverted`. **`pending` and `reverting` are the undo log's
 * two open states**: a batch's rows, with every figure's previous value, are written before a single
 * figure changes, so a batch caught in either state can always be finished or undone. `failed` is a
 * commit that was undone — nothing it wrote remains.
 */
export const BATCH_STATUSES = ['pending', 'committed', 'reverting', 'reverted', 'failed'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * One confirmed import of a filled template into one month (P9-T4, AC-1).
 *
 * **What the batch says about the file**: its name, its SHA-256, the template version, the encoding
 * and delimiter it was read with, and the month revision its preview was taken against. The file
 * itself is not kept: its figures are in `dataUploadRows`, and a copy of a spreadsheet of names is
 * personal data held for no reader.
 *
 * **What it says about the import**: who confirmed it and when, how many rows the file had, how many
 * were written and how many figures, how many issues were not taken — and, once reverted, who reverted
 * it and how many figures went back.
 */
@Schema({ ...baseSchemaOptions, collection: 'dataUploadBatches' })
export class DataUploadBatch {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  month!: string;

  @Prop({ type: String, enum: BATCH_STATUSES, required: true })
  status!: BatchStatus;

  @Prop({ type: String, required: true })
  filename!: string;

  @Prop({ type: String, required: true })
  fileSha256!: string;

  @Prop({ type: Number, required: true })
  templateVersion!: number;

  @Prop({ type: String, required: true })
  encoding!: string;

  @Prop({ type: String, required: true })
  delimiter!: string;

  /** The revision the preview was taken against — with the file's hash, what "the same preview" means. */
  @Prop({ type: Number, required: true })
  basedOnRevision!: number;

  /**
   * The month revision this import claimed — **the order of imports within a month**.
   *
   * Not `committedAt`: two imports in one millisecond tie, and a fixed clock ties every one. The
   * revision is claimed atomically and only once, so "the latest standing import" is never ambiguous.
   */
  @Prop({ type: Number, required: true })
  monthRevision!: number;

  /** Data rows in the file. */
  @Prop({ type: Number, required: true })
  rowCount!: number;

  /** Rows with at least one figure written. */
  @Prop({ type: Number, required: true })
  writtenRowCount!: number;

  /** Figures written. */
  @Prop({ type: Number, required: true })
  cellCount!: number;

  /** Rows and figures not taken. */
  @Prop({ type: Number, required: true })
  issueCount!: number;

  /** When the write began, from the clock port — what decides whether a `pending` batch is stranded. */
  @Prop({ type: Date, required: true })
  startedAt!: Date;

  @Prop({ type: Date, default: null })
  committedAt!: Date | null;

  @Prop({ type: String, default: null })
  committedBy!: string | null;

  @Prop({ type: Date, default: null })
  revertedAt!: Date | null;

  @Prop({ type: String, default: null })
  revertedBy!: string | null;

  /** Figures corrected by hand that the file would have changed, and the importer left as they were (ADR-0053). */
  @Prop({ type: Number, default: 0 })
  keptCorrectionCount!: number;

  /** Figures corrected by hand that the importer chose to replace with the file's. */
  @Prop({ type: Number, default: 0 })
  replacedCorrectionCount!: number;

  /** Figures a revert put back. */
  @Prop({ type: Number, default: 0 })
  restoredCellCount!: number;

  /** Figures a revert left alone, because something else had written them since. */
  @Prop({ type: Number, default: 0 })
  keptCellCount!: number;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const DataUploadBatchSchema = SchemaFactory.createForClass(DataUploadBatch);

/** The history panel, and "the latest standing import" revert has to find. */
DataUploadBatchSchema.index({ kpmId: 1, month: 1, status: 1, monthRevision: -1 });
/** "Has this very preview been committed?" — the file's hash against the revision it saw. */
DataUploadBatchSchema.index({ kpmId: 1, month: 1, fileSha256: 1, basedOnRevision: 1 });
