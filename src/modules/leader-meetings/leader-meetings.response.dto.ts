import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import { ACTION_STATUSES, type ActionStatus } from './leader-meeting.schema';
import type {
  ActionItem, AgendaItem, ForumLimits, ForumPerson, MeetingCan, MeetingCard, MeetingEditors, MeetingListView,
  MeetingState, MeetingView, MonthlyTarget, PartialPeriod, Scorecard, ScorecardRow, ShareLink, YtdChange, YtdChangeUnit,
} from './leader-meeting.view';
import type { ScorecardAsOf } from './scorecard/scorecard-record';
import {
  COLUMN_KEYS, ROW_KEYS, type ColumnKey, type ColumnPeriod, type RowKey, type ScorecardCell, type ScorecardUnit,
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
  @ApiProperty({
    type: String, nullable: true,
    description: 'UI V1 (UI-111): their profile photo, when they have one, as a signed link (`users.avatarUrl`); the avatar draws initials otherwise.',
  })
  photoUrl!: string | null;
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
    enum: ['figure', 'pending', 'none', 'blocked', 'unrecorded'],
    description: '`figure` a value; `pending` *pending data* — no source holds it for its period, never 0; `none` *—*, a '
      + 'ratio over nothing; `blocked` *Not tracked*, a row the table leaves empty in this column; `unrecorded` *—*, a '
      + 'column or a row a scorecard kept before it existed does not hold — never computed for it.',
  })
  kind!: ScorecardCell['kind'];

  @ApiPropertyOptional({ description: 'On a `figure`: exact — IDR minor units, a count, a ratio or a whole percentage.' }) value?: number;
  @ApiPropertyOptional({ type: [String], description: 'On a `figure`: the months of its period, `YYYY-MM`, not uploaded yet.' })
  leavesOut?: string[];
}

class MonthlyTargetDto implements MonthlyTarget {
  @ApiProperty({
    type: Number, nullable: true, example: 1,
    description: 'The rate per unit an editor typed, in the row’s unit — IDR minor units for `ape`, a count for the others; '
      + '`null` for none (`ape` then reads *TBD*, every other row blank).',
  })
  rate!: number | null;

  @ApiProperty({
    type: Number, nullable: true, example: 9,
    description: '`rate × # of units`, the meeting’s own units — the ones it was kept with, once it is over. `null` with no rate.',
  })
  value!: number | null;

  @ApiProperty({
    type: String, nullable: true,
    description: 'A target typed as text before rates that could not be read as one: shown as typed, as plain text, until '
      + 'an editor enters a rate. `null` otherwise.',
  })
  typed!: string | null;

  @ApiProperty({ example: 1, description: '0 for a cell never typed.' }) version!: number;
}

class YtdChangeDto {
  @ApiProperty({
    enum: ['figure', 'none'],
    description: '`none` *—*: either year is no figure, or — a change in `percent` — last year’s is 0.',
  })
  kind!: YtdChange['kind'];

  @ApiPropertyOptional({
    example: 18,
    description: 'On a `figure`: this year’s to date against last year’s, whole and signed, in `unit`. Rounded half up.',
  })
  value?: number;

  @ApiPropertyOptional({
    enum: ['percent', 'points'],
    description: 'On a `figure`: `percent`, a percentage of last year’s figure (*+18%*); `points`, on a row whose own '
      + 'figure is a percentage (`unit: percentage`), the difference in percentage points (*-40 points* for 60% against '
      + '100%), since a percentage of a percentage would read as either.',
  })
  unit?: YtdChangeUnit;
}

class ScorecardRowDto implements ScorecardRow {
  @ApiProperty({ enum: ROW_KEYS }) key!: RowKey;
  @ApiProperty({ enum: ['idr_minor', 'count', 'percentage', 'ratio'] }) unit!: ScorecardUnit;
  @ApiProperty({
    type: 'object', additionalProperties: { $ref: '#/components/schemas/ScorecardCellDto' },
    description: `One cell per column: ${COLUMN_KEYS.join(', ')}.`,
  })
  cells!: Record<ColumnKey, ScorecardCell>;

