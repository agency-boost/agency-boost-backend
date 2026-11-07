import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GOAL_MODES } from './goal.schema';
import type { CascadeResult } from './goal-cascade';
import type { GoalAchieved, GoalMeasured, GoalOfficial, GoalPreview, GoalSnapshotView, GoalTypist, GoalView } from './goal.service';

export class GoalMeasuredDto implements GoalMeasured {
  @ApiProperty({ example: '2026-08-30' }) from!: string;
  @ApiProperty({ example: '2026-09-28' }) to!: string;
  @ApiProperty({ example: 30, description: '`ROLLING_30D` — the ratio window, fixed (ADR-0022).' }) days!: number;

  @ApiProperty({
    type: Number, nullable: true, example: 0.25,
    description: '`MEASURED_LEAD_TO_APPOINTMENT_RATE` (ADR-0055): the goal’s appointments code ÷ its leads code, '
      + 'as a proportion. **`null` is not enough data** — nothing to divide by — never 0.',
  })
  leadToAppointmentRate!: number | null;

  @ApiProperty({
    type: Number, nullable: true, example: 0.2,
    description: '`MEASURED_CLOSING_RATE` (ADR-0055): the goal’s closings code ÷ its appointments code. `null` is not enough data.',
  })
  closingRate!: number | null;
}

/** Somebody who typed a member's figure for them (S2). */
export class GoalTypistDto implements GoalTypist {
  @ApiProperty({ description: 'The membership: the person in this office, never their account.' }) membershipId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Sari Puspita', description: '`null` when they can no longer be named.' })
  name!: string | null;
}

export class GoalAchievedDto implements GoalAchieved {
  @ApiProperty({ type: Number, description: 'The APE `projected` is computed from, in IDR minor units.' })
  minor!: number;

  @ApiProperty({
    enum: ['imported', 'corrected', 'self_reported'],
    description: 'The carrier’s file, a correction by hand, or a figure **typed in the app, not uploaded** — by the member, or by whoever coaches them (ADR-0183; `typedBy`). On the member’s own plan **the newer of the typed figure and the office’s year to date** (ADR-0230 §6): a figure typed after the office last wrote the year, until an import or a correction written after it. On a leader’s or the office’s reads the office’s figure whenever it holds one.',
  })
  provenance!: 'imported' | 'corrected' | 'self_reported';

  @ApiProperty({ type: String, nullable: true, example: '2026-08', description: 'The month whose year-to-date figure it is; `null` for the agent’s own.' })
  month!: string | null;

  @ApiPropertyOptional({
    type: GoalTypistDto,
    description: 'Who typed a `self_reported` figure, **when it was not the member** — a coach (S2). Absent when the member typed it, and on the office’s own figure.',
  })
  typedBy?: GoalTypistDto;
}

/** **The office's own year to date** (P19.8-T5; ADR-0230 §1, §4): Goal Settings' automatic figure, whichever is in force. */
export class GoalOfficialDto implements GoalOfficial {
  @ApiProperty({ type: Number, description: 'The office’s year to date for the plan’s year, in IDR minor units.' })
  minor!: number;

  @ApiProperty({ enum: ['imported', 'corrected'], description: 'The carrier’s file, or a correction by hand.' })
  provenance!: 'imported' | 'corrected';

  @ApiProperty({ type: String, example: '2026-10', description: 'The latest month the year to date reads: *⚡ Otomatis · per Okt 2026*.' })
  month!: string;
}

export class GoalSnapshotDto implements GoalSnapshotView {
  @ApiProperty({ type: Number })
  monthlyApeTargetMinor!: number;

  @ApiProperty({ type: Number })
  policiesPerMonth!: number;

  @ApiProperty({ type: Number })
  appointmentsPerMonth!: number;

  @ApiProperty({ type: Number })
  leadsPerMonth!: number;
}

export class GoalProjectionDto implements CascadeResult {
  @ApiProperty({ type: Number })
  annualApeTargetMinor!: number;

  @ApiProperty({ type: Number })
  apeAchievedMinor!: number;

  @ApiProperty({ type: Number, description: '`max(0, target − achieved)`. Never negative.' })
  remainingApeMinor!: number;

