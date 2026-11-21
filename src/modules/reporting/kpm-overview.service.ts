import { Injectable } from '@nestjs/common';
import { requireOfficeSteward } from '@/common/auth/office-steward';
import { RequestContext, type HierarchyRole } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { calendarMonth, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_CURRENCY, KPM_REPORTING, PERIOD } from '@/domain/constants';
import type { CoachingStatus } from '@/domain/constants/coaching-status';
import type { UsageStatus } from '@/domain/constants/usage';
import { rateOver, wholePercent } from '@/domain/metrics/rate';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { recruitsJoined } from '@/modules/org/recruits';
import { activeAgentsIn } from '@/modules/production/active-agents';
import { OfficialApe } from '@/modules/production/official-ape';
import type { MonthCells, ProductionReadings } from '@/modules/production/production-readings';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import {
  AbGroupTargetsService, type AbGroupTargetGroup, type AbGroupTargetRow, type AbGroupTargetsView, type AbGroupTargetTotals,
} from './ab-group-targets/ab-group-targets.service';
import { KpmSetup, type SettingsWaiting, type SetupView } from './kpm-setup.service';
import { shiftMonth } from './office-figures';
import { OfficeGroups } from './office-groups';
import { OfficePeople, type OfficeHeader } from './office-people';
import { NO_GROUP, overviewTree, scopeOf, type OverviewGroupRef } from './overview-tree';

/** A rung's count, as the platform's adoption read names it (`PlatformAnalyticsService`). */
export interface RungCount {
  code: string;
  label: string;
  count: number;
}

/** *Pakai* over a set of people: *"26 dari 30"*, and its share (`null` over nobody). */
export interface UsageCount {
  used: number;
  of: number;
  pct: number | null;
}

/** Section 1's three counts over one set of people: everyone, the leaders (AB and AAB) and the agents. */
export interface UsageCounts {
  total: UsageCount;
  leaders: UsageCount;
  agents: UsageCount;
}

/**
 * **One person on the Overview's lists** (sections 2 and 3, and the compliance card's list): where they stand in the
 * tree, their photo and number, and their two statuses — the app's use and their coaching — as of the office's today.
 */
export interface OverviewPersonView {
  membershipId: string;
  name: string;
  /** `ab` and `aab` draw the orange label before the name; an agent none. */
  role: HierarchyRole;
  photoUrl: string | null;
  /** Their WhatsApp number (`users.phone`), `null` when none is on file. */
  phone: string | null;
  /** Their AB's informal group; `null` is *Tanpa group*. */
  groupId: string | null;
  /** Their AB group's AB; `null` for somebody under no AB. */
  abMembershipId: string | null;
  depth: 0 | 1 | 2;
  /** The leaders above them in their AB group, the AB first: whose *"n di timnya"* they count toward. */
  leaderIds: string[];
  /** `never` *Belum pernah pakai* · `lapsed` *Pakai n hari lalu* (> 14) · `recent` (≤ 14); `days` since the last day logged. */
  usage: { status: UsageStatus; days: number | null; usedInWindow: boolean };
  /** `never` *Belum pernah coaching* · `lapsed` (> 14 days) · `recent` (≤ 14); `days` since the last 1-on-1. */
  coaching: { status: CoachingStatus; days: number | null };
}

/** **`GET /kpm/overview`** — sections 1, 2, 3 and 6, the filter's choices, and a new KPM's setup card. */
export interface KpmOverviewView {
  office: OfficeHeader;
  today: LocalDate;
  /** The office's month, `YYYY-MM`. */
  month: string;
  /** Section 1's period: the last 30 days, today included. */
  usageWindow: { from: LocalDate; to: LocalDate };
  /** *Semua group ⌄*'s choices: the live groups A to Z, then *Tanpa group* when it holds anybody; each with its people. */
  groups: (OverviewGroupRef & { people: number })[];
  /** The group the page is over (`?group=`), or `null` for the whole KPM. */
  group: OverviewGroupRef | null;
  /** **1 · Pemakaian AgencyBoost**: the scope's counts, then one row per informal group in it. */
  usage: UsageCounts & { byGroup: (OverviewGroupRef & UsageCounts)[] };
  /** **2 · Pemakaian per orang** and **3 · Coaching**: everybody in scope, in the tree's order. */
  people: OverviewPersonView[];
  /** **6 · Produksi 6 bulan**: the six months ending with this one; `apeMinor` `null` where the office holds no file. */
  production: { currency: string; months: { month: string; apeMinor: number | null }[] };
  /** ***Siapkan KPM*** while any of its steps is open; `null` once all are done, which is stored. */
  setup: SetupView | null;
  /** What waits for the Owner on the settings pages: *Pengaturan KPM ›*'s line. */
  settings: SettingsWaiting;
}

