import { ApiProperty } from '@nestjs/swagger';
import { KPM_REPORTING, type KpmAnalyticsPeriod } from '@/domain/constants';
import type { Moc, MocCriterion } from '@/domain/metrics/moc-status';
import type { Rate } from '@/domain/metrics/rate';
import type { AnalyticsAgency, AnalyticsLeader, AnalyticsRow, Figures, KpmAnalyticsView } from './kpm-analytics.service';
import type {
  KpmOverviewView, NotLoggedView, OverviewAgency, OverviewLeader, OverviewUnit, RecruitTargetView, RungCount,
} from './kpm-overview.service';
import { REVIEWED_PAGES, SETUP_MARK_VIAS, type ReviewedPage } from './kpm-setup-mark.schema';
import {
  SETUP_STEPS, type ReviewedView, type SettingsWaiting, type SetupStep, type SetupView,
} from './kpm-setup.service';
import type { Money, Person } from './office-figures';
import type { OfficeGroup } from './office-groups';
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

class ActiveThisMonthDto {
  @ApiProperty({
    type: Number, nullable: true, example: 18,
    description: '`MAA_COUNT_IN_UNIT` over the agency for the current calendar month: members whose upload for the month shows '
      + 'APE > 0 or # of policy > 0 (D1). `null` while the month is not uploaded — *–*, *Belum diunggah*, never 0. Logging '
      + 'changes nothing in it.',
  })
  count!: number | null;

  @ApiProperty({ example: 28, description: 'Today’s headcount (`OFFICE_HEADCOUNT`, D3): the members with status *Aktif*.' }) of!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`count` over `of`, a whole percent; `null` with `count`, or over nobody.' })
  pct!: number | null;

  @ApiProperty({ example: '2026-11', description: 'The month counted: the agency’s current calendar month, *bulan ini*.' }) month!: string;
  @ApiProperty({
    type: String, nullable: true, example: '2026-11-03',
    description: 'The agency’s day the month’s rows were last written, by an import or a correction (D8, *per 3 Nov*); '
      + '`null` while the month is not uploaded.',
  })
  asOf!: string | null;
}

class LoggedThisWeekDto {
  @ApiProperty({ description: 'Members with a day logged in the last 7 days, today included.' }) logged!: number;
  @ApiProperty() notLogged!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`ACTIVITY_COMPLIANCE_RATE`; `null` over nobody.' }) pct!: number | null;
}

class OverviewEngagementDto {
  @ApiProperty({
    type: ActiveThisMonthDto,
    description: '*Aktif bulan ini* (ADR-0200 §2): production in the agency’s file for the current month, over the '
      + 'headcount — the Overview’s first tile.',
  })
  activeThisMonth!: KpmOverviewView['engagement']['activeThisMonth'];

  @ApiProperty({
    type: LoggedThisWeekDto,
    description: '*Pengguna aktif* over the rolling 7 days: the first tile’s *7 hari: n belum ›*, which opens *Belum mencatat · '
      + '7 hari*. The only logging figure the Overview serves (ADR-0200 §3).',
  })
  loggedThisWeek!: KpmOverviewView['engagement']['loggedThisWeek'];
}

class LeaderboardRowDto extends PersonDto implements OverviewLeader {
  @ApiProperty({ description: 'Everybody below them now, at any depth; 0 for an AB who leads nobody.' }) teamSize!: number;
  @ApiProperty({ description: 'Of those, how many they led a 1:1 with in the last 7 days.' }) coached!: number;
  @ApiProperty({
    type: Number, nullable: true,
    description: '`LEADER_COACHING_FREQUENCY`, a whole percent rounded half up in integers; `null` for an AB who leads nobody — '
      + 'no rate, never 0%.',
  })
  pct!: number | null;

  @ApiProperty({
    description: 'They have an active direct report (ADR-0087). `false` is an AB who leads nobody: listed last, read as *No team*.',
  })
  leads!: boolean;
}

class OverviewCoachingDto {
  @ApiProperty({ type: RateDto, description: '`COACHING_COVERAGE` over the agency, coached in the last 7 days.' }) coverage7d!: Rate;
  @ApiProperty({ type: RateDto, description: 'The same over the last 30 days.' }) coverage30d!: Rate;
  @ApiProperty({
    type: [LeaderboardRowDto],
    description: 'Every member of the `ab` class: those who lead somebody lowest share first, then those who lead nobody '
      + '(`leads: false`), A to Z. The whole ranking: the card shows four and expands.',
  })
  leaderboard!: OverviewLeader[];
}

