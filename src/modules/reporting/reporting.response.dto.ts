import { ApiProperty } from '@nestjs/swagger';
import { USAGE_STATUSES, type UsageStatus } from '@/domain/constants/usage';
import { COACHING_STATUSES, type CoachingStatus } from '@/domain/constants/coaching-status';
import type { Rate } from '@/domain/metrics/rate';
import type {
  KpmOverviewView, OverviewPerformanceView, OverviewPersonView, PerformanceActual, PerformanceGroup, PerformanceRow,
  PerformanceTotals, RungCount, UsageCount, UsageCounts,
} from './kpm-overview.service';
import { REVIEWED_PAGES, SETUP_MARK_VIAS, type ReviewedPage } from './kpm-setup-mark.schema';
import {
  SETUP_STEPS, type ReviewedView, type SettingsWaiting, type SetupStep, type SetupView,
} from './kpm-setup.service';
import type { Money } from './office-figures';
import type { OfficeHeader } from './office-people';
import type { OverviewGroupRef } from './overview-tree';

/** Declared for OpenAPI. The wire shapes live on the services' view types. */

// ------------------------------------------------------------------ shared

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

// ------------------------------------------------------------------ the KPM Overview (P19.19; ADR-0272)

class OfficeHeaderDto implements OfficeHeader {
  @ApiProperty({ example: 'Prudential' }) companyName!: string;
  @ApiProperty({ example: '0417' }) code!: string;
  @ApiProperty({ example: 'BSD City Branch' }) branch!: string;
}

class GroupRefDto implements OverviewGroupRef {
  @ApiProperty({ type: String, nullable: true, description: 'The informal group; `null` is *Tanpa group*.' }) groupId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Top Producers 2026' }) name!: string | null;
}

class GroupChoiceDto extends GroupRefDto {
  @ApiProperty({ example: 10, description: 'Its people today, test accounts not counted.' }) people!: number;
}

class UsageCountDto implements UsageCount {
  @ApiProperty({ example: 26, description: 'Logged at least one activity in the last 30 days (*Pakai*).' }) used!: number;
  @ApiProperty({ example: 30 }) of!: number;
  @ApiProperty({ type: Number, nullable: true, example: 87, description: 'Whole, rounded half up; `null` over nobody.' }) pct!: number | null;
}

class UsageCountsDto implements UsageCounts {
  @ApiProperty({ type: UsageCountDto }) total!: UsageCount;
  @ApiProperty({ type: UsageCountDto, description: 'The ABs and AABs.' }) leaders!: UsageCount;
  @ApiProperty({ type: UsageCountDto, description: 'Everybody else.' }) agents!: UsageCount;
}

class GroupUsageDto extends UsageCountsDto implements OverviewGroupRef {
  @ApiProperty({ type: String, nullable: true, description: '`null`: *Tanpa group*.' }) groupId!: string | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

class OverviewUsageDto extends UsageCountsDto {
  @ApiProperty({ type: [GroupUsageDto], description: 'One per informal group in scope, in the filter’s order.' })
  byGroup!: KpmOverviewView['usage']['byGroup'];
}

class PersonUsageDto {
  @ApiProperty({ enum: USAGE_STATUSES }) status!: UsageStatus;
  @ApiProperty({ type: Number, nullable: true, example: 18, description: 'Days since the latest day logged; `null`: never.' }) days!: number | null;
  @ApiProperty({ description: 'Logged in the last 30 days (*Pakai*).' }) usedInWindow!: boolean;
}

class PersonCoachingDto {
  @ApiProperty({ enum: COACHING_STATUSES }) status!: CoachingStatus;
  @ApiProperty({ type: Number, nullable: true, example: 27, description: 'Days since the latest 1-on-1; `null`: never.' }) days!: number | null;
}

class OverviewPersonDto implements OverviewPersonView {
  @ApiProperty({ description: 'The membership: the person in this office, never their account.' }) membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ enum: ['ab', 'aab', 'agent'], description: '`ab` and `aab` draw the orange label before the name.' })
  role!: OverviewPersonView['role'];
  @ApiProperty({ type: String, nullable: true, description: 'A signed link to their photo; `null`: initials.' }) photoUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '+6281234567890', description: 'Their WhatsApp number, or `null`.' }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Their AB’s informal group; `null`: *Tanpa group*.' }) groupId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Their AB group’s AB; `null` under no AB.' }) abMembershipId!: string | null;
  @ApiProperty({ enum: [0, 1, 2], description: 'The indent: the AB 0, an AAB or the AB’s own agent 1, an AAB’s agent 2.' }) depth!: 0 | 1 | 2;
  @ApiProperty({ type: [String], description: 'The leaders above them in their AB group, the AB first.' }) leaderIds!: string[];
  @ApiProperty({ type: PersonUsageDto }) usage!: OverviewPersonView['usage'];
  @ApiProperty({ type: PersonCoachingDto }) coaching!: OverviewPersonView['coaching'];
}

