import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { PopupShownDto, SurveyAnswerDto } from './surveys.dto';
import {
  SurveyAnswerSavedDto, SurveyFormDto, SurveyListDto, SurveyPendingDto, SurveySubmittedDto,
} from './surveys.response.dto';
import { SurveysService, type FormView, type PendingView, type SurveyListView } from './surveys.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const NOT_INVITED = refusal(
  404,
  '`SURVEY_NOT_INVITED` — the caller was not invited to this run, **or** it belongs to another office, was cancelled or is '
  + 'unknown. One answer for all: it says nothing of the run.',
);
const CLOSED = refusal(409, '`SURVEY_CLOSED` — `details.reason`: `closed` (the run has ended) or `submitted` (already sent).');
const READ_GATE = refusal(
  403,
  '`TENANT_NO_MEMBERSHIP` — a Super Admin outside a view-as session belongs to no KPM. `PERM_DENIED` — a member who holds '
  + 'no `survey:respond`.',
);

/**
 * **A member's own surveys** (P19.5-T4; ADR-0216 §5, §6; C-R1 to C-R10; `functional/surveys.md`). Every tenant role
 * holds `survey:respond`, `own`; only an invitee is answered. **The reads declare no permission** — a view-as session
 * reads them as its member does, with no saved answer and no popup — and `SurveysService` checks the grant; the writes
 * declare it, and a session is refused each one.
 */
@ApiTags('surveys')
@ApiBearerAuth()
@Controller('surveys')
export class SurveysController {
  constructor(private readonly surveys: SurveysService) {}

  @Get('pending')
  @ApiOperation({
    summary: 'The reminder: the open surveys, the sent ones still open, and today’s popup',
    description: 'For Home’s popup and *Lainnya*’s dot, *Perlu diisi* cards and the *Survei* tile’s dot. Holds `survey:respond`, '
      + 'checked by the service. The popup is decided here: at most one a KPM day, at the run’s opening, halfway (when on) '
      + 'and one day before the end (always); two runs due make one.',
  })
  @ApiResponse(READ_GATE)
  @ApiResponse({ status: 200, type: SurveyPendingDto })
  pending(@Ctx() ctx: RequestContext): Promise<PendingView> {
    return this.surveys.pending(ctx);
  }

  @Post('popup/shown')
  @RequirePermission('survey:respond')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'The popup was drawn',
    description: 'Writes the KPM day and the moment on the runs named, so no second popup is shown that day on any device. '
      + 'Runs the caller was not invited to are left alone.',
  })
  @ApiResponse({ status: 204, description: 'Written; nothing comes back.' })
  async popupShown(@Ctx() ctx: RequestContext, @Body() body: PopupShownDto): Promise<void> {
    await this.surveys.popupShown(ctx, body.moment, body.runIds);
  }

  @Get()
  @ApiOperation({
    summary: 'The *Survei* page: the open runs, then *Riwayat*',
    description: 'Every run the caller was invited to that is open and not sent, then every run they sent, newest first, with '
      + 'the day. Holds `survey:respond`, checked by the service.',
  })
  @ApiResponse(READ_GATE)
  @ApiResponse({ status: 200, type: SurveyListDto })
  list(@Ctx() ctx: RequestContext): Promise<SurveyListView> {
    return this.surveys.list(ctx);
  }

  @Get(':runId')
  @ApiOperation({
    summary: 'The form',
    description: 'One question a screen, `{perusahaan}` and `{kpm}` filled, the saved answers and where to resume. A closed or '
      + 'sent run answers its `state` and no question. In a view-as session the saved answers are not sent. Holds '
      + '`survey:respond`, checked by the service.',
  })
  @ApiResponse(READ_GATE)
  @ApiResponse(NOT_INVITED)
  @ApiResponse({ status: 200, type: SurveyFormDto })
  form(@Ctx() ctx: RequestContext, @Param('runId') runId: string): Promise<FormView> {
    return this.surveys.form(ctx, runId);
  }

  @Put(':runId/answers/:questionKode')
  @RequirePermission('survey:respond')
  @ApiOperation({
    summary: 'Save one answer (*Tersimpan otomatis*)',
    description: 'Checked against the question’s type and stored; answers the count. `400 VALIDATION_FAILED` for a value the '
      + 'question does not take, or a kode the run does not ask.',
  })
  @ApiResponse(NOT_INVITED)
  @ApiResponse(CLOSED)
  @ApiResponse({ status: 200, type: SurveyAnswerSavedDto })
  answer(
    @Ctx() ctx: RequestContext, @Param('runId') runId: string, @Param('questionKode') questionKode: string,
    @Body() body: SurveyAnswerDto,
  ): Promise<{ answeredCount: number; totalCount: number }> {
    return this.surveys.answer(ctx, runId, questionKode, body.value);
  }

  @Post(':runId/submit')
  @RequirePermission('survey:respond')
  @ApiOperation({
    summary: '*Kirim*',
    description: 'Every required question answered, else `400 VALIDATION_FAILED` naming the first. An anonymous run’s form is '
      + 'stored with no person on it; the draft is cleared.',
  })
  @ApiResponse(NOT_INVITED)
  @ApiResponse(CLOSED)
  @ApiResponse({ status: 201, type: SurveySubmittedDto })
  submit(@Ctx() ctx: RequestContext, @Param('runId') runId: string): Promise<{ submittedAt: string }> {
    return this.surveys.submit(ctx, runId);
  }
}
