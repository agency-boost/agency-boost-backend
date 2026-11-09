import { AnalyticsEditorDto } from './analytics-template.response.dto';
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
import type { PublishAllOutcome, PublishAllView, PublishedKindView, TemplateView } from './template.service';
import type { NamedTemplateView, TemplateOfficeView, TemplateSectionState } from './named-template.service';
import type { DroppedSettingView } from './office-template';
import type { PushDifference, PushState } from './template-push';
import type {
  ApplyKindOutcome, ApplyOfficeResult, ApplyView, KindStanding, TemplateOfficeStandingView,
} from './template-push.service';
import type {
  ActivityBindingView, BindableType, OfficeActivityBindingView,
} from './activity-binding.service';
import type { SavedOfficeTemplateView } from './template-copy.service';
import { TEMPLATE_ORIGINS, type TemplateOrigin } from './named-template.schema';
import {
  NAMED_TEMPLATE_KINDS, OFFICE_TEMPLATE_KINDS, type NamedTemplateKind, type OfficeTemplateKind,
} from './template-defaults';
import type { RecruitmentPlaybookBody } from '@/domain/constants';
import { RecruitmentPlaybookLimitsDto, RecruitmentVocabularyDto } from '@/modules/recruitment/recruitment.response.dto';
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

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Submission polis',
    description:
      '*Nama singkat* (ADR-0229 §5): the one line the Unit Dashboard’s activity table shows, the full `label` '
      + 'on tap. `null` for none.',
  })
  shortLabel!: string | null;

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
      'How to write `benchmark` for a reader. `percent`: × 100, as typed (15%, 15,5%; ADR-0174 §2). '
      + '`decimal`: two decimals (0,30). `points`: ± percentage points (±30 points). Always '
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

/** One link kind, as the Company template's *Activation checklist* tab reads it (P18.2-T3 AC-6). */
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

/** The newest published version of one kind, beside the draft on the read (P19-T6 AC-3). */
export class PublishedTemplateKindDto implements PublishedKindView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: Number, description: 'What new offices are seeded from today.' })
  version!: number;

  @ApiProperty({ type: Number })
  revision!: number;

  @ApiProperty({ type: Object, description: 'Shape depends on `kind`.' })
  payload!: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true })
  publishedAt!: string | null;
}

/** What a playbook section's editor reads beside its words (ADR-0210 §1). */
export class PlaybookEditorDto {
  @ApiProperty({
    type: 'object', additionalProperties: true,
    description: 'The AgencyBoost words, a whole playbook — what *Mulai dari kata-kata AgencyBoost* starts from.',
  })
  defaults!: RecruitmentPlaybookBody;

  @ApiProperty({ type: () => RecruitmentVocabularyDto })
  vocabulary!: RecruitmentVocabularyDto;

  @ApiProperty({ type: () => RecruitmentPlaybookLimitsDto, description: 'The bounds a publish holds each text to.' })
  limits!: RecruitmentPlaybookLimitsDto;
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

  @ApiProperty({
    type: Number,
    example: 3,
    description: 'How many times the kind\'s working copy has been written; `0` for nothing saved. A draft save sends '
      + 'it back as `expectedRevision`, and one somebody else has moved past is `409 VERSION_CONFLICT`. '
      + '`version` does not move when a draft is saved.',
  })
  revision!: number;

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

  @ApiPropertyOptional({
    type: () => PublishedTemplateKindDto,
    nullable: true,
    description:
      '**The read only**: the live version beside the draft — the newest published version of the kind, '
      + 'or `null` where nothing is published. A draft no longer hides what offices are made from today.',
  })
  published?: PublishedTemplateKindDto | null;

  @ApiPropertyOptional({
    type: () => PlaybookEditorDto,
    description:
      '`recruitment_playbook` only (ADR-0210 §1): the AgencyBoost words to start the section from, the brief\u2019s '
      + 'vocabulary the words are keyed by, in the reader\u2019s language, and the bounds a publish holds each text to.',
  })
  playbook?: PlaybookEditorDto;

  @ApiPropertyOptional({
    type: () => AnalyticsEditorDto,
    description:
      '`advanced_analytics` only (ADR-0214 §1): the KPMs that read the template, the kodes they hold data for — whose '
      + 'unit and start month are locked — *Dipakai di*, next month and the bounds a draft is held to.',
  })
  analytics?: AnalyticsEditorDto;
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

/** Where one kind of a template stands (ADR-0185 §3). */
export class TemplateSectionStateDto implements TemplateSectionState {
  @ApiProperty({ type: Number, nullable: true, description: 'The newest published version; null where none is.' })
  publishedVersion!: number | null;

