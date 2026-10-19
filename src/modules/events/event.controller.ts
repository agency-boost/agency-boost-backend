import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  EventDto, EventInviteeListDto, EventTypeDto, FeedbackSummaryDto, RollCallDto,
} from './event.response.dto';
import { EventService } from './event.service';
import { EventRollCallService } from './event-roll-call.service';
import { NoEventQueryDto, SaveEventDto, SaveEventTypeDto, SaveRollCallDto } from './event.dto';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * The events an office runs (P5-T6, ADR-0034), and — since Phase 18.5 — what its administration reads of the
 * members' answers: the roll call, the *Feedback Summary* and the audience picker's people (P18.5-T5, P18.5-T6).
 *
 * **Nothing per-person is stored on an event.** RSVP, attendance and feedback are their own per-member records
 * (`eventRsvps`, `eventFeedback`); the member's side is `EventGuestController` at `/events`.
 *
 * **The reads are the Owner's and the Admins'** (`event_settings:read`, T5 AC-2): the list carries leader-only events
 * and invitee lists, which ADR-0039 keeps from members — it sat on `tenant_config:read`, which every member holds.
 * *The exit review (B1):* the types' read moved there too. It carries archived types and how many events name each —
 * leader-only and chosen-people ones counted — and only the settings screen reads it; members read the active types,
 * with no counts, in the published snapshot (`/kpm/config`).
 *
 * The roll call's read is guarded by **`event_attendance:confirm`**, the write it serves (the phase file's *Settled
 * already*; `leader_request:approve` guarding its decline is the precedent) — the same two holders.
 *
 * `invitees` is a literal segment, and the per-event reads are two segments deep, so neither shadows the other.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/events')
export class EventController {
  constructor(
    private readonly events: EventService,
    private readonly rollCalls: EventRollCallService,
  ) {}

  @Get('types')
  @RequirePermission('event_settings:read')
  @ApiOperation({
    summary: 'The office’s event types',
    description:
      'Each with how many events name it, so *Archive* can say what it affects, archived ones on request. The '
      + 'Owner’s and the Admins’ alone: the counts include leader-only and '
      + 'chosen-people events, and no field screen reads this — members read the active types in `/kpm/config`.',
  })
  @ApiResponse({ status: 200, type: EventTypeDto, isArray: true })
  async listTypes(@Ctx() ctx: RequestContext, @Query('includeArchived') archived?: string) {
    return this.events.listTypes(ctx, archived === 'true');
  }

  @Post('types')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Add an event type' })
  @ApiResponse({ status: 201, type: EventTypeDto })
  async createType(@Ctx() ctx: RequestContext, @Body() dto: SaveEventTypeDto) {
    return this.events.createType(ctx, dto);
  }

