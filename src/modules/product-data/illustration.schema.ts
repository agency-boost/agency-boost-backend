import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import {
  ILLUSTRATION_STATUSES, type IllustrationCheckState, type IllustrationStatus, type PdfDetailBlockKind,
} from '@/domain/constants';
import type { ReadingFailure } from './ai/reader.port';

export type IllustrationDocument = HydratedDocument<Illustration>;

/** One number of the illustration a formula is checked against: the inputs it was printed for, and the amount. */
export interface IllustrationSample {
  page: number | null;
  /** The illustration's own inputs, minor units by formula name (`up` → 50 000 000 000). */
  inputs: Record<string, number>;
  /** The amount it prints, minor units. */
  printedMinor: number;
  /** Our evaluation of the formula for those inputs; `null` when it cannot be worked out. */
  computedMinor: number | null;
  match: boolean;
}

/** **A formula's check** (P19.15-T2 AC-2): both numbers matched, one did not, or fewer than two could be read. */
export interface IllustrationCheck {
  state: IllustrationCheckState;
  /** Why it is `mismatch` or `unchecked`: a sample that differs, a name the product has not, too few samples. */
  reason: 'differs' | 'name' | 'grammar' | 'few_samples' | null;
  samples: IllustrationSample[];
}

/** One row of a block, as the Super Admin edits it, with the page it came from and its check. */
export interface IllustrationRow {
  /** Stable across edits: the evidence a row was read with stays with it when the Super Admin rewords or reorders. */
  id: string;
  label: string;
  note: string | null;
  formula: string | null;
  text: string | null;
  page: number | null;
  /** The numbers found for it, kept so a formula edited by hand is checked again against the same two. */
  evidence: { page: number | null; printedMinor: number; inputs: Record<string, number> }[];
  check: IllustrationCheck | null;
}

export interface IllustrationBlock {
  block: PdfDetailBlockKind;
  page: number | null;
  rows: IllustrationRow[];
}

/**
 * **An official illustration, condensed into the PDF's detail blocks** (P19.15-T2; ADR-0259 §8; the P1b spec's
 * `illustration` and `pdf_detail_block`). Company data like `products`: `companyId`, no `kpmId`.
 *
 * - **`reading`** while Claude condenses it, **`draft`** while the Super Admin checks the wording and the formulas,
 *   **`published`** once its blocks are the product's `pdfDetail` — for new proposals only; a saved proposal keeps the
 *   blocks it printed (its item's snapshot, ADR-0225 §3) — and **`failed`** when reading failed. A newer publish sets
 *   `supersededAt` on the one before.
 * - **Every amount is a formula of the agent's inputs**, checked against two numbers printed in the illustration; a
 *   formula that does not match is flagged, never corrected by a guess.
 * - **Soft delete** (invariant §6).
 */
@Schema({ ...baseSchemaOptions, collection: 'illustrations' })
export class Illustration {
  @Prop({ type: String, required: true })
  companyId!: string;

  @Prop({ type: String, required: true })
  productId!: string;

  @Prop({ type: String, default: null })
  plan!: string | null;

  @Prop({ type: String, required: true })
  fileName!: string;

  /** The PDF, kept in the company's folder; `null` where storage is not configured (development). */
  @Prop({ type: String, default: null })
  fileKey!: string | null;

  /** The illustration's own date, `YYYY-MM-DD`: what *source.date* on each published block says. */
  @Prop({ type: String, required: true })
  illustrationDate!: string;

  @Prop({ type: String, enum: ILLUSTRATION_STATUSES, required: true })
  status!: IllustrationStatus;

  @Prop({ type: String, default: null })
  failure!: ReadingFailure | 'stale' | null;

  @Prop({ type: Date, required: true })
  readingStartedAt!: Date;

  @Prop({ type: [Object], default: [] })
  blocks!: IllustrationBlock[];

  /** What the reading left out — boilerplate, fund descriptions, repeated tables — in its own words. */
  @Prop({ type: [String], default: [] })
  dropped!: string[];

  /** The illustration's sample inputs, minor units by name: the preview's values. */
  @Prop({ type: Object, default: () => ({}) })
  sampleInputs!: Record<string, number>;

  /** *Unggah file*'s item it came from, when it did. */
  @Prop({ type: String, default: null })
  intakeItemId!: string | null;

  @Prop({ type: String, required: true })
  uploadedBy!: string;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  @Prop({ type: String, default: null })
  publishedBy!: string | null;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Date, default: null })
  supersededAt!: Date | null;

  @Prop({ type: Object, default: () => ({ inputTokens: 0, outputTokens: 0 }) })
  usage!: { inputTokens: number; outputTokens: number };

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const IllustrationSchema = SchemaFactory.createForClass(Illustration);
/** One product's illustrations, newest first: the *Ilustrasi* tab. */
IllustrationSchema.index({ companyId: 1, productId: 1, deletedAt: 1, createdAt: -1 });
