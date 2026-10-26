import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { endOfMonth, type LocalDate } from '@/common/time/local-day';
import { NEW_AGENT_ACTIVE_MONTHS } from '@/domain/constants/metrics';
import { activationCohort, cohortOutcome, newAgent3mActive, type CohortMonth } from '@/domain/metrics/activation-cohort';
import {
  averageCaseSizeRealised, caseSubmissions, maaMonthlyAvg, newActiveAgentsMonthlyAvg,
} from '@/domain/metrics/held-months';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { memberAt, officeHeadcount } from '@/domain/metrics/office-headcount';
import { belongedDuring, producingAgents } from '@/domain/metrics/producing-agents';
import { ActivationProgressRepository } from '@/modules/activation/activation-progress.repository';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import {
  ProductionReadings, type MonthCells, type MonthLedger, type OfficeMonth,
} from '@/modules/production/production-readings';
import { AGENCY_CLASS, AGENT_CLASS, UNIT_CLASS } from '@/modules/reporting/agency-partition';
import { shiftMonth } from '@/modules/reporting/office-figures';
import { OfficePeople, type OfficePerson } from '@/modules/reporting/office-people';
import {
  COLUMN_KEYS, MONTH_COLUMN_KEYS, type ColumnKey, type ComputedScorecard, type ComputedScorecardRow,
  type RowKey, type ScorecardCell, type ScorecardChips, type ScorecardInput, type ScorecardUnit,
} from './scorecard.types';

/** A column's period: its first day, and the day it ends — the earliest of its own last day, the meeting's and today. */
interface Period {
  from: LocalDate;
  end: LocalDate;
  /** `YYYY-MM`, from the first month to the end's; none for a period that has not begun by its end. */
  months: string[];
}

/** One month of the office's file beyond APE: the two sums the forum reads, `null` where no figure is held. */
interface FileMonth {
  newActiveAgents: number | null;
  policies: number | null;
}

/** What every row reads, read once (`compute`). */
interface Reads {
  timezone: string;
  everyone: readonly OfficePerson[];
  byId: ReadonlyMap<string, OfficePerson>;
  office: ReadonlyMap<string, OfficeMonth>;
  file: ReadonlyMap<string, FileMonth>;
  cells: ReadonlyMap<string, ReadonlyMap<string, MonthCells>>;
  /** Each month's bounds in the office's zone, computed once a month however many members read them. */
  bounds: Map<string, { start: Date; endExclusive: Date }>;
}

const PENDING: ScorecardCell = { kind: 'pending' };
const NONE: ScorecardCell = { kind: 'none' };
const BLOCKED: ScorecardCell = { kind: 'blocked' };
const figure = (value: number, leavesOut: string[] = []): ScorecardCell => ({ kind: 'figure', value, leavesOut });
const orPending = (value: number | null, leavesOut: string[]): ScorecardCell =>
  (value === null ? PENDING : figure(value, leavesOut));

/**
 * **The forum's *Overview & Stats*, computed** (OD-144, ADR-0129; `functional/leader-forum.md`, *Overview & Stats*):
 * the five chips and the nine rows over the five periods a meeting's date names (*FY {Y−1}*, *YTD {Y}*, *This Month,
 * Last Year*, *Last Month*, *This Month*). The forum's service calls it for a live meeting on every read and once more
 * for the freeze; the meeting overlays its typed *Monthly Target* and its `frozenAt`.
 *
 * **Every figure through the function that already computes it** (invariant §8) — the office's people as the Overview
 * reads them (`OfficePeople`), `OFFICE_HEADCOUNT` and the composition by rung code, the office's file as the analytics
 * sums it (`ProductionReadings.officeMonths`) and the members' year to date as the Overview does (`ledgersFor`),
 * `MONTHLY_ACTIVE_AGENT` and `MAA_COUNT_IN_UNIT` from the month table's cells (`monthCellsFor`) — and this phase's
 * seven, each once under `domain/metrics/`. **A period ends at the earliest of its own last day, the meeting's date
 * and today**: a point-in-time figure is taken on that day; a figure from the file counts the period's months the
 * office holds now, and names the ones it leaves out — but the office's current month, whose file is not due yet.
 * **Exact**: no rounding but money's to whole minor units.
 *
 * **A fixed number of queries whatever the office's size** (`scorecard.performance.spec.ts`): the office's people,
 * then six reads at once — the file month by month, its two other sums, each member's cells, the year to date twice
 * — and the activations. Read through the tenant repositories, in the office named (invariant §1). Writes nothing.
 */
