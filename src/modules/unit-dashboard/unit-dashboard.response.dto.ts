import { ApiProperty } from '@nestjs/swagger';
import { UNIT_DASHBOARD, type UnitDashboardPeriod } from '@/domain/constants';
import { GOAL_PACE_STATUSES, type GoalPaceStatus } from '@/domain/metrics/goal-pace-status';
import type { CountAgainst, LeadCountsRow, RolledUpGoal } from '@/domain/metrics/unit-rollup';
import type { FollowUp } from '@/modules/coaching/follow-up';
import { PROVENANCES, type Provenance } from '@/modules/production/monthly-agent-data.schema';
import type { MonthState } from '@/modules/production/production-months.service';
import { MonthStateDto } from '@/modules/production/production.response.dto';
import { FigureSourceDto } from '@/modules/summary/figure-source.dto';
import type {
  GoalCell, ProductionCell, ProductionUpdated, UnitDashboardView, UnitGroup, UnitLastOneOnOne, UnitPerson,
  UnitRow, UnitTotal,
} from './unit-dashboard.service';

/** Declared for OpenAPI. The wire shapes live on `UnitDashboardService`'s view types. */

export class UnitPersonDto implements UnitPerson {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' })
  membershipId!: string;

  @ApiProperty({ example: 'Rina Wijaya' })
  name!: string;
}

class UnitHeadDto extends UnitPersonDto {
  @ApiProperty({ description: 'The unit is the reader’s own. Otherwise it is a leader’s below them, named.' })
  isReader!: boolean;
}

class UnitRungDto {
  @ApiProperty({ example: 'AGENT', description: 'The rung’s stable code on the company’s ladder.' }) code!: string;
  @ApiProperty({ example: 'Agent', description: 'The ladder’s own label for it.' }) label!: string;
}

export class GoalCellDto implements GoalCell {
  @ApiProperty({ description: 'A goal is saved for the year. Without one the row reads *No goal set*, never 0.' })
  set!: boolean;

  @ApiProperty({ enum: ['month', 'year'], description: 'Which of the Summary’s figures these are: the month’s under `7d`.' })
  period!: 'month' | 'year';

  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units. `null` without a goal.' }) targetMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`null` when the agency holds no figure yet — not zero.' }) actualMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`APE_ATTAINMENT_PCT`, capped at 999.' }) attainmentPct!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`APE_GAP_TO_TARGET`.' }) gapMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) overMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '`POLICIES_NEEDED` at their average case size.' }) policiesNeeded!: number | null;
  @ApiProperty({ description: 'Their average case size, IDR minor units.' }) caseSizeMinor!: number;
  @ApiProperty() targetMet!: boolean;

  @ApiProperty({
    type: FigureSourceDto, nullable: true,
    description: 'Where the achieved figure came from; `null` until this month’s file arrives.',
  })
  source!: GoalCell['source'];
}

export class ProductionCellDto implements ProductionCell {
  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units. `null` is *Not uploaded yet*, never zero.' })
  valueMinor!: number | null;

  @ApiProperty({ enum: PROVENANCES, nullable: true }) provenance!: Provenance | null;
  @ApiProperty({ type: UnitPersonDto, nullable: true, description: 'Who corrected it, for a correction.' }) correctedBy!: UnitPerson | null;
  @ApiProperty({ type: String, nullable: true }) correctedAt!: string | null;
}

class ProductionCellsDto {
  @ApiProperty({ type: ProductionCellDto, description: 'This month’s APE, as the month table holds it.' }) monthly!: ProductionCell;
  @ApiProperty({ type: ProductionCellDto, description: 'The year to date’s APE, as the month table holds it.' }) ytd!: ProductionCell;
}

class LeadCountsDto implements LeadCountsRow {
  @ApiProperty({ description: '`OPEN_SALES_LEADS`.' }) salesOpen!: number;
  @ApiProperty({ description: '`SALES_LEADS_CLOSING_THIS_MONTH`: open sales leads promised for this month.' }) salesClosing!: number;
  @ApiProperty({ description: '`RECRUITMENT_PIPELINE_NOW`.' }) recruitOpen!: number;
  @ApiProperty({ description: '`RECRUITMENT_NOMINATED_THIS_MONTH`: open recruitment leads promised for this month.' }) recruitNominated!: number;
}

class CountAgainstDto implements CountAgainst {
  @ApiProperty() logged!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`null` without an APE target to derive it from.' }) target!: number | null;
}

class UnitActivityDto {
  @ApiProperty({ type: CountAgainstDto, description: 'Leads contacted: the goal’s leads code.' }) leads!: CountAgainst;
  @ApiProperty({ type: CountAgainstDto }) appointments!: CountAgainst;
  @ApiProperty({ type: CountAgainstDto }) closings!: CountAgainst;
  @ApiProperty({ type: CountAgainstDto, description: '`CASCADE_ACTIVITY_TOUCHES`: the three summed; no target if any has none.' })
  touches!: CountAgainst;
}

