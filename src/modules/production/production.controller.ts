import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { MonthViewDto, TemplateFileDto } from './production.response.dto';
import { ProductionService } from './production.service';

/**
 * The office's monthly production (P9-T1, P9-T2).
 *
 * **Two routes, one screen.** `/kpm/data-upload` reads the month and downloads the template; the
 * preview, commit, correct and revert routes arrive with the tasks that give each a control on that
 * screen, so no endpoint here waits for a consumer (`check-api-consumers.py`).
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