@Injectable()
export class LeaderScorecardService {
  constructor(
    private readonly people: OfficePeople,
    private readonly production: ProductionReadings,
    private readonly monthRows: MonthlyAgentDataRepository,
    private readonly activations: ActivationProgressRepository,
    private readonly clock: Clock,
  ) {}

  async compute(input: ScorecardInput): Promise<ComputedScorecard> {
    const { kpmId, timezone, meetingDate } = input;
    const ctx = RequestContext.tenantRead(kpmId, 'leader-scorecard');
    const today = this.clock.localDateFor(timezone);
    const year = Number(meetingDate.slice(0, 4));
    const month = meetingDate.slice(0, 7);
    const lastYear = String(year - 1);

    const periodOf = (from: LocalDate, ownEnd: LocalDate): Period => {
      const end = [ownEnd, meetingDate, today].sort()[0];
      const months: string[] = [];
      for (let m = from.slice(0, 7); end >= from && m <= end.slice(0, 7); m = shiftMonth(m, 1)) months.push(m);
      return { from, end, months };
    };
    const monthPeriod = (m: string) => periodOf(`${m}-01`, endOfMonth(`${m}-01`));
    const periods: Record<ColumnKey, Period> = {
      fy: periodOf(`${lastYear}-01-01`, `${lastYear}-12-31`),
      ytd: periodOf(`${year}-01-01`, endOfMonth(meetingDate)),
      thisMonthLastYear: monthPeriod(shiftMonth(month, -12)),
      lastMonth: monthPeriod(shiftMonth(month, -1)),
      thisMonth: monthPeriod(month),
    };

    // ---- The reads: the people since the first period began, then the rest at once.
    const roster = await this.people.read(ctx, this.clock.startOfLocalDay(timezone, `${lastYear}-01-01`));
    const everyone = roster.everyone;
    const ids = everyone.map((p) => p.membershipId);
    // Production is everybody's who was here in the year, a leaver's included (OD-74), as the Overview's year to date.
    const since = (y: string) => this.clock.startOfLocalDay(timezone, `${y}-01-01`).getTime();
    const producersIn = (y: string) => everyone
      .filter((p) => p.status === 'active' || (p.removedAt !== null && p.removedAt.getTime() >= since(y)))
      .map((p) => p.membershipId);
    // The file from January of last year to three months past the meeting's: a hire's four months from their start.
    const range = { from: `${lastYear}-01`, to: shiftMonth(month, NEW_AGENT_ACTIVE_MONTHS - 1) };
    const cohortTo = [periods.fy.end, periods.ytd.end].sort()[1];
    const [office, file, cells, fyLedgers, ytdLedgers, started] = await Promise.all([
      this.production.officeMonths(ctx, range),
      this.fileMonths(ctx, range),
      this.production.monthCellsFor(ctx, ids, range),
      this.yearToDate(ctx, producersIn(lastYear), periods.fy),
      this.yearToDate(ctx, producersIn(String(year)), periods.ytd),
      this.activations.find(
        ctx,
        { startDate: { $gte: periods.fy.from, $lte: cohortTo } },
        { projection: { membershipId: 1, startDate: 1 } },
      ),
    ]);
    const reads: Reads = {
      timezone, everyone, byId: new Map(everyone.map((p) => [p.membershipId, p])), office, file, cells, bounds: new Map(),
    };

    // ---- Each row, column by column. **The office's current month is never named as left out**, as the Overview's
    // `missingMonths` never names it: its file is not due until it ends. *This Month* still reads *pending data* then.
    const current = today.slice(0, 7);
    const named = (cell: ScorecardCell): ScorecardCell =>
      (cell.kind === 'figure' ? { ...cell, leavesOut: cell.leavesOut.filter((m) => m !== current) } : cell);
    const columns = (cell: (period: Period, key: ColumnKey) => ScorecardCell) =>
      Object.fromEntries(COLUMN_KEYS.map((key) => [key, named(cell(periods[key], key))])) as Record<ColumnKey, ScorecardCell>;
    const yearly = (cell: (period: Period) => ScorecardCell) =>
      columns((period, key) => (MONTH_COLUMN_KEYS.includes(key) ? BLOCKED : cell(period)));
    const ledgers = { fy: fyLedgers, ytd: ytdLedgers } as Record<ColumnKey, Map<string, MonthLedger> | undefined>;

    const rows: Record<RowKey, Omit<ComputedScorecardRow, 'key'>> = {
      ape: {
        unit: 'idr_minor',
        cells: columns((period, key) => (key === 'fy' || key === 'ytd'
          ? this.apeToDate(reads, period, ledgers[key]!)
          : this.overHeld(period, (m) => office.get(m)?.apeMonthlyMinor ?? null, (values) => values[0]))),
      },
      manpower: {
        unit: 'count',
        cells: columns((period) => figure(officeHeadcount(everyone, this.clock.endOfLocalDay(timezone, period.end)))),
      },
      // OD-26 is open: no source holds the FLC count for any period.
      flc: { unit: 'count', cells: columns(() => PENDING) },
      producing_agents: { unit: 'count', cells: yearly((period) => this.producing(reads, period)) },
      new_aa: {
        unit: 'count',
        cells: columns((period) => this.overHeld(
          period, (m) => file.get(m)?.newActiveAgents ?? null,
          (values) => (period.months.length === 1 ? values[0] : newActiveAgentsMonthlyAvg(values)),
        )),
      },
      new_agent_3m: {
        unit: 'percentage',
        cells: yearly((period) => this.newAgent3m(reads, period, started)),
      },
      avg_monthly_aa: {
        unit: 'count',
        cells: columns((period) => this.overHeld(
          period, (m) => this.maaCount(reads, period, m),
          (values) => (period.months.length === 1 ? values[0] : maaMonthlyAvg(values)),
        )),
      },
      case_submission: {
        unit: 'count',
        cells: columns((period) => this.overHeld(period, (m) => file.get(m)?.policies ?? null, caseSubmissions)),
      },
      average_case_size: {
        unit: 'idr_minor',
        cells: yearly((period) => {
          const months = period.months.map((m) => ({ apeMinor: office.get(m)?.apeMonthlyMinor ?? null, policies: file.get(m)?.policies ?? null }));
          const size = averageCaseSizeRealised(months);
          if (size === 'none') return NONE;
          const leavesOut = period.months.filter((_, i) => months[i].apeMinor === null || months[i].policies === null);
          return orPending(size, leavesOut);
        }),
      },
    };

    return {
      periods: {
        fy: lastYear,
        ytd: String(year),
        thisMonthLastYear: shiftMonth(month, -12),
        lastMonth: shiftMonth(month, -1),
        thisMonth: month,
      },
      chips: this.chips(everyone, this.clock.endOfLocalDay(timezone, periods.thisMonth.end)),
      rows: (Object.keys(rows) as RowKey[]).map((key) => ({ key, unit: rows[key].unit as ScorecardUnit, cells: rows[key].cells })),
    };
  }

