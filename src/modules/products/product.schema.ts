import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { ProductDocumentRefSchema } from './kpm-product-config.schema';
import {
  PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_CURRENCIES, PRODUCT_DEFAULT_CURRENCIES, PRODUCT_KINDS,
  PRODUCT_LIFECYCLES, PRODUCT_NEEDS, PROPOSAL_DEFAULT_INSURED,
  type ProductCategory, type ProductChannel, type ProductCurrency, type ProductKind, type ProductLifecycle,
  type ProductNeed, type ProposalDefaultInsured,
} from '@/domain/constants';
import type { FaqEntry, PdfDetailBlock, PlanOption, ProposalField } from './proposal-fields';

export type ProductDocument = HydratedDocument<Product>;

/**
 * **One objection card** (P19.4-T4 AC-1, B1-1; ADR-0209 §9): what the customer says, and the reply. Plain text, each
 * with its line breaks (B1-2).
 */
@Schema({ _id: false })
export class Objection {
  @Prop({ type: String, default: '' })
  objection!: string;

  @Prop({ type: String, default: '' })
  answer!: string;
}

export const ObjectionSchema = SchemaFactory.createForClass(Objection);

/**
 * The words an agent sells a product with — the seven fields the Owner's override modal names
 * (`KPM_Owner.html:1786-1793`).
 *
 * **Named fields, not one authored paragraph.** The prototype parses the opening and the closing
 * question out of `<b>` tags, so the script's structure lives in its formatting and the first person
 * to bold a phrase mid-paragraph breaks it. Every field here is plain text.
 */
@Schema({ _id: false })
export class AttackPlan {
  @Prop({ type: String, default: '', trim: true })
  goodFit!: string;

  @Prop({ type: String, default: '', trim: true })
  opening!: string;

  @Prop({ type: [String], default: [] })
  benefits!: string[];

  @Prop({ type: String, default: '', trim: true })
  fullScript!: string;

  /**
   * *4 · If they push back*: every objection and its reply, in order (P19.4-T4 AC-1; ADR-0209 §9). It replaced the
   * one pair, `objectionTheySay` and `objectionYouSay`; migration `0054-product-objection-cards` moved each product's
   * pair here, splitting the merged *`1. "…" → …`* text into cards.
   */
  @Prop({ type: [ObjectionSchema], default: [] })
  objections!: Objection[];

  @Prop({ type: String, default: '', trim: true })
  nextAction!: string;
}

export const AttackPlanSchema = SchemaFactory.createForClass(AttackPlan);

/** One year of commission, as the **company** states it. Never defaulted (parity F-15). */
@Schema({ _id: false })
export class CommissionYear {
  @Prop({ type: Number, required: true })
  year!: number;

  /** A proportion, not a percentage: `0.4` is 40%. One representation, as the ratios use. */
  @Prop({ type: Number, required: true })
  rate!: number;
}

export const CommissionYearSchema = SchemaFactory.createForClass(CommissionYear);

/**
 * A product on a company's shelf (P5-T4, ADR-0033).
 *
 * **Company-partitioned, not tenant-scoped.** `companyId` is required and there is no `kpmId`:
 * Prudential's shelf is not Allianz's, Super Admin writes it, and an office reads only its own
 * company's rows. That is why it is exempt from the tenant index convention.
 *
 * **Read live, never copied into an office.** A withdrawal reaches every office of the company on
 * their next read, with nobody pressing publish — which is the whole reason the catalog is not part
 * of an office's snapshot. What an office owns is its decisions about products (`kpmProductConfigs`,
 * P5-T5), not the products.
 */
@Schema({ ...configSchemaOptions, collection: 'products' })
export class Product {
  @Prop({ type: String, required: true, index: true })
  companyId!: string;

