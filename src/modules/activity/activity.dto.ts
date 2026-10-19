import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, Matches } from 'class-validator';

/**
 * Every property carries a real `class-validator` decorator, not just `@ApiProperty`.
 *
 * The global pipe runs `whitelist: true, forbidNonWhitelisted: true`, and the whitelist keeps only
 * properties carrying one of **its** decorators — `@ApiProperty` is Swagger's. Three Phase 5 DTOs
 * were documented for OpenAPI and validated elsewhere, so the pipe stripped them whole and their
 * routes could not succeed at all. Found at the Phase 5 exit review; not repeated here.
 */

/** `YYYY-MM-DD`, and the message says so rather than failing a regex silently. */
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'A day is written YYYY-MM-DD, in this office’s timezone.';

export class ReadActivityDayQueryDto {
  @ApiPropertyOptional({ example: '2026-03-11', description: 'Defaults to today in the office.' })
  @IsOptional() @IsString() @Matches(LOCAL_DATE, { message: DATE_MESSAGE })
  date?: string;

  @ApiPropertyOptional({ description: 'Whose day. Defaults to your own; needs the scope to read, and another member’s read is audited.' })
  @IsOptional() @IsString() @MaxLength(64)
  membershipId?: string;
}

export class SaveActivityDayDto {
  @ApiPropertyOptional({ example: '2026-03-11', description: 'Defaults to today in the office.' })
  @IsOptional() @IsString() @Matches(LOCAL_DATE, { message: DATE_MESSAGE })
  date?: string;

  /**
   * `{ activityTypeCode: count }`. A code this office does not have is refused **by name**, and a
   * code left out counts as zero — the screen sends the whole day, because a day is the unit.
   *
   * **There is no `membershipId` here, and that is the enforcement.** No role may log on another
   * person's behalf (`roles-and-permissions.md` §3.5); a route with no subject to pass is a
   * stronger guarantee than a check that has to be remembered.
   */
  @ApiProperty({ example: { LEADS_GEN_ACTIVITY: 3, SELL_SUBMISSION: 1 } })
  @IsObject()
  counts!: Record<string, number>;
}

export class CorrectActivityDayDto {
  @ApiProperty({ example: '2026-02-11', description: 'The frozen day being corrected.' })
  @IsString() @Matches(LOCAL_DATE, { message: DATE_MESSAGE })
  date!: string;

  @ApiProperty({ example: { SELL_SUBMISSION: 2 } })
  @IsObject()
  counts!: Record<string, number>;

  @ApiProperty({
    example: 'Two submissions were logged against the wrong day.',
    description: 'Required. A correction nobody can explain is a number that changed for no '
      + 'reason anybody can find.',
  })
  @IsString() @MaxLength(500)
  reason!: string;
}

export class ActivitySummaryQueryDto {
  @ApiPropertyOptional({ enum: ['ROLLING_7D', 'ROLLING_30D', 'CALENDAR_MONTH'] })
  @IsOptional() @IsIn(['ROLLING_7D', 'ROLLING_30D', 'CALENDAR_MONTH'])
  period?: string;

  @ApiPropertyOptional({ example: '2026-03-01', description: 'With `to`, overrides `period`.' })
  @IsOptional() @IsString() @Matches(LOCAL_DATE, { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({ example: '2026-03-31' })
  @IsOptional() @IsString() @Matches(LOCAL_DATE, { message: DATE_MESSAGE })
  to?: string;

  @ApiPropertyOptional({ description: 'Whose totals. Defaults to your own; another member’s read is audited.' })
  @IsOptional() @IsString() @MaxLength(64)
  membershipId?: string;
}

export class ActivityDashboardQueryDto {
  @ApiPropertyOptional({
    enum: ['ROLLING_7D', 'ROLLING_30D', 'CUSTOM'],
    description: 'The two presets end today in the office’s timezone. `CUSTOM` needs `from` and `to`.',
  })
  @IsOptional() @IsIn(['ROLLING_7D', 'ROLLING_30D', 'CUSTOM'])
  range?: string;

  @ApiPropertyOptional({ example: '2026-09-01', description: '`CUSTOM` only.' })
  @IsOptional() @IsString() @Matches(LOCAL_DATE, { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-28', description: '`CUSTOM` only. Not after today.' })
  @IsOptional() @IsString() @Matches(LOCAL_DATE, { message: DATE_MESSAGE })
  to?: string;

  /**
   * **Whose days** (P13.1-T9): coaching's *Activity* tab names the coachee here, by the name the
   * ratios' subject has — `for` — so a caller who sent `membershipId` is refused by name rather than
   * answered with their own days.
   */
  @ApiPropertyOptional({
    name: 'for',
    maxLength: 64,
    description: 'Whose days: a membership id. Defaults to your own; another member’s needs the scope '
      + 'to read them, is a 404 outside it, is drawn on their rung, and is audited.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  for?: string;
}

/**
 * **One field, `for`** (P11-T4 AC-2): whose ratios — yours, or a coachee's, the session's Ratios card.
 * The subject keeps this route's name for it, as the Summary's and the goals' do (`functional/coaching.md`,
 * the Data contract). Every other field is refused by name by `forbidNonWhitelisted` — `membershipId`
 * included, which is the activity reads' name and not this one's, so a caller who sent it is told rather
 * than answered with their own ratios.
 */
export class ActivityRatiosQueryDto {
  @ApiPropertyOptional({
    name: 'for',
    maxLength: 64,
    description: 'Whose ratios: a membership id. Defaults to your own; another member’s needs the scope '
      + 'to read them, is a 404 outside it, and is audited.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  for?: string;
}