  /**
   * **The chips**, on the *This Month* period's last day: `OFFICE_HEADCOUNT` — the same function, on the same day, as
   * the *Manpower* row's *This Month* cell — and its members by class (ADR-0156), as `kpm-analytics.service.ts`
   * counts them: a *Senior Leader* rung's members are ABs, whatever the company called it. *# of units* is the
   * office's AB agencies (D-units), one per member of the `ab` class.
   */
  private chips(everyone: readonly OfficePerson[], endOfDay: Date): ScorecardChips {
    const members = everyone.filter((p) => memberAt(p, endOfDay));
    const of = (role: string) => members.filter((p) => p.role === role).length;
    return {
      manpower: officeHeadcount(everyone, endOfDay),
      agents: of(AGENT_CLASS),
      units: of(AGENCY_CLASS),
      ab: of(AGENCY_CLASS),
      aab: of(UNIT_CLASS),
    };
  }

  /**
   * A figure over the period's months the office's file holds: one value a month (`null` not held), folded by the
   * metric's own function; *pending data* when none is held, and the months not held named.
   */
  private overHeld(
    period: Period, read: (m: string) => number | null, fold: (values: (number | null)[]) => number | null,
  ): ScorecardCell {
    const values = period.months.map(read);
    if (values.every((v) => v === null)) return PENDING;
    return orPending(fold(values), period.months.filter((_, i) => values[i] === null));
  }

