import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import {
  PROPOSAL_PAY_FREQUENCIES, RATE_BASES,
  type ProductCurrency, type ProposalPayFrequency, type RateBasis, type RateColumnRole, type RateTableSource,
} from '@/domain/constants';

export type RateTableDocument = HydratedDocument<RateTable>;
export type RateRowDocument = HydratedDocument<RateRow>;

/**
 * **A version's rules, versioned with its rates** (P19.15-T1 AC-4; ADR-0258 §3): what the agent's card holds the amounts
 * and the insured's age to while this version is in force. Each `null` is *no limit* — without a UP step the UP is not
 * rounded, without a minimum no message shows (P1b *Isian*). Amounts in minor units of the row's currency; premium limits
 * are **per year** (the table's annual premium, before a *Cara bayar* factor).
 */
export interface RateRules {
  upStep: number | null;
  upMin: number | null;
  upMax: number | null;
  premiumMin: number | null;
  premiumMax: number | null;
  entryAgeMin: number | null;
  entryAgeMax: number | null;
  /** The oldest age at the next birthday each pay term (by its key) may be entered at. */
  payTermMaxAge: Record<string, number>;
}

/**
 * **The *Cara bayar* factors, against the annual premium** (P1 spec's *Payment frequency*): *bulanan 0,0875*. `null` is
 * *not given*: a frequency without a factor, and without rows of its own, is not offered (ADR-0258 §4). Never an assumed
 * 12× or 11×.
 */
export interface FrequencyFactors {
  monthly: number | null;
  quarterly: number | null;
  semiannual: number | null;
  annual: number | null;
}

/** One of *Uji 3 contoh*'s profiles, as typed from the official illustration, with the app's own result beside it. */
export interface RateTestCase {
  inputs: {
    age: number;
    gender: 'male' | 'female';
    smoker: boolean | null;
    plan: string | null;
    payTerm: string | null;
    payFrequency: ProposalPayFrequency;
    /** The sum assured, the goal or the premium typed — whichever the product's calculation starts from. */
    amountMinor: number;
  };
  /** The premium the illustration prints — the benefit, for a `premium_benefit` product. */
  expectedMinor: number;
  /** What the app calculates for the same inputs; `null` when the table has no answer for them. */
  actualMinor: number | null;
  /** Within `PRODUCT_DATA.TEST_TOLERANCE_UNITS` rounding units. */
  match: boolean;
}

/**
 * **A gap the table leaves** (*Cek kelengkapan*; P19.15-T1 AC-1): worded on the screen, never blocking. `ages` names a
 * range of ages missing everywhere, or for one combination (`plan`, `payTerm`, `gender`, `smoker`); `combination` a plan
 * and pay term with no row at all; `smoker`, `gender`, `plan`, `payTerm`, `currency` a value with no row.
 */
export interface RateGap {
  kind: string;
  from?: number;
  to?: number;
  plan?: string | null;
  payTerm?: string | null;
  payTermLabel?: string | null;
  gender?: 'male' | 'female' | null;
  smoker?: boolean | null;
  currency?: string | null;
}

/**
 * **A premium table version of one product of one insurer** (P19.15-T1; ADR-0258; `erd.md`, *Company: premium
 * tables*). **Company-partitioned like `products`** — `companyId`, no `kpmId`: every office of the insurer reads the same
 * version, live (ADR-0033).
 *
 * - **Its state is derived, never stored** (`rate-table-status.ts`): from `activatedAt`, `turnedOffAt`, its dates and
 *   today in Asia/Jakarta, so a scheduled version is in force from 00:00 on its *Berlaku mulai* with no job (§2).
 * - **Only a draft changes.** An activated version is never edited, only replaced, turned off, or — unused — deleted.
 * - **Its rules and *Cara bayar* factors are its own** (§3): insurers change them with the rates.
 * - **Soft delete** (invariant §6).
 */
@Schema({ ...configSchemaOptions, collection: 'rateTables' })
export class RateTable {
  @Prop({ type: String, required: true })
  companyId!: string;

  @Prop({ type: String, required: true })
  productId!: string;

  /** 1, 2, 3 … per product, in upload order, never reused. */
  @Prop({ type: Number, required: true })
  version!: number;

  /** *Berlaku mulai*, `YYYY-MM-DD`: in force from 00:00 Asia/Jakarta on this day. */
  @Prop({ type: String, required: true })
  effectiveFrom!: string;

  /** *Berlaku sampai*, `YYYY-MM-DD`, the last day in force; `null` for open-ended. */
  @Prop({ type: String, default: null })
  effectiveTo!: string | null;

  @Prop({ type: Date, default: null })
  activatedAt!: Date | null;

  @Prop({ type: String, default: null })
  activatedBy!: string | null;

  @Prop({ type: Date, default: null })
  turnedOffAt!: Date | null;

  @Prop({ type: String, default: null })
  turnedOffBy!: string | null;

  /** The file it came from, or *Unggah file*'s intake item (D3). */
  @Prop({ type: Object, required: true })
  source!: { fileName: string; type: RateTableSource; assetKey: string | null; intakeItemId: string | null };

  @Prop({ type: String, required: true })
  uploadedBy!: string;

  @Prop({ type: Date, required: true })
  uploadedAt!: Date;

  /** *Cocokkan kolom*: the file's column → what it means. Suggested at upload, confirmed by a person (`mappedAt`). */
  @Prop({ type: Object, default: () => ({}) })
  columnMap!: Record<string, RateColumnRole>;

