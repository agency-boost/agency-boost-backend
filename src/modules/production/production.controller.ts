import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { MonthViewDto, TemplateFileDto, UploadPreviewDto } from './production.response.dto';
import { ProductionUploadInterceptor, type UploadedCsv } from './production-upload.interceptor';
import { ProductionService } from './production.service';

/** The multipart form's text field. The file is `file`, read by the interceptor. */
class PreviewUploadDto {
  @IsString()
  month!: string;
}

/**
 * The office's monthly production (P9-T1, P9-T2, P9-T3).
 *
 * **Three routes, one screen.** `/kpm/data-upload` reads the month, downloads the template and
 * previews a filled one; commit, correct and revert arrive with the tasks that give each a control on
 * that screen, so no endpoint here waits for a consumer (`check-api-consumers.py`).
 */
@ApiTags('production')
@ApiBearerAuth()
@Controller('kpm/data-upload')
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

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
