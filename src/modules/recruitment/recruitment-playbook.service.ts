import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { RecruitmentPlaybookBody } from '@/domain/constants';
import { CompanyTemplate, CompanyTemplateDocument } from '@/modules/config/company-template.schema';
import { NamedTemplate, NamedTemplateDocument } from '@/modules/config/named-template.schema';
import { Kpm, KpmDocument, type KpmStartedFrom } from '@/modules/tenants/kpm.schema';

/** The playbook a KPM reads: the words, and the template version they are, for the record. */
export interface OfficePlaybook {
  body: RecruitmentPlaybookBody;
  templateId: string;
  version: number;
}

/**
 * **Which recruitment playbook a KPM reads, live** (ADR-0210 §4, amending ADR-0125; P19.4-T5 AC-8).
 *
 * The playbook is a **template section** (`companyTemplates`, kind `recruitment_playbook`), and every KPM reads **the
 * published version of the template it was made from** — `kpms.startedFrom.templateId`, when that template is its own
 * company's — and otherwise its company's **default** template's: a KPM made from a built-in template of the library,
 * from *Kosong*, before templates were recorded, or moved since to another company (ADR-0191 §5). A draft is never read;
 * an archived template's last published version still is. A template with no published playbook answers `null`, which
 * is ADR-0125's empty state.
 *
 * **Company-partitioned, as it always was** (ADR-0125 §1, ADR-0033): the company and the template are the reader's own
 * KPM's, from its row — **never** a company or a template a caller names — and every read filters by that company's
 * id, so a KPM never reads another company's playbook. These are **the named reads** (`forOffice`, `publishedOf`); the
 * company-level `recruitmentPlaybooks` records the playbook lived in until migration `0056` are read by nothing.
 *
 * Nothing here writes. The Super Admin writes the section through the template's kind routes (`TemplateService`).
 */
@Injectable()
export class RecruitmentPlaybookService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(NamedTemplate.name) private readonly templates: Model<NamedTemplateDocument>,
    @InjectModel(CompanyTemplate.name) private readonly sections: Model<CompanyTemplateDocument>,
  ) {}

  /** The playbook the KPM `kpmId` reads now, or `null` — no KPM, no template, or nothing published. */
  async forOffice(kpmId: string): Promise<OfficePlaybook | null> {
    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null }, { companyId: 1, startedFrom: 1 })
      .lean().exec()
      .catch(() => null) as { companyId?: string; startedFrom?: KpmStartedFrom | null } | null;
    if (!kpm?.companyId) return null;
    const templateId = await this.templateOf(kpm.companyId, kpm.startedFrom ?? null);
    return templateId ? this.publishedOf(kpm.companyId, templateId) : null;
  }

  /**
   * **The template a KPM of `companyId` reads its playbook from** (ADR-0210 §4): the one it was made from when that is
   * one of the company's own, else the company's default; `null` for a company with no template at all.
   */
  async templateOf(companyId: string, startedFrom: KpmStartedFrom | null): Promise<string | null> {
    const own = startedFrom?.source === 'template' && startedFrom.templateId
      && (!startedFrom.companyId || startedFrom.companyId === companyId)
      ? await this.templates
        .findOne({ _id: startedFrom.templateId, companyId, deletedAt: null }, { _id: 1 })
        .lean().exec().catch(() => null)
      : null;
    const template = own ?? await this.templates
      .findOne({ companyId, isDefault: true, deletedAt: null }, { _id: 1 })
      .lean().exec();
    return template ? String(template._id) : null;
  }

  /** **One template's published playbook**, filtered by its company: the newest published version, or `null`. */
  async publishedOf(companyId: string, templateId: string): Promise<OfficePlaybook | null> {
    const row = await this.sections
      .findOne({ companyId, templateId, kind: 'recruitment_playbook', status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .lean().exec();
    if (!row) return null;
    return { body: row.payload as unknown as RecruitmentPlaybookBody, templateId, version: row.version };
  }
}
