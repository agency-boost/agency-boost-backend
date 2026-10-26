import { ApiProperty } from '@nestjs/swagger';
import { KPM_REPORTING, type KpmAnalyticsPeriod } from '@/domain/constants';
import type { Moc, MocCriterion } from '@/domain/metrics/moc-status';
import type { Rate } from '@/domain/metrics/rate';
import type { AnalyticsAgency, AnalyticsRow, Figures, KpmAnalyticsView } from './kpm-analytics.service';
import type {
  KpmOverviewView, NotLoggedView, OverviewAgency, OverviewLeader, OverviewUnit, RecruitTargetView, RungCount,
} from './kpm-overview.service';
import type { Money, Person } from './office-figures';
import type { OfficeHeader } from './office-people';
import type { Adoption, OfficeState, PlatformAnalyticsView } from './platform-analytics.service';

/** Declared for OpenAPI. The wire shapes live on the services' view types. */

// ------------------------------------------------------------------ shared

class PersonDto implements Person {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' }) membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
}

export class RungCountDto implements RungCount {
  @ApiProperty({ example: 'AB', description: 'The rung’s stable code on the company’s ladder.' }) code!: string;
  @ApiProperty({ example: 'AB', description: 'The ladder’s own label for it.' }) label!: string;
  @ApiProperty({ example: 8 }) count!: number;
}

export class RateDto implements Rate {
  @ApiProperty({ example: 112 }) count!: number;
  @ApiProperty({ example: 187, description: 'The group: one headcount for every denominator (OD-24).' }) of!: number;
  @ApiProperty({ type: Number, nullable: true, example: 60, description: 'A whole percent; `null` over nobody, never 0%.' })
  pct!: number | null;
}

export class MoneyDto implements Money {
  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units, from the agency’s file. `null` is *Not uploaded yet*, never zero.' })
  achievedMinor!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units: the sum of the members’ own goals (OD-143). `null` when nobody has one.' })
  targetMinor!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Achieved of target, a whole percent capped at 999; `null` without both.' })
  pct!: number | null;
}

export class ReportingThresholdsDto {
  @ApiProperty({
    example: KPM_REPORTING.STATUS_SPLIT_PCT,
    description: 'The attainment a row is coloured *success* at, and *alert* below (`KPM_Owner.html:3150`, `:3220`).',
  })
  statusSplitPct!: number;
}

class RungRefDto {
  @ApiProperty({ example: 'AGENT' }) code!: string;
  @ApiProperty({ example: 'Agent' }) label!: string;
}

// ------------------------------------------------------------------ the KPM Overview

class OfficeHeaderDto implements OfficeHeader {
  @ApiProperty({ example: 'Prudential' }) companyName!: string;
  @ApiProperty({ example: '0417' }) code!: string;
  @ApiProperty({ example: 'BSD City Branch' }) branch!: string;
}

class OverviewCompositionDto {
  @ApiProperty({ description: '`OFFICE_HEADCOUNT`: the active memberships now, every rung (OD-24).' }) total!: number;
  @ApiProperty({ description: '`OFFICE_NEW_MEMBERS_THIS_MONTH`: of them, the memberships that began this calendar month.' }) newThisMonth!: number;
  @ApiProperty({
    type: [RungCountDto],
    description: 'One per rung of the company’s ladder, senior first as drawn; an archived rung only while somebody '
      + 'stands on it. They sum to `total`.',
  })
  rungs!: RungCount[];
}

class LoggedThisMonthDto extends RateDto {
  @ApiProperty({
    type: Number, nullable: true,
    description: 'The same count for last month, from its first day to the same day of the month; `null` when '
      + 'the agency had nobody then.',
  })
  lastMonthToDate!: number | null;
}

class LoggedThisWeekDto {
  @ApiProperty({ description: 'Members with a day logged in the last 7 days, today included.' }) logged!: number;
  @ApiProperty() notLogged!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`ACTIVITY_COMPLIANCE_RATE`; `null` over nobody.' }) pct!: number | null;
}

