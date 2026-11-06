import { ApiProperty } from '@nestjs/swagger';
import {
  CAMPAIGN_KINDS, CAMPAIGN_POSTER_COLORS, CAMPAIGN_SUBTYPES, CAMPAIGN_WINDOWS, METRIC_UNITS, REQUIREMENT_COMPARATORS,
  type CampaignPosterColor,
} from '@/domain/constants';
import type {
  AgentRequirementView, CampaignCardView, CampaignDetailView, CampaignListView, ChasedCampaignView, ChasingView,
  ProgressRowView,
} from './campaign-agent.service';

/** The card's poster: an emoji and a design-token colour name (P18.2-T7, D-fields). */
export class AgentCampaignPosterDto {
  @ApiProperty({ type: String, description: 'One emoji. Decorative: the screen hides it from assistive technology.' })
  emoji!: string;

  @ApiProperty({ enum: CAMPAIGN_POSTER_COLORS, description: 'A design-token name, never a hex.' })
  color!: CampaignPosterColor;
}

export class AgentCampaignRequirementDto implements AgentRequirementView {
  @ApiProperty({ type: String })
  metricKey!: string;

  @ApiProperty({ type: String, description: 'The registry’s name, so no screen holds a second copy.' })
  metricName!: string;

  @ApiProperty({ enum: REQUIREMENT_COMPARATORS })
  comparator!: string;

  @ApiProperty({ type: Number, description: 'Integer sen when `unit` is `idr_minor`; the screen prints rupiah.' })
  value!: number;

  @ApiProperty({ enum: METRIC_UNITS })
  unit!: AgentRequirementView['unit'];

  @ApiProperty({
    type: Boolean,
    description: '`false`: a requirement no campaign can measure, stored before the evaluable set existed — *Not measured yet*.',
  })
  measured!: boolean;
}

export class CampaignCardDto implements CampaignCardView {
  @ApiProperty({ type: String, description: 'The stable code: the address `/campaigns/{code}`.' })
  code!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ enum: CAMPAIGN_KINDS })
  kind!: CampaignCardView['kind'];

  @ApiProperty({ enum: CAMPAIGN_SUBTYPES, nullable: true, description: '*Promotion Criteria* or *Production Clubs*; `null` when seasonal.' })
  subtype!: CampaignCardView['subtype'];

  @ApiProperty({ enum: CAMPAIGN_WINDOWS })
  window!: CampaignCardView['window'];

  @ApiProperty({
    enum: ['upcoming', 'running', 'ended'],
    description: 'Derived now from its dates. A structural campaign with no end, once begun, is `running` — its card reads *Ongoing*.',
  })
  phase!: CampaignCardView['phase'];

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endsAt!: string | null;

  @ApiProperty({
    type: String,
    description: 'Composed in the office’s calendar — *1 Jul – 30 Sep 2026* — or the window’s own words: *Rolling '
      + '12-month window*, *Standing — evaluated per calendar year (1 Jan – 31 Des)*.',
  })
  duration!: string;

  @ApiProperty({ type: AgentCampaignPosterDto })
  poster!: AgentCampaignPosterDto;

  @ApiProperty({ type: String, description: 'Plain text: render it as text, never markup.' })
  blurb!: string;

  @ApiProperty({ type: String, description: 'The prize line. Plain text.' })
  reward!: string;

  @ApiProperty({ type: [AgentCampaignRequirementDto] })
  requirements!: AgentCampaignRequirementDto[];

  @ApiProperty({ type: Boolean, description: 'The reader is chasing it.' })
  chasing!: boolean;

  @ApiProperty({ type: Boolean, description: 'The reader’s rung is one it applies to (or it applies to everybody).' })
  eligible!: boolean;

  @ApiProperty({
    enum: ['ended', 'not_eligible'],
    nullable: true,
    description: 'Why the chase control is disabled: the campaign has ended, or it is not open to the reader’s role. `null` when it is live.',
  })
  chaseBlocked!: CampaignCardView['chaseBlocked'];
}

