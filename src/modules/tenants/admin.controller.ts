import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { ImpersonateDto } from '@/modules/auth/auth.dto';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import { Company, CompanyDocument } from './company.schema';
import { AssignOwnerDto, CreateCompanyDto, CreateKpmDto, SetStatusDto } from './tenant.dto';
import { TenantService } from './tenant.service';

/**
 * The Super Admin console. Tenant management only — no billing, no tenant business
 * data (ADR-0005).
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly tenants: TenantService,
    private readonly impersonation: ImpersonationService,
    private readonly audit: AuditService,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
  ) {}

  @Get('companies')
  @RequirePermission('company:crud')
  @ApiOperation({ summary: 'List principal insurers' })
  async listCompanies() {
    return this.companies.find({ deletedAt: null }).sort({ name: 1 }).exec();
  }

  @Post('companies')
  @RequirePermission('company:crud')
  @ApiOperation({ summary: 'Create a principal insurer' })
  async createCompany(@Body() dto: CreateCompanyDto) {
    return this.companies.create({ ...dto });
  }

  @Get('tenants')
  @RequirePermission('kpm:list_all')
  @ApiOperation({ summary: 'List every KPM on the platform' })
  async listTenants(@Ctx() ctx: RequestContext) {
    return this.tenants.listAll(ctx);
  }

  @Post('tenants')
  @RequirePermission('kpm:create')
  @ApiOperation({
    summary: 'Create a KPM',
    description:
      'The only way an office comes into existence — there is no self-service path ' +
      '(ADR-0005). Seeds the per-office settings every prototype screen hardcodes.',
  })
  async createTenant(@Ctx() ctx: RequestContext, @Body() dto: CreateKpmDto) {
    return this.tenants.createKpm(ctx, dto);
  }

  @Get('tenants/:id')
  @RequirePermission('kpm:read_profile')
  @ApiOperation({ summary: 'Read one KPM' })
  async readTenant(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tenants.readProfile(ctx, id);
  }

  @Patch('tenants/:id/owner')
  @RequirePermission('kpm:assign_owner')
  @ApiOperation({
    summary: 'Assign or transfer the KPM Owner',
    description: 'Audited with both the outgoing and incoming user.',
  })
  async assignOwner(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: AssignOwnerDto,
  ) {
    return this.tenants.assignOwner(ctx, id, dto.userId);
  }

  @Patch('tenants/:id/status')
  @RequirePermission('kpm:suspend')
  @ApiOperation({
    summary: 'Suspend, reactivate or archive a KPM',
    description:
      'A suspended office refuses its members with TENANT_SUSPENDED, distinct from a ' +
      'permission failure so the UI can explain it.',
  })
  async setStatus(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
  ) {
    return this.tenants.setStatus(ctx, id, dto.status, dto.reason);
  }

  @Get('audit')
  @RequirePermission('audit_log:read')
  @ApiOperation({ summary: 'Read the audit log for a tenant' })
  async readAudit(@Ctx() ctx: RequestContext) {
    return this.audit.findForTenant(ctx.kpmId ?? '', 100);
  }

  @Post('impersonate/:userId')
  @RequirePermission('impersonation:start')
  @ApiOperation({
    summary: 'Start a support impersonation session',
    description:
      'Time-boxed to an hour, reason required, and every action it produces records ' +
      'both the real Super Admin and the person acted as. Refused for another Super ' +
      'Admin — that would erase the attribution the feature depends on.',
  })
  async impersonate(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body() dto: ImpersonateDto,
  ) {
    return this.impersonation.start(ctx, userId, dto.reason, dto.durationMinutes);
  }

  @Post('impersonate/end')
  @ApiOperation({ summary: 'End the current impersonation session' })
  async endImpersonation(@Ctx() ctx: RequestContext) {
    await this.impersonation.end(ctx);
    return { status: 'ended' };
  }
}
