import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { field } from '@/common/validation/violations';
import { KPM_REPORTING, type KpmAnalyticsPeriod } from '@/domain/constants';
import { REPORTING_REFUSALS } from './reporting.messages';

/**
 * **Empty on purpose**: the Overview is the reader's office, with nothing to filter, page or name. A class with no
 * fields is how the validation pipe refuses a query parameter by name rather than ignoring it (P18-T1 AC-11).
 */
export class KpmOverviewQueryDto {}

/** The not-logged list takes no parameter either: the last 7 days, the office's whole membership. */
export class NotLoggedQueryDto {}

/** *Target* (`KPM_Owner.html:1060-1062`): the office's current month, and a whole number from 0. */
export class SetRecruitTargetDto {
  @ApiProperty({ example: '2026-10', description: 'The agency’s current month, `YYYY-MM`. No other month is accepted.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: field(REPORTING_REFUSALS.VALIDATION_FAILED.monthShape) })
  month!: string;

  @ApiProperty({ minimum: 0, example: 15, description: 'Recruits to close in the month: a whole number from 0.' })
  @IsInt()
  @Min(0)
  target!: number;
}

/** `period` and nothing else (P18-T2 AC-10): a period it does not know, or a parameter of any other name, is 400. */
export class KpmAnalyticsQueryDto {
  @ApiPropertyOptional({
    enum: KPM_REPORTING.ANALYTICS_PERIODS,
    default: KPM_REPORTING.ANALYTICS_DEFAULT_PERIOD,
    description:
      'Which month the month-bound columns read: *APE — This Month* and its target as fixed when that month '
      + 'began, *Active this month* / *Active last month*, and *Total leads* now or as they stood at last month’s '
      + 'end. *APE — Annual*, *Coached (7d)*, *Manpower*, MOC and the clubs are today’s whatever the period.',
  })
  @IsOptional()
  @IsIn(KPM_REPORTING.ANALYTICS_PERIODS)
  period?: KpmAnalyticsPeriod;
}

/** Cross-platform analytics takes no parameter: every office, this month. */
export class PlatformAnalyticsQueryDto {}