class UnitLastOneOnOneDto implements UnitLastOneOnOne {
  @ApiProperty({ description: '`DAYS_SINCE_LAST_COACHING`: whole calendar days, 0 being today.' }) days!: number;
  @ApiProperty({ example: '2026-09-28' }) date!: string;
  @ApiProperty({ description: '`days` is above `overdueAfterDays`.' }) overdue!: boolean;
  @ApiProperty({ type: UnitPersonDto, nullable: true, description: 'Who led it.' }) coach!: UnitPerson | null;
}

class FollowUpDto implements FollowUp {
  @ApiProperty() text!: string;
  @ApiProperty({ type: String, nullable: true }) dueDate!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Whole days past `dueDate`, when it is before today.' }) overdueDays!: number | null;
}

/** A campaign a row's person is chasing: the chip's words, and its address (P18.5-T7 AC-8). */
class UnitChasedCampaignDto {
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
}

export class UnitRowDto implements UnitRow {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Rina Wijaya' }) name!: string;
  @ApiProperty({ description: 'The reader’s own row.' }) isReader!: boolean;
  @ApiProperty({
    description:
      'You, or somebody you coach whose coaching pages you may open: the row links to them. `false` where '
      + 'those pages would not be found — the agency’s owner or an administrator reading a unit outside their '
      + 'own team, or a leader on the agent rung, who may not read anybody else’s Personal Summary.',
  })
  coached!: boolean;
  @ApiProperty({ type: UnitRungDto }) rung!: { code: string; label: string };
  @ApiProperty({ description: 'Edges from the unit’s head: the head is 0.' }) depth!: number;
  @ApiProperty({ description: 'Leads somebody: a unit head.' }) leads!: boolean;
  @ApiProperty({ type: GoalCellDto }) goal!: GoalCell;
  @ApiProperty({ type: ProductionCellsDto }) production!: { monthly: ProductionCell; ytd: ProductionCell };
  @ApiProperty({ type: LeadCountsDto }) leadsCounts!: LeadCountsRow;
  @ApiProperty({ type: UnitActivityDto }) activity!: UnitRow['activity'];

  @ApiProperty({
    type: UnitLastOneOnOneDto, nullable: true,
    description: 'The coaching roster’s; `null` on the reader’s own row and before a first finalized session.',
  })
  lastOneOnOne!: UnitLastOneOnOne | null;

  @ApiProperty({ enum: GOAL_PACE_STATUSES, description: '`GOAL_PACE_STATUS` for the calendar month, whatever the period.' })
  status!: GoalPaceStatus;

  @ApiProperty({ type: Boolean, nullable: true, description: '`PACING_TO_MAA`; `null` without a target.' })
  pacingToMaa!: boolean | null;

  @ApiProperty({
    type: FollowUpDto, nullable: true,
    description: 'The next open action item of their latest finalized coaching session.',
  })
  followUp!: FollowUp | null;

  @ApiProperty({
    type: Boolean, nullable: true,
    description: '*Chasing MDRT*: chasing the agency’s `MDRT_QUALIFICATION` campaign, not ended. `null` where your '
      + 'reading does not reach their campaigns — a leader on the agent rung reading a coachee: drawn —.',
  })
  chasingMdrt!: boolean | null;

  @ApiProperty({
    type: [UnitChasedCampaignDto], nullable: true,
    description: '*Campaigns they’re chasing*: campaigns not ended, by title. `null` as `chasingMdrt`.',
  })
  campaigns!: { code: string; title: string }[] | null;
}

class RolledUpGoalDto implements RolledUpGoal {
  @ApiProperty({ type: Number, nullable: true, description: 'The rows’ targets summed; `null` when none holds one.' }) targetMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'The rows’ actuals summed; `null` when none holds one.' }) actualMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'From the sums, never averaged.' }) attainmentPct!: number | null;
  @ApiProperty({ description: 'Rows holding no actual, which the sum leaves out.' }) missing!: number;
}

class PotentialActiveDto {
  @ApiProperty({ description: '`POTENTIAL_MAA_COUNT_IN_UNIT`.' }) count!: number;
  @ApiProperty({ description: 'Everybody the group holds.' }) of!: number;
}

export class UnitTotalDto implements UnitTotal {
  @ApiProperty({ type: RolledUpGoalDto }) goal!: RolledUpGoal;
  @ApiProperty({ type: LeadCountsDto }) leadsCounts!: LeadCountsRow;
  @ApiProperty({ type: CountAgainstDto }) touches!: CountAgainst;
  @ApiProperty({ type: PotentialActiveDto }) potentialActive!: { count: number; of: number };
}

