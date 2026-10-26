import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RATIO_DISPLAY_UNITS, type ActivationLinkKind, type RatioDisplayUnit } from '@/domain/constants';
import type { ActivityCategoryView, ActivityTypeView } from './activity.service';
import type { LeadPipelineView, LeadStatusView } from './lead-status.service';
import { LEAD_PIPELINES, type LeadPipeline } from './lead-status.schema';
import { RATIO_ORIGINS, type RatioOrigin } from './ratio-definition.schema';
import type { RatioDefinitionView } from './ratio.service';
import type {
  PublishState, SnapshotEventTypeView, TenantConfigView,
} from './tenant-config.service';
import type { TemplateView } from './template.service';
import type { NamedTemplateView } from './named-template.service';
import type { DroppedSetting } from './office-template';
import type {
  ActivityBindingView, BindableType, OfficeActivityBindingView,
} from './activity-binding.service';
import type { SavedOfficeTemplateView } from './template-copy.service';
import { TEMPLATE_ORIGINS, type TemplateOrigin } from './named-template.schema';
import { OFFICE_TEMPLATE_KINDS, type OfficeTemplateKind } from './template-defaults';
import { TEMPLATE_KINDS, type TemplateKind } from './company-template.schema';
import { TrainingCategoryDto } from '@/modules/training/training.response.dto';
import { ActivationVersionDto } from '@/modules/activation/activation.response.dto';
import { CapabilityCatalogDto } from '@/modules/capability/capability.response.dto';
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

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'DEVELOPMENT',
    description:
      'The summary tile this section counts toward (ADR-0064). Sections sharing a code share a '
      + 'tile; `null` is a tile of its own, under `label`. **Presentation only** — the strips on '
      + '`/activity/log` and `/activity/dashboard` read it, and no metric does.',
  })
  summaryGroupCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Development',
    description:
      'The tile\'s label, identical on every section of the group — a write leaving two that '
      + 'disagree is refused `422 CONFIG_SUMMARY_GROUP_LABEL_MISMATCH`. `null` exactly when '
      + '`summaryGroupCode` is.',
  })
  summaryGroupLabel!: string | null;

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

  @ApiProperty({
    type: Boolean,
    description:
      'A stage the lead is expected to convert from this period, and what the KPM '
      + 'Overview counts as *Expected to close*. Unlike the terminal flag it is not '
      + 'exclusive, and it is never true on the stage that closes the pipeline.',
  })
  isLateStage!: boolean;

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

/** An event type as the snapshot carries it (P5-T9): no live count, and active rows only. */
export class SnapshotEventTypeDto implements SnapshotEventTypeView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emoji!: string | null;

  @ApiProperty({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ type: Number })
  version!: number;
}

/** Which activity types each cascade role counts — the office's activity binding (ADR-0163). */
export class ActivityBindingDto implements ActivityBindingView {
  @ApiProperty({
    type: [String], example: ['LEADS_CONTACTED'],
    description: '*Set appointment*: the activity type codes the goal cascade\u2019s leads column counts, summed.',
  })
  leads!: string[];

  @ApiProperty({
    type: [String], example: ['SELL_PRESENTATION'],
    description: '*Sales meeting*: the codes the appointments column counts, summed.',
  })
  appointments!: string[];

  @ApiProperty({
    type: [String], example: ['SELL_SUBMISSION'],
    description: '*Submission polis*: the codes the closings column and the pace sentence count, summed.',
  })
  closings!: string[];

  @ApiProperty({
    type: Number,
    description: 'Bumped on every write. 0 for an office with no binding yet, which counts the default binding.',
  })
  version!: number;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  updatedAt!: string | null;
}

/** One of the office's activity types, as the Super Admin's binding card offers it. */
export class BindableTypeDto implements BindableType {
  @ApiProperty({ type: String, example: 'SELL_PRESENTATION' }) code!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String }) categoryCode!: string;
  @ApiProperty({ type: Number }) displayOrder!: number;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: 'active' | 'archived';
}

/** One named office\u2019s activity binding, with every type it may name, archived ones included. */
export class OfficeActivityBindingDto extends ActivityBindingDto implements OfficeActivityBindingView {
  @ApiProperty({ type: String }) kpmId!: string;

