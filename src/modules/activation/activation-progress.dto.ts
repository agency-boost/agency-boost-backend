import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { field } from '@/common/validation/violations';
import { ACTIVATION } from '@/domain/constants';
import { ACTIVATION_REFUSALS } from './activation.messages';

/**
 * **The activation's requests** (`functional/activation.md`, the Data contract). Each limit is read from
 * `ACTIVATION`, so the OpenAPI document states the numbers the server enforces; whether a date is a day
 * at all — `2026-02-31` — and the start date's bounds against the office's today are the service's.
 *
 * Every body is checked field by field: the global pipe's `forbidNonWhitelisted` refuses any other field,
 * by name — a leader's tick that sends a `note` included.
 */

/** `YYYY-MM-DD`. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The day's shape, in both languages (P18.98-T5 AC-3): the service's own sentence, the field named by class-validator's
 * `$property`, which it fills in for each field in either language.
 */
const DATE_MESSAGE = field(ACTIVATION_REFUSALS.VALIDATION_FAILED.dayShape({ field: '$property' }));

/** A lead's name and a note, at most (the leads module's and the coaching module's own bounds hold them again). */
const RECORD_TEXT_MAX = 500;

/**
 * **The record a hand tick of a data-backed item is saved with** (P18.96-T4 AC-3; `functional/activation.md`,
 * *Data-backed items*). One of:
 *
 * - `closing` with `leadId` — *Which case?*, one of the member's existing closings (`GET …/closings`);
 * - `closing` with `name` and `date` — *Log a new closing*: a sales lead created at *Paid and issued* on that day;
 * - `one_on_one` with `date` and `note` — *Log 1:1*: a leader's is a coaching session with the hire; the hire's own
 *   is their note and date on the item, since a coachee writes no session about themselves (ADR-0078).
 *
 * Which fields a kind takes, and the days' bounds — the join date to the office's today — are the service's.
 */
export class ActivationItemRecordInputDto {
  @ApiProperty({ type: String, enum: ['closing', 'one_on_one'] })
  @IsIn(['closing', 'one_on_one'])
  kind!: 'closing' | 'one_on_one';

  @ApiPropertyOptional({ type: String, description: '`closing`: an existing closing of the member’s, by its lead id.' })
  @IsOptional() @IsString() @MaxLength(64)
  leadId?: string;

  @ApiPropertyOptional({
    type: String, maxLength: RECORD_TEXT_MAX, example: 'Ibu Ratna Kusuma',
    description: '`closing`, a new one: who the case was sold to — the lead’s name. Absent with a `date`: a pecah telor’s day alone (UI V1, D-26), logged under a name the API gives it.',
  })
  @IsOptional() @IsString() @MaxLength(RECORD_TEXT_MAX)
  name?: string;

  @ApiPropertyOptional({
    type: String, example: '2026-10-20',
    description: 'A new `closing`: the day it was paid and issued. `one_on_one`: the day it was held. An office date.',
  })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  date?: string;

  @ApiPropertyOptional({
    type: String, maxLength: RECORD_TEXT_MAX, example: 'Went through his first two presentations.',
    description: '`one_on_one`: what the 1:1 covered, trimmed, 1 to 500 characters.',
  })
  @IsOptional() @IsString() @MaxLength(RECORD_TEXT_MAX)
  note?: string;
}

/** The hire's own tick: the item's state, and their optional note and date. */
export class TickOwnActivationItemDto {
  @ApiProperty({ type: Boolean, description: 'Done or not. Sets the item rather than toggling it.' })
  @IsBoolean()
  done!: boolean;

  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: ACTIVATION.HIRE_NOTE_MAX, example: 'Did it with Sari on Tuesday.',
    description: '*Note (optional)*: the hire’s own, trimmed; empty or `null` clears it, absent leaves it. No leader reads it.',
  })
  @IsOptional() @IsString() @MaxLength(ACTIVATION.HIRE_NOTE_MAX)
  note?: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true, example: '2026-09-29',
    description: 'The hire’s own date for the item, an office date; `null` clears it, absent leaves it. No leader reads it.',
  })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  date?: string | null;

  @ApiPropertyOptional({
    type: ActivationItemRecordInputDto,
    description:
      'A data-backed item’s tick only: the closing it names, or the 1:1. Saved with the tick, or '
      + 'neither is. Refused on any other item.',
  })
  @IsOptional() @ValidateNested() @Type(() => ActivationItemRecordInputDto)
  record?: ActivationItemRecordInputDto;
}

/**
 * A leader's tick: the item's state, and — for a data-backed item — its record. No note and no date are drawn for a
 * leader.
 */
export class TickHireActivationItemDto {
  @ApiProperty({ type: Boolean, description: 'Done or not. Sets the item rather than toggling it.' })
  @IsBoolean()
  done!: boolean;

  @ApiPropertyOptional({
    type: ActivationItemRecordInputDto,
    description:
      'A data-backed item’s tick only: the closing it names — the hire’s, or a new one logged in their '
      + 'pipeline — or the 1:1, saved as a coaching session with them. Saved with the tick, or neither is.',
  })
  @IsOptional() @ValidateNested() @Type(() => ActivationItemRecordInputDto)
  record?: ActivationItemRecordInputDto;
}

export class CorrectActivationStartDto {
  @ApiProperty({
    type: String, example: '2026-07-01',
    description:
      'The hire’s **join date**, which their activation starts on (ADR-0169 §2), an office date: the office’s '
      + `today at the latest, and at most ${ACTIVATION.START_DATE_MAX_DAYS_BACK} days before it. Named \`startDate\` `
      + 'for the callers that already send it.',
  })
  @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  startDate!: string;
}

export class SaveActivationNoteDto {
  @ApiProperty({
    type: String, minLength: 1, maxLength: ACTIVATION.COACHING_NOTE_MAX,
    example: 'Great pace on prospecting — let’s focus on booking your first JFW this week.',
    description: 'The coaching note, trimmed: 1 to the limit once trimmed. Replaces the one before it.',
  })
  @IsString() @MaxLength(ACTIVATION.COACHING_NOTE_MAX)
  text!: string;
}