class OverviewEngagementDto {
  @ApiProperty({
    type: LoggedThisMonthDto,
    description: '`ACTIVITY_LOGGED_THIS_MONTH` (*Agents who logged activity this month*): members who logged at least '
      + 'one activity this calendar month, over the headcount.',
  })
  loggedThisMonth!: KpmOverviewView['engagement']['loggedThisMonth'];

  @ApiProperty({ type: LoggedThisWeekDto }) loggedThisWeek!: KpmOverviewView['engagement']['loggedThisWeek'];
}

class LeaderboardRowDto extends PersonDto implements OverviewLeader {
  @ApiProperty({ description: 'Everybody below them now, at any depth.' }) teamSize!: number;
  @ApiProperty({ description: 'Of those, how many they led a 1:1 with in the last 7 days.' }) coached!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`LEADER_COACHING_FREQUENCY`, a whole percent.' }) pct!: number | null;
}

class OverviewCoachingDto {
  @ApiProperty({ type: RateDto, description: '`COACHING_COVERAGE` over the agency, coached in the last 7 days.' }) coverage7d!: Rate;
  @ApiProperty({ type: RateDto, description: 'The same over the last 30 days.' }) coverage30d!: Rate;
  @ApiProperty({
    type: [LeaderboardRowDto],
    description: 'Every AB who leads somebody, lowest share first. The whole ranking: the card shows four and expands.',
  })
  leaderboard!: OverviewLeader[];
}

class OverviewRecruitmentDto {
  @ApiProperty({ description: '`RECRUITMENT_EXPECTED_TO_CLOSE`: open candidates on a stage the agency ticked *Expected to close*.' })
  expectedToClose!: number;

  @ApiProperty({ description: '`RECRUITMENT_PIPELINE_NOW`: open candidates not on a closing stage.' }) pipelineNow!: number;
  @ApiProperty({ description: '`RECRUITMENT_CLOSED_LAST_MONTH`: candidates closed won last calendar month.' }) closedLastMonth!: number;
  @ApiProperty({
    type: Number, nullable: true,
    description: 'The month’s target, or the latest earlier month’s carried forward; `null` when none was ever set — no pill then.',
  })
  target!: number | null;

  @ApiProperty({ example: '2026-10', description: 'The month a target is set for: the agency’s current month.' }) targetMonth!: string;
}

class YearToDateDto extends MoneyDto {
  @ApiProperty({
    type: [String], example: ['2026-08'],
    description: 'The months the year to date is waiting on: this year’s months after the latest month the file holds, '
      + 'before the current one — every month before this one while none is held. A gap before the latest held month is '
      + 'not listed: that month’s year to date already covers it.',
  })
  missingMonths!: string[];

  @ApiProperty({ description: 'Members with no goal saved for the year: in no target.' }) membersWithoutGoal!: number;
}

class OverviewUnitDto extends PersonDto implements OverviewUnit {
  @ApiProperty({ type: Number, nullable: true }) achievedMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) targetMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pct!: number | null;
}

class OverviewAgencyDto extends OverviewUnitDto implements OverviewAgency {
  @ApiProperty({ type: [OverviewUnitDto], description: 'Each AAB who leads somebody, over their unit within the agency.' })
  aabUnits!: OverviewUnit[];
}

class OverviewProductionDto {
  @ApiProperty({ type: YearToDateDto, description: 'The agency’s year to date from its file, against the sum of its members’ goals.' })
  ytd!: KpmOverviewView['production']['ytd'];

  @ApiProperty({
    type: Number, nullable: true,
    description: '`APE_YEAR_PROJECTION`, IDR minor units: the year to date as of the latest month held, over that month’s '
      + 'number, run to twelve — a month with no file is still covered by the year to date; `null` until a month is held.',
  })
  projectionMinor!: number | null;

  @ApiProperty({
    type: [OverviewAgencyDto],
    description: 'Every AB agency (an AB under an AB is its own), lowest attainment first, a row with none last.',
  })
  agencies!: OverviewAgency[];
}