  @ApiProperty({
    type: [BindableTypeDto],
    description: 'Every activity type the office holds, archived ones included (their history counts), in its order.',
  })
  types!: BindableTypeDto[];
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
    type: [TrainingCategoryDto],
    description:
      'The training taxonomy agents are offered: active categories and skills, and **published** '
      + 'active modules only. A draft never reaches an agent.',
  })
  training!: TrainingCategoryDto[];

  @ApiProperty({
    type: ActivationVersionDto,
    nullable: true,
    description:
      'The 90-day checklist a new hire is given — the **published** version only, and '
      + '`null` before an office has published one. A draft never reaches an agent.',
  })
  activationChecklist!: ActivationVersionDto | null;

  @ApiProperty({
    type: [SnapshotEventTypeDto],
    description:
      'What an event may be filed under, active rows only — without the live event '
      + 'count the settings screen carries, because a count frozen into a snapshot is wrong the '
      + 'moment anybody files an event.',
  })
  eventTypes!: SnapshotEventTypeDto[];

  @ApiProperty({
    type: CapabilityCatalogDto,
    nullable: true,
    description:
      'The capability catalog a leader assesses against, active rows only. `null` only '
      + 'for an office provisioned before it existed.',
  })
  capability!: CapabilityCatalogDto | null;

  @ApiProperty({
    type: ActivityBindingDto,
    nullable: true,
    description:
      'The activity binding in force when the copy was published — a record. Every count reads the office\u2019s '
      + 'live binding, which takes effect when it is saved. `null` in a copy published before the binding existed.',
  })
  activityBinding!: ActivityBindingDto | null;

  @ApiProperty({
    type: Number,
    description:
      'The highest version across everything above — one number to compare rather than '
      + 'three collections to reason about. It moves when what the office counts changes, '
      + 'and not on a reorder, because a reorder rebinds nothing.',
  })
  version!: number;
}

/** One link kind, as the Company template's *Activation checklist* tab reads it (P18.5-T3 AC-6). */
export class ActivationLinkKindDto implements ActivationLinkKind {
  @ApiProperty({ type: String, example: 'Training module' })
  label!: string;

  @ApiProperty({ type: String, example: '/training' })
  route!: string;

  @ApiProperty({ type: String, example: 'the hire has completed that training module', description: 'The badge’s tooltip.' })
  completesWhen!: string;

  @ApiProperty({ type: Boolean, description: 'An item bound to it completes on its own: draw *Auto*.' })
  live!: boolean;
}

/** The link registry, by kind: the three feature links, and `training` for every training link. */
export class ActivationLinkKindsDto {
  @ApiProperty({ type: ActivationLinkKindDto })
  'feature:goals'!: ActivationLinkKindDto;

  @ApiProperty({ type: ActivationLinkKindDto })
  'feature:leads'!: ActivationLinkKindDto;

  @ApiProperty({ type: ActivationLinkKindDto })
  'feature:activity'!: ActivationLinkKindDto;

  @ApiProperty({ type: ActivationLinkKindDto })
  training!: ActivationLinkKindDto;
}

/** A company's KPM template, as a Super Admin sees it (P4-T8, ADR-0018). */
export class CompanyTemplateDto implements TemplateView {
  @ApiProperty({ type: String, description: 'Empty when nothing has been saved yet.' })
  id!: string;

  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The named template this kind belongs to. Null for `campaign_kinds`, which is the company\'s, '
      + 'shared by every template.',
  })
  templateId!: string | null;

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
      'How many of this template\'s offices were built from an older version of this kind — '
      + 'including those whose record for it has no version: since 13.2, an office whose template held '
      + 'none of this kind when it was made; before 13.2, one built from the platform defaults because '
      + 'the company had published nothing of it.',
  })
  officesBehind!: number;

  @ApiProperty({
    type: Number,
    description:
      'How many were created before provisioning recorded this kind, so whether they are '
      + 'current is not known. Counted apart from `officesBehind`, which only counts offices '
      + 'known to be behind.',
  })
  officesUnrecorded!: number;

  @ApiPropertyOptional({
    type: ActivationLinkKindsDto,
    description:
      '`activation_checklist` only: what each link kind does and whether it completes on its own — the badge '
      + 'reads *Auto* only where `live`. `training` answers for every `training:<moduleCode>` link.',
  })
  linkKinds?: ActivationLinkKindsDto;
}