  @Patch('types/:id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Change an event type',
    description: 'Never the code: an event that already happened points at it.',
  })
  @ApiResponse({ status: 200, type: EventTypeDto })
  async updateType(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: SaveEventTypeDto,
  ) {
    return this.events.updateType(ctx, id, dto);
  }

  @Post('types/:id/archive')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Archive an event type',
    description:
      'The prototype’s control is a red **Delete**. An event that already happened renders the '
      + 'type it was, and a type that vanished would leave every one of those events describing '
      + 'nothing. Archiving keeps it readable and stops new events being filed under it.',
  })
  @ApiResponse({ status: 201, type: EventTypeDto })
  async archiveType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.archiveType(ctx, id);
  }

  @Post('types/:id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring an event type back' })
  @ApiResponse({ status: 201, type: EventTypeDto })
  async restoreType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.restoreType(ctx, id);
  }

  @Get()
  @RequirePermission('event_settings:read')
  @ApiOperation({
    summary: 'The office’s events',
    description:
      'In start order, each with its phase **derived now** — upcoming, running or past — and the '
      + 'calendar day in the office’s own timezone, so no browser re-derives it in its own. The Owner’s and the '
      + 'Admins’ alone: it carries leader-only events and invitee lists.',
  })
  @ApiResponse({ status: 200, type: EventDto, isArray: true })
  async list(@Ctx() ctx: RequestContext, @Query('includeArchived') archived?: string) {
    return this.events.list(ctx, archived === 'true');
  }

  @Post()
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Add an event',
    description:
      '`endsAt` is required and must be after `startsAt`: without an end, *"is it running now?"* '
      + 'has no answer and a status has to be typed in by hand, which is the prototype’s defect.',
  })
  @ApiResponse({ status: 201, type: EventDto })
  async create(@Ctx() ctx: RequestContext, @Body() dto: SaveEventDto) {
    return this.events.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Change an event',
    description:
      'An event that has ended and that somebody has answered — an RSVP, a claim, a confirmation or feedback — '
      + 'cannot be moved so that it ends in the future.',
  })
  @ApiResponse({ status: 200, type: EventDto })
  @ApiResponse(refusal(409, '`EVENT_HAS_RESPONSES` — an answered event moved back into the future.'))
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: SaveEventDto) {
    return this.events.update(ctx, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Archive an event' })
  @ApiResponse({ status: 201, type: EventDto })
  async archive(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.archive(ctx, id);
  }

  @Post(':id/restore')
  @RequirePermission('tenant_config:write')
  @ApiOperation({ summary: 'Bring an event back' })
  @ApiResponse({ status: 201, type: EventDto })
  async restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.events.restore(ctx, id);
  }

  // ---------------------------------------------------------------- Phase 18.5 (P18.5-T5, P18.5-T6)

  @Get('invitees')
  @RequirePermission('event_settings:read')
  @ApiOperation({
    summary: 'The audience picker’s people (D-picker)',
    description:
      'Every active member of the office, with the rung and whether they lead somebody now — *Chosen leaders* '
      + 'lists only those. Searched on the screen; takes no parameter.',
  })
  @ApiResponse({ status: 200, type: EventInviteeListDto })
  async invitees(@Ctx() ctx: RequestContext, @Query() _query: NoEventQueryDto) {
    return this.rollCalls.invitees(ctx);
  }

  @Get(':id/attendance')
  @RequirePermission('event_attendance:confirm')
  @ApiOperation({
    summary: 'The roll call (D-rollcall)',
    description:
      'The audience as at the event’s start, each with their RSVP or claim, the confirmation, the status and '
      + 'whether they answered; the attendance rate; and whether the reader may confirm now. Guarded by the '
      + 'confirm it serves (as `leader_request:approve` guards its decline), so a read-only support session is '
      + 'refused it by its verb. Readable at any phase; another office’s event is `404`.',
  })
  @ApiResponse({ status: 200, type: RollCallDto })
  async rollCall(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() _query: NoEventQueryDto) {
    return this.rollCalls.rollCall(ctx, id);
  }

  @Put(':id/attendance')
  @RequirePermission('event_attendance:confirm')
  @ApiOperation({
    summary: 'Confirm attendance (OD-31)',
    description:
      '`true` attended, `false` marked absent, `null` cleared. Only a confirmation makes *attended*; nobody '
      + 'confirms their own. Changed rows only, each audited with before, after and the confirmer.',
  })
  @ApiResponse({ status: 200, type: RollCallDto })
  @ApiResponse(refusal(400, '`EVENT_ATTENDANCE_SELF` — the caller’s own membership; nothing is written.'))
  @ApiResponse(refusal(409, '`EVENT_NOT_ENDED` — before the event ends.'))
  async saveRollCall(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: SaveRollCallDto) {
    return this.rollCalls.saveRollCall(ctx, id, body);
  }

  @Get(':id/feedback')
  @RequirePermission('event_feedback:read')
  @ApiOperation({
    summary: 'The *Feedback Summary* (OD-151)',
    description:
      'Every answer from the audience with its author’s name, the NPS over confirmed attendees (`null` with '
      + 'none), and how many await confirmation. The office’s administration’s alone: a member’s own grant is '
      + 'refused `403`.',
  })
  @ApiResponse({ status: 200, type: FeedbackSummaryDto })
  async feedbackSummary(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() _query: NoEventQueryDto) {
    return this.rollCalls.feedbackSummary(ctx, id);
  }
}
