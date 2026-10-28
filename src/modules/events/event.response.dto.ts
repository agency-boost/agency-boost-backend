import { ApiProperty } from '@nestjs/swagger';
import {
  EVENT_ATTENDANCE_STATUSES, EVENT_AUDIENCE_SCOPES, EVENT_ISSUERS, EVENT_PHASES,
} from '@/domain/constants';
import { EventAudienceDto } from './event.dto';

export class EventTypeDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emoji!: string | null;

  @ApiProperty({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ enum: ['active', 'archived'] })
  status!: string;

  @ApiProperty({ type: Number, description: 'How many events name it — what *Archive* affects.' })
  events!: number;
}

export class EventDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  typeCode!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  blurb!: string;

  @ApiProperty({ type: String })
  description!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: string;

  @ApiProperty({
    type: String,
    example: '2026-09-18',
    description: 'The calendar day in the **office’s** timezone, so no browser re-derives it in its own.',
  })
  startsOn!: string;

  @ApiProperty({ type: String })
  location!: string;

  @ApiProperty({ type: String, nullable: true })
  locationUrl!: string | null;

  @ApiProperty({ type: EventAudienceDto })
  audience!: EventAudienceDto;

  @ApiProperty({
    enum: EVENT_PHASES,
    description: 'Derived on every read from the instants, never stored.',
  })
  phase!: string;

  @ApiProperty({ enum: ['active', 'archived'] })
  status!: string;

  @ApiProperty({ type: Number })
  version!: number;
}

// ---------------------------------------------------------------- Phase 18.5 (P18.5-T5, P18.5-T6)

export class NpsConstantsDto {
  @ApiProperty({ type: Number, example: 0 }) scaleMin!: number;
  @ApiProperty({ type: Number, example: 10 }) scaleMax!: number;
  @ApiProperty({ type: Number, example: 9, description: 'A promoter scores at least this.' }) promoterMin!: number;
  @ApiProperty({ type: Number, example: 6, description: 'A detractor scores at most this.' }) detractorMax!: number;
}

export class GuestEventTypeDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true }) emoji!: string | null;
  @ApiProperty({ type: String, nullable: true }) color!: string | null;
}

export class GuestEventAudienceDto {
  @ApiProperty({ enum: EVENT_ISSUERS }) issuer!: string;
  @ApiProperty({ enum: EVENT_AUDIENCE_SCOPES }) scope!: string;
}

export class MyEventFeedbackDto {
  @ApiProperty({ type: Number }) score!: number;
  @ApiProperty({ type: String }) why!: string;
  @ApiProperty({ type: String }) improve!: string;
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: string;
}

export class MyEventPartDto {
  @ApiProperty({ enum: ['going', 'cancelled'], nullable: true }) rsvp!: string | null;
  @ApiProperty({ type: Boolean, description: '*"I actually attended this event"* pressed. Never attendance.' }) claimed!: boolean;
  @ApiProperty({ type: MyEventFeedbackDto, nullable: true }) feedback!: MyEventFeedbackDto | null;
}

/** One event as a member of its audience reads it: never the invitee list, never a confirmation. */
export class GuestEventDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) blurb!: string;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ type: GuestEventTypeDto }) type!: GuestEventTypeDto;
  @ApiProperty({ type: GuestEventAudienceDto }) audience!: GuestEventAudienceDto;
  @ApiProperty({ type: String, format: 'date-time' }) startsAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endsAt!: string;
  @ApiProperty({ type: String, example: '2026-10-15', description: 'The day it starts, in the office’s zone.' }) startsOn!: string;
  @ApiProperty({ type: String, example: '14:00', description: '`HH:mm` (24-hour), in the office’s zone.' }) startTime!: string;
  @ApiProperty({ type: String }) location!: string;
  @ApiProperty({ type: String, nullable: true }) locationUrl!: string | null;
  @ApiProperty({ enum: EVENT_PHASES }) phase!: string;
  @ApiProperty({ type: Boolean, description: '`now >= endsAt`: RSVP closed; the claim and the feedback open.' }) ended!: boolean;
  @ApiProperty({ type: MyEventPartDto }) me!: MyEventPartDto;
}

export class GuestEventLimitsDto {
  @ApiProperty({ type: Number, example: 1000 }) feedbackTextMax!: number;
  @ApiProperty({ type: NpsConstantsDto }) nps!: NpsConstantsDto;
}

export class GuestEventCanDto {
  @ApiProperty({ type: Boolean }) rsvp!: boolean;
  @ApiProperty({ type: Boolean }) cancelRsvp!: boolean;
  @ApiProperty({ type: Boolean }) claim!: boolean;
  @ApiProperty({ type: Boolean }) feedback!: boolean;
}

