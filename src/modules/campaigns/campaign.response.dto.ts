import { ApiProperty } from '@nestjs/swagger';
import {
  CAMPAIGN_KINDS, CAMPAIGN_POSTER_COLORS, CAMPAIGN_SUBTYPES, CAMPAIGN_WINDOWS, METRIC_UNITS, QUALIFICATION_RULE_KINDS,
} from '@/domain/constants';

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

/** A campaign requirement, as the Owner's list reads it (P18.5-T8, D-evaluable). */
export class CampaignRequirementDto extends RequirementViewDto {
  @ApiProperty({
    type: Boolean,
    description: 'Whether a campaign can measure it. `false` for one stored before the evaluable set existed: the '
      + 'screen reads it *Not measured yet*.',
  })
  measured!: boolean;
}

/** The card's poster: an emoji and a token colour (D-fields). */
export class CampaignPosterDto {
  @ApiProperty({ type: String })
  emoji!: string;

  @ApiProperty({ enum: CAMPAIGN_POSTER_COLORS, description: 'A design-token name, never a hex.' })
  color!: string;
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

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: '`null`: a structural campaign with no end.' })
  endsAt!: string | null;

  @ApiProperty({
    enum: ['upcoming', 'running', 'ended'],
    description: 'Derived on every read, never stored.',
  })
  phase!: string;

  @ApiProperty({ type: [CampaignRequirementDto] })
  requirements!: CampaignRequirementDto[];

  @ApiProperty({ enum: CAMPAIGN_KINDS })
  kind!: string;

  @ApiProperty({ enum: CAMPAIGN_SUBTYPES, nullable: true })
  subtype!: string | null;

  @ApiProperty({ enum: CAMPAIGN_WINDOWS })
  window!: string;

  @ApiProperty({ type: [String], description: 'Rungs by code. Empty means everybody.' })
  appliesToOrgLevelCodes!: string[];

  @ApiProperty({ type: CampaignPosterDto })
  poster!: CampaignPosterDto;

  @ApiProperty({ type: String })
  blurb!: string;

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

/** One entry of the metric registry, as `GET /metrics` serves it (P5-T9). */
export class MetricDefinitionDto {
  @ApiProperty({ type: String, description: 'The stable key a rule or requirement names.' })
  key!: string;

  @ApiProperty({ type: String, description: 'What a screen calls it. No screen holds a second copy.' })
  name!: string;

  @ApiProperty({
    enum: METRIC_UNITS,
    description: '`idr_minor` is integer sen, never a float and never a display string.',
  })
  unit!: string;

  @ApiProperty({
    type: Number,
    description:
      'The roadmap phase that computes it. No screen shows it: `computed` says whether it is '
      + 'measured by the time campaigns are evaluated, and a phase number is a schedule a customer '
      + 'can do nothing with.',
  })
  phase!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'Whether it is measured by the time campaigns are evaluated. A rule naming one that is not '
      + 'is recorded as waiting on it rather than never passing in silence.',
  })
  computed!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'Whether a **campaign** requirement may name it: a member\'s production over whole '
      + 'months, their logged activity, the five ratios, their unit\'s active agents. The Owner\'s picker offers only '
      + 'these; a carrier rule may name any metric listed here.',
  })
  campaign!: boolean;
}
