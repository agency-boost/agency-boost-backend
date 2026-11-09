import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CoachingSurveyService, type CoachingSurveyView } from './coaching-survey.service';
import { CoachingSurveyDto } from './surveys.response.dto';

/**
 * **The coaching *Survei* tab's read** (P19.5-T4; ADR-0216 §7; B3, B4): one person's qualitative answers, to whoever can
 * open their coaching page, when the run allows it — and never Q12.
 */
@ApiTags('surveys')
@ApiBearerAuth()
@Controller('coaching')
export class CoachingSurveyController {
  constructor(private readonly survey: CoachingSurveyService) {}

  @Get(':membershipId/survey')
  @RequirePermission('survey_answers:read')
  @ApiOperation({
    summary: 'A person’s qualitative survey answers (the *Survei* tab)',
    description: 'Their latest qualitative run: `answered` with the cards; `not_answered`; `anonymous` — the run is anonymous, '
      + 'not shown per person, or the form carried no notice — with no answer sent; or `none`. Writes the §3.5 read entry, '
      + 'surface `survey`.',
  })
  @ApiResponse({
    status: 403,
    type: ApiErrorEnvelope,
    description: '`SURVEY_ANSWERS_HIDDEN` — every view-as session, whoever it acts as. `PERM_DENIED` — an Agent, or a '
      + 'Super Admin.',
  })
  @ApiResponse({ status: 200, type: CoachingSurveyDto })
  @ApiResponse({
    status: 404, type: ApiErrorEnvelope,
    description: '`NOT_FOUND` — no such person, one who belongs to another office, **or** one outside the reader’s line '
      + '(B4-6): one answer for all three.',
  })
  read(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string): Promise<CoachingSurveyView> {
    return this.survey.read(ctx, membershipId);
  }
}
