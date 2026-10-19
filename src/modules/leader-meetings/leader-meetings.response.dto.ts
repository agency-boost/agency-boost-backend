import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import { ACTION_STATUSES, type ActionStatus, type MonthlyTargetCell } from './leader-meeting.schema';
import type {
  ActionItem, AgendaItem, ForumLimits, ForumPerson, MeetingCan, MeetingCard, MeetingEditors, MeetingListView,
  MeetingState, MeetingView, Scorecard, ScorecardRow, ShareLink,
} from './leader-meeting.view';
import {
  COLUMN_KEYS, ROW_KEYS, type ColumnKey, type RowKey, type ScorecardCell, type ScorecardUnit,
} from './scorecard/scorecard.types';

/** Declared for OpenAPI. The wire shapes live on `leader-meeting.view.ts`, as `frontend/src/lib/leader-meetings.ts` reads them. */

// ------------------------------------------------------------------ people and bounds

class ForumRungDto {
  @ApiProperty({ example: 'AB', description: 'The rung’s stable code on the company’s ladder.' }) code!: string;
  @ApiProperty({ example: 'AB', description: 'The ladder’s own label for it.' }) label!: string;
}

export class ForumPersonDto implements ForumPerson {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' }) membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ type: ForumRungDto }) rung!: { code: string; label: string };
  @ApiProperty({ description: 'The reader themselves: *"(You)"* after the name.' }) isReader!: boolean;
  @ApiProperty({
    description: 'Tagged *Core Leader* — now, or when a frozen list was written. *"{n} core leaders tagged"* counts every '
      + 'editor tagged but the Owner, an Admin who is tagged included.',
  })
  tagged!: boolean;
}

export class MeetingEditorsDto implements MeetingEditors {
  @ApiProperty({ type: ForumPersonDto, nullable: true, description: 'The Owner, first. `null` for an agency with none.' })
  owner!: ForumPerson | null;

  @ApiProperty({ type: [ForumPersonDto], description: 'The Admins, by name.' }) admins!: ForumPerson[];
  @ApiProperty({ type: [ForumPersonDto], description: 'Every other member tagged *Core Leader*, by name.' }) coreLeaders!: ForumPerson[];
  @ApiProperty({ example: 3, description: '*"{n} core leaders tagged"*: every editor tagged *Core Leader* but the Owner.' })
  coreLeaderCount!: number;

  @ApiProperty({
    description: 'True once the meeting is *Completed* and these are the editors written onto it the first time it was '
      + 'read after its date: its record of who could edit it then, which grants nothing. False: the tag, now.',
  })
  frozen!: boolean;
}

export class ForumLimitsDto implements ForumLimits {
  @ApiProperty({ example: LEADER_MEETING_LIMITS.titleMax, description: 'A title, after trimming.' }) titleMax!: number;
  @ApiProperty({ example: LEADER_MEETING_LIMITS.textMax, description: 'An agenda item, and each cell of the tracker but its PIC.' })
  textMax!: number;

  @ApiProperty({ example: LEADER_MEETING_LIMITS.picMax, description: 'A PIC.' }) picMax!: number;
  @ApiProperty({ example: LEADER_MEETING_LIMITS.targetMax, description: 'A *Monthly Target* cell.' }) targetMax!: number;
}

// ------------------------------------------------------------------ the list

export class MeetingCardDto implements MeetingCard {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 14, description: 'One past the agency’s highest when it was made; never changed.' }) number!: number;
  @ApiProperty({ example: 'Strategic Check-in — #14', description: 'Plain text: render it as text, never as markup.' }) title!: string;
  @ApiProperty({ example: '2026-10-13', description: 'An office date, `YYYY-MM-DD`.' }) date!: string;
  @ApiProperty({
    enum: ['upcoming', 'completed'],
    description: '*Upcoming* through the end of its date in the agency’s calendar, *Completed* from 00:00 after. Never stored.',
  })
  state!: MeetingState;

  @ApiProperty({ type: MeetingEditorsDto }) editors!: MeetingEditors;
  @ApiProperty({ example: 4, description: 'The tracker’s rows not *Implemented*; 0 reads *All clear*.' }) openItems!: number;
}

