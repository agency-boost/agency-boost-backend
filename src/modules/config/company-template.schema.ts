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
  // ADR-0034: the tabs carry **types, not occurrences**. There is no kind for an event or a
  // campaign itself, and there will not be one — a company's own are live records at company
  // level, and an office's are the office's.
  'event_types',
  'campaign_kinds',
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * Which published version of one template kind an office was built from (P5-T12, ADR-0115 §4).
 *
 * **Since Phase 13.2**, `templateId` is the **named template** the office started from (`templates`),
 * and `null` when it started from the AgencyBoost defaults or *Empty*; `version` is the version of
 * this kind it copied, and `null` when the source held none of it — an unpublished kind of a
 * template, or *Empty* — or when the source was the AgencyBoost defaults. Which of the three sources
 * it was is `kpms.startedFrom`.
 *
 * An office created **before** 13.2 is not rewritten: its `templateId` names the `companyTemplates`
 * row it copied, and its `version: null` means provisioning found nothing published and copied the
 * platform defaults. Nothing reads `templateId`; the counts read `version`.
 *
 * A record with `version: null` is a known answer, and it is different from **no record at all**,
 * which means the office was created before provisioning recorded this kind.
 *
 * **`platformSupplied: true`** (ADR-0116, 2026-10-08) marks a kind the source held none of and the office
 * was given the platform's own all the same, because it is structural: only `capability_ladder`, whose
 * stages *Leader Notes* places people on and no screen can add. `version` stays `null` — the source still
 * held none — and the field is absent, never `false`, on every other record.
 */
export interface SeedRecord {
  templateId: string | null;
  version: number | null;
  platformSupplied?: true;
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

  /**
   * The named template this row belongs to (ADR-0115 §3, `templates`). **`null` for
   * `campaign_kinds`**, which is the company's — one per company, shared by every template — and
   * applied to its live carrier rules when published (ADR-0026).
   */
  @Prop({ type: String, default: null })
  templateId!: string | null;

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

/**
 * One version of one kind per **template** (ADR-0115 §3). It was one per company, `(companyId, kind,
 * version)`, until a company could hold several; migration `0023` drops that index.
 */
CompanyTemplateSchema.index(
  { companyId: 1, templateId: 1, kind: 1, version: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The provisioning read: one template's current published version of this kind. */
CompanyTemplateSchema.index({ companyId: 1, templateId: 1, kind: 1, status: 1, version: -1 });
