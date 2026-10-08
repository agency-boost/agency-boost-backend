import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min,
  ValidateIf, ValidateNested,
} from 'class-validator';
import { UNIT_DASHBOARD, type UnitDashboardPeriod } from '@/domain/constants';

/**
 * **`period` and `for`, and nothing else** (P15-T1 AC-10): a period it does not know, or a parameter of any
 * other name, is refused by name — as the coaching roster refuses one — rather than ignored.
 */
export class UnitDashboardQueryDto {
  @ApiPropertyOptional({
    enum: UNIT_DASHBOARD.PERIODS,
    default: UNIT_DASHBOARD.DEFAULT_PERIOD,
    description:
      'What the goal and activity figures measure. `month` (the default): this month. `year`: the year to '
      + 'date. `7d`: activity over the last 7 days against this month’s targets pro-rated, and this month’s '
      + 'goal figures — nobody reports a week’s APE. *Status*, the pacing mark and the lead counts are this '
      + 'month’s whatever the period.',
  })
  @IsOptional()
  @IsIn(UNIT_DASHBOARD.PERIODS)
  period?: UnitDashboardPeriod;

  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'The **membership** whose unit to read: somebody below you who leads somebody — or, for the agency’s '
      + 'owner and its administrators, any leader in the agency. Omitted, it is your own unit.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  for?: string;
}

/** One person's figures from the company report, in sen. Either or both; never `null`. */
export class ProductionRowDto {
  @ApiProperty({ description: 'The **membership** whose figures these are.' })
  @IsString()
  @MaxLength(64)
  membershipId!: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'This month’s APE, in IDR minor units (the screen sends whole rupiah × 100). Omit to leave it.',
  })
  // Absent is "leave it"; `null` is refused — a leader cannot clear a figure (ADR-0051).
  @ValidateIf((row: ProductionRowDto) => row.apeMonthlyMinor !== undefined)
  @IsInt()
  @Min(0)
  apeMonthlyMinor?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'The year to date’s APE, in IDR minor units. Omit to leave it.',
  })
  @ValidateIf((row: ProductionRowDto) => row.apeYtdMinor !== undefined)
  @IsInt()
  @Min(0)
  apeYtdMinor?: number;
}

/** *Save all* (`Overall.html:7542-7555`): the rows whose figures changed, pinned to the month's revision. */
export class UpdateProductionDto {
  @ApiProperty({ example: '2026-09', description: 'The agency’s current month, `YYYY-MM`. No other month is accepted.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @ApiProperty({ minimum: 0, description: 'The month’s revision as the dashboard read it (`production.revision`).' })
  @IsInt()
  @Min(0)
  revision!: number;

  @ApiProperty({ type: [ProductionRowDto], minItems: 1, maxItems: UNIT_DASHBOARD.MAX_ROWS_PER_SAVE })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(UNIT_DASHBOARD.MAX_ROWS_PER_SAVE)
  @ValidateNested({ each: true })
  @Type(() => ProductionRowDto)
  rows!: ProductionRowDto[];
}
