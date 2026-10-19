import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested,
} from 'class-validator';

/**
 * **The limits a session's editable state is held to** (`functional/coaching.md`, the Data contract):
 * at most 50 items and 50 tips, each text at most 500 characters, and a reopen reason at most 500. An
 * id the client echoes back is at most 64 characters, as every subject parameter is.
 */
export const SESSION_LIMITS = { ITEMS_MAX: 50, TIPS_MAX: 50, TEXT_MAX: 500, REASON_MAX: 500, ID_MAX: 64 } as const;

/** `YYYY-MM-DD`. Whether it is a day at all — `2026-02-31` — the service checks. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'A date is written YYYY-MM-DD.';

/** What every pinned session write carries: the version it was read at (`conventions.md`, *Concurrency*). */
export class PinnedSessionDto {
  @ApiProperty({
    example: 3,
    description:
      'The `version` this write was read at. Refused with `409 VERSION_CONFLICT` when the session has moved '
      + 'on — the same session open on a second device is the realistic case.',
  })
  @IsInt() @Min(1)
  version!: number;
}

export class LastWeekItemChangeDto {
  @ApiProperty({ description: 'One of the session’s own *Last week’s action items*.' })
  @IsString() @MaxLength(SESSION_LIMITS.ID_MAX)
  itemId!: string;

  @ApiProperty({ description: 'Ticked done in this session. The session it came from never changes.' })
  @IsBoolean()
  done!: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-10-09', description: 'Its date, moved here; omitted keeps it.' })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  dueDate?: string | null;
}

export class ActionItemDraftDto {
  @ApiPropertyOptional({ description: 'The row’s id, as the session answered it. Omitted for a new row.' })
  @IsOptional() @IsString() @MaxLength(SESSION_LIMITS.ID_MAX)
  itemId?: string;

  @ApiProperty({ example: 'Book two presentations', description: 'Blank is kept while editing; finalize refuses it.' })
  @IsString() @MaxLength(SESSION_LIMITS.TEXT_MAX)
  text!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-10-09', description: 'Its date, or `null` until one is set.' })
  @IsOptional() @IsString() @Matches(DATE_SHAPE, { message: DATE_MESSAGE })
  dueDate?: string | null;
}

export class TipDraftDto {
  @ApiPropertyOptional({ description: 'The tip’s id, as the session answered it. Omitted for a new tip.' })
  @IsOptional() @IsString() @MaxLength(SESSION_LIMITS.ID_MAX)
  tipId?: string;

  @ApiProperty({ example: 'Confirm the next meeting before you leave the current one.' })
  @IsString() @MaxLength(SESSION_LIMITS.TEXT_MAX)
  text!: string;
}

/**
 * **A draft save: the whole editable state** (`PUT /coaching/sessions/:sessionId`). *Other action items*
 * and the tips are the whole lists as the coach left them — a row not sent is removed — and last week's
 * items are the ticks and dates written on this session.
 */
export class SaveCoachingSessionDto extends PinnedSessionDto {
  @ApiProperty({ type: LastWeekItemChangeDto, isArray: true, maxItems: SESSION_LIMITS.ITEMS_MAX })
  @IsArray() @ArrayMaxSize(SESSION_LIMITS.ITEMS_MAX) @ValidateNested({ each: true }) @Type(() => LastWeekItemChangeDto)
  lastWeekItems!: LastWeekItemChangeDto[];

  @ApiProperty({ type: ActionItemDraftDto, isArray: true, maxItems: SESSION_LIMITS.ITEMS_MAX })
  @IsArray() @ArrayMaxSize(SESSION_LIMITS.ITEMS_MAX) @ValidateNested({ each: true }) @Type(() => ActionItemDraftDto)
  actionItems!: ActionItemDraftDto[];

  @ApiProperty({ type: TipDraftDto, isArray: true, maxItems: SESSION_LIMITS.TIPS_MAX })
  @IsArray() @ArrayMaxSize(SESSION_LIMITS.TIPS_MAX) @ValidateNested({ each: true }) @Type(() => TipDraftDto)
  tips!: TipDraftDto[];
}

/** A reopen: the version read, and why (ADR-0079). */
export class ReopenCoachingSessionDto extends PinnedSessionDto {
  @ApiProperty({
    maxLength: SESSION_LIMITS.REASON_MAX,
    example: 'Two action items had the wrong dates.',
    description:
      'Why it is reopened. Required, and kept with the session: everybody who reads the session, the '
      + 'coachee included, reads it.',
  })
  @IsString() @MaxLength(SESSION_LIMITS.REASON_MAX) @Matches(/\S/, { message: 'reason must not be blank' })
  reason!: string;
}
