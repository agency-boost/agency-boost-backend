import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CreateSurveyRunDto, SurveyPeopleQueryDto, SurveyResultsQueryDto, UpdateSurveyRunDto } from './surveys.dto';
import { SurveyPeopleDto, SurveyPersonAnswersDto, SurveyResultsDto, SurveyRunDto } from './surveys.response.dto';
import { SurveyPeopleService, type SurveyPeopleView, type SurveyPersonAnswers } from './survey-people.service';
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
  constructor(private readonly runs: SurveyRunsService, private readonly people: SurveyPeopleService) {}

  @Get('nps')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: 'The NPS tab: its runs, one run’s results in one view, and *Survei baru*',
    description: '`NPS_KPM_OVERALL` and `NPS_SCORE` per question on the run’s own cut-offs (AT-8), for `who`.',
  })
  @ApiResponse(READ_404)
  @ApiResponse({ status: 200, type: SurveyResultsDto })
  nps(@Ctx() ctx: RequestContext, @Query() query: SurveyResultsQueryDto): Promise<ResultsView> {
    return this.runs.results(ctx, 'nps', query.runId, query.who);
  }

  @Get('qual')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: 'The *Kualitatif* tab: its runs, one run’s results in one view, and *Survei baru*',
    description: '`QUAL_ITEM_ISSUE_PCT` per item with *semester lalu*, for `who`.',
  })
  @ApiResponse(READ_404)
  @ApiResponse({ status: 200, type: SurveyResultsDto })
  qual(@Ctx() ctx: RequestContext, @Query() query: SurveyResultsQueryDto): Promise<ResultsView> {
    return this.runs.results(ctx, 'qual', query.runId, query.who);
  }

  @Get('qual/people')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Analisa kualitatif › Per orang*: every invitee of one run',
    description: 'ADR-0276 §5. Photo, name, role, upline, informal group, *waktu*, *masa kerja*, *usia*, '
      + 'whether they answered and *n item* bermasalah (`QUAL_PERSON_ISSUE_ITEMS`) — the count only where the run is named '
      + 'and *per orang*. `canOpen` where the reader reaches the person (a core leader: their own downline). Test accounts '
      + 'never. A summary (view-as, platform read) gets no name: `people: null`.',
  })
  @ApiResponse(READ_404)
  @ApiResponse({ status: 200, type: SurveyPeopleDto })
  qualPeople(@Ctx() ctx: RequestContext, @Query() query: SurveyPeopleQueryDto): Promise<SurveyPeopleView> {
    return this.people.people(ctx, query.runId);
  }

  @Get('qual/people/:membershipId')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: 'One person’s answers, opened under their row',
    description: 'ADR-0276 §5: *Item bermasalah* per area, Q4 with its note, A–C on the 1–5 scale, D with '
      + 'consistency and comfort, *Coaching leader downline*, and Q12’s score for the office alone. Writes the §3.5 subject '
      + 'read, surface `survey`.',
  })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — somebody in another office or nobody, one outside a core leader’s downline, one who has not answered, or a run '
    + 'that is anonymous or not *per orang*: one answer. Also an AB or AAB who is no core leader.',
  ))
  @ApiResponse(refusal(403, '`SURVEY_ANSWERS_HIDDEN` — a view-as session: a person’s answers are never shown in one.'))
  @ApiResponse({ status: 200, type: SurveyPersonAnswersDto })
  qualPerson(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Query() query: SurveyPeopleQueryDto,
  ): Promise<SurveyPersonAnswers> {
    return this.people.person(ctx, membershipId, query.runId);
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
