import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  CorrectActivationStartDto, SaveActivationNoteDto, TickHireActivationItemDto,
} from './activation-progress.dto';
import {
  ActivationClosingsDto, ActivationNoteSavedDto, ActivationViewDto, NewHireMarkedLeftDto, NewHiresRosterDto,
} from './activation-progress.response.dto';
import { NewHiresService } from './new-hires.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const NOT_REACHED =
  '`NOT_FOUND` — nobody you coach with an activation: a peer’s hire, somebody in another team, a member who '
  + 'has left, yourself, or an id that is nobody’s — deliberately indistinguishable from one in another '
  + 'office: a `403` would confirm that somebody exists.';

const CLOSED = '`ACTIVATION_CLOSED` — the activation is complete, or its six months are over: nothing on it changes.';

/**
 * **A leader's new hires** (`functional/activation.md`, the Data contract; roles §3.8): the roster, one
 * hire's activation — which the coaching *Activation* tab reads too — a leader's tick, the join date's
 * correction and the coaching note. **Every route reaches only the hires the reader coaches now**
 * (`COACH`), and every read of a hire's activation is recorded.
 */
@ApiTags('activation')
@ApiBearerAuth()
@Controller('new-hires')
export class NewHiresController {
  constructor(private readonly hires: NewHiresService) {}