  @ApiProperty({ type: Number })
  monthlyApeTargetMinor!: number;

  @ApiProperty({ type: Number })
  policiesPerMonth!: number;

  @ApiProperty({
    type: Number,
    description: 'Steps 3 and 5’s `≈ n/week`: `policiesPerMonth` ÷ 4.33 to **one decimal**, a whole figure '
      + 'whole — `1.4` for six a month (ADR-0160 §5).',
  })
  policiesPerWeek!: number;

  @ApiProperty({ type: Number })
  appointmentsPerMonth!: number;

  @ApiProperty({ type: Number, description: 'The `≈ n/week` sub-line: ÷ 4.33, rounded up, a whole count.' })
  appointmentsPerWeek!: number;

  @ApiProperty({ type: Number })
  leadsPerMonth!: number;

  @ApiProperty({ type: Number, description: 'The `≈ n/week` sub-line: ÷ 4.33, rounded up, a whole count.' })
  leadsPerWeek!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'The annual target is reached, so every figure above is zero (ADR-0047). The screen replaces '
      + 'the cascade with a sentence rather than printing *contact 0 leads* to the best producer '
      + 'in the office.',
  })
  targetMet!: boolean;
}

export class GoalCascadeMappingDto {
  @ApiProperty({ type: String, example: 'LEADS_CONTACTED' })
  leadsCode!: string;

  @ApiProperty({ type: String, example: 'SELL_PRESENTATION' })
  appointmentsCode!: string;

  @ApiProperty({ type: String, example: 'SELL_SUBMISSION' })
  closingsCode!: string;
}

/** The office's activity binding as the plan's columns count it: each role a list of codes, summed. */
export class GoalCascadeBindingDto {
  @ApiProperty({ type: [String], example: ['LEADS_CONTACTED'], description: '*Set appointment*.' })
  leads!: string[];

  @ApiProperty({ type: [String], example: ['SELL_PRESENTATION'], description: '*Sales meeting*.' })
  appointments!: string[];

  @ApiProperty({ type: [String], example: ['SELL_SUBMISSION'], description: '*Submission polis*.' })
  closings!: string[];
}

export class GoalResponseDto implements Omit<GoalView, 'id' | 'membershipId' | 'version'> {
  @ApiProperty({ type: String, example: '2026' })
  period!: string;

  @ApiProperty({ enum: GOAL_MODES })
  mode!: 'direct' | 'from_savings';

  @ApiProperty({ type: Number })
  annualApeTargetMinor!: number;

  @ApiProperty({ type: Number })
  savingsTargetMinor!: number;

  @ApiProperty({ type: Number })
  commissionRatePct!: number;

  @ApiProperty({
    type: Number,
    description:
      'The divisor **in force**, derived on every read from the office’s calendar unless the agent '
      + 'overrode it. Never served from storage: a plan saved in January would otherwise still '
      + 'claim eleven months left in October (client PRD §17).',
  })
  monthsLeft!: number;

  @ApiProperty({
    type: Boolean,
    description: 'Whether the figure above is the agent’s own choice or the office’s calendar.',
  })
  monthsLeftIsOverride!: boolean;

  @ApiProperty({ type: Number, description: 'The typed figure — the agent’s, or a coach’s while the office held none (ADR-0183) — kept, and used while it is newer than the office’s year to date (ADR-0230 §6). 0 is nothing typed.' })
  apeAchievedMinor!: number;

  @ApiProperty({ type: GoalAchievedDto, description: 'The figure the plan is measured against, and whose it is.' })
  achieved!: GoalAchievedDto;

  @ApiProperty({
    type: GoalOfficialDto, nullable: true,
    description: '**The office’s own year to date for the year, whichever figure is in force** (ADR-0230 §4): what Goal '
      + 'Settings prefills as *⚡ Otomatis · per {month}* and puts back with *Pakai otomatis*. `null` while the office holds none.',
  })
  official!: GoalOfficialDto | null;

  @ApiProperty({ type: Number })
  caseSizeMinor!: number;

