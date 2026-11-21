import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { KpmOverviewQueryDto, OverviewPerformanceQueryDto } from './reporting.dto';
import { KpmOverviewDto, OverviewPerformanceDto } from './reporting.response.dto';
import { KpmOverviewService } from './kpm-overview.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** Who reads the Overview (ADR-0268 §1): the KPM's stewards. Every other member is refused by the route's grant. */
const NOT_A_STEWARD = refusal(
  403,
  '`TENANT_NO_MEMBERSHIP` — a Super Admin who has not entered a KPM. `PERM_DENIED` — an AB or an AAB who is not a core '
  + 'leader, or an Agent.',
);

/** `?group=` names no group of this office. */
const NO_SUCH_GROUP = refusal(
  404,
  '`NOT_FOUND` — `group` is not one of this office’s live informal groups (nor `none`): unknown, archived or another '
  + 'office’s, indistinguishable.',
);

/**
 * **The KPM Overview, second version** (P19.19; ADR-0272; `functional/kpm-overview.md`, the Data contract): the page the
 * Owner, the Admins and core leaders land on, and its *Performa vs target*. **Literal paths only**, so none shadows
 * another; `GET /kpm/overview/compliance` is `ComplianceController`'s. Until P19.19 this also served the first version's
 * `not-logged` list and `PUT recruit-target`; both are gone (ADR-0272 §2, §7).
 */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/overview')
export class KpmOverviewController {
  constructor(private readonly overview: KpmOverviewService) {}

  @Get()
  @RequirePermission('kpm_overview:read')
  @ApiOperation({
    summary: 'The KPM’s overview: usage, coaching and production',
    description:
      'Over the KPM, or one informal group (`group`, `none` for *Tanpa group*), test accounts never counted: **1** '
      + '*Pemakaian AgencyBoost* — who logged an activity in the last 30 days, of everyone, the leaders (AB, AAB) and the '
      + 'agents, and one row per informal group; **2** and **3** — every person in the tree’s order (informal group → AB → '
      + 'AAB → agents) with their usage and coaching status, photo and WhatsApp number; **6** *Produksi 6 bulan* — the '
      + 'month’s APE over the people for the six months ending with this one, `null` for a month without a file. And the '
      + 'filter’s choices, a new KPM’s setup card and what waits on the settings pages. Computed on the read, not '
      + 'paginated. Each person listed is recorded as read.',
  })
  @ApiResponse({ status: 200, type: KpmOverviewDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `group` empty or over-long, or a parameter of any other name.'))
  @ApiResponse(NOT_A_STEWARD)
  @ApiResponse(NO_SUCH_GROUP)
  async read(@Ctx() ctx: RequestContext, @Query() query: KpmOverviewQueryDto) {
    return this.overview.read(ctx, query);
  }

  @Get('performance')
  @RequirePermission('kpm_overview:read')
  @ApiOperation({
    summary: 'Performa vs target for one month',
    description:
      'The month’s targets as `GET /kpm/ab-group-targets` reads them — *Total KPM*, each informal group’s total, every AB '
      + 'group — each with what was achieved: the month’s APE in the upload against everyone’s Goal Setting ÷ 12, *Active '
      + 'Agent* (APE or a policy in the upload) and *Rekrut* (new hires who joined in the month, credited to whoever '
      + 'registered them). APE and Active Agent are `null` while the month is not uploaded. *Total KPM* counts every member '
      + 'and every recruit of the office. `group` keeps one informal group (`none`: *Tanpa group*). Nothing is recorded.',
  })
  @ApiResponse({ status: 200, type: OverviewPerformanceDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `month` not `YYYY-MM`, `group` empty or over-long, or another parameter.'))
  @ApiResponse(NOT_A_STEWARD)
  @ApiResponse(NO_SUCH_GROUP)
  @ApiResponse(refusal(422, '`AB_GROUP_TARGET_MONTH_CLOSED` — a month before January 2024 or more than a year ahead.'))
  async performance(@Ctx() ctx: RequestContext, @Query() query: OverviewPerformanceQueryDto) {
    return this.overview.performance(ctx, query);
  }
}

/*
 * ***Cross-platform analytics*** (`GET /admin/analytics`, `PlatformAnalyticsController`) is retired by P19.23 (ADR-0277 §1):
 * the console's Dashboard reads adoption per KPM (`GET /admin/dashboard`).
 */
