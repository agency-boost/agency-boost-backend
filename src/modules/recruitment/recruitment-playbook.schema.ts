import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import type { RecruitmentPlaybookBody } from '@/domain/constants';

export type RecruitmentPlaybookDocument = HydratedDocument<RecruitmentPlaybook>;

/**
 * **A company's recruitment playbook, as it was until P19.4-T5** (OD-88 → option 5, ADR-0125; D-model). *Since ADR-0210
 * the playbook is a template section (`companyTemplates`, kind `recruitment_playbook`), read live by each KPM from its
 * template; migration `0056` moved every record there and marked it `migratedTo`. Nothing reads or writes this
 * collection since, but migration `0025`'s backfill and the history below.*
 *
 * It was the words every office of the company read live when one of its members built a recruitment plan.
 *
 * **Company-partitioned, as `products` is** (ADR-0033): one row per company, no `kpmId`, read through the
 * named company-filtered method `RecruitmentPlaybookService.ofCompany` — never through an office's scoped
 * repository, and never by an office's write. The Super Admin writes it, whole, on the Company template's
 * *Recruitment* tab; each save moves `version` and is audited with what it replaced.
 *
 * **`body` is the whole playbook as one document** (`RecruitmentPlaybookBody`), validated whole before
 * every write (`recruitment-playbook-input.ts`) — every profile and every hesitation answered, an opening
 * for every motivation — so a reader never meets half of one. `minimize: false` keeps an empty
 * `profileObjections` as `{}` rather than dropping it on save.
 *
 * Never hard-deleted (invariant §3, §6).
 */
@Schema({ ...configSchemaOptions, collection: 'recruitmentPlaybooks', minimize: false })
export class RecruitmentPlaybook {
  /** The insurer whose words these are. One live row per company (the index below). */
  @Prop({ type: String, required: true })
  companyId!: string;

  @Prop({ type: Object, required: true })
  body!: RecruitmentPlaybookBody;

  /** Moves by one on every save; a save names the version it was made against (T8 AC-2). */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  /**
   * The **user** who saved it last — a Super Admin, who is a member of no office, so there is no
   * membership to name (as `products.updatedBy`). `null` for the words a company was given at creation
   * or by migration `0025`.
   */
  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  /**
   * **Where migration `0056` moved it** (ADR-0210 §5): the company's default template and the version it became there,
   * or `null` — not moved. Since P19.4-T5 the playbook is a template section and this record is **read by nothing**; it
   * stays as its history, never hard-deleted (invariant §6).
   */
  @Prop({ type: Object, default: null })
  migratedTo!: { templateId: string; version: number } | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const RecruitmentPlaybookSchema = SchemaFactory.createForClass(RecruitmentPlaybook);

/** One live playbook per company (D-model): a second is refused by the database, not only by the service. */
RecruitmentPlaybookSchema.index(
  { companyId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
