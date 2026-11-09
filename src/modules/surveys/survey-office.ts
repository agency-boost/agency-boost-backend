import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import type { LocalDate } from '@/common/time/local-day';
import type { LabelPair } from '@/modules/config/analytics-config';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, type KpmDocument } from '@/modules/tenants/kpm.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';

/** The KPM a survey is about: its day, and the words its questions' tokens are filled with. */
export interface SurveyOfficeView {
  today: LocalDate;
  timezone: string;
  /** `{perusahaan}`: the company's name. */
  company: string;
  /** `{kpm}`: *KPM 0417 Jakarta Selatan*, the code and the branch. */
  kpm: string;
  /** The code alone, for the popup's *"KPM 0417 ingin mendengar pendapat Anda."*. */
  kpmCode: string;
}

/**
 * **`{perusahaan}` and `{kpm}` filled** (ADR-0216 §1): stored as written in the template and the snapshot, filled when
 * the form is shown, so the mockup's hard-coded *Prudential* is the KPM's own company.
 */
export function filled(text: LabelPair, office: Pick<SurveyOfficeView, 'company' | 'kpm'>): LabelPair {
  const fill = (s: string) => s.replace(/\{perusahaan\}/g, office.company).replace(/\{kpm\}/g, office.kpm);
  return { id: fill(text.id), en: fill(text.en || text.id) };
}

/**
 * **The request's KPM, as a survey needs it** — its calendar day (invariant §9: the KPM's zone, never the server's) and
 * its names. `kpms` is the tenant record and `companies` the platform's, read by `_id` from the caller's own office.
 */
@Injectable()
export class SurveyOffice {
  constructor(
    private readonly day: TenantDay,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
  ) {}

  async of(ctx: RequestContext): Promise<SurveyOfficeView> {
    if (!ctx.kpmId) throw new NoMembershipException();
    const [{ today, timezone }, kpm] = await Promise.all([
      this.day.for(ctx),
      this.kpms.findById(ctx.kpmId, { code: 1, branchName: 1, companyId: 1 }).lean().exec(),
    ]);
    const company = kpm?.companyId
      ? await this.companies.findById(kpm.companyId, { name: 1 }).lean().exec().catch(() => null)
      : null;
    const code = kpm?.code ?? '';
    return {
      today, timezone, company: company?.name ?? '', kpmCode: code,
      kpm: [`KPM ${code}`.trim(), kpm?.branchName ?? ''].filter(Boolean).join(' '),
    };
  }

  /** Today in the request's KPM. */
  async today(ctx: RequestContext): Promise<LocalDate> {
    return (await this.day.for(ctx)).today;
  }
}
