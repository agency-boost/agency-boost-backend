import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { LEADER_MEETING_SHARE_DAYS } from '@/domain/constants';
import {
  AddActionItemDto, AddAgendaItemDto, CreateLeaderMeetingDto, LeaderMeetingsQueryDto, LeaderMeetingVersionQueryDto,
  RescheduleLeaderMeetingDto, SaveActionItemDto, SaveAgendaItemDto,
} from './leader-meetings.dto';
import {
  AgendaItemDto, AgendaItemSavedDto, LeaderActionItemDto, MeetingCardDto, MeetingListViewDto, MeetingViewDto, ShareLinkDto,
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
  '`NOT_FOUND` — no such forum, **or** it belongs to another office, was deleted, or the reader is a field member who is '
  + 'no core leader. All one answer: a `403` here would confirm the forum exists.',
);

/** The guard's two refusals, and the forum's own 404, for a route the field's Core Leaders reach. */
const REFUSED = refusal(
  403,
  '`PERM_DENIED` — a role without the permission, or any write in a read-only support session; `details.permission` '
  + 'names it. `TENANT_NO_MEMBERSHIP` — a Super Admin who has entered no KPM belongs to no agency.',
);

/** An item's write that met a newer one. */
const ITEM_CONFLICT = refusal(
  409,
  '`VERSION_CONFLICT` — that same item changed since you read it, or was removed. A write to another item lands. Read '
  + 'the meeting again.',
);

/** Making, moving and deleting are the stewards' (ADR-0268): a field member who is no core leader is refused by the guard. */
const OFFICE_ONLY = refusal(
  403,
  '`PERM_DENIED` — a field member who is no core leader, or a write in a read-only support session. '
  + '`TENANT_NO_MEMBERSHIP` — a Super Admin who has entered no KPM.',
);

/**
 * **The Strategic Leader Forum** (`functional/leader-forum.md`, the Data contract; P19.22-T8, ADR-0276): the agency's
 * numbered forums of its core leaders — a date and time, one agenda checklist and the action items, the unfinished
 * ones carried to the next forum — written together by the Super Admin inside the KPM, the Owner, the Admins and the
 * core leaders, and shared read-only with the agency by a link that expires (*Bagikan*, in a WhatsApp message).
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
    summary: 'The agency’s forums',
    description:
      'Every forum of the agency, newest first by date and time: its number, date, time, *Akan datang* or *Selesai* by the '
      + 'agency’s calendar, the office days until it, its agenda’s count and *Action items x/y selesai*; *Forum berikutnya*; '
      + 'the core leaders; whether the reader may make one. Not paginated; nothing is recorded.',
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
    summary: 'Make a forum',
    description:
      '*+ Forum baru*: a date and a time; numbered one past the agency’s highest forum not deleted; its agenda the previous '
      + 'forum’s, every box unticked — or, for the agency’s first, three lines — and **the previous forum’s action items '
      + 'not *Selesai*, carried** (*dari forum #n*). Audited.',
  })
  @ApiResponse({ status: 201, type: MeetingCardDto })
  @ApiResponse(OFFICE_ONLY)
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateLeaderMeetingDto) {
    return this.forum.create(ctx, body);
  }

  @Get('shared/:token')
  @RequirePermission('leader_meeting:read_shared_link')
  @ApiOperation({
    summary: 'Open a shared forum',
    description:
      'The forum a live link of the reader’s own agency names, **read-only** whoever opens it: every `can` false but '
      + '`print`. An unknown, expired or revoked link, a deleted forum and another agency’s link are one answer. '
      + 'Each opening is recorded.',
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
    summary: 'A forum',
    description:
      'The head, the core leaders, every person it names, the agenda and the action items in their order, and what the '
      + 'reader may do. Its *MAPA driver* and *Informal group* tabs are Advanced analytics’ own reads. Not recorded as a '
      + 'read of anybody’s data.',
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
    summary: 'Move a forum',
    description:
      'The date, the time or both, pinned to the head’s version, while the forum is upcoming — whether or not anybody has '
      + 'written in it. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: MeetingCardDto })
  @ApiResponse(refusal(
    409,
    '`LEADER_MEETING_COMPLETED` — the forum has taken place, so its date stays. `VERSION_CONFLICT` — its date or time '
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
    summary: 'Delete a forum',
    description:
      'Only one nobody has written in — no agenda line, box or action item saved in it since it was made. It leaves the '
      + 'list, its address answers not found, and its number may be given again. Audited.',
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
    summary: 'Add an agenda line',
    description: '*+ Tambah agenda*: the line typed, its PIC — an editor, or `"all"` (*Semua*) — if chosen, unticked, last. Audited.',
  })
  @ApiResponse({ status: 201, type: AgendaItemDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — an empty or too long text, or a PIC who is not one of the forum’s editors.'))
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async addAgendaItem(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Body() body: AddAgendaItemDto) {
    return this.minutes.addAgendaItem(ctx, meetingId, body);
  }

  @Patch(':meetingId/agenda-items/:itemId')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Save an agenda line’s field',
    description:
      'One field — the text, the PIC (an editor, `"all"` or `null`) or the box — with the line’s version. A text emptied '
      + 'removes the line, answered `{ removed: true }`. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: AgendaItemSavedDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — not exactly one field, a field too long or unknown, or a PIC who is not one of the forum’s editors.',
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
      '*+ Tambah action item*: the text typed, its PIC (an editor) and *tenggat* if chosen, *Belum*, last — and carried at '
      + 'once into every later forum (*dari forum #n*). Audited.',
  })
  @ApiResponse({ status: 201, type: LeaderActionItemDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — an empty or too long text, a date that is not a day, or a PIC who is not an editor.'))
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async addActionItem(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string, @Body() body: AddActionItemDto) {
    return this.minutes.addActionItem(ctx, meetingId, body);
  }

  @Patch(':meetingId/action-items/:itemId')
  @RequirePermission('leader_meeting:edit')
  @ApiOperation({
    summary: 'Save an action item’s field',
    description:
      'One field — the text, the PIC, the *tenggat* or the state (*Belum · Proses · Selesai*) — with the item’s version; '
      + 'then that field on the copies of its lineage in every later forum, never an earlier one. A state set back from '
      + '*Selesai* carries it into a later forum that has no copy. Audited with before and after.',
  })
  @ApiResponse({ status: 200, type: LeaderActionItemDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — not exactly one field, an empty or too long text, an unknown state, a date that is not a day, or '
    + 'a PIC who is not one of the forum’s editors.',
  ))
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
  @ApiOperation({
    summary: 'Remove an action item',
    description:
      'The trash, after *Hapus action item?*: the item, pinned to its version, **and its copies in every later forum**. An '
      + 'earlier forum keeps its own. Audited with what it was.',
  })
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

  @Post(':meetingId/share-links')
  @RequirePermission('leader_meeting:share_link')
  @ApiOperation({
    summary: 'Share a forum',
    description:
      `*Bagikan*: a fresh link, opening the forum read-only for the agency’s signed-in members for ${LEADER_MEETING_SHARE_DAYS} `
      + 'days, which the screen sends in a WhatsApp message. Its token is in this answer and nowhere else: only its hash is '
      + 'kept, so a link cannot be shown twice. Audited, never with the token.',
  })
  @ApiResponse({ status: 201, type: ShareLinkDto })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REFUSED)
  async share(@Ctx() ctx: RequestContext, @Param('meetingId') meetingId: string) {
    return this.sharing.create(ctx, meetingId);
  }
}
