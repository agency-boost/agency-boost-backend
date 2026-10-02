import { ApiProperty } from '@nestjs/swagger';
import {
  COACHING_SESSION_STATUSES, type CoachingSessionStatus, type SnapshotRatioRow, type SnapshotRatioSides,
} from './coaching-session.schema';
import type {
  ActionItemView, CoachingSessionView, EarlierVersionView, LastWeekItemView, LeadActionView, SessionDraftSaved,
  SessionHistoryRow, SessionHistoryView, SessionPerson, TipView,
} from './coaching-session.service';

/** Declared for OpenAPI. The wire shapes live on the service's view types. */

export class SessionPersonDto implements SessionPerson {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' })
  membershipId!: string;

  @ApiProperty({ example: 'Sari Puspita', description: 'Empty when the membership can no longer be named.' })
  name!: string;
}

export class SessionLeadTagDto {
  @ApiProperty() leadId!: string;

  @ApiProperty({ example: 'Pak Hendro Gunawan', description: 'The lead’s name as it read that day: *Leads · {name}*.' })
  name!: string;
}

export class LastWeekItemDto implements LastWeekItemView {
  @ApiProperty() itemId!: string;

  @ApiProperty({ example: 'Book three presentations' }) text!: string;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-28' }) dueDate!: string | null;

  @ApiProperty({ type: SessionLeadTagDto, nullable: true, description: 'The lead it came from; `null` for a typed item.' })
  lead!: { leadId: string; name: string } | null;

  @ApiProperty({ description: 'Ticked done by this session. The session it came from never changes.' })
  done!: boolean;
}

export class LeadActionDto implements LeadActionView {
  @ApiProperty() leadId!: string;

  @ApiProperty({ example: 'Pak Hendro Gunawan' }) leadName!: string;

  @ApiProperty({ example: '2026-10-03', description: 'The lead’s next action date.' }) dueDate!: string;

  @ApiProperty({ example: 'Collect the signed SPAJ.', description: 'The lead’s note, or *Follow up with {name}*.' })
  text!: string;
}

export class ActionItemDto implements ActionItemView {
  @ApiProperty() itemId!: string;

  @ApiProperty({ example: 'Shadow Sari on one presentation' }) text!: string;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-07', description: '`null` until a date is set.' })
  dueDate!: string | null;
}

export class TipDto implements TipView {
  @ApiProperty() tipId!: string;

  @ApiProperty({ example: 'Confirm the next meeting before you leave the current one.' }) text!: string;
}

export class LastWeekRefDto {
  @ApiProperty({ description: 'The finalized session these items were carried from.' }) sessionId!: string;

  @ApiProperty({ example: '2026-09-25', description: 'Its date: *From {date} session*.' }) date!: string;
}

export class EarlierVersionDto implements EarlierVersionView {
  @ApiProperty() finalizedAt!: string;

  @ApiProperty({ type: SessionPersonDto }) finalizedBy!: SessionPerson;

  @ApiProperty() reopenedAt!: string;

  @ApiProperty({ type: SessionPersonDto }) reopenedBy!: SessionPerson;

  @ApiProperty({ example: 'Two action items had the wrong dates.', description: 'Why it was reopened.' })
  reason!: string;

  @ApiProperty({ type: LastWeekItemDto, isArray: true }) lastWeekItems!: LastWeekItemView[];

  @ApiProperty({ type: LeadActionDto, isArray: true }) leadActions!: LeadActionView[];

  @ApiProperty({ type: ActionItemDto, isArray: true }) actionItems!: ActionItemView[];

  @ApiProperty({ type: TipDto, isArray: true }) tips!: TipView[];
}

// ------------------------------------------------------------------ the snapshot

export class SnapshotPeriodDto {
  @ApiProperty({ type: Number, nullable: true, description: 'IDR sen; `null` with no goal to measure against.' })
  targetMinor!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'IDR sen; `null` when nothing was held yet — never a 0 in its place.' })
  actualMinor!: number | null;

  @ApiProperty({ type: Number, nullable: true }) attainmentPct!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'IDR sen, never negative.' }) gapMinor!: number | null;

  @ApiProperty() targetMet!: boolean;
}

export class SnapshotSourceDto {
  @ApiProperty({ enum: ['imported', 'corrected', 'self_reported'], description: 'Whose APE figure it was.' })
  provenance!: 'imported' | 'corrected' | 'self_reported';