/** Whether the office has edited anything since agents last had a copy (P4-T6). */
export class PublishStateDto implements PublishState {
  @ApiProperty({ type: Number, description: 'What agents are on. 0 when nothing is published.' })
  publishedVersion!: number;

  @ApiProperty({
    type: Number,
    description:
      'The highest live row version. Informational — **not** a change detector: a created row '
      + 'starts at 1, and an edit below the maximum or an archive leaves it where it was. Read '
      + '`hasUnpublishedChanges` for that.',
  })
  workingVersion!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'Whether any row has been created, edited, archived or restored since the last publish, '
      + 'judged by which rows are present at which version. A reorder is not a change. True for '
      + 'an office with nothing published.',
  })
  hasUnpublishedChanges!: boolean;

  @ApiProperty({ type: String, nullable: true })
  publishedAt!: string | null;
}

/** Where a template came from (ADR-0115). A record, never a link. */
export class TemplateOriginDto implements TemplateOrigin {
  @ApiProperty({ enum: TEMPLATE_ORIGINS })
  kind!: TemplateOrigin['kind'];

  @ApiProperty({ type: String, nullable: true, required: false })
  templateId?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  kpmId?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  companyId?: string | null;
}

/** One of a company's named templates (ADR-0115 §3). */
export class NamedTemplateDto implements NamedTemplateView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ type: String, example: 'Prudential template' })
  name!: string;

  @ApiProperty({ type: Boolean, description: 'The company\'s default: exactly one per company.' })
  isDefault!: boolean;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';

  @ApiProperty({ type: String, nullable: true })
  archivedAt!: string | null;

  @ApiProperty({ type: () => TemplateOriginDto })
  origin!: TemplateOriginDto;

  @ApiProperty({
    type: Object,
    description:
      'The newest published version of each of the seven kinds, keyed by kind; null where none is '
      + 'published, which an office made from this template gets empty.',
  })
  publishedVersions!: Record<OfficeTemplateKind, number | null>;

  @ApiProperty({
    type: Number,
    description:
      'Live offices started from this template — and, for the template each existing company was given '
      + 'when templates were named, the offices created before then.',
  })
  officeCount!: number;

  @ApiProperty({ type: String })
  createdAt!: string;

  @ApiProperty({ type: String })
  updatedAt!: string;
}

/**
 * Something an office held that *Save as template* left out or changed, and why (exit review of P13.2,
 * finding 2): what archiving left behind, which no office made from the template could be given.
 */
export class DroppedSettingDto implements DroppedSetting {
  @ApiProperty({
    enum: OFFICE_TEMPLATE_KINDS,
    description: 'The template kind it was in: `ratio_set`, `capability_ladder` or `activation_checklist`.',
  })
  kind!: OfficeTemplateKind;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The ratio, stage, grid or checklist item concerned; null when the whole kind was left out.',
  })
  code!: string | null;

  @ApiProperty({
    type: String,
    example: 'Ratio CLOSING no longer counts OLD_VISIT, which is not an active activity type in this office.',
    description: 'One sentence naming the codes, as the office page shows it.',
  })
  reason!: string;
}

/** *Save as template*'s answer: the template as made, and what the office held that it left out. */
export class SavedOfficeTemplateDto extends NamedTemplateDto implements SavedOfficeTemplateView {
  @ApiProperty({
    type: () => DroppedSettingDto,
    isArray: true,
    description:
      'What the office held that the template leaves out or changes, because it names something archived: '
      + 'an archived activity type taken out of a ratio (the ratio left out when a side counts nothing '
      + 'else), a stage\'s archived milestones (the stage left out when it requires nothing else), a grid '
      + 'whose every item is archived, the ladder when no stage or milestone is left, and a checklist '
      + 'item\'s link to a module no longer offered (the item kept as a manual one). Empty when nothing was. '
      + 'Recorded in the `template.created` audit row as well.',
  })
  dropped!: DroppedSettingDto[];
}
