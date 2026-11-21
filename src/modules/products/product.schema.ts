import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { ProductDocumentRefSchema } from './kpm-product-config.schema';
import {
  PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_CURRENCIES, PRODUCT_DEFAULT_CURRENCIES, PRODUCT_KINDS,
  PRODUCT_LIFECYCLES, PRODUCT_NEEDS, PROPOSAL_CALC_TYPES, PROPOSAL_DEFAULT_INSURED, PROPOSAL_NEED_TAGS,
  type ProductCategory, type ProductChannel, type ProductCurrency, type ProductKind, type ProductLifecycle,
  type ProductNeed, type ProposalCalcType, type ProposalDefaultInsured, type ProposalNeedTag, type ProposalPayFrequency,
} from '@/domain/constants';
import type { FaqEntry, PayTerm, PdfDetailBlock, PlanOption, PlanRule, ProposalField } from './proposal-fields';

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

  /*
   * **The catalogue's calculation fields** (P19.14-T2 AC-5; ADR-0255 §4, §5; the 11 Nov spec's *Products (catalog)*):
   * checked on every save with the proposal fields (`checkProposalSettings`), so stored as plain values, the shapes in
   * `proposal-fields.ts`. Each defaults to what changes nothing: `manual`, no limits, the four periodic *Cara bayar*.
   * **No syariah flag**: `channel: 'syariah'` is it (`isSyariahProduct`). **No currency field**: `currencies` and the
   * `currency` proposal field are it (ADR-0225 §8).
   */

  /** `up_premium`, `goal`, `premium_benefit`, `plan_priced` or `manual` — which amounts the card shows. */
  @Prop({ type: String, enum: PROPOSAL_CALC_TYPES, default: 'manual' })
  calcType!: ProposalCalcType;

  /** The ages at the next birthday a client may enter at; `null` for no limit. */
  @Prop({ type: Object, default: null })
  entryAge!: { min: number; max: number } | null;

  /** Each with its `maxEntryAge`; `[]` for none. */
  @Prop({ type: [Object], default: [] })
  payTerms!: PayTerm[];

  /** *Cara bayar* offered; `[]` reads the four periodic ones. */
  @Prop({ type: [String], default: [] })
  frequencies!: ProposalPayFrequency[];

  @Prop({ type: Boolean, default: false })
  smokerRated!: boolean;

  /** How the `derived` field is worked out, or `null`. */
  @Prop({ type: Object, default: null })
  planRule!: PlanRule | null;

  /** Minor units of the item's currency, each `null` for none; read by 19.15's calculation. */
  @Prop({ type: Number, default: null })
  upStep!: number | null;

  @Prop({ type: Number, default: null })
  upMin!: number | null;

  @Prop({ type: Number, default: null })
  upMax!: number | null;

  @Prop({ type: Number, default: null })
  premiumMin!: number | null;

  @Prop({ type: Number, default: null })
  premiumMax!: number | null;

  /** The active premium table's version (19.15); `null` is `manual`. */
  @Prop({ type: String, default: null })
  rateTableId!: string | null;

  /** The need tile it ticks; `null` reads its first need's or its category's (`needTagOf`). */
  @Prop({ type: String, enum: [...PROPOSAL_NEED_TAGS, null], default: null })
  needTag!: ProposalNeedTag | null;

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

  /*
   * **A draft, and which KPMs have the product** (P19.23-T4 AC-3, AC-5; ADR-0278 §4). The fields above are the
   * **published** product, which every KPM that has it reads live (ADR-0033). What the Super Admin is still editing waits
   * in `draft`, read by no KPM, until *Terbitkan ke KPM* publishes it.
   */

  /**
   * The unpublished edits: any of the fields `PATCH …/products/:productId` takes, plus `alsoFits`, as the editor saved
   * them with *Simpan draf*. `null` when nothing waits. Checked again, whole, when it is published.
   */
  @Prop({ type: Object, default: null })
  draft!: ProductDraft | null;

  /**
   * **The KPMs that have it** (ADR-0278 §4): `null` is every KPM of the company — every product made before ADR-0278,
   * and every product the full editor makes; a list is the KPMs it was published to, `[]` a new product published to
   * none yet. A KPM created after {@link firstPublishedAt} has it too: a new KPM starts from the company as it stands.
   */
  @Prop({ type: [String], default: null })
  releasedTo!: string[] | null;

  /** When it was first published to a KPM; `null` for a new product still a draft. Absent on rows made before. */
  @Prop({ type: Date, default: null })
  firstPublishedAt!: Date | null;

  /**
   * ***Juga sesuai*** (P19.23-T4 AC-3; ADR-0278 §4): codes of this company's other products, in the order the agent's
   * Sales attack plan offers them under *Juga sesuai kebutuhan ini* — by code, never by position (invariant §4). `[]`:
   * the brief's other matches, as the plan has always chosen them.
   */
  @Prop({ type: [String], default: [] })
  alsoFits!: string[];

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

/** A product's unpublished edits (ADR-0278 §4): the write's own fields, by name, as the editor saved them. */
export type ProductDraft = Record<string, unknown>;

/**
 * **Which of a company's products one KPM has** (P19.23-T4 AC-5; ADR-0278 §4): every product with no release list (all
 * of them before ADR-0278), one published to this KPM, and one first published before this KPM was made. A new product
 * still a draft (`releasedTo: []`, never published) is in no KPM. Laid over the company filter by every KPM-side read of
 * the catalogue (`KpmProductService.productsOf`), so the rule is written once.
 */
export function heldByKpm(kpmId: string, kpmCreatedAt: Date | null | undefined): Record<string, unknown> {
  return {
    $or: [
      { releasedTo: null },
      { releasedTo: kpmId },
      ...(kpmCreatedAt ? [{ firstPublishedAt: { $ne: null, $lte: kpmCreatedAt } }] : []),
    ],
  };
}

/** The same rule for a product in hand: whether one KPM has it. */
export function isHeldBy(
  product: Pick<Product, 'releasedTo' | 'firstPublishedAt'>, kpm: { id: string; createdAt: Date | null | undefined },
): boolean {
  if (product.releasedTo === null || product.releasedTo === undefined) return true;
  if (product.releasedTo.includes(kpm.id)) return true;
  return Boolean(product.firstPublishedAt && kpm.createdAt && product.firstPublishedAt <= kpm.createdAt);
}
