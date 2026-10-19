import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type NamedTemplateDocument = HydratedDocument<NamedTemplate>;

/** Where a template came from (ADR-0115 §3, §5). A record for the list and the audit, never a link. */
export const TEMPLATE_ORIGINS = ['migration', 'empty', 'defaults', 'copy', 'office', 'import'] as const;
export type TemplateOriginKind = (typeof TEMPLATE_ORIGINS)[number];

export class TemplateOrigin {
  kind!: TemplateOriginKind;
  /** The template copied (`copy`, `import`). */
  templateId?: string | null;
  /** The office whose published settings were saved (`office`). */
  kpmId?: string | null;
  /** The company the source belonged to (`import`, and an `office` of another company). */
  companyId?: string | null;
}

/**
 * **A named template**: one company's set of the seven per-office kinds (ADR-0115 §3).
 *
 * A company holds several, exactly one of them **its default** — what a KPM request's approval and
 * *Start from*'s first choice use. The kinds themselves stay in `companyTemplates`, each drafted and
 * published as before, a published version immutable; their rows hang under this one by
 * `templateId`. `campaign_kinds` is the company's and hangs under none.
 *
 * **Archived, never deleted** (invariant §3). An archived template is still read — offices record that
 * they started from it — and is no longer offered. The default is never archived.
 *
 * **Company-partitioned, not tenant-scoped**: no `kpmId`, written only by the Super Admin, the same
 * shape as `companyTemplates`, `products` and `companyOrgLevels`.
 *
 * `version` is Mongoose's concurrency counter here (`baseSchemaOptions`): a template has no published
 * versions of its own — its kinds do.
 */
@Schema({ ...baseSchemaOptions, collection: 'templates' })
export class NamedTemplate {
  @Prop({ type: String, required: true, index: true })
  companyId!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: Boolean, required: true, default: false })
  isDefault!: boolean;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: Object, required: true })
  origin!: TemplateOrigin;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** The Super Admin's user id — a platform write has no membership. `null` for the migration's. */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const NamedTemplateSchema = SchemaFactory.createForClass(NamedTemplate);

/**
 * **A name is unique among a company's active templates** (ADR-0115 §3). Archived ones are left out,
 * so a name can be used again once its template is archived. Compared case-folded: *BSD settings* and
 * *bsd settings* side by side in a picker is one name twice.
 */
NamedTemplateSchema.index(
  { companyId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active', deletedAt: null },
    collation: { locale: 'en', strength: 2 },
    name: 'companyId_1_name_1_active',
  },
);

/** **Exactly one default per company** — the index refuses a second, whatever raced. */
NamedTemplateSchema.index(
  { companyId: 1, isDefault: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true, deletedAt: null },
    name: 'companyId_1_isDefault_1_one',
  },
);