export class CampaignCanDto {
  @ApiProperty({
    type: Boolean,
    description: 'The reader may chase at all — `false` in a read-only support session, which draws no chase control.',
  })
  chase!: boolean;
}

export class CampaignListDto implements CampaignListView {
  @ApiProperty({
    type: [CampaignCardDto],
    description: 'In order: seasonal running (ending soonest first), upcoming (starting soonest first), ended (latest '
      + 'first); then structural by title.',
  })
  campaigns!: CampaignCardDto[];

  @ApiProperty({ type: CampaignCanDto })
  can!: CampaignCanDto;
}

export class CampaignProgressRowDto implements ProgressRowView {
  @ApiProperty({ type: String })
  metricKey!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Over the window: sen for money, 0–100 for persistency, the ratio card’s value for a ratio. `null` when nothing is held.',
  })
  current!: number | null;

  @ApiProperty({ type: Number })
  target!: number;

  @ApiProperty({ enum: METRIC_UNITS })
  unit!: ProgressRowView['unit'];

  @ApiProperty({
    enum: ['met', 'in_progress', 'not_met', 'not_uploaded', 'nothing_logged', 'not_measured'],
    description: '`met` — *"{current} of {target}"* with ✓; `in_progress` and `not_met` — *"{current} of {target}"*; '
      + '`not_uploaded` — *Not uploaded yet*, never ✕; `nothing_logged` — an activity requirement with nothing logged, '
      + '*Nothing logged yet*; `not_measured` — *Not measured yet*.',
  })
  state!: ProgressRowView['state'];
}

export class CampaignProgressDto {
  @ApiProperty({ type: String, description: 'The months or days read: *Jul – Sep 2026*, *Okt 2025 – Sep 2026*.' })
  windowLabel!: string;

  @ApiProperty({ type: Boolean, description: 'The result is final: the last month it reads has locked, and it no longer moves.' })
  final!: boolean;

  @ApiProperty({ type: [CampaignProgressRowDto] })
  rows!: CampaignProgressRowDto[];
}

export class CampaignDetailDto extends CampaignCardDto implements CampaignDetailView {
  @ApiProperty({ type: String, description: 'Plain text.' })
  description!: string;

  @ApiProperty({ type: CampaignCanDto })
  can!: CampaignCanDto;

  @ApiProperty({
    type: CampaignProgressDto,
    nullable: true,
    description: 'The reader’s progress, one row per requirement, in the order of `requirements`. `null` while upcoming.',
  })
  progress!: CampaignProgressDto | null;
}

export class ChasedCampaignDto implements ChasedCampaignView {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ enum: CAMPAIGN_KINDS })
  kind!: ChasedCampaignView['kind'];

  @ApiProperty({ enum: CAMPAIGN_SUBTYPES, nullable: true })
  subtype!: ChasedCampaignView['subtype'];

  @ApiProperty({ enum: ['upcoming', 'running'], description: 'Never ended: an ended campaign leaves every chasing list.' })
  phase!: ChasedCampaignView['phase'];

  @ApiProperty({ type: String })
  duration!: string;

  @ApiProperty({
    type: String,
    example: 'Runs Jan – Des',
    description: 'The months it runs, composed in the office’s calendar — the Personal Summary row’s line: *Runs Jan – '
      + 'Des* for a calendar year, *Runs Agu – Okt 2026* for its own dates (*Runs from Okt 2026* with no end), *Runs over '
      + 'the last 12 months* for the rolling window.',
  })
  runs!: string;

  @ApiProperty({ type: AgentCampaignPosterDto })
  poster!: AgentCampaignPosterDto;
}

export class ChasingDto implements ChasingView {
  @ApiProperty({ type: String, description: 'Whose chases these are.' })
  membershipId!: string;

  @ApiProperty({ type: [ChasedCampaignDto] })
  campaigns!: ChasedCampaignDto[];
}
