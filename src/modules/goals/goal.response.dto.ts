import { ApiProperty } from '@nestjs/swagger';
import { GOAL_MODES } from './goal.schema';
import type { CascadeResult } from './goal-cascade';
import type { GoalHistoryEntry, GoalSnapshotView, GoalView } from './goal.service';

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

  @ApiProperty({ type: Number })
  apeAchievedMinor!: number;

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

export class GoalHistoryEntryDto implements GoalHistoryEntry {
  @ApiProperty({ type: Number, description: 'The version this plan was.' })
  version!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  at!: string | null;

  @ApiProperty({ type: String, nullable: true })
  byMembershipId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '`null` when the membership resolves to nobody — somebody who has left the office.',
  })
  byName!: string | null;

  @ApiProperty({ enum: GOAL_MODES })
  mode!: 'direct' | 'from_savings';

  @ApiProperty({ type: Number })
  annualApeTargetMinor!: number;

  @ApiProperty({ type: Number })
  savingsTargetMinor!: number;

  @ApiProperty({ type: Number })
  commissionRatePct!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'The agent’s own figure, or `null`.' })
  monthsLeftOverride!: number | null;

  @ApiProperty({ type: Number })
  apeAchievedMinor!: number;

  @ApiProperty({ type: Number })
  caseSizeMinor!: number;

  @ApiProperty({ type: Number })
  leadsToApptPct!: number;

  @ApiProperty({ type: Number })
  closingRatePct!: number;

  @ApiProperty({ type: GoalSnapshotDto, description: 'What that plan was agreed to mean.' })
  snapshot!: GoalSnapshotView;
}
