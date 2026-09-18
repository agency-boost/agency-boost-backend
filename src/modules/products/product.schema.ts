import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import {
  PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_LIFECYCLES, PRODUCT_NEEDS,
  type ProductCategory, type ProductChannel, type ProductLifecycle, type ProductNeed,
} from '@/domain/constants';

export type ProductDocument = HydratedDocument<Product>;

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

  @Prop({ type: String, default: '', trim: true })
  objectionTheySay!: string;

  @Prop({ type: String, default: '', trim: true })
  objectionYouSay!: string;

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

  /** Empty until the company states one. The screen says so rather than inventing 40% / 20%. */
  @Prop({ type: [CommissionYearSchema], default: [] })
  commissionSchedule!: CommissionYear[];

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

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

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
