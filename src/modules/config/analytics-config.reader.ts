import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { Kpm, KpmDocument, type KpmStartedFrom } from '@/modules/tenants/kpm.schema';
import { CompanyTemplate, CompanyTemplateDocument } from './company-template.schema';
import { NamedTemplate, NamedTemplateDocument } from './named-template.schema';
import { platformAnalyticsConfig, type AdvancedAnalyticsConfig, type UploadField } from './analytics-config';

/**
 * **The configuration a KPM reads now** (ADR-0214 §3): the template it resolves to, that template's name and published
 * version, and the payload. `templateId` and `templateName` are `null` for the platform's own configuration, which is
 * version 1 — what a KPM reads when its company has no template with a published section.
 */
export interface PublishedAnalyticsConfig {
  templateId: string | null;
  templateName: string | null;
  version: number;
  config: AdvancedAnalyticsConfig;
}

type Lean<T> = T & { _id: unknown };

/**
 * **`AnalyticsConfigReader` — every KPM's *Advanced analytics* configuration, read live** (P19.5-T1 AC-2; ADR-0214 §3).
 *
 * The one reader every KPM-side reader goes through — the month read, the Data upload file and its preview and commit
 * (P19.5-T2), the KPM's *Advanced analytics* page (T3) and the survey runs (T4). It is read per request and **never
 * written into the KPM**: a published version is live at once for every KPM on the template, existing ones included,
 * and a draft is never read.
 *
 * **The resolution**, as ADR-0210 §4 resolves the playbook:
 *
 * 1. the template the KPM was made from (`kpms.startedFrom.templateId`), when it is one of its own company's — an
 *    archived one too, whose last published version is still read;
 * 2. otherwise its company's **default** template — a KPM made from the built-in library, from *Kosong*, before
 *    templates were recorded, or moved since to another company (ADR-0191 §5);
 * 3. that template's **newest published** `advanced_analytics`, or — where it has none — the **platform's own**
 *    (`platformAnalyticsConfig`), so every KPM always has the four system columns.
 *
 * *As built:* a template with no published section answers the platform's, not the default template's: every template
 * holds a published version 1 from migration `0057` on, and every template made since is made with one, so the step is
 * a guard rather than a path a KPM takes.
 *
 * **Company-partitioned**: the company and the template are the KPM's own, from its row — never a company or a template
 * a caller names — and every read filters by that company's id.
 */
