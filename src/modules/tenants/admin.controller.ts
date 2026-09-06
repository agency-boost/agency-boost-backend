import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { ImpersonateDto } from '@/modules/auth/auth.dto';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import { Company, CompanyDocument } from './company.schema';
import {
  ApproveKpmRequestDto,
  AssignOwnerDto,
  AuditQueryDto,
  CreateCompanyDto,
  CreateKpmDto,
  DeclineKpmRequestDto,
  SetStatusDto,
} from './tenant.dto';
import { KpmRequestService } from './kpm-request.service';
import { TenantService } from './tenant.service';

/**
 * The Super Admin console.
 *
 * Tenant management, plus the aggregate composition counts the overview needs. No
 * billing, and no office's leads, activity, coaching notes or production — ADR-0011
 * retook ADR-0005's wider claim once the prototype turned up with headcounts on its
 * front page.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly tenants: TenantService,
    private readonly kpmRequestService: KpmRequestService,
    private readonly impersonation: ImpersonationService,
    private readonly audit: AuditService,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
  ) {}

  @Get('overview')
  @RequirePermission('platform_metrics:read')
  @ApiOperation({
    summary: 'The platform overview',
    description:
      'The queue of what needs the platform\u2019s own hand, the four headline counts, and every ' +
      'company with its KPM and member totals. Aggregate composition only \u2014 no office\u2019s ' +
      'leads, activity, coaching notes or production (ADR-0011).',
  })
  async overview(@Ctx() ctx: RequestContext) {
    return this.tenants.platformOverview(ctx);
  }

  @Get('kpm-requests')
  @RequirePermission('kpm_request:read')
  @ApiOperation({
    summary: 'The KPM registration queue',
    description:
      'Offices somebody has asked for and nobody has decided yet, pending first. The requester is ' +
      'the proposed Owner \u2014 the prototype writes them as one person with one intent.',
  })
  async kpmRequests(@Ctx() ctx: RequestContext) {
    return this.kpmRequestService.queue(ctx);
  }

  @Post('kpm-requests/:requestId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('kpm_request:decide')
  @ApiOperation({
    summary: 'Approve a KPM registration',
    description:
      'Creates the office and hands it to the person who asked, in one audited operation. The code ' +
      'is supplied here because it must be unique within the company and a requester cannot know ' +
      'what is free.',
  })
  async approveKpmRequest(
    @Ctx() ctx: RequestContext,
    @Param('requestId') requestId: string,
    @Body() dto: ApproveKpmRequestDto,
  ) {
    return this.kpmRequestService.approve(ctx, requestId, dto);
  }

  @Post('kpm-requests/:requestId/decline')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('kpm_request:decide')
  @ApiOperation({
    summary: 'Decline a KPM registration',
    description: 'Creates nothing. The reason is kept and is the only thing the asker can act on.',
  })
  async declineKpmRequest(
    @Ctx() ctx: RequestContext,
    @Param('requestId') requestId: string,
    @Body() dto: DeclineKpmRequestDto,
  ) {
    return this.kpmRequestService.decline(ctx, requestId, dto);
  }

  @Get('companies')
  @RequirePermission('company:crud')
  @ApiOperation({ summary: 'List principal insurers' })
  async listCompanies() {
    return this.companies.find({ deletedAt: null }).sort({ name: 1 }).exec();
  }

  @Post('companies')
  @RequirePermission('company:crud')
  @ApiOperation({
    summary: 'Create a principal insurer',
    description:
      'Audited: an insurer is the parent every office inherits its currency, locale ' +
      'and time zone from, so its creation is a platform-level change worth recording.',
  })
  async createCompany(@Ctx() ctx: RequestContext, @Body() dto: CreateCompanyDto) {
    const company = await this.companies.create({ ...dto });
    await this.audit.record(ctx, {
      action: 'company.created',
      targetCollection: 'companies',
      targetId: String(company._id),
      after: { name: company.name, slug: company.slug },
    });
    return company;
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
    description:
      'Name the person by email or by user id. The account must already exist — this ' +
      'promotes an existing platform user; inviting a new one arrives with invitations ' +
      'in Phase 3. Audited with both the outgoing and incoming user.',
  })
  async assignOwner(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: AssignOwnerDto,
  ) {
    return this.tenants.assignOwner(ctx, id, dto);
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
  @ApiOperation({
    summary: 'Read the audit log',
    description:
      'Defaults to the caller\'s own tenant. A Super Admin has no tenant, so their ' +
      'default is the platform-level log — provisioning, company creation, ' +
      'impersonation — and `kpmId` narrows it to one office. Anyone else is pinned to ' +
      'their own office whatever they pass.',
  })
  async readAudit(@Ctx() ctx: RequestContext, @Query() query: AuditQueryDto) {
    const scope = ctx.isSuperAdmin ? (query.kpmId ?? null) : ctx.kpmId;
    return this.audit.findForTenant(scope, 100);
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
