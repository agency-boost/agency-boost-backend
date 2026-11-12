import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { PLATFORM_READ } from '@/domain/constants';
import { ComplianceQueryDto } from '../compliance/compliance.dto';
import { KpmAnalyticsQueryDto } from '../reporting.dto';
import {
  CompanyKpmsQueryDto, KpmComparisonQueryDto, KpmDataQueryDto, PlatformAccountsQueryDto, PlatformMembersQueryDto,
} from './platform-reads.dto';
import { PlatformReads } from './platform-reads.service';
import {
  CompanyKpmsDto, KpmComparisonPageDto, KpmDataDto, PlatformAccountsPageDto, PlatformMembersPageDto,
} from './platform-reads.response.dto';
import { KpmAnalyticsDto } from '../reporting.response.dto';
import { ComplianceViewDto } from '../compliance/compliance.response.dto';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** Every one of these reads: the Super Admin's alone, refused in a support session; audited, or not served. */
const PLATFORM_ONLY = refusal(
  403,
  '`PERM_DENIED` — every tenant role, and a support session (its context is the member’s, holding no platform grant).',
);
const UNRECORDED = refusal(
  500,
  '`INTERNAL_ERROR` — the read’s audit entries could not be written, so the read is not served (ADR-0207 §5).',
);

const AUDITED = (action: string) =>
  ` **Audited per read** as \`${action}\` (ADR-0207 §5): one entry in the platform’s log with the purpose, the `
  + 'filters, the page and the number of rows, and one in each KPM’s whose data it returned, written before the answer '
  + 'is sent. Read-only: nothing in any KPM is written.';

