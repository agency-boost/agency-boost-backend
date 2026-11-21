import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ComplianceCampaignEntry } from './campaigns.category';
import { COMPLIANCE_CATEGORIES, type ComplianceCategoryKey, type ComplianceOverride } from './compliance-category';
import type { ComplianceCard, ComplianceCellRow, ComplianceView } from './compliance.service';
import type { ComplianceEventEntry } from './events.category';
import type { ComplianceTrainingCategory, ComplianceTrainingModule, ComplianceTrainingSkill } from './training.category';

/** Declared for OpenAPI. The wire shapes live on the service's and the categories' types (`contract-tree.md`). */

class ComplianceTrainingModuleDto implements ComplianceTrainingModule {
  @ApiProperty({ example: 'PROSPECT_LIST' }) code!: string;
  @ApiProperty({ example: 'Building Your Prospect List' }) title!: string;
}

class ComplianceTrainingSkillDto implements ComplianceTrainingSkill {
  @ApiProperty({ example: 'PROSPECTING' }) code!: string;
  @ApiProperty({ example: 'Prospecting' }) label!: string;
  @ApiProperty({ type: [ComplianceTrainingModuleDto], description: 'Its published modules, in order: never empty.' })
  modules!: ComplianceTrainingModuleDto[];
}

class ComplianceTrainingCategoryDto implements ComplianceTrainingCategory {
  @ApiProperty({ example: 'SALES' }) code!: string;
  @ApiProperty({ example: 'Sales' }) label!: string;
  @ApiProperty({
    type: [ComplianceTrainingSkillDto],
    description: 'The skills holding a published module, in order. Empty: the category has no module yet.',
  })
  skills!: ComplianceTrainingSkillDto[];
}

class ComplianceEventEntryDto implements ComplianceEventEntry {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Town Hall' }) title!: string;
  @ApiProperty({ description: 'ISO instant.' }) startsAt!: string;
  @ApiProperty({ description: 'ISO instant.' }) endsAt!: string;
  @ApiProperty({ example: '2026-10-15', description: 'The office’s day it starts on.' }) startsOn!: string;
  @ApiProperty({ enum: ['upcoming', 'running', 'past'] }) phase!: 'upcoming' | 'running' | 'past';
}

class ComplianceCampaignEntryDto implements ComplianceCampaignEntry {
  @ApiProperty({ example: 'PERSISTENCY_PUSH' }) code!: string;
  @ApiProperty({ example: 'Persistency Push' }) title!: string;
  @ApiProperty({ enum: ['structural', 'seasonal'] }) kind!: 'structural' | 'seasonal';
  @ApiProperty({ type: String, nullable: true }) subtype!: string | null;
  @ApiProperty({ enum: ['upcoming', 'running', 'ended'] }) phase!: 'upcoming' | 'running' | 'ended';
  @ApiProperty({ description: 'ISO instant.' }) startsAt!: string;
  @ApiProperty({ type: String, nullable: true, description: 'ISO instant; `null` while it runs on with no end.' }) endsAt!: string | null;
  @ApiProperty({ description: 'Its result can no longer change: the last month its window reads is locked.' }) final!: boolean;
}

class ComplianceCatalogDto {
  @ApiProperty({
    type: [ComplianceTrainingCategoryDto],
    description: 'What the office offers, from its published configuration: every category in order, an empty one included.',
  })
  training!: ComplianceTrainingCategoryDto[];

  @ApiProperty({
    type: [ComplianceEventEntryDto],
    description: 'This year’s events, archived ones never: not ended first, soonest first, then past, latest first.',
  })
  events!: ComplianceEventEntryDto[];

  @ApiProperty({
    type: [ComplianceCampaignEntryDto],
    description: 'This year’s campaigns, archived ones never: structural, then seasonal ongoing, then seasonal past.',
  })
  campaigns!: ComplianceCampaignEntryDto[];
}

class ComplianceOverridePersonDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() name!: string;
}

class ComplianceOverrideDto implements ComplianceOverride {
  @ApiProperty({ enum: ['qualified', 'not_met'] }) status!: 'qualified' | 'not_met';
  @ApiProperty() reason!: string;
  @ApiProperty({ type: ComplianceOverridePersonDto }) by!: ComplianceOverridePersonDto;
  @ApiProperty({ description: 'ISO instant.' }) at!: string;
}

class ComplianceCellDto {
  @ApiProperty({
    type: String, nullable: true,
    description: 'A code, never a word: *training* `done` · `in_progress` · `not_started`; *goals* `set` · `not_set`; '
      + '*activity* `logged` · `missed`; *leads* `managed` · `needs_next_action` · `no_leads`; *activation* `completed` · '
      + '`in_progress` · `overdue`; *events* `registered` · `not_registered` · `attended` · `no_show` · `unconfirmed`, and '
      + 'over *Semua event* `done` · `not_done`; *campaigns* `chasing` · `not_chasing`. `null` draws '
      + '*—*: the item does not apply to them.',
  })
  status!: string | null;