  @Prop({ type: Date, default: null })
  mappedAt!: Date | null;

  /**
   * **The file's cells, kept while the version is a draft** (`header`, `rows`, the *Ketentuan* sheet's `ketentuan`), so a
   * changed mapping is read again from the file as uploaded. Cleared on activation.
   */
  @Prop({ type: Object, default: null })
  raw!: { header: string[]; rows: string[][]; firstRow: number; ketentuan: string[][] | null } | null;

  /** How the rows state their price, decided by the columns. */
  @Prop({ type: String, enum: [...RATE_BASES, null], default: null })
  basis!: RateBasis | null;

  @Prop({ type: Number, default: 0 })
  rowCount!: number;

  /** *Cek kelengkapan*, worked out when the rows are written; never blocking (P1b). */
  @Prop({ type: [Object], default: [] })
  gaps!: RateGap[];

  /** How many gaps there were in all, `gaps` holding the first `PRODUCT_DATA.GAPS_MAX`. */
  @Prop({ type: Number, default: 0 })
  gapCount!: number;

  @Prop({ type: [Object], default: [] })
  testCases!: RateTestCase[];

  /** *"Ilustrasi pakai tarif lama"*: activates a version whose profiles do not all match. */
  @Prop({ type: String, default: null })
  overrideReason!: string | null;

  @Prop({ type: Object, required: true })
  rules!: RateRules;

  @Prop({ type: Object, required: true })
  frequencies!: FrequencyFactors;

  /**
   * Where the rules came from — the file's *Ketentuan* sheet, the version before, the catalogue, or a person — and
   * whether a person has seen them since (`rulesConfirmed`): rules read from a file are shown old → new and confirmed
   * before the version may be activated (AC-4).
   */
  @Prop({ type: String, default: 'catalogue' })
  rulesSource!: 'ketentuan' | 'previous' | 'catalogue' | 'typed' | 'intake';

  @Prop({ type: Boolean, default: true })
  rulesConfirmed!: boolean;

  /**
   * **What the table was made against** (P1b §1's *product changed in the catalog after its table was uploaded*): a
   * fingerprint of the product's plans, pay terms, smoker rating, currencies and calculation type, written at upload and
   * at activation. A product whose fingerprint has moved since is *Perlu dicek*.
   */
  @Prop({ type: String, default: null })
  productFingerprint!: string | null;

  /** The first time a proposal was calculated with it: a version used is never deleted (AC-3). */
  @Prop({ type: Date, default: null })
  firstUsedAt!: Date | null;

  /** D2's daily job (ADR-0261): the 15-day notice to Super Admins, and the KPM Owners' notice when it starts. */
  @Prop({ type: Date, default: null })
  expiryNoticeSentAt!: Date | null;

  @Prop({ type: Date, default: null })
  activationNoticeSentAt!: Date | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  deletedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RateTableSchema = SchemaFactory.createForClass(RateTable);

/** A product's versions, newest first: the version list, and what is in force today. */
RateTableSchema.index({ companyId: 1, productId: 1, deletedAt: 1, version: -1 });
/** The Proposal tab's whole company at once, and D2's daily job by date. */
RateTableSchema.index({ companyId: 1, deletedAt: 1, effectiveFrom: 1 });

/**
 * **One price of a premium table version** (P1b *Data*'s `rate_row`): the attributes that change the price — each
 * `null` for *any* — and the rate. Written from the file exactly as it says (ADR-0258 §1): never interpolated,
 * extrapolated or copied from another age, plan or product.
 */
@Schema({ ...configSchemaOptions, collection: 'rateRows' })
export class RateRow {
  @Prop({ type: String, required: true })
  rateTableId!: string;

  /** The age at the next birthday; `null` for any. */
  @Prop({ type: Number, default: null })
  age!: number | null;

  @Prop({ type: String, enum: ['male', 'female', null], default: null })
  gender!: 'male' | 'female' | null;

  @Prop({ type: Boolean, default: null })
  smoker!: boolean | null;

  /** A plan option's label; `null` for any. */
  @Prop({ type: String, default: null })
  plan!: string | null;

  /** A pay term's key; `null` for any. */
  @Prop({ type: String, default: null })
  payTerm!: string | null;

  @Prop({ type: String, required: true })
  currency!: ProductCurrency;

  /**
   * The *Cara bayar* this row prices directly; `null` for the annual premium a factor turns into the others. A table
   * that gives monthly premiums of its own offers monthly without a factor (ADR-0258 §4).
   */
  @Prop({ type: String, enum: [...PROPOSAL_PAY_FREQUENCIES, null], default: null })
  frequency!: ProposalPayFrequency | null;

  @Prop({ type: String, enum: RATE_BASES, required: true })
  basis!: RateBasis;

  /** `per_mille` and `per_band`: the rate per Rp1.000, a decimal. `per_plan`: the premium, in minor units. */
  @Prop({ type: Number, required: true })
  rate!: number;

  /** `per_band`: the sum assured the rate applies from and to, minor units, both inclusive. */
  @Prop({ type: Number, default: null })
  bandMin!: number | null;

  @Prop({ type: Number, default: null })
  bandMax!: number | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;
}

export const RateRowSchema = SchemaFactory.createForClass(RateRow);

/** The card's one lookup: the version, then each attribute a price is found by (P1b *Data*). */
RateRowSchema.index({ rateTableId: 1, age: 1, gender: 1, smoker: 1, plan: 1, payTerm: 1 });