/**
 * **The Super Admin's reads across KPMs** (ADR-0207; P19.4-T3; `functional/kpm-analytics.md` and
 * `functional/tenant-provisioning.md`, the Data contracts): six named reads, each reached from one screen. Every figure is
 * the KPM's own, through the function its Owner's page uses; every route is a `GET`.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class PlatformReadsController {
  constructor(private readonly reads: PlatformReads) {}

  @Get('members')
  @RequirePermission('platform_members:read')
  @ApiOperation({
    summary: 'All members — every membership on the platform',
    description:
      `*All members* and a KPM's *Anggota* tab (SA UI-010, SA R1): one row per membership, ${PLATFORM_READ.PAGE_SIZE} a `
      + 'page, by name: the person, the company, the KPM, the rung with the *Owner* and *Admin* badges, the leader, the '
      + 'status, the invitation’s state, the join date and the last day an activity was logged. Filtered and searched on '
      + 'the server; `q` matches a name, a phone number or an email address, **neither of which is returned**. A person in '
      + 'two KPMs is two rows. View-only: a row links to its KPM.'
      + AUDITED(PLATFORM_READ.ACTION.members) + ' The entries name the memberships returned.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `q` shorter than two characters, an unknown `role` or `status`, a '
    + '`page` that is no whole number from 1, an id that is no id, or a parameter of any other name. `details` names it.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: PlatformMembersPageDto })
  async members(@Ctx() ctx: RequestContext, @Query() query: PlatformMembersQueryDto) {
    return this.reads.members(ctx, query);
  }

  @Get('users')
  @RequirePermission('platform_members:read')
  @ApiOperation({
    summary: 'Registered accounts — every account, with or without a KPM',
    description:
      `*All members* › *Akun terdaftar* (ADR-0245 §1): every registered account but a Super Admin’s, `
      + `${PLATFORM_READ.PAGE_SIZE} a page, newest registration first — a person who registered and joined no KPM `
      + 'included, whom *All members*’ memberships cannot list. Each row: the name, the email, the insurer it registered '
      + 'with, the day it registered, whether the address is verified, the day it last signed in, and how many KPMs it '
      + 'is active or pending in. `q` matches a name or an email; `kpm=none` is *Tanpa KPM*, `kpm=some` *Punya KPM*. '
      + 'Never a phone, a birth date or a gender. View-only. **Audited per read** as '
      + `\`${PLATFORM_READ.ACTION.accounts}\` (ADR-0207 §5): one entry in the platform’s log with the purpose, the filters, `
      + 'the page, the number of rows and the accounts returned, written before the answer is sent.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `q` shorter than two characters, a `kpm` other than `none` or `some`, '
    + 'a `page` that is no whole number from 1, or a parameter of any other name. `details` names it.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: PlatformAccountsPageDto })
  async accounts(@Ctx() ctx: RequestContext, @Query() query: PlatformAccountsQueryDto) {
    return this.reads.accounts(ctx, query);
  }

  @Get('analytics/kpms')
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: 'The KPM comparison — the Overview’s figures, one row per KPM',
    description:
      'Under the adoption figures on `/admin/analytics` (SA UI-013, SA R4): per KPM, *Total members*, *Aktif bulan ini*, '
      + '*Pengguna aktif*, *Coached 7 hari · 30 hari*, *Production this year* against target and the *Recruitment '
      + 'pipeline* against the month’s target — **each the same figure that KPM’s `/kpm/overview` shows**, computed by the '
      + 'same code over the KPM. Counts and sums only; no benchmark, score or rank. Archived KPMs are left out.'
      + AUDITED(PLATFORM_READ.ACTION.kpmComparison),
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — an unknown `sort`, a `page` that is no whole number from 1, or a '
    + 'parameter of any other name.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: KpmComparisonPageDto })
  async comparison(@Ctx() ctx: RequestContext, @Query() query: KpmComparisonQueryDto) {
    return this.reads.kpmComparisonAcrossTenants(ctx, query);
  }

  @Get('tenants/:id/analytics')
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: '*Lihat sebagai KPM* — the KPM’s analytics, read-only',
    description:
      'Exactly what `GET /kpm/analytics` answers the KPM’s Owner (SA R4, A2, A-R8), through the same service over the '
      + 'KPM: the totals, the Leader list and *Monthly production*, names included. Not a support session: it acts as '
      + 'nobody and needs no reason. The same `period` and `group` as the Owner’s.'
      + AUDITED(PLATFORM_READ.ACTION.kpmAnalytics) + ' Each visit is one.',
  })
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id; a `group` the KPM does not hold. Indistinguishable from another office’s.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: KpmAnalyticsDto })
  async analytics(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: KpmAnalyticsQueryDto) {
    return this.reads.kpmAnalytics(ctx, id, query);
  }

  @Get('tenants/:id/analytics/compliance')
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: '*Lihat sebagai KPM* — the KPM’s compliance tree, read-only',
    description:
      'Exactly what `GET /kpm/analytics/compliance` answers the KPM’s Owner, through the same service over the KPM, '
      + 'with `can.override` always `false`. The chosen category’s disclosure entries are written in the KPM’s log, the '
      + 'Super Admin their actor, as the Owner’s own read writes them.'
      + AUDITED(PLATFORM_READ.ACTION.kpmAnalytics),
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — as the Owner’s read refuses it.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id; an item or a group the KPM does not list. Indistinguishable from another office’s.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: ComplianceViewDto })
  async compliance(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: ComplianceQueryDto) {
    return this.reads.kpmCompliance(ctx, id, query);
  }

  @Get('tenants/:id/data')
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: '*Data bulanan* — the KPM’s twelve months and its uploads, read-only',
    description:
      `The KPM page's *Data bulanan* tab and *Ringkasan*'s grid (A2): ${PLATFORM_READ.DATA_MONTHS} months ending with the `
      + 'KPM’s current month, each `complete` (*Lengkap*), `missing` (*Belum*) or `none` (*—*, before the KPM); and the '
      + 'uploads of those months, newest first — the month, who uploaded it, when, the agents’ rows written and the '
      + 'note. No figure, no upload: the KPM’s Owner and Admins upload.'
      + AUDITED(PLATFORM_READ.ACTION.kpmData),
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a parameter of any name.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id: indistinguishable from another office’s.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: KpmDataDto })
  async data(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() _query: KpmDataQueryDto) {
    return this.reads.kpmData(ctx, id);
  }

  @Get('companies/:companyId/kpms')
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: '*KPM & data* — the company’s KPMs for a month',
    description:
      'The company page’s *KPM & data* tab (A2): three tiles — the KPMs and their Owners signed in, the members and those '
      + 'never signed in, the KPMs complete for the month — and per KPM its manpower, MAA, APE and recruitment from '
      + 'January through the month, its data status and its peer status (the D4 rule: other KPMs of the company complete '
      + 'for the month, three needed; *"Belum cukup KPM pembanding"* under three). Every figure through the Overview’s '
      + 'own functions over each KPM. `month` is the latest any KPM uploaded when absent.'
      + AUDITED(PLATFORM_READ.ACTION.companyKpms),
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month, or a parameter of any other name.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no company with this id, or the Template library, which holds no KPM — as another office’s would be.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: CompanyKpmsDto })
  async companyKpms(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Query() query: CompanyKpmsQueryDto) {
    return this.reads.companyKpmsAcrossTenants(ctx, companyId, query.month);
  }
}
