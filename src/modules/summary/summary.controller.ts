import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { SummaryDto } from './summary.response.dto';
import { SummaryService } from './summary.service';

/**
 * **Empty on purpose**: the Summary is your own, and a class with no fields is how the validation pipe
 * refuses a `membershipId` by name rather than ignoring it.
 */
export class SummaryQueryDto {}

/** The Personal Summary (P10). */
@ApiTags('summary')
@ApiBearerAuth()
@Controller('summary')
export class SummaryController {
  constructor(private readonly summary: SummaryService) {}

  @Get()
  @RequirePermission('personal_summary:read')
  @ApiOperation({
    summary: 'Your Personal Summary (P10-T4)',
    description:
      'Your goal against what you produced, this month and this year, the gap, and the pace — read from '
      + 'your goal, the office’s production and your own log. **Your own, only**: there is no '
      + '`membershipId`, and a leader’s view of a downline’s is Phase 13’s coaching copy.',
  })
  @ApiResponse({ status: 200, type: SummaryDto })
  // The query is validated, and empty: anything sent is refused by name.
  async read(@Ctx() ctx: RequestContext, @Query() _query: SummaryQueryDto) {
    return this.summary.read(ctx);
  }
}
