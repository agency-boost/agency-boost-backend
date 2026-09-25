import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { SaveGoalDto } from './goal.dto';
import { GoalResponseDto } from './goal.response.dto';
import { GoalService } from './goal.service';

/**
 * An agent's agreed plan for a period (P8-T3).
 *
 * **Two routes, one screen.** Both are called by `/goals`; the history a period list would feed is
 * P8-T6's, and it arrives with the screen that reads it rather than waiting here for one.
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
      + 'like. `projected` is recomputed on every read; `snapshot` is what was agreed.',
  })
  @ApiResponse({ status: 200, type: GoalResponseDto })
  async read(@Ctx() ctx: RequestContext, @Param('period') period: string) {
    return this.goals.readOrDefaults(ctx, period);
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
  async save(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Body() body: SaveGoalDto,
  ) {
    // The period is the path, never the body: two sources for one key is one source too many.
    return this.goals.save(ctx, { ...body, period });
  }
}
