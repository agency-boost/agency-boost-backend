import { ApiProperty } from '@nestjs/swagger';
import type { ActivityCategoryView, ActivityTypeView } from './activity.service';
import type { LeadPipelineView, LeadStatusView } from './lead-status.service';
import { LEAD_PIPELINES, type LeadPipeline } from './lead-status.schema';
import type { RatioDefinitionView } from './ratio.service';
import type { TenantConfigView } from './tenant-config.service';
import { RATIO_COMPARISONS, type RatioComparison } from './ratio-definition.schema';

/**
 * The wire shape of one activity type.
 *
 * `implements` the service's view, so the two cannot drift: adding a field to the view
 * without adding it here fails to compile.
 */
export class ActivityTypeDto implements ActivityTypeView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({
    type: String,
    example: 'SELL_SUBMISSION',
    description:
      'The identity. Every activity log, ratio formula and goal target holds this, and '
      + 'nothing can change it — see `tenant-config.md`.',
  })
  code!: string;

  @ApiProperty({ type: String, example: 'SELLING' })
  categoryCode!: string;

  @ApiProperty({ type: String, example: 'Submission polis' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: 'secara mandiri atau melalui BOP' })
  description!: string | null;

  @ApiProperty({
    type: Number,
    example: 6,
    description: 'Presentation only, and reorderable. Nothing reads it back.',
  })
  displayOrder!: number;

  @ApiProperty({
    type: Number,
    example: 1,
    description: 'The domain\'s version, bumped when what the office counts changes. Not a reorder.',
  })
  version!: number;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';
}

export class ActivityCategoryDto implements ActivityCategoryView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'SELLING' })
  code!: string;

  @ApiProperty({ type: String, example: 'Selling' })
  label!: string;

  @ApiProperty({ type: Number, example: 2 })
  displayOrder!: number;

  @ApiProperty({ type: Number, example: 1 })
  version!: number;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';

  @ApiProperty({ type: [ActivityTypeDto] })
  types!: ActivityTypeDto[];
}

export class LeadStatusDto implements LeadStatusView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: LEAD_PIPELINES })
  pipeline!: LeadPipeline;

  @ApiProperty({
    type: String,
    example: 'PAID_AND_ISSUED',
    description: 'What every lead holds. Renaming the label leaves this alone.',
  })
  code!: string;

  @ApiProperty({ type: String, example: 'Paid and issued' })
  label!: string;

  @ApiProperty({ type: Number, example: 5, description: 'Order within its pipeline. Reorderable.' })
  rank!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'The stage that closes this pipeline, and what gates marking a lead successful. '
      + 'Exactly one per pipeline — a property, not "the last one in the list".',
  })
  isTerminal!: boolean;

  @ApiProperty({ type: Number })
  version!: number;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';
}

export class LeadPipelineDto implements LeadPipelineView {
  @ApiProperty({ enum: LEAD_PIPELINES })
  pipeline!: LeadPipeline;

  @ApiProperty({ type: [LeadStatusDto] })
  statuses!: LeadStatusDto[];
}

export class RatioDefinitionDto implements RatioDefinitionView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'SELLING_SUCCESS_RATE' })
  code!: string;

  @ApiProperty({ type: String, example: 'Selling success rate' })
  label!: string;

  @ApiProperty({
    type: [String],
    example: ['SELL_SUBMISSION'],
    description: 'Activity type codes, summed. Never the prototype\'s item numbers.',
  })
  numerator!: string[];

  @ApiProperty({ type: [String], example: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'] })
  denominator!: string[];

  @ApiProperty({ type: Number, example: 0.15, description: 'The office\'s own value.' })
  benchmark!: number;

  @ApiProperty({ enum: RATIO_COMPARISONS })
  comparison!: RatioComparison;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ type: Number })
  version!: number;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';
}

/** Everything an agent surface needs, in one round trip (P4-T7). */
export class TenantConfigDto implements TenantConfigView {
  @ApiProperty({ type: [ActivityCategoryDto] })
  activity!: ActivityCategoryDto[];

  @ApiProperty({ type: [RatioDefinitionDto] })
  ratios!: RatioDefinitionDto[];

  @ApiProperty({ type: [LeadPipelineDto] })
  leadPipelines!: LeadPipelineDto[];

  @ApiProperty({
    type: Number,
    description:
      'The highest version across everything above — one number to compare rather than '
      + 'three collections to reason about. It moves when what the office counts changes, '
      + 'and not on a reorder, because a reorder rebinds nothing.',
  })
  version!: number;
}