class OverviewRecruitmentDto {
  @ApiProperty({ description: '`RECRUITMENT_EXPECTED_TO_CLOSE`: open candidates on a stage the agency ticked *Expected to close*.' })
  expectedToClose!: number;

  @ApiProperty({ description: '`RECRUITMENT_PIPELINE_NOW`: open candidates not on a closing stage.' }) pipelineNow!: number;
  @ApiProperty({
    type: Number, nullable: true,
    description: '`RECRUITMENT_CLOSED_LAST_MONTH`, *Recruitment last month* (D2): the upload’s `RECRUITMENT` for the previous '
      + 'calendar month, summed over the agency’s rows, a leaver’s included; `null` (*–*) when not uploaded. Never a lead.',
  })
  closedLastMonth!: number | null;
  @ApiProperty({
    type: Number, nullable: true,
    description: 'The month’s target, or the latest earlier month’s carried forward; `null` when none was ever set — no pill then.',
  })
  target!: number | null;

  @ApiProperty({ example: '2026-10', description: 'The month a target is set for: the agency’s current month.' }) targetMonth!: string;
}

class YearToDateDto extends MoneyDto {
  @ApiProperty({
    type: [String], example: ['2026-10', '2026-11'],
    description: 'The months the year to date is waiting on **that are still open for upload** (UI-150): from `from`, after '
      + 'the latest month the file holds, the current month included while it is not uploaded, each still open (ADR-0050). '
      + 'A gap before the latest held month is not listed — that month’s year to date already covers it — and neither is a '
      + 'month locked or before the KPM’s first.',
  })
  missingMonths!: string[];

  @ApiProperty({
    example: '2026-01',
    description: 'The first month *this year* counts: January, or the KPM’s first month when it began this year (UI-150, '
      + 'Overview R3).',
  })
  from!: string;

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
    description: '`APE_YEAR_PROJECTION`, IDR minor units: the year to date as of the latest month held **that has ended**, '
      + 'over that month’s number, run to twelve — a month with no file is still covered by the year to date, and the '
      + 'current month, uploaded mid-month, never enters it (D8); `null` until such a month is held.',
  })
  projectionMinor!: number | null;

  @ApiProperty({
    type: String, nullable: true, example: '2026-10',
    description: 'The month the projection runs from: the latest month of the year held before the current one; `null` with the projection.',
  })
  projectionThrough!: string | null;

  @ApiProperty({
    type: [OverviewAgencyDto],
    description: 'Every AB agency (an AB under an AB is its own), lowest attainment first, a row with none last.',
  })
  agencies!: OverviewAgency[];
}

class SetupStepDto {
  @ApiProperty({ enum: SETUP_STEPS, description: 'In the card’s order: the four settings pages, then *Impor anggota*, *Unggah produksi*, *Atur target rekrutmen*.' })
  key!: SetupStep;

  @ApiProperty({
    description: 'Steps 1–4: the page was saved or marked *Sudah sesuai*. 5: a member besides the Owner. 6: any production '
      + 'upload. 7: a recruitment target set.',
  })
  done!: boolean;
}

class OpenMonthDto {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ example: '2026-12-07', description: 'The last day it may be uploaded, in the agency’s calendar (ADR-0050).' })
  closesOn!: string;
}

class SetupDto implements SetupView {
  @ApiProperty({ example: 3, description: '*n dari 7 selesai*.' }) done!: number;
  @ApiProperty({ type: [SetupStepDto] }) steps!: SetupView['steps'];
  @ApiProperty({ description: 'The agency’s address and contact phone are both filled: step 1’s meta.' }) branchFilled!: boolean;
  @ApiProperty({ example: 1, description: 'Today’s headcount: step 5’s meta.' }) members!: number;
  @ApiProperty({
    type: OpenMonthDto, nullable: true,
    description: 'Step 6: the earliest month still open and not uploaded, or this month while it is open; `null` with neither.',
  })
  openMonth!: SetupView['openMonth'];

  @ApiProperty({ type: Number, nullable: true, description: 'The recruitment target standing for this month: step 7’s meta.' })
  target!: number | null;
}

