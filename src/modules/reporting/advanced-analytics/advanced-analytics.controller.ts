import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { PLATFORM_READ } from '@/domain/constants';
import {
  AdminAdvancedAnalyticsQueryDto, AdvancedAnalyticsShellQueryDto, DemographicsQueryDto, EventsQueryDto, MapaQueryDto,
  QuantQueryDto, SetMapaTargetDto, SetSubgroupTargetDto, SubgroupQueryDto,
} from './advanced-analytics.dto';
import {
  AdminAdvancedAnalyticsSectionDto, AdvancedAnalyticsShellDto, DemographicsDto, EventsNpsDto, MapaDto, MapaTargetDto,
  QuantDto, SubgroupDto, SubgroupTargetDto,
} from './advanced-analytics.response.dto';
import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { AdminAdvancedAnalytics } from './admin-advanced-analytics.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** Who reads the page (ADR-0215 §2): the Owner, the Admins and a Core Leader; any other leader is 404. */
const READ_403 = refusal(
  403,
  '`TENANT_NO_MEMBERSHIP` — a Super Admin outside a support session belongs to no agency. `PERM_DENIED` — a role '
  + 'without the permission: an Agent.',
);
const READ_404 = refusal(
  404,
  '`NOT_FOUND` — an AB or an AAB who is not a Core Leader (roles §3.9 ¶); a section the template has switched off; an '
  + '`ab` this office does not hold. Indistinguishable from another office’s.',
);
const WRITE_403 = refusal(
  403,
  '`PERM_DENIED` — every role but the Owner and the Admins. `IMPERSONATION_READ_ONLY` — a view-as session.',
);

/**
 * **The KPM's *Advanced analytics* page** (P19.5-T3; ADR-0215; `functional/advanced-analytics.md`, the Data contract):
 * the shell and five sections. *NPS KPM* and *Analitik kualitatif* are `SurveyRunsController`'s, on the same prefix.
 */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/advanced-analytics')
export class AdvancedAnalyticsController {
  constructor(private readonly analytics: AdvancedAnalyticsService) {}