class ChartMonthDto {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'IDR minor units; `null`: the office holds no file for the month (*"–"*).' })
  apeMinor!: number | null;
}

class OverviewProductionDto {
  @ApiProperty({ example: 'IDR' }) currency!: string;
  @ApiProperty({ type: [ChartMonthDto], description: 'Six, oldest first, ending with the office’s month.' })
  months!: KpmOverviewView['production']['months'];
}

class UsageWindowDto {
  @ApiProperty({ example: '2026-10-22' }) from!: string;
  @ApiProperty({ example: '2026-11-20' }) to!: string;
}

class SetupStepDto {
  @ApiProperty({ enum: SETUP_STEPS, description: 'In the card’s order: the four settings pages, then *Impor anggota*, *Unggah produksi*, and the monthly targets per AB group (`recruit-target`, the key kept).' })
  key!: SetupStep;

  @ApiProperty({
    description: 'Steps 1–4: the page was saved or marked *Sudah sesuai*. 5: a member besides the Owner. 6: any production '
      + 'upload. 7: at least one AB group has a monthly target standing this month (ADR-0272 §7).',
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

  @ApiProperty({ type: Number, nullable: true, description: 'Step 7’s meta: how many AB groups have a target standing this month; `null` with none.' })
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
  @ApiProperty({ example: '2026-11-20', description: 'Today in the office’s calendar.' }) today!: string;
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ type: UsageWindowDto, description: 'Section 1’s 30 days, today included.' }) usageWindow!: KpmOverviewView['usageWindow'];
  @ApiProperty({ type: [GroupChoiceDto], description: '*Semua group ⌄*: the live groups A to Z, then *Tanpa group*.' })
  groups!: KpmOverviewView['groups'];
  @ApiProperty({ type: GroupRefDto, nullable: true, description: 'The group read (`?group=`); `null` for the whole KPM.' })
  group!: OverviewGroupRef | null;
  @ApiProperty({ type: OverviewUsageDto }) usage!: KpmOverviewView['usage'];
  @ApiProperty({ type: [OverviewPersonDto], description: 'Everybody in scope, in the tree’s order.' }) people!: OverviewPersonView[];
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

// ------------------------------------------------------------------ Performa vs target (P19.19-T2)

class PerformanceActualDto implements PerformanceActual {
  @ApiProperty({ type: Number, nullable: true, description: 'The month’s APE in sen; `null` while the month is not uploaded.' })
  apeMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 27, description: 'APE over the APE target, whole; `null` without both.' })
  apePct!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 2, description: '*Active Agent*; `null` while the month is not uploaded.' })
  activeAgents!: number | null;
  @ApiProperty({ example: 1, description: '*Rekrut*: new hires who joined in the month, credited to the people.' }) rekrut!: number;
}