class SettingsWaitingDto implements SettingsWaiting {
  @ApiProperty({ example: 2, description: 'Products whose own script or description waits for approval: *2 produk menunggu Anda*.' })
  productsAwaiting!: number;

  @ApiProperty({
    type: Number, nullable: true, example: 2,
    description: 'The version an unpublished activation checklist draft will be (*Draf versi 2*); `null` with no draft saved.',
  })
  checklistDraftVersion!: number | null;
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
  @ApiProperty({
    type: SetupDto, nullable: true,
    description: '*Siapkan KPM* (UI-149): the seven steps while any is open; `null` once all seven are done, stored, so the '
      + 'card never comes back.',
  })
  setup!: SetupView | null;

  @ApiProperty({ type: SettingsWaitingDto, description: 'What waits for the Owner on the settings pages: *Pengaturan KPM ›*’s line.' })
  settings!: SettingsWaiting;
}

class NotLoggedMemberDto extends PersonDto {
  @ApiProperty({ type: RungRefDto }) rung!: { code: string; label: string };
  @ApiProperty({ type: String, nullable: true, example: '2026-09-30', description: 'Their latest day logged; `null` is *Never logged*.' })
  lastLoggedOn!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 9, description: 'Whole days since, in the agency’s calendar.' })
  daysSince!: number | null;

  @ApiProperty({ type: PersonDto, nullable: true, description: 'Their leader now (*Agent · ke Sari*); `null` at the top of the tree.' })
  leader!: Person | null;

  @ApiProperty({
    type: String, nullable: true, example: '+6281234567890',
    description: 'Their WhatsApp number, for the reminder (UI-101, D-22); `null` when none is on file.',
  })
  phone!: string | null;
}

export class NotLoggedDto implements NotLoggedView {
  @ApiProperty({ example: 8, description: 'Everybody with no day logged in the last 7 days: *Belum mencatat · 7 hari*’s *n dari N*.' })
  total!: number;

  @ApiProperty({
    type: [NotLoggedMemberDto],
    description: 'The first five of them (`KPM_REPORTING.NOT_LOGGED_SHOWN`): never logged first, then the longest silent, '
      + 'each recorded as read. The rest are the People screen’s.',
  })
  members!: NotLoggedView['members'];
}

export class RecruitTargetDto implements RecruitTargetView {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ example: 15 }) target!: number;
}

/** `PUT /kpm/settings/:page/reviewed` (P19.3-T2): the page's step, ticked. */
export class ReviewedDto implements ReviewedView {
  @ApiProperty({ enum: REVIEWED_PAGES }) page!: ReviewedPage;
  @ApiProperty({ enum: [true] }) reviewed!: true;
  @ApiProperty({ example: '2026-11-03T02:15:00.000Z', description: 'When the step first ticked: this tap, an earlier one or a save.' })
  at!: string;

  @ApiProperty({ enum: SETUP_MARK_VIAS, description: 'How it first ticked: `reviewed` (*Sudah sesuai*), `saved`, or `migration`.' })
  via!: ReviewedView['via'];
}

// ------------------------------------------------------------------ KPM analytics

class AnalyticsLeadsDto {
  @ApiProperty({ description: 'Open sales leads (`OPEN_SALES_LEADS`).' }) sales!: number;
  @ApiProperty({ description: 'Of them, promised for the period’s month.' }) salesPotential!: number;
  @ApiProperty({ description: 'Open recruitment candidates (`RECRUITMENT_PIPELINE_NOW`).' }) recruit!: number;
  @ApiProperty({ description: 'Of them, promised for the period’s month.' }) recruitPotential!: number;
}

class ManpowerDto {
  @ApiProperty({ description: 'Members of the `ab` class (D3): the split *x AB · y AAB · z Agents*, the AB counted once, as AB.' })
  ab!: number;

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

  @ApiProperty({
    type: MoneyDto,
    description: '*APE YTD*: the year to date from the agency’s file against the annual goals — today’s members, whatever the '
      + 'period. (The field keeps its name; the column is *APE YTD*, never *Annual*.)',
  })
  apeAnnual!: Money;

  @ApiProperty({ type: RateDto, description: '`COACHED_7D` over the row’s members today, its head included.' }) coached7d!: Rate;
  @ApiProperty({
    type: Number, nullable: true,
    description: '`MAA_COUNT_IN_UNIT` for the period’s month, over its members on the month’s last day; `null` is *Not uploaded yet*.',
  })
  activeAgents!: number | null;

