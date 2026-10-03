import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { CALENDAR, CALENDAR_ENTRY_TYPES, type CalendarEntryType } from '@/domain/constants';

/**
 * **The calendar's requests** (`functional/calendar.md`, the Data contract). The shapes and the limits
 * are checked here, every limit read from `CALENDAR` so the OpenAPI document states the numbers the
 * server enforces; the rules between fields — an end after its start, a trip of at most 31 days, an
 * invitee who is a member — are the service's, in `calendar-time.ts` and `calendar.service.ts`.
 *
 * **Every query is refused field by field**: the global pipe's `forbidNonWhitelisted` answers any other
 * parameter 400, by name, rather than ignoring it.
 */

/** `YYYY-MM-DD`. Whether it is a day at all — `2026-02-31` — the service checks. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property must be a day, written YYYY-MM-DD.';
/** `HH:mm`, 24-hour. `00:00` as an end is midnight at the end of the date. */
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_MESSAGE = '$property must be a time, written HH:mm, 00:00 to 23:59.';

export class CalendarEntriesQueryDto {
  @ApiPropertyOptional({ enum: ['week', 'month'], default: 'week', description: 'The period to answer.' })
  @IsOptional() @IsIn(['week', 'month'])
  view?: 'week' | 'month';

  @ApiPropertyOptional({
    example: '2026-09-28',
    description: 'An office date in the week or month to answer; the office’s today when omitted.',
  })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  date?: string;

  @ApiPropertyOptional({
    minLength: 1, maxLength: CALENDAR.ID_MAX,
    description:
      'A member you coach, whose week to compare beside your own. `view=week` only. Anybody else — '
      + 'yourself included — is not found; sent empty, it is refused rather than read as your own.',
  })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(CALENDAR.ID_MAX)
  for?: string;
}

/** An entry's own fields: what *New event* and *Edit event* send. */
class CalendarEntryFieldsDto {
  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: CALENDAR.TITLE_MAX, example: 'Weekly unit standup',
    description: 'Optional; trimmed. An entry with none is drawn *(untitled event)*.',
  })
  @IsOptional() @IsString() @MaxLength(CALENDAR.TITLE_MAX)
  title?: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: CALENDAR.NOTES_MAX, example: 'Zoom — zoom.us/j/91827364',
    description: '*Notes / location*. Optional; trimmed.',
  })
  @IsOptional() @IsString() @MaxLength(CALENDAR.NOTES_MAX)
  notes?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-09-28', description: 'A timed entry’s office date.' })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  date?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '09:00', description: 'A timed entry’s start, the office’s wall clock.' })
  @IsOptional() @IsString() @Matches(TIME_SHAPE, { message: TIME_MESSAGE })
  start?: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true, example: '09:30',
    description: 'A timed entry’s end, after its start on the same date; `00:00` is midnight at the end of it.',
  })
  @IsOptional() @IsString() @Matches(TIME_SHAPE, { message: TIME_MESSAGE })
  end?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-10-01', description: 'Travel’s *Departure date*, an office date.' })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  startsOn?: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true, example: '2026-10-02',
    description: `Travel’s *Return date*: on or after the departure, at most ${CALENDAR.TRAVEL_DAYS_MAX} days inclusive.`,
  })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  endsOn?: string | null;

  @ApiPropertyOptional({
    type: String, isArray: true, maxItems: CALENDAR.INVITEES_MAX, uniqueItems: true,
    description:
      'Members of your office to invite, by membership: active field members only, never yourself. An id '
      + 'that is not one is named in the 404’s `details.inviteeIds`.',
  })
  @IsOptional() @IsArray() @ArrayMaxSize(CALENDAR.INVITEES_MAX) @ArrayUnique()
  @IsString({ each: true }) @MaxLength(CALENDAR.ID_MAX, { each: true })
  inviteeIds?: string[];
}

export class CreateCalendarEntryDto extends CalendarEntryFieldsDto {
  @ApiProperty({ enum: CALENDAR_ENTRY_TYPES, description: 'Travel takes two dates; every other type a date and two times.' })
  @IsIn(CALENDAR_ENTRY_TYPES)
  type!: CalendarEntryType;
}

export class UpdateCalendarEntryDto extends CalendarEntryFieldsDto {
  @ApiProperty({
    example: 1,
    description: 'The `version` you read. Refused with `409 VERSION_CONFLICT` when the entry has moved on.',
  })
  @IsInt() @Min(1)
  version!: number;

  @ApiPropertyOptional({
    enum: CALENDAR_ENTRY_TYPES,
    description: 'A change between Travel and a timed type sends the other kind’s fields.',
  })
  @IsOptional() @IsIn(CALENDAR_ENTRY_TYPES)
  type?: CalendarEntryType;
}

export class DeleteCalendarEntryQueryDto {
  @ApiProperty({ example: 1, description: 'The `version` you read.' })
  @Type(() => Number) @IsInt() @Min(1)
  version!: number;
}

export class AnswerCalendarEntryDto {
  @ApiProperty({ enum: ['accepted', 'declined'], description: 'Your own answer. You can change it later.' })
  @IsIn(['accepted', 'declined'])
  answer!: 'accepted' | 'declined';
}

export class CreateCalendarBlockDto extends CreateCalendarEntryDto {
  @ApiProperty({
    maxLength: CALENDAR.ID_MAX,
    description: 'The member the time is placed on: somebody you coach. They are on it as placed, with no answer to give.',
  })
  @IsString() @MaxLength(CALENDAR.ID_MAX)
  membershipId!: string;
}

export class CalendarPeopleQueryDto {
  @ApiPropertyOptional({
    maxLength: CALENDAR.PEOPLE_QUERY_MAX, example: 'rina',
    description: 'Part of a full name, any case. Empty lists everybody.',
  })
  @IsOptional() @IsString() @MaxLength(CALENDAR.PEOPLE_QUERY_MAX)
  q?: string;

  @ApiPropertyOptional({ description: 'The `nextCursor` of the page before.' })
  @IsOptional() @IsString() @MaxLength(2048)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: CALENDAR.PEOPLE_PAGE_MAX, default: CALENDAR.PEOPLE_PAGE_MAX })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(CALENDAR.PEOPLE_PAGE_MAX)
  limit?: number;
}

/**
 * **Empty on purpose**: the compare list is the reader's own reach, with nothing to filter or page. A
 * query parameter of any name is refused by name rather than ignored.
 */
export class CalendarDownlineQueryDto {}
