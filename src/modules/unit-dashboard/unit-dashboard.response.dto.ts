import { ApiProperty } from '@nestjs/swagger';
import { UNIT_DASHBOARD, type UnitDashboardPeriod, type UnitView } from '@/domain/constants';
import { GOAL_PACE_STATUSES, type GoalPaceStatus } from '@/domain/metrics/goal-pace-status';
import type { CountAgainst, LeadCountsRow, PairedGoal } from '@/domain/metrics/unit-rollup';
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

/** The views a head is offered, and the reader's default (ADR-0249 §1). */
export class UnitScopesDto {
  @ApiProperty({
    enum: UNIT_DASHBOARD.VIEWS, isArray: true,
    description: 'In the order drawn. *Grup langsung* while the head leads somebody; *Grup informal* while they own a live '
      + 'group or have an AB below them; *Semua downline* while an AB is below them, and always for the owner or an '
      + 'administrator on their own dashboard. The picker is hidden with one view or none.',
  })
  offered!: UnitView[];

  @ApiProperty({
    enum: UNIT_DASHBOARD.VIEWS,
    description: 'What a read without `scope` answers: the owner’s own dashboard `downline`; an administrator’s `direct` '
      + 'while they lead somebody, else `downline`; every leader’s, and every view of another leader’s unit, `direct`.',
  })
  default!: UnitView;
}

class UnitGroupRefDto {
  @ApiProperty() groupId!: string;
  @ApiProperty({ example: 'Top Producers 2026' }) name!: string;
}

/** *Grup informal*'s line (ADR-0249 §4). */
export class UnitInformalDto {
  @ApiProperty({
    type: [UnitGroupRefDto],
    description: 'The live groups the head owns, A to Z — where *+ Tambah ke grup* tags somebody. Empty: none yet.',
  })
  groups!: { groupId: string; name: string }[];

  @ApiProperty({
    description: '`ABS_NOT_IN_INFORMAL_GROUP`: the active ABs below the head tagged into no live group the head owns — '
      + '*“{n} AB di bawah Anda belum masuk grup”*.',
  })
  absNotInGroup!: number;

  @ApiProperty({
    type: [UnitPersonDto], nullable: true,
    description: 'Those ABs, A to Z — only to a reader who may tag people into groups (`member:tag_group`); `null` otherwise.',
  })
  abs!: UnitPerson[] | null;

  @ApiProperty({ description: 'The reader may tag people into groups: *+ Tambah ke grup* is drawn. The API refuses it too.' })
  canTag!: boolean;
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

/** A campaign a row's person is chasing: the chip's words, and its address (P18.2-T7 AC-8). */
class UnitChasedCampaignDto {
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
}

export class UnitRowDto implements UnitRow {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Rina Wijaya' }) name!: string;
  @ApiProperty({
    type: String, nullable: true,
    description: 'UI V1 (UI-111): their profile photo, when they have one, as a signed link (`users.avatarUrl`); the row draws initials otherwise.',
  })
  photoUrl!: string | null;
  @ApiProperty({
    type: String, nullable: true, example: '+6281234567890',
    description: 'The WhatsApp number on their account, for the row’s WhatsApp button. `null` without one, '
      + 'and always on the reader’s own row, for an inactive membership, and in the agency’s read-only view of another '
      + 'leader’s unit.',
  })
  phone!: string | null;
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
  @ApiProperty({
    description: '*Closing* (UI-028; O-4): their sales leads that reached *Paid and issued* within `window`, on the agency’s '
      + 'calendar — each lead counted on its first move there.',
  }) closings!: number;
  @ApiProperty({
    description: '*Proposal* (`PROPOSALS_MADE`): their live proposals first saved as a PDF within `window`, on the '
      + 'agency’s calendar. A count, and nothing about any client, product or premium.',
  }) proposalsMade!: number;
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
    description: '*New hire*: a new hire with no first sale by today (`COUNTS_FOR_PRODUCTION` false). In the team, tagged '
      + 'on the roster, and left out of every total’s goal and *On pace to be active*. `false` from the first sale’s day.',
  })
  newHireBeforeFirstSale!: boolean;

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

