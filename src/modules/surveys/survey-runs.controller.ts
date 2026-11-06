import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CreateSurveyRunDto, SurveyResultsQueryDto, UpdateSurveyRunDto } from './surveys.dto';
import { SurveyResultsDto, SurveyRunDto } from './surveys.response.dto';
import { SurveyRunsService, type ResultsView, type RunView } from './survey-runs.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });
const RUN_404 = refusal(404, '`NOT_FOUND` — no such run, **or** it belongs to another office or was cancelled: one answer.');
const OPENED = refusal(409, '`SURVEY_CLOSED` (`details.reason: opened`) — the run has opened: nothing about it changes.');
const CONFLICT = refusal(
  409,
  '`SURVEY_RUN_CONFLICT` — `details.reason`: `period_taken` (a run of the kind in the period), `outside_cadence` (dates '
  + 'outside one period of the template’s cadence) or `section_off` (the section is off in the template).',
);
const READ_404 = refusal(
  404,
  '`NOT_FOUND` — an AB or an AAB not tagged *Core Leader* (roles §3.9 ¶), or a `runId` that belongs to another office or '
  + 'to none: one answer for both.',
);

/**
 * **The KPM's survey runs and their results** (P19.5-T4; ADR-0216 §2, §4; AC-1 to AC-4, AC-13): the NPS and *Kualitatif*
 * tabs of *Advanced analytics*. The runs are `advanced_analytics:write`, the Owner's and the Admins', audited; the results
 * `advanced_analytics:read`, in the reader's shape — a Core Leader's without *Dukungan leader*, a view-as session's a
 * summary with no free text.
 */
@ApiTags('surveys')
@ApiBearerAuth()
@Controller('kpm/advanced-analytics')
export class SurveyRunsController {
  constructor(private readonly runs: SurveyRunsService) {}

  @Get('nps')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({ summary: 'The NPS tab: its runs and one run’s results', description: '`NPS_SCORE` on the run’s own cut-offs (AT-8).' })
  @ApiResponse(READ_404)
  @ApiResponse({ status: 200, type: SurveyResultsDto })
  nps(@Ctx() ctx: RequestContext, @Query() query: SurveyResultsQueryDto): Promise<ResultsView> {
    return this.runs.results(ctx, 'nps', query.runId);
  }

  @Get('qual')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({ summary: 'The *Kualitatif* tab: its runs and one run’s results', description: '`QUAL_ITEM_ISSUE_PCT` per item.' })
  @ApiResponse(READ_404)
  @ApiResponse({ status: 200, type: SurveyResultsDto })
  qual(@Ctx() ctx: RequestContext, @Query() query: SurveyResultsQueryDto): Promise<ResultsView> {
    return this.runs.results(ctx, 'qual', query.runId);
  }

  @Post('surveys/runs')
  @RequirePermission('advanced_analytics:write')
  @ApiOperation({
    summary: '*Mulai survei*',
    description: 'A run within the template’s cadence: NPS in one quarter or half, a qualitative run in June or December. It '
      + 'opens at 00:00 on its first day in the KPM’s calendar, taking its snapshot and its invitations then. Audited.',
  })
  @ApiResponse(CONFLICT)
  @ApiResponse({ status: 201, type: SurveyRunDto })
  create(@Ctx() ctx: RequestContext, @Body() body: CreateSurveyRunDto): Promise<RunView> {
    const { kind, ...input } = body;
    return this.runs.create(ctx, kind, input);
  }

  @Patch('surveys/runs/:runId')
  @RequirePermission('advanced_analytics:write')
  @ApiOperation({ summary: 'Change a scheduled run', description: 'Before it opens only. Audited with before and after.' })
  @ApiResponse(OPENED)
  @ApiResponse(CONFLICT)
  @ApiResponse({ status: 200, type: SurveyRunDto })
  @ApiResponse(RUN_404)
  update(@Ctx() ctx: RequestContext, @Param('runId') runId: string, @Body() body: UpdateSurveyRunDto): Promise<RunView> {
    return this.runs.update(ctx, runId, body);
  }

  @Delete('surveys/runs/:runId')
  @RequirePermission('advanced_analytics:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel a scheduled run', description: 'Before it opens only; a soft delete. Audited.' })
  @ApiResponse(OPENED)
  @ApiResponse({ status: 204, description: 'Cancelled; nothing comes back.' })
  @ApiResponse(RUN_404)
  async cancel(@Ctx() ctx: RequestContext, @Param('runId') runId: string): Promise<void> {
    await this.runs.cancel(ctx, runId);
  }
}
