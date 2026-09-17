import { ApiProperty } from '@nestjs/swagger';
import { RATIO_DISPLAY_UNITS, type RatioDisplayUnit } from '@/domain/constants';
import type { ActivityCategoryView, ActivityTypeView } from './activity.service';
import type { LeadPipelineView, LeadStatusView } from './lead-status.service';
import { LEAD_PIPELINES, type LeadPipeline } from './lead-status.schema';
import { RATIO_ORIGINS, type RatioOrigin } from './ratio-definition.schema';
import type { RatioDefinitionView } from './ratio.service';
import type { PublishState, TenantConfigView } from './tenant-config.service';
import type { TemplateView } from './template.service';
import { TEMPLATE_KINDS, type TemplateKind } from './company-template.schema';
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
    type: [String],
    example: ['AB', 'AAB'],
    description:
      'The rungs that may log this, **inherited from its category and never stored here**. '
      + 'Empty means every rung.',
  })
  appliesToOrgLevelCodes!: string[];

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

  @ApiProperty({ type: String, nullable: true, example: 'What the office sells, and to whom' })
  description!: string | null;

  @ApiProperty({
    type: [String],
    example: ['AB', 'AAB'],
    description:
      'The rungs this section is a question for. **Empty means every rung**, and it '
      + 'cascades to every type inside — a type has no applicability of its own.',
  })
  appliesToOrgLevelCodes!: string[];

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

  @ApiProperty({
    enum: RATIO_ORIGINS,
    description:
      '`platform` rows were provisioned \u2014 their numerator and denominator are fixed so '
      + 'that two offices\u2019 figures mean the same thing. `office` rows are the office\u2019s '
      + 'own and free in every respect.',
  })
  origin!: RatioOrigin;

  @ApiProperty({
    type: [String],
    example: ['AB', 'AAB'],
    description: 'Ladder rung codes. **Empty means every rung.**',
  })
  appliesToOrgLevelCodes!: string[];

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'The formula this office was provisioned with (ADR-0024), or `null` on a ratio it '
      + 'created. What a divergence is measured against, and what the screen shows an Owner '
      + 'they moved away from.',
  })
  standardNumerator!: string[] | null;

  @ApiProperty({ type: [String], nullable: true })
  standardDenominator!: string[] | null;

  @ApiProperty({
    type: Boolean,
    description:
      'The formula no longer matches what this office was seeded from (ADR-0024). A display '
      + 'and support caveat: nothing is excluded from any comparison on account of it, '
      + 'because a platform comparison computes the seeded formula rather than reading this '
      + 'row.',
  })
  divergesFromStandard!: boolean;

  @ApiProperty({ enum: RATIO_COMPARISONS })
  comparison!: RatioComparison;

  @ApiProperty({
    enum: RATIO_DISPLAY_UNITS,
    description:
      'How to write `benchmark` for a reader. `percent`: × 100 to one decimal (15.0%). '
      + '`decimal`: two decimals (0.30). `points`: ± percentage points (±30 points). Always '
      + '`points` on a `band` ratio.',
  })
  displayUnit!: RatioDisplayUnit;

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

/** A company's KPM template, as a Super Admin sees it (P4-T8, ADR-0018). */
export class CompanyTemplateDto implements TemplateView {
  @ApiProperty({ type: String, description: 'Empty when nothing has been saved yet.' })
  id!: string;

  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ enum: TEMPLATE_KINDS })
  kind!: TemplateKind;

  @ApiProperty({ type: Number, description: 'The version this is, or will be once published.' })
  version!: number;

  @ApiProperty({ type: String, enum: ['draft', 'published', 'archived'] })
  status!: 'draft' | 'published' | 'archived';

  @ApiProperty({ type: Object, description: 'Shape depends on `kind`.' })
  payload!: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true })
  publishedAt!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'What new offices are seeded from today. Null when nothing is published.',
  })
  publishedVersion!: number | null;

  @ApiProperty({
    type: Number,
    description:
      'How many of this company\'s offices were built from something older — including '
      + 'those built before anything was published at all.',
  })
  officesBehind!: number;
}

/** Whether the office has edited anything since agents last had a copy (P4-T6). */
export class PublishStateDto implements PublishState {
  @ApiProperty({ type: Number, description: 'What agents are on. 0 when nothing is published.' })
  publishedVersion!: number;

  @ApiProperty({ type: Number, description: 'The highest live row version.' })
  workingVersion!: number;

  @ApiProperty({ type: Boolean })
  hasUnpublishedChanges!: boolean;

  @ApiProperty({ type: String, nullable: true })
  publishedAt!: string | null;
}