/** A row's results for the month: APE against its target, *Active Agent* and *Rekrut* as counted. */
export interface PerformanceActual {
  /** The month's APE in the upload over the people, in sen; `null` while the month is not uploaded. */
  apeMinor: number | null;
  /** APE over the APE target, whole, rounded half up; `null` without an upload or a target. */
  apePct: number | null;
  /** `MAA_COUNT_IN_UNIT`: `null` while the month is not uploaded — *"–"*, never 0. */
  activeAgents: number | null;
  /** `RECRUITS_JOINED` in the month, credited to the people. */
  rekrut: number;
}

export type PerformanceRow = AbGroupTargetRow & { photoUrl: string | null; actual: PerformanceActual };
export type PerformanceTotals = AbGroupTargetTotals & { actual: PerformanceActual };
export type PerformanceGroup = Omit<AbGroupTargetGroup, 'totals' | 'abGroups'> & {
  totals: PerformanceTotals;
  abGroups: PerformanceRow[];
};

/**
 * **`GET /kpm/overview/performance?month=&group=`** — **5 · Performa vs target**: the targets' own view for the month
 * (`GET /kpm/ab-group-targets`), each total and row with what was achieved beside it.
 */
export interface OverviewPerformanceView extends Omit<AbGroupTargetsView, 'total' | 'groups'> {
  /** The office holds a file for the month: without one APE and Active Agent read *"–"*. */
  held: boolean;
  /** The group the page is over, or `null`; `groups` then holds it alone. `total` is always the KPM's. */
  group: OverviewGroupRef | null;
  total: AbGroupTargetsView['total'] & { actual: PerformanceActual };
  groups: PerformanceGroup[];
}

/**
 * **The KPM Overview, second version** (Phase 19.19; [ADR-0272](../../../../docs/04-adr/0272-the-kpm-overview-reads-usage-compliance-and-results-on-one-page-and-kpm-analytics-is-removed.md);
 * `functional/kpm-overview.md`; the brief's *KPM Overview, new content*): the page the Owner, the Admins and core leaders
 * land on — **usage first, then compliance, then results** — over the KPM or one informal group.
 *
 * - **Who** (ADR-0268 §1): the KPM's stewards — the Super Admin inside the KPM, the Owner, an Admin, a core leader, who
 *   sees the whole KPM here (`requireOfficeSteward`); the routes' `kpm_overview:read` asks first.
 * - **Who is counted**: `OfficeGroups.partition` — every active member, **test accounts never** (ADR-0267 §1) — placed
 *   informal group → AB group → person (`overviewTree`).
 * - **Every figure is one already defined, read through its owner's port** (invariant §8; §A.21): *Pakai* over the last
 *   30 days and the usage status (`ActivityReadings.usageOf`), the coaching status (`CoachingReadings.statusOf`), *Active
 *   Agent* (`activeAgentsIn`), *Rekrut* (`recruitsJoined`), the targets (`AbGroupTargetsService`), the month's APE
 *   (`ProductionReadings.monthCellsFor`) — so the numbers equal the Unit Dashboard's for the same people and month.
 * - **The audit**: a read lists each person's latest day logged and latest 1-on-1, so each person listed is one §3.5 entry
 *   (`kpm_overview`), in one insert, once the answer exists.
 */
@Injectable()
export class KpmOverviewService {
  constructor(
    private readonly people: OfficePeople,
    private readonly days: TenantDay,
    private readonly activity: ActivityReadings,
    private readonly sessions: CoachingReadings,
    /** The official APE, the one port every reader of the month table asks (ADR-0195, P19.1-T4 AC-13). */
    private readonly production: OfficialApe,
    private readonly subjectReads: SubjectReadAudit,
    private readonly setup: KpmSetup,
    private readonly groups: OfficeGroups,
    private readonly targets: AbGroupTargetsService,
    private readonly names: MemberNames,
    private readonly memberships: MembershipRepository,
  ) {}

  /** Each person's month cells over a range, through the port's one read (`monthCellsAndYearToDateFor`'s cells). */
  private async cellsFor(
    ctx: RequestContext, ids: readonly string[], range: { from: string; to: string },
  ): Promise<Map<string, Map<string, MonthCells>>> {
    return (await this.production.monthCellsAndYearToDateFor(ctx, ids, range)).cells;
  }

