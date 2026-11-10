import { ApiProperty } from '@nestjs/swagger';
import { LeadResponseDto } from '@/modules/leads/lead.response.dto';
import { INSIGHT_RULES, type Insight, type InsightKind, type InsightRule } from './insights';
import { FigureSourceDto } from './figure-source.dto';
import type { FigureSource, SummaryActivity, SummaryView } from './summary.service';

export { FigureSourceDto };
import type {
  ActivityTarget, ActivityTargetKey, MonthApeSource, MonthRealised, Pace, PeriodFigures, SectionChip,
} from './summary-figures';

/** Declared for OpenAPI. The wire shapes live on `SummaryService`'s view types. */

class PeriodFiguresDto implements PeriodFigures {
  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units. `null` without a goal.' }) targetMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`null` when nothing is held yet — not zero.' }) actualMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`APE_ATTAINMENT_PCT`, capped at 999. `null` without a target or an actual.' }) attainmentPct!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`APE_GAP_TO_TARGET`.' }) gapMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) overMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`POLICIES_NEEDED`.' }) policiesNeeded!: number | null;
  @ApiProperty() targetMet!: boolean;
}

/** UI-157 item 2: the helpers with nothing held, counting 0 achieved. */
class WithoutProductionDto {
  @ApiProperty({ description: '*Sisa*: the whole target — `APE_GAP_TO_TARGET` at an APE of 0. IDR minor units.' }) gapMinor!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`POLICIES_NEEDED` at an APE of 0; `null` without a case size.' }) policiesNeeded!: number | null;
}

/** Whose figure the period's APE produced is, and the helpers without one (P19.1-T4, UI-157; ADR-0195). */
class ProductionHeldDto extends PeriodFiguresDto {
  @ApiProperty({
    enum: ['official', 'estimate', 'none'],
    description: '`official`: the office’s file, imported or corrected. `estimate`: the member’s own figure, typed on Goal '
      + 'Settings or the Summary — *perkiraan Anda* (a coach’s typing too, ADR-0183) — the year to date, or on `monthly` the '
      + 'month’s own figure typed over the upload (`realised.source: manual`). `none`: nothing yet.',
  })
  production!: 'official' | 'estimate' | 'none';
  @ApiProperty({
    type: WithoutProductionDto, nullable: true,
    description: 'With `production: none` and a target above 0 not yet met, the helpers counting what was achieved as 0 '
      + '(UI-157 item 2), which the screen marks *(belum ada data produksi)*; `null` otherwise.',
  })
  withoutProduction!: { gapMinor: number; policiesNeeded: number | null } | null;
}

/** P19.1-T4 AC-11: the office's figure replaced an estimate. */
class EstimateReplacedDto {
  @ApiProperty({
    type: String, format: 'date', example: '2026-12-05',
    description: 'The office’s day its year-to-date figure was written — the correction’s, or the year’s latest import — '
      + 'after the estimate: *Diganti data produksi resmi (diunggah 5 Des)*.',
  })
  uploadedOn!: string;
}

/** The member's own figure for a month, typed over the upload (P19.11-T4). */
class MonthManualDto {
  @ApiProperty({ example: 216_500_000_00, description: 'IDR sen: the month’s APE as the member typed it, in millions on the screen.' })
  minor!: number;
  @ApiProperty({ type: String, format: 'date-time', description: 'When the member typed it.' }) typedAt!: string;
}

/** *Bulanan*'s realised APE: which figure `actualMinor` is (P19.11-T4; UX-12, UXQ2's default). */
class MonthRealisedDto implements MonthRealised {
  @ApiProperty({
    enum: ['manual', 'uploaded', 'none'],
    description: 'Which figure `actualMinor` is — **the member’s own figure typed over the upload, then the office’s upload, '
      + 'then nothing** (*Belum diunggah*). `manual` is the screen’s *Diubah manual*.',
  })
  source!: MonthApeSource;
  @ApiProperty({
    description: 'The office holds an upload for the month, in force or not — with `manual`, the screen offers *Kembalikan ke '
      + 'data unggahan*; without, clearing goes back to *Belum diunggah*.',
  })
  uploaded!: boolean;
  @ApiProperty({
    type: MonthManualDto, nullable: true,
    description: 'The member’s own figure for the month (`PUT /goals/:period/ape-month`), always the one in force; `null` without one.',
  })
  manual!: { minor: number; typedAt: string } | null;
}