/**
 * **Paired**: a row's target counts only when its production for the period is held, and the actual is the same rows'
 * production — so a file not uploaded yet is left out of both, and named, rather than counted as 0.
 */
class PairedGoalDto implements PairedGoal {
  @ApiProperty({
    type: Number, nullable: true,
    description: 'The targets of the rows whose production is held, summed — every target held when no row’s production is; '
      + '`null` when none holds one.',
  }) targetMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'The rows’ actuals summed; `null` when none holds one: *Not uploaded yet*.' }) actualMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'From the paired sums, never averaged.' }) attainmentPct!: number | null;
  @ApiProperty({
    description: 'Rows holding no actual, which both sums leave out. A new hire before a first sale is not one: they are '
      + 'left out by `newHires`.',
  }) missing!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'How far the actual is short of the target; 0 when met; `null` without both.' }) gapMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'How far the actual is over the target; 0 when short; `null` without both.' }) overMinor!: number | null;
}

class PotentialActiveDto {
  @ApiProperty({
    description: '`POTENTIAL_MAA_COUNT_IN_UNIT`: who is pacing to an active month, among the people who count for production.',
  }) count!: number;
  @ApiProperty({
    description: 'Manpower (UI-013): everybody the group holds, its head and every new hire included — the same number as *Your team*.',
  }) of!: number;
}

class ActiveAgentTileDto extends PotentialActiveDto {
  @ApiProperty({
    type: PotentialActiveDto,
    description: '*Unit*: the head and their direct agents — the rows of `yourUnit` (UI-013, D-16).',
  }) unit!: { count: number; of: number };
  @ApiProperty({
    type: PotentialActiveDto,
    description: '*AAB*: the rest of the head’s direct group — every AAB unit below the head, its head included.',
  }) aab!: { count: number; of: number };
  @ApiProperty({
    type: PotentialActiveDto,
    description: '*AB*: everybody on the roster outside the head’s direct group — an AB below the head and their people; none '
      + 'in *Grup langsung*. `unit`, `aab` and `ab` add up to the total; an AB is never counted as an AAB.',
  }) ab!: { count: number; of: number };
}

export class UnitTotalDto implements UnitTotal {
  @ApiProperty({ type: PairedGoalDto, description: 'Over the people who count for production: no new hire before a first sale.' })
  goal!: PairedGoal;
  @ApiProperty({ type: LeadCountsDto }) leadsCounts!: LeadCountsRow;
  @ApiProperty({ description: 'The rows’ *Closing* summed (UI-028).' }) closings!: number;
  @ApiProperty({ description: 'The rows’ *Proposal* summed.' }) proposalsMade!: number;
  @ApiProperty({ type: CountAgainstDto }) touches!: CountAgainst;
  @ApiProperty({ type: PotentialActiveDto }) potentialActive!: { count: number; of: number };
  @ApiProperty({
    description: 'New hires before a first sale whom `goal` leaves out, and `potentialActive.count` (never its `of`, UI-013).',
  }) newHires!: number;
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
  @ApiProperty({
    description: '*AAB*’s chip: the rows of the head’s direct group outside *Your Unit*. `direct`, `aab` and `ab` add up to `total`.',
  }) aab!: number;
  @ApiProperty({
    description: '*AB*’s chip, drawn while above 0: the rows outside the head’s direct group — an AB below the head and their '
      + 'people, in *Grup informal* and *Semua downline*; office-wide, other roots’ trees and *Belum punya leader* too.',
  }) ab!: number;
  @ApiProperty({
    description: 'Of `total`, the new hires before a first sale: in the team, left out of *Direct Group production*, and '
      + 'in *Active Agent*’s `of` though never its `count` (UI-013).',
  }) newHires!: number;
}