export class KpmOverviewDto implements KpmOverviewView {
  @ApiProperty({ type: OfficeHeaderDto }) office!: OfficeHeader;
  @ApiProperty({ example: '2026-10-09', description: 'Today in the agency’s calendar.' }) today!: string;
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ example: '2026' }) year!: string;
  @ApiProperty({ type: ReportingThresholdsDto }) thresholds!: { statusSplitPct: number };
  @ApiProperty({ type: OverviewCompositionDto }) composition!: KpmOverviewView['composition'];
  @ApiProperty({ type: OverviewEngagementDto }) engagement!: KpmOverviewView['engagement'];
  @ApiProperty({ type: OverviewCoachingDto }) coaching!: KpmOverviewView['coaching'];
  @ApiProperty({ type: OverviewRecruitmentDto }) recruitment!: KpmOverviewView['recruitment'];
  @ApiProperty({ type: OverviewProductionDto }) production!: KpmOverviewView['production'];
}

class NotLoggedMemberDto extends PersonDto {
  @ApiProperty({ type: RungRefDto }) rung!: { code: string; label: string };
  @ApiProperty({ type: String, nullable: true, example: '2026-09-30', description: 'Their latest day logged; `null` is *Never logged*.' })
  lastLoggedOn!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 9, description: 'Whole days since, in the agency’s calendar.' })
  daysSince!: number | null;
}

export class NotLoggedDto implements NotLoggedView {
  @ApiProperty({ example: 69, description: 'Everybody with no day logged in the last 7 days; the reveal’s *“+ {total − 3} more”*.' })
  total!: number;

  @ApiProperty({
    type: [NotLoggedMemberDto],
    description: 'The first three of them (`KPM_REPORTING.NOT_LOGGED_SHOWN`): never logged first, then the longest silent. '
      + 'The rest are the People screen’s.',
  })
  members!: NotLoggedView['members'];
}

export class RecruitTargetDto implements RecruitTargetView {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ example: 15 }) target!: number;
}

// ------------------------------------------------------------------ KPM analytics

class AnalyticsLeadsDto {
  @ApiProperty({ description: 'Open sales leads (`OPEN_SALES_LEADS`).' }) sales!: number;
  @ApiProperty({ description: 'Of them, promised for the period’s month.' }) salesPotential!: number;
  @ApiProperty({ description: 'Open recruitment candidates (`RECRUITMENT_PIPELINE_NOW`).' }) recruit!: number;
  @ApiProperty({ description: 'Of them, promised for the period’s month.' }) recruitPotential!: number;
}

class ManpowerDto {
  @ApiProperty() aab!: number;
  @ApiProperty() agents!: number;
  @ApiProperty({ description: 'Everybody in the row now, its head included (OD-24).' }) total!: number;
}

class AnalyticsFiguresDto implements Figures {
  @ApiProperty({
    type: MoneyDto,
    description: 'The period’s month’s APE from the file, against the monthly targets as fixed when it began — over '
      + 'the members the row had on the month’s last day, a member who has left since included.',
  })
  apeMonth!: Money;

  @ApiProperty({ type: MoneyDto, description: 'The year to date against the annual goals — today’s members, whatever the period.' })
  apeAnnual!: Money;

  @ApiProperty({ type: RateDto, description: '`COACHED_7D` over the row’s members today, its head included.' }) coached7d!: Rate;
  @ApiProperty({
    type: Number, nullable: true,
    description: '`MAA_COUNT_IN_UNIT` for the period’s month, over its members on the month’s last day; `null` is *Not uploaded yet*.',
  })
  activeAgents!: number | null;

  @ApiProperty({ type: AnalyticsLeadsDto, description: 'As they stood at the period’s end, over the members it had then.' })
  leads!: Figures['leads'];

  @ApiProperty({ type: ManpowerDto, description: 'Today’s members, whatever the period.' }) manpower!: Figures['manpower'];
}

class MocCriterionDto implements MocCriterion {
  @ApiProperty({ example: 'NET_APE', description: 'The metric the carrier’s rule names.' }) code!: string;
  @ApiProperty({ example: 'Net APE' }) label!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units for Net APE, a percent for persistency, a count otherwise; `null` is not uploaded.' })
  current!: number | null;

