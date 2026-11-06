import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AllowWhileReadOnly, Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { GoalReadQueryDto, SaveEstimateDto, SaveGoalDto, SaveGoalQueryDto } from './goal.dto';
import { GoalPreviewDto, GoalResponseDto } from './goal.response.dto';
import { GoalService } from './goal.service';

/**
 * An agent's agreed plan for a period (P8-T3).
 *
 * **Three routes, one screen** — and a fourth, the Summary's. The read, the save and since UI V1 (P18.11-T5) the
 * preview its result card moves with are called by `/goals` and a coachee's *Goal Setting* tab; since P19.1-T4 the
 * Summary writes the member's own estimate of the APE produced through `PUT /goals/:period/ape-estimate`. `GET /goals/:period/history` was retired
 * by P10.1-T6 with the card that read it: the prototype draws no goal history, so no screen would
 * call it again. The stored revisions keep every version and who saved it (ADR-0042).
 *
 * **`PUT`, not `PATCH`.** The five cards are one plan — a case size that changes without the
 * conversion rates beside it is not a partial edit, it is a different plan — and the screen sends
 * the whole thing on Save. There is no field-at-a-time write here, unlike a lead, because a goal is
 * agreed all at once.
 */
@ApiTags('goals')
@ApiBearerAuth()
@Controller('goals')
export class GoalController {
  constructor(private readonly goals: GoalService) {}

  @Get(':period')
  @RequirePermission('goal:read')
  @ApiOperation({
    summary: 'Your plan for a period',
    description:
      'The goal, or **the office’s defaults** when there is none — so the screen opens on five '
      + 'filled cards rather than on empty ones, and a first-time reader sees what a plan looks '
      + 'like. `projected` is recomputed on every read; `snapshot` is what was agreed. '
      + 'Somebody else’s plan, named by `for`, comes back without their measured rates.',
  })
  @ApiResponse({ status: 200, type: GoalResponseDto })
  // `for` is validated as every query field is: any other parameter is refused by name.
  async read(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Query() query: GoalReadQueryDto,
  ) {
    return this.goals.readOrDefaults(ctx, period, query.for);
  }

  /*
   * **A read by its permission, sent as a `POST` for its body** (the Phase 18.11 exit review, L4): it writes nothing, so
   * a read-only support session reaches it as it reaches `GET /goals/:period` — the screen it moves is one the session
   * may open.
   */
  @Post(':period/preview')
  @HttpCode(HttpStatus.OK)
  @AllowWhileReadOnly()
  @RequirePermission('goal:read')
  @ApiOperation({
    summary: 'What a plan would mean, unsaved',
    description:
      'The cascade over the inputs the screen holds, by the formula a save uses, and **nothing written** — Goal '
      + 'Settings’ result card and commitment move with it as a slider moves. The body is a save’s; '
      + '`for` is a read’s, `goal:read`’s reach, 404 beyond it. On somebody else’s plan the APE produced is the '
      + 'figure they stored, as a save keeps it. An assumption that cannot make a plan answers `projected: null` — the '
      + 'save still refuses it by name. Reachable in a read-only support session, as the read is.',
  })
  @ApiResponse({ status: 200, type: GoalPreviewDto })
  async preview(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Body() body: SaveGoalDto,
    @Query() query: GoalReadQueryDto,
  ) {
    // The period is the path, as on a save.
    return this.goals.preview(ctx, period, { ...body, period }, query.for);
  }

  @Put(':period')
  @RequirePermission('goal:update')
  @ApiOperation({
    summary: 'Save your plan',
    description:
      'Creates it or replaces what it held, in one write. Refused with `GOAL_INVALID_ASSUMPTION` '
      + 'when the numbers cannot produce a plan — a case size of zero, or a conversion rate '
      + 'outside 0–100 — and nothing is written when it is.',
  })
  @ApiResponse({ status: 200, type: GoalResponseDto })
  @ApiResponse({
    status: 409,
    description:
      '`COACHING_SESSION_FINALIZED` — `session` names your session with them, and it is finalized: '
      + 'reopen it first. `GOAL_PERIOD_LOCKED` — the period has ended.',
    type: ApiErrorEnvelope,
  })
  // `for` and `session` are validated as every query field is: any other parameter is refused by name.
  async save(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Body() body: SaveGoalDto,
    @Query() query: SaveGoalQueryDto,
  ) {
    // The period is the path, never the body: two sources for one key is one source too many.
    return this.goals.save(ctx, { ...body, period }, query.for, query.session);
  }

  /*
   * **The member's own estimate** (P19.1-T4, UI-157 item 4; ADR-0195): the Summary's *Isi produksi sementara*, *Ubah*
   * and *Hapus*. One narrow write of one field, the caller's own plan, no `for`: it is not a plan saved again.
   */
  @Put(':period/ape-estimate')
  @RequirePermission('goal:update')
  @ApiOperation({
    summary: 'Your own estimate of the APE produced so far this year',
    description:
      'Writes the plan’s `apeAchievedMinor` — the figure Goal Settings shows as *APE yang sudah dicapai tahun ini* — as '
      + 'the caller’s own estimate (*perkiraan Anda*, provenance `self_reported`); `null` or `0` clears it (*Hapus*). The '
      + 'plan as it stood is kept as a revision and its version moves on; nothing else of it changes — not its other '
      + 'inputs, its agreed snapshot or `savedAt`. **Your own plan only**, and only a '
      + 'saved one: `404 Goal` without it. Read by your own screens alone — never by a leader’s or the office’s, which '
      + 'read the office’s figures (ADR-0195) — and replaced on every screen once the office holds a year-to-date figure '
      + 'for the year.',
  })
  @ApiResponse({ status: 200, type: GoalResponseDto })
  @ApiResponse({
    status: 404,
    description: '`NOT_FOUND` — you have no saved plan for the period. Indistinguishable from a plan in another office.',
    type: ApiErrorEnvelope,
  })
  @ApiResponse({ status: 409, description: '`GOAL_PERIOD_LOCKED` — the period has ended.', type: ApiErrorEnvelope })
  async saveEstimate(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Body() body: SaveEstimateDto,
  ) {
    return this.goals.saveEstimate(ctx, period, body);
  }
}