class GroupProductionTileDto extends PairedGoalDto {
  @ApiProperty({ enum: ['month', 'year'] }) period!: 'month' | 'year';
}

class PotentialRecruitsTileDto {
  @ApiProperty({ description: 'Recruitment leads promised this month across *Your Unit*.' }) yourUnit!: number;
  @ApiProperty({ description: 'The same across the rest of the head’s direct group.' }) aabs!: number;
  @ApiProperty({ description: 'The same across the rows outside the head’s direct group; 0 in *Grup langsung*.' }) abs!: number;
}

class UnitTilesDto {
  @ApiProperty({ type: TeamTileDto }) team!: UnitDashboardView['tiles']['team'];
  @ApiProperty({ type: GroupProductionTileDto }) directGroupProduction!: UnitDashboardView['tiles']['directGroupProduction'];
  @ApiProperty({
    type: ActiveAgentTileDto,
    description: '*Active Agent* (UI-013): pacing of manpower, with its *Unit* and *AAB* split.',
  }) potentialActive!: UnitDashboardView['tiles']['potentialActive'];
  @ApiProperty({ type: PotentialRecruitsTileDto }) potentialRecruits!: { yourUnit: number; aabs: number; abs: number };
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

/** *Chasing MDRT*'s header (P18.2-T7 AC-7). */
class UnitMdrtDto {
  @ApiProperty({ description: 'The agency’s `MDRT_QUALIFICATION` campaign is running now.' }) running!: boolean;
  @ApiProperty({
    example: 'Chasing MDRT (Million Dollar Round Table) this year — APE of Rp 2,4 M or more.',
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
  @ApiProperty({
    description: 'The Owner or an Admin reading another leader’s unit (`for`): drawn as that leader sees it, with no write '
      + 'control, and a save naming it is refused (UI-152).',
  })
  readOnly!: boolean;
  @ApiProperty({ type: UnitTilesDto }) tiles!: UnitDashboardView['tiles'];
  @ApiProperty({ type: YourUnitDto }) yourUnit!: { rows: UnitRow[]; total: UnitTotal };
  @ApiProperty({ type: [UnitGroupDto] }) units!: UnitGroup[];
  @ApiProperty({
    type: YourUnitDto, nullable: true,
    description: '*Belum punya leader*: in the owner’s or an administrator’s own *Semua downline*, the agency’s people with '
      + 'no leader there who lead nobody, A to Z, and their total. `null` otherwise.',
  })
  unled!: { rows: UnitRow[]; total: UnitTotal } | null;
  @ApiProperty({
    enum: UNIT_DASHBOARD.VIEWS,
    description: 'The view this answer is over: `direct` (*Grup langsung*: the head and everybody below them, never '
      + 'descending into an AB), `informal` (*Grup informal*: that, and each AB below the head tagged into a live group '
      + 'they own, with that AB’s own direct group) or `downline` (*Semua downline*: everybody below the head; the whole '
      + 'agency for its owner or an administrator on their own dashboard).',
  })
  scope!: UnitView;
  @ApiProperty({ type: UnitScopesDto }) scopes!: UnitDashboardView['scopes'];
  @ApiProperty({ type: UnitInformalDto, nullable: true, description: 'In `informal` only; `null` in any other view.' })
  informal!: UnitDashboardView['informal'];
  @ApiProperty({ type: UnitProductionStateDto }) production!: UnitDashboardView['production'];
  @ApiProperty({ type: UnitMdrtDto }) mdrt!: UnitDashboardView['mdrt'];
  @ApiProperty({
    type: String, nullable: true, example: '2026-10-28',
    description: '*Last updated* (UI-028): the agency’s day of its newest standing production import, of any month; `null` '
      + 'while it has none.',
  })
  lastUpload!: string | null;
}

export class ProductionUpdatedDto implements ProductionUpdated {
  @ApiProperty({ description: 'People with at least one figure changed. A figure already holding the value changes nothing.' })
  updated!: number;

  @ApiProperty({ type: MonthStateDto }) state!: MonthState;
}
