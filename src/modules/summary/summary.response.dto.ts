import { ApiProperty } from '@nestjs/swagger';
import type { FigureSource, SummaryView } from './summary.service';
import type { Pace, PeriodFigures } from './summary-figures';

/** Declared for OpenAPI. The wire shapes live on `SummaryService`'s view types. */

export class FigureSourceDto implements FigureSource {
  @ApiProperty({ enum: ['imported', 'corrected', 'self_reported'] }) provenance!: 'imported' | 'corrected' | 'self_reported';
  @ApiProperty({ type: String, nullable: true, example: '2026-09' }) month!: string | null;
}

class PeriodFiguresDto implements PeriodFigures {
  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units. `null` without a goal.' }) targetMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`null` when nothing is held yet — not zero.' }) actualMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`APE_ATTAINMENT_PCT`, capped at 999. `null` without a target or an actual.' }) attainmentPct!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`APE_GAP_TO_TARGET`.' }) gapMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) overMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`POLICIES_NEEDED`.' }) policiesNeeded!: number | null;
  @ApiProperty() targetMet!: boolean;
}

export class MonthlyFiguresDto extends PeriodFiguresDto {
  @ApiProperty({
    type: FigureSourceDto, nullable: true,
    description: 'Where this month’s APE came from; `null` until the file for the month arrives.',
  })
  source!: FigureSource | null;
}

export class YearlyFiguresDto extends PeriodFiguresDto {
  @ApiProperty({ type: FigureSourceDto, description: 'The office’s year to date, or the agent’s own figure (P9-T6).' })
  source!: FigureSource;
}

export class PaceDto implements Pace {
  @ApiProperty() closingTarget!: number;
  @ApiProperty() closingsLogged!: number;
  @ApiProperty() dayOfMonth!: number;
  @ApiProperty() daysInMonth!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`PROJECTED_CLOSINGS_THIS_MONTH`; `null` before the 7th of the month.' }) projected!: number | null;
  @ApiProperty({ description: 'Days left today included, over 7, rounded up — never zero.' }) weeksLeft!: number;
  @ApiProperty({ description: '`CLOSINGS_NEEDED_PER_WEEK`; 0 once the target is reached.' }) neededPerWeek!: number;
  @ApiProperty() targetMet!: boolean;
}

class SummaryGoalDto {
  @ApiProperty({ description: 'A goal has been saved for the year. The defaults a first-time reader sees are not one.' }) set!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) savedAt!: string | null;
}

export class SummaryDto implements SummaryView {
  @ApiProperty({ example: '2026' }) year!: string;
  @ApiProperty({ example: '2026-09' }) month!: string;
  @ApiProperty({ example: '2026-09-28' }) today!: string;
  @ApiProperty({ type: SummaryGoalDto }) goal!: { set: boolean; savedAt: string | null };
  @ApiProperty() caseSizeMinor!: number;

  @ApiProperty({
    type: MonthlyFiguresDto,
    description: '*Monthly* (ADR-0056): `MONTHLY_APE_TARGET` — fixed against this month’s own figure — against this month’s uploaded APE.',
  })
  monthly!: MonthlyFiguresDto;

  @ApiProperty({ type: YearlyFiguresDto, description: '*Yearly*: the annual target against the year to date.' })
  yearly!: YearlyFiguresDto;

  @ApiProperty({ type: PaceDto, nullable: true, description: 'The pace sentence (ADR-0057); `null` without a goal.' })
  pace!: Pace | null;
}
