import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { CALENDAR_ENTRY_TYPES, type CalendarEntryType } from '@/domain/constants';
import { CALENDAR_ANSWERS, type CalendarAnswer } from './calendar-event.schema';
import type { CalendarDeleted, CalendarSettings } from './calendar.service';
import {
  PEOPLE_GROUPS, type CalendarDownline, type CalendarDownlineRow, type CalendarPeoplePage, type CalendarPersonRow,
  type PeopleGroup,
} from './calendar-people.service';
import type {
  CalendarBusyView, CalendarEntryView, CalendarInviteeView, CalendarPeriodView, CalendarPersonView, ReaderIs,
} from './calendar-view';

/** Declared for OpenAPI. The wire shapes live on the services' view types, which these implement. */

export class CalendarPersonDto implements CalendarPersonView {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' })
  membershipId!: string;

  @ApiProperty({ example: 'Sari Puspita', description: 'Their full name. A member who has left keeps theirs.' })
  name!: string;
}

export class CalendarRungDto {
  @ApiProperty({ example: 'AAB', description: 'The rung’s stable code on the company’s ladder.' })
  code!: string;

  @ApiProperty({ example: 'AAB', description: 'The ladder’s own label for it.' })
  label!: string;
}

export class CalendarInviteeDto extends CalendarPersonDto implements CalendarInviteeView {
  @ApiProperty({ description: 'The member a block was placed on: on it with no answer to give.' })
  placed!: boolean;

  @ApiPropertyOptional({
    enum: CALENDAR_ANSWERS,
    description: 'Their answer — **to the organiser alone**, and never on a placed member. Absent for anybody else.',
  })
  answer?: CalendarAnswer;

  @ApiProperty({
    description: 'A *1:1 coaching* entry, and you coach this person now: their chip opens their coaching session. `false` everywhere else.',
  })
  readerCoaches!: boolean;
}

/** The office's dates and wall clock an entry or a busy block is answered in. */
class CalendarTimingDto {
  @ApiProperty({ description: 'Travel: two dates and no times.' })
  allDay!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-28', description: 'A timed entry’s office date; `null` on Travel.' })
  date!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '09:00', description: 'A timed entry’s start, `HH:mm`; `null` on Travel.' })
  start!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '09:30',
    description: 'A timed entry’s end, `HH:mm`, `00:00` being midnight at the end of its date; `null` on Travel.',
  })
  end!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Travel’s departure date; `null` otherwise.' })
  startsOn!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Travel’s return date, inclusive; `null` otherwise.' })
  endsOn!: string | null;

  @ApiProperty({ example: '2026-09-28T02:00:00.000Z', description: 'The start, a UTC instant.' })
  startsAt!: string;

  @ApiProperty({ example: '2026-09-28T02:30:00.000Z', description: 'The end, a UTC instant, exclusive.' })
  endsAt!: string;
}

export class CalendarEntryDto extends CalendarTimingDto implements CalendarEntryView {
  @ApiProperty()
  entryId!: string;

  @ApiProperty({ example: 1, description: 'What an edit or a delete sends back. An answer does not move it.' })
  version!: number;

  @ApiProperty({ enum: CALENDAR_ENTRY_TYPES })
  type!: CalendarEntryType;

  @ApiProperty({ example: 'Weekly unit standup', description: '`\'\'` when none: drawn *(untitled event)*.' })
  title!: string;

  @ApiProperty({ example: 'Zoom — zoom.us/j/91827364', description: '*Notes / location*; `\'\'` when none.' })
  notes!: string;

  @ApiProperty({ type: CalendarPersonDto, description: 'Whose entry it is, and the only member who edits or deletes it.' })
  organiser!: CalendarPersonView;

  @ApiProperty({ type: CalendarInviteeDto, isArray: true, description: 'Everybody else on it, the placed member included.' })
  invitees!: CalendarInviteeView[];

  @ApiProperty({
    enum: ['organiser', 'invitee', 'placed', 'ancestor'],
    description:
      'How you stand to it: its `organiser` (*Delete* and *Edit*); an `invitee` (*Decline* and *Accept*); the '
      + 'member a block was `placed` on, or an `ancestor` reading a compared calendar (*Close* alone).',
  })
  readerIs!: ReaderIs;

  @ApiProperty({ enum: CALENDAR_ANSWERS, nullable: true, description: 'Your own answer as an invitee; `null` otherwise.' })
  myAnswer!: CalendarAnswer | null;
}

export class CalendarBusyBlockDto extends CalendarTimingDto implements CalendarBusyView {
  @ApiProperty({
    type: Boolean, example: true,
    description:
      'Always `true`. An entry a compared member attends that you could not read in your own right, by its '
      + 'time and nothing else: no id, no type, no title, no notes, no people.',
  })
  busy!: true;
}

export class CalendarDayDto {
  @ApiProperty({ example: '2026-09-28' })
  date!: string;

  @ApiProperty({ description: 'The period’s own day; `false` for a month’s padding days before the 1st and after its last.' })
  inPeriod!: boolean;
}

export class CalendarNowDto {
  @ApiProperty({ example: '2026-09-28T02:45:00.000Z', description: 'Now, a UTC instant.' })
  at!: string;

  @ApiProperty({ example: 585, description: 'Now as the office’s minute of the day, 0 to 1439: where the now-line is drawn.' })
  minute!: number;
}

