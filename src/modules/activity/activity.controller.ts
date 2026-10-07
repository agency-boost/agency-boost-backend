import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  ActivityDashboardQueryDto, ActivityRatiosQueryDto, ActivitySummaryQueryDto,
  CorrectActivityDayDto,
  ReadActivityDayQueryDto, SaveActivityDayDto,
} from './activity.dto';
import {
  ActivityDashboardDto, ActivityDayDto, ActivityRatiosDto, ActivitySummaryDto,
} from './activity.response.dto';
import { ActivityService } from './activity.service';

/**
 * What an agent did, day by day (P6).
 *
 * **Reading is wide and writing is narrow.** A leader reads a downline's rows because coaching
 * depends on it; nobody writes anybody else's, and the write routes carry no subject to pass
 * (`roles-and-permissions.md` §3.5).
 */
/** The refusal a subject outside the caller's reach gets, worded as every 404 in the document is. */
const NOT_YOURS = (field: string) =>
  `\`NOT_FOUND\` — \`${field}\` names nobody you may read, **or** somebody in another office. The two are `
  + 'deliberately indistinguishable: a `403` here would confirm the id exists.';

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
      'Defaults to **today in the office’s timezone** and to your own membership. Every activity type '
      + 'of the office’s **published** configuration that the subject’s rung is shown comes back, zeros '
      + 'included — the rows Log Activity draws from `/kpm/config`, so a type with no count still has a '
      + 'row to type into. `editable` says whether the Save button is live for this caller on this day.'
      + ' **Another member’s day is audited**: the read writes `activity_log.read_raw` with the '
      + 'subject, the day and the surface (§3.5). Your own writes nothing.',
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
      + '**Codes are checked against the office’s published configuration**, the one the screen shows: '
      + 'a type archived since the last publish still saves, one created since is refused by name until '
      + 'it is published, and one in a section your rung is not shown is `ACTIVITY_TYPE_NOT_APPLICABLE`.\n\n'
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
      'Periods are the **named** ones (ADR-0022), resolved in the office’s timezone: a rolling '
      + 'window is never labelled *this month*. `from`/`to` override `period` for a custom range.\n\n'
      + '`targets` are the goal’s three cascade codes against `SUB_PERIOD_ACTIVITY_TARGET`: this month’s '
      + 'activity targets, as the Personal Summary sets them, **pro-rated** to the last 7 days — for '
      + '`ROLLING_7D` only, and `null` without an APE target. `sections` are the subject’s summary tiles '
      + 'over the window, grouped as the Summary’s are, on the subject’s rung.\n\n'
      + '**Another member’s totals are audited**: the read writes `activity_log.read_raw` with the '
      + 'subject, the range and the surface (§3.5). Outside your scope it is a 404, never a 403.',
  })
  @ApiResponse({ status: 200, type: ActivitySummaryDto })
  // The subject is a query field, so `openapi.ts` derives no 404 for it: written here, as the Summary's is.
  @ApiResponse({ status: 404, description: NOT_YOURS('membershipId'), type: ApiErrorEnvelope })
  async summary(@Ctx() ctx: RequestContext, @Query() query: ActivitySummaryQueryDto) {
    return this.activity.summary(ctx, query);
  }

  @Get('dashboard')
  @RequirePermission('activity_log:read_raw')
  @ApiOperation({
    summary: 'Your own activity over a range, per type and per column — or a coachee’s',
    description:
      '*Last 7 days* (the default), *Last 30 days*, or a custom range of up to 366 days, ending today in '
      + 'the office’s timezone. Seven days is a column a day; thirty days is 7-day blocks counted back '
      + 'from today and a remainder; a custom range is daily up to 31 days and blocks above.\n\n'
      + '**Yours, or a coachee’s** (coaching’s *Activity* tab): `for` names whose, drawn on the subject’s '
      + 'own rung — their sections, not yours. Outside your scope it is a 404, never a 403. **Another '
      + 'member’s days are audited**: the read writes `activity_log.read_raw` with the subject, the range '
      + 'and the surface `activity_dashboard` (§3.5). Your own writes nothing.',
  })
  @ApiResponse({ status: 200, type: ActivityDashboardDto })
  @ApiResponse({ status: 404, description: NOT_YOURS('for'), type: ApiErrorEnvelope })
  async dashboard(@Ctx() ctx: RequestContext, @Query() query: ActivityDashboardQueryDto) {
    return this.activity.dashboard(ctx, query);
  }

  @Get('ratios')
  @RequirePermission('activity_ratios:read')
  @ApiOperation({
    summary: 'The office’s ratios over the last 30 days',
    description:
      'Every active ratio of the office **that applies to the subject’s rung** (ADR-0020), computed over '
      + '`ROLLING_30D` — fixed, ending today in the office’s timezone — with the office’s own formula and '
      + 'benchmark. A ratio that does not apply is absent, never shown as failed. A zero denominator is '
      + '`null` and `neutral`: *not enough data*, never 0.\n\n'
      + '**Yours, or a coachee’s**: `for` names whose, on the subject’s own rung. Outside your scope it is '
      + 'a 404, never a 403. **Another member’s ratios are audited**: the read writes '
      + '`activity_log.read_raw` with the subject, the 30 days and the surface `ratios` (§3.5). Your own '
      + 'writes nothing.',
  })
  @ApiResponse({ status: 200, type: ActivityRatiosDto })
  @ApiResponse({ status: 404, description: NOT_YOURS('for'), type: ApiErrorEnvelope })
  // `for` and nothing else: any other field is refused by name (`ActivityRatiosQueryDto`).
  async ratios(@Ctx() ctx: RequestContext, @Query() query: ActivityRatiosQueryDto) {
    return this.activity.ratios(ctx, query.for);
  }

  /*
   * `GET /activity/compliance` was retired on 2026-10-02 (P11-T6 AC-10; `functional/coaching.md`, the
   * Data contract), as P10.1-T4 retired `GET /leads/summary`. Its only caller, Log Activity's *Logged /
   * Missed* card, went in P10.1-T5, and the coaching roster it was kept for draws no compliance: its four
   * columns are the prototype's, and P11-T6 AC-6 forbids a row-level activity figure. The computation
   * stays, `ActivityService.compliance`, because `GET /summary` reads it.
   */
}