export class MonthlyFiguresDto extends ProductionHeldDto {
  @ApiProperty({
    type: FigureSourceDto, nullable: true,
    description: 'Where this month’s APE came from: the office’s file, or — with `realised.source: manual` — `self_reported` '
      + 'for the month, the member’s own figure typed over it; `null` while neither is held.',
  })
  source!: FigureSource | null;

  @ApiProperty({
    type: MonthRealisedDto,
    description: 'The realised APE’s source — `manual`, `uploaded` or `none` — and whether an upload '
      + 'exists for the month. `actualMinor` is `manual ?? uploaded`, and the attainment, `gapMinor` (never below 0), '
      + '`policiesNeeded` and `targetMet` are worked out from it. The member’s own Summary and their coach’s view of it only: '
      + 'no leader’s, Unit Dashboard’s or office’s figure reads the member’s own.',
  })
  realised!: MonthRealised;
}

export class YearlyFiguresDto extends ProductionHeldDto {
  @ApiProperty({ type: FigureSourceDto, description: 'The office’s year to date, or the agent’s own figure.' })
  source!: FigureSource;
}

/** The pace sentence's figures (ADR-0109): *tracking to close N … a target of M … W weeks left … K policies/week*. */
export class PaceDto implements Pace {
  @ApiProperty({ description: '*M*: this month’s closing target — the closings chip’s.' }) closingTarget!: number;
  @ApiProperty({ description: '*N*, `CLOSINGS_LAST_30_DAYS`: the goal’s closing code over the last 30 days, today included, in the office’s calendar.' })
  closingsLast30Days!: number;
  @ApiProperty() dayOfMonth!: number;
  @ApiProperty() daysInMonth!: number;
  @ApiProperty({ description: '*W*: days left today included, over 7, rounded up — never zero.' }) weeksLeft!: number;
  @ApiProperty({ description: '`POLICIES_NEEDED` for the month: this month’s APE gap over the case size, rounded up — the whole target’s until the month’s file lands; 0 once the target is reached.' })
  policiesNeeded!: number;
  @ApiProperty({ description: '*K*, `CLOSINGS_NEEDED_PER_WEEK`: the policies still needed over the weeks left, rounded up.' }) neededPerWeek!: number;
  @ApiProperty({ description: 'This month’s APE target, or the year’s, is reached: the green sentence instead of the danger box.' }) targetMet!: boolean;
}

export class ActivityTargetDto implements ActivityTarget {
  @ApiProperty({ enum: ['leads', 'appointments', 'closings'] }) key!: ActivityTargetKey;
  @ApiProperty({ example: 'SELL_SUBMISSION', description: 'The first code the office binds to this role (its activity binding).' }) code!: string;
  @ApiProperty({
    type: [String], example: ['SELL_SUBMISSION'],
    description: 'Every code the office binds to this role; `logged` is their sum, so a replaced activity keeps counting.',
  })
  codes!: string[];
  @ApiProperty({ description: 'Logged over the period, every bound code summed, archived types included.' }) logged!: number;
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
  @ApiProperty({ example: 'DEVELOPMENT', description: 'The summary tile\'s group code (ADR-0064), or the section\'s own code when it has a tile of its own.' })
  code!: string;
  @ApiProperty({ example: 'Development', description: 'The group\'s label, or the section\'s own.' }) label!: string;
  @ApiProperty({ description: '`ACTIVITY_TOTAL_BY_CATEGORY` over the period, summed over the tile\'s sections; the rows add up to it.' }) total!: number;
  @ApiProperty({ type: [SectionRowDto] }) rows!: SectionRowDto[];
}