  @ApiProperty({
    type: Number, nullable: true, example: 68,
    description: '*Producing this month*’s share: `activeAgents` over the members it counts from — `manpower.total` for '
      + '`this_month`, the month’s members on its last day for `previous_month` (OD-235), so never above 100 — a whole '
      + 'percent rounded half up in integers (`rateOver`); `null` while the month is not uploaded, or over nobody.',
  })
  activePct!: number | null;

  @ApiProperty({
    example: 31,
    description: 'The members `activePct` is over (OD-235): `manpower.total` for `this_month`, the month’s members on its '
      + 'last day for `previous_month`, a leaver since included — so the cell writes its count over the same members as '
      + 'its percent. Served whether or not the month is uploaded.',
  })
  activeOf!: number;

  @ApiProperty({ type: AnalyticsLeadsDto, description: 'As they stood at the period’s end, over the members it had then.' })
  leads!: Figures['leads'];

  @ApiProperty({ type: ManpowerDto, description: 'Today’s members, whatever the period.' }) manpower!: Figures['manpower'];
}

class MocCriterionDto implements MocCriterion {
  @ApiProperty({
    example: 'MOC_APE',
    description: 'The metric the carrier’s rule names — a stored `NET_APE` reads as `MOC_APE`, the metric that took its place.',
  })
  code!: string;

  @ApiProperty({ example: 'APE' }) label!: string;
  @ApiProperty({
    type: Number, nullable: true,
    description: 'IDR minor units for APE, a percent for persistency (the leader’s uploaded unit persistency), a count — exact, '
      + 'Monthly2 AA an average — otherwise; `null` is not uploaded.',
  })
  current!: number | null;

  @ApiProperty({ description: 'The carrier rule’s threshold, in the same unit.' }) required!: number;
  @ApiProperty({ type: Boolean, nullable: true, description: '`null` while its input is not uploaded — never ✕.' }) met!: boolean | null;
  @ApiProperty({
    example: 'Jan – Sep 2026',
    description: 'What it was read over — for Direct AB, *based on today’s upline* (*berdasarkan upline saat ini*).',
  })
  period!: string;
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
  @ApiProperty({ description: 'The AB agencies (the MOC tile’s base).' }) abCount!: number;
  @ApiProperty({ description: 'ABs meeting MOC.' }) mocMet!: number;
  @ApiProperty({ description: 'ABs with a MOC evaluated.' }) mocOf!: number;
}

class MonthlyProductionDto {
  @ApiProperty({ example: '2026-04' }) month!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'The agency’s APE for the month from its file; `null` is a gap, no file.' })
  apeMinor!: number | null;
}

class ActiveCountDto {
  @ApiProperty({ type: Number, nullable: true, description: '`MAA_COUNT_IN_UNIT` over these members; `null` is *Not uploaded yet*.' })
  count!: number | null;

  @ApiProperty({ description: 'The members it is out of: today’s for `this_month`, the month’s on its last day otherwise.' })
  of!: number;
}

class LeaderActiveDto extends ActiveCountDto {
  @ApiProperty({ type: Number, nullable: true, description: 'A whole percent (`rateOver`); `null` not uploaded, or over nobody.' })
  pct!: number | null;

  @ApiProperty({ type: ActiveCountDto, description: '*Unit*: the leader and their direct agents who lead nobody.' })
  unit!: { count: number | null; of: number };

  @ApiProperty({ type: ActiveCountDto, description: '*AAB*: the rest of the Group — every AAB below and their people.' })
  aab!: { count: number | null; of: number };
}

class AnalyticsLeaderDto implements AnalyticsLeader {
  @ApiProperty({ type: RowHeadDto }) head!: AnalyticsLeader['head'];
  @ApiProperty({ enum: ['ab', 'aab'], description: 'The class (ADR-0156): the row’s pill and the chips’ count.' }) role!: 'ab' | 'aab';
  @ApiProperty({
    description: 'The reader may open this leader’s Unit Dashboard and Group Tree: the Owner and an Admin any leader’s, a '
      + 'Core Leader their own and those below them — the reach those reads answer, 404 outside it.',
  })
  opens!: boolean;
  @ApiProperty({ type: PersonDto, nullable: true, description: '*Leader dari*: the leader’s upline today; `null` for a root.' })
  above!: Person | null;

