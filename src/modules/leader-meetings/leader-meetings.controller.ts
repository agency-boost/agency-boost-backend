import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { LEADER_MEETING_SHARE_DAYS } from '@/domain/constants';
import {
  AddAgendaItemDto, CreateLeaderMeetingDto, LeaderMeetingsQueryDto, LeaderMeetingVersionQueryDto,
  ReorderActionItemsDto, RescheduleLeaderMeetingDto, SaveActionItemDto, SaveAgendaItemDto, SaveMonthlyTargetDto,
} from './leader-meetings.dto';
import {
  AgendaItemDto, AgendaItemSavedDto, LeaderActionItemDto, MeetingCardDto, MeetingListViewDto, MeetingViewDto,
  MonthlyTargetSavedDto, ShareLinkDto, ShareLinksRevokedDto,
} from './leader-meetings.response.dto';
import { LeaderMeetingMinutes } from './leader-meeting-minutes.service';
import { LeaderMeetingSharing } from './leader-meeting-sharing.service';
import { LeaderMeetingsService } from './leader-meetings.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * One description for every 404 the forum gives — the derived one says *another office*, and so does this: a
 * refusal never confirms that a meeting exists.
 */
const NOT_FOUND = refusal(
  404,
  '`NOT_FOUND` — no such meeting, **or** it belongs to another office, was deleted, or the reader is a field member not '
  + 'tagged *Core Leader*. All one answer: a `403` here would confirm the meeting exists.',
);

/** The guard's two refusals, and the forum's own 404, for a route the field's Core Leaders reach. */
const REFUSED = refusal(
  403,
  '`PERM_DENIED` — a role without the permission, or any write in a read-only support session; `details.permission` '
  + 'names it. `TENANT_NO_MEMBERSHIP` — a Super Admin outside a support session belongs to no agency.',
);

/** An item's write that met a newer one. */
const ITEM_CONFLICT = refusal(
  409,
  '`VERSION_CONFLICT` — that same item changed since you read it, or was removed. A write to another item lands. Read '
  + 'the meeting again.',
);

/** Making, moving and deleting are the Owner's and the Admins'; a Core Leader is refused by the guard. */
const OFFICE_ONLY = refusal(
  403,
  '`PERM_DENIED` — a Core Leader, or any other field member, or a write in a read-only support session. '
  + '`TENANT_NO_MEMBERSHIP` — a Super Admin outside a support session.',
);

/**
 * **The Strategic Leader Forum** (`functional/leader-forum.md`, the Data contract): the agency's numbered *Strategic
 * Check-in* meetings, written together by the Owner, the Admins and the members tagged *Core Leader*, and shared
 * read-only with the agency by a link that expires.
 *
 * **`shared/:token` is declared before `:meetingId`**, and a meeting id that is not an id answers 404, so neither
 * route takes the other's requests. No write route takes a token.
 */
@ApiTags('leader-forum')
@ApiBearerAuth()
@Controller('leader-meetings')
export class LeaderMeetingsController {
  constructor(
    private readonly forum: LeaderMeetingsService,
    private readonly minutes: LeaderMeetingMinutes,
    private readonly sharing: LeaderMeetingSharing,
  ) {}

  @Get()
  @RequirePermission('leader_meeting:read')
  @ApiOperation({
    summary: 'The agency’s meetings',
    description:
      'Every meeting of the agency, newest first by date: its number, title and date, *Upcoming* or *Completed* by the '
      + 'agency’s calendar, who can edit it — live while it is upcoming, the list written onto it once it was read after '
      + 'its date — and its open action items. Whether the reader may make one. Not paginated; nothing is recorded.',
  })
  @ApiResponse({ status: 200, type: MeetingListViewDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — this read takes no query parameter; one of any name is refused.'))
  @ApiResponse(REFUSED)
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — a field member not tagged *Core Leader*, answered as another office’s meeting is: as if there were nothing.',
  ))
  async list(@Ctx() ctx: RequestContext, @Query() _query: LeaderMeetingsQueryDto) {
    return this.forum.list(ctx);
  }