export class UnitGroupDto implements UnitGroup {
  @ApiProperty({ type: UnitRowDto }) head!: UnitRow;
  @ApiProperty({ type: [UnitRowDto], description: 'The head’s direct reports who lead nobody, A to Z.' }) members!: UnitRow[];
  @ApiProperty({ type: () => [UnitGroupDto], description: 'The head’s direct reports who lead somebody, A to Z, each with their own.' })
  units!: UnitGroup[];
  @ApiProperty({ type: UnitTotalDto, description: 'The head and everybody below them.' }) total!: UnitTotal;
}

class TeamTileDto {
  @ApiProperty({ description: 'Every row.' }) total!: number;
  @ApiProperty({ description: '*Your Unit*’s rows, the head included.' }) direct!: number;
  @ApiProperty({ description: 'The units below the head.' }) units!: number;
  @ApiProperty({ description: 'Everybody under those units’ heads.' }) underUnits!: number;
}

class GroupProductionTileDto extends RolledUpGoalDto {
  @ApiProperty({ enum: ['month', 'year'] }) period!: 'month' | 'year';
}

class PotentialRecruitsTileDto {
  @ApiProperty({ description: 'Recruitment leads promised this month across *Your Unit*.' }) yourUnit!: number;
  @ApiProperty({ description: 'The same across every unit below the head.' }) aabs!: number;
}

class UnitTilesDto {
  @ApiProperty({ type: TeamTileDto }) team!: UnitDashboardView['tiles']['team'];
  @ApiProperty({ type: GroupProductionTileDto }) directGroupProduction!: UnitDashboardView['tiles']['directGroupProduction'];
  @ApiProperty({ type: PotentialActiveDto }) potentialActive!: { count: number; of: number };
  @ApiProperty({ type: PotentialRecruitsTileDto }) potentialRecruits!: { yourUnit: number; aabs: number };
}

class YourUnitDto {
  @ApiProperty({ type: [UnitRowDto], description: 'The head first, then their direct reports on the agent rung who lead nobody, A to Z.' })
  rows!: UnitRow[];

  @ApiProperty({ type: UnitTotalDto }) total!: UnitTotal;
}

class UnitProductionStateDto {
  @ApiProperty({ example: '2026-09' }) month!: string;
  @ApiProperty({ description: 'The month’s revision: *Save all* sends it back.' }) revision!: number;
  @ApiProperty({ description: 'The agency has locked the month; its owner or an administrator reopens it.' }) locked!: boolean;
  @ApiProperty({ description: 'The reader may save corrections here, in this session, over a unit with rows.' }) canUpdate!: boolean;
}

/** *Chasing MDRT*'s header (P18.5-T7 AC-7). */
class UnitMdrtDto {
  @ApiProperty({ description: 'The agency’s `MDRT_QUALIFICATION` campaign is running now.' }) running!: boolean;
  @ApiProperty({
    example: 'Chasing MDRT (Million Dollar Round Table) this year — APE of Rp 2.400.000.000 or more.',
    description: 'The header tooltip, composed from that campaign’s requirement, or saying none is running.',
  })
  tooltip!: string;
}

class WindowDto {
  @ApiProperty({ example: '2026-09-01' }) from!: string;
  @ApiProperty({ example: '2026-09-14' }) to!: string;
}

export class UnitDashboardDto implements UnitDashboardView {
  @ApiProperty({ example: '2026-09-14', description: 'The agency’s today.' }) today!: string;
  @ApiProperty({ example: '2026-09' }) month!: string;
  @ApiProperty({ example: '2026' }) year!: string;
  @ApiProperty({ enum: UNIT_DASHBOARD.PERIODS }) period!: UnitDashboardPeriod;
  @ApiProperty({ type: WindowDto, description: 'The days the activity figures count, in the agency’s calendar.' }) window!: { from: string; to: string };
  @ApiProperty({ description: 'The agency’s `coachingOverdueDays`.' }) overdueAfterDays!: number;
  @ApiProperty({ type: UnitHeadDto }) head!: UnitPerson & { isReader: boolean };
  @ApiProperty({ description: 'The head leads nobody: no rows.' }) empty!: boolean;
  @ApiProperty({ type: UnitTilesDto }) tiles!: UnitDashboardView['tiles'];
  @ApiProperty({ type: YourUnitDto }) yourUnit!: { rows: UnitRow[]; total: UnitTotal };
  @ApiProperty({ type: [UnitGroupDto] }) units!: UnitGroup[];
  @ApiProperty({ type: UnitProductionStateDto }) production!: UnitDashboardView['production'];
  @ApiProperty({ type: UnitMdrtDto }) mdrt!: UnitDashboardView['mdrt'];
}

export class ProductionUpdatedDto implements ProductionUpdated {
  @ApiProperty({ description: 'People with at least one figure changed. A figure already holding the value changes nothing.' })
  updated!: number;

  @ApiProperty({ type: MonthStateDto }) state!: MonthState;
}
