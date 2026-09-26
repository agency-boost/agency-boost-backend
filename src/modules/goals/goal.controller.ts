import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { SaveGoalDto } from './goal.dto';
import { GoalHistoryEntryDto, GoalResponseDto } from './goal.response.dto';
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
  @ApiQuery({
    name: 'for',
    required: false,
    description:
      'A **membership** in your downline, unit or office, as your grant allows (§3.6). Omitted, it '
      + 'is your own. Somebody outside it is a **404, never a 403**: a refusal that confirmed the '
      + 'person exists would answer a question nobody was entitled to ask.',
  })
  @ApiResponse({ status: 200, type: GoalResponseDto })
  async read(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Query('for') forMembershipId?: string,
  ) {
    return this.goals.readOrDefaults(ctx, period, forMembershipId);
  }

  /**
   * **Before `:period` would not help here** — `history` is a second path segment, not a
   * competing one — but it is declared beside its sibling so a reader finds both in one place.
   */
  @Get(':period/history')
  @RequirePermission('goal:read')
  @ApiOperation({
    summary: 'Every plan agreed for a period',
    description:
      'Newest first, the current one included. **Whole states, not diffs**: what changed is '
      + 'derived from two of them by whoever renders it, and a reader who wants only *what did we '
      + 'agree in January* gets it without reconstructing anything (ADR-0042). Empty when there is '
      + 'no plan for the period.',
  })
  @ApiQuery({ name: 'for', required: false, description: 'Somebody your grant reaches (§3.6).' })
  @ApiResponse({ status: 200, type: GoalHistoryEntryDto, isArray: true })
  async history(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Query('for') forMembershipId?: string,
  ) {
    return this.goals.history(ctx, period, forMembershipId);
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
  @ApiQuery({
    name: 'for',
    required: false,
    description:
      'Save **somebody else’s** goal, as §3.6 allows a leader, an Owner and an Admin to. It becomes '
      + 'their goal immediately — there is no acceptance step (ADR-0046) — the record names who '
      + 'saved it, and **they are notified**.',
  })
  @ApiResponse({ status: 200, type: GoalResponseDto })
  async save(
    @Ctx() ctx: RequestContext,
    @Param('period') period: string,
    @Body() body: SaveGoalDto,
    @Query('for') forMembershipId?: string,
  ) {
    // The period is the path, never the body: two sources for one key is one source too many.
    return this.goals.save(ctx, { ...body, period }, forMembershipId);
  }
}
