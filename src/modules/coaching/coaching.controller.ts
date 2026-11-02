import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CoacheeQueryDto, CoachingRosterQueryDto } from './coaching.dto';
import { CoacheeDto, CoachingRosterDto } from './coaching.response.dto';
import { CoachingRosterService } from './coaching-roster.service';
import { CoacheeService } from './coachee.service';
import { PinnedSessionDto, ReopenCoachingSessionDto, SaveCoachingSessionDto } from './coaching-session.dto';
import {
  CoachingSessionDto, SessionDraftSavedDto, SessionHistoryDto,
} from './coaching-session.response.dto';
import { CoachingSessionService } from './coaching-session.service';

/** A session refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * Coaching (Phase 11; `functional/coaching.md`, the Data contract).
 *
 * **Literal paths before parameters.** `coaching/coachees` is declared ahead of the routes whose
 * parameters could shadow it, when the person shell and the session routes join this controller.
 */
@ApiTags('coaching')
@ApiBearerAuth()
@Controller('coaching')
export class CoachingController {
  constructor(
    private readonly roster: CoachingRosterService,
    private readonly person: CoacheeService,
    private readonly sessions: CoachingSessionService,
  ) {}

  @Get('coachees')
  @RequirePermission('coaching_session:read')
  @ApiOperation({
    summary: 'Everyone you coach',
    description:
      'The coaching roster: everybody below you on the current leader edges, at any depth, and nobody '
      + 'else — the agents who answer to you directly, then each leader who does, with their whole team '
      + 'beneath them. Each person’s last 1:1 and who led it, and their status for the calendar month. '
      + '**Verdicts and dates only**: no count of any activity is in the answer. Somebody who coaches '
      + 'nobody gets an empty roster, not an error. Not paginated.',
  })
  @ApiResponse({ status: 200, type: CoachingRosterDto })
  /*
   * The query is validated, and empty: anything sent is refused by name (`CoachingRosterQueryDto`).
   * `openapi.ts` derives a 400 from a documented body or query parameter, and an empty DTO documents
   * neither, so the refusal is written here, in the shared envelope like every other failure.
   */
  @ApiResponse({
    status: 400,
    description:
      '`VALIDATION_FAILED` — this read takes no query parameter. One sent, of any name, is refused, '
      + 'and `details` names it.',
    type: ApiErrorEnvelope,
  })
  async coachees(@Ctx() ctx: RequestContext, @Query() _query: CoachingRosterQueryDto) {
    return this.roster.read(ctx);
  }

  @Get('coachees/:membershipId')
  @RequirePermission('coaching_session:read')
  @ApiOperation({
    summary: 'Somebody you coach',
    description:
      'The person a coaching page opens on: their name and pronoun, their rung, the leader they answer '
      + 'to directly and whether that is you, and how many people are below them and how many of those '
      + 'lead — with today in the office’s calendar. **Directory facts, and no figure of theirs**, so the '
      + 'read is not recorded. Only somebody you coach is answered: anybody else, a member who has left '
      + 'and yourself included, is not found.',
  })
  @ApiResponse({ status: 200, type: CoacheeDto })
  // As the roster's: an empty query DTO documents no parameter, so its refusal is written here.
  @ApiResponse({
    status: 400,
    description:
      '`VALIDATION_FAILED` — this read takes no query parameter. One sent, of any name, is refused, '
      + 'and `details` names it.',
    type: ApiErrorEnvelope,
  })
  async coachee(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Query() _query: CoacheeQueryDto,
  ) {
    return this.person.read(ctx, membershipId);
  }

  @Get('coachees/:membershipId/sessions')
  @RequirePermission('coaching_session:read')
  @ApiOperation({
    summary: 'Somebody’s coaching sessions',
    description:
      'Their finalized sessions, newest first — each with its day, who led it, how many action items it '
      + 'agreed and how many of them the next session ticked done — and what the session workspace opens '
      + 'on: your open draft with them, else the session you are correcting, else the one you finalized '
      + 'today. Somebody you coach: every finalized session about them, whoever led it. The Owner and the '
      + 'Admin: every finalized one. A leader who no longer coaches them: the sessions they led, and no '
      + 'other. Dates, coaches and counts, so the read is not recorded. Not paginated.',
  })
  @ApiResponse({ status: 200, type: SessionHistoryDto })
  async history(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.sessions.history(ctx, membershipId);
  }

