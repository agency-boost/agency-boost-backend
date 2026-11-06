import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Optional, Param, Patch, Post, Put,
  Query, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags,
} from '@nestjs/swagger';
import {
  AllowWhileOfficeUnavailable, AllowWhileReadOnly, Ctx, RequirePermission,
} from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditReadService } from '@/modules/audit/audit-read.service';
import { AuditQueryDto } from '@/modules/audit/audit-query.dto';
import { ImpersonateDto } from '@/modules/auth/auth.dto';
import { ImpersonationService } from '@/modules/auth/impersonation.service';
import {
  AccountSearchQueryDto,
  ApproveKpmRequestDto,
  AssignOwnerDto,
  CodeAvailabilityQueryDto,
  MoveCompanyDto,
  CreateCompanyDto,
  SetCompanyStatusDto,
  UpdateCompanyDto,
  CreateKpmDto,
  CreateOrgLevelDto,
  DeclineKpmRequestDto,
  RosterFileImportDto,
  RosterImportDto,
  RosterRowsDto,
  RosterTemplateQueryDto,
  SetStatusDto,
  UpdateOrgLevelDto,
  DeleteOrgLevelQueryDto,
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
import { PlatformReads } from '@/modules/reporting/platform/platform-reads.service';
import { TemplateService } from '@/modules/config/template.service';
import { SaveTemplateDraftDto } from '@/modules/config/template.dto';
import { TemplateQueryDto } from '@/modules/config/named-template.dto';
import { TEMPLATE_KINDS, type TemplateKind } from '@/modules/config/company-template.schema';
import { TENANTS_REFUSALS } from './tenants.messages';
import { RosterUploadInterceptor } from './roster-upload.interceptor';
import type { FileUpload } from '@/common/spreadsheet/file-upload.interceptor';
import { AUDIT_LOG, ROSTER_UPLOAD, XLSX_MIME_TYPE } from '@/domain/constants';

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
    /*
     * *Data terakhir* and *Perlu tindakan* on the offices list (P19.4-T3 AC-8): whether each office's months are
     * uploaded. Optional so a spec building the controller by hand need not; the application always provides it.
     */
    @Optional() @Inject(PlatformReads) private readonly platformReads: PlatformReads | null = null,
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
    summary: 'Approve a KPM registration and make the applicant its Owner',
    description:
      '"Setujui & jadikan Owner" (ADR-0191 §3): creates the office and makes the person who asked its '
      + 'Owner as one step that completes or leaves nothing behind. The code is supplied here because it must be unique '
      + 'within the company; `companyId` corrects the request\'s company. Every check comes first — `404` for an unknown '
      + 'company or applicant, `409 TENANT_CODE_TAKEN` naming the office holding the code, `409 TENANT_COMPANY_MISMATCH` '
      + 'for an applicant of another company or with no agent code, `409 AUTH_EMAIL_NOT_VERIFIED` for an unverified '
      + 'address. A press while another approval holds the request is `409 TENANT_REQUEST_IN_PROGRESS`; one after it '
      + 'succeeded answers the queue with the same office, never a second. If the Owner cannot be set the office is '
      + 'soft-deleted again. A declined request is `409 TENANT_REQUEST_DECIDED`. Answers the queue. `startFrom` is '
      + '*Mulai dari* (ADR-0213 §3), offered when the company has no template: absent, the company\'s default template, '
      + 'or the built-in default where it has none.',
  })
  async approveKpmRequest(
    @Ctx() ctx: RequestContext,
    @Param('requestId') requestId: string,
    @Body() dto: ApproveKpmRequestDto,
  ) {
    this.refuseTheDefaults(dto);
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

  @Delete('kpm-requests/:requestId')
  @RequirePermission('kpm_request:decide')
  @ApiOperation({
    summary: 'Remove a wrong or duplicate KPM request',
    description:
      '"Hapus" (ADR-0191 §5): a soft delete, pending or decided, audited as `kpm_request.deleted`. Nothing '
      + 'it made is touched. `409 TENANT_REQUEST_IN_PROGRESS` while an approval holds it; `404` for one that is not '
      + 'there. Answers the queue.',
  })
  async deleteKpmRequest(@Ctx() ctx: RequestContext, @Param('requestId') requestId: string) {
    return this.kpmRequestService.remove(ctx, requestId);
  }

  @Get('accounts')
  @RequirePermission('kpm:assign_owner')
  @ApiOperation({
    summary: 'Find the account to make an Owner',
    description:
      '"Ganti Owner"\'s picker (ADR-0191 §5): accounts whose name or email contains `q` (at least two '
      + 'characters, else `400`), at most twenty, Super Admins left out — each with its company, whether its address '
      + 'is verified and whether it holds an agent code, and the offices it already owns or belongs to.',
  })
  async searchAccounts(@Ctx() ctx: RequestContext, @Query() query: AccountSearchQueryDto) {
    return this.tenants.searchAccounts(ctx, query.q);
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
      'even after archiving \u2014 because it is what every membership holds. `leaderTier` ' +
      '(`senior`, `associate` or `null`, absent being `null`) decides the class its members are ' +
      'given (ADR-0156).',
  })
  async createOrgLevel(@Ctx() ctx: RequestContext, @Body() dto: CreateOrgLevelDto) {
    return this.orgLevels.create(ctx, dto);
  }

  @Patch('org-levels/:id')
  @RequirePermission('org_level:crud')
  @ApiOperation({
    summary: 'Rename, reorder, archive or set the leader tier of a rung',
    description:
      'The code is not updatable, by construction \u2014 it is absent from the body. ' +
      'Archiving retires a rung and keeps every membership that references it readable. ' +
      'A change of `leaderTier` is refused `409 ORG_LEVEL_TIER_IN_USE`, with `details.members`, ' +
      'while any live membership stands on the rung: nobody is re-classed silently (ADR-0156 \u00a75). ' +
      '`expectedVersion`, when sent, must be the rung\'s `version` as read, or `409 VERSION_CONFLICT` ' +
      'and nothing is written.',
  })
  async updateOrgLevel(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: UpdateOrgLevelDto,
  ) {
    return this.orgLevels.update(ctx, id, dto);
  }

  @Delete('org-levels/:id')
  @RequirePermission('org_level:crud')
  @ApiOperation({
    summary: 'Delete an archived rung that nothing names',
    description:
      'A soft delete (ADR-0213 §2, B1-6), audited as `org_level.deleted` with its code and label; answers the '
      + 'company\'s ladder as it now stands. Only an **archived** rung, and only when nothing in its company names it — '
      + 'a membership of any status or its role history, a leader-limit request, a KPM\'s live or published setting or '
      + 'campaign, the company\'s carrier rules, any version or draft of its templates. Otherwise `409 ORG_LEVEL_IN_USE` '
      + 'with `details.references`, each `{ kind, count }` (empty for a live rung, which is archived first). '
      + '`?expectedVersion=` as read, or `409 VERSION_CONFLICT`. The code may be used again afterwards.',
  })
  async deleteOrgLevel(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Query() query: DeleteOrgLevelQueryDto,
  ) {
    return this.orgLevels.remove(ctx, id, query.expectedVersion);
  }

  @Get('tenants')
  @RequirePermission('kpm:list_all')
  @ApiOperation({
    summary: 'List every KPM on the platform',
    description:
      'Newest first, each with its subscription, *Leaders used*, its Owner\'s state and its member counts (ADR-0212), and '
      + '`dataStatus` (SA R5; the setup spec\'s A2): the latest month its file holds and, when the last ended month is not uploaded and the '
      + 'KPM existed in it, that month — *"Data <bulan> belum diunggah"*. Whether a month was uploaded, never a figure of it.',
  })
  async listTenants(@Ctx() ctx: RequestContext) {
    const rows = await this.tenants.listAll(ctx);
    if (!this.platformReads) return rows.map((row) => ({ ...row, dataStatus: { latestMonth: null, missingMonth: null } }));
    const status = await this.platformReads.dataStatusAcrossTenants(ctx, rows);
    return rows.map((row) => ({ ...row, dataStatus: status.get(row._id) ?? { latestMonth: null, missingMonth: null } }));
  }

  @Post('tenants')
  @RequirePermission('kpm:create')
  @ApiOperation({
    summary: 'Create a KPM',
    description:
      'The only way an office comes into existence — there is no self-service path ' +
      '(ADR-0005). Seeds the per-office settings every prototype screen hardcodes, and its ' +
      'configuration from `startFrom` (ADR-0115): one of the company\'s active templates, the ' +
      'Template library\'s (`templateLibrary`, ADR-0164), or empty — the company\'s default template ' +
      'when absent. `kind: \'defaults\'` is refused 400 VALIDATION_FAILED, `details.field: ' +
      '\'startFrom.kind\'`: the Template\'s Default template holds the AgencyBoost defaults (ADR-0168 §2). There is no ' +
      'fallback: a kind the source holds none of is empty in the office, and every office has the ' +
      'three cascade activity types. The whole source is checked before the office is written, so ' +
      'a refusal (400, naming what is broken; 404 for a template that is not the company\'s; 409 ' +
      'TEMPLATE_RUNG_UNKNOWN for a library template naming a role the company\'s ladder lacks) leaves ' +
      'nothing behind. The Template library itself holds no office: 409 COMPANY_IS_TEMPLATE_LIBRARY. '
      + '**`owner`** (ADR-0212 §1, §2; *Pemilik KPM*): made the Owner as one unit with the KPM — checked before anything is '
      + 'written as `PATCH /admin/tenants/:id/owner` checks one (`409 TENANT_COMPANY_MISMATCH`, `409 '
      + 'AUTH_EMAIL_NOT_VERIFIED`; for an email nobody holds `agentCode` required, `400`, and free, `409 '
      + 'AGENT_CODE_TAKEN`), and a failure after the KPM is written undoes it. With no `email`, no account: '
      + '`pendingOwner`, *Belum diundang*. `sendInvitation` (default `true`) emails the Owner a one-time link to choose a '
      + 'password; `invitationSent` says whether it went. A code taken in the company is `409 TENANT_CODE_TAKEN`: *"Kode '
      + '0417 sudah dipakai KPM lain di Prudential: …"*.',
  })
  async createTenant(@Ctx() ctx: RequestContext, @Body() dto: CreateKpmDto) {
    this.refuseTheDefaults(dto);
    return this.tenants.createKpm(ctx, dto);
  }

  /**
   * **No office is started from the AgencyBoost defaults through this route** (ADR-0168 §2). The Template's
   * Default template holds them as data the Super Admin edits, and one editable source is what keeps the two
   * from drifting apart unseen.
   *
   * Refused here, at the request, and nowhere deeper: `ProvisioningService.planFor` keeps its `defaults` source
   * — the code's own starting point, `platformDefaultPayload`, which migration `0037` builds the Template from —
   * for the callers that are not a request. `StartFromDto` still admits the value, so the refusal names the field
   * and says what to choose instead rather than reading as an unknown enum member.
   */
  private refuseTheDefaults(dto: { startFrom?: CreateKpmDto['startFrom'] }): void {
    if (dto.startFrom?.kind !== 'defaults') return;
    throw new DomainException(
      ErrorCode.VALIDATION_FAILED,
      TENANTS_REFUSALS.VALIDATION_FAILED.startFromDefaults,
      HttpStatus.BAD_REQUEST,
      { field: 'startFrom.kind' },
    );
  }

  @Get('tenants/code-availability')
  @RequirePermission('kpm:create')
  @ApiOperation({
    summary: 'Is a KPM code free in a company?',
    description:
      'Read as the code is typed on a KPM request\'s card or the New office form (ADR-0191 §2): '
      + '`available`, and when it is not, `takenBy` — the live office of the company holding it. Declared above '
      + '`tenants/:id`, which would otherwise read it as an id. `404` for an unknown company.',
  })
  async codeAvailability(@Ctx() ctx: RequestContext, @Query() query: CodeAvailabilityQueryDto) {
    return this.tenants.codeAvailability(ctx, query.companyId, query.code);
  }

  // ---- Filling and updating an office from a spreadsheet (P3.2-T4; the setup spec's §A3 since P19.3-T4). ----

  @Get('tenants/roster-template')
  @RequirePermission('kpm:import_roster')
  @ApiOperation({
    summary: 'The member template',
    description:
      'Absent `format`: the JSON below — the header, the columns, `template` (the CSV: **the header and nothing '
      + 'else**, ADR-0184) and `examples`, three worked rows as cells, which is what the paste box shows; a screen '
      + 'splitting a CSV itself would be a second parser. **The header is A3\'s** (ADR-0205 §5): *Kode agen, '
      + 'Nama, Peran, Kode upline, No. WhatsApp, Email, Tanggal bergabung, Waktu, Tanggal lahir*, then *Jenis kelamin* '
      + 'and *Bulan bergabung di perusahaan*. `format=csv`: that CSV as the file itself, `roster-template.csv`. '
      + '`format=xlsx`: the template as an Excel workbook, `roster-template.xlsx` — a guide sheet in the reader’s '
      + 'language (*Petunjuk*, *Guide*: the steps, each column, the rules, the examples) apart from the *Data* sheet, '
      + 'which holds the header alone, its code, phone and date columns as text and its fixed choices as dropdowns. '
      + 'With `kpmId` (or, for an Owner or an Admin, their own office) *Peran* is a dropdown of the company ladder\'s '
      + 'rungs; another office\'s id is 404. Any other `format`, a `kpmId` that is not an id, or any other query field '
      + 'is `400 VALIDATION_FAILED`. Declared above the routes that take an `:id`, because Nest would otherwise read '
      + '"roster-template" as one.',
  })
  @ApiProduces('application/json', 'text/csv', XLSX_MIME_TYPE)
  async rosterTemplate(@Ctx() ctx: RequestContext, @Query() query: RosterTemplateQueryDto) {
    const { format, kpmId } = query;
    if (format === 'xlsx') {
      return new StreamableFile(await this.roster.workbook(ctx, kpmId || null), {
        type: XLSX_MIME_TYPE, disposition: 'attachment; filename="roster-template.xlsx"',
      });
    }
    if (format === 'csv') {
      return new StreamableFile(Buffer.from(ROSTER_TEMPLATE, 'utf8'), {
        type: 'text/csv; charset=utf-8', disposition: 'attachment; filename="roster-template.csv"',
      });
    }
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
      + 'puts on its front page. `published` is the live version beside it — the newest published '
      + 'version, payload and date, or `null` where nothing is published — so a draft never hides it. '
      + '`revision` is what a draft save sends back as `expectedRevision`.',
  })
  async readTemplate(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('kind') kind: string,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templates.read(companyId, this.kindOf(kind), query.templateId, ctx.reader, ctx);
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
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('kind') kind: string,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templates.history(companyId, this.kindOf(kind), query.templateId, ctx.reader);
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
      + '`?templateId=` names, the default when absent; an archived template is refused (400). '
      + '`expectedRevision`, when sent, must be the `revision` read, or `409 VERSION_CONFLICT` and '
      + 'nothing is written.',
  })
  async saveTemplateDraft(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('kind') kind: string,
    @Body() dto: SaveTemplateDraftDto,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templates.saveDraft(
      ctx, companyId, this.kindOf(kind), dto.payload, query.templateId, dto.expectedRevision,
    );
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
      throw new InvalidRequestException(
        TENANTS_REFUSALS.VALIDATION_FAILED.unknownTemplateKind({ kind: raw, kinds: TEMPLATE_KINDS }),
      );
    }
    return raw as TemplateKind;
  }

  // ---- Support sessions (P4-T10, §3.13). ----
  // `POST /admin/impersonation/:sessionId/elevate` is retired (P19.4-T2; ADR-0206 §3): a session only looks, so there
  // is no write for a second Super Admin to approve, and the route answers 404 like any that does not exist.

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
      'Name the person by email or by user id — "Ganti Owner" picks the id from `GET /admin/accounts` — or, with '
      + '`owner { fullName, phone, email, agentCode? }`, somebody named (ADR-0212 §3): an account with that email is made '
      + 'the Owner, or one is made for it (no usable password; `agentCode` then required, `400`, and free in the company, '
      + '`409 AGENT_CODE_TAKEN`), and invited by email unless `sendInvitation` is `false` (an account that has signed in '
      + 'is sent none); `owner.email` is required (`400`). A pending Owner (`pendingOwner`) is cleared once one is set. '
      + 'Refused before anything is written: `409 TENANT_COMPANY_MISMATCH` for an account of another company or with no '
      + 'agent code, `409 AUTH_EMAIL_NOT_VERIFIED` for an unverified address (ADR-0190 §4). '
      + 'Audited with both the outgoing and incoming user. Answers the office as the list reads it.',
  })
  async assignOwner(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: AssignOwnerDto,
  ) {
    return this.tenants.assignOwner(ctx, id, dto);
  }

  @Post('tenants/:id/owner/invitation')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('kpm:assign_owner')
  @ApiOperation({
    summary: 'Send the Owner their invitation again',
    description:
      '*Kirim ulang undangan* on the Owner\'s card (ADR-0212 §2): a new one-time link to choose a password, emailed to '
      + 'the Owner (`password_reset`, alive `ROSTER_INVITATION.TTL_DAYS`), every older link revoked, `invitedAt` '
      + 'stamped, audited `kpm.owner_invited` with `resent: true`. Nothing by WhatsApp or SMS. `409 '
      + 'TENANT_OWNER_NOT_INVITABLE` — `details.reason` `no_owner`, `no_email` (an Owner named without one) or '
      + '`signed_in`; `429 AUTH_RATE_LIMITED` past three an hour for the KPM; `404` for an unknown KPM. Nothing is sent '
      + 'on a refusal. Answers the office as the list reads it.',
  })
  async resendOwnerInvitation(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tenants.resendOwnerInvitation(ctx, id);
  }

  @Patch('tenants/:id/company')
  @RequirePermission('kpm:update_company_tag')
  @ApiOperation({
    summary: 'Move a KPM to another company',
    description:
      '"Pindahkan ke perusahaan lain" (ADR-0191 §5): only while the office has no member but its Owner '
      + '(`409 TENANT_NOT_EMPTY`, `details.members`), its configuration provisioned again from the new company\'s '
      + 'default template and the old one soft-deleted. The Owner must be the new company\'s (`409 '
      + 'TENANT_COMPANY_MISMATCH`) and keeps their rung by its code; the code must be free there (`409 '
      + 'TENANT_CODE_TAKEN`); the Template library holds no office (`409 COMPANY_IS_TEMPLATE_LIBRARY`); the same '
      + 'company is `400`. Every check first, so a refusal writes nothing. Audited as `kpm.company_moved`.',
  })
  async moveCompany(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: MoveCompanyDto) {
    return this.tenants.moveCompany(ctx, id, dto.companyId);
  }

  @Get('tenants/:id/contents')
  @RequirePermission('kpm:archive')
  @ApiOperation({
    summary: 'What a KPM holds: its members and its records',
    description:
      'What the "Hapus KPM" confirmation shows (ADR-0191 §5): `members` (every membership, the Owner\'s '
      + 'included), `records` (every row carrying the office, apart from its configuration and the audit log) and '
      + '`deletable` when both are zero.',
  })
  async tenantContents(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tenants.contents(ctx, id);
  }

  @Delete('tenants/:id')
  @RequirePermission('kpm:archive')
  @ApiOperation({
    summary: 'Delete an empty KPM',
    description:
      '"Hapus KPM" (ADR-0191 §5): a soft delete of an office with no member and no record, its '
      + 'configuration with it, audited as `kpm.deleted`; its code is free again. One with either is `409 '
      + 'TENANT_NOT_EMPTY` with the counts — archive it instead (`PATCH /admin/tenants/:id/status`).',
  })
  async deleteTenant(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.tenants.deleteKpm(ctx, id);
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
    summary: 'What a member file would do',
    description:
      'Each row\'s result, in the file\'s order (the setup spec\'s §A3; ADR-0205 §5 to §8): `imported` (a new '
      + 'person), `updated` (a code already in this office: blank cells keep what is stored, an email is never changed) '
      + 'or `skipped`, with A3\'s words — a code twice in the file, a role not on the company\'s ladder, an upline in '
      + 'neither the file nor the office, an upline who is no leader or ranks lower, an Agent or AAB with no upline, a '
      + 'loop, a row whose upline\'s row is skipped, a code held elsewhere at the insurer (naming no office), a new '
      + 'person with no email, a cell in the wrong shape, a row past the leader limit. `counts` is *N orang baru siap '
      + 'diimpor, M diperbarui, K baris dilewati*; `skippedCsv` the skipped rows with an `Alasan` column. `issues` is '
      + 'only what makes the file unreadable — no *Kode agen*, *Nama* or *Peran* column, an unknown column — and then '
      + '`rows` is empty. Writes nothing.',
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
    summary: 'Import the valid rows of a member file',
    description:
      'The whole file checked again — never a preview trusted — then **every valid row as one unit** (ADR-0205 §9): '
      + 'written leader first, and if any write fails, what this commit wrote is undone (its memberships, edges and '
      + 'accounts soft-deleted, its updates put back) before the failure is answered, so the office holds every valid '
      + 'row or none. New people are existing agents (ADR-0169 §6). **No password is returned or shown**: with `invite` '
      + '(the default) each new person is emailed a one-time link to choose theirs; without it they use *Lupa kata '
      + 'sandi?*. Answers the preview\'s rows and counts, and `invited`. `400 VALIDATION_FAILED` for a file that cannot '
      + 'be read, or one with no row to import; `409 LEADER_LIMIT_REACHED` when the office fills while it is written.',
  })
  async importRoster(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: RosterImportDto,
  ) {
    return this.roster.commit(ctx, id, dto.rows, dto.invite ?? true);
  }

  /** The file's form, for the two routes that take one. */
  private static readonly ROSTER_FILE_BODY = {
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string', format: 'binary',
          description: `The filled template — an Excel workbook (.xlsx) or a CSV. At most ${ROSTER_UPLOAD.MAX_BYTES / 1024 / 1024} MiB.`,
        },
        invite: {
          type: 'string', enum: ['true', 'false'],
          description: 'On `roster/file` only: mail each new person their invitation. Absent is `true`.',
        },
      },
    },
  };

  @Post('tenants/:id/roster/file/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('kpm:import_roster')
  @UseInterceptors(RosterUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody(AdminController.ROSTER_FILE_BODY)
  @ApiOperation({
    summary: 'What an uploaded roster file would do',
    description:
      'The same check as the pasted rows\' (`roster/preview`), for a file sent as `multipart/form-data` (ADR-0184). '
      + '**An Excel workbook** is opened only after its parts, as its own directory declares them, are checked to unpack '
      + 'to at most 25 MiB in at most 1,000 parts (`ASSET_TOO_LARGE`, 413), and its *Data* sheet is read — or the sheet '
      + 'that starts with the header — at most 10,000 rows, each line numbered as the sheet numbers its row. **A CSV** '
      + 'is read as UTF-8, or Windows-1252 when it is not valid UTF-8. Either way the rows meet the same parser and the '
      + 'same issues. Writes nothing. `413 ASSET_TOO_LARGE` over 1 MiB; `422 UPLOAD_MALFORMED_CSV` for a file that is '
      + 'neither text nor a workbook that opens, or a workbook with no sheet to read; `400 VALIDATION_FAILED` with no '
      + 'file; 404 for an office not the caller\'s.',
  })
  async previewRosterFile(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @UploadedFile() file?: FileUpload,
  ) {
    return this.roster.previewFile(ctx, id, file);
  }

  @Post('tenants/:id/roster/file')
  @RequirePermission('kpm:import_roster')
  @UseInterceptors(RosterUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody(AdminController.ROSTER_FILE_BODY)
  @ApiOperation({
    summary: 'Create everybody in a roster file',
    description:
      'The same import as the pasted rows\' (`roster`), for the file the preview read (ADR-0184): read again, checked '
      + 'again, and its valid rows written as one unit. `invite` is a form field, `true` or `false`. No password is '
      + 'returned. The file\'s own refusals are the preview\'s.',
  })
  async importRosterFile(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: RosterFileImportDto,
    @UploadedFile() file?: FileUpload,
  ) {
    return this.roster.commitFile(ctx, id, file, dto.invite !== 'false');
  }

  @Get('audit')
  @RequirePermission('audit_log:read')
  @ApiOperation({
    summary: 'Read the audit log, a page at a time',
    description:
      'Defaults to the caller\'s own tenant. A Super Admin has no tenant, so their default is the platform-level log — '
      + 'provisioning, companies, templates, products, support sessions — and `kpmId` narrows it to one office. Anyone '
      + 'else is pinned to their own office whatever they pass. Within that reach `companyId`, `action`, `actorUserId`, '
      + '`from` and `to` narrow it, together. Newest first, and **grouped on the server**: consecutive rows with the same '
      + `actor, action and target within ${AUDIT_LOG.GROUP_WINDOW_MINUTES} minutes of the group's newest (inclusive) are `
      + `one item carrying \`count\` and \`oldestAt\`. At most ${AUDIT_LOG.PAGE_SIZE} items a page, never a group split `
      + 'across two; `page.nextCursor` asks for the next, and is null on the last. The first page (no `cursor`) carries '
      + '`facets`, the actions and actors within the reach. **In words** (SA UI-016): each item carries '
      + '`actionLabel` and `targetKind` in the reader\'s language and `targetLabel`, the target\'s name — *"Prudential '
      + 'template · Aktivitas & rasio"*, *"PRUProsper"*, *"KPM 0417 · Bandung"* — and `facets.actionLabels` the chip\'s '
      + 'words. A leader note\'s rows about the reader are dropped before '
      + 'grouping (ADR-0073). A query field that is not a string, or not its shape, is 400 VALIDATION_FAILED naming it.',
  })
  async readAudit(@Ctx() ctx: RequestContext, @Query() query: AuditQueryDto) {
    const scope = ctx.isSuperAdmin ? (query.kpmId ?? null) : ctx.kpmId;
    const { kpmId: _asked, cursor, ...filters } = query;
    // The reader, so a leader note's rows about them are never served to them (ADR-0073).
    // And their language: the actions, the kinds of target and a section's name in their words (P19.4-T3 AC-11).
    return this.auditRead.page({ kpmId: scope, readerUserId: ctx.userId, reader: ctx.reader }, filters, cursor);
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
  // Blocking this would strand the operator inside the session they are leaving: the one route a session posts to.
  @AllowWhileReadOnly()
  // And so would the office being suspended or archived while they were in it (P13.2 exit review).
  @AllowWhileOfficeUnavailable()
  // A POST defaults to 201, and this one answers 200 — it ends a session rather than
  // creating anything. The document said 201 until P3.1-T11; a client checking the status
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
      'Admin — that would erase the attribution the feature depends on. **It only looks** ' +
      '(ADR-0206): every request of the session whose method is not `GET`, `HEAD` or `OPTIONS` is ' +
      '`403 IMPERSONATION_READ_ONLY`, but `POST /admin/impersonate/end`. `purpose` is `support` or left ' +
      'out; `setup` is `400 VALIDATION_FAILED` naming `purpose`, with nothing written. The answer is ' +
      '`{ accessToken, expiresAt, sessionId, readOnly: true }`. A second start as the same person within one ' +
      'second would sign the same token, and is refused (`409 IMPERSONATION_JUST_STARTED`) with nothing written.',
  })
  async impersonate(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body() dto: ImpersonateDto,
  ) {
    return this.impersonation.start(ctx, userId, dto.reason, dto.durationMinutes, dto.purpose);
  }

}
