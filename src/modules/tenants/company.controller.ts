import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/auth/auth.decorators';
import { PublicCompanyDto } from './platform.response.dto';
import { TenantService } from './tenant.service';

/**
 * The one company route a person can reach before they have an account.
 *
 * Registration asks which insurer issued your agent code (ADR-0017), and that question
 * cannot be answered from a list nobody may read: `GET /admin/companies` is
 * `company:crud`, Super Admin only, and registration is `@Public()`.
 *
 * So this returns **an id and a name and nothing else** — not the slug, not the defaults,
 * not the counts, not `createdAt`. The set of insurers a product sells for is not a
 * secret; how many offices each has, and when they were onboarded, is nobody's business
 * until they are inside.
 */
@ApiTags('companies')
@Controller('companies')
export class CompanyController {
  constructor(private readonly tenants: TenantService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'List the insurers a person may register under',
    description: 'Public, and deliberately minimal: an id and a name per company.',
  })
  @ApiResponse({
    status: 200,
    description: 'Every live company, by name.',
    type: PublicCompanyDto,
    isArray: true,
  })
  async list() {
    return this.tenants.listCompaniesForRegistration();
  }
}