  @Post('coachees/:membershipId/sessions')
  @RequirePermission('coaching_session:create')
  @ApiOperation({
    summary: 'Start a coaching session',
    description:
      '*▶ Start coaching session*. Opens a draft with somebody you coach, or — when you already have one '
      + 'open with them — answers that one, so a second start resumes it from any device. A new draft '
      + 'opens on their latest finalized session, whoever led it: its action items under *Last week’s '
      + 'action items*, none ticked, and every one not done carried into *Other action items* with its '
      + 'date cleared — except one whose lead has a next action date now, which *From leads* lists — and '
      + 'every tip, as written. The answer is the session, as reading it answers it, and is recorded as '
      + 'a read of their data.',
  })
  @ApiResponse({ status: 201, type: CoachingSessionDto, description: 'A new draft.' })
  @ApiResponse({ status: 200, type: CoachingSessionDto, description: 'The draft you already had open with them.' })
  async start(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, session } = await this.sessions.start(ctx, membershipId);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return session;
  }

  @Get('sessions/:sessionId')
  @RequirePermission('coaching_session:read')
  @ApiOperation({
    summary: 'A coaching session',
    description:
      'One session, as you may see it. Its coach, while they coach the person, reads all of it, the '
      + 'draft included, with *From leads* read from the person’s leads now. Everybody else reads its '
      + 'latest finalized version, read-only: any leader who coaches the person now, the leader who led it '
      + 'after they stopped, the Owner and the Admin, and the person it is about. A draft is its coach’s '
      + 'alone. With the snapshot of what the 1:1 looked at, and every earlier version with who reopened '
      + 'it, when and why. A read by anybody but the person it is about is recorded.',
  })
  @ApiResponse({ status: 200, type: CoachingSessionDto })
  async read(@Ctx() ctx: RequestContext, @Param('sessionId') sessionId: string) {
    return this.sessions.read(ctx, sessionId);
  }

  @Put('sessions/:sessionId')
  @RequirePermission('coaching_session:edit')
  @ApiOperation({
    summary: 'Save a coaching session',
    description:
      'The whole editable state, pinned to the version you read: last week’s ticks and dates, *Other '
      + 'action items* and the tips, each list whole. A tick on last week’s item is written on this '
      + 'session; the session it came from never changes. A blank row may be saved while editing. Only '
      + 'its coach saves it, while they coach the person. At most 50 items and 50 tips, each at most 500 '
      + 'characters.',
  })
  @ApiResponse({ status: 200, type: SessionDraftSavedDto })
  @ApiResponse(refusal(409, '`COACHING_SESSION_FINALIZED` — it is finalized; reopen it first. `VERSION_CONFLICT` — it changed since you read it.'))
  async save(
    @Ctx() ctx: RequestContext, @Param('sessionId') sessionId: string, @Body() body: SaveCoachingSessionDto,
  ) {
    return this.sessions.save(ctx, sessionId, body);
  }

  @Post('sessions/:sessionId/finalize')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('coaching_session:finalize')
  @ApiOperation({
    summary: 'Finalize a coaching session',
    description:
      '*✓ Finalize this session*. Refused, with the prototype’s own sentence and `details.rule`, when there '
      + 'is no action item at all, a tip or an action item is blank, an action item has no date, or a lead '
      + 'of theirs promised for this month has no next action date — the first of these that fails. Then it '
      + 'is locked: who finalized it and when, the actions from their leads as they stand, and — the first '
      + 'time only — its date and the snapshot of what the 1:1 looked at. The person is told, and an email '
      + 'about a goal you set during the session goes out once.',
  })
  @ApiResponse({ status: 200, type: CoachingSessionDto })
  @ApiResponse(refusal(409, '`COACHING_SESSION_FINALIZED` — already finalized. `VERSION_CONFLICT` — it changed since you read it.'))
  @ApiResponse(refusal(
    422,
    '`COACHING_SESSION_INCOMPLETE` — `details.rule` names the check; `details.leadId` and `details.leadName` the lead, '
    + 'for `LEAD_THIS_MONTH_UNDATED`; `details.count` and `details.itemIds` the action items with no date, for '
    + '`UNDATED_ACTION_ITEM` (UI-060).',
  ))
  async finalize(
    @Ctx() ctx: RequestContext, @Param('sessionId') sessionId: string, @Body() body: PinnedSessionDto,
  ) {
    return this.sessions.finalize(ctx, sessionId, body.version);
  }

  @Post('sessions/:sessionId/reopen')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('coaching_session:reopen')
  @ApiOperation({
    summary: 'Reopen a finalized coaching session',
    description:
      '*Edit again*, with a reason. Its coach, while they coach the person, and the Owner and the Admin '
      + 'while its coach still does, until 7 days after the day it was first finalized. The finalized '
      + 'version is kept whole, with who reopened it, when and why, and stays the one that counts until '
      + 'the correction is finalized. Everybody who reads the session, the person included, reads the reason.',
  })
  @ApiResponse({ status: 200, type: CoachingSessionDto })
  @ApiResponse(refusal(
    409,
    '`COACHING_SESSION_NOT_FINALIZED` — a draft, or already reopened (`details.status`). '
    + '`COACHING_REOPEN_WINDOW_CLOSED` — past its last day (`details.date`, `details.reopenableUntil`, '
    + '`details.windowDays`). `COACHING_REOPEN_COACH_NOT_CURRENT` — its coach no longer coaches the person, '
    + 'so nobody could finalize the correction. `VERSION_CONFLICT` — it changed since you read it.',
  ))
  async reopen(
    @Ctx() ctx: RequestContext, @Param('sessionId') sessionId: string, @Body() body: ReopenCoachingSessionDto,
  ) {
    return this.sessions.reopen(ctx, sessionId, body);
  }
}