  @Get()
  @RequirePermission('new_hires:read_roster')
  @ApiOperation({
    summary: 'Your new hires',
    description:
      'Every new hire you coach, at any depth, whose join date is in the last twelve months — never an existing '
      + 'agent — in three sections by their 3M activation: in progress (days 1 to 90), activated (a first paid and '
      + 'issued case by day 90) and not activated (none by then, or they left before one). Each row: the join date, '
      + 'the day, the first sale, the result, the day they left and their checklist where they have one. At the top, '
      + 'the 3M activation % of everybody listed and of each unit — your direct unit, then each AAB’s or AB’s below '
      + 'you — overall and by join month. A result decided is kept, and never changes after. Each new hire shown is '
      + 'a recorded read.',
  })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — you coach no new hire who joined in the last twelve months, so there is nobody to show. Answered '
    + 'exactly as a record in another office is.',
  ))
  @ApiResponse({ status: 200, type: NewHiresRosterDto })
  async roster(@Ctx() ctx: RequestContext) {
    return this.hires.roster(ctx);
  }

  @Post(':membershipId/left')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('new_hire:mark_left')
  @ApiOperation({
    summary: 'Mark a new hire as left',
    description:
      'Records that a new hire has left, today: their 3M activation is decided — not activated unless their first '
      + 'sale came first — and kept, and they are removed from the office as a removal removes anybody, so they leave '
      + 'every count of people. Their checklist and history stay, and New Hires lists them for the rest of their year. '
      + 'Only for a new hire New Hires lists: one who joined in the last twelve months. Audited.',
  })
  @ApiResponse(refusal(
    403,
    '`PERM_DENIED` — an Agent who leads, or a read-only support session. `ORG_REMOVAL_NOT_PERMITTED` — the office’s '
    + 'root member or its owner, whom nobody removes from inside the office.',
  ))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — nobody you may mark: somebody you do not coach, a member who has left the office, yourself, or an '
    + 'id that is nobody’s — deliberately indistinguishable from one in another office.',
  ))
  @ApiResponse(refusal(
    409,
    '`NOT_A_NEW_HIRE` — they joined as an existing agent. `NEW_HIRE_NOT_MARKABLE` — they joined more than twelve '
    + 'months ago, so New Hires no longer lists them (`details.reason: past_the_year`); remove them instead. '
    + '`NEW_HIRE_HAS_REPORTS` — somebody reports to them: move them '
    + 'first; `details.directCount` says how many. `NEW_HIRE_ALREADY_LEFT` — they are marked as left already; '
    + '`details.leftOn` says when.',
  ))
  @ApiResponse({ status: 200, type: NewHireMarkedLeftDto })
  async markLeft(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.hires.markLeft(ctx, membershipId);
  }

  @Get(':membershipId')
  @RequirePermission('activation:read')
  @ApiOperation({
    summary: 'One hire’s activation',
    description:
      'As the hire reads it, in any state — without their own note and date on each item. The detail page, '
      + 'and a coaching page’s Activation tab. A recorded read.',
  })
  @ApiResponse(refusal(404, NOT_REACHED))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async detail(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.hires.detail(ctx, membershipId);
  }

  @Get(':membershipId/closings')
  @RequirePermission('activation:read')
  @ApiOperation({
    summary: 'A hire’s closings',
    description:
      'Their sales leads that reached Paid and issued, newest first, with the day each first did: what *Which case?* '
      + 'offers when you tick *Close first case independently* or *Reach Independent Agent milestone* for them. For a '
      + 'leader who reads their leads; a recorded read.',
  })
  @ApiResponse(refusal(404, `${NOT_REACHED} Or you do not read their leads.`))
  @ApiResponse({ status: 200, type: ActivationClosingsDto })
  async closings(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.hires.closings(ctx, membershipId);
  }

  @Put(':membershipId/items/:code')
  @RequirePermission('activation:update_manual_item')
  @ApiOperation({
    summary: 'Tick or untick a hire’s item',
    description:
      'Sets one manual item of a hire you coach done or not, in your name. An item that completes on its own '
      + 'is never ticked by hand. **An item that completes from sales or coaching data is ticked with its record** '
      + '(`record`): the closing it names — one of theirs, or a new one logged in their leads — or the 1:1, saved as a '
      + 'coaching session with them. The tick and the record are saved together, and the tick reads *waiting for data* '
      + 'until the data confirms it.',
  })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — a record on an item that takes none, a record of the wrong kind, or its day outside the '
    + 'hire’s join date to today; a new closing without a name, or a 1:1 without a note.',
  ))
  @ApiResponse(refusal(
    403,
    '`PERM_DENIED` — a 1:1 logged by a leader who runs no coaching sessions: an Agent who leads.',
  ))
  @ApiResponse(refusal(404, `${NOT_REACHED} Or their checklist has no item with that code, or the closing named is not theirs.`))
  @ApiResponse(refusal(409, `\`ACTIVATION_ITEM_AUTOMATIC\` — the item completes on its own. ${CLOSED}`))
  @ApiResponse(refusal(
    422,
    '`ACTIVATION_RECORD_REQUIRED` — a tick of an item that completes from sales or coaching data, sent without its '
    + 'record. `details.form` says which: `closing` or `one_on_one`.',
  ))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async tick(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Param('code') code: string,
    @Body() body: TickHireActivationItemDto,
  ) {
    return this.hires.tick(ctx, membershipId, code, body);
  }

  @Put(':membershipId/start-date')
  @RequirePermission('activation:set_start_date')
  @ApiOperation({
    summary: 'Correct a hire’s join date',
    description:
      'The day they joined, when it was not the day they were added here. It moves their join date and their '
      + 'activation’s start, which is the join date, together; it does not change whether they are a new hire, '
      + 'which was decided once. The day and the end are recomputed; who corrected it and when are kept, and the '
      + 'old and new dates recorded. The body’s field keeps its name, `startDate`.',
  })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — not a day, a day after the office’s today, or more than 365 days before it.',
  ))
  @ApiResponse(refusal(404, NOT_REACHED))
  @ApiResponse(refusal(409, CLOSED))
  @ApiResponse({ status: 200, type: ActivationViewDto })
  async correctStart(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() body: CorrectActivationStartDto,
  ) {
    return this.hires.correctStart(ctx, membershipId, body.startDate);
  }

  @Put(':membershipId/note')
  @RequirePermission('activation_note:write')
  @ApiOperation({
    summary: 'Save your coaching note to a hire',
    description:
      'One note per hire, replacing the one before it, kept with who wrote it and when — and read by the hire '
      + 'on their own activation page.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — empty once trimmed, or longer than 1,000 characters.'))
  @ApiResponse(refusal(404, NOT_REACHED))
  @ApiResponse(refusal(409, CLOSED))
  @ApiResponse({ status: 200, type: ActivationNoteSavedDto })
  async saveNote(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() body: SaveActivationNoteDto,
  ) {
    return this.hires.saveNote(ctx, membershipId, body.text);
  }
}