export class SummaryActivityDto implements SummaryActivity {
  @ApiProperty({ example: '2026-09-01' }) from!: string;
  @ApiProperty({ example: '2026-09-28' }) to!: string;
  @ApiProperty({
    type: [ActivityTargetDto],
    description: 'Leads contacted, appointments, closings — in that order. The year’s are the cascade on what the year still '
      + 'needs, so its closings target is `yearly.policiesNeeded` (UI-052).',
  }) targets!: ActivityTargetDto[];
  @ApiProperty({
    description: '*n aktivitas*: the sum of the rows below — `targets` and every row of `sections`, each code once (UI-052).',
  }) total!: number;
  @ApiProperty({ type: [SectionChipDto], description: 'One per summary tile the reader is shown (ADR-0064) whose sections hold none of the three codes above.' })
  sections!: SectionChipDto[];
}

class SummaryActivityPeriodsDto {
  @ApiProperty({ type: SummaryActivityDto, description: 'This calendar month, against the cascade on `MONTHLY_APE_TARGET`.' }) monthly!: SummaryActivityDto;
  @ApiProperty({ type: SummaryActivityDto, description: 'The year to date, against the cascade on the annual target.' }) yearly!: SummaryActivityDto;
}

class SummaryLeadsDto {
  @ApiProperty({
    type: [LeadResponseDto],
    description: '**Every** open lead of the member’s own, in `GET /leads`’ row shape — `proposals` on the '
      + 'reader’s own rows only — what needs attention first: a dated next action first, the nearest (an overdue one) on '
      + 'top, then the leads with none, the one registered first first, then the id. Empty to a reader whose `lead:read` '
      + 'does not reach the member (roles §3.7): `total` still counts them.',
  }) rows!: LeadResponseDto[];
  @ApiProperty({ description: 'Every open lead of the member’s own.' }) total!: number;
  @ApiProperty({
    example: 5,
    description: '`SUMMARY.LEADS_SHOWN`: how many rows the section shows before *Lihat semua (N)* opens the rest in place (AC-2).',
  }) shown!: number;
  @ApiProperty({
    description: 'The open leads of everybody else the reader’s `lead:read` reaches — what Leads Management lists them '
      + 'besides their own. Counted on the reader’s own summary while `total` is 0; 0 otherwise.',
  }) unitOpen!: number;
}

export class InsightDto {
  @ApiProperty({ enum: INSIGHT_RULES, description: 'The rule that fired — the card names it (ADR-0060).' }) rule!: InsightRule;
  @ApiProperty({ enum: ['action', 'improve'], description: '*What to do next*, or *How you can improve your performance*.' }) kind!: InsightKind;
  @ApiProperty({
    type: 'object', additionalProperties: true,
    description: 'What the rule read. NOTHING_LOGGED: `windowDays`, `lastLoggedOn`. BEHIND_PACE: `closingsLast30Days`, `closingTarget`, '
      + '`neededPerWeek`, `weeksLeft`. LEAD_OVERDUE: `leadId`, `name`, `overdueDays`, `others`. LEAD_NEGLECTED: `leadId`, `name`, '
      + '`others`. RATIO_BELOW, RATIO_STRENGTH: `code`, `label`, `value`, `benchmark`, `displayUnit`.',
  })
  facts!: Record<string, unknown>;
}

class SummaryGoalDto {
  @ApiProperty({ description: 'A goal has been saved for the year. The defaults a first-time reader sees are not one.' }) set!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) savedAt!: string | null;
}

/** Where the page's counts of policies come from (UI-052). */
class SummaryPoliciesDto {
  @ApiProperty({
    enum: ['activity_log'],
    description:
      'Every count of policies on the page — the *Submission polis* chips and the pace sentence’s *closing N* — is the '
      + 'member’s activity log. APE, the gap and *Polis yang dibutuhkan* are the production upload’s (`monthly.source`, '
      + '`yearly.source`). The screen says which (UI-052).',
  }) source!: 'activity_log';
  @ApiProperty({ type: [String], example: ['SELL_SUBMISSION'], description: 'The codes the office binds to *Submission polis*, counted.' })
  codes!: string[];
}

