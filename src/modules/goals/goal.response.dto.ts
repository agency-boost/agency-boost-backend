import { ApiProperty } from '@nestjs/swagger';
import { GOAL_MODES } from './goal.schema';
import type { CascadeResult } from './goal-cascade';
import type { GoalAchieved, GoalMeasured, GoalSnapshotView, GoalView } from './goal.service';

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

export class GoalAchievedDto implements GoalAchieved {
  @ApiProperty({ type: Number, description: 'The APE `projected` is computed from, in IDR minor units.' })
  minor!: number;

  @ApiProperty({
    enum: ['imported', 'corrected', 'self_reported'],
    description: 'The carrier’s file, a correction by hand, or the agent’s own typed figure — the last only while the office holds no year-to-date figure for the year.',
  })
  provenance!: 'imported' | 'corrected' | 'self_reported';

  @ApiProperty({ type: String, nullable: true, example: '2026-08', description: 'The month whose year-to-date figure it is; `null` for the agent’s own.' })
  month!: string | null;
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

  @ApiProperty({ type: Number, description: 'The screen’s `≈ n/week` sub-line. Ceil, like every step.' })
  policiesPerWeek!: number;

  @ApiProperty({ type: Number })
  appointmentsPerMonth!: number;

  @ApiProperty({ type: Number })
  appointmentsPerWeek!: number;

  @ApiProperty({ type: Number })
  leadsPerMonth!: number;

  @ApiProperty({ type: Number })
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

  @ApiProperty({ type: Number, description: 'The agent’s own typed figure — kept, and used only until production arrives.' })
  apeAchievedMinor!: number;

  @ApiProperty({ type: GoalAchievedDto, description: 'The figure the plan is measured against, and whose it is.' })
  achieved!: GoalAchievedDto;

  @ApiProperty({ type: Number })
  caseSizeMinor!: number;

  @ApiProperty({ type: Number })
  leadsToApptPct!: number;

  @ApiProperty({ type: Number })
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

  @ApiProperty({ type: GoalCascadeMappingDto, description: 'Activity **codes**, never positions.' })
  cascadeMapping!: { leadsCode: string; appointmentsCode: string; closingsCode: string };

  @ApiProperty({
    type: GoalMeasuredDto,
    description: 'The subject’s own conversion rates over the last 30 days, over **this goal’s** cascade codes — '
      + 'printed under the assumptions they measure. Read only: nothing is filled in (ADR-0048, ADR-0055).',
  })
  measured!: GoalMeasured;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  savedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Who saved it. Differing from the goal’s own membership is a leader’s goal-setting — two '
      + 'columns, no flag (ADR-0046).',
  })
  savedByMembershipId!: string | null;
}