  @ApiProperty({ type: Boolean, description: 'A draft is saved and not published.' })
  hasDraft!: boolean;
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
      'The newest published version of each of its kinds, keyed by kind — the seven an office copies and '
      + '`recruitment_playbook` (ADR-0210 §1); null where none is published, which an office made from this template '
      + 'gets empty, and its agents meet the playbook-empty state.',
  })
  publishedVersions!: Record<NamedTemplateKind, number | null>;

  @ApiProperty({
    type: Object,
    description:
      'Each of its kinds, keyed by kind, `recruitment_playbook` among them: `publishedVersion` (null where none is) and '
      + '`hasDraft`, a draft '
      + 'saved and not published (ADR-0185 §3) — the template card\u2019s sections published and changes waiting, '
      + 'and the checklist\u2019s *Terbit vN*, *Draf* or *Kosong*.',
    example: {
      activity_taxonomy: { publishedVersion: 3, hasDraft: false },
      lead_pipeline: { publishedVersion: 1, hasDraft: true },
      activation_checklist: { publishedVersion: null, hasDraft: false },
    },
  })
  sections!: Record<NamedTemplateKind, TemplateSectionStateDto>;

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
export class DroppedSettingDto implements DroppedSettingView {
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

/** What *Terbitkan semua* did with one kind (ADR-0185 §3). */
export class PublishAllOutcomeDto {
  @ApiProperty({ enum: NAMED_TEMPLATE_KINDS })
  kind!: NamedTemplateKind;

  @ApiProperty({
    enum: ['published', 'skipped', 'refused'],
    description: '`published`: its draft is `version` now. `skipped`: nothing waited (`reason: no_changes`). '
      + '`refused`: its draft was refused as its own publish would refuse it, and is still a draft (`error`).',
  })
  outcome!: PublishAllOutcome['outcome'];

  @ApiPropertyOptional({ type: Number, description: '`published` only: the version it now is.' })
  version?: number;

  @ApiPropertyOptional({ enum: ['no_changes'], description: '`skipped` only.' })
  reason?: 'no_changes';

  @ApiPropertyOptional({
    type: Object,
    description: '`refused` only: the refusal\u2019s `code` and `message`, in the reader\u2019s language.',
    example: { code: 'VALIDATION_FAILED', message: 'Add at least one activity type before publishing.' },
  })
  error?: { code: string; message: string };
}

/** *Terbitkan semua*'s answer (ADR-0185 §3). */
export class PublishAllDto implements PublishAllView {
  @ApiProperty({ type: () => NamedTemplateDto, description: 'The template as it now stands.' })
  template!: NamedTemplateDto;

  @ApiProperty({ type: () => PublishAllOutcomeDto, isArray: true, description: 'Every kind, in publishing order.' })
  results!: PublishAllOutcome[];
}

/** One office a template answers for, and the kinds it is behind on (ADR-0185 §4). */
export class TemplateOfficeDto implements TemplateOfficeView {
  @ApiProperty({ type: String, description: 'The office (`kpms._id`).' })
  id!: string;

  @ApiProperty({ type: String, example: '0417' })
  code!: string;

  @ApiProperty({ type: String, example: 'BSD City Branch' })
  branchName!: string;

  @ApiProperty({
    enum: OFFICE_TEMPLATE_KINDS, isArray: true,
    description: 'Kinds the template has published a newer version of than the office was built from, or held none of then.',
  })
  behind!: OfficeTemplateKind[];

  @ApiProperty({
    enum: OFFICE_TEMPLATE_KINDS, isArray: true,
    description: 'Kinds the office has no record of: created before provisioning recorded them, so not known.',
  })
  unrecorded!: OfficeTemplateKind[];
}

/** One thing a KPM did to a section, against the version it was last given (ADR-0208 §4). */
export class PushDifferenceDto implements PushDifference {
  @ApiProperty({ type: String, example: 'types', description: 'The level: `categories`, `types`, `modules`, `statuses`, …' })
  level!: string;

  @ApiProperty({ type: String, example: 'COFFEE_MEETING', description: 'The item’s code.' })
  code!: string;

