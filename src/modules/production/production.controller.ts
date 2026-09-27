import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import {
  HistoryDto, ImportResultDto, MonthStateDto, MonthViewDto, TemplateFileDto, UploadPreviewDto,
} from './production.response.dto';
import { ProductionImportService } from './production-import.service';
import { ProductionMonths } from './production-months.service';
import { ProductionUploadInterceptor, type UploadedCsv } from './production-upload.interceptor';
import { ProductionService, requireMonth, requireOffice } from './production.service';

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
}

class RevertDto {
  @IsString()
  batchId!: string;
}

/**
 * The office's monthly production (P9-T1 to P9-T4).
 *
 * **Eight routes, one screen.** `/kpm/data-upload` reads the month, downloads the template, previews
 * and confirms a filled one, lists and reverts imports, and locks and reopens the month. Correction
 * arrives with P9-T5, with the control that calls it (`check-api-consumers.py`).
 */
@ApiTags('production')
@ApiBearerAuth()
@Controller('kpm/data-upload')
export class ProductionController {
  constructor(
    private readonly production: ProductionService,
    private readonly imports: ProductionImportService,
    private readonly months: ProductionMonths,
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
  @ApiQuery({ name: 'month', example: '2026-09', description: '`YYYY-MM`, the office’s calendar month. Names the file; the rows are the same for every month.' })
  @ApiResponse({ status: 200, type: TemplateFileDto })
  async template(@Ctx() ctx: RequestContext, @Query('month') month: string) {
    return this.production.template(ctx, month ?? '');
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
        file: { type: 'string', format: 'binary', description: 'The filled template, as it was saved. At most 1 MiB.' },
      },
    },
  })
  @ApiOperation({
    summary: 'What a filled file would change, before anything does',
    description:
      'Reads the file as bytes — UTF-8, or Windows-1252 when it is not valid UTF-8 — with a comma, '
      + 'semicolon or tab delimiter, and checks its header cell by cell against every template ever '
      + 'issued (ADR-0052). **Writes nothing.** Answers every data row against the roster and what is '
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
    @UploadedFile() file?: UploadedCsv,
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
    @UploadedFile() file?: UploadedCsv,
  ) {
    return this.imports.commit(ctx, body.month, body.revision, file);
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