  @ApiProperty({ type: String, nullable: true, example: '2026-08', description: 'Whose year to date it was; `null` for the member’s own.' })
  month!: string | null;
}

export class SnapshotGoalDto {
  @ApiProperty({ example: '2026' }) period!: string;

  @ApiProperty({ example: '2026-09' }) month!: string;

  @ApiProperty({ example: 'IDR' }) currency!: string;

  @ApiProperty({ type: SnapshotPeriodDto, description: 'This month, as the Summary showed it that day.' })
  monthly!: SnapshotPeriodDto;

  @ApiProperty({ type: SnapshotPeriodDto, description: 'This year, as the Summary showed it that day.' })
  yearly!: SnapshotPeriodDto;

  @ApiProperty({ type: SnapshotSourceDto }) source!: SnapshotSourceDto;

  @ApiProperty({ type: Date, nullable: true, description: 'When the goal looked at was saved; `null` with no goal.' })
  savedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true }) savedByMembershipId!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Which version of the goal; `null` with no goal.' })
  goalVersion!: number | null;
}

export class SnapshotRatioSidesDto implements SnapshotRatioSides {
  @ApiProperty({ type: String, nullable: true, example: 'Selling', description: 'The section the numerator counts; `null` when its codes span sections.' })
  numerator!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Recruitment', description: 'The section the denominator counts; `null` when its codes span sections.' })
  denominator!: string | null;
}

export class SnapshotRatioRowDto implements SnapshotRatioRow {
  @ApiProperty() code!: string;

  @ApiProperty({ description: 'The label it read that day.' }) label!: string;

  @ApiProperty() comparison!: string;

  @ApiProperty() displayUnit!: string;

  @ApiProperty({ type: Number, nullable: true }) benchmark!: number | null;

  @ApiProperty({ type: Number, nullable: true }) value!: number | null;

  @ApiProperty({ type: Number, nullable: true }) share!: number | null;

  @ApiProperty() status!: string;

  @ApiProperty({
    type: SnapshotRatioSidesDto, nullable: true, required: false,
    description: 'The balance’s two ends as the Ratios card named them that day — `value` leans toward the '
      + 'numerator when positive. `null` for a rate. **Absent** from a snapshot taken before the field existed.',
  })
  sides?: SnapshotRatioSidesDto | null;
}

export class SnapshotRatiosDto {
  @ApiProperty() from!: string;

  @ApiProperty() to!: string;

  @ApiProperty({ example: 30 }) days!: number;

  @ApiProperty({ type: SnapshotRatioRowDto, isArray: true, description: 'The ratios on the coachee’s rung.' })
  rows!: SnapshotRatioRowDto[];
}

export class SnapshotTargetDto {
  @ApiProperty({ example: 'closings' }) key!: string;

  @ApiProperty({ example: 'SELL_SUBMISSION' }) code!: string;

  @ApiProperty() logged!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Pro-rated to the 7 days; `null` with no APE target.' })
  target!: number | null;
}

export class SnapshotSectionRowDto {
  @ApiProperty() code!: string;

  @ApiProperty() label!: string;

  @ApiProperty() count!: number;
}

export class SnapshotSectionDto {
  @ApiProperty() code!: string;

  @ApiProperty() label!: string;

  @ApiProperty() total!: number;

  @ApiProperty({ type: SnapshotSectionRowDto, isArray: true }) rows!: SnapshotSectionRowDto[];
}

export class SnapshotActivityDto {
  @ApiProperty() from!: string;

  @ApiProperty() to!: string;

  @ApiProperty({ type: SnapshotTargetDto, isArray: true }) targets!: SnapshotTargetDto[];

  @ApiProperty({ type: SnapshotSectionDto, isArray: true }) sections!: SnapshotSectionDto[];
}

export class SessionSnapshotDto {
  @ApiProperty({ description: 'When it was taken: the session’s first finalize.' }) takenAt!: string;

  @ApiProperty({ type: SnapshotGoalDto, nullable: true }) goal!: SnapshotGoalDto | null;

  @ApiProperty({ type: SnapshotRatiosDto, nullable: true, description: 'The last 30 days.' }) ratios!: SnapshotRatiosDto | null;

  @ApiProperty({ type: SnapshotActivityDto, nullable: true, description: 'The last 7 days.' })
  activity!: SnapshotActivityDto | null;
}

// ------------------------------------------------------------------ the session

export class CoachingSessionDto implements CoachingSessionView {
  @ApiProperty() sessionId!: string;