  @ApiProperty({ description: 'The carrier rule’s threshold, in the same unit.' }) required!: number;
  @ApiProperty({ type: Boolean, nullable: true, description: '`null` while its input is not uploaded — never ✕.' }) met!: boolean | null;
  @ApiProperty({ example: 'Jan – Sep 2026', description: 'What it was read over.' }) period!: string;
}

class MocDto implements Moc {
  @ApiProperty({ enum: ['met', 'not_met', 'unknown'] }) status!: Moc['status'];
  @ApiProperty({ example: 'Met via the standard three-criteria path.' }) path!: string;
  @ApiProperty({ type: [MocCriterionDto] }) criteria!: MocCriterion[];
  @ApiProperty({ type: String, nullable: true, description: 'What is not uploaded, when the status is `unknown`.' }) missing!: string | null;
}

class RowHeadDto extends PersonDto {
  @ApiProperty({ description: 'The row is the reader’s own: *(you)*.' }) isReader!: boolean;
  @ApiProperty({
    description: 'The head has at least one active direct report — a leader, so the row offers *Coach*. An AB '
      + 'leading nobody heads an agency of one, and is not offered it.',
  })
  leads!: boolean;
}

class AnalyticsRowDto extends AnalyticsFiguresDto implements AnalyticsRow {
  @ApiProperty({ type: RowHeadDto }) head!: AnalyticsRow['head'];
}

class AnalyticsUnitRowDto extends AnalyticsRowDto {
  @ApiProperty({ type: MocDto, nullable: true, description: 'The AAB’s MOC; `null` when the company has no rule for the rung.' })
  moc!: Moc | null;
}

class ClubDto {
  @ApiProperty({ example: 'STAR_CLUB' }) code!: string;
  @ApiProperty({ example: 'Star Club' }) label!: string;
}

class AnalyticsMemberDto extends PersonDto {
  @ApiProperty({ type: RungRefDto }) rung!: { code: string; label: string };
}

class AnalyticsAgencyDto extends AnalyticsRowDto implements AnalyticsAgency {
  @ApiProperty({ type: ClubDto, nullable: true, description: '`PRODUCTION_CLUB_TIER` over the agency’s year to date, the highest tier only.' })
  club!: { code: string; label: string } | null;

  @ApiProperty({ type: MocDto, nullable: true, description: '`MOC_STATUS` for the AB.' }) moc!: Moc | null;
  @ApiProperty({ type: AnalyticsRowDto, description: '*(Direct)*: the AB and the members in no AAB’s unit.' }) direct!: AnalyticsRow;
  @ApiProperty({ type: [AnalyticsUnitRowDto] }) aabUnits!: AnalyticsAgency['aabUnits'];
  @ApiProperty({ type: [AnalyticsMemberDto], description: 'The manpower toggle: the agency’s people other than the AB.' })
  members!: AnalyticsAgency['members'];
}

class AnalyticsTotalDto extends AnalyticsFiguresDto {
  @ApiProperty({ description: 'The rows: *"Total — all {n} ABs"*.' }) abCount!: number;
  @ApiProperty({ description: 'ABs meeting MOC.' }) mocMet!: number;
  @ApiProperty({ description: 'ABs with a MOC evaluated.' }) mocOf!: number;
  @ApiProperty({
    type: Number, nullable: true,
    description: 'IDR minor units: the year to date of members who left this year — the agency’s, in no row, so the '
      + 'total’s *APE — Annual* is short of the Overview’s by it. `null` when no leaver holds a figure.',
  })
  leaversExcludedMinor!: number | null;
}

class MonthlyProductionDto {
  @ApiProperty({ example: '2026-04' }) month!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'The agency’s APE for the month from its file; `null` is a gap, no file.' })
  apeMinor!: number | null;
}