  @ApiProperty({ enum: ['added', 'removed', 'changed'] })
  change!: PushDifference['change'];

  @ApiPropertyOptional({
    type: [String], example: ['label'],
    description: '`changed` only: the fields that differ — `material` for a training module showing the KPM’s own.',
  })
  fields?: string[];
}

/** Where a KPM stands on one section (ADR-0208 §4). */
export class KindStandingDto implements KindStanding {
  @ApiProperty({ enum: OFFICE_TEMPLATE_KINDS })
  kind!: OfficeTemplateKind;

  @ApiProperty({
    enum: ['unchanged', 'changed', 'current'],
    description: '`current`: the KPM holds the newest version, and a push skips it. `changed`: it differs from the '
      + 'version it was last given. `unchanged`: it does not, however old that version.',
  })
  state!: PushState;

  @ApiProperty({ type: Number, nullable: true, description: 'The version of this template the KPM was last given.' })
  givenVersion!: number | null;

  @ApiProperty({ type: Number })
  newestVersion!: number;

  @ApiProperty({ type: () => PushDifferenceDto, isArray: true, description: '`changed` only; empty otherwise.' })
  differences!: PushDifference[];

  @ApiPropertyOptional({ type: Number, description: 'Training only: modules showing the KPM’s own material.' })
  ownMaterialModules?: number;
}

/**
 * One office a template answers for — and, with `?kind=`, where it stands on the sections asked about (ADR-0208 §4).
 * Without `?kind=` the two fields are absent and the row is ADR-0185 §4's, as before.
 */
export class TemplateOfficeStandingDto extends TemplateOfficeDto implements Partial<TemplateOfficeStandingView> {
  @ApiPropertyOptional({
    enum: ['unchanged', 'changed', 'current'],
    description: 'With `?kind=` only. `changed` when any section is; `current` when every section is.',
  })
  state?: PushState;

  @ApiPropertyOptional({
    type: () => KindStandingDto, isArray: true,
    description: 'With `?kind=` only: the sections asked about that the template has published, in publishing order.',
  })
  kinds?: KindStanding[];
}

/** A template's material upload, confirmed against storage: what landed, as storage reports it (ADR-0040). */
export class ConfirmedUploadDto {
  @ApiProperty({ type: String })
  storageKey!: string;

  @ApiProperty({ type: String, example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({ type: Number, example: 1048576 })
  bytes!: number;
}

/** What a push did for one KPM and one section (ADR-0208 §4). */
export class ApplyKindOutcomeDto {
  @ApiProperty({ enum: OFFICE_TEMPLATE_KINDS })
  kind!: OfficeTemplateKind;

  @ApiProperty({ enum: ['applied', 'skipped', 'refused'] })
  outcome!: ApplyKindOutcome['outcome'];

  @ApiPropertyOptional({ type: Number, description: '`applied`: the template version the KPM now holds.' })
  version?: number;

  @ApiPropertyOptional({ type: Boolean, description: '`applied`: the KPM’s own training material was replaced.' })
  replaced?: boolean;

  @ApiPropertyOptional({ enum: ['current'], description: '`skipped`: the KPM already held the newest version.' })
  reason?: 'current';

  @ApiPropertyOptional({
    type: Object,
    description: '`refused`: the refusal’s `code` and `message`, in the reader’s language.',
    example: { code: 'TEMPLATE_APPLY_UNCONFIRMED', message: 'KPM 0417 changed this section itself…' },
  })
  error?: { code: string; message: string };
}

export class ApplyOfficeResultDto implements ApplyOfficeResult {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: '0417' })
  code!: string;

  @ApiProperty({ type: String, example: 'BSD City Branch' })
  branchName!: string;

  @ApiProperty({ type: () => ApplyKindOutcomeDto, isArray: true })
  results!: ApplyKindOutcome[];

  @ApiProperty({
    type: Boolean,
    description: 'The KPM had changes of its own waiting to be published, so what was applied waits with them.',
  })
  awaitingPublish!: boolean;
}

/** *Terapkan juga ke KPM yang sudah ada*'s answer (ADR-0208 §4). */
export class ApplyTemplateResultDto implements ApplyView {
  @ApiProperty({ type: String })
  templateId!: string;

  @ApiProperty({ type: () => ApplyOfficeResultDto, isArray: true, description: 'Each KPM, in the order sent.' })
  offices!: ApplyOfficeResult[];
}
