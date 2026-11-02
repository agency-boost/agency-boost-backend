import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  KpmAnalyticsQueryDto, KpmOverviewQueryDto, NotLoggedQueryDto, PlatformAnalyticsQueryDto, SetRecruitTargetDto,
} from './reporting.dto';
import {
  KpmAnalyticsDto, KpmOverviewDto, NotLoggedDto, PlatformAnalyticsDto, RecruitTargetDto,
} from './reporting.response.dto';
import { KpmAnalyticsService } from './kpm-analytics.service';
import { KpmOverviewService } from './kpm-overview.service';
import { PlatformAnalyticsService } from './platform-analytics.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** An empty query DTO derives no 400, so the refusal of a parameter of any name is written here. */
const NO_PARAMETERS = refusal(
  400,
  '`VALIDATION_FAILED` — this read takes no query parameter. One sent, of any name, is refused, and `details` names it.',
);

/** Outside a support session a Super Admin is in no agency, and the agency's reads have none to answer for. */
const NO_OFFICE = refusal(
  403,
  '`TENANT_NO_MEMBERSHIP` — a Super Admin outside a support session belongs to no agency. `PERM_DENIED` — '
  + 'a role without the permission: every field role.',
);

/**
 * **The KPM Overview** (`functional/kpm-analytics.md`, the Data contract): the page the Owner and the Admin land
 * on, its not-logged list, and the recruitment target. **Literal paths only**, so none shadows another.
 */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/overview')
export class KpmOverviewController {
  constructor(private readonly overview: KpmOverviewService) {}

  @Get()
  @RequirePermission('kpm_overview:read')
  @ApiOperation({
    summary: 'The agency’s overview',
    description:
      'Five sections, every figure computed on the read from the agency’s own records through the function '
      + 'that already computes it: team composition (the headcount, new this month, one tile per rung of the '
      + 'company’s ladder); engagement (members who logged an activity this calendar month, beside last month '
      + 'to the same day, and over the last 7 days); coaching coverage over 7 and 30 days with '
      + 'each AB’s own coaching, lowest first; the recruitment pipeline as counts, with the month’s target; and '
      + 'production this year against the sum of the members’ goals, its projection, and every AB agency, '
      + 'furthest behind first. A figure without data is `null`, never 0. Not paginated. Each leader on the '
      + 'coaching ranking is recorded as read.',
  })
  @ApiResponse({ status: 200, type: KpmOverviewDto })
  @ApiResponse(NO_PARAMETERS)
  @ApiResponse(NO_OFFICE)
  async read(@Ctx() ctx: RequestContext, @Query() _query: KpmOverviewQueryDto) {
    return this.overview.read(ctx);
  }

  @Get('not-logged')
  @RequirePermission('kpm_overview:read')
  @ApiOperation({
    summary: 'Who has not logged lately',
    description:
      'How many members have no day logged in the last 7 days, and the first three of them — never-logged '
      + 'first, then the longest silent: name, rung, their latest day logged and the days since. Read when *View '
      + 'who hasn’t logged* is opened; the three listed are recorded as read, the rest counted are not.',
  })
  @ApiResponse({ status: 200, type: NotLoggedDto })
  @ApiResponse(NO_PARAMETERS)
  @ApiResponse(NO_OFFICE)
  async notLogged(@Ctx() ctx: RequestContext, @Query() _query: NotLoggedQueryDto) {
    return this.overview.notLogged(ctx);
  }

  @Put('recruit-target')
  @RequirePermission('kpm_overview:set_recruit_target')
  @ApiOperation({
    summary: 'Set this month’s recruitment target',
    description:
      'The agency’s target for its current month: stored, and read by every later month that sets none. '
      + 'Audited with the value before and after. Another month is refused. The same target again changes '
      + 'nothing.',
  })
  @ApiResponse({ status: 200, type: RecruitTargetDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — `month` is not the agency’s current month (`details.month` names it), or `target` '
    + 'is not a whole number from 0.',
  ))
  async setRecruitTarget(@Ctx() ctx: RequestContext, @Body() body: SetRecruitTargetDto) {
    return this.overview.setRecruitTarget(ctx, body);
  }
}

/**
 * Who reads KPM analytics (ADR-0159 §2): the Owner, the Admins and the office's **Core Leaders**. A leader who is not
 * one holds the grant and is answered 404, so nothing tells them there is a reading behind it.
 */
const ANALYTICS_REFUSALS = [
  refusal(
    403,
    '`TENANT_NO_MEMBERSHIP` — a Super Admin outside a support session belongs to no agency. `PERM_DENIED` — '
    + 'a role without the permission: an Agent.',
  ),
  refusal(
    404,
    '`NOT_FOUND` — an AB or an AAB who is not a Core Leader (tagged, on a leader rung; ADR-0159 §2), read on every '
    + 'request: the forum’s rule. Indistinguishable from another office’s.',
  ),
] as const;

/** **KPM analytics** (`functional/kpm-analytics.md`, the Data contract): the unit comparison by AB agency. */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/analytics')
export class KpmAnalyticsController {
  constructor(private readonly analytics: KpmAnalyticsService) {}

  @Get()
  @RequirePermission('kpm_analytics:read')
  @ApiOperation({
    summary: 'The agency’s unit comparison',
    description:
      'One row per AB agency — the AB and everybody below them down to the next AB, so an AB under an AB is '
      + 'its own row and the rows add up to the agency — each with its *(Direct)* row and a row per AAB unit: '
      + 'APE this month against the targets fixed when it began, APE this year against the annual goals, '
      + 'coached in the last 7 days, active agents for the period’s month, total and promised leads, and '
      + 'manpower by rung. Each AB’s and AAB’s Maintenance of Contract against the company’s carrier rules, '
      + 'criterion by criterion, a criterion without uploaded input `null` rather than failed; each agency’s '
      + 'production club. The total row, and the agency’s production for the six months before this one. '
      + 'Computed on the read, not paginated; nothing is recorded. Read by the Owner, an Admin and a Core Leader '
      + '(ADR-0159 §2), the whole office, read-only.',
  })
  @ApiResponse({ status: 200, type: KpmAnalyticsDto })
  @ApiResponse(ANALYTICS_REFUSALS[0])
  @ApiResponse(ANALYTICS_REFUSALS[1])
  async read(@Ctx() ctx: RequestContext, @Query() query: KpmAnalyticsQueryDto) {
    return this.analytics.read(ctx, query);
  }
}

/** ***Cross-platform analytics*** (`functional/kpm-analytics.md`, the Data contract): adoption across offices. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/analytics')
export class PlatformAnalyticsController {
  constructor(private readonly platform: PlatformAnalyticsService) {}

  @Get()
  @RequirePermission('platform_analytics:read')
  @ApiOperation({
    summary: 'Adoption across agencies',
    description:
      'Per agency, per company and for the platform: active members by rung, joined and left this calendar '
      + 'month, and signed in within the last 7 and 30 days. Counts only — no member, lead, activity, coaching '
      + 'or production figure — read across agencies through named reads. Nothing is recorded.',
  })
  @ApiResponse({ status: 200, type: PlatformAnalyticsDto })
  @ApiResponse(NO_PARAMETERS)
  async read(@Ctx() ctx: RequestContext, @Query() _query: PlatformAnalyticsQueryDto) {
    return this.platform.read(ctx);
  }
}