  @ApiProperty({ example: 12, description: '*Group* (ADR-0204 §2): the leader and everybody below them today — the Unit Dashboard’s team.' })
  group!: number;

  @ApiProperty({ example: 4, description: '*Unit*: the leader and their direct agents who lead nobody.' }) unit!: number;
  @ApiProperty({
    type: ManpowerDto,
    description: 'The Group by class, the leader included (`total` is `group`): the split *"3 AAB · 8 Agents"*, every AAB counted.',
  })
  manpower!: Figures['manpower'];
  @ApiProperty({ type: MoneyDto, description: '*APE bulan ini* over the Group, against the members’ own monthly targets.' })
  apeMonth!: Money;

  @ApiProperty({ type: LeaderActiveDto, description: '*Active this month* (D1) over the Group, with its Unit and AAB halves.' })
  active!: AnalyticsLeader['active'];

  @ApiProperty({ type: RateDto, description: '`COACHED_7D` over the Group today, the leader included.' }) coached7d!: Rate;
  @ApiProperty({ type: AnalyticsLeadsDto, description: 'The Group’s open leads, and those promised for the period’s month.' })
  leads!: AnalyticsLeader['leads'];

  @ApiProperty({ type: ClubDto, nullable: true, description: 'An AB’s club, over their agency’s year to date; `null` for an AAB.' })
  club!: { code: string; label: string } | null;

  @ApiProperty({ type: MocDto, nullable: true, description: '`MOC_STATUS` for the leader’s rung; `null` with no rule for it.' })
  moc!: Moc | null;
}

export class OfficeGroupDto implements OfficeGroup {
  @ApiProperty({ description: 'The custom group (*All members → Groups*).' }) groupId!: string;
  @ApiProperty({ example: 'Core Leader' }) name!: string;
  @ApiProperty({ example: 3, description: 'Its members today: tagged with it, status *Aktif*.' }) memberCount!: number;
}

export class KpmAnalyticsDto implements KpmAnalyticsView {
  @ApiProperty({ enum: KPM_REPORTING.ANALYTICS_PERIODS }) period!: KpmAnalyticsPeriod;
  @ApiProperty({ example: '2026-10', description: 'The period’s month.' }) month!: string;
  @ApiProperty({ type: ReportingThresholdsDto }) thresholds!: { statusSplitPct: number };
  @ApiProperty({
    example: 'AAB: APE ≥ Rp 200 jt AND Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75%.\nAB: (APE ≥ Rp 600 jt AND '
      + 'Monthly2 AA DU ≥ 4 / DG ≥ 6 AND Rolling Persistency DU/DG ≥ 75%) OR Direct AB (AB on AB) ≥ 5.',
    description: 'The MOC column’s tooltip, composed from the company’s MOC rules: a line per rule, the junior rung '
      + 'first, separated by `\\n`. Empty when the company has none.',
  })
  mocRulesText!: string;

  @ApiProperty({ type: [AnalyticsAgencyDto], description: 'One row per AB agency, A to Z; the rows partition the agency’s members.' })
  agencies!: AnalyticsAgency[];

  @ApiProperty({
    type: AnalyticsTotalDto,
    description: 'The KPM’s totals, over everybody in scope. `apeAnnual` is the KPM’s production this year, a leaver’s '
      + 'included — the Overview’s figure (ADR-0204 §1) — and so no longer the sum of the rows, which count today’s members.',
  })
  total!: KpmAnalyticsView['total'];

  @ApiProperty({
    type: [AnalyticsLeaderDto],
    description: 'Every AB and AAB (status *Aktif*), lowest *APE bulan ini* % first, a leader with no % last (UI-152).',
  })
  leaders!: AnalyticsLeader[];

  @ApiProperty({ type: [OfficeGroupDto], description: 'The office’s active custom groups, A to Z: *Lihat untuk*’s choices.' })
  groups!: OfficeGroup[];

  @ApiProperty({ example: 28, description: '*Seluruh KPM · n orang*: the agency’s members today, whichever group is read.' })
  officePeople!: number;

  @ApiProperty({ type: OfficeGroupDto, nullable: true, description: 'The group the figures are over (`?group=`); `null` for the whole KPM.' })
  group!: OfficeGroup | null;

  @ApiProperty({ type: [MonthlyProductionDto], description: 'The six months ending with this one, oldest first (UI-091).' })
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