  @Get()
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: 'The page’s tabs',
    description: 'The template’s sections that are on, in its order — NPS and *Kualitatif* also while a run of them is '
      + 'open — then *Event*; the template’s name and version; and whether the reader may type targets or upload.',
  })
  @ApiResponse({ status: 200, type: AdvancedAnalyticsShellDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a query parameter of any name.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  shell(@Ctx() ctx: RequestContext, @Query() _query: AdvancedAnalyticsShellQueryDto) {
    return this.analytics.shell(ctx);
  }

  @Get('demographics')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Demografi KPM*',
    description: '`MANPOWER_BY_DIMENSION`: manpower on the month’s last day by role (the company’s ladder), work status, '
      + 'gender, age band and tenure band, each summing to manpower, a missing field under *Belum diisi*. With `ab`, '
      + 'over that AB’s Group.',
  })
  @ApiResponse({ status: 200, type: DemographicsDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month or is later than this one.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  demographics(@Ctx() ctx: RequestContext, @Query() query: DemographicsQueryDto) {
    return this.analytics.demographics(ctx, query);
  }

  @Get('mapa')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*MAPA driver*',
    description: 'The forum’s nine rows month by month for a year, through the forum’s own scorecard: each month '
      + 'beside the same month last year and the KPM’s typed target (*TBD* while none), and the year columns with '
      + 'the months not complete (*Belum lengkap*). The recruitment row names the members who joined as new hires '
      + 'where they differ from the upload (D2).',
  })
  @ApiResponse({ status: 200, type: MapaDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `year` that is no year or is later than this one.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  mapa(@Ctx() ctx: RequestContext, @Query() query: MapaQueryDto) {
    return this.analytics.mapa(ctx, query);
  }

  @Get('quant')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Analitik kuantitatif*',
    description: 'The ten metrics A1 to D1 of a semi-annual run, each with the KPM’s value, whether it is complete, the '
      + 'median of the company’s other KPMs with complete data (three needed) and the peer status. A median and a count '
      + 'only: never another KPM’s figure, name or id. The run recalculates until the 15th of the month after its period '
      + 'and is then frozen.',
  })
  @ApiResponse({ status: 200, type: QuantDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `periodEnd` that is no June or December, or has not ended.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  quant(@Ctx() ctx: RequestContext, @Query() query: QuantQueryDto) {
    return this.analytics.quantView(ctx, query);
  }

  @Get('subgroup')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Perbaikan sub-group*',
    description: 'One row per AB’s agency: manpower and leaders, MAA as a baseline, last month and this month as of '
      + 'its upload, the AA and recruitment targets, adoption, power users, one-on-ones a week, the weekly activity '
      + 'target, and recruitment as a baseline and this year.',
  })
  @ApiResponse({ status: 200, type: SubgroupDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a query parameter of any name.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  subgroup(@Ctx() ctx: RequestContext, @Query() _query: SubgroupQueryDto) {
    return this.analytics.subgroup(ctx);
  }

  @Get('events')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Event* — the events’ NPS',
    description: 'Each event with counted feedback in the period — the year to date, or `month` — with its NPS over '
      + 'its confirmed attendees, the average and the count; and the KPM’s NPS for the period over them all. With `ab`, '
      + 'the answers of that AB’s Group. No respondent is named.',
  })
  @ApiResponse({ status: 200, type: EventsNpsDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month or is later than this one.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  events(@Ctx() ctx: RequestContext, @Query() query: EventsQueryDto) {
    return this.analytics.eventsNps(ctx, query);
  }

  @Put('targets/mapa')
  @RequirePermission('advanced_analytics:write')
  @ApiOperation({
    summary: 'Type a MAPA target',
    description: 'A month’s target for one of the forum’s five rows, or `null` — *TBD*. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: MapaTargetDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month, a `row` that takes no target, a `value` that is no whole number from 0.'))
  @ApiResponse(WRITE_403)
  @ApiResponse(refusal(404, '`NOT_FOUND` — *MAPA driver* is off in the template: as another office’s would be.'))
  setMapaTarget(@Ctx() ctx: RequestContext, @Body() body: SetMapaTargetDto) {
    return this.analytics.setMapaTarget(ctx, body);
  }

  @Put('targets/subgroup/:headMembershipId')
  @RequirePermission('advanced_analytics:write')
  @ApiOperation({
    summary: 'Set a head of group’s targets',
    description: 'The AA and recruitment targets of one AB’s agency, whole numbers from 0. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: SubgroupTargetDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a target that is no whole number from 0 to 1000.'))
  @ApiResponse(WRITE_403)
  @ApiResponse(refusal(404, '`NOT_FOUND` — no active AB of this office with this id, or *Perbaikan sub-group* is off. Indistinguishable from another office’s.'))
  setSubgroupTarget(
    @Ctx() ctx: RequestContext, @Param('headMembershipId') headMembershipId: string, @Body() body: SetSubgroupTargetDto,
  ) {
    return this.analytics.setSubgroupTarget(ctx, headMembershipId, body);
  }
}

const AUDITED = ` **Audited per visit** as \`${PLATFORM_READ.ACTION.kpmAdvancedAnalytics}\` (ADR-0207 §5): one entry in the `
  + 'platform’s log and one in the KPM’s, written before the answer is sent. Read-only: nothing in the KPM is written.';

/**
 * **The Super Admin's *Advanced analytics* tab on a KPM** (P19.5-T3 AC-12; ADR-0215 §9): *Lihat sebagai KPM*, read-only,
 * under `platform_kpm_figures:read`. Its own controller, so the platform reads' inventory keeps naming no survey.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/tenants/:id/advanced-analytics')
export class AdminAdvancedAnalyticsController {
  constructor(private readonly reads: AdminAdvancedAnalytics) {}

  @Get()
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: '*Lihat sebagai KPM* — the KPM’s Advanced analytics tabs',
    description: 'Exactly what `GET /kpm/advanced-analytics` answers the KPM’s Owner, with `canWrite` and `canUpload` false.' + AUDITED,
  })
  @ApiResponse({ status: 200, type: AdvancedAnalyticsShellDto })
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id: indistinguishable from another office’s.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role, and a support session.'))
  @ApiResponse(refusal(500, '`INTERNAL_ERROR` — the visit’s audit entries could not be written, so the read is not served.'))
  shell(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() _query: AdvancedAnalyticsShellQueryDto) {
    return this.reads.read(ctx, id, 'shell', {});
  }

  @Get(':section')
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: '*Lihat sebagai KPM* — one section of the KPM’s Advanced analytics',
    description: 'Exactly what `GET /kpm/advanced-analytics/<section>` answers the KPM’s Owner, through the same '
      + 'function over the KPM, with no control that writes. `nps` and `qual` are summaries: counts, scores and '
      + 'percentages — never a person’s answer, an anonymous run’s rows, an open answer or *Dukungan leader* (A-R9).'
      + AUDITED,
  })
  @ApiResponse({ status: 200, type: AdminAdvancedAnalyticsSectionDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a parameter its section refuses, or of any other name.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id; a section unknown or off in its template; an `ab` or a run the KPM does not hold. Indistinguishable from another office’s.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role, and a support session.'))
  @ApiResponse(refusal(500, '`INTERNAL_ERROR` — the visit’s audit entries could not be written, so the read is not served.'))
  section(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Param('section') section: string,
    @Query() query: AdminAdvancedAnalyticsQueryDto,
  ) {
    return this.reads.read(ctx, id, section, query);
  }
}
