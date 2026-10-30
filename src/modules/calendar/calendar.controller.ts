import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  AnswerCalendarEntryDto, CalendarDownlineQueryDto, CalendarEntriesQueryDto, CalendarPeopleQueryDto,
  CalendarSettingsQueryDto, CreateCalendarBlockDto, CreateCalendarEntryDto, DeleteCalendarEntryQueryDto,
  SaveCalendarSettingsDto, UpdateCalendarEntryDto,
} from './calendar.dto';
import {
  CalendarBusyBlockDto, CalendarDeletedDto, CalendarDownlineDto, CalendarEntryDto, CalendarHiddenTaskDto,
  CalendarJoinedEventDto, CalendarPeriodDto, CalendarSettingsDto, CalendarTaskDto,
} from './calendar.response.dto';
import { CalendarService } from './calendar.service';
import { CalendarPeopleService } from './calendar-people.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** A 404 for a route whose path names nothing: described as indistinguishable from another office's. */
const NOT_FOUND_ANOTHER_OFFICE =
  'deliberately indistinguishable from one in another office: a `403` would confirm that somebody exists.';

/**
 * **The calendar** (`functional/calendar.md`, the Data contract; roles §3.15).
 *
 * **Literal paths beside `entries`**: `people`, `downline`, `blocks` and `settings` are siblings of
 * `entries`, and `entries/:entryId` is declared after `entries`, so no parameter route can shadow a
 * literal one.
 */