  @ApiProperty({
    type: Boolean, nullable: true,
    description: 'Counts as done. `null` — the item does not apply — is out of every *done / of*.',
  })
  done!: boolean | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-10', description: 'The office’s day the date column shows, or `null`.' })
  on!: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true,
    description: '*Events* and *campaigns* only: the second column’s code — feedback `shared` · `not_shared`; achieved '
      + '`qualified` · `not_met` · `not_joined` · `in_progress` · `unknown`. `null` draws *—*.',
  })
  second?: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true,
    description: '*Activation* only: the day an expired activation ended — its *Overdue* says so. `null` otherwise.',
  })
  endedOn?: string | null;

  @ApiPropertyOptional({ type: ComplianceOverrideDto, nullable: true, description: '*Campaigns* only: the override on the standing.' })
  override?: ComplianceOverrideDto | null;

  @ApiPropertyOptional({ description: '*Campaigns* only: the standing is stored and final, so its result may be overridden.' })
  overridable?: boolean;
}

class ComplianceCanDto {
  @ApiProperty({ description: 'May override a final campaign standing: never in a read-only support session.' })
  override!: boolean;
}

class ComplianceThresholdsDto {
  @ApiProperty({ example: 34, description: 'A card below this share done is red (`KPM_REPORTING.COMPLIANCE_LOW_BELOW_PCT`).' })
  lowBelowPct!: number;
  @ApiProperty({ example: 67, description: 'Below this it is yellow, from it green (`KPM_REPORTING.COMPLIANCE_HIGH_FROM_PCT`).' })
  highFromPct!: number;
}

class ComplianceCardDto implements ComplianceCard {
  @ApiProperty({ enum: COMPLIANCE_CATEGORIES }) category!: ComplianceCategoryKey;
  @ApiProperty({ example: 14, description: 'Done, among those the card applies to.' }) count!: number;
  @ApiProperty({
    example: 30,
    description: 'Those the card applies to: *anggota* — the scope’s members; for *Activation* *agent baru*, those with an '
      + 'activation; for *Events* *yang diundang*, those in a listed event’s audience; for *Campaigns* those eligible for '
      + 'a listed campaign. **0 draws *—***.',
  })
  of!: number;
  @ApiProperty({ type: Number, nullable: true, example: 47, description: 'Whole, rounded half up; `null` with `of: 0`.' })
  pct!: number | null;
}

class ComplianceCellRowDto extends ComplianceCellDto implements ComplianceCellRow {
  @ApiProperty({ description: 'The person, by membership: the Overview’s tree (`GET /kpm/overview`’s `people`) draws the row.' })
  membershipId!: string;
}

class ComplianceSelectedDto {
  @ApiProperty({ enum: COMPLIANCE_CATEGORIES }) category!: ComplianceCategoryKey;
  @ApiProperty({
    type: String, nullable: true,
    description: 'The item read: Training’s module (the first offered when none is asked), an event’s id, a campaign’s '
      + 'code; `null` for a single-item card and for *Semua event* / *Semua campaign* — every one at once.',
  })
  item!: string | null;
  @ApiProperty({ example: 14, description: '*"x dari y"*’s x: cells done.' }) done!: number;
  @ApiProperty({ example: 30, description: '*"x dari y"*’s y: cells the item applies to.' }) of!: number;
  @ApiProperty({ type: [ComplianceCellRowDto], description: 'Every person of the scope, in the Overview’s tree order.' })
  cells!: ComplianceCellRowDto[];
}

class ComplianceGroupRefDto {
  @ApiProperty({ type: String, nullable: true, description: '`null`: *Tanpa group*.' }) groupId!: string | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class ComplianceViewDto implements ComplianceView {
  @ApiProperty({ example: '2026-11-20', description: 'The office’s day.' }) today!: string;
  @ApiProperty({ type: ComplianceThresholdsDto }) thresholds!: ComplianceThresholdsDto;
  @ApiProperty({ type: ComplianceGroupRefDto, nullable: true, description: 'The informal group read (`?group=`); `null`: the KPM.' })
  group!: ComplianceGroupRefDto | null;
  @ApiProperty({ type: [ComplianceCardDto], description: 'Seven, lowest % first, a card that applies to nobody last.' })
  cards!: ComplianceCardDto[];
  @ApiProperty({ type: ComplianceCatalogDto }) catalog!: ComplianceCatalogDto;
  @ApiProperty({ type: ComplianceSelectedDto, nullable: true, description: 'The card asked about (`?category=`), else `null`.' })
  selected!: ComplianceSelectedDto | null;
  @ApiProperty({ type: ComplianceCanDto }) can!: ComplianceCanDto;
}