  /**
   * *APE* over *FY* and *YTD*: **the office's year to date through the period's last month**, as the Overview reads
   * it — each producer's latest year-to-date figure held no later than that month, summed — a leaver's kept (OD-74).
   * The carrier's figure is cumulative, so a month with no file of its own before the latest held is inside it: what
   * the cell leaves out is the period's months after the latest held (the Overview's `missingMonths`, which — as every
   * cell's — never names the office's current month: `compute`).
   */
  private apeToDate(reads: Reads, period: Period, ledgers: Map<string, MonthLedger>): ScorecardCell {
    if (period.months.length === 0) return PENDING;
    const last = period.months[period.months.length - 1];
    const figures = [...ledgers.values()]
      .map((ledger) => (last.endsWith('-12') ? ledger.standing.yearToDate : ledger.standing.throughLastMonth))
      .filter((held) => held !== null)
      .map((held) => held!.minor);
    if (figures.length === 0) return PENDING;
    const heldMonths = period.months.filter((m) => reads.office.get(m)?.held === true);
    return figure(figures.reduce((sum, v) => sum + v, 0), period.months.filter((m) => !heldMonths.some((h) => h >= m)));
  }

  /**
   * The year to date as it stood at the end of the period's last month, through `ledgersFor` — the Overview's own
   * reading: December's is the year's latest figure; any other month's is the next month's *through last month*.
   */
  private async yearToDate(ctx: RequestContext, producers: string[], period: Period): Promise<Map<string, MonthLedger>> {
    if (period.months.length === 0) return new Map();
    const last = period.months[period.months.length - 1];
    return this.production.ledgersFor(ctx, producers, last.endsWith('-12') ? last : shiftMonth(last, 1));
  }

  /** A month's bounds in the office's zone (`Clock.monthBounds`), each month's computed once. */
  private boundsOf(reads: Reads, m: string): { start: Date; endExclusive: Date } {
    let found = reads.bounds.get(m);
    if (!found) {
      found = this.clock.monthBounds(reads.timezone, m);
      reads.bounds.set(m, found);
    }
    return found;
  }

  /** Where a month ends inside its period: its own end, or the period's last day's, whichever is first. */
  private monthEnd(reads: Reads, period: Period, m: string): { start: Date; endExclusive: Date } {
    const bounds = this.boundsOf(reads, m);
    const periodEnd = this.clock.endOfLocalDay(reads.timezone, period.end);
    return { start: bounds.start, endExclusive: periodEnd < bounds.endExclusive ? periodEnd : bounds.endExclusive };
  }

  /** A member's `MONTHLY_ACTIVE_AGENT` for a month, from the month table's cells; `null` where they have no row. */
  private activeIn(reads: Reads, membershipId: string, m: string): boolean | null {
    const cell = reads.cells.get(membershipId)?.get(m);
    return cell ? monthlyActiveAgent(cell.apeMonthly, cell.policyCountMonthly) : null;
  }

  /**
   * `MAA_COUNT_IN_UNIT` over the office for a month, as the analytics' total reads its period's month: the members it
   * had on its last day — in a period that ends sooner, on that day — `null` while the office holds no file for it.
   */
  private maaCount(reads: Reads, period: Period, m: string): number | null {
    const end = this.monthEnd(reads, period, m).endExclusive;
    const members = reads.everyone.filter((p) => memberAt(p, end));
    return maaCountInUnit(members.map((p) => this.activeIn(reads, p.membershipId, m)), reads.office.get(m)?.held === true);
  }