export class KpmAnalyticsDto implements KpmAnalyticsView {
  @ApiProperty({ enum: KPM_REPORTING.ANALYTICS_PERIODS }) period!: KpmAnalyticsPeriod;
  @ApiProperty({ example: '2026-10', description: 'The period’s month.' }) month!: string;
  @ApiProperty({ type: ReportingThresholdsDto }) thresholds!: { statusSplitPct: number };
  @ApiProperty({
    example: 'AAB: Net APE ≥ Rp 200 jt AND Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75,0%.\nAB: (Net APE ≥ Rp 600 jt AND '
      + 'Monthly2 AA DU ≥ 4 / DG ≥ 6 AND Rolling Persistency DU/DG ≥ 75,0%) OR Direct AB (AB on AB) ≥ 5.',
    description: 'The MOC column’s tooltip, composed from the company’s MOC rules: a line per rule, the junior rung '
      + 'first, separated by `\\n`. Empty when the company has none.',
  })
  mocRulesText!: string;

  @ApiProperty({ type: [AnalyticsAgencyDto], description: 'One row per AB agency, A to Z; the rows partition the agency’s members.' })
  agencies!: AnalyticsAgency[];

  @ApiProperty({ type: AnalyticsTotalDto, description: 'The sum of the rows, a percentage from the sums.' })
  total!: KpmAnalyticsView['total'];

  @ApiProperty({ type: [MonthlyProductionDto], description: 'The six months before this one, oldest first.' })
  monthly!: KpmAnalyticsView['monthly'];
}

// ------------------------------------------------------------------ Cross-platform analytics

export class AdoptionDto implements Adoption {
  @ApiProperty({
    description: 'On an office’s row, its active memberships now. On a company’s and the platform’s, the **people**: '
      + 'distinct accounts among those memberships, so somebody in two offices counts once there.',
  })
  members!: number;

  @ApiProperty({
    type: [RungCountDto],
    description: 'Active memberships by rung of the company’s ladder, senior first — on every row the offices’ sum.',
  })
  byRung!: RungCount[];

  @ApiProperty({ description: 'Memberships that began this calendar month — on every row the offices’ sum.' }) joinedThisMonth!: number;
  @ApiProperty({ description: 'Memberships removed this calendar month — on every row the offices’ sum.' }) leftThisMonth!: number;
  @ApiProperty({
    description: 'Of `members`, who signed in within the last 7 days: memberships on an office’s row, accounts on a '
      + 'company’s and the platform’s.',
  })
  signedIn7d!: number;

  @ApiProperty({ description: 'The same, within the last 30 days.' }) signedIn30d!: number;
}

class PlatformCompanyRefDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Prudential' }) name!: string;
}

class PlatformOfficeAdoptionDto extends AdoptionDto {
  @ApiProperty() kpmId!: string;
  @ApiProperty({ example: '0417' }) code!: string;
  @ApiProperty({ example: 'BSD City Branch' }) branch!: string;
  @ApiProperty({ type: PlatformCompanyRefDto }) company!: { id: string; name: string };
  @ApiProperty({
    enum: ['active', 'suspended', 'archived', 'ended', 'ended_kept_active'],
    description: 'The office’s state as *All KPMs* lists it.',
  })
  state!: OfficeState;
}

class PlatformCompanyAdoptionDto extends AdoptionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Prudential' }) name!: string;
  @ApiProperty() offices!: number;
}

class PlatformAdoptionDto extends AdoptionDto {
  @ApiProperty() offices!: number;
  @ApiProperty() companies!: number;
}

export class PlatformAnalyticsDto implements PlatformAnalyticsView {
  @ApiProperty({ example: '2026-10', description: 'The calendar month *joined* and *left* count, in Asia/Jakarta.' }) month!: string;
  @ApiProperty({ type: [PlatformOfficeAdoptionDto], description: 'One per office, by company then code.' })
  offices!: PlatformAnalyticsView['offices'];

  @ApiProperty({ type: [PlatformCompanyAdoptionDto] }) companies!: PlatformAnalyticsView['companies'];
  @ApiProperty({ type: PlatformAdoptionDto }) platform!: PlatformAnalyticsView['platform'];
}