@ApiTags('calendar')
@ApiBearerAuth()
@ApiExtraModels(CalendarBusyBlockDto, CalendarTaskDto, CalendarHiddenTaskDto, CalendarJoinedEventDto)
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly people: CalendarPeopleService,
  ) {}

  @Get('entries')
  @RequirePermission('calendar_entry:read')
  @ApiOperation({
    summary: 'A week, a month, an Agenda or 3 Hari of a calendar',
    description:
      'Your own calendar — every entry you organise, and every one you are on and have not declined — for '
      + 'the week or the month holding `date`, or the Agenda’s or *3 Hari*’s days from it, with the period’s days, '
      + 'the dates ‹ and › ask for, and the office’s today and now: nothing is worked out in the browser. Weeks run '
      + 'Monday to Sunday in the office’s zone; a month is padded to whole weeks, and its padding days carry their '
      + 'entries too.\n\n'
      + 'Beside the entries, **what other features put on it** (UI V1): `tasks` — lead next actions and open coaching '
      + 'action items, dated with no time — and `events`, the events you said you are going to. Read from their '
      + 'sources each time, so a change there shows here at once; none can be edited here.\n\n'
      + 'With `for`, the week or the month of somebody you coach, beside your own: everything they organised in full, and '
      + 'an entry they only attend in full only when you could read it yourself — otherwise as a busy block. '
      + 'An entry organised by somebody who hides their details is a busy block too, unless you are on it. '
      + 'Each such read is recorded.',
  })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `for` names nobody you coach: a peer, somebody in another team, a member who has left, '
    + `yourself, or an id that is nobody’s — ${NOT_FOUND_ANOTHER_OFFICE}`,
  ))
  @ApiResponse({ status: 200, type: CalendarPeriodDto })
  async read(@Ctx() ctx: RequestContext, @Query() query: CalendarEntriesQueryDto) {
    return this.calendar.read(ctx, query);
  }

  @Get('people')
  @RequirePermission('calendar_invitee:search')
  @ApiOperation({
    summary: 'People you can invite',
    description:
      'The active field members of your office, never you, searched by a part of their full name: each '
      + 'person’s name, rung, leader’s name, and where they sit relative to you — your direct unit, your '
      + 'group, other units, or your leadership — in that order, then down the tree. Paged by a cursor.',
  })
  async searchPeople(@Ctx() ctx: RequestContext, @Query() query: CalendarPeopleQueryDto) {
    return this.people.people(ctx, query);
  }

  @Get('downline')
  @RequirePermission('calendar_entry:read')
  @ApiOperation({
    summary: 'People whose calendar you can compare',
    description:
      'Everybody you coach now, at any depth: your direct agents, then each leader who answers to you with '
      + 'their whole team after them. Nobody when you lead nobody. Not paginated.',
  })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — this read takes no query parameter. One sent, of any name, is refused, and `details` names it.',
  ))
  @ApiResponse({ status: 200, type: CalendarDownlineDto })
  async downline(@Ctx() ctx: RequestContext, @Query() _query: CalendarDownlineQueryDto) {
    return this.people.downline(ctx);
  }

  @Get('settings')
  @RequirePermission('calendar_entry:read')
  @ApiOperation({
    summary: 'Your calendar settings',
    description:
      'Your own, and nobody else’s: whether *Hide my personal activities* is on. Off until you turn it on.',
  })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — this read takes no query parameter. One sent, of any name, is refused, and `details` names it.',
  ))
  @ApiResponse({ status: 200, type: CalendarSettingsDto })
  async readSettings(@Ctx() ctx: RequestContext, @Query() _query: CalendarSettingsQueryDto) {
    return this.calendar.settings(ctx);
  }

  @Put('settings')
  @RequirePermission('calendar_entry:update')
  @ApiOperation({
    summary: 'Hide my personal activities',
    description:
      'Your own setting, sent whole. On, a leader comparing your week with theirs sees each entry you '
      + 'organise as *Busy* with its time and nothing else, unless they are on it; the people on an entry '
      + 'still read it in full, and your own calendar is unchanged. Off, they read what you organise in '
      + 'full. A change is recorded; sending what is set already changes nothing.',
  })
  @ApiResponse({ status: 200, type: CalendarSettingsDto })
  async saveSettings(@Ctx() ctx: RequestContext, @Body() body: SaveCalendarSettingsDto) {
    return this.calendar.saveSettings(ctx, body);
  }

  @Post('blocks')
  @RequirePermission('calendar_entry:block')
  @ApiOperation({
    summary: 'Block time on somebody you coach',
    description:
      'Your own entry, placed straight onto their calendar with no approval needed: they are on it as '
      + 'placed, read it and cannot answer it, and are told once. Others may be invited beside them. You '
      + 'edit and delete it as any entry of yours.',
  })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `membershipId` names nobody you coach (a peer, somebody in another team, a member who '
    + `has left, yourself, nobody’s id), or \`details.inviteeIds\` names invitees who are not active members — ${NOT_FOUND_ANOTHER_OFFICE}`,
  ))
  @ApiResponse({ status: 201, type: CalendarEntryDto })
  async block(@Ctx() ctx: RequestContext, @Body() body: CreateCalendarBlockDto) {
    return this.calendar.block(ctx, body);
  }

  @Post('entries')
  @RequirePermission('calendar_entry:create')
  @ApiOperation({
    summary: 'Create an entry',
    description:
      'An entry on your own calendar, of one of the five types: Travel with two office dates, every other '
      + 'type with an office date and two times, the end after the start on that date. Each invitee is '
      + 'asked to accept or decline, and told.',
  })
  @ApiResponse(refusal(
    404,
    `\`NOT_FOUND\` — \`details.inviteeIds\` names each invitee who is not an active member of your office, ${NOT_FOUND_ANOTHER_OFFICE}`,
  ))
  @ApiResponse({ status: 201, type: CalendarEntryDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateCalendarEntryDto) {
    return this.calendar.create(ctx, body);
  }

  @Get('entries/:entryId')
  @RequirePermission('calendar_entry:read')
  @ApiOperation({
    summary: 'One entry',
    description:
      'An entry you organise, or one you are on — whatever your answer, a declined one included, or placed. '
      + 'Anybody else is not found.',
  })
  async readOne(@Ctx() ctx: RequestContext, @Param('entryId') entryId: string) {
    return this.calendar.readOne(ctx, entryId);
  }

  @Patch('entries/:entryId')
  @RequirePermission('calendar_entry:update')
  @ApiOperation({
    summary: 'Edit an entry',
    description:
      'Yours alone, pinned to the version you read. A field sent replaces the stored one; `inviteeIds`, when '
      + 'sent, is the whole invitation list — somebody added is invited, somebody dropped leaves it, and '
      + 'somebody kept keeps their answer. Everybody on it is told when its date or time moves.',
  })
  @ApiResponse(refusal(409, '`VERSION_CONFLICT` — it changed since you read it. Read it again.'))
  @ApiResponse({ status: 200, type: CalendarEntryDto })
  async update(
    @Ctx() ctx: RequestContext, @Param('entryId') entryId: string, @Body() body: UpdateCalendarEntryDto,
  ) {
    return this.calendar.update(ctx, entryId, body);
  }

  @Delete('entries/:entryId')
  @RequirePermission('calendar_entry:delete')
  @ApiOperation({
    summary: 'Delete an entry',
    description:
      'Yours alone, pinned to the version you read. It leaves every calendar it was on, and everybody on it '
      + 'who had not declined is told.',
  })
  @ApiResponse(refusal(409, '`VERSION_CONFLICT` — it changed since you read it. Read it again.'))
  @ApiResponse({ status: 200, type: CalendarDeletedDto })
  async remove(
    @Ctx() ctx: RequestContext, @Param('entryId') entryId: string, @Query() query: DeleteCalendarEntryQueryDto,
  ) {
    return this.calendar.remove(ctx, entryId, query.version);
  }

  @Post('entries/:entryId/answer')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('calendar_entry:answer')
  @ApiOperation({
    summary: 'Accept or decline an invitation',
    description:
      'Your own answer to an entry you are invited to, and nothing else; you can change it later. A '
      + 'declined entry leaves your calendar and stays readable from its notice.',
  })
  @ApiResponse(refusal(
    409,
    '`CALENDAR_BLOCK_NOT_ANSWERABLE` — the time was placed on you by a leader above you: there is nothing to accept or decline.',
  ))
  @ApiResponse({ status: 200, type: CalendarEntryDto })
  async answer(
    @Ctx() ctx: RequestContext, @Param('entryId') entryId: string, @Body() body: AnswerCalendarEntryDto,
  ) {
    return this.calendar.answer(ctx, entryId, body.answer);
  }
}
