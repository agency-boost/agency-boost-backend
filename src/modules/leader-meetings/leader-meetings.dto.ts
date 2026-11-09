import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsString, Max, MaxLength, Min, MinLength, ValidateBy, ValidateIf,
} from 'class-validator';
import { isLocalDate } from '@/common/time/local-day';
import { field } from '@/common/validation/violations';
import { LEADER_MEETING_LIMITS, LEADER_MEETING_TARGET_RATE_DECIMALS } from '@/domain/constants';
import { ACTION_STATUSES, AGENDA_SECTIONS, type ActionStatus, type AgendaSection } from './leader-meeting.schema';
import { LEADER_MEETINGS_REFUSALS } from './leader-meetings.messages';

/** The DTOs' own sentences, in both languages (P18.10-T5 AC-3): `field` carries them through class-validator. */
const SAY = LEADER_MEETINGS_REFUSALS.VALIDATION_FAILED;

const { titleMax, textMax, picMax } = LEADER_MEETING_LIMITS;

/** Leading and trailing spaces are not part of a title: `"  "` is an empty title, refused. */
const Trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * **Absent is "leave it"; `null` is refused**, 400 (the `unit-dashboard.dto.ts` convention). `@IsOptional()` would
 * let `null` through to the write, storing a meeting with no date or a row with no status.
 */
const Sent = () => ValidateIf((_: unknown, value: unknown) => value !== undefined);

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

/** **Empty on purpose** (P18.1-T2 AC-9): the list is the reader's office, every meeting; a parameter of any name is 400. */
export class LeaderMeetingsQueryDto {}

/** *+ New meeting*'s dialog (ADR-0130 §2): the numbered title, already filled, and an office date. */
export class CreateLeaderMeetingDto {
  @ApiProperty({ example: 'Strategic Check-in — #15', minLength: 1, maxLength: titleMax, description: 'Plain text, trimmed.' })
  @Trimmed()
  @IsString()
  @MinLength(1, { message: field(SAY.titleNotEmpty) })
  @MaxLength(titleMax)
  title!: string;

  @ApiProperty({ example: '2026-10-27', description: 'An office date, `YYYY-MM-DD`, in the agency’s calendar.' })
  @IsOfficeDate()
  date!: string;
}

/** The same dialog from the head's date (ADR-0130 §4): the title, the date, or both, while the meeting is upcoming. */
export class RescheduleLeaderMeetingDto {
  @ApiPropertyOptional({ example: 'Strategic Check-in — #14', minLength: 1, maxLength: titleMax })
  @Sent()
  @Trimmed()
  @IsString()
  @MinLength(1, { message: field(SAY.titleNotEmpty) })
  @MaxLength(titleMax)
  title?: string;

  @ApiPropertyOptional({ example: '2026-10-14', description: 'An office date, `YYYY-MM-DD`.' })
  @Sent()
  @IsOfficeDate()
  date?: string;

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

/** *+ Add item* (`:2863`), under one of the agenda's three sections. */
export class AddAgendaItemDto {
  @ApiProperty({ enum: AGENDA_SECTIONS })
  @IsIn(AGENDA_SECTIONS)
  section!: AgendaSection;
}

/**
 * **One agenda item's field** — its text, its PIC or its box — with the item's own `version`. One field per write;
 * a text that trims to nothing removes the item.
 */
export class SaveAgendaItemDto {
  @ApiPropertyOptional({ maxLength: textMax, description: 'Plain text. Emptied, the item is removed.' })
  @Sent()
  @IsString()
  @MaxLength(textMax)
  text?: string;

  @ApiPropertyOptional({ maxLength: picMax, description: 'A name typed by hand; empty for none.' })
  @Sent()
  @IsString()
  @MaxLength(picMax)
  pic?: string;

  @ApiPropertyOptional({ description: 'The item’s box, in any section (UI V1, UI-110).' })
  @Sent()
  @IsBoolean()
  done?: boolean;

  @ApiProperty({ example: 1, description: 'The item’s `version` you read.' })
  @IsInt()
  @Min(1)
  version!: number;
}

/** **One cell of an action row**, with the row's own `version`. One field per write. */
export class SaveActionItemDto {
  @ApiPropertyOptional({ maxLength: textMax, description: '*Key initiative*.' })
  @Sent()
  @IsString()
  @MaxLength(textMax)
  initiative?: string;

  @ApiPropertyOptional({ maxLength: textMax, description: '*Success metric*.' })
  @Sent()
  @IsString()
  @MaxLength(textMax)
  metric?: string;

  @ApiPropertyOptional({ maxLength: textMax, description: '*Action item*.' })
  @Sent()
  @IsString()
  @MaxLength(textMax)
  action?: string;

  @ApiPropertyOptional({ maxLength: picMax, description: '*PIC*: a name typed by hand.' })
  @Sent()
  @IsString()
  @MaxLength(picMax)
  pic?: string;

  @ApiPropertyOptional({ maxLength: textMax, description: '*Remarks / Target*.' })
  @Sent()
  @IsString()
  @MaxLength(textMax)
  remarks?: string;

  @ApiPropertyOptional({ enum: ACTION_STATUSES, description: '*Not yet planned*, *Planned* or *Implemented*.' })
  @Sent()
  @IsIn(ACTION_STATUSES)
  status?: ActionStatus;

  @ApiProperty({ example: 1, description: 'The row’s `version` you read.' })
  @IsInt()
  @Min(1)
  version!: number;
}

/** **The tracker's order, whole**: every row's id, in the new order. */
export class ReorderActionItemsDto {
  @ApiProperty({ type: [String], description: 'Every row of the meeting, each once, in their new order.' })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  itemIds!: string[];
}

/**
 * **One *Monthly Target* cell, as a rate per unit** (ADR-0175 §4): a number from 0 in the row's unit — IDR minor units for
 * `ape`, which the service holds to whole sen, a count to two places for the others (`LEADER_MEETING_TARGET_RATE_DECIMALS`,
 * which bounds every row's rate here) — or `null` to clear it, with the
 * cell's `version`, 0 for a cell never typed. **Anything that is not a number is refused**, a text included: the
 * free-text target is gone (the pipe converts nothing, `VALIDATION_PIPE_OPTIONS`).
 */
export class SaveMonthlyTargetDto {
  @ApiProperty({
    type: Number, nullable: true, minimum: 0, example: 1,
    description: 'The rate per unit, in the row’s unit: IDR minor units for `ape` (whole sen), a count to two places for '
      + 'the others. `null` clears the target. Not a number: `400 VALIDATION_FAILED`.',
  })
  @ValidateIf((_: unknown, value: unknown) => value !== null)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: LEADER_MEETING_TARGET_RATE_DECIMALS },
    { message: field(SAY.rateNumber) },
  )
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  rate!: number | null;

  @ApiProperty({ example: 0, description: 'The cell’s `version` you read: 0 for one never typed.' })
  @IsInt()
  @Min(0)
  version!: number;
}
