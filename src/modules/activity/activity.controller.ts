import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import {
  ActivityComplianceQueryDto, ActivityDashboardQueryDto, ActivityRatiosQueryDto, ActivitySummaryQueryDto,
  CorrectActivityDayDto,
  ReadActivityDayQueryDto, SaveActivityDayDto,
} from './activity.dto';
import {
  ActivityComplianceDto, ActivityDashboardDto, ActivityDayDto, ActivityRatiosDto, ActivitySummaryDto,
} from './activity.response.dto';
import { ActivityService } from './activity.service';

/**
 * What an agent did, day by day (P6).
 *
 * **Reading is wide and writing is narrow.** A leader reads a downline's rows because coaching
 * depends on it; nobody writes anybody else's, and the write routes carry no subject to pass
 * (`roles-and-permissions.md` §3.5).
 */
@ApiTags('activity')
@ApiBearerAuth()
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get('log')
  @RequirePermission('activity_log:read_raw')
  @ApiOperation({
    summary: 'One day',
    description:
      'Defaults to **today in the office’s timezone** and to your own membership. Every active '
      + 'activity type comes back, zeros included — the screen is the office’s taxonomy, so a type '
      + 'with no count still has a row to type into. `editable` says whether the Save button is '
      + 'live for this caller on this day.',
  })
  @ApiResponse({ status: 200, type: ActivityDayDto })
  async readDay(@Ctx() ctx: RequestContext, @Query() query: ReadActivityDayQueryDto) {
    return this.activity.readDay(ctx, query);
  }

  @Put('log')
  @RequirePermission('activity_log:create')
  @ApiOperation({
    summary: 'Save your own day',
    description:
      'An upsert: the whole day is sent, and a code left out counts as zero. Free within the '
      + 'current calendar month plus the office’s grace window; **a future day is refused**, and a '
      + 'day past its window is refused with a pointer at the correction route (ADR-0042).\n\n'
      + '**There is no `membershipId` parameter.** No role may log on another person’s behalf, and '
      + 'a route with no subject to pass is a stronger guarantee than a check somebody has to '
      + 'remember.',
  })
  @ApiResponse({ status: 200, type: ActivityDayDto })
  async saveDay(@Ctx() ctx: RequestContext, @Body() dto: SaveActivityDayDto) {
    return this.activity.saveDay(ctx, dto);
  }

  @Post('log/correction')
  @RequirePermission('activity_log:update')
  @ApiOperation({
    summary: 'Correct a frozen day',
    description:
      'For a day whose window has closed. The **whole prior state** moves into the record’s '
      + 'correction list — not a diff — so a leader who coached against Tuesday’s numbers can '
      + 'still read Tuesday’s numbers. A reason is required.',
  })
  @ApiResponse({ status: 201, type: ActivityDayDto })
  async correctDay(@Ctx() ctx: RequestContext, @Body() dto: CorrectActivityDayDto) {
    return this.activity.correctDay(ctx, dto);
  }

  @Get('summary')
  @RequirePermission('activity_ratios:read')
  @ApiOperation({
    summary: 'Totals per activity code over a period',
    description:
      'The read Phase 10’s dashboard and ratio cards will use. Periods are the **named** ones '
      + '(ADR-0022), resolved in the office’s timezone: a rolling window is never labelled *this '
      + 'month*. `from`/`to` override `period` for a custom range.',
  })
  @ApiResponse({ status: 200, type: ActivitySummaryDto })
  async summary(@Ctx() ctx: RequestContext, @Query() query: ActivitySummaryQueryDto) {
    return this.activity.summary(ctx, query);
  }

  @Get('dashboard')
  @RequirePermission('activity_log:read_raw')
  @ApiOperation({
    summary: 'Your own activity over a range, per type and per column (P10-T1)',
    description:
      '*Last 7 days* (the default), *Last 30 days*, or a custom range of up to 366 days, ending today in '
      + 'the office’s timezone. Seven days is a column a day; thirty days is 7-day blocks counted back '
      + 'from today and a remainder; a custom range is daily up to 31 days and blocks above.\n\n'
      + '**There is no `membershipId` parameter.** The screen is first-person; a leader’s view of a '
      + 'downline is Phase 13’s, where the read audit `roles-and-permissions.md` §3.5 requires is built.',
  })
  @ApiResponse({ status: 200, type: ActivityDashboardDto })
  async dashboard(@Ctx() ctx: RequestContext, @Query() query: ActivityDashboardQueryDto) {
    return this.activity.dashboard(ctx, query);
  }

  @Get('ratios')
  @RequirePermission('activity_ratios:read')
  @ApiOperation({
    summary: 'The office’s ratios over the last 30 days (P10-T2)',
    description:
      'Every active ratio of the office **that applies to the subject’s rung** (ADR-0020), computed over '
      + '`ROLLING_30D` — fixed, ending today in the office’s timezone — with the office’s own formula and '
      + 'benchmark. A zero denominator is `null` and `neutral`: *not enough data*, never 0.\n\n'
      + '**Your own, only** — there is no `membershipId` parameter. A leader’s view of a downline’s '
      + 'ratios is Phase 13’s coaching copy.',
  })
  @ApiResponse({ status: 200, type: ActivityRatiosDto })
  // The query is validated, and empty: anything sent is refused by name (`ActivityRatiosQueryDto`).
  async ratios(@Ctx() ctx: RequestContext, @Query() _query: ActivityRatiosQueryDto) {
    return this.activity.ratios(ctx);
  }

  @Get('compliance')
  @RequirePermission('activity_log:read_raw')
  @ApiOperation({
    summary: 'Whether this member is reporting',
    description:
      '`ACTIVITY_COMPLIANCE_7D` and `ACTIVITY_COMPLIANCE_MONTH`. **Existence, not a total**: an '
      + 'all-zero entry is a statement that nothing happened and counts as reporting, where no '
      + 'entry is silence and does not (ADR-0042). There is no partial state — Logged or Missed.',
  })
  @ApiResponse({ status: 200, type: ActivityComplianceDto })
  async compliance(@Ctx() ctx: RequestContext, @Query() query: ActivityComplianceQueryDto) {
    return this.activity.compliance(ctx, query);
  }
}
