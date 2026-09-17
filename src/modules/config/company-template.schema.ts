import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type CompanyTemplateDocument = HydratedDocument<CompanyTemplate>;

/** What a template can be a template of. Grows as Phase 5 lands its catalogs. */
export const TEMPLATE_KINDS = [
  'activity_taxonomy',
  'lead_pipeline',
  'ratio_set',
  'activation_checklist',
  'training_taxonomy',
  'capability_ladder',
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * Which published version of one template kind an office was built from (P5-T12).
 *
 * `version: null` means provisioning looked, found nothing of this kind published for the
 * company, and copied the platform defaults. That is a known answer — the office is on
 * something the company never chose — and it is different from **no record at all**, which
 * means the office was created before provisioning recorded this kind.
 */
export interface SeedRecord {
  templateId: string | null;
  version: number | null;
}

/**
 * The preset every new office of one company starts from (ADR-0018).
 *
 * Called the **Company template** since ADR-0023. The frozen prototype says *KPM template*
 * and the quotations below keep its words; the product does not, because the template is
 * a company's and "KPM" names only the shape of the thing it is copied into.
 *
 * **`companyId` is required, and that is the decision.** The ERD carried
 * `companyId | null` since Phase 0 with no document explaining what a template belonging
 * to nobody would mean. It means nothing: Prudential's activation checklist is not
 * Allianz's, the prototype says so twice (`Superadmin.html:304`, and its *KPM template*
 * item sitting in the Companies nav group at `:179`), and ADR-0012 already decided the
 * same thing for the company's role ladder.
 *
 * **Copy-on-provision, not reference.** An office is seeded from its company's published
 * template once and then owns its copy. Publishing a new version does not reach back into
 * offices already created — an office that has diverged keeps its divergence, which is
 * the whole point of Phase 4.
 *
 * Company-partitioned rather than tenant-scoped: no `kpmId`, written only by Super Admin,
 * read by the offices of its own company. `products` and `companyOrgLevels` are the same
 * shape.
 */
@Schema({ ...configSchemaOptions, collection: 'companyTemplates' })
export class CompanyTemplate {
  @Prop({ type: String, required: true, index: true })
  companyId!: string;

  @Prop({ type: String, required: true, enum: TEMPLATE_KINDS, index: true })
  kind!: TemplateKind;

  /**
   * Monotonic per `(company, kind)`. **Immutable once published** — an office records the
   * version it was seeded from, and a version whose content could change afterwards would
   * make that record a lie.
   */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true })
  status!: 'draft' | 'published' | 'archived';

  /** The shape depends on `kind`; the seeding code for that kind is what reads it. */
  @Prop({ type: Object, required: true, default: {} })
  payload!: Record<string, unknown>;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const CompanyTemplateSchema = SchemaFactory.createForClass(CompanyTemplate);

/** One version of one kind per company. */
CompanyTemplateSchema.index(
  { companyId: 1, kind: 1, version: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The provisioning read: this company's current published template of this kind. */
CompanyTemplateSchema.index({ companyId: 1, kind: 1, status: 1, version: -1 });