class PerformanceRowDto implements PerformanceRow {
  @ApiProperty() abMembershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) agentCode!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'A signed link to the AB’s photo; `null`: initials.' }) photoUrl!: string | null;
  @ApiProperty() isGroupLeader!: boolean;
  @ApiProperty({ example: 9, description: '*n orang*: the AB group, the AB included, test accounts not counted.' }) people!: number;
  @ApiProperty({ type: Number, nullable: true, description: '`null`: *Belum ada target*.' }) activeAgentTarget!: number | null;
  @ApiProperty({ type: Number, nullable: true }) rekrutTarget!: number | null;
  @ApiProperty({ enum: ['set', 'carried', 'none'] }) source!: PerformanceRow['source'];
  @ApiProperty({ type: String, nullable: true }) fromMonth!: string | null;
  @ApiProperty() rekrutYtdTarget!: number;
  @ApiProperty({ description: 'The members’ Goal Setting for the year ÷ 12, in sen. Not editable here.' }) apeTargetMinor!: number;
  @ApiProperty() goalsSet!: number;
  @ApiProperty({ type: PerformanceActualDto }) actual!: PerformanceActual;
}

class PerformanceTotalsDto implements PerformanceTotals {
  @ApiProperty() activeAgentTarget!: number;
  @ApiProperty() rekrutTarget!: number;
  @ApiProperty() rekrutYtdTarget!: number;
  @ApiProperty() apeTargetMinor!: number;
  @ApiProperty({ description: 'AB groups with no target: the sums are over the others.' }) unset!: number;
  @ApiProperty() abGroups!: number;
  @ApiProperty() people!: number;
  @ApiProperty({ type: PerformanceActualDto }) actual!: PerformanceActual;
}

class PerformanceKpmTotalsDto extends PerformanceTotalsDto {
  @ApiProperty({ description: 'Active members under no AB: in the KPM’s APE target and figures, in no AB group.' })
  unplacedPeople!: number;
}

class TargetGroupDto {
  @ApiProperty() groupId!: string;
  @ApiProperty() name!: string;
}

class TargetLeaderDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() name!: string;
}

class PerformanceGroupDto implements PerformanceGroup {
  @ApiProperty({ type: TargetGroupDto, nullable: true, description: '`null`: *Tanpa group*.' }) group!: PerformanceGroup['group'];
  @ApiProperty({ type: [TargetLeaderDto] }) leaders!: PerformanceGroup['leaders'];
  @ApiProperty({ type: PerformanceTotalsDto }) totals!: PerformanceTotals;
  @ApiProperty({ type: [PerformanceRowDto] }) abGroups!: PerformanceRow[];
}

export class OverviewPerformanceDto implements OverviewPerformanceView {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ example: '2026-11', description: 'The office’s month: the switcher’s › stops here.' }) currentMonth!: string;
  @ApiProperty({ example: '2024-01' }) earliestMonth!: string;
  @ApiProperty({ example: '2027-11' }) latestMonth!: string;
  @ApiProperty({ example: 999 }) max!: number;
  @ApiProperty({ example: 'IDR' }) currency!: string;
  @ApiProperty({ description: 'The office holds a file for the month.' }) held!: boolean;
  @ApiProperty({ type: GroupRefDto, nullable: true, description: 'The group kept (`?group=`); `null` for every group.' })
  group!: OverviewGroupRef | null;
  @ApiProperty({ type: PerformanceKpmTotalsDto, description: '*Total KPM*.' }) total!: OverviewPerformanceView['total'];
  @ApiProperty({ type: [PerformanceGroupDto], description: 'The informal groups A to Z, then *Tanpa group*.' }) groups!: PerformanceGroup[];
  @ApiProperty({ description: 'The targets may be saved: never in a view-only session.' }) canWrite!: boolean;
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

// Cross-platform analytics' `PlatformAnalyticsDto` and its rows went with `GET /admin/analytics` (P19.23; ADR-0277 §1).
