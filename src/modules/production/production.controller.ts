import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import {
  IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateIf,
} from 'class-validator';
import { PRODUCTION_METRICS, type ProductionMetric } from './monthly-agent-data.schema';
import { CADENCES, type Cadence } from './production-preview';
import { ProductionCorrections } from './production-correction.service';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { XLSX_MIME_TYPE } from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { PRODUCTION_REFUSALS } from './production.messages';
import {
  CorrectionResultDto, HistoryDto, ImportResultDto, MonthStateDto, MonthViewDto, TemplateFileDto,
  UploadPreviewDto,
} from './production.response.dto';
import { ProductionImportService } from './production-import.service';
import { ProductionMonths } from './production-months.service';
import { ProductionUploadInterceptor, type FileUpload } from './production-upload.interceptor';
import { ProductionService, requireMonth, requireOffice } from './production.service';

/**
 * **`GET /kpm/data-upload/template`'s query** (S4 of the T17–T20 permission review): `month`, checked as a month by the
 * service, and `format`, `xlsx` or absent for the JSON. Each a string or nothing, so an operator object is a 400, and
 * any other query field is refused by name.
 */
class TemplateFileQueryDto {
  @IsOptional()
  @IsString()
  month?: string;

  @IsOptional()
  @IsIn(['xlsx'], { message: field(PRODUCTION_REFUSALS.VALIDATION_FAILED.unknownFormat) })
  format?: 'xlsx';
}

/** The multipart form's text field. The file is `file`, read by the interceptor. */
class PreviewUploadDto {
  @IsString()
  month!: string;
}

/** Confirm import: the same form as the preview, and the revision the preview was taken against. */
class CommitUploadDto {
  @IsString()
  month!: string;

  @IsString()
  revision!: string;

  /**
   * The corrections by hand to replace with the file's figure, as `membershipId:field` joined by
   * commas — `66f…101:apeMonthly`. Absent, every correction stays (ADR-0053).
   */
  @IsOptional()
  @IsString()
  replace?: string;
}

class RevertDto {
  @IsString()
  batchId!: string;
}

/** One figure, in the unit it is stored in — money in sen — or `null` to clear it. */
class CorrectCellDto {
  @IsString()
  month!: string;

  @IsString()
  membershipId!: string;

  @IsIn(PRODUCTION_METRICS)
  metric!: ProductionMetric;

  @IsIn(CADENCES)
  cadence!: Cadence;

  /** Required, and `null` to clear: an absent value is not a request to empty a figure. */
  @ValidateIf((o: CorrectCellDto) => o.value !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  value!: number | null;

  @IsInt()
  @Min(0)
  revision!: number;

  @IsString()
  @MaxLength(500)
  reason!: string;
}

/**
 * The office's monthly production (P9-T1 to P9-T5).
 *
 * **Nine routes, one screen.** `/kpm/data-upload` reads the month, downloads the template, previews
 * and confirms a filled one, lists and reverts imports, locks and reopens the month, and corrects one
 * figure by hand. No endpoint here waits for a consumer (`check-api-consumers.py`).
 */
@ApiTags('production')
@ApiBearerAuth()
@Controller('kpm/data-upload')
export class ProductionController {
  constructor(
    private readonly production: ProductionService,
    private readonly imports: ProductionImportService,
    private readonly months: ProductionMonths,
    private readonly corrections: ProductionCorrections,
  ) {}

