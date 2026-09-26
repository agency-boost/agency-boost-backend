import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { MonthViewDto } from './production.response.dto';
import { ProductionService } from './production.service';

/**
 * The office's monthly production (P9-T1).
 *
 * **One route, one screen.** `/kpm/data-upload` reads it; the download, preview, commit, correct and
 * revert routes arrive with the tasks that give each a control on that screen, so no endpoint here
 * waits for a consumer (`check-api-consumers.py`).
 */
@ApiTags('production')
@ApiBearerAuth()
@Controller('kpm/data-upload')
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

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
