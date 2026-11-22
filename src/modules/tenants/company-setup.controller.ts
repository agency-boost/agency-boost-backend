import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { SetUpCompanyDto } from './company-setup.dto';
import { CompanySetupService } from './company-setup.service';

/**
 * ***Perusahaan baru*** (P19.23-T4 AC-1; ADR-0278 §3): a company made from the Default template or a copy of another
 * company, with its default template, in one write. `POST /admin/companies` stays, for callers that make a company with
 * no template (ADR-0213 §3).
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/companies/setup')
export class CompanySetupController {
  constructor(private readonly setup: CompanySetupService) {}

  @Post()
  @RequirePermission('company:crud')
  @ApiOperation({
    summary: 'Create a company from the Default template or a copy of another company',
    description:
      '`from: default` copies the Default template (the Template library): its ladder with the leader tiers, its carrier '
      + 'rules and its default template, which becomes the new company’s default. `from: company` copies '
      + '`fromCompanyId` the same way. **Never products**: the catalogue is filled on *Produk & proposal*. Answers the '
      + 'company and `templateId`, its default template. Audited `company.created`, `template.created` and '
      + '`company.set_up`. 409 COMPANY_SLUG_TAKEN naming the company that holds the slug; 400 for the Default template '
      + 'named as a company, or a company with no template to copy; 404 for a company that does not exist.',
  })
  @ApiResponse({ status: 201, description: 'The company, with `templateId`.' })
  @ApiResponse({ status: 400, type: ApiErrorEnvelope, description: '`VALIDATION_FAILED` — nothing to copy.' })
  async create(@Ctx() ctx: RequestContext, @Body() dto: SetUpCompanyDto) {
    return this.setup.setUp(ctx, dto);
  }
}
