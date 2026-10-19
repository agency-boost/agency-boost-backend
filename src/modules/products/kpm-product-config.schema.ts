import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { PRODUCT_DOCUMENT_SLOTS, SCRIPT_REVIEW_STATES, type ScriptReviewState } from '@/domain/constants';

export type KpmProductConfigDocument = HydratedDocument<KpmProductConfig>;

/** One attached document. A `storageKey`, never a URL — a URL is minted per request and expires. */
@Schema({ _id: false })
export class ProductDocumentRef {
  @Prop({ type: String, required: true })
  storageKey!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  @Prop({ type: String, required: true })
  mimeType!: string;

  @Prop({ type: Number, required: true })
  bytes!: number;
}

export const ProductDocumentRefSchema = SchemaFactory.createForClass(ProductDocumentRef);

/**
 * What **this office** has decided about one of its company's products (P5-T5, ADR-0033).
 *
 * **A decision, not a copy.** The product itself is the company's and is read live, so this row
 * holds only what the office chose: whether it sells the product, which of its words it has
 * replaced, and which of the three document slots it has filled itself.
 *
 * **Absent means inherit, and that is the whole design.** `active: null` inherits the company's
 * `activeByDefault`; a key missing from `overrides` inherits the company's value. So a company
 * edit to a field this office has not overridden reaches it on the next read with nobody
 * republishing anything — and *"reset this to the company's"* is an `$unset`, not a copy of the
 * company's current value, which would freeze today's wording into the office for ever.
 */
@Schema({ ...configSchemaOptions, collection: 'kpmProductConfigs' })
export class KpmProductConfig {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** A product of this office's own company. Another company's is a 404. */
  @Prop({ type: String, required: true })
  productId!: string;

  /** `null` inherits the company's `activeByDefault` — including for a product added later. */
  @Prop({ type: Boolean, default: null })
  active!: boolean | null;

  /**
   * Only the fields this office has replaced.
   *
   * Stored as a loose map rather than named columns because *"has this been overridden?"* has to
   * be answerable per field, and a column holding `null` cannot tell "inherit" from "the office
   * deliberately blanked it". A key's presence is the answer.
   *
   * Which keys are allowed is `OVERRIDABLE_PRODUCT_FIELDS`; a write naming anything else is
   * refused **by name**, so nobody has to guess which half of their edit was dropped.
   */
  @Prop({ type: Object, default: () => ({}) })
  overrides!: Record<string, unknown>;

  /**
   * Whether the office's own override may reach its agents yet (ADR-0037).
   *
   * The office approves its **own** script — this is not an independent review, and the manual
   * says so. `none` is the state of a row with no script override at all.
   */
  @Prop({ type: String, enum: SCRIPT_REVIEW_STATES, default: 'none', index: true })
  reviewState!: ScriptReviewState;

  @Prop({ type: String, default: null })
  reviewedByMembershipId!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  /** Required on a rejection: "no" without a reason is not something anybody can act on. */
  @Prop({ type: String, default: null })
  rejectionReason!: string | null;

  /**
   * Which version of the override was approved (P5-T10 AC-2).
   *
   * Editing an approved override starts a new one and leaves the approved version readable, so
   * agents keep reading approved words while the next draft is being reviewed.
   */
  @Prop({ type: Number, default: 0 })
  approvedOverrideVersion!: number;

  /** The words agents are actually served: the approved override, frozen at approval. */
  @Prop({ type: Object, default: () => ({}) })
  approvedOverrides!: Record<string, unknown>;

  /**
   * The office's own uploads, by slot. A slot missing here inherits the company's document.
   *
   * Three named slots rather than a list, because the prototype's screen has three named rows and
   * an agent looking for the illustration is looking for *the* illustration.
   */
  @Prop({ type: Map, of: ProductDocumentRefSchema, default: () => ({}) })
  documents!: Map<string, ProductDocumentRef>;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const KpmProductConfigSchema = SchemaFactory.createForClass(KpmProductConfig);

/** One decision per product per office (P5-T5 AC-1). */
KpmProductConfigSchema.index(
  { kpmId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The review queue P5-T10 reads: this office's overrides waiting on somebody. */
KpmProductConfigSchema.index({ kpmId: 1, reviewState: 1 });

export { PRODUCT_DOCUMENT_SLOTS };