  /** `PRODUCING_AGENTS` over the period's months held, each member's flags in the months they belonged in. */
  private producing(reads: Reads, period: Period): ScorecardCell {
    const held = period.months.filter((m) => reads.office.get(m)?.held === true);
    const windows = held.map((m) => this.monthEnd(reads, period, m));
    const flags = reads.everyone.map((p) => held
      .filter((_, i) => belongedDuring(p, windows[i].start, windows[i].endExclusive))
      .map((m) => this.activeIn(reads, p.membershipId, m)));
    return orPending(producingAgents(flags, held.length), period.months.filter((m) => !held.includes(m)));
  }

  /**
   * `NEW_AGENT_3M_ACTIVE_PCT` over the period's cohort (`ACTIVATION_COHORT`): each hire's start month and the three
   * after it, read as the office holds them now. *Pending data* while nobody is counted; what it leaves out is named by
   * **the months not held that the hires it does not count yet are waiting on** — every month of their four whose file
   * the office does not hold, an empty month or one still to come — so the cell never names a month that is uploaded.
   */
  private newAgent3m(reads: Reads, period: Period, started: readonly { membershipId: string; startDate: string }[]): ScorecardCell {
    if (period.months.length === 0) return PENDING;
    const cohort = activationCohort(started, { from: period.from, to: period.end });
    // Each hire's start in the period: the one activation the cohort counted them by.
    const startOf = new Map<string, string>();
    for (const a of started) {
      if (a.startDate >= period.from && a.startDate <= period.end && !startOf.has(a.membershipId)) startOf.set(a.membershipId, a.startDate);
    }
    const hires = cohort.map((id) => {
      const person = reads.byId.get(id);
      return Array.from({ length: NEW_AGENT_ACTIVE_MONTHS }, (_, i): CohortMonth => {
        const m = shiftMonth(startOf.get(id)!.slice(0, 7), i);
        const bounds = this.boundsOf(reads, m);
        return {
          held: reads.office.get(m)?.held === true,
          // Judged by leaving alone (the spec's *Noted* 4): the activation's start is when the hire began, and a leader
          // may move it before the join (OD-118) — a month before `joinedAt` is still one of theirs.
          belonged: person !== undefined && belongedDuring({ ...person, joinedAt: null }, bounds.start, bounds.endExclusive),
          active: this.activeIn(reads, id, m),
        };
      });
    });
    const share = newAgent3mActive(hires);
    if (share.pct === null) return PENDING;
    const waitingOn = cohort.flatMap((id, i) => (cohortOutcome(hires[i]) === 'left_out'
      ? hires[i].map((m, k) => (m.held ? null : shiftMonth(startOf.get(id)!.slice(0, 7), k))).filter((m): m is string => m !== null)
      : []));
    return figure(share.pct, [...new Set(waitingOn)].sort());
  }

  /**
   * The office's `NEW_ACTIVE_AGENTS` and policy count, month by month, over a range — each the sum of every figure the
   * office's file holds for the month, a leaver's included (OD-74), `null` where it holds none: one aggregate over the
   * office's rows on the `(kpmId, month, deletedAt)` index, as `officeMonths` sums APE.
   */
  private async fileMonths(ctx: RequestContext, range: { from: string; to: string }): Promise<Map<string, FileMonth>> {
    const heldCount = (path: string) => ({ $sum: { $cond: [{ $ne: [{ $ifNull: [path, null] }, null] }, 1, 0] } });
    const rows = await this.monthRows.aggregate(ctx, [
      { $match: { month: { $gte: range.from, $lte: range.to } } },
      {
        $group: {
          _id: '$month',
          newActiveAgents: { $sum: { $ifNull: ['$newActiveAgentsMonthly.value', 0] } },
          newActiveAgentsHeld: heldCount('$newActiveAgentsMonthly.value'),
          policies: { $sum: { $ifNull: ['$policyCountMonthly.value', 0] } },
          policiesHeld: heldCount('$policyCountMonthly.value'),
        },
      },
    ]);
    return new Map(rows.map((row) => [String(row._id), {
      newActiveAgents: (row.newActiveAgentsHeld as number) > 0 ? (row.newActiveAgents as number) : null,
      policies: (row.policiesHeld as number) > 0 ? (row.policies as number) : null,
    }]));
  }
}