  /**
   * **Declared before `:month`, and that is load-bearing.** Nest matches routes in declaration order,
   * so `GET /kpm/data-upload/template` declared second would reach `readMonth` with the word
   * *template* as its month — refused as a bad month, which is the wrong answer to a right request.
   * The roster template sits above `:id` in `admin.controller.ts` for the same reason.
   */
  @Get('template')
  @RequirePermission('data_upload:download_template')
  @ApiOperation({
    summary: 'The file to fill in for a month',
    description:
      'The header that is the contract — code, name, six metrics monthly, the same six YTD, in the '
      + 'prototype’s own order — and one row per active agent with twelve empty fields. A name is '
      + 'one quoted field: a quote inside it is doubled, a line break becomes a space, and a name '
      + 'that starts like a formula is written as text. The agent code is written exactly as '
      + 'stored. **The header is the version**: there is no version line, and an importer '
      + 'identifies a file by its header cells.',
  })
  @ApiQuery({ name: 'month', type: String, example: '2026-09', description: '`YYYY-MM`, the office’s calendar month. Names the file; the rows are the same for every month.' })
  @ApiQuery({
    name: 'format', required: false, enum: ['xlsx'],
    description: 'Absent: the JSON below, whose `file` is the CSV. `xlsx`: the same header and rows as an Excel workbook '
      + '(ADR-0184) — its *Data* sheet, with the guide on a sheet of its own in the reader’s language — answered as the '
      + 'file itself, `attachment; filename="KPM0417-agent-data-Sep-2026.xlsx"`. Anything else is `400 VALIDATION_FAILED`.',
  })
  @ApiProduces('application/json', XLSX_MIME_TYPE)
  @ApiResponse({ status: 200, type: TemplateFileDto })
  async template(@Ctx() ctx: RequestContext, @Query() query: TemplateFileQueryDto) {
    const month = query.month ?? '';
    if (query.format === 'xlsx') {
      const { filename, bytes } = await this.production.workbook(ctx, month);
      return new StreamableFile(bytes, { type: XLSX_MIME_TYPE, disposition: `attachment; filename="${filename}"` });
    }
    return this.production.template(ctx, month);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data_upload:upload_and_preview')
  @UseInterceptors(ProductionUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['month', 'file'],
      properties: {
        month: { type: 'string', example: '2026-09', description: '`YYYY-MM`, the month the figures are for.' },
        file: { type: 'string', format: 'binary', description: 'The filled template, as it was saved — an Excel workbook (.xlsx) or a CSV. At most 1 MiB.' },
      },
    },
  })
  @ApiOperation({
    summary: 'What a filled file would change, before anything does',
    description:
      'Reads the file as bytes. **An Excel workbook** (ADR-0184) is opened only after its parts, as its own directory '
      + 'declares them, are checked to unpack to at most 25 MiB in at most 1,000 parts (`ASSET_TOO_LARGE`, 413, '
      + 'otherwise), and its *Data* sheet is read, at most 10,000 rows (`format: \'xlsx\'`). **A CSV** is read as UTF-8, '
      + 'or Windows-1252 when it is not valid UTF-8, with a comma, semicolon or tab delimiter. Either way the header is '
      + 'checked cell by cell against every template ever issued (ADR-0052). **Writes nothing.** Answers every data row against the roster and what is '
      + 'stored: a row is `refused` when it cannot be attributed to exactly one active member; a ready '
      + 'row carries twelve cells, each `new`, `changed`, `unchanged`, `not_provided` or `refused`, '
      + 'with the reason on the row. A blank cell is not provided and would change nothing (ADR-0051). '
      + '`UPLOAD_TEMPLATE_MISMATCH` and `UPLOAD_MALFORMED_CSV` (422) refuse the whole file; '
      + '`ASSET_TOO_LARGE` (413) above 1 MiB.',
  })
  @ApiResponse({ status: 200, type: UploadPreviewDto })
  async preview(
    @Ctx() ctx: RequestContext,
    @Body() body: PreviewUploadDto,
    @UploadedFile() file?: FileUpload,
  ) {
    return this.production.preview(ctx, body.month, file);
  }

