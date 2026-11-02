import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ComplianceCampaignEntry } from './campaigns.category';
import { COMPLIANCE_CATEGORIES, type ComplianceCategoryKey, type ComplianceOverride } from './compliance-category';
import type {
  ComplianceRow, CompliancePerson, ComplianceSection, ComplianceUnit, ComplianceView,
} from './compliance.service';
import type { ComplianceEventEntry } from './events.category';
import type { ComplianceTrainingCategory, ComplianceTrainingModule, ComplianceTrainingSkill } from './training.category';

/** Declared for OpenAPI. The wire shapes live on the service's and the categories' types (`contract-tree.md`). */

class ComplianceChipDto {
  @ApiProperty({ enum: COMPLIANCE_CATEGORIES }) category!: ComplianceCategoryKey;
  @ApiProperty({ example: 12, description: 'Done, among those the category applies to (D-chips).' }) count!: number;
  @ApiProperty({
    example: 19,
    description: 'Those the category applies to: every member listed; for *Activation* those with an activation, for '
      + '*Events* those in a listed event’s audience, for *Campaigns* those eligible for a listed campaign. **0 draws *—*** '
      + '— nobody to count, or nothing offered or listed.',
  })
  of!: number;
}

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

class ComplianceGoalsCatalogDto {
  @ApiProperty({ example: '2026', description: 'The office’s calendar year: *"{year} goals"*.' }) year!: string;
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

  @ApiProperty({ type: ComplianceGoalsCatalogDto }) goals!: ComplianceGoalsCatalogDto;

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

class ComplianceSelectionDto {
  @ApiProperty({ enum: COMPLIANCE_CATEGORIES }) category!: ComplianceCategoryKey;
  @ApiProperty({
    type: String, nullable: true,
    description: 'The item read: the one asked, or the first listed. `null` for a single-item category, or when nothing is listed.',
  })
  item!: string | null;
}

class CompliancePersonDto implements CompliancePerson {
  @ApiProperty({ description: 'The membership: the person in this office, never their account.' }) membershipId!: string;
  @ApiProperty({ example: 'Agus Salim' }) name!: string;
  @ApiProperty({ description: 'Leads somebody now: the name opens their Unit Dashboard.' }) leads!: boolean;
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
      + '*activity* `logged` · `missed`; *activation* `completed` · `in_progress` · `overdue`; *events* `registered` · '
      + '`not_registered` · `attended` · `no_show` · `unconfirmed`; *campaigns* `chasing` · `not_chasing`. `null` draws '
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

class ComplianceRowDto extends CompliancePersonDto implements ComplianceRow {
  @ApiProperty({ description: 'The card’s head’s own row: *Personal*, always first.' }) personal!: boolean;
  @ApiProperty({ type: ComplianceCellDto }) cell!: ComplianceCellDto;
}

class ComplianceUnitDto implements ComplianceUnit {
  @ApiProperty({ type: CompliancePersonDto }) head!: CompliancePersonDto;
  @ApiProperty({ enum: ['AB', 'AAB'], description: '`AB`: the agency’s own card — the AB and those in no AAB’s unit.' })
  rung!: 'AB' | 'AAB';
  @ApiProperty({ description: 'Rows done.' }) done!: number;
  @ApiProperty({ description: 'Rows the item applies to.' }) of!: number;
  @ApiProperty({ type: [ComplianceRowDto], description: 'The head’s own row first.' }) rows!: ComplianceRowDto[];
}

class ComplianceSectionDto implements ComplianceSection {
  @ApiProperty({ type: CompliancePersonDto, description: 'The AB whose agency it is.' }) head!: CompliancePersonDto;
  @ApiProperty() done!: number;
  @ApiProperty() of!: number;
  @ApiProperty({ type: [ComplianceUnitDto], description: 'The AB’s own card, then one per AAB who leads somebody, A to Z.' })
  units!: ComplianceUnitDto[];
}

class ComplianceCanDto {
  @ApiProperty({ description: 'May override a final campaign standing: never in a read-only support session.' })
  override!: boolean;
}

class ComplianceThresholdsDto {
  @ApiProperty({ example: 50, description: 'UI V1 (UI-109): a bar below this share done is red (`KPM_REPORTING.COMPLIANCE_LOW_BELOW_PCT`).' })
  lowBelowPct!: number;
  @ApiProperty({ example: 80, description: 'From this share done it is green (`KPM_REPORTING.COMPLIANCE_HIGH_FROM_PCT`).' })
  highFromPct!: number;
}

export class ComplianceViewDto implements ComplianceView {
  @ApiProperty({ example: '2026-10-10', description: 'The office’s day.' }) today!: string;
  @ApiProperty({ description: 'The members listed: the office’s active members, each in an AB agency.' }) people!: number;
  @ApiProperty({ description: 'The AB agencies: one section each.' }) units!: number;
  @ApiProperty({ type: [ComplianceChipDto], description: 'Six, in the summary’s order, every one computed on every read.' })
  summary!: ComplianceChipDto[];
  @ApiProperty({ type: ComplianceCatalogDto }) catalog!: ComplianceCatalogDto;
  @ApiProperty({ type: ComplianceSelectionDto }) selected!: ComplianceSelectionDto;
  @ApiProperty({ type: [ComplianceSectionDto], description: 'One per AB agency, A to Z by the AB’s name.' })
  tree!: ComplianceSectionDto[];
  @ApiProperty({ type: ComplianceCanDto }) can!: ComplianceCanDto;
  @ApiProperty({ type: ComplianceThresholdsDto }) thresholds!: ComplianceThresholdsDto;
}