  /** The two reads `activeAgentsIn` makes, through the port. */
  private get months(): Pick<ProductionReadings, 'monthCellsFor' | 'officeMonths'> {
    return {
      monthCellsFor: (ctx, ids, range) => this.cellsFor(ctx, ids, range),
      officeMonths: (ctx, range) => this.production.officeMonths(ctx, range),
    };
  }

  /** **`GET /kpm/overview`** (P19.19-T1, T3 AC-1). */
  async read(ctx: RequestContext, query: { group?: string } = {}): Promise<KpmOverviewView> {
    requireOfficeSteward(ctx, 'KPM');
    const office = await this.days.office(ctx);
    const { today, month, timezone } = office;
    const partition = await this.groups.partition(ctx);
    const everyone = [...partition.members.keys()];
    const pictured = await this.names.pictured(ctx, everyone, everyone, { phones: true });
    const tree = overviewTree(partition, (id) => pictured.get(id)?.name ?? '');
    // The group first: an unknown one is 404 before anything else is read.
    const scope = scopeOf(tree, query.group);
    const ids = scope.memberIds;
    const window = rollingWindow(today, PERIOD.ROLLING_30D_DAYS);
    const year = today.slice(0, 4);
    const chartFrom = shiftMonth(month, -(KPM_REPORTING.MONTHLY_CHART_MONTHS - 1));
    const abIds = [...partition.abGroups.keys()];

    const [header, usage, coaching, cells, months, targets] = await Promise.all([
      this.people.header(ctx),
      this.activity.usageOf(ctx, ids, today, window),
      this.sessions.statusOf(ctx, ids, { today, timezone }),
      this.cellsFor(ctx, ids, { from: chartFrom, to: month }),
      // This year's months for the setup card, and the chart's six, in one read.
      this.production.officeMonths(ctx, { from: [chartFrom, `${year}-01`].sort()[0], to: month }),
      this.targets.forAbs(ctx, abIds, month),
    ]);
    const held = [...months].filter(([key, m]) => m.held && key.startsWith(year)).map(([key]) => key).sort();
    const targeted = [...targets.values()].filter((t) => t.source !== 'none').length;
    const setup = await this.setup.read(ctx, {
      today, month, timezone, headcount: everyone.length, target: targeted === 0 ? null : targeted, held,
    });

    // ---- 1 · Pemakaian AgencyBoost: *Pakai* over the last 30 days (`APP_USE_IN_PERIOD`).
    const used = (id: string) => usage.get(id)?.usedInPeriod === true;
    const isLeader = (id: string) => {
      const role = partition.members.get(id)?.role;
      return role === 'ab' || role === 'aab';
    };
    const countsOf = (people: readonly string[]): UsageCounts => {
      const count = (subset: readonly string[]): UsageCount => {
        const rate = rateOver(subset.filter(used).length, subset.length);
        return { used: rate.count, of: rate.of, pct: rate.pct };
      };
      return { total: count(people), leaders: count(people.filter(isLeader)), agents: count(people.filter((id) => !isLeader(id))) };
    };
    const inScope = new Set(ids);
    const byGroup = tree.groups
      .filter((g) => scope.selected === null || g.groupId === scope.selected.groupId)
      .map((g) => ({ groupId: g.groupId, name: g.name, ...countsOf(g.memberIds.filter((id) => inScope.has(id))) }));

    // ---- 2 and 3: everybody in scope, in the tree's order.
    const people = scope.rows.map((row): OverviewPersonView => {
      const u = usage.get(row.membershipId);
      const c = coaching.get(row.membershipId);
      const person = pictured.get(row.membershipId);
      return {
        membershipId: row.membershipId,
        name: person?.name ?? '',
        role: row.role,
        photoUrl: person?.photoUrl ?? null,
        phone: person?.phone ?? null,
        groupId: row.groupId,
        abMembershipId: row.abMembershipId,
        depth: row.depth,
        leaderIds: row.leaderIds,
        usage: { status: u?.status ?? 'never', days: u?.daysSinceLastLogged ?? null, usedInWindow: used(row.membershipId) },
        coaching: { status: c?.status ?? 'never', days: c?.daysSinceLastCoaching ?? null },
      };
    });

    // ---- 6 · Produksi 6 bulan: the month's APE over the scope's people, where the office holds a file for it.
    const chart = Array.from({ length: KPM_REPORTING.MONTHLY_CHART_MONTHS }, (_, i) => {
      const m = shiftMonth(chartFrom, i);
      if (!(months.get(m)?.held ?? false)) return { month: m, apeMinor: null };
      return { month: m, apeMinor: ids.reduce((sum, id) => sum + (cells.get(id)?.get(m)?.apeMonthly ?? 0), 0) };
    });

    const view: KpmOverviewView = {
      office: header,
      today,
      month,
      usageWindow: window,
      groups: tree.groups.map((g) => ({ groupId: g.groupId, name: g.name, people: g.memberIds.length })),
      group: scope.selected,
      usage: { ...countsOf(ids), byGroup },
      people,
      production: { currency: DEFAULT_CURRENCY, months: chart },
      setup: setup.setup,
      settings: setup.settings,
    };
    // Last, once the answer exists: each person listed, whose latest day logged and latest 1-on-1 it carries.
    await this.subjectReads.recordMany(ctx, people, 'kpm_overview', { from: null, to: today });
    return view;
  }