export class CalendarSubjectDto extends CalendarPersonDto {
  @ApiProperty({ type: CalendarRungDto })
  rung!: { code: string; label: string };
}

export class CalendarPeriodDto implements CalendarPeriodView {
  @ApiProperty({ enum: ['week', 'month'] })
  view!: 'week' | 'month';

  @ApiProperty({ example: '2026-09-28', description: 'The first office date drawn: a week’s Monday, or a month’s first padded Monday.' })
  from!: string;

  @ApiProperty({ example: '2026-10-04', description: 'The last office date drawn, inclusive: a Sunday.' })
  to!: string;

  @ApiProperty({ type: String, nullable: true, example: null, description: '`YYYY-MM` in Month; `null` in Week.' })
  month!: string | null;

  @ApiProperty({ type: CalendarDayDto, isArray: true, description: 'Every day from `from` to `to`, Monday first.' })
  days!: { date: string; inPeriod: boolean }[];

  @ApiProperty({ example: '2026-09-21', description: 'The `date` ‹ asks for: the Monday of the week before, or the first of the month before.' })
  previous!: string;

  @ApiProperty({ example: '2026-10-05', description: 'The `date` › asks for.' })
  next!: string;

  @ApiProperty({ example: '2026-09-28', description: 'The office’s today, in its own zone — never the browser’s.' })
  today!: string;

  @ApiProperty({ type: CalendarNowDto })
  now!: { at: string; minute: number };

  @ApiProperty({ type: CalendarSubjectDto, description: 'Whose calendar this is: yours, or the member you compared.' })
  subject!: CalendarPeriodView['subject'];

  @ApiProperty({
    type: 'array',
    items: { oneOf: [{ $ref: getSchemaPath(CalendarEntryDto) }, { $ref: getSchemaPath(CalendarBusyBlockDto) }] },
    description:
      'By start, then id: each an entry, or — in a compared read, for an entry the member only attends that '
      + 'you could not read in your own right — a busy block. Everything overlapping the period.',
  })
  entries!: (CalendarEntryView | CalendarBusyView)[];
}

export class CalendarDeletedDto implements CalendarDeleted {
  @ApiProperty()
  entryId!: string;

  @ApiProperty({ example: '2026-09-28T03:00:00.000Z', description: 'When it was deleted. It leaves every calendar it was on.' })
  deletedAt!: string;
}

/** The reader's own calendar settings (ADR-0110). */
export class CalendarSettingsDto implements CalendarSettings {
  @ApiProperty({
    description:
      '*Hide my personal activities*: on, your leaders comparing your week see only *Busy* at the times of '
      + 'the entries you organise, unless they are on one. Off until you turn it on.',
  })
  hideDetails!: boolean;
}

export class CalendarPersonRowDto implements CalendarPersonRow {
  @ApiProperty()
  membershipId!: string;

  @ApiProperty({ example: 'Rina Wijaya' })
  name!: string;

  @ApiProperty({ type: CalendarRungDto })
  rung!: { code: string; label: string };

  @ApiProperty({ type: String, nullable: true, example: 'Sari Puspita', description: 'Their leader’s full name; `null` for somebody with none.' })
  leaderName!: string | null;

  @ApiProperty({
    description: 'Their current leader is you: a direct report, whose tag is the rung alone. Everybody else’s adds *· under* their leader’s name.',
  })
  direct!: boolean;

  @ApiProperty({
    enum: PEOPLE_GROUPS,
    description:
      'Where they sit relative to you: `direct_unit` *Your direct unit*; `group` *Your group (AAB teams)*; '
      + '`other` *Other units in your KPM*; `leadership` *KPM leadership*, your upline.',
  })
  group!: PeopleGroup;
}

export class CalendarPageDto {
  @ApiProperty({ type: String, nullable: true })
  cursor!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The next page’s `cursor`; `null` on the last.' })
  nextCursor!: string | null;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty()
  hasMore!: boolean;
}

export class CalendarPeoplePageDto implements CalendarPeoplePage {
  @ApiProperty({ type: CalendarPersonRowDto, isArray: true, description: 'In the picker’s group order, then tree order, names A to Z within a level.' })
  items!: CalendarPersonRow[];

  @ApiProperty({ type: CalendarPageDto })
  page!: CalendarPeoplePage['page'];
}

export class CalendarDownlineRowDto implements CalendarDownlineRow {
  @ApiProperty()
  membershipId!: string;

  @ApiProperty({ example: 'Rina Wijaya' })
  name!: string;

  @ApiProperty({ type: CalendarRungDto })
  rung!: { code: string; label: string };

  @ApiProperty({ type: String, nullable: true, example: 'Sari Puspita', description: 'Their leader’s full name.' })
  leaderName!: string | null;

  @ApiProperty({ description: 'Their current leader is you: depth 1.' })
  direct!: boolean;

  @ApiProperty({ example: 1, description: 'Levels below you: 1 answers to you directly.' })
  depth!: number;

  @ApiProperty({
    enum: ['direct_unit', 'group'],
    description: '`direct_unit` *Direct unit*; `group` *AAB & their teams (group)*, each team after its head.',
  })
  group!: CalendarDownlineRow['group'];
}

export class CalendarDownlineDto implements CalendarDownline {
  @ApiProperty({ type: CalendarDownlineRowDto, isArray: true, description: 'Everybody you coach now; nobody when you lead nobody.' })
  people!: CalendarDownlineRow[];
}
