import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { field } from '@/common/validation/violations';
import { AB_GROUP_TARGETS } from '@/domain/constants';
import type {
  AbGroupTargetGroup, AbGroupTargetRow, AbGroupTargetsView, AbGroupTargetTotals,
} from './ab-group-targets.service';
import { AB_GROUP_TARGET_REFUSALS } from './ab-group-targets.messages';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthShape = { message: field(AB_GROUP_TARGET_REFUSALS.VALIDATION_FAILED.monthShape) };

/** `GET /kpm/ab-group-targets?month=`: the month to read; absent, the office's. */
export class AbGroupTargetsQueryDto {
  @ApiPropertyOptional({ example: '2026-11', description: '`YYYY-MM`. Absent: the office’s month.' })
  @IsOptional()
  @Matches(MONTH, monthShape)
  month?: string;
}

/** **The target dialog's *Simpan***: one AB group's two targets for one month (ADR-0270 §4). */
export class SetAbGroupTargetDto {
  @ApiProperty({ example: '2026-11', description: '`YYYY-MM`, from January 2024 to a year after the office’s month.' })
  @Matches(MONTH, monthShape)
  month!: string;

  @ApiProperty({ minimum: 0, maximum: AB_GROUP_TARGETS.MAX, example: 6, description: '*Target Active Agent per bulan*.' })
  @IsInt()
  @Min(0)
  @Max(AB_GROUP_TARGETS.MAX)
  activeAgentTarget!: number;

  @ApiProperty({ minimum: 0, maximum: AB_GROUP_TARGETS.MAX, example: 3, description: '*Target Rekrut per bulan*.' })
  @IsInt()
  @Min(0)
  @Max(AB_GROUP_TARGETS.MAX)
  rekrutTarget!: number;
}

class AbGroupTargetRowDto implements AbGroupTargetRow {
  @ApiProperty() abMembershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) agentCode!: string | null;
  @ApiProperty() isGroupLeader!: boolean;
  @ApiProperty({ description: 'The AB group, the AB included, test accounts not counted.' }) people!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`null`: *Belum ada target*.' }) activeAgentTarget!: number | null;
  @ApiProperty({ type: Number, nullable: true }) rekrutTarget!: number | null;
  @ApiProperty({ enum: ['set', 'carried', 'none'], description: 'Saved for this month, carried from an earlier one, or none.' })
  source!: 'set' | 'carried' | 'none';
  @ApiProperty({ type: String, nullable: true, description: 'The month the targets were saved for.' }) fromMonth!: string | null;
  @ApiProperty({ description: 'January to this month, each month’s Rekrut target.' }) rekrutYtdTarget!: number;
  @ApiProperty({ description: 'The members’ Goal Setting for the year ÷ 12, in sen. Not editable here.' }) apeTargetMinor!: number;
  @ApiProperty({ description: 'Members with a saved Goal Setting target above zero.' }) goalsSet!: number;
}

class AbGroupTargetTotalsDto implements AbGroupTargetTotals {
  @ApiProperty() activeAgentTarget!: number;
  @ApiProperty() rekrutTarget!: number;
  @ApiProperty() rekrutYtdTarget!: number;
  @ApiProperty() apeTargetMinor!: number;
  @ApiProperty({ description: 'AB groups with no target: the sums are over the others.' }) unset!: number;
  @ApiProperty() abGroups!: number;
  @ApiProperty() people!: number;
}

class KpmTargetTotalsDto extends AbGroupTargetTotalsDto {
  @ApiProperty({ description: 'Active members under no AB: their Goal Setting is in the KPM’s APE target.' })
  unplacedPeople!: number;
}

class TargetGroupRefDto {
  @ApiProperty() groupId!: string;
  @ApiProperty() name!: string;
}

class TargetGroupLeaderDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() name!: string;
}

class AbGroupTargetGroupDto implements AbGroupTargetGroup {
  @ApiProperty({ type: TargetGroupRefDto, nullable: true, description: '`null`: *Tanpa group*.' }) group!: TargetGroupRefDto | null;
  @ApiProperty({ type: [TargetGroupLeaderDto] }) leaders!: TargetGroupLeaderDto[];
  @ApiProperty({ type: AbGroupTargetTotalsDto }) totals!: AbGroupTargetTotalsDto;
  @ApiProperty({ type: [AbGroupTargetRowDto] }) abGroups!: AbGroupTargetRowDto[];
}

/** **`GET /kpm/ab-group-targets`, and what a save answers.** */
export class AbGroupTargetsViewDto implements AbGroupTargetsView {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ example: '2026-11' }) currentMonth!: string;
  @ApiProperty({ example: '2024-01' }) earliestMonth!: string;
  @ApiProperty({ example: '2027-11' }) latestMonth!: string;
  @ApiProperty({ example: 999 }) max!: number;
  @ApiProperty({ example: 'IDR' }) currency!: string;
  @ApiProperty({ type: KpmTargetTotalsDto, description: '*Total KPM*.' }) total!: KpmTargetTotalsDto;
  @ApiProperty({ type: [AbGroupTargetGroupDto], description: 'The informal groups A to Z, then *Tanpa group*.' })
  groups!: AbGroupTargetGroupDto[];
  @ApiProperty() canWrite!: boolean;
}
