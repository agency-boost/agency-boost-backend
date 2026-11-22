import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { REPORTING_REFUSALS } from './reporting.messages';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * **The KPM Overview's one filter** (P19.19-T1 AC-1, AC-2): *Semua group ⌄* — an informal group by id, `none` for *Tanpa
 * group*, absent for the whole KPM. No page-wide period: sections 1 to 3 read the last 30 days and today, section 6 the
 * six months ending with this one. Any other parameter is 400, by name (the validation pipe refuses an unknown field).
 */
export class KpmOverviewQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    example: 'none',
    description:
      'An informal group’s id, or `none` for *Tanpa group*: every section is then over its people today. An unknown or '
      + 'archived group, or another office’s, is 404.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  group?: string;
}

/** **Performa vs target**'s month and the page's group (P19.19-T2 AC-1): *‹ November 2026 ›*. */
export class OverviewPerformanceQueryDto extends KpmOverviewQueryDto {
  @ApiPropertyOptional({
    example: '2026-11',
    description: '`YYYY-MM`. Absent: the office’s month. From January 2024 to the office’s month; outside it `422 '
      + 'AB_GROUP_TARGET_MONTH_CLOSED`, as the targets’ own read.',
  })
  @IsOptional()
  @Matches(MONTH, { message: field(REPORTING_REFUSALS.VALIDATION_FAILED.monthShape) })
  month?: string;
}