  @ApiProperty({ type: SessionPersonDto }) coachee!: SessionPerson;

  @ApiProperty({ type: SessionPersonDto, description: 'Who leads it, and the only member who edits or finalizes it.' })
  coach!: SessionPerson;

  @ApiProperty({
    enum: COACHING_SESSION_STATUSES,
    description:
      'As you may see it: a session under correction reads `finalized`, as its latest finalized version, to '
      + 'everybody but its coach while they coach the person.',
  })
  status!: CoachingSessionStatus;

  @ApiProperty({ example: 3, description: 'What a save, a finalize or a reopen pins.' }) version!: number;

  @ApiProperty({
    type: String, nullable: true, example: '2026-09-28',
    description: 'The day it was first finalized, in your agency’s calendar; `null` until then. A correction never moves it.',
  })
  date!: string | null;

  @ApiProperty() startedAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The latest finalize.' }) finalizedAt!: string | null;

  @ApiProperty({ type: SessionPersonDto, nullable: true }) finalizedBy!: SessionPerson | null;

  @ApiProperty({
    type: String, nullable: true, example: '2026-10-05',
    description:
      'The last day it may be reopened, for a reader who may reopen it — given after that day too, so the '
      + 'screen can say until when — else `null`.',
  })
  reopenableUntil!: string | null;

  @ApiProperty({ type: LastWeekRefDto, nullable: true, description: 'The finalized session *last week* is; `null` for a first session.' })
  lastWeek!: { sessionId: string; date: string } | null;

  @ApiProperty({ type: LastWeekItemDto, isArray: true }) lastWeekItems!: LastWeekItemView[];

  @ApiProperty({
    type: LeadActionDto, isArray: true,
    description:
      '*From leads (automatic)*: read from the person’s leads now while the session is open and you coach '
      + 'them; otherwise the list its last finalize took.',
  })
  leadActions!: LeadActionView[];

  @ApiProperty({ type: ActionItemDto, isArray: true, description: '*Other action items*.' }) actionItems!: ActionItemView[];

  @ApiProperty({ type: TipDto, isArray: true }) tips!: TipView[];

  @ApiProperty({
    type: SessionSnapshotDto, nullable: true,
    description: 'What the 1:1 looked at, taken once at the first finalize. `null` until then. Never a live figure.',
  })
  snapshot!: CoachingSessionView['snapshot'];

  @ApiProperty({ type: EarlierVersionDto, isArray: true, description: 'Every finalized version a reopen replaced, oldest first.' })
  earlier!: EarlierVersionView[];
}

export class SessionHistoryRowDto implements SessionHistoryRow {
  @ApiProperty() sessionId!: string;

  @ApiProperty({ example: '2026-09-28' }) date!: string;

  @ApiProperty({ type: SessionPersonDto }) coach!: SessionPerson;

  @ApiProperty({ example: 3, description: 'Its action items, from leads and typed: *{N} action items*.' })
  actionItemCount!: number;

  @ApiProperty({
    example: 1,
    description: 'How many of them the next session ticked done: *{M} completed*. 0 until one reviews them.',
  })
  completedCount!: number;
}

export class SessionCurrentDto {
  @ApiProperty() sessionId!: string;

  @ApiProperty({ enum: COACHING_SESSION_STATUSES }) status!: CoachingSessionStatus;
}

export class SessionHistoryDto implements SessionHistoryView {
  @ApiProperty({ example: '2026-10-02', description: 'Today where you work.' }) today!: string;

  @ApiProperty({
    type: SessionCurrentDto, nullable: true,
    description:
      'What the workspace opens on: your open draft with this person; else the session you are correcting; '
      + 'else the one you finalized today; else `null`, and the workspace opens before *Start*.',
  })
  current!: SessionHistoryView['current'];

  @ApiProperty({ type: SessionHistoryRowDto, isArray: true, description: 'Finalized sessions, newest first. Not paginated.' })
  sessions!: SessionHistoryRow[];
}

export class SessionDraftSavedDto implements SessionDraftSaved {
  @ApiProperty() sessionId!: string;

  @ApiProperty({ example: 4, description: 'The version the next write pins.' }) version!: number;

  @ApiProperty({ type: ActionItemDto, isArray: true, description: 'With the ids new rows were given.' })
  actionItems!: ActionItemView[];

  @ApiProperty({ type: TipDto, isArray: true }) tips!: TipView[];
}
