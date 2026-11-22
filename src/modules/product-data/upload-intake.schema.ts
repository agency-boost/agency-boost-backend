import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import {
  INTAKE_ITEM_KINDS, INTAKE_ITEM_STATUSES, INTAKE_STATUSES,
  type IntakeFileKind, type IntakeItemKind, type IntakeItemStatus, type IntakeQuestionKind, type IntakeStatus,
} from '@/domain/constants';
import type { ReadingFailure } from './ai/reader.port';

export type UploadIntakeDocument = HydratedDocument<UploadIntake>;
export type IntakeItemDocument = HydratedDocument<IntakeItem>;

/** One file of an upload — a ZIP's files each their own — with how its reading went. */
export interface IntakeFile {
  /** Its index in the upload: what a source link names (`/files/:index`). */
  index: number;
  name: string;
  kind: IntakeFileKind;
  mimeType: string;
  bytes: number;
  /** Where the original is kept (the company's folder, or the uploader's when the company is not known); `null` unkept. */
  storageKey: string | null;
  fromZip: string | null;
  status: 'reading' | 'read' | 'failed';
  failure: ReadingFailure | 'too_long' | 'unreadable' | null;
  /** How many items it gave. */
  items: number;
}

/**
 * ***Unggah file*: one upload** (P19.15-T3; ADR-0259; the P1b spec's `upload_intake`). **Company data, not tenant data**:
 * `companyId` the company it was uploaded for, or `null` for *Perusahaan*'s upload where the files must say which —
 * no `kpmId`, as `products` has none (ADR-0033).
 *
 * - **Read in the API's own process** (§5): `status: 'reading'` until each file has been read; a reading still
 *   unfinished `INTAKE.STALE_READING_MINUTES` after `readingStartedAt` is reported `failed` on the next read.
 * - **Its status after reading follows its items** (`intake-status.ts`): `needs_answers` while any has an open
 *   question, `ready` when all are answered and some wait for a confirm, `applied` once each is applied or rejected with
 *   at least one applied, `rejected` when each was rejected.
 * - **Soft delete** (invariant §6).
 */
@Schema({ ...baseSchemaOptions, collection: 'uploadIntakes' })
export class UploadIntake {
  @Prop({ type: String, default: null })
  companyId!: string | null;

  @Prop({ type: [Object], default: [] })
  files!: IntakeFile[];

  /** The user who uploaded (a global user id: the Super Admin, or a holder of *Kelola data produk*). */
  @Prop({ type: String, required: true })
  uploadedBy!: string;

  @Prop({ type: String, enum: INTAKE_STATUSES, required: true })
  status!: IntakeStatus;

  @Prop({ type: Date, required: true })
  readingStartedAt!: Date;

  @Prop({ type: Date, default: null })
  readAt!: Date | null;

  /** Why the whole upload failed (`stale`, `not_configured`), when it did; a file's own failure is on the file. */
  @Prop({ type: String, default: null })
  failure!: string | null;