@Injectable()
export class AnalyticsConfigReader {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(NamedTemplate.name) private readonly named: Model<NamedTemplateDocument>,
    @InjectModel(CompanyTemplate.name) private readonly sections: Model<CompanyTemplateDocument>,
  ) {}

  /** **The configuration the request's KPM reads now.** A request with no KPM is a defect, never a guess. */
  async publishedFor(ctx: RequestContext): Promise<PublishedAnalyticsConfig> {
    if (!ctx.kpmId) throw new MissingTenantContextError('companyTemplates', 'AnalyticsConfigReader.publishedFor');
    return this.forOffice(ctx.kpmId);
  }

  /** The configuration the KPM `kpmId` reads now: the platform's for a KPM that cannot be found. */
  async forOffice(kpmId: string): Promise<PublishedAnalyticsConfig> {
    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null }, { companyId: 1, startedFrom: 1 })
      .lean().exec()
      .catch(() => null) as { companyId?: string; startedFrom?: KpmStartedFrom | null } | null;
    const template = kpm?.companyId ? await this.templateOf(kpm.companyId, kpm.startedFrom ?? null) : null;
    if (!template) return platform();
    return (await this.publishedOf(kpm!.companyId!, template.id, template.name)) ?? platform();
  }

  /**
   * **Every version the KPM's template has published, oldest first, its columns only** (P19.5-T2 AC-11; AA UI-025;
   * ADR-0214 §12): what *"Di luar batas sejak v<n>"* names — the version since which a stored value has sat outside its
   * column's limits. The platform's own configuration is version 1 alone.
   */
  async uploadFieldsHistoryFor(ctx: RequestContext): Promise<{ version: number; uploadFields: UploadField[] }[]> {
    if (!ctx.kpmId) throw new MissingTenantContextError('companyTemplates', 'AnalyticsConfigReader.uploadFieldsHistoryFor');
    const kpm = await this.kpms
      .findOne({ _id: ctx.kpmId, deletedAt: null }, { companyId: 1, startedFrom: 1 })
      .lean().exec()
      .catch(() => null) as { companyId?: string; startedFrom?: KpmStartedFrom | null } | null;
    const template = kpm?.companyId ? await this.templateOf(kpm.companyId, kpm.startedFrom ?? null) : null;
    const rows = template
      ? await this.sections
        .find(
          { companyId: kpm!.companyId, templateId: template.id, kind: 'advanced_analytics', status: 'published', deletedAt: null },
          { version: 1, 'payload.uploadFields': 1 },
        )
        .sort({ version: 1 })
        .lean().exec()
      : [];
    if (rows.length === 0) return [{ version: 1, uploadFields: platformAnalyticsConfig().uploadFields }];
    return rows.map((row) => ({
      version: row.version,
      uploadFields: ((row.payload as unknown as { uploadFields?: UploadField[] })?.uploadFields ?? []),
    }));
  }

  /**
   * **The template a KPM of `companyId` reads from** (step 1 and 2): the one it was made from when that is one of the
   * company's own, else the company's default; `null` for a company with no template at all.
   */
  async templateOf(companyId: string, startedFrom: KpmStartedFrom | null): Promise<{ id: string; name: string } | null> {
    const own = ownTemplateId(companyId, startedFrom);
    const mine = own
      ? await this.named.findOne({ _id: own, companyId, deletedAt: null }, { _id: 1, name: 1 }).lean().exec().catch(() => null)
      : null;
    const template = mine ?? await this.named
      .findOne({ companyId, isDefault: true, deletedAt: null }, { _id: 1, name: 1 })
      .lean().exec();
    return template ? { id: String(template._id), name: String(template.name) } : null;
  }

  /** One template's newest published section, filtered by its company; `null` where it has published none. */
  async publishedOf(companyId: string, templateId: string, templateName: string): Promise<PublishedAnalyticsConfig | null> {
    const row = await this.sections
      .findOne({ companyId, templateId, kind: 'advanced_analytics', status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .lean().exec();
    if (!row) return null;
    return { templateId, templateName, version: row.version, config: row.payload as unknown as AdvancedAnalyticsConfig };
  }

  /**
   * **The live KPMs whose resolution lands on one template** (ADR-0214 §4, §7): who a publish reaches, whose Owner and
   * Admins are told, and whose registered codes the pattern is tested over. The KPMs' own rows, by company — `kpms`
   * is the platform's register of offices, not a tenant's data.
   */
  async officesReading(companyId: string, templateId: string): Promise<string[]> {
    const [offices, templates] = await Promise.all([
      this.kpms.find({ companyId, deletedAt: null }, { startedFrom: 1 }).lean().exec() as Promise<
        Lean<{ startedFrom?: KpmStartedFrom | null }>[]>,
      this.named.find({ companyId, deletedAt: null }, { _id: 1, isDefault: 1 }).lean().exec() as Promise<
        Lean<{ isDefault?: boolean }>[]>,
    ]);
    const ids = new Set(templates.map((t) => String(t._id)));
    const byDefault = templates.find((t) => t.isDefault);
    const fallback = byDefault ? String(byDefault._id) : null;
    return offices
      .filter((office) => {
        const own = ownTemplateId(companyId, office.startedFrom ?? null);
        const reads = own && ids.has(own) ? own : fallback;
        return reads === templateId;
      })
      .map((office) => String(office._id));
  }
}

/** The template a KPM was made from, when its record names one of `companyId`'s own. */
function ownTemplateId(companyId: string, startedFrom: KpmStartedFrom | null): string | null {
  return startedFrom?.source === 'template' && startedFrom.templateId
    && (!startedFrom.companyId || startedFrom.companyId === companyId)
    ? String(startedFrom.templateId)
    : null;
}

function platform(): PublishedAnalyticsConfig {
  return { templateId: null, templateName: null, version: 1, config: platformAnalyticsConfig() };
}