  /** **`GET /kpm/overview/performance`** (P19.19-T2). */
  async performance(ctx: RequestContext, query: { month?: string; group?: string } = {}): Promise<OverviewPerformanceView> {
    requireOfficeSteward(ctx, 'KPM');
    // The targets' own read: the month's range (422 outside it), the AB groups under their informal groups, the totals.
    const targets = await this.targets.read(ctx, query.month);
    const wanted = query.group === undefined ? undefined : query.group === NO_GROUP ? null : query.group;
    if (wanted !== undefined && wanted !== null && !targets.groups.some((g) => g.group?.groupId === wanted)) {
      throw new NotFoundException('Group');
    }
    const month = targets.month;
    const partition = await this.groups.partition(ctx);
    const everyone = [...partition.members.keys()];
    const abIds = [...partition.abGroups.keys()];
    const [active, cells, recruits, pictured] = await Promise.all([
      activeAgentsIn(this.months, ctx, everyone, month),
      this.cellsFor(ctx, everyone, { from: month, to: month }),
      recruitsJoined(this.memberships, ctx, calendarMonth(`${month}-01`)),
      this.names.pictured(ctx, abIds, abIds),
    ]);
    const activeIds = new Set(active.people.map((p) => p.membershipId));
    const pctOf = (achieved: number | null, target: number) => (achieved === null || target <= 0 ? null : wholePercent(achieved, target));
    const actualOf = (people: readonly string[], apeTargetMinor: number, rekrut: number): PerformanceActual => {
      const apeMinor = active.held ? people.reduce((sum, id) => sum + (cells.get(id)?.get(month)?.apeMonthly ?? 0), 0) : null;
      return {
        apeMinor,
        apePct: pctOf(apeMinor, apeTargetMinor),
        activeAgents: active.held ? people.filter((id) => activeIds.has(id)).length : null,
        rekrut,
      };
    };
    const creditedTo = (people: readonly string[]) => {
      const set = new Set(people);
      return recruits.filter((r) => r.registeredByMembershipId !== null && set.has(r.registeredByMembershipId)).length;
    };
    const peopleOf = (ab: string) => partition.abGroups.get(ab)?.memberIds ?? [];

    const groups: PerformanceGroup[] = targets.groups
      .filter((g) => wanted === undefined || (g.group?.groupId ?? null) === wanted)
      .map((g) => {
        const rows = g.abGroups.map((row): PerformanceRow => {
          const ids = peopleOf(row.abMembershipId);
          return {
            ...row,
            photoUrl: pictured.get(row.abMembershipId)?.photoUrl ?? null,
            actual: actualOf(ids, row.apeTargetMinor, creditedTo(ids)),
          };
        });
        const ids = g.abGroups.flatMap((row) => peopleOf(row.abMembershipId));
        return { ...g, totals: { ...g.totals, actual: actualOf(ids, g.totals.apeTargetMinor, creditedTo(ids)) }, abGroups: rows };
      });
    return {
      ...targets,
      held: active.held,
      group: wanted === undefined ? null : {
        groupId: wanted,
        name: wanted === null ? null : targets.groups.find((g) => g.group?.groupId === wanted)?.group?.name ?? null,
      },
      // *Total KPM*: every member's APE and Active Agent — those under no AB too — and every recruit who joined the office.
      total: { ...targets.total, actual: actualOf(everyone, targets.total.apeTargetMinor, recruits.length) },
      groups,
    };
  }
}