  @Post()
  @RequirePermission('leader_meeting:create')
  @ApiOperation({
    summary: 'Make a meeting',
    description:
      '*+ New meeting*: numbered one past the agency’s highest meeting not deleted, its agenda the latest meeting’s, '
      + 'every box unticked — or, for the agency’s first, the ten items every forum starts from — and no action items. '
      + 'Audited.',
  })
  @ApiResponse({ status: 201, type: MeetingCardDto })
  @ApiResponse(OFFICE_ONLY)
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateLeaderMeetingDto) {
    return this.forum.create(ctx, body);
  }

  @Get('shared/:token')
  @RequirePermission('leader_meeting:read_shared_link')
  @ApiOperation({
    summary: 'Open a shared meeting',
    description:
      'The meeting a live link of the reader’s own agency names, **read-only** whoever opens it: every `can` false but '
      + '`print`. An unknown, expired or revoked link, a deleted meeting and another agency’s link are one answer. '
      + 'Each opening is recorded. An opening after the meeting’s date can be the read that keeps its scorecard.',
  })
  @ApiResponse({ status: 200, type: MeetingViewDto })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — the link is unknown, expired, revoked, of a deleted meeting, or another office’s. One answer for '
    + 'every one of them.',
  ))
  @ApiResponse(refusal(403, '`TENANT_NO_MEMBERSHIP` — a Super Admin outside a support session belongs to no agency.'))
  async openShared(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    return this.sharing.open(ctx, token);
  }

  @Get(':meetingId')
  @RequirePermission('leader_meeting:read')
  @ApiOperation({
    summary: 'A meeting',
    description:
      'The head, who can edit it, *Overview & Stats*, the agenda and the action items in their order, who may edit now, '
      + 'and what the reader may do. The scorecard is computed on every read while the meeting is upcoming; **the first '
      + 'read once it is over writes it, and the editors, onto the meeting** for good — except in a read-only support '
      + 'session, which is answered them and writes nothing. Typed targets laid over it. Not recorded as a read of '
      + 'anybody’s data.',
  })
  @ApiResponse({ status: 200, type: MeetingViewDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async read(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string) {
    return this.forum.read(ctx, meetingId);
  }

  @Patch(':meetingId')
  @RequirePermission('leader_meeting:reschedule')
  @ApiOperation({
    summary: 'Move a meeting',
    description:
      'The title, the date or both, pinned to the head’s version, while the meeting is upcoming — whether or not '
      + 'anybody has written in it. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: MeetingCardDto })
  @ApiResponse(refusal(
    409,
    '`LEADER_MEETING_COMPLETED` — the meeting has taken place, so its date stays. `VERSION_CONFLICT` — its title or date '
    + 'changed since you read it.',
  ))
  @ApiResponse(NOT_FOUND)
  @ApiResponse(OFFICE_ONLY)
  async reschedule(
    @Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Body() body: RescheduleLeaderMeetingDto,
  ) {
    return this.forum.reschedule(ctx, meetingId, body);
  }

  @Delete(':meetingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('leader_meeting:delete')
  @ApiOperation({
    summary: 'Delete a meeting',
    description:
      'Only one nobody has written in — no agenda item, box, action item or target saved since it was made. It leaves '
      + 'the list, its address answers not found, and its number may be given again. Audited.',
  })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse(refusal(
    409,
    '`LEADER_MEETING_HAS_MINUTES` — somebody has written in it, so it is kept. `VERSION_CONFLICT` — it changed since you '
    + 'read it.',
  ))
  @ApiResponse(NOT_FOUND)
  @ApiResponse(OFFICE_ONLY)
  async remove(
    @Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Query() query: LeaderMeetingVersionQueryDto,
  ) {
    await this.forum.remove(ctx, meetingId, query.version);
  }

  @Post(':meetingId/agenda-items')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Add an agenda item',
    description: '*+ Add item*: *"New agenda item"*, no PIC, unticked, last in its section. Audited.',
  })
  @ApiResponse({ status: 201, type: AgendaItemDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async addAgendaItem(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Body() body: AddAgendaItemDto) {
    return this.minutes.addAgendaItem(ctx, meetingId, body.section);
  }

  @Patch(':meetingId/agenda-items/:itemId')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Save an agenda item’s field',
    description:
      'One field — the text, the PIC, or on *During* the box — with the item’s version. A text emptied removes the '
      + 'item, answered `{ removed: true }`. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: AgendaItemSavedDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — not exactly one field, a field too long or unknown, or `done` on an item outside *During*.',
  ))
  @ApiResponse(ITEM_CONFLICT)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async saveAgendaItem(
    @Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Param('itemId') itemId: string,
    @Body() body: SaveAgendaItemDto,
  ) {
    return this.minutes.saveAgendaItem(ctx, meetingId, itemId, body);
  }

  @Post(':meetingId/action-items')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Add an action item',
    description:
      '*+ Add action item*: *New initiative* · *Success metric* · *New action item* · *TBD* · *Not yet planned* · '
      + '*TBD*, last. Audited.',
  })
  @ApiResponse({ status: 201, type: LeaderActionItemDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async addActionItem(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string) {
    return this.minutes.addActionItem(ctx, meetingId);
  }

  @Put(':meetingId/action-items/order')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Reorder the action items',
    description: 'Every row’s id in its new place. Refused when a row was added or removed since you read them. Audited.',
  })
  @ApiResponse({ status: 200, type: LeaderActionItemDto, isArray: true })
  @ApiResponse(refusal(409, '`VERSION_CONFLICT` — the rows are not the meeting’s: one was added or removed since you read them.'))
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async reorderActionItems(
    @Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Body() body: ReorderActionItemsDto,
  ) {
    return this.minutes.reorderActionItems(ctx, meetingId, body.itemIds);
  }

  @Patch(':meetingId/action-items/:itemId')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Save an action item’s field',
    description: 'One cell, or the status, with the row’s version. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: LeaderActionItemDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — not exactly one field, a field too long or unknown, or an unknown status.'))
  @ApiResponse(ITEM_CONFLICT)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async saveActionItem(
    @Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Param('itemId') itemId: string,
    @Body() body: SaveActionItemDto,
  ) {
    return this.minutes.saveActionItem(ctx, meetingId, itemId, body);
  }

  @Delete(':meetingId/action-items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({ summary: 'Remove an action item', description: '×: the row, pinned to its version. Audited with what it was.' })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiResponse(ITEM_CONFLICT)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async removeActionItem(
    @Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Param('itemId') itemId: string,
    @Query() query: LeaderMeetingVersionQueryDto,
  ) {
    await this.minutes.removeActionItem(ctx, meetingId, itemId, query.version);
  }

  @Put(':meetingId/monthly-targets/:row')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Save a Monthly Target cell',
    description:
      'The leaders’ own target for one of the six rows the scorecard leaves open — `ape`, `manpower`, `flc`, `new_aa`, '
      + '`avg_monthly_aa`, `case_submission` — with the cell’s version, 0 for one never typed. Never kept with the '
      + 'scorecard: it stays editable. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: MonthlyTargetSavedDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a row the scorecard blocks or does not have, or a value too long.'))
  @ApiResponse(ITEM_CONFLICT)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async saveMonthlyTarget(
    @Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Param('row') row: string,
    @Body() body: SaveMonthlyTargetDto,
  ) {
    return this.minutes.saveMonthlyTarget(ctx, meetingId, row, body);
  }

  @Post(':meetingId/share-links')
  @RequirePermission('leader_meeting:share_link')
  @ApiOperation({
    summary: 'Share a meeting',
    description:
      `A fresh link, opening the meeting read-only for the agency’s signed-in members for ${LEADER_MEETING_SHARE_DAYS} `
      + 'days. Its token is in this answer and nowhere else: only its hash is kept, so a link cannot be shown twice. '
      + 'Audited, never with the token.',
  })
  @ApiResponse({ status: 201, type: ShareLinkDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async share(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string) {
    return this.sharing.create(ctx, meetingId);
  }

  @Delete(':meetingId/share-links')
  @RequirePermission('leader_meeting:share_link')
  @ApiOperation({
    summary: 'Stop sharing a meeting',
    description: '*Stop sharing*: every live link to the meeting revoked, each audited. They open nothing after.',
  })
  @ApiResponse({ status: 200, type: ShareLinksRevokedDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async stopSharing(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string) {
    return this.sharing.revokeAll(ctx, meetingId);
  }
}
