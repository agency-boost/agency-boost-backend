import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { field } from '@/common/validation/violations';
import { TARGET_ROW_KEYS } from '@/modules/leader-meetings/scorecard/scorecard.types';
import { ADVANCED_ANALYTICS_REFUSALS as SAY } from './advanced-analytics.messages';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;
const RUN_END = /^\d{4}-(06|12)$/;

/** The shell read takes no parameter: a class with no fields refuses one by name (P18-T1 AC-11). */
export class AdvancedAnalyticsShellQueryDto {}

/** *Demografi KPM*: the month whose last day counts, and an AB's Group. */
export class DemographicsQueryDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'The month whose last day the manpower is counted on, `YYYY-MM`; this month by default.' })
  @IsOptional()
  @Matches(MONTH, { message: field(SAY.VALIDATION_FAILED.monthShape) })
  month?: string;

  @ApiPropertyOptional({ description: 'An AB’s membership id: every dimension over that AB’s Group (ADR-0204). Another KPM’s, or no AB, is 404.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ab?: string;
}

/** *Event*: a calendar month, or the year to date; an AB's Group. */
export class EventsQueryDto extends DemographicsQueryDto {}

/** *MAPA driver*: the year shown. */
export class MapaQueryDto {
  @ApiPropertyOptional({ example: '2026', description: 'The year shown, `YYYY`; this year by default.' })
  @IsOptional()
  @Matches(YEAR, { message: field(SAY.VALIDATION_FAILED.yearShape) })
  year?: string;
}

/** *Analitik kuantitatif*: the run picked. */
export class QuantQueryDto {
  @ApiPropertyOptional({ example: '2026-06', description: 'A run’s last month, `YYYY-06` or `YYYY-12`; the latest run by default.' })
  @IsOptional()
  @Matches(RUN_END, { message: field(SAY.VALIDATION_FAILED.periodEndShape) })
  periodEnd?: string;
}

/** *Perbaikan sub-group* reads this month, today: no parameter. */
export class SubgroupQueryDto {}

/** A MAPA target (ADR-0215 §7): a month, a row a target is typed for, and its value — or `null`, *TBD*. */
export class SetMapaTargetDto {
  @ApiProperty({ example: '2026-11', description: 'The month, `YYYY-MM`.' })
  @IsString()
  @Matches(MONTH, { message: field(SAY.VALIDATION_FAILED.monthShape) })
  month!: string;

  @ApiProperty({ enum: TARGET_ROW_KEYS, description: 'A MAPA row whose month a target is typed for — the forum’s five.' })
  @IsIn(TARGET_ROW_KEYS as unknown as string[], { message: field(SAY.VALIDATION_FAILED.rowShape({ rows: TARGET_ROW_KEYS })) })
  row!: string;

  @ApiProperty({ nullable: true, minimum: 0, description: 'In the row’s unit — IDR minor units for `ape` — a whole number; `null` clears it.' })
  @ValidateIf((_o, v) => v !== null)
  @IsInt({ message: field(SAY.VALIDATION_FAILED.valueShape) })
  @Min(0, { message: field(SAY.VALIDATION_FAILED.valueShape) })
  value!: number | null;
}

/** A head of group's targets (ADR-0215 §7): whole numbers from 0. */
export class SetSubgroupTargetDto {
  @ApiProperty({ minimum: 0, maximum: 1000, example: 3 })
  @IsInt({ message: field(SAY.VALIDATION_FAILED.targetShape) })
  @Min(0, { message: field(SAY.VALIDATION_FAILED.targetShape) })
  @Max(1000, { message: field(SAY.VALIDATION_FAILED.targetShape) })
  aaTarget!: number;

  @ApiProperty({ minimum: 0, maximum: 1000, example: 6 })
  @IsInt({ message: field(SAY.VALIDATION_FAILED.targetShape) })
  @Min(0, { message: field(SAY.VALIDATION_FAILED.targetShape) })
  @Max(1000, { message: field(SAY.VALIDATION_FAILED.targetShape) })
  recTarget!: number;
}

/** The Super Admin's read of one section: the union of the sections' own parameters, each checked by its section. */
export class AdminAdvancedAnalyticsQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(MONTH, { message: field(SAY.VALIDATION_FAILED.monthShape) }) month?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) ab?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(YEAR, { message: field(SAY.VALIDATION_FAILED.yearShape) }) year?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(RUN_END, { message: field(SAY.VALIDATION_FAILED.periodEndShape) }) periodEnd?: string;
  @ApiPropertyOptional({ description: 'NPS and *Kualitatif*: a run, by id.' }) @IsOptional() @IsString() @MaxLength(64) runId?: string;
}