  /** `PRUMAPAN`. The identity: typed once, never changed, never reused (ADR-0006). */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  /** What everyone reads. The prototype uses this as the key as well, which is the defect. */
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, default: '', trim: true })
  tagline!: string;

  @Prop({ type: String, required: true, enum: PRODUCT_CHANNELS })
  channel!: ProductChannel;

  @Prop({ type: String, required: true, enum: PRODUCT_CATEGORIES })
  category!: ProductCategory;

  /**
   * **A base or a rider** (P19.4-T4 AC-3; the riders spec's rule 1; ADR-0209 §1). A rider keeps its `category`, is
   * never offered alone, and agents meet it only inside a base it attaches to.
   */
  @Prop({ type: String, enum: PRODUCT_KINDS, default: 'base' })
  kind!: ProductKind;

  /**
   * **The base products a rider attaches to** (rule 2): ids of this company's active bases, at least one for a
   * rider, `[]` for a base. Withdrawing a base takes it out of every list here (rule 4).
   */
  @Prop({ type: [String], default: [] })
  attachesTo!: string[];

  /**
   * **The currencies its policies are sold in** (P19.4-T4 AC-12, B1-4; ADR-0209 §8): `IDR`, `USD` or both, in that
   * order. A label, not money: the product carries no amount.
   */
  @Prop({ type: [String], enum: PRODUCT_CURRENCIES, default: () => [...PRODUCT_DEFAULT_CURRENCIES] })
  currencies!: ProductCurrency[];

  /** `accident` is a need and not a category: those products sit under `health`. */
  @Prop({ type: [String], default: [], enum: PRODUCT_NEEDS })
  primaryNeeds!: ProductNeed[];

  @Prop({ type: [Number], default: [] })
  eligibleAgeBands!: number[];

  @Prop({ type: [Number], default: [] })
  eligibleBudgetBands!: number[];

  @Prop({ type: [String], default: [] })
  benefits!: string[];

  @Prop({ type: String, default: '', trim: true })
  differentiator!: string;

  @Prop({ type: String, default: '', trim: true })
  bestFor!: string;

  @Prop({ type: AttackPlanSchema, default: () => ({}) })
  defaultAttackPlan!: AttackPlan;

  /**
   * The company's own documents for this product, by slot (P5-T5).
   *
   * Company-owned assets (`companyId`, no `kpmId`), shared by reference with every office of the
   * company exactly as training material is (ADR-0032). An office that uploads its own into a slot
   * overrides this one **for itself**; removing its upload falls back here.
   */
  @Prop({ type: Map, of: ProductDocumentRefSchema, default: () => ({}) })
  defaultDocuments!: Map<string, unknown>;

  /** Empty until the company states one. The screen says so rather than inventing 40% / 20%. */
  @Prop({ type: [CommissionYearSchema], default: [] })
  commissionSchedule!: CommissionYear[];

  /*
   * **What the proposal reads from the product** (P19.7-T1 AC-2; ADR-0225 §1): the Super Admin's, in the company's
   * catalogue, checked on every save by `checkProposalSettings` (§2) — so stored as plain documents, the shapes in
   * `proposal-fields.ts`. Empty until set: a product with no fields is still offered, with *Tertanggung* and the premium.
   */

  /** The panel's fields between *Tertanggung* and the premium, in order (at most `PROPOSAL.FIELDS_MAX`). */
  @Prop({ type: [Object], default: [] })
  proposalFields!: ProposalField[];

  /** *Lihat semua plan*'s cards, cheapest first, each an option of the `plan` field. */
  @Prop({ type: [Object], default: [] })
  planOptions!: PlanOption[];

  /** *Tanya-jawab*: for the agent only, never printed. An office may replace it, held for approval (§5). */
  @Prop({ type: [Object], default: [] })
  faq!: FaqEntry[];

  /** Page 2's detail blocks, each with the illustration it was read from. */
  @Prop({ type: [Object], default: [] })
  pdfDetail!: PdfDetailBlock[];

  /** A conventional product's syariah name, where its syariah version is no product of its own (§3). */
  @Prop({ type: String, default: null })
  syariahName!: string | null;

  /** `null` reads the category's: *Anak* for education, *Klien* for the rest. */
  @Prop({ type: String, enum: [...PROPOSAL_DEFAULT_INSURED, null], default: null })
  defaultInsured!: ProposalDefaultInsured | null;

  /** The PDF's type label; `null` reads the category's (*KESEHATAN* …). */
  @Prop({ type: String, default: null })
  proposalTypeLabel!: string | null;

  /**
   * **Where the proposal fields came from, when an import wrote them** (ADR-0225 §10): `{ import, hash }`, the hash of
   * what it wrote. The import writes again only while the product's fields still hash to it — never over a Super
   * Admin's edit. `null` for fields nobody imported.
   */
  @Prop({ type: Object, default: null })
  proposalFieldsSource!: { import: string; hash: string } | null;

  @Prop({ type: String, enum: PRODUCT_LIFECYCLES, default: 'active', index: true })
  lifecycle!: ProductLifecycle;

  /** What replaced it, where a run-off product has a successor. The boolean `legacy` could not say. */
  @Prop({ type: String, default: null })
  replacedByProductId!: string | null;

  @Prop({ type: Date, default: null })
  lifecycleChangedAt!: Date | null;

  @Prop({ type: String, default: null })
  lifecycleChangedBy!: string | null;

  /** What an office sells before its Owner has an opinion about it (ADR-0033). */
  @Prop({ type: Boolean, default: false })
  activeByDefault!: boolean;

  /** Presentation only, and one number — the prototype's four copies each had their own. */
  @Prop({ type: Number, required: true })
  sortOrder!: number;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  /**
   * **A soft delete** (P19.4-T4 AC-13, B1-5; ADR-0209 §10): a withdrawn product nothing references, set by
   * `DELETE …/products/:productId`. Its code is never reused.
   */
  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  deletedBy!: string | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

/** One code per company, counting withdrawn rows: a code is never reused (P5-T4 AC-2). */
ProductSchema.index(
  { companyId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The read order. */
ProductSchema.index({ companyId: 1, sortOrder: 1 });

/** The riders of a base, read when a base is withdrawn or deleted (P19.4-T4 AC-6, AC-13). */
ProductSchema.index({ companyId: 1, attachesTo: 1 });
