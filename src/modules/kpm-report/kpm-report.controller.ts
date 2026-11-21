import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { KpmReportLinkDto, KpmReportQueryDto } from './kpm-report.dto';
import { KpmReportLinkViewDto } from './kpm-report.response.dto';
import { KpmReportService, type KpmReportFile } from './kpm-report.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const AUDITED = ' Audited in the platform\'s log and the KPM\'s, written before the answer is sent: a failure fails the request.';

/** The file as the answer: `application/pdf`, an attachment, never cached. */
const fileOf = (file: KpmReportFile) =>
  new StreamableFile(file.bytes, { type: 'application/pdf', disposition: file.disposition, length: file.bytes.length });

/**
 * ***Laporan KPM*** **in the Super Admin console** (P19.24-T1, T2; ADR-0280): the PDF icon on each KPM of the Dashboard's
 * *Adopsi per KPM* and inside a KPM opens a dialog — the month, *Unduh PDF* and *Kirim ke owner*. `kpm_report:read`, the
 * Super Admin's alone.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/tenants/:id/report')
export class AdminKpmReportController {
  constructor(private readonly reports: KpmReportService) {}

  @Get()
  @RequirePermission('kpm_report:read')
  @Header('Cache-Control', 'no-store, private')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: '*Unduh PDF* — the KPM report for a month',
    description: 'One A4 PDF (the approved template, ~20 pages) for any KPM of any company and a month — the KPM\'s or one '
      + 'of the twelve before it — read as the KPM\'s Owner sees its pages: every figure the page\'s own reading, test '
      + 'accounts never counted. Built now and kept nowhere. `Content-Disposition: attachment`, '
      + '`Laporan-KPM-{KPM}-{YYYY-MM}.pdf`.' + AUDITED,
  })
  // The 200 is the file alone (`application/pdf`, `response-map.ts`); the refusals are the envelope, as everywhere.
  @ApiResponse({ status: 200, description: 'The file.' })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `month` missing, not `YYYY-MM`, after the KPM\'s month or more than twelve before it.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role, and a support session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id: indistinguishable from another office’s.'))
  @ApiResponse(refusal(500, '`INTERNAL_ERROR` — the report\'s audit entries could not be written, so it is not served.'))
  async pdf(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: KpmReportQueryDto) {
    return fileOf(await this.reports.pdf(ctx, id, query.month));
  }

  @Post('link')
  @RequirePermission('kpm_report:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '*Kirim ke owner* — a link to the KPM report, for WhatsApp',
    description: 'Nothing is sent (OD-359): the answer is the link the Super Admin\'s own WhatsApp carries to the KPM\'s '
      + 'Owner — `<app>/laporan-kpm/<token>`, signed, alive `KPM_REPORT.LINK_TTL_DAYS` (7), opened only by the KPM\'s '
      + 'Owner or a KPM Admin signed in (`GET /kpm-report/shared/:token`) — and the Owner\'s name and number for the '
      + 'message. The token is in this answer and nowhere else.' + AUDITED,
  })
  @ApiResponse({ status: 200, type: KpmReportLinkViewDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `month` missing, not `YYYY-MM`, or outside the KPM\'s thirteen months.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role, and a support session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id: indistinguishable from another office’s.'))
  async link(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: KpmReportLinkDto) {
    return this.reports.link(ctx, id, body.month);
  }
}

/**
 * **The *Kirim ke owner* link, opened** (P19.24-T2 AC-1; ADR-0280 §5; OD-428): the KPM's Owner or a KPM Admin, signed in,
 * in that KPM. The token is redacted from every log line (`redact-url.ts`).
 */
@ApiTags('KPM report')
@ApiBearerAuth()
@Controller('kpm-report')
export class KpmReportLinkController {
  constructor(private readonly reports: KpmReportService) {}

  @Get('shared/:token')
  @RequirePermission('kpm_report:download_link')
  @Header('Cache-Control', 'no-store, private')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Open a KPM report link (the Owner)',
    description: 'The report the link names — its KPM and month — built now, as the Super Admin who sent it would build '
      + 'it. Only the KPM\'s Owner or a KPM Admin, signed in in that KPM; a view-as session is refused (it opens the report '
      + 'and cannot take it away). Rate limited per account, thirty an hour.' + AUDITED,
  })
  @ApiResponse({ status: 200, description: 'The file.' })
  @ApiResponse(refusal(403, '`PERM_DENIED` — a role other than the Owner and the Admins, and a view-as session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — the link is not valid or has expired, its sender is no longer a Super Admin, '
    + 'its KPM is gone, or the reader is not this KPM\'s Owner or Admin — said in plain words, as a link into another office is answered.'))
  @ApiResponse(refusal(429, '`AUTH_RATE_LIMITED` — too many links opened by this account within the hour.'))
  async open(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    return fileOf(await this.reports.openLink(ctx, token));
  }
}