  @ApiProperty({ type: YtdChangeDto, description: 'What a phone’s card for the row reads: this year to date against last year’s.' })
  ytdChange!: YtdChange;

  @ApiProperty({
    type: MonthlyTargetDto, nullable: true,
    description: '`null` on a row the table does not track month by month, which takes no target.',
  })
  monthlyTarget!: MonthlyTarget | null;
}

class ColumnPeriodDto implements ColumnPeriod {
  @ApiProperty({ example: '2026-01', description: 'The column’s first month, `YYYY-MM`.' }) from!: string;
  @ApiProperty({ example: '2026-10', description: 'Its last, `YYYY-MM`: the same for a single month.' }) to!: string;
}

class ScorecardPeriodsDto {
  @ApiProperty({ type: ColumnPeriodDto, description: '*Full Year*: January to December of the year before the meeting’s.' })
  fy!: ColumnPeriod;

  @ApiProperty({ type: ColumnPeriodDto, description: '*YTD* of the year before: January to the meeting’s month, a year earlier.' })
  ytdLastYear!: ColumnPeriod;

  @ApiProperty({ type: ColumnPeriodDto, description: '*YTD*: the meeting’s year, January to its month.' }) ytd!: ColumnPeriod;
  @ApiProperty({ type: ColumnPeriodDto }) thisMonthLastYear!: ColumnPeriod;
  @ApiProperty({ type: ColumnPeriodDto }) lastMonth!: ColumnPeriod;
  @ApiProperty({ type: ColumnPeriodDto }) thisMonth!: ColumnPeriod;
}

class ScorecardChipsDto {
  @ApiProperty() manpower!: number;
  @ApiProperty() agents!: number;
  @ApiProperty({ description: '*# of units*: *# of AB* + *# of AAB* — or, on a scorecard kept before that, the number it was kept with.' })
  units!: number;

  @ApiProperty() ab!: number;
  @ApiProperty() aab!: number;
}

class ScorecardAsOfDto {
  @ApiProperty({
    enum: ['date', 'none', 'unrecorded'],
    description: '`date` the agency’s day its latest production file was uploaded; `none` no file yet — nothing is drawn; '
      + '`unrecorded` *—*, a scorecard kept before the date was recorded.',
  })
  kind!: ScorecardAsOf['kind'];

  @ApiPropertyOptional({ example: '2026-10-26', description: 'On a `date`: `YYYY-MM-DD`, the agency’s calendar.' }) date?: string;
}

class PartialPeriodDto implements PartialPeriod {
  @ApiProperty({ enum: COLUMN_KEYS }) column!: ColumnKey;
  @ApiProperty({ type: [String], description: 'Every month, `YYYY-MM`, one of the column’s figures leaves out: its *(*)* note.' })
  leavesOut!: string[];
}

class ScorecardDto implements Scorecard {
  @ApiProperty({ type: ScorecardPeriodsDto, description: 'Each column’s months, from the meeting’s month.' })
  periods!: Record<ColumnKey, ColumnPeriod>;

  @ApiProperty({ type: ScorecardChipsDto }) chips!: Scorecard['chips'];
  @ApiProperty({ type: [ScorecardRowDto], description: 'Nine, in the reference slide’s order.' }) rows!: ScorecardRow[];
  @ApiProperty({ type: ScorecardAsOfDto, description: '*AS OF*, beside the title.' }) asOf!: ScorecardAsOf;
  @ApiProperty({ type: [PartialPeriodDto], description: 'The periods a figure of which leaves months out, in column order.' })
  partialPeriods!: PartialPeriod[];

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
  @ApiProperty({ description: 'Ticked or not, in any section (UI V1, UI-110).' }) done!: boolean;
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