  @Post('commit')
  @RequirePermission('data_upload:commit_import')
  @UseInterceptors(ProductionUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['month', 'revision', 'file'],
      properties: {
        month: { type: 'string', example: '2026-09' },
        revision: { type: 'string', example: '4', description: 'The `revision` the preview answered with.' },
        replace: { type: 'string', example: '66f000000000000000000101:apeMonthly', description: 'Corrections by hand to replace, `membershipId:field`, comma-separated. Absent: every correction stays (ADR-0053).' },
        file: { type: 'string', format: 'binary', description: 'The same file that was previewed.' },
      },
    },
  })
  @ApiOperation({
    summary: 'Confirm import: write what the preview showed',
    description:
      'Reads the file again against what is stored now, and writes each `new` and `changed` figure as '
      + '`imported`, with this batch as its source. A blank is not written (ADR-0051). The batch and its '
      + 'rows — every figure’s previous value — are written before any figure changes, and a failure '
      + 'part-way puts back what was written. `VERSION_CONFLICT` (409) when the month has moved since '
      + 'the preview; `UPLOAD_BATCH_ALREADY_COMMITTED` (409) for the same file against the same '
      + 'revision; `UPLOAD_MONTH_LOCKED` (409); `VALIDATION_FAILED` (400) when the file would change '
      + 'nothing; the preview’s own refusals for the file itself.',
  })
  @ApiResponse({ status: 201, type: ImportResultDto })
  async commit(
    @Ctx() ctx: RequestContext,
    @Body() body: CommitUploadDto,
    @UploadedFile() file?: FileUpload,
  ) {
    return this.imports.commit(ctx, body.month, body.revision, file, body.replace);
  }

  @Post('revert')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data_upload:revert_batch')
  @ApiOperation({
    summary: 'Revert an import',
    description:
      'Puts every figure the import wrote back to exactly what it was, empty included. Only the '
      + 'month’s latest standing import — `UPLOAD_BATCH_NOT_LATEST` (409) otherwise — and a figure '
      + 'written since by something else is kept and counted. `UPLOAD_NOTHING_TO_REVERT` (409) for one '
      + 'already reverted; `UPLOAD_MONTH_LOCKED` (409); `NOT_FOUND` (404) for another office’s.',
  })
  @ApiResponse({ status: 200, type: ImportResultDto })
  async revert(@Ctx() ctx: RequestContext, @Body() body: RevertDto) {
    return this.imports.revert(ctx, body.batchId);
  }

  /** Declared above `:month`, for the same reason `template` is. */
  @Get('history')
  @RequirePermission('data_upload:read_history')
  @ApiOperation({ summary: 'Every import of a month that went through, newest first' })
  @ApiQuery({ name: 'month', example: '2026-09' })
  @ApiResponse({ status: 200, type: HistoryDto })
  async history(@Ctx() ctx: RequestContext, @Query('month') month: string) {
    return this.imports.history(ctx, month ?? '');
  }

  @Post('months/:month/lock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data_upload:lock_month')
  @ApiOperation({
    summary: 'Lock a month now',
    description: 'Ahead of its schedule, or again after a reopen. Audited. A month already locked is answered as it is (ADR-0050).',
  })
  @ApiParam({ name: 'month', example: '2026-09' })
  @ApiResponse({ status: 200, type: MonthStateDto })
  async lock(@Ctx() ctx: RequestContext, @Param('month') month: string) {
    requireOfficeAndMonth(ctx, month);
    return this.months.lock(ctx, month);
  }

  @Post('months/:month/reopen')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('data_upload:reopen_month')
  @ApiOperation({
    summary: 'Reopen a locked month',
    description: 'It stays open until somebody locks it again. Audited. A month already open is answered as it is (ADR-0050).',
  })
  @ApiParam({ name: 'month', example: '2026-09' })
  @ApiResponse({ status: 200, type: MonthStateDto })
  async reopen(@Ctx() ctx: RequestContext, @Param('month') month: string) {
    requireOfficeAndMonth(ctx, month);
    return this.months.reopen(ctx, month);
  }

  @Patch('cell')
  @RequirePermission('data_upload:correct_cell')
  @ApiOperation({
    summary: 'Correct one figure by hand',
    description:
      'Writes the figure as `corrected`, with who, when and the reason, and an audit entry carrying the '
      + 'figure before and after. `value: null` clears it — the only way a figure is cleared '
      + '(ADR-0051). The same range rules as the import: `UPLOAD_VALUE_OUT_OF_RANGE` (422) names the '
      + 'figure and what is wrong. `UPLOAD_MONTH_LOCKED` / `VERSION_CONFLICT` (409); `NOT_FOUND` (404) '
      + 'for somebody who is not an active member of the office; `VALIDATION_FAILED` (400) without a '
      + 'reason. A figure already holding that value is answered `changed: false`, and nothing is written.',
  })
  @ApiResponse({ status: 200, type: CorrectionResultDto })
  async correct(@Ctx() ctx: RequestContext, @Body() body: CorrectCellDto) {
    return this.corrections.correct(ctx, body);
  }

  @Get(':month')
  @RequirePermission('data_upload:read')
  @ApiOperation({
    summary: 'The office’s production for a month',
    description:
      'Every active member, with the six metrics in their monthly and year-to-date figures and '
      + 'the provenance of each cell. **`null` is not zero**: a cell nothing has written says the '
      + 'carrier has not reported this person, where `0` says it reported nothing. Reads only — '
      + 'the file, the correction and the revert each have their own route.',
  })
  @ApiParam({ name: 'month', example: '2026-09', description: '`YYYY-MM`, the office’s calendar month.' })
  @ApiResponse({ status: 200, type: MonthViewDto })
  async readMonth(@Ctx() ctx: RequestContext, @Param('month') month: string) {
    return this.production.readMonth(ctx, month);
  }
}

function requireOfficeAndMonth(ctx: RequestContext, month: string): void {
  requireOffice(ctx);
  requireMonth(month);
}
