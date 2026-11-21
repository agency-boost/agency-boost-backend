import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { PLATFORM_READ } from '@/domain/constants';
import {
  AdminAdvancedAnalyticsQueryDto, AdvancedAnalyticsShellQueryDto, DemographicsQueryDto, DemographicsUploadDto, EventsQueryDto,
  MapaQueryDto, QuantQueryDto, SubgroupPeopleQueryDto, SubgroupQueryDto,
} from './advanced-analytics.dto';
import {
  AdminAdvancedAnalyticsSectionDto, AdvancedAnalyticsShellDto, DemographicsDto, DemographicsFileDto,
  DemographicsUploadDto as DemographicsUploadResultDto, EventsNpsDto, MapaDto, QuantDto, SubgroupDto, SubgroupSheetDto,
} from './advanced-analytics.response.dto';
import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { AdminAdvancedAnalytics } from './admin-advanced-analytics.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * Who reads the page (ADR-0215 §2 as ADR-0268 §1 and ADR-0275 §1 amend it): the KPM's stewards — the Super Admin inside
 * the KPM, the Owner, the Admins and a core leader; any other leader is 404.
 */
const READ_403 = refusal(
  403,
  '`TENANT_NO_MEMBERSHIP` — a Super Admin who has not entered a KPM (`X-Kpm-Id`). `PERM_DENIED` — a role without the '
  + 'permission: an Agent.',
);
const READ_404 = refusal(
  404,
  '`NOT_FOUND` — an AB or an AAB who is not a core leader (roles §3.9 ¶); a section the template has switched off; an '
  + '`ab` this office does not hold. Indistinguishable from another office’s.',
);
const WRITE_403 = refusal(
  403,
  '`PERM_DENIED` — every role but the KPM’s stewards. `IMPERSONATION_READ_ONLY` — a view-as session.',
);

