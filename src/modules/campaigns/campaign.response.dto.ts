import { ApiProperty } from '@nestjs/swagger';
import { QUALIFICATION_RULE_KINDS } from '@/domain/constants';

export class RequirementViewDto {
  @ApiProperty({ type: String })
  metricKey!: string;

  @ApiProperty({ type: String, description: 'The registry’s own name, so no screen holds a second copy.' })
  metricName!: string;

  @ApiProperty({ type: String })
  comparator!: string;

  @ApiProperty({ type: Number })
  value!: number;

  @ApiProperty({ type: String, description: '`idr_minor` means integer sen.' })
  unit!: string;
}

export class CampaignDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  description!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: string;

  @ApiProperty({
    enum: ['upcoming', 'running', 'ended'],
    description: 'Derived on every read, never stored.',
  })
  phase!: string;

  @ApiProperty({ type: [RequirementViewDto] })
  requirements!: RequirementViewDto[];

  @ApiProperty({ type: String })
  reward!: string;

  @ApiProperty({ enum: ['active', 'archived'] })
  status!: string;

  @ApiProperty({ type: Number })
  version!: number;
}

export class CriteriaGroupDto {
  @ApiProperty({ enum: ['all', 'any'] })
  mode!: string;

  @ApiProperty({ type: [RequirementViewDto] })
  criteria!: RequirementViewDto[];
}

export class QualificationRuleDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: QUALIFICATION_RULE_KINDS })
  kind!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: [String], description: 'Rungs by code. Empty means everybody.' })
  appliesToOrgLevelCodes!: string[];

  @ApiProperty({ type: [CriteriaGroupDto] })
  criteriaGroups!: CriteriaGroupDto[];

  @ApiProperty({ enum: ['all', 'any'] })
  groupMode!: string;

  @ApiProperty({ type: String })
  reward!: string;

  @ApiProperty({ type: Number })
  rank!: number;

  @ApiProperty({
    type: [String],
    description:
      'Metric keys the registry does not define yet. A rule with any of these can never pass, and '
      + 'the screen says so rather than showing it as an ordinary rule.',
  })
  waitingOnMetrics!: string[];
}
