import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { NoEventBodyDto, NoEventQueryDto, SubmitEventFeedbackDto } from './event.dto';
import { GuestEventDto, GuestEventListDto } from './event.response.dto';
import { EventGuestService } from './event-guest.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** The rule every route here keeps: outside the reader's audience is the answer an event that is not there gives. */
const OUTSIDE =
  'Another office’s event, an archived one and one whose audience did not hold the reader **as at its start** all '
  + 'answer `404`, deliberately indistinguishable: a `403` would confirm the event exists.';

/**
 * **The agent's *KPM Events*** (`/events`, its modal at `/events/[eventId]`; P18.5-T5, P18.5-T6; roles §3.11;
 * `functional/events.md`). Field routes, apart from the office's settings: no invitee list and no confirmation ever
 * reaches a member. A read-only support session reads and is refused every write by its verb.
 */
@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventGuestController {
  constructor(private readonly guests: EventGuestService) {}

  @Get()
  @RequirePermission('event:read_list')
  @ApiOperation({
    summary: 'The reader’s events',
    description:
      'Active events whose audience holds the reader as at the event’s start (an upcoming one: the office now), '
      + 'in start order, each with the reader’s own RSVP, claim and answer, the day and time in the office’s zone, '
      + 'the limits the form needs and what the reader may do. Takes no parameter.',
  })
  @ApiResponse({ status: 200, type: GuestEventListDto })
  async list(@Ctx() ctx: RequestContext, @Query() _query: NoEventQueryDto) {
    return this.guests.list(ctx);
  }

  @Get(':eventId')
  @RequirePermission('event:read_list')
  @ApiOperation({ summary: 'One event, as the modal reads it', description: OUTSIDE })
  @ApiResponse({ status: 200, type: GuestEventDto })
  async read(@Ctx() ctx: RequestContext, @Param('eventId') eventId: string) {
    return this.guests.read(ctx, eventId);
  }

  @Post(':eventId/rsvp')
  @RequirePermission('event:rsvp')
  @ApiOperation({
    summary: '*Join event*',
    description: `Idempotent. A running event still takes it; from \`endsAt\` it is refused. ${OUTSIDE}`,
  })
  @ApiResponse({ status: 201, type: GuestEventDto })
  @ApiResponse(refusal(409, '`EVENT_RSVP_CLOSED` — the event has ended.'))
  async rsvp(@Ctx() ctx: RequestContext, @Param('eventId') eventId: string, @Body() _body: NoEventBodyDto) {
    return this.guests.rsvp(ctx, eventId);
  }

  @Post(':eventId/rsvp/cancel')
  @RequirePermission('event:cancel_rsvp')
  @ApiOperation({ summary: '*Cancel RSVP*', description: `Idempotent; refused from \`endsAt\`. ${OUTSIDE}` })
  @ApiResponse({ status: 201, type: GuestEventDto })
  @ApiResponse(refusal(409, '`EVENT_RSVP_CLOSED` — the event has ended.'))
  async cancelRsvp(@Ctx() ctx: RequestContext, @Param('eventId') eventId: string, @Body() _body: NoEventBodyDto) {
    return this.guests.cancelRsvp(ctx, eventId);
  }

  @Post(':eventId/attendance/claim')
  @RequirePermission('event_attendance:self_claim')
  @ApiOperation({
    summary: '*I actually attended this event*',
    description:
      'Writes the member’s claim and **never attendance** (OD-31): it unlocks the feedback form, and only the '
      + `Owner or an Admin confirms. Idempotent; refused before \`endsAt\` and inside any support session. ${OUTSIDE}`,
  })
  @ApiResponse({ status: 201, type: GuestEventDto })
  @ApiResponse(refusal(409, '`EVENT_NOT_ENDED` — the event has not ended.'))
  async claim(@Ctx() ctx: RequestContext, @Param('eventId') eventId: string, @Body() _body: NoEventBodyDto) {
    return this.guests.claim(ctx, eventId);
  }

  @Post(':eventId/feedback')
  @RequirePermission('event_feedback:submit')
  @ApiOperation({
    summary: 'The member’s answer: a score, *Why?* and *How can we improve?*',
    description:
      'Once (single-submit), from `endsAt`, for a member who RSVP’d, said they came or was confirmed. Both texts '
      + `are trimmed and stored; refused inside any support session. ${OUTSIDE}`,
  })
  @ApiResponse({ status: 201, type: GuestEventDto })
  @ApiResponse(refusal(409, '`EVENT_NOT_ENDED`, `EVENT_NOT_ATTENDED` or `EVENT_FEEDBACK_ALREADY_SUBMITTED`.'))
  async submitFeedback(
    @Ctx() ctx: RequestContext, @Param('eventId') eventId: string, @Body() body: SubmitEventFeedbackDto,
  ) {
    return this.guests.submitFeedback(ctx, eventId, body);
  }
}