class ListCanDto {
  @ApiProperty({ description: '*+ New meeting*: the Owner’s and the Admins’ alone.' }) create!: boolean;
}

export class MeetingListViewDto implements MeetingListView {
  @ApiProperty({ type: [MeetingCardDto], description: 'Every meeting of the agency, newest first by date. Not paginated.' })
  meetings!: MeetingCard[];

  @ApiProperty({ type: ListCanDto }) can!: { create: boolean };
  @ApiProperty({ type: ForumLimitsDto }) limits!: ForumLimits;
}

// ------------------------------------------------------------------ the scorecard

class ScorecardCellDto {
  @ApiProperty({
    enum: ['figure', 'pending', 'none', 'blocked'],
    description: '`figure` a value; `pending` *pending data* — no source holds it for its period, never 0; `none` *—*, a '
      + 'ratio over nothing; `blocked`, as the prototype draws it.',
  })
  kind!: ScorecardCell['kind'];

  @ApiPropertyOptional({ description: 'On a `figure`: exact — IDR minor units, a count, or a whole percentage.' }) value?: number;
  @ApiPropertyOptional({ type: [String], description: 'On a `figure`: the months of its period, `YYYY-MM`, not uploaded yet.' })
  leavesOut?: string[];
}

class MonthlyTargetDto implements MonthlyTargetCell {
  @ApiProperty({ example: '8 (1 @ unit)', description: 'Typed by an editor; *TBD* is a value. Plain text.' }) value!: string;
  @ApiProperty({ example: 1, description: '0 for a cell never typed.' }) version!: number;
}

class ScorecardRowDto implements ScorecardRow {
  @ApiProperty({ enum: ROW_KEYS }) key!: RowKey;
  @ApiProperty({ enum: ['idr_minor', 'count', 'percentage'] }) unit!: ScorecardUnit;
  @ApiProperty({
    type: 'object', additionalProperties: { $ref: '#/components/schemas/ScorecardCellDto' },
    description: `One cell per column: ${COLUMN_KEYS.join(', ')}.`,
  })
  cells!: Record<ColumnKey, ScorecardCell>;

  @ApiProperty({ type: MonthlyTargetDto, nullable: true, description: '`null` where the prototype blocks the cell.' })
  monthlyTarget!: MonthlyTargetCell | null;
}

class ScorecardPeriodsDto {
  @ApiProperty({ example: '2025', description: '*FY {year}*: the year before the meeting’s.' }) fy!: string;
  @ApiProperty({ example: '2026', description: '*YTD {year}*: the meeting’s year, January to its month.' }) ytd!: string;
  @ApiProperty({ example: '2025-10' }) thisMonthLastYear!: string;
  @ApiProperty({ example: '2026-09' }) lastMonth!: string;
  @ApiProperty({ example: '2026-10' }) thisMonth!: string;
}

class ScorecardChipsDto {
  @ApiProperty() manpower!: number;
  @ApiProperty() agents!: number;
  @ApiProperty() units!: number;
  @ApiProperty() ab!: number;
  @ApiProperty() aab!: number;
}

class ScorecardDto implements Scorecard {
  @ApiProperty({ type: ScorecardPeriodsDto }) periods!: Record<ColumnKey, string>;
  @ApiProperty({ type: ScorecardChipsDto }) chips!: Scorecard['chips'];
  @ApiProperty({ type: [ScorecardRowDto], description: 'Nine, in the prototype’s order.' }) rows!: ScorecardRow[];
  @ApiProperty({
    type: String, nullable: true,
    description: '`null` while the scorecard is computed on every read; the instant it was written onto the meeting otherwise.',
  })
  frozenAt!: string | null;
}

// ------------------------------------------------------------------ the minutes

export class AgendaItemDto implements AgendaItem {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Plain text.' }) text!: string;
  @ApiProperty({ description: 'A name typed by hand; empty for none.' }) pic!: string;
  @ApiProperty({ description: 'Meaningful on *During* only.' }) done!: boolean;
  @ApiProperty({ example: 1 }) version!: number;
}

