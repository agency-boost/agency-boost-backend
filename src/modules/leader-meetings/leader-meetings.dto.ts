import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Matches, MaxLength, Min, MinLength, ValidateBy, ValidateIf } from 'class-validator';
import { isLocalDate } from '@/common/time/local-day';
import { field } from '@/common/validation/violations';
import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import { ACTION_STATUSES, type ActionStatus } from './leader-meeting.schema';
import { LEADER_MEETINGS_REFUSALS } from './leader-meetings.messages';

/** The DTOs' own sentences, in both languages (P18.10-T5 AC-3): `field` carries them through class-validator. */
const SAY = LEADER_MEETINGS_REFUSALS.VALIDATION_FAILED;

const { textMax } = LEADER_MEETING_LIMITS;

/** Leading and trailing spaces are not part of a text: `"  "` is an empty text, refused. */
const Trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * **Absent is "leave it"; `null` is refused**, 400 (the `unit-dashboard.dto.ts` convention). `@IsOptional()` would
 * let `null` through to the write.
 */
const Sent = () => ValidateIf((_: unknown, value: unknown) => value !== undefined);

/** **Absent is "leave it"; `null` clears it** — a PIC or a *tenggat*. */
const SentOrCleared = () => ValidateIf((_: unknown, value: unknown) => value !== undefined && value !== null);

/** A real office date, `YYYY-MM-DD`: `2026-02-31` matches the shape and is not a day. */
function IsOfficeDate() {
  return ValidateBy({
    name: 'isOfficeDate',
    validator: {
      validate: (value: unknown) => isLocalDate(value),
      defaultMessage: () => field(SAY.dateShape),
    },
  });
}

/** `HH:MM`, 00:00 to 23:59: a forum's time in the office's day. */
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A member, by membership id: 24 hex characters. */
const MEMBERSHIP_ID = /^[0-9a-f]{24}$/;

/** *Semua*: an agenda line for everybody at the forum. */
export const PIC_ALL = 'all';

/** **Empty on purpose** (P18.1-T2 AC-9): the list is the reader's office, every forum; a parameter of any name is 400. */
export class LeaderMeetingsQueryDto {}

/** *+ Forum baru* (P19.22-T8 AC-1; ADR-0276): an office date and a time. No title: every forum is *Forum #n*. */
export class CreateLeaderMeetingDto {
  @ApiProperty({ example: '2026-11-27', description: 'An office date, `YYYY-MM-DD`, in the agency’s calendar.' })
  @IsOfficeDate()
  date!: string;

  @ApiProperty({ example: '14:00', description: 'The office time it starts, `HH:MM`.' })
  @Matches(TIME_SHAPE, { message: field(SAY.timeShape) })
  time!: string;
}

/** The date, the time or both, while the forum is upcoming (ADR-0130 §4). */
export class RescheduleLeaderMeetingDto {
  @ApiPropertyOptional({ example: '2026-11-28', description: 'An office date, `YYYY-MM-DD`.' })
  @Sent()
  @IsOfficeDate()
  date?: string;

  @ApiPropertyOptional({ example: '15:00', description: '`HH:MM`.' })
  @Sent()
  @Matches(TIME_SHAPE, { message: field(SAY.timeShape) })
  time?: string;

  @ApiProperty({ example: 1, description: 'The head’s `version` you read. Refused `409 VERSION_CONFLICT` once it has moved on.' })
  @IsInt()
  @Min(1)
  version!: number;
}

/** `?version=` on a delete: the version you read. */
export class LeaderMeetingVersionQueryDto {
  @ApiProperty({ example: 1, description: 'The `version` you read.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

/** *+ Tambah agenda* (AC-3): the line's text, and its PIC if one is chosen. */
export class AddAgendaItemDto {
  @ApiProperty({ minLength: 1, maxLength: textMax, example: 'Rencana Closing Clinic Desember' })
  @Trimmed()
  @IsString()
  @MinLength(1, { message: field(SAY.textNotEmpty) })
  @MaxLength(textMax)
  text!: string;

  @ApiPropertyOptional({
    nullable: true, example: 'all',
    description: 'A member’s membership id — one of the forum’s editors — or `"all"` (*Semua*), or `null` for none.',
  })
  @SentOrCleared()
  @IsString()
  @Matches(new RegExp(`^(${PIC_ALL}|[0-9a-f]{24})$`))
  pic?: string | null;
}

/**
 * **One agenda line's field** — its text, its PIC or its box — with the line's own `version`. One field per write; a
 * text that trims to nothing removes the line.
 */
export class SaveAgendaItemDto {
  @ApiPropertyOptional({ maxLength: textMax, description: 'Plain text. Emptied, the line is removed.' })
  @Sent()
  @Trimmed()
  @IsString()
  @MaxLength(textMax)
  text?: string;

  @ApiPropertyOptional({ nullable: true, description: 'A member’s membership id (an editor), `"all"` (*Semua*), or `null` for none.' })
  @SentOrCleared()
  @IsString()
  @Matches(new RegExp(`^(${PIC_ALL}|[0-9a-f]{24})$`))
  pic?: string | null;

  @ApiPropertyOptional({ description: 'Ticked during the forum.' })
  @Sent()
  @IsBoolean()
  done?: boolean;

  @ApiProperty({ example: 1, description: 'The line’s `version` you read.' })
  @IsInt()
  @Min(1)
  version!: number;
}

/** *+ Tambah action item* (AC-4): what is to be done, and its PIC and *tenggat* if chosen. *Belum*. */
export class AddActionItemDto {
  @ApiProperty({ minLength: 1, maxLength: textMax, example: 'Siapkan Closing Clinic Desember' })
  @Trimmed()
  @IsString()
  @MinLength(1, { message: field(SAY.textNotEmpty) })
  @MaxLength(textMax)
  text!: string;

  @ApiPropertyOptional({ nullable: true, description: 'A member’s membership id — one of the forum’s editors — or `null`.' })
  @SentOrCleared()
  @IsString()
  @Matches(MEMBERSHIP_ID)
  pic?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-02', description: '*Tenggat*, an office date, or `null`.' })
  @SentOrCleared()
  @IsOfficeDate()
  dueOn?: string | null;
}

/** **One action item's field** — text, PIC, *tenggat* or state — with the item's own `version`. One field per write. */
export class SaveActionItemDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: textMax, description: 'What is to be done. Never empty: the trash removes an item.' })
  @Sent()
  @Trimmed()
  @IsString()
  @MinLength(1, { message: field(SAY.textNotEmpty) })
  @MaxLength(textMax)
  text?: string;

  @ApiPropertyOptional({ nullable: true, description: 'A member’s membership id (an editor), or `null` for none.' })
  @SentOrCleared()
  @IsString()
  @Matches(MEMBERSHIP_ID)
  pic?: string | null;

  @ApiPropertyOptional({ nullable: true, description: '*Tenggat*, `YYYY-MM-DD`, or `null` for none.' })
  @SentOrCleared()
  @IsOfficeDate()
  dueOn?: string | null;

  @ApiPropertyOptional({ enum: ACTION_STATUSES, description: '*Belum* (`todo`), *Proses* (`doing`) or *Selesai* (`done`).' })
  @Sent()
  @IsIn(ACTION_STATUSES)
  status?: ActionStatus;

  @ApiProperty({ example: 1, description: 'The item’s `version` you read.' })
  @IsInt()
  @Min(1)
  version!: number;
}