  /** Tokens the reading took, summed over its files (ADR-0259 §7): what the owner is billed for, never the content. */
  @Prop({ type: Object, default: () => ({ inputTokens: 0, outputTokens: 0 }) })
  usage!: { inputTokens: number; outputTokens: number };

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const UploadIntakeSchema = SchemaFactory.createForClass(UploadIntake);
/** One company's uploads, newest first: the Proposal tab's list. */
UploadIntakeSchema.index({ companyId: 1, deletedAt: 1, createdAt: -1 });

/** Where in a file a value stands: the file (by index), the page, the sheet and cell, a short quote. */
export interface IntakeSource {
  file: number;
  fileName: string;
  page: number | null;
  sheet: string | null;
  cell: string | null;
  quote: string | null;
}

/** **One line of a card**: old → new, from its source, and whether the new value was read with full certainty. */
export interface IntakeDiffRow {
  /** What changes, by our name: `upMin`, `payTermMaxAge:y10`, `frequencyFactor:monthly`, `name`, `table`. */
  key: string;
  label: string;
  /** The value now, as the card says it, or `null` for *Belum ada*. */
  old: string | null;
  /** The new value, as the card says it, or `null` while a question must give it. */
  new: string | null;
  /** The new value as stored: minor units, a whole number, a rate, a text, a flag. */
  value: number | string | boolean | null;
  certain: boolean;
  source: IntakeSource;
}

export interface IntakeChoice { value: string; label: string }

/** **A question card**: what is asked, its choices, the answer and who gave it. */
export interface IntakeQuestion {
  id: string;
  kind: IntakeQuestionKind;
  text: string;
  choices: IntakeChoice[];
  /** What the answer decides: a column (`column:C`), a cell (`cell:12:C`), a diff row (`diff:upMin`), … */
  about: string | null;
  /** Asked only when another question has this answer (a new product's code, after *Produk baru*). */
  when: { question: string; answer: string } | null;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: Date | null;
}

/** A table's column as the reading understood it, its meaning a person may still have to give. */
export interface IntakeTableColumn {
  column: string;
  header: string;
  meaning: 'age' | 'gender' | 'smoker' | 'plan' | 'pay_term' | 'rate' | 'band_min' | 'band_max' | 'ignore' | 'unclear';
  gender: 'male' | 'female' | null;
  smoker: boolean | null;
  plan: string | null;
  payTermKey: string | null;
}

/** **A premium table found in a file**: its columns and its cells exactly as written, read again at confirm. */
export interface IntakeTable {
  sheet: string | null;
  basis: 'per_mille' | 'per_plan' | 'per_band' | null;
  currency: 'IDR' | 'USD' | null;
  columns: IntakeTableColumn[];
  /** Each row's cells by column, as written, with the row's source and each cell's certainty. */
  rows: { row: number | null; page: number | null; cells: Record<string, { text: string; value: string | null; certain: boolean }> }[];
  gaps: string[];
}

/**
 * **One thing a file says** (the P1b spec's `intake_item`): a premium table, a product's rules, an illustration, a new or
 * withdrawn product, a change of a field, or a percentage change. One card per product.
 *
 * - **Nothing is applied until a person confirms it** (P19.15-T3 AC-3): `needs_answers` while a question is open,
 *   `ready` once each is answered, then `applied` (through T1's or T2's flow, `appliedRef` naming what it made) or
 *   `rejected`.
 * - **The numbers are the file's** (ADR-0259 §3): a table's cells and a rule's value as written, kept with their
 *   certainty; a number not read with certainty is a *ketik angkanya* question, and a percentage an approval request.
 */
@Schema({ ...baseSchemaOptions, collection: 'intakeItems' })
export class IntakeItem {
  @Prop({ type: String, required: true })
  intakeId!: string;

  /** The company it is for: the upload's, or the one the file names or a person chose. `null` while asked. */
  @Prop({ type: String, default: null })
  companyId!: string | null;

  @Prop({ type: String, default: null })
  productId!: string | null;

  /** The product as the file names it: what the card shows before it is matched. */
  @Prop({ type: String, default: null })
  productAsWritten!: string | null;

  @Prop({ type: String, enum: INTAKE_ITEM_KINDS, required: true })
  kind!: IntakeItemKind;

  /** One plain line: *"Tabel premi baru PRUCerah, berlaku 1 Des 2026"*. */
  @Prop({ type: String, default: '' })
  summary!: string;

  @Prop({ type: String, default: null })
  effectiveFrom!: string | null;

  @Prop({ type: String, default: null })
  effectiveTo!: string | null;

  @Prop({ type: Object, required: true })
  source!: IntakeSource;

  @Prop({ type: [Object], default: [] })
  diff!: IntakeDiffRow[];

  @Prop({ type: Object, default: null })
  table!: IntakeTable | null;

  /** *Naik 5%*: the percentage as written, its direction, and the rule a person is asked to approve. */
  @Prop({ type: Object, default: null })
  percent!: { asWritten: string; direction: 'up' | 'down'; rule: string; factor: string } | null;

  /** A new product's name, as the file writes it. */
  @Prop({ type: String, default: null })
  newProductName!: string | null;

  @Prop({ type: [Object], default: [] })
  questions!: IntakeQuestion[];

  /** `high` when every value was read with certainty and every match is clear; `low` otherwise. */
  @Prop({ type: String, enum: ['high', 'low'], default: 'high' })
  confidence!: 'high' | 'low';

  @Prop({ type: String, enum: INTAKE_ITEM_STATUSES, required: true })
  status!: IntakeItemStatus;

  /** What applying it made or changed: a premium table draft, a product, an illustration. */
  @Prop({ type: Object, default: null })
  appliedRef!: { kind: 'rate_table' | 'product' | 'illustration'; id: string } | null;

  @Prop({ type: String, default: null })
  decidedBy!: string | null;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const IntakeItemSchema = SchemaFactory.createForClass(IntakeItem);
/** An upload's cards, in the order they were found. */
IntakeItemSchema.index({ intakeId: 1, deletedAt: 1, createdAt: 1 });
/** A company's items by product: *Perubahan oleh pengelola* and a product's history. */
IntakeItemSchema.index({ companyId: 1, productId: 1, deletedAt: 1 });