class AgendaDto {
  @ApiProperty({ type: [AgendaItemDto] }) preparation!: AgendaItem[];
  @ApiProperty({ type: [AgendaItemDto] }) during!: AgendaItem[];
  @ApiProperty({ type: [AgendaItemDto] }) post!: AgendaItem[];
}

/** An agenda item saved — or `{ removed: true }`, when its text was emptied and the item removed. */
export class AgendaItemSavedDto {
  @ApiPropertyOptional() id?: string;
  @ApiPropertyOptional() text?: string;
  @ApiPropertyOptional() pic?: string;
  @ApiPropertyOptional() done?: boolean;
  @ApiPropertyOptional() version?: number;
  @ApiPropertyOptional({ enum: [true], description: 'Present, and true, when the item was removed: nothing else is.' })
  removed?: true;
}

export class LeaderActionItemDto implements ActionItem {
  @ApiProperty() id!: string;
  @ApiProperty({ description: '*Key initiative*.' }) initiative!: string;
  @ApiProperty({ description: '*Success metric*.' }) metric!: string;
  @ApiProperty({ description: '*Action item*.' }) action!: string;
  @ApiProperty({ description: '*PIC*.' }) pic!: string;
  @ApiProperty({ enum: ACTION_STATUSES }) status!: ActionStatus;
  @ApiProperty({ description: '*Remarks / Target*.' }) remarks!: string;
  @ApiProperty({ example: 1 }) version!: number;
}

export class MonthlyTargetSavedDto extends MonthlyTargetDto {}

// ------------------------------------------------------------------ a meeting

class AccessNoteDto {
  @ApiProperty({ type: String, nullable: true, description: 'The Owner’s name, now.' }) ownerName!: string | null;
  @ApiProperty({ type: [String], description: 'Each Admin’s name, now.' }) adminNames!: string[];
}

class MeetingCanDto implements MeetingCan {
  @ApiProperty() edit!: boolean;
  @ApiProperty() share!: boolean;
  @ApiProperty({ description: 'The dialog’s title and date: an upcoming meeting only.' }) reschedule!: boolean;
  @ApiProperty({ description: '*Delete meeting*: one nobody has written in.' }) delete!: boolean;
  @ApiProperty({ description: '*Manage tags →*.' }) manageTags!: boolean;
  @ApiProperty({ description: '*Save as PDF*: whoever reads the meeting.' }) print!: boolean;
}

export class MeetingViewDto extends MeetingCardDto implements MeetingView {
  @ApiProperty({ example: 1, description: 'The head’s version: the title and the date.' }) version!: number;
  @ApiProperty({ example: 'BSD City Branch', description: 'The agency’s branch: the share dialog’s hint names it.' }) branch!: string;
  @ApiProperty({ type: ScorecardDto }) scorecard!: Scorecard;
  @ApiProperty({ type: AgendaDto }) agenda!: MeetingView['agenda'];
  @ApiProperty({ type: [LeaderActionItemDto], description: 'In their order.' }) actionItems!: ActionItem[];
  @ApiProperty({ description: 'False: nobody has written in it, so *Delete meeting* is offered.' }) writtenIn!: boolean;
  @ApiProperty({ enum: ['address', 'link'], description: '`link`: opened by a shared link, read-only.' }) via!: 'address' | 'link';
  @ApiProperty({ type: AccessNoteDto, description: 'Who may edit **now**, on every meeting, past ones included.' })
  accessNote!: { ownerName: string | null; adminNames: string[] };

  @ApiProperty({ type: MeetingCanDto }) can!: MeetingCan;
  @ApiProperty({ type: ForumLimitsDto }) limits!: ForumLimits;
}

// ------------------------------------------------------------------ sharing

export class ShareLinkDto implements ShareLink {
  @ApiProperty({ description: 'The raw token, in this answer and nowhere else: only its hash is kept.' }) token!: string;
  @ApiProperty({ description: 'The instant the link stops opening.' }) expiresAt!: string;
}

export class ShareLinksRevokedDto {
  @ApiProperty({ example: 2, description: 'The live links to the meeting revoked by this request.' }) revoked!: number;
}

/** The scorecard's cell is referenced by name from a row's `cells`, so it is registered as a model of its own. */
export const LEADER_FORUM_SHARED_SHAPES = [ScorecardCellDto];
