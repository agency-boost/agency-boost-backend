import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { NamedTemplateService } from '@/modules/config/named-template.service';
import { TemplateCopyService } from '@/modules/config/template-copy.service';
import { can } from '@/modules/rbac/permissions';
import { COMPANY_SETUP_REFUSALS } from './company-setup.messages';
import type { CompanyStart } from './company-setup.dto';
import { Company, CompanyDocument } from './company.schema';
import { TenantService } from './tenant.service';

const SAY = COMPANY_SETUP_REFUSALS.VALIDATION_FAILED;

/** What *Perusahaan baru* answers: the company as the list reads it, and the default template it was given. */
export type SetUpCompanyView = Record<string, unknown> & { startedBlank: false; templateId: string };

/**
 * ***Perusahaan baru*** (P19.23-T4 AC-1; ADR-0278 §3): **a new company starts from a copy**, never empty — the Default
 * template (the Template library, ADR-0164), or another company. Either way it is given the source's ladder and carrier
 * rules (`TenantService.createCompany`, `copyOf`) and **a copy of the source's default template as its own default**
 * (`TemplateCopyService.importFrom`: each kind's newest published version as version 1, codes kept, training files
 * duplicated into the new company). **Never products**: an insurer's catalogue is its own, filled on *Produk & proposal*.
 * Supersedes ADR-0213 §3 (*a new company starts with no template*) for the console.
 *
 * The Super Admin's alone: `company:crud` and `company_template:write`. Audited by each write it goes through, and once
 * as `company.set_up`, naming the source.
 */
@Injectable()
export class CompanySetupService {
  constructor(
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly tenants: TenantService,
    private readonly named: NamedTemplateService,
    private readonly copies: TemplateCopyService,
    private readonly audit: AuditService,
  ) {}

  async setUp(
    ctx: RequestContext,
    input: { name: string; slug: string; from: CompanyStart; fromCompanyId?: string },
  ): Promise<SetUpCompanyView> {
    if (!can(ctx, 'company:crud')) throw new PermissionDeniedException('company:crud');
    if (!can(ctx, 'company_template:write')) throw new PermissionDeniedException('company_template:write');
    const source = await this.sourceOf(input);

    const company = await this.tenants.createCompany(ctx, {
      name: input.name, slug: input.slug, usesPlatformDefaults: true, copyOf: { companyId: source.companyId },
    });
    const companyId = String(company._id);
    const template = await this.copies.importFrom(ctx, companyId, {
      fromCompanyId: source.companyId,
      templateId: source.templateId,
      name: `${company.name} template`,
    });

    await this.audit.record(ctx, {
      action: 'company.set_up',
      targetCollection: 'companies',
      targetId: companyId,
      after: {
        name: company.name,
        from: input.from,
        source: { companyId: source.companyId, templateId: source.templateId, name: source.name },
        templateId: template.id,
      },
    });
    return { ...(company.toObject() as unknown as Record<string, unknown>), startedBlank: false, templateId: template.id };
  }

  /**
   * The company and template copied, checked before anything is written: the Template library's default for
   * `default`; for `company`, an insurer that exists (`404`), is not the Template library (`400`) and has a default
   * template (`400`).
   */
  private async sourceOf(
    input: { from: CompanyStart; fromCompanyId?: string },
  ): Promise<{ companyId: string; templateId: string; name: string }> {
    if (input.from === 'default') {
      const library = await this.named.library();
      if (!library) throw new NotFoundException('Template');
      return { companyId: library.companyId, templateId: String(library.template._id), name: 'Default template' };
    }
    const id = String(input.fromCompanyId ?? '');
    const company = Types.ObjectId.isValid(id)
      ? await this.companies.findOne({ _id: id, deletedAt: null }).exec()
      : null;
    if (!company) throw new NotFoundException('Company');
    if (company.kind === 'template') throw new InvalidRequestException(SAY.defaultIsNotACompany);
    const template = await this.named.resolve(id).catch((err: unknown) => {
      if (err instanceof NotFoundException) return null;
      throw err;
    });
    if (!template) throw new InvalidRequestException(SAY.nothingToCopy({ name: company.name }));
    return { companyId: id, templateId: String(template._id), name: company.name };
  }
}
