import {
  BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AllowWhileOfficeUnavailable, AllowWhileReadOnly, Ctx, RequirePermission,
} from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { AuditReadService } from '@/modules/audit/audit-read.service';
import { ElevateImpersonationDto, ImpersonateDto } from '@/modules/auth/auth.dto';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import {
  ApproveKpmRequestDto,
  AssignOwnerDto,
  AuditQueryDto,
  CreateCompanyDto,
  SetCompanyStatusDto,
  UpdateCompanyDto,
  CreateKpmDto,
  CreateOrgLevelDto,
  DeclineKpmRequestDto,
  RosterRowsDto,
  SetStatusDto,
  UpdateOrgLevelDto,
  UpdateSubscriptionDto,
} from './tenant.dto';
import { KpmRequestService } from './kpm-request.service';
import { OrgLevelService } from './org-level.service';
import { RosterImportService } from './roster-import.service';
import {
  ROSTER_COLUMNS,
  ROSTER_EXAMPLES,
  ROSTER_TEMPLATE,
  ROSTER_TEMPLATE_HEADER,
} from './roster-csv';
import { TenantService } from './tenant.service';
import { TemplateService } from '@/modules/config/template.service';
import { SaveTemplateDraftDto } from '@/modules/config/template.dto';
import { TemplateQueryDto } from '@/modules/config/named-template.dto';
import { TEMPLATE_KINDS, type TemplateKind } from '@/modules/config/company-template.schema';

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
    private readonly orgLevels: OrgLevelService,
    private readonly impersonation: ImpersonationService,
    private readonly auditRead: AuditReadService,
    private readonly roster: RosterImportService,
    private readonly templates: TemplateService,
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

  @Get('tenant-admins')
  @RequirePermission('kpm_admin:list_platform')
  @ApiOperation({
    summary: 'Everybody who administers an office',
    description:
      'Every KPM Owner and delegated KPM Admin, across every office, grouped by office. Read-only: ' +
      'granting and revoking stay inside the office, where the Owner does them.',
  })
  async tenantAdmins(@Ctx() ctx: RequestContext) {
    return this.tenants.platformAdmins(ctx);
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
  @ApiOperation({ summary: 'List every company' })
  async listCompanies(@Ctx() ctx: RequestContext) {
    return this.tenants.listCompanies(ctx);
  }

  @Post('companies')
  @RequirePermission('company:crud')
  @ApiOperation({
    summary: 'Create a company',
    description:
      'Audited: a company is the parent every office inherits its currency, locale ' +
      'and time zone from, so its creation is a platform-level change worth recording. ' +
      'A slug already in use is refused with COMPANY_SLUG_TAKEN, naming the company ' +
      'that holds it.',
  })
  async createCompany(@Ctx() ctx: RequestContext, @Body() dto: CreateCompanyDto) {
    return this.tenants.createCompany(ctx, dto);
  }

  @Patch('companies/:companyId')
  @RequirePermission('company:crud')
  @ApiOperation({
    summary: 'Rename a company, or change its slug',
    description:
      'Both are labels: every office points at its company by id and nothing stores the '
      + 'slug, so changing one moves no reference. A slug already in use is refused with '
      + 'COMPANY_SLUG_TAKEN, naming the company that holds it. Audited.',
  })
  async updateCompany(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.tenants.updateCompany(ctx, companyId, dto);
  }

  @Patch('companies/:companyId/status')
  @RequirePermission('company:crud')
  @ApiOperation({
    summary: 'Suspend a company, or bring it back',
    description:
      'A suspended company disappears from the list somebody registering chooses from, so '
      + 'no new person and no new office attaches to it. It does **not** sign anybody out '
      + 'or suspend its offices — that is each office\'s own lifecycle. Nothing is deleted.',
  })
  async setCompanyStatus(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() dto: SetCompanyStatusDto,
  ) {
    return this.tenants.setCompanyStatus(ctx, companyId, dto.status);
  }

  @Get('org-levels')
  /*
   * `org_level:crud`, not `org_level:read`. P4-T9 widened the read to every member so that
   * badges could be drawn from the company's own ladder — and silently widened this route
   * with it, which returns *every* company's ladder with no filter. An agent reached
   * nineteen insurers' promotion structures with an ordinary token. Members read their own
   * company's ladder at `GET /kpm/org-levels`, which narrows by the caller's office.
   */
  @RequirePermission('org_level:crud')
  @ApiOperation({
    summary: 'The role ladders companies define',
    description:
      'Every rung of every company\u2019s ladder, junior first \u2014 archived ones included, ' +
      'because a screen that hid them would show a ladder that does not explain the ' +
      'people standing on it. Narrow with ?companyId.',
  })
  async listOrgLevels(@Ctx() ctx: RequestContext, @Query('companyId') companyId?: string) {
    return this.orgLevels.list(ctx, companyId);
  }

  @Post('org-levels')
  @RequirePermission('org_level:crud')
  @ApiOperation({
    summary: 'Add a rung to a company\u2019s ladder',
    description:
      'The ladder belongs to the company, not to any office (ADR-0012): a KPM cannot add, ' +
      'rename or remove a rung. `code` is stable and semantic and is never reused \u2014 not ' +
      'even after archiving \u2014 because it is what every membership holds.',
  })
  async createOrgLevel(@Ctx() ctx: RequestContext, @Body() dto: CreateOrgLevelDto) {
    return this.orgLevels.create(ctx, dto);
  }

  @Patch('org-levels/:id')
  @RequirePermission('org_level:crud')
  @ApiOperation({
    summary: 'Rename, reorder or archive a rung',
    description:
      'The code is not updatable, by construction \u2014 it is absent from the body. ' +
      'Archiving retires a rung and keeps every membership that references it readable.',
  })
  async updateOrgLevel(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: UpdateOrgLevelDto,
  ) {
    return this.orgLevels.update(ctx, id, dto);
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
      '(ADR-0005). Seeds the per-office settings every prototype screen hardcodes, and its ' +
      'configuration from `startFrom` (ADR-0115): one of the company\'s active templates, the ' +
      'AgencyBoost defaults, or empty — the company\'s default template when absent. There is no ' +
      'fallback: a kind the source holds none of is empty in the office, and every office has the ' +
      'three cascade activity types. The whole source is checked before the office is written, so ' +
      'a refusal (400, naming what is broken; 404 for a template that is not the company\'s) leaves ' +
      'nothing behind.',
  })
  async createTenant(@Ctx() ctx: RequestContext, @Body() dto: CreateKpmDto) {
    return this.tenants.createKpm(ctx, dto);
  }

  // ---- Filling a new office from a spreadsheet (P3.6-T4). ----

  @Get('tenants/roster-template')
  @RequirePermission('kpm:import_roster')
  @ApiOperation({
    summary: 'The roster template',
    description:
      'The file to download: the header, plus worked examples **commented out**, so they '
      + 'can be read and copied without ever importing. `examples` carries the same three '
      + 'rows as cells, which is what the paste box shows — a screen splitting the CSV '
      + 'itself would be a second parser, disagreeing with this one over the quoted row. '
      + 'Declared above the routes that take an `:id`, because Nest would otherwise read '
      + '"roster-template" as one.',
  })
  async rosterTemplate() {
    return {
      header: ROSTER_TEMPLATE_HEADER,
      columns: ROSTER_COLUMNS,
      template: ROSTER_TEMPLATE,
      examples: ROSTER_EXAMPLES,
    };
  }

  // ---- A company's KPM template (P4-T8, ADR-0018). Above `tenants/:id` for the same
  // reason `roster-template` is: a literal segment must be declared before a parameter
  // that would swallow it.

  @Get('companies/:companyId/template/:kind')
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'A company\'s template of one kind',
    description:
      'One kind of one of the company\'s named templates — `?templateId=`, or the company\'s '
      + 'default when absent (404 for a template that is not the company\'s). The draft if there is '
      + 'one, else the newest published, else nothing: version 0 and an empty payload, which is what '
      + 'an office made from the template would get of the kind. `campaign_kinds` is the company\'s '
      + 'own, shared by every template, and ignores `templateId`. `officesBehind` says how many of '
      + 'the template\'s offices are on something older, which is the count the Superadmin prototype '
      + 'puts on its front page.',
  })
  async readTemplate(
    @Param('companyId') companyId: string,
    @Param('kind') kind: string,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templates.read(companyId, this.kindOf(kind), query.templateId);
  }

  @Get('companies/:companyId/template/:kind/history')
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'Every version of one template',
    description:
      'Newest first, for one kind of the template `?templateId=` names (the default when absent). A '
      + 'published version is immutable; this is the record of them.',
  })
  async templateHistory(
    @Param('companyId') companyId: string,
    @Param('kind') kind: string,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templates.history(companyId, this.kindOf(kind), query.templateId);
  }

  @Put('companies/:companyId/template/:kind')
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Save the working copy',
    description:
      'The whole payload, not a patch: a template is edited and copied as one document, '
      + 'and merging two versions of an ordered list of codes has no answer anybody would '
      + 'predict. Creates the draft if this is the first edit since publishing. An '
      + '`activity_taxonomy` draft has its summary tiles checked here (ADR-0064): '
      + '`summaryGroupCode` and `summaryGroupLabel` on a category together or not at all '
      + '(`400 VALIDATION_FAILED`), one label per tile '
      + '(`422 CONFIG_SUMMARY_GROUP_LABEL_MISMATCH`), and no shared tile under the code of a '
      + 'category outside it (`422 CONFIG_SUMMARY_GROUP_CODE_TAKEN`). Writes the template '
      + '`?templateId=` names, the default when absent; an archived template is refused (400).',
  })
  async saveTemplateDraft(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('kind') kind: string,
    @Body() dto: SaveTemplateDraftDto,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templates.saveDraft(ctx, companyId, this.kindOf(kind), dto.payload, query.templateId);
  }

  @Post('companies/:companyId/template/:kind/publish')
  @RequirePermission('company_template:write')
  @ApiOperation({
    summary: 'Publish the draft',
    description:
      'Becomes the version new offices are seeded from. **Reaches nothing that already '
      + 'exists** — copy-on-provision means copy once, and an office that has diverged '
      + 'keeps its divergence. Refuses a payload that would produce a broken office, '
      + 'because the alternative is discovering it while creating one for a real branch. '
      + 'Publishes the template `?templateId=` names, the default when absent; an archived '
      + 'template is refused (400). A ratio set is checked against the same template\'s published '
      + 'taxonomy and the three cascade activity types.',
  })
  async publishTemplate(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('kind') kind: string,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templates.publish(ctx, companyId, this.kindOf(kind), query.templateId);
  }

  /** An unknown kind is a 400 naming the ones that exist, not an empty answer. */
  private kindOf(raw: string): TemplateKind {
    if (!(TEMPLATE_KINDS as readonly string[]).includes(raw)) {
      throw new BadRequestException(
        `Unknown template kind "${raw}". One of: ${TEMPLATE_KINDS.join(', ')}.`,
      );
    }
    return raw as TemplateKind;
  }

  // ---- Support sessions (P4-T10, §3.13). ----

  @Post('impersonation/:sessionId/elevate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('impersonation:elevate_to_write')
  @ApiOperation({
    summary: 'Approve a support session to write',
    description:
      '**A second Super Admin, never the one running it.** An admin session can rewrite '
      + 'the configuration every member of an office depends on, and the operator best '
      + 'placed to notice that is a bad idea is somebody other than the one having it. '
      + 'The reason is typed again and the office\'s Owner reads it. `403` for the '
      + 'session\'s own starter; `404` for one that has ended or expired.',
  })
  async elevateSession(
    @Ctx() ctx: RequestContext,
    @Param('sessionId') sessionId: string,
    @Body() dto: ElevateImpersonationDto,
  ) {
    await this.impersonation.elevate(ctx, sessionId, dto.reason);
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
      'promotes an existing platform user, and inviting a new one is not this route\'s. ' +
      'Audited with both the outgoing and incoming user.',
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

  @Patch('tenants/:kpmId/subscription')
  @RequirePermission('kpm:update_subscription')
  @ApiOperation({
    summary: 'Set an office’s subscription',
    description:
      'Its start and end dates (office dates, both or neither, the end on or after the start), the '
      + 'price per leader per month in IDR minor units (whole rupiah; informational, nothing is charged), '
      + 'the leader limit (or null for none) and keep-active-after-the-end, all five every time (ADR-0112). '
      + 'From 00:00 of the office day after the end date its members are refused TENANT_SUBSCRIPTION_ENDED '
      + 'unless it is kept active. A limit below the leaders it has demotes nobody. Super Admin only, '
      + 'refused in a support session; audited with the five fields before and after. Answers the office '
      + 'as GET /admin/tenants reads it. 400 VALIDATION_FAILED names the field; an unknown office is 404.',
  })
  async updateSubscription(
    @Ctx() ctx: RequestContext,
    @Param('kpmId') kpmId: string,
    @Body() dto: UpdateSubscriptionDto,
  ) {
    return this.tenants.updateSubscription(ctx, kpmId, dto);
  }

  @Post('tenants/:id/roster/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('kpm:import_roster')
  @ApiOperation({
    summary: 'What a roster file would do',
    description:
      'Every problem in the file, per row, in one pass — shape, blanks, duplicates, a '
      + 'code the insurer already issued, a leader who is in neither the file nor the '
      + 'office. Writes nothing.',
  })
  async previewRoster(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: RosterRowsDto,
  ) {
    return this.roster.preview(ctx, id, dto.rows);
  }

  @Post('tenants/:id/roster')
  @RequirePermission('kpm:import_roster')
  @ApiOperation({
    summary: 'Create everybody in the file',
    description:
      'All or nothing: one bad row and nothing is written, because a half-imported '
      + 'roster cannot be told from a whole one. Returns each account with the password '
      + 'it starts on — **the only place those exist** — for the operator to pass on. '
      + 'Every one of them is refused every route but change-password until it is '
      + 'replaced.',
  })
  async importRoster(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: RosterRowsDto,
  ) {
    return this.roster.commit(ctx, id, dto.rows);
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
    // The reader, so a leader note's rows about them are never served to them (ADR-0073).
    return this.auditRead.findForTenant(scope, 100, ctx.userId);
  }

  /**
   * **Declared before `impersonate/:userId`, and that is load-bearing.** Nest matches in
   * declaration order, so with the parameterised route first this one was never reached:
   * `POST /admin/impersonate/end` bound `userId = 'end'` and was refused with
   * `PERM_DENIED` naming `impersonation:start`. Ending a support session was impossible,
   * and nothing said so — no test exercised the route, and the OpenAPI document lists
   * both paths because it reads decorators rather than the router.
   */
  @Post('impersonate/end')
  // Blocking this would strand the operator inside the session they are leaving.
  @AllowWhileReadOnly()
  // And so would the office being suspended or archived while they were in it (P13.2 exit review).
  @AllowWhileOfficeUnavailable()
  // A POST defaults to 201, and this one answers 200 — it ends a session rather than
  // creating anything. The document said 201 until P3.5-T11; a client checking the status
  // would have treated every successful call as a failure.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the current impersonation session' })
  async endImpersonation(@Ctx() ctx: RequestContext) {
    await this.impersonation.end(ctx);
    return { status: 'ended' };
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

}
