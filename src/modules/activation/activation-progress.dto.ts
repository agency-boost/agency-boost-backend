import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ACTIVATION } from '@/domain/constants';

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
const DATE_MESSAGE = '$property must be a day, written YYYY-MM-DD.';

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
}

/** A leader's tick: the item's state, and nothing else — no note and no date are drawn for a leader. */
export class TickHireActivationItemDto {
  @ApiProperty({ type: Boolean, description: 'Done or not. Sets the item rather than toggling it.' })
  @IsBoolean()
  done!: boolean;
}

export class CorrectActivationStartDto {
  @ApiProperty({
    type: String, example: '2026-07-01',
    description:
      'The day the activation started, an office date: the office’s today at the latest, and at most '
      + `${ACTIVATION.START_DATE_MAX_DAYS_BACK} days before it.`,
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