/** The day the page's APE is valid for (UI V1, UI-054): the date header above the goal card. */
class SummaryUploadedOnDto {
  @ApiProperty({
    type: String, nullable: true, format: 'date', example: '2026-10-30',
    description: 'The office’s day its latest production file for `month` was uploaded, in its calendar; `null` while there is none.',
  })
  month!: string | null;
  @ApiProperty({
    type: String, nullable: true, format: 'date', example: '2026-10-30',
    description: 'The office’s day its latest production file of any month of `year`, up to `month`, was uploaded; `null` while there is none.',
  })
  year!: string | null;
}

/** Which period the Summary is for, and which there are (P18.5-T11, ADR-0161 §4). */
class SummaryPeriodDto {
  @ApiProperty({ example: '2025-03', description: 'The office’s first month, `YYYY-MM`, in its zone: the earliest `month` there is, and its year the earliest `year`.' })
  firstMonth!: string;
  @ApiProperty({ example: '2026-09', description: 'The office’s current month, `YYYY-MM`: the latest there is.' })
  thisMonth!: string;
  @ApiProperty({ description: '`month` is the current month: its days run to today, and the pace is said. Otherwise it is read whole, with no pace.' })
  currentMonth!: boolean;
  @ApiProperty({ description: '`year` is the current year: its days run to today. Otherwise it is read whole, to 31 December.' })
  currentYear!: boolean;
}

export class SummaryDto implements SummaryView {
  @ApiProperty({ example: '2026', description: 'The year *Yearly* is about: this one, or the one asked for.' }) year!: string;
  @ApiProperty({ example: '2026-09', description: 'The month *Monthly* is about: this one, the one asked for, or the December of a closed year asked for.' }) month!: string;
  @ApiProperty({ example: '2026-09-28' }) today!: string;
  @ApiProperty({ type: SummaryPeriodDto }) period!: SummaryPeriodDto;
  @ApiProperty({ type: SummaryGoalDto }) goal!: { set: boolean; savedAt: string | null };
  @ApiProperty() caseSizeMinor!: number;

  @ApiProperty({
    type: MonthlyFiguresDto,
    description: '*Monthly* (ADR-0056): `MONTHLY_APE_TARGET` — fixed against this month’s own figure — against this month’s uploaded APE.',
  })
  monthly!: MonthlyFiguresDto;

  @ApiProperty({ type: YearlyFiguresDto, description: '*Yearly*: the annual target against the year to date.' })
  yearly!: YearlyFiguresDto;

  @ApiProperty({
    type: EstimateReplacedDto, nullable: true,
    description: 'The office’s year-to-date figure, written after it, replaced a typed estimate the plan still stores '
      + '(UI-157 item 4, ADR-0195 §3); `null` when nothing was replaced.',
  })
  estimateReplaced!: { uploadedOn: string } | null;

  @ApiProperty({ type: PaceDto, nullable: true, description: 'The pace sentence (ADR-0109); `null` without a goal, and for a month that has ended (ADR-0161).' })
  pace!: Pace | null;

  @ApiProperty({ type: SummaryPoliciesDto, description: 'Where every count of policies on the page comes from: the activity log (UI-052).' })
  policies!: { source: 'activity_log'; codes: string[] };

  @ApiProperty({
    type: SummaryUploadedOnDto,
    description: 'The day the page’s APE is valid for — the latest production upload of the month, and of the year (UI-054).',
  })
  uploadedOn!: { month: string | null; year: string | null };

  @ApiProperty({ type: SummaryActivityPeriodsDto, description: '*Your sales activity targets* and the other sections.' })
  activity!: { monthly: SummaryActivityDto; yearly: SummaryActivityDto };

  @ApiProperty({ type: SummaryLeadsDto, description: '*Leads yang perlu perhatian Anda*: the member’s own open leads.' })
  leads!: { rows: LeadResponseDto[]; total: number; shown: number; unitOpen: number };

  @ApiProperty({ type: [InsightDto], description: 'The insight cards: the rules that fired, in their fixed priority, at most four.' })
  insights!: Insight[];
}