/**
 * **The KPM's *Advanced analytics* page** (P19.5-T3, P19.22; ADR-0215, ADR-0275; `functional/advanced-analytics.md`, the
 * Data contract): the shell, *Demografi* with its list and upload, *MAPA driver*, *Analisa kuantitatif*, *Informal group*
 * with its sheets, and *Event*. *NPS* and *Analisa kualitatif* are `SurveyRunsController`'s, on the same prefix. The typed
 * MAPA targets (`PUT targets/mapa`) are gone: the targets are the AB groups' (ADR-0275 §3).
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
    summary: '*Demografi*',
    description: 'ADR-0275 §2: the summary — *Total manpower*, *Data lengkap* (*Status kerja*, *Tanggal lahir* '
      + 'and *Tanggal bergabung* on file), *Perlu melengkapi* — `MANPOWER_BY_DIMENSION` on the month’s last day by role, '
      + 'work status, gender, age band and tenure band, a missing field under *Belum diisi*; *Kelengkapan data* per field, '
      + 'Leader vs Agent; and *Data anggota*, the incomplete first, with each one’s WhatsApp number for *Kirim pengingat*. '
      + 'With `ab`, over that AB’s Group. Test accounts are never counted or listed.',
  })
  @ApiResponse({ status: 200, type: DemographicsDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month or is later than this one.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  demographics(@Ctx() ctx: RequestContext, @Query() query: DemographicsQueryDto) {
    return this.analytics.demographics(ctx, query);
  }

  @Get('demographics/file')
  @RequirePermission('advanced_analytics:write')
  @ApiOperation({
    summary: '*Unduh daftar (CSV)*',
    description: 'One row per active member — *Kode agen, Nama, Peran, Upline, Status kerja, Tanggal lahir, '
      + 'Tanggal bergabung* — with what is on file, as `{ filename, file }`. A name that starts like a formula is written as '
      + 'text. The KPM’s stewards.',
  })
  @ApiResponse({ status: 200, type: DemographicsFileDto })
  @ApiResponse(WRITE_403)
  @ApiResponse(READ_404)
  demographicsFile(@Ctx() ctx: RequestContext) {
    return this.analytics.demographicsFile(ctx);
  }

  @Post('demographics/upload')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('advanced_analytics:write')
  @ApiOperation({
    summary: '*Upload* — the filled list',
    description: 'ADR-0275 §2; OD-413: each row is the member with its *Kode agen* in this KPM; a filled cell '
      + 'writes its field (*Status kerja* Full-time / Part-time; *Tanggal lahir*, *Tanggal bergabung* `dd/mm/yyyy`), an '
      + 'empty one changes nothing. Checked as the profile checks them; a core leader changes their own downline only. '
      + 'Each member changed is audited `member.personal_completed`, before and after. Answers each row’s outcome.',
  })
  @ApiResponse({ status: 200, type: DemographicsUploadResultDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — no `file`, one over 90,000 bytes, or one whose header has no *Kode agen*.'))
  @ApiResponse(refusal(422, '`UPLOAD_MALFORMED_CSV` — a quote opened and never closed.'))
  @ApiResponse(WRITE_403)
  @ApiResponse(READ_404)
  uploadDemographics(@Ctx() ctx: RequestContext, @Body() body: DemographicsUploadDto) {
    return this.analytics.uploadDemographics(ctx, body);
  }

  @Get('mapa')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*MAPA driver*',
    description: 'ADR-0275 §3: *Bulan ini vs target* (APE, Active Agent, Rekrut), then eight rows — APE, '
      + '**M** Manpower and Rekrut, **A** Active Agent and *% agent baru aktif dalam 3 bulan*, **P** Polis terbit and Polis '
      + 'per Active Agent, **A** Nilai rata-rata polis — each with YTD last year · YTD this year (APE’s the total, every '
      + 'other the average per month) and the same month last year · last month · this month, each change in % (points for '
      + 'a percentage), and the read-only monthly target: Active Agent and Rekrut the sums of the AB groups’ targets, APE '
      + 'the members’ Goal Setting ÷ 12. Rekrut is `RECRUITS_JOINED`.',
  })
  @ApiResponse({ status: 200, type: MapaDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month, later than this one, or before January of last year.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  mapa(@Ctx() ctx: RequestContext, @Query() query: MapaQueryDto) {
    return this.analytics.mapa(ctx, query);
  }

  @Get('quant')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Analisa kuantitatif*',
    description: 'ADR-0275 §4: the ten metrics A1 to D1 of a half-year, each with the KPM’s value, whether it '
      + 'is complete, the median of the company’s other KPMs with complete data over the same months (three needed), the '
      + 'peer status, *Semester lalu*, and **its distribution per leader** — each leader’s value over their own unit, high '
      + 'to low, named and pictured, their median and how many stand at or above it. A peer median and a count only: never '
      + 'another KPM’s figure, name or id. The run recalculates until the 15th of the month after it, then is frozen.',
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
    summary: '*Informal group*',
    description: 'ADR-0275 §5: for `month`, *Total KPM*, then one card per informal group A to Z and *Tanpa '
      + 'group*, each with its AB groups — every scope with four drivers coloured by progress (green ≥100%, yellow ≥67%, '
      + 'red below): Monthly Active Agent MTD vs target, Pemakaian AgencyBoost (downline %, leader %), 1-on-1 per minggu '
      + '(sessions in 30 days ÷ 4,35 vs 2 × the Active Agent target) and Rekrut YTD vs target. The targets are the AB '
      + 'groups’ own, summed — the same as KPM Overview › *Performa vs target*. Test accounts are never counted.',
  })
  @ApiResponse({ status: 200, type: SubgroupDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month or is later than this one.'))
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  subgroup(@Ctx() ctx: RequestContext, @Query() query: SubgroupQueryDto) {
    return this.analytics.subgroup(ctx, query);
  }

  @Get('subgroup/people')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Informal group* — the people behind one number of an AB group',
    description: '`maa` who is active (APE, polis) and who is not yet, nearest first; `usage` who has not '
      + 'used the app in 30 days, then who has, power users ★ first; `coaching` never, more than 14 days, within 14 days; '
      + '`rekrut` who joined this year and who recruited them, and the recruit potential in Leads. With the AB’s WhatsApp '
      + 'number for *WhatsApp {AB} · kirim daftar ini*.',
  })
  @ApiResponse({ status: 200, type: SubgroupSheetDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — no `ab`, a `driver` of another name, a bad `month`.'))
  @ApiResponse(READ_403)
  @ApiResponse(refusal(404, '`NOT_FOUND` — an `ab` that heads no AB group of this office; an AB or an AAB who is not a '
    + 'core leader (roles §3.9 ¶); a section the template has switched off. Indistinguishable from another office’s.'))
  subgroupPeople(@Ctx() ctx: RequestContext, @Query() query: SubgroupPeopleQueryDto) {
    return this.analytics.subgroupPeople(ctx, query);
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
