import { ApiProperty } from '@nestjs/swagger';
import { GOAL_PACE_STATUSES, type GoalPaceStatus } from '@/domain/metrics/goal-pace-status';
import type {
  CoachingRosterView, RosterLastOneOnOne, RosterPerson, RosterRow, RosterUnit,
} from './coaching-roster.service';
import type { CoacheeDownline, CoacheeView } from './coachee.service';

/** Declared for OpenAPI. The wire shapes live on the services' view types. */

export class RosterPersonDto implements RosterPerson {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' })
  membershipId!: string;

  @ApiProperty({ example: 'Rina Wijaya' })
  name!: string;
}

export class RosterRungDto {
  @ApiProperty({ example: 'AGENT', description: 'The rung’s stable code on the company’s ladder.' })
  code!: string;

  @ApiProperty({ example: 'Agent', description: 'The ladder’s own label for it.' })
  label!: string;
}

export class RosterLastOneOnOneDto implements RosterLastOneOnOne {
  @ApiProperty({
    example: 4,
    description: '`DAYS_SINCE_LAST_COACHING`: whole calendar days since the latest finalized session, 0 being today.',
  })
  days!: number;

  @ApiProperty({
    example: '2026-09-28',
    description: 'That session’s day: the day it was first finalized. A correction never moves it.',
  })
  date!: string;

  @ApiProperty({ description: '`days` is above `overdueAfterDays`. Decided here, never in the browser.' })
  overdue!: boolean;

  @ApiProperty({
    type: RosterPersonDto, nullable: true,
    description: 'Who led that session, whoever it was; `null` when their membership can no longer be named.',
  })
  coach!: RosterPerson | null;
}

export class RosterRowDto implements RosterRow {
  @ApiProperty() membershipId!: string;

  @ApiProperty({ example: 'Rina Wijaya' }) name!: string;

  @ApiProperty({
    type: String, nullable: true,
    description: 'UI V1 (UI-111): their profile photo, when they have one, as a signed link (`users.avatarUrl`); the row draws initials otherwise.',
  })
  photoUrl!: string | null;

  @ApiProperty({ type: RosterRungDto }) rung!: { code: string; label: string };

  @ApiProperty({ example: 1, description: 'Levels below the reader: 1 is somebody who answers to the reader directly.' })
  depth!: number;

  @ApiProperty({
    type: RosterLastOneOnOneDto, nullable: true,
    description: 'The latest finalized session about them; `null` until there is one (*No 1:1 yet*). A draft never counts.',
  })
  lastOneOnOne!: RosterLastOneOnOne | null;

  @ApiProperty({
    enum: GOAL_PACE_STATUSES,
    description:
      '`GOAL_PACE_STATUS` for the calendar month: `no_goal_set` with no goal for the year; else '
      + '`needs_attention` when not pacing to at least one policy submission this month; else '
      + '`on_track` at or above the on-track share of this month’s APE target, and `watch_closely` below it. '
      + 'A year already met needs nothing more this month and reads `on_track` once the policy gate '
      + 'passes. Until this month’s production file is uploaded, the share is `CLOSINGS_LAST_30_DAYS`, the '
      + 'policy submissions logged over the last 30 days, over this month’s closing target '
      + '(`POLICY_COUNT_TARGET`) — the Summary’s pace sentence, answered from the 1st (ADR-0109).',
  })
  status!: GoalPaceStatus;
}

export class RosterUnitDto implements RosterUnit {
  @ApiProperty({ type: RosterRowDto, description: 'Somebody who answers to the reader directly and leads others.' })
  head!: RosterRow;

  @ApiProperty({
    type: RosterRowDto, isArray: true,
    description: 'Their whole subtree in tree order: a nested head is followed by their own members. A to Z within a level.',
  })
  members!: RosterRow[];
}

export class CoachingRosterDto implements CoachingRosterView {
  @ApiProperty({ example: '2026-10-02', description: 'Today where you work: the day every figure here is as of.' })
  today!: string;

  @ApiProperty({ example: 7, description: 'How many days a last 1:1 may be before it reads overdue, as set for your agency.' })
  overdueAfterDays!: number;

  @ApiProperty({
    type: RosterRowDto, isArray: true,
    description: 'The agents who answer to you directly, A to Z.',
  })
  directAgents!: RosterRow[];

  @ApiProperty({
    type: RosterUnitDto, isArray: true,
    description: 'Each leader who answers to you directly, A to Z, with everybody below them.',
  })
  units!: RosterUnit[];
}

export class CoacheeDownlineDto implements CoacheeDownline {
  @ApiProperty({
    example: 2,
    description: 'Everybody below them on the current leader edges, at any depth. 0 when nobody is.',
  })
  members!: number;

  @ApiProperty({
    example: 0,
    description: 'Those of them who lead somebody themselves. 0 when nobody below them leads anybody.',
  })
  leaders!: number;
}

export class CoacheeDto implements CoacheeView {
  @ApiProperty({
    example: '2026-10-02',
    description: 'Today where you work (`YYYY-MM-DD`), in the office’s own time zone: the day the page dates from, never the browser’s.',
  })
  today!: string;

  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' })
  membershipId!: string;

  @ApiProperty({ example: 'Rina Wijaya' })
  name!: string;

  @ApiProperty({
    type: String, nullable: true,
    description: 'UI V1 (UI-111): their profile photo, when they have one, as a signed link (`users.avatarUrl`); the header draws initials otherwise.',
  })
  photoUrl!: string | null;

  @ApiProperty({
    enum: ['she', 'he', 'they'],
    example: 'she',
    description: 'Their own pronoun, which every sentence about them is written in. `they` unless they chose one.',
  })
  pronoun!: CoacheeView['pronoun'];

  @ApiProperty({ type: RosterRungDto })
  rung!: { code: string; label: string };

  @ApiProperty({
    type: RosterPersonDto, nullable: true,
    description: 'The leader they answer to directly; `null` only when that membership can no longer be named.',
  })
  leader!: RosterPerson | null;

  @ApiProperty({ example: true, description: 'You are that leader: they are in your own unit.' })
  direct!: boolean;

  @ApiProperty({ type: CoacheeDownlineDto })
  downline!: CoacheeDownline;
}