  @ApiProperty({
    type: Number,
    description: '*Appointment to Sales meeting*, a percentage. Unsaved, the office’s *Set appointment to meeting* '
      + 'benchmark, or 30 (ADR-0160 §3).',
  })
  leadsToApptPct!: number;

  @ApiProperty({
    type: Number,
    description: '*Closing rate*, a percentage. Unsaved, the office’s *Selling success rate* benchmark, or 30 '
      + '(ADR-0160 §3).',
  })
  closingRatePct!: number;

  @ApiProperty({
    type: GoalSnapshotDto,
    description:
      'What was agreed, frozen at save time. **Never a display source** — `projected` is what a '
      + 'screen renders, because `monthsLeft` shrinks every day.',
  })
  snapshot!: GoalSnapshotView;

  @ApiProperty({
    type: GoalProjectionDto,
    nullable: true,
    description:
      'What the inputs mean **today**, recomputed on every read. `null` when the stored inputs '
      + 'cannot produce a plan: a write refuses that by name, and a read must not, or a goal saved '
      + 'before the rule would lock its agent out of the screen that could fix it.',
  })
  projected!: CascadeResult | null;

  @ApiProperty({
    type: GoalCascadeMappingDto,
    description: 'Activity **codes**, never positions: the first code of each role in the office’s binding when the '
      + 'plan was first saved, kept as its record and never rewritten. Nothing counts from it — see `cascadeBinding`.',
  })
  cascadeMapping!: { leadsCode: string; appointmentsCode: string; closingsCode: string };

  @ApiProperty({
    type: GoalCascadeBindingDto,
    description: 'What the three columns count today: the office’s activity binding, each role a list of codes, '
      + 'summed. The *Activity #n* chips are drawn from it.',
  })
  cascadeBinding!: { leads: string[]; appointments: string[]; closings: string[] };

  @ApiProperty({
    type: GoalMeasuredDto,
    nullable: true,
    description: 'Your own conversion rates over the last 30 days, over the office’s cascade binding — '
      + 'printed under the assumptions they measure. Read only: nothing is filled in (ADR-0048, ADR-0055). '
      + '**`null` on anybody else’s plan**: reading or saving somebody else’s goal answers no rate from '
      + 'their log.',
  })
  measured!: GoalMeasured | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  savedAt!: string | null;

  @ApiProperty({
    type: String, format: 'date-time', nullable: true,
    description: 'When `apeAchievedMinor` last changed — a save that changed it, or the member’s own estimate '
      + '(ADR-0195 §3). `null` on a plan from before it was recorded, and on the office’s defaults.',
  })
  apeAchievedTypedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Who saved it. Differing from the goal’s own membership is a leader’s goal-setting — two '
      + 'columns, no flag (ADR-0046).',
  })
  savedByMembershipId!: string | null;
}

/**
 * **`POST /goals/:period/preview`** (P18.11-T5, UI V1 UI-014): what the inputs a screen holds would mean, worked out
 * by the formula a save uses and written nowhere — the months in force, the APE produced the plan is measured
 * against, and the cascade.
 */
export class GoalPreviewDto implements GoalPreview {
  @ApiProperty({ type: String, example: '2026' })
  period!: string;

  @ApiProperty({ type: Number, example: 2.1, description: 'The divisor in force: the typed one, or the office’s calendar.' })
  monthsLeft!: number;

  @ApiProperty({ type: Boolean, description: 'Whether `monthsLeft` was typed over (`true`) or is the office’s calendar.' })
  monthsLeftIsOverride!: boolean;

  @ApiProperty({
    type: GoalAchievedDto,
    description: 'The APE the plan is measured against: the newer of the typed figure and the office’s year to date '
      + '(ADR-0230 §6) — a figure you type on your own plan is typed now, so it is the answer; on anybody else’s the '
      + 'figure typed while the office holds none, else the member’s stored one by the same rule.',
  })
  achieved!: GoalAchievedDto;

  @ApiProperty({
    type: GoalProjectionDto,
    nullable: true,
    description: 'The cascade, as a save would store it. `null` when the inputs cannot make a plan — a save refuses '
      + 'that with `GOAL_INVALID_ASSUMPTION`.',
  })
  projected!: CascadeResult | null;
}
