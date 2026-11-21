import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { DEMOGRAPHIC_DATA } from '@/domain/constants/advanced-analytics';
import { ADVANCED_ANALYTICS_REFUSALS as SAY } from './advanced-analytics.messages';
import { SHEET_DRIVERS, type SheetDriver } from './advanced-analytics.service';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
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

/** *MAPA driver*: the month shown (P19.22-T3; ADR-0275 §3). */
export class MapaQueryDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'The month shown, `YYYY-MM`, from January of last year to this one; this month by default.' })
  @IsOptional()
  @Matches(MONTH, { message: field(SAY.VALIDATION_FAILED.monthShape) })
  month?: string;
}

/** *Analisa kuantitatif*: the half-year picked. */
export class QuantQueryDto {
  @ApiPropertyOptional({ example: '2026-06', description: 'A half-year’s last month, `YYYY-06` or `YYYY-12`; the latest ended by default.' })
  @IsOptional()
  @Matches(RUN_END, { message: field(SAY.VALIDATION_FAILED.periodEndShape) })
  periodEnd?: string;
}

/** *Informal group*: the month shown (P19.22-T5 AC-1). */
export class SubgroupQueryDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'The month shown, `YYYY-MM`, no later than this one; this month by default.' })
  @IsOptional()
  @Matches(MONTH, { message: field(SAY.VALIDATION_FAILED.monthShape) })
  month?: string;
}

/** The sheet behind one number of an AB group (P19.22-T5 AC-4). */
export class SubgroupPeopleQueryDto extends SubgroupQueryDto {
  @ApiProperty({ description: 'The AB whose AB group the sheet is about: their membership id. Another KPM’s, or no AB of an AB group, is 404.' })
  @IsString()
  @MaxLength(64)
  ab!: string;

  @ApiProperty({ enum: SHEET_DRIVERS, description: '`maa` Monthly Active Agent · `usage` Pemakaian · `coaching` 1-on-1 · `rekrut` Rekrut YTD.' })
  @IsIn(SHEET_DRIVERS as unknown as string[], { message: field(SAY.VALIDATION_FAILED.driverShape({ drivers: SHEET_DRIVERS })) })
  driver!: SheetDriver;
}

/** *Demografi › Upload*: the filled list, as text (P19.22-T2; ADR-0275 §2). */
export class DemographicsUploadDto {
  @ApiProperty({ description: 'The CSV, as read from the file: *Kode agen* and the fields to fill. At most 90,000 bytes.' })
  @IsString()
  @MaxLength(DEMOGRAPHIC_DATA.FILE_MAX_BYTES, { message: field(SAY.VALIDATION_FAILED.fileTooLarge({ bytes: DEMOGRAPHIC_DATA.FILE_MAX_BYTES })) })
  file!: string;
}

/** The Super Admin's read of one section: the union of the sections' own parameters, each checked by its section. */
export class AdminAdvancedAnalyticsQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(MONTH, { message: field(SAY.VALIDATION_FAILED.monthShape) }) month?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) ab?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(RUN_END, { message: field(SAY.VALIDATION_FAILED.periodEndShape) }) periodEnd?: string;
  @ApiPropertyOptional({ description: 'NPS and *Kualitatif*: a run, by id.' }) @IsOptional() @IsString() @MaxLength(64) runId?: string;
}