export class GuestEventListDto {
  @ApiProperty({ type: GuestEventDto, isArray: true }) events!: GuestEventDto[];
  @ApiProperty({ type: String, description: 'For *"{company} Event"*.' }) companyName!: string;
  @ApiProperty({ type: String, example: 'Asia/Jakarta' }) timezone!: string;
  @ApiProperty({ type: GuestEventLimitsDto }) limits!: GuestEventLimitsDto;
  @ApiProperty({ type: GuestEventCanDto, description: 'False in a read-only support session: draw no write control.' })
  can!: GuestEventCanDto;
}

export class EventInviteeDto {
  @ApiProperty({ type: String }) membershipId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) orgLevelCode!: string;
  @ApiProperty({ type: String }) rung!: string;
  @ApiProperty({ type: Boolean, description: 'Leads somebody now (the graph): *Chosen leaders* lists only these.' }) leads!: boolean;
}

export class EventInviteeListDto {
  @ApiProperty({ type: EventInviteeDto, isArray: true }) people!: EventInviteeDto[];
}

export class RollCallRowDto {
  @ApiProperty({ type: String }) membershipId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) orgLevelCode!: string;
  @ApiProperty({ type: String }) rung!: string;
  @ApiProperty({ enum: ['rsvp', 'claimed'], nullable: true, description: '*RSVP’d* / *Said they came* / —.' }) said!: string | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'The confirmation: attended, marked absent, or not yet.' }) attended!: boolean | null;
  @ApiProperty({ enum: EVENT_ATTENDANCE_STATUSES }) status!: string;
  @ApiProperty({ type: Boolean, description: 'The caller’s own row: nobody confirms their own.' }) self!: boolean;
  @ApiProperty({ type: String, nullable: true }) confirmedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) confirmedAt!: string | null;
  @ApiProperty({ type: Boolean }) gaveFeedback!: boolean;
}

export class RollCallCountsDto {
  @ApiProperty({ type: Number }) audience!: number;
  @ApiProperty({ type: Number }) attended!: number;
  @ApiProperty({ type: Number }) noShow!: number;
  @ApiProperty({ type: Number }) unconfirmed!: number;
  @ApiProperty({ type: Number }) registered!: number;
  @ApiProperty({ type: Number }) notRegistered!: number;
}

export class RollCallCanDto {
  @ApiProperty({ type: Boolean, description: 'Holds the confirm, is not read-only, and the event has ended.' }) confirm!: boolean;
}

export class RollCallDto {
  @ApiProperty({ type: String }) eventId!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ enum: EVENT_PHASES }) phase!: string;
  @ApiProperty({ type: Boolean }) ended!: boolean;
  @ApiProperty({ type: String }) startsOn!: string;
  @ApiProperty({ type: RollCallRowDto, isArray: true }) people!: RollCallRowDto[];
  @ApiProperty({ type: RollCallCountsDto }) counts!: RollCallCountsDto;
  @ApiProperty({
    type: Number, nullable: true,
    description: '`EVENT_ATTENDANCE_RATE` as a reader is shown it: a whole percent, rounded once from the counts (ADR-0174 §1) — '
      + 'never its tenth rounded again; null before the end or for nobody.',
  })
  attendanceRate!: number | null;
  @ApiProperty({ type: RollCallCanDto }) can!: RollCallCanDto;
}

export class FeedbackRowDto {
  @ApiProperty({ type: String }) membershipId!: string;
  @ApiProperty({ type: String, description: 'Shown to the Owner and the Admins (OD-151).' }) name!: string;
  @ApiProperty({ type: Number }) score!: number;
  @ApiProperty({ enum: ['promoter', 'passive', 'detractor'] }) bucket!: string;
  @ApiProperty({ type: String }) why!: string;
  @ApiProperty({ type: String }) improve!: string;
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ enum: ['confirmed', 'unconfirmed', 'absent'] }) attendance!: string;
  @ApiProperty({ type: Boolean, description: 'In the official NPS: the author was confirmed attended.' }) counted!: boolean;
}

export class FeedbackSummaryDto {
  @ApiProperty({ type: String }) eventId!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: Number, nullable: true, description: '`EVENT_NPS` over confirmed attendees; null with none (*—*).' })
  nps!: number | null;
  @ApiProperty({ type: Number, description: 'n, the NPS’s denominator.' }) counted!: number;
  @ApiProperty({ type: Number, description: 'Every answer from the audience.' }) responses!: number;
  @ApiProperty({ type: Number, description: 'k: answers whose author nobody has confirmed yet.' }) awaitingConfirmation!: number;
  @ApiProperty({ type: Number }) promoters!: number;
  @ApiProperty({ type: Number }) passives!: number;
  @ApiProperty({ type: Number }) detractors!: number;
  @ApiProperty({ type: FeedbackRowDto, isArray: true }) rows!: FeedbackRowDto[];
  @ApiProperty({ type: NpsConstantsDto }) constants!: NpsConstantsDto;
}
