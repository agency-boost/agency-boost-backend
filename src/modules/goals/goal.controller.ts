import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { GoalReadQueryDto, SaveGoalDto, SaveGoalQueryDto } from './goal.dto';
import { GoalResponseDto } from './goal.response.dto';
import { GoalService } from './goal.service';

/**
 * An agent's agreed plan for a period (P8-T3).
 *
 * **Two routes, one screen.** Both are called by `/goals`. `GET /goals/:period/history` was retired
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
}
