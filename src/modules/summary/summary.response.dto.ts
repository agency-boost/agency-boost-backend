import { ApiProperty } from '@nestjs/swagger';
import type { LeadFlag } from '@/modules/leads/lead-attention';
import type { OpenLead } from '@/modules/leads/lead-readings';
import type { LeadType } from '@/modules/leads/lead.schema';
import type { FigureSource, SummaryActivity, SummaryView } from './summary.service';
import type { ActivityTarget, ActivityTargetKey, Pace, PeriodFigures, SectionChip } from './summary-figures';

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

export class ActivityTargetDto implements ActivityTarget {
  @ApiProperty({ enum: ['leads', 'appointments', 'closings'] }) key!: ActivityTargetKey;
  @ApiProperty({ example: 'SELL_SUBMISSION', description: 'The goal’s own code for this count (`cascadeMapping`).' }) code!: string;
  @ApiProperty({ description: 'Logged over the period, archived types included.' }) logged!: number;
  @ApiProperty({
    type: Number, nullable: true,
    description: '`SUMMARY_ACTIVITY_TARGET`. `null` without an APE target; 0 when the month needs nothing more — met, not unmeasured.',
  })
  target!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`ACTIVITY_TARGET_ATTAINMENT_PCT`, capped at 999; `null` on a zero or missing target.' })
  attainmentPct!: number | null;
  @ApiProperty() targetMet!: boolean;
}

class SectionRowDto {
  @ApiProperty({ example: 'RECRUIT_PRESENTATION' }) code!: string;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
}

export class SectionChipDto implements SectionChip {
  @ApiProperty({ example: 'RECRUITMENT' }) code!: string;
  @ApiProperty({ example: 'Recruitment' }) label!: string;
  @ApiProperty({ description: '`ACTIVITY_TOTAL_BY_CATEGORY` over the period; the rows add up to it.' }) total!: number;
  @ApiProperty({ type: [SectionRowDto] }) rows!: SectionRowDto[];
}

export class SummaryActivityDto implements SummaryActivity {
  @ApiProperty({ example: '2026-09-01' }) from!: string;
  @ApiProperty({ example: '2026-09-28' }) to!: string;
  @ApiProperty({ type: [ActivityTargetDto], description: 'Leads contacted, appointments, closings — in that order.' }) targets!: ActivityTargetDto[];
  @ApiProperty({ description: 'Every activity logged over the period, across all categories.' }) total!: number;
  @ApiProperty({ type: [SectionChipDto], description: 'One per section the reader is shown that holds none of the three codes above.' })
  sections!: SectionChipDto[];
}

class SummaryActivityPeriodsDto {
  @ApiProperty({ type: SummaryActivityDto, description: 'This calendar month, against the cascade on `MONTHLY_APE_TARGET`.' }) monthly!: SummaryActivityDto;
  @ApiProperty({ type: SummaryActivityDto, description: 'The year to date, against the cascade on the annual target.' }) yearly!: SummaryActivityDto;
}

export class OpenLeadDto implements OpenLead {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['sales', 'recruitment'], nullable: true }) type!: LeadType | null;
  @ApiProperty({ type: String, nullable: true }) statusCode!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The office’s name for the stage, archived stages included.' }) statusLabel!: string | null;
  @ApiProperty({ description: 'Promised for the office’s current month.' }) thisMonth!: boolean;
  @ApiProperty({ enum: ['overdue', 'no-next-action', 'no-remarks'], isArray: true, description: 'As the Leads screen derives them (`leadFlags`).' }) flags!: LeadFlag[];
  @ApiProperty({ type: Number, nullable: true, description: 'Whole days in the office’s zone; `null` unless overdue.' }) overdueDays!: number | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-09-18' }) nextActionDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextActionNote!: string | null;
}

class SummaryLeadsDto {
  @ApiProperty({ type: [OpenLeadDto], description: 'The nearest `SUMMARY.LEADS_SHOWN` (10), nearest next action first, undated last.' }) rows!: OpenLeadDto[];
  @ApiProperty({ description: 'Every open lead of the reader’s own.' }) total!: number;
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

  @ApiProperty({ type: SummaryActivityPeriodsDto, description: '*Your sales activity targets* and the other sections (P10-T5).' })
  activity!: { monthly: SummaryActivityDto; yearly: SummaryActivityDto };

  @ApiProperty({ type: SummaryLeadsDto, description: '*Leads that need you* (P10-T6): the reader’s own open leads.' })
  leads!: { rows: OpenLeadDto[]; total: number };
}
