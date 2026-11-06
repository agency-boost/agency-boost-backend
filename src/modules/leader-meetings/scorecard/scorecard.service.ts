import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { endOfMonth, type LocalDate } from '@/common/time/local-day';
import { casesPerProducingAgent } from '@/domain/metrics/cases-per-producing-agent';
import { averageCaseSizeRealised, caseSubmissions, maaMonthlyAvg, recruitmentMonthlyAvg } from '@/domain/metrics/held-months';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { newAgentActivationOf, newAgentActivationShare } from '@/domain/metrics/new-agent-activation-3m';
import { memberAt, officeHeadcount } from '@/domain/metrics/office-headcount';
import { belongedDuring, producingAgents } from '@/domain/metrics/producing-agents';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import type { HeldFigure, MonthCells, OfficeMonth } from '@/modules/production/production-readings';
import { AGENCY_CLASS, AGENT_CLASS, UNIT_CLASS } from '@/modules/reporting/agency-partition';
import { shiftMonth } from '@/modules/reporting/office-figures';
import { OfficePeople, type OfficePerson } from '@/modules/reporting/office-people';
import {
  COLUMN_KEYS, MONTH_COLUMN_KEYS, ROW_UNITS, type ColumnKey, type ColumnPeriod, type ComputedScorecard,
  type RowKey, type ScorecardCell, type ScorecardChips, type ScorecardInput,
} from './scorecard.types';

/** *Full Year {Y−1}* and *YTD {Y−1}*: the columns that read *"—"* until any month of theirs is uploaded (ADR-0203 §8). */
const YEAR_BEFORE_COLUMN_KEYS: readonly ColumnKey[] = ['fy', 'ytdLastYear'];

/** A column's period: its first day, and the day it ends — the earliest of its own last day, the meeting's and today. */
interface Period {
  from: LocalDate;
  end: LocalDate;
  /** `YYYY-MM`, from the first month to the end's; none for a period that has not begun by its end. */
  months: string[];
}

/** What every row reads, read once (`compute`). */
interface Reads {
  timezone: string;
  everyone: readonly OfficePerson[];
  office: ReadonlyMap<string, OfficeMonth>;
  /** Each month's policy count over the office's file, `null` where no figure is held. */
  policies: ReadonlyMap<string, number | null>;
  cells: ReadonlyMap<string, ReadonlyMap<string, MonthCells>>;
  /** Each month's bounds in the office's zone, computed once a month however many members read them. */
  bounds: Map<string, { start: Date; endExclusive: Date }>;
}

const PENDING: ScorecardCell = { kind: 'pending' };
const NONE: ScorecardCell = { kind: 'none' };
const BLOCKED: ScorecardCell = { kind: 'blocked' };
const NOT_UPLOADED: ScorecardCell = { kind: 'not_uploaded' };
const figure = (value: number, leavesOut: string[] = []): ScorecardCell => ({ kind: 'figure', value, leavesOut });
const orPending = (value: number | null, leavesOut: string[]): ScorecardCell =>
  (value === null ? PENDING : figure(value, leavesOut));

/**
 * **The months each column names, from the meeting's own month** (P18.9-T1 AC-2; ADR-0175 §1): *Full Year {Y−1}*
 * January to December of the year before, ***YTD {Y−1}*** January to the meeting's month of the year before — the
 * months *YTD {Y}* covers — *YTD {Y}* January to the meeting's month, and the three single months. What each header's
 * second line reads; a scorecard frozen before *YTD {Y−1}* existed is named by the same function (`scorecard-record.ts`).
 */
export function columnPeriods(meetingDate: string): Record<ColumnKey, ColumnPeriod> {
  const month = meetingDate.slice(0, 7);
  const lastYear = String(Number(meetingDate.slice(0, 4)) - 1);
  const single = (m: string): ColumnPeriod => ({ from: m, to: m });
  return {
    fy: { from: `${lastYear}-01`, to: `${lastYear}-12` },
    ytdLastYear: { from: `${lastYear}-01`, to: shiftMonth(month, -12) },
    ytd: { from: `${month.slice(0, 4)}-01`, to: month },
    thisMonthLastYear: single(shiftMonth(month, -12)),
    lastMonth: single(shiftMonth(month, -1)),
    thisMonth: single(month),
  };
}

/**
 * **The forum's *Overview & Stats*, computed** (OD-144, ADR-0129, ADR-0175; `functional/leader-forum.md`, *Overview &
 * Stats*): the five chips, *AS OF*, and the nine rows over the six periods a meeting's date names (*Full Year {Y−1}*,
 * *YTD {Y−1}*, *YTD {Y}*, *This Month, Last Year*, *Last Month*, *This Month*). The forum's service calls it for a live
 * meeting on every read and once more for the freeze; the meeting overlays its typed *Monthly Target* and its
 * `frozenAt`.
 *
 * **Every figure through the function that already computes it** (invariant §8) — the office's people as the Overview
 * reads them (`OfficePeople`), `OFFICE_HEADCOUNT` and the composition by class, the office's file as the analytics
 * sums it (`ProductionReadings.officeMonths`), the members' year to date by the rule the Overview's `ledgersFor` reads
 * it with and `MONTHLY_ACTIVE_AGENT` and `MAA_COUNT_IN_UNIT` from the month table's cells, both from one read
 * (`monthCellsAndYearToDateFor`) — and the forum's own, each once under `domain/metrics/`. ***YTD {Y−1}* goes
 * through the same functions as *YTD {Y}***, a year earlier (P18.9-T1 AC-1). **A period ends at the earliest of its
 * own last day, the meeting's date and today**: a point-in-time figure is taken on that day; a figure from the file
 * counts the period's months the office holds now, and names the ones it leaves out — but the office's current month,
 * whose file is not due yet. **Exact**: no rounding but money's to whole minor units.
 *
 * **A fixed number of queries whatever the office's size** (`scorecard.performance.spec.ts`): the office's people,
 * then five reads at once — the file month by month, its policy count, each member's cells and year to date, the new
 * hires and the latest upload — and nothing per member. Read through the tenant repositories, in the office named
 * (invariant §1). Writes nothing. *Since 2026-10-28* (the CI run's 3,217 ms against the meeting read's 3 s): six
 * queries, where eleven read the year to date three times over, each hydrated, and the people's names no cell uses.
 */
@Injectable()
export class LeaderScorecardService {
  constructor(
    private readonly people: OfficePeople,
    // The official APE (ADR-0195): the scorecard reads the office's file and never a member's estimate (UI-157 item 5).
    private readonly production: OfficialApe,
    private readonly monthRows: MonthlyAgentDataRepository,
    // The office's new hires, for *3M new agent %* — `NEW_AGENT_ACTIVATION_3M_PCT` since P19.3-T1 (ADR-0202), read here.
    private readonly memberships: MembershipRepository,
    private readonly clock: Clock,
    // P18.9-T1 AC-13: the day of the office's latest upload, *AS OF* — read here, written by the import alone.
    private readonly batches: DataUploadBatchRepository,
  ) {}

  async compute(input: ScorecardInput): Promise<ComputedScorecard> {
    const { kpmId, timezone, meetingDate } = input;
    const ctx = RequestContext.tenantRead(kpmId, 'leader-scorecard');
    const today = this.clock.localDateFor(timezone);
    const year = Number(meetingDate.slice(0, 4));
    const month = meetingDate.slice(0, 7);
    const lastYear = String(year - 1);
    const periods = this.periodsOf(meetingDate, today);

    // ---- The reads: the people since the first period began, then the rest at once.
    // The office's zone, which the meeting names already: `OfficePeople` reads it again only when it is not given. No
    // name: no cell names anybody.
    const everyone = await this.people.everyone(ctx, this.clock.startOfLocalDay(timezone, `${lastYear}-01-01`), timezone);
    const ids = everyone.map((p) => p.membershipId);
    // Production is everybody's who was here in the year, a leaver's included (OD-74), as the Overview's year to date.
    const since = (y: string) => this.clock.startOfLocalDay(timezone, `${y}-01-01`).getTime();
    const producersIn = (y: string) => everyone
      .filter((p) => p.status === 'active' || (p.removedAt !== null && p.removedAt.getTime() >= since(y)))
      .map((p) => p.membershipId);
    // The file from January of last year to the meeting's month: no period reads past it.
    const range = { from: `${lastYear}-01`, to: month };
    const cohortTo = [periods.fy.end, periods.ytd.end].sort()[1];
    const [office, policies, file, newHires, asOf] = await Promise.all([
      this.production.officeMonths(ctx, range),
      this.policyMonths(ctx, range),
      // Each member's cells and year to date in one read: every year column's months are inside the range.
      this.production.monthCellsAndYearToDateFor(ctx, ids, range),
      // Every new hire who joined over the periods, removed or not — a cohort is who joined. P19.3-T1: their own file's
      // months are read from the cells, by their membership (ADR-0202 §1).
      this.memberships.find(
        ctx,
        { joinedAs: 'new_hire', joinDate: { $gte: periods.fy.from, $lte: cohortTo } },
        { projection: { _id: 1, joinedAs: 1, joinDate: 1 } },
      ),
      this.latestUpload(ctx, range, timezone),
    ]);
    const reads: Reads = { timezone, everyone, office, policies, cells: file.cells, bounds: new Map() };

    // ---- Each row, column by column. **The office's current month is never named as left out**, as the Overview's
    // `missingMonths` never names it: its file is not due until it ends. *This Month* still reads *pending data* then.
    const current = today.slice(0, 7);
    // P19.3-T1 (ADR-0203 §8): a year-before column with no month of its period held reads *"—"*, where it read *pending
    // data* — the SLF map's *"Show '—' until uploaded"*. A figure the app gives (*Manpower*) stays a figure.
    const yearBeforeEmpty = new Set(YEAR_BEFORE_COLUMN_KEYS.filter((key) => !periods[key].months.some((m) => office.get(m)?.held === true)));
    const named = (cell: ScorecardCell, key: ColumnKey): ScorecardCell => {
      if (cell.kind === 'pending' && yearBeforeEmpty.has(key)) return NOT_UPLOADED;
      return cell.kind === 'figure' ? { ...cell, leavesOut: cell.leavesOut.filter((m) => m !== current) } : cell;
    };
    const columns = (cell: (period: Period, key: ColumnKey) => ScorecardCell) =>
      Object.fromEntries(COLUMN_KEYS.map((key) => [key, named(cell(periods[key], key), key)])) as Record<ColumnKey, ScorecardCell>;
    /** A row the table tracks over the year columns alone: *Not tracked* in the *Monthly View*. */
    const yearly = (cell: (period: Period, key: ColumnKey) => ScorecardCell) =>
      columns((period, key) => (MONTH_COLUMN_KEYS.includes(key) ? BLOCKED : cell(period, key)));
    // Whose year to date each year column sums — P18.9-T1 AC-1: *YTD {Y−1}*'s last year's producers, as *Full Year*'s.
    const lastYears = producersIn(lastYear);
    const producers = { fy: lastYears, ytdLastYear: lastYears, ytd: producersIn(String(year)) } as Partial<Record<ColumnKey, string[]>>;

    const producing = yearly((period) => this.producing(reads, period));
    const cases = columns((period) => this.overHeld(period, (m) => policies.get(m) ?? null, caseSubmissions));
    // `newHires` read with `_id` (the projection): each hire's own months in the file are the cells, by membership.
    const hires = newHires.map((m) => ({ membershipId: String((m as unknown as { _id: unknown })._id), joinDate: m.joinDate }));

    const rows: Record<RowKey, Record<ColumnKey, ScorecardCell>> = {
      ape: columns((period, key) => (producers[key]
        ? this.apeToDate(reads, period, (through) => file.apeYearToDateThrough(producers[key]!, through))
        : this.overHeld(period, (m) => office.get(m)?.apeMonthlyMinor ?? null, (values) => values[0]))),
      manpower: columns((period) => figure(officeHeadcount(everyone, this.clock.endOfLocalDay(timezone, period.end)))),
      // P19.3-T1 (ADR-0203 §2): `RECRUITMENT_MONTHLY_AVG`, the upload's recruitment per month (D2), averaged over the
      // column's months held — our reading of the SLF map's *Recruitment*; OD-26 (what *FLC* expands to) stays open.
      flc: columns((period) => this.overHeld(period, (m) => office.get(m)?.recruitmentMonthly ?? null, recruitmentMonthlyAvg)),
      producing_agents: producing,
      new_agent_3m: yearly((period) => this.newAgent3m(reads, period, hires)),
      avg_monthly_aa: columns((period) => this.overHeld(
        period, (m) => this.maaCount(reads, period, m),
        (values) => (period.months.length === 1 ? values[0] : maaMonthlyAvg(values)),
      )),
      case_submission: cases,
      // P19.3-T1 (ADR-0203 §5): per active agent per month — Σ policies ÷ Σ monthly active agents over the months held.
      cases_per_producing_agent: yearly((period) => this.perActiveAgent(reads, period)),
      average_case_size: yearly((period) => {
        const months = period.months.map((m) => ({ apeMinor: office.get(m)?.apeMonthlyMinor ?? null, policies: policies.get(m) ?? null }));
        const size = averageCaseSizeRealised(months);
        if (size === 'none') return NONE;
        const leavesOut = period.months.filter((_, i) => months[i].apeMinor === null || months[i].policies === null);
        return orPending(size, leavesOut);
      }),
    };

    return {
      periods: columnPeriods(meetingDate),
      chips: this.chips(everyone, this.clock.endOfLocalDay(timezone, periods.thisMonth.end)),
      rows: (Object.keys(rows) as RowKey[]).map((key) => ({ key, unit: ROW_UNITS[key], cells: rows[key] })),
      asOf,
      // P19.3-T1 (ADR-0202 §4): stored with a freeze, so the footnotes describe what each row was computed with.
      definitions: 'data_sources',
    };
  }

  /**
   * ***# of units* for a meeting, alone** — the *Monthly Target*'s multiplier, for a target's write to answer with its
   * value (P18.9-T1 AC-10): the chips' own count, the same function on the same day, from one read of the people.
   */
  async units(input: ScorecardInput): Promise<number> {
    const { kpmId, timezone, meetingDate } = input;
    const ctx = RequestContext.tenantRead(kpmId, 'leader-scorecard');
    const periods = this.periodsOf(meetingDate, this.clock.localDateFor(timezone));
    const lastYear = String(Number(meetingDate.slice(0, 4)) - 1);
    const everyone = await this.people.everyone(ctx, this.clock.startOfLocalDay(timezone, `${lastYear}-01-01`), timezone);
    return this.chips(everyone, this.clock.endOfLocalDay(timezone, periods.thisMonth.end)).units;
  }

  /** Each column's period, as its figures are computed: its months, ending at its own end, the meeting's or today. */
  private periodsOf(meetingDate: string, today: LocalDate): Record<ColumnKey, Period> {
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
    return {
      fy: periodOf(`${lastYear}-01-01`, `${lastYear}-12-31`),
      ytdLastYear: periodOf(`${lastYear}-01-01`, endOfMonth(`${shiftMonth(month, -12)}-01`)),
      ytd: periodOf(`${year}-01-01`, endOfMonth(meetingDate)),
      thisMonthLastYear: monthPeriod(shiftMonth(month, -12)),
      lastMonth: monthPeriod(shiftMonth(month, -1)),
      thisMonth: monthPeriod(month),
    };
  }

  /**
   * **The chips**, on the *This Month* period's last day: `OFFICE_HEADCOUNT` — the same function, on the same day, as
   * the *Manpower* row's *This Month* cell — and its members by class (ADR-0156), as `kpm-analytics.service.ts`
   * counts them: a *Senior Leader* rung's members are ABs, whatever the company called it.
   *
   * ***# of units* is the AB and AAB with at least one downline** since P19.3-T1 (ADR-0203 §1; the SLF map's *"Units =
   * number of AB + AAB with ≥ 1 downline"*): a member of either leader class who, that day, leads at least one member —
   * a member that day whose upline they are (ADR-0087's *leads*). It was *# of AB* + *# of AAB* from P18.9-T1 (ADR-0175
   * §3), so it may now be less than the two chips beside it. The *Monthly Target*'s multiplier follows it (`units`).
   */
  private chips(everyone: readonly OfficePerson[], endOfDay: Date): ScorecardChips {
    const members = everyone.filter((p) => memberAt(p, endOfDay));
    const of = (role: string) => members.filter((p) => p.role === role).length;
    const ab = of(AGENCY_CLASS);
    const aab = of(UNIT_CLASS);
    const leading = new Set(members.flatMap((p) => (p.leaderId === null ? [] : [p.leaderId])));
    const units = members.filter((p) => (p.role === AGENCY_CLASS || p.role === UNIT_CLASS) && leading.has(p.membershipId)).length;
    return { manpower: officeHeadcount(everyone, endOfDay), agents: of(AGENT_CLASS), units, ab, aab };
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
   * *Cases/producing agents* (`CASES_PER_PRODUCING_AGENT`) **per active agent per month** since P19.3-T1 (ADR-0203 §5):
   * each month's policies over the office's file and its `MAA_COUNT_IN_UNIT` over the office — the *Avg. monthly AA*
   * row's own count — summed over the period's months holding both, through the metric's function: *—* over nobody,
   * *pending data* while no month holds both, the months either half leaves out named.
   */
  private perActiveAgent(reads: Reads, period: Period): ScorecardCell {
    const months = period.months.map((m) => ({ policies: reads.policies.get(m) ?? null, activeAgents: this.maaCount(reads, period, m) }));
    const value = casesPerProducingAgent(months);
    if (value === 'none') return NONE;
    return orPending(value, period.months.filter((_, i) => months[i].policies === null || months[i].activeAgents === null));
  }

  /**
   * *APE* over the year columns: **the office's year to date through the period's last month**, as the Overview reads
   * it — each producer's latest year-to-date figure held from January to that month, summed — a leaver's kept (OD-74).
   * `yearToDate` answers each producer's figure (`monthCellsAndYearToDateFor`'s `apeYearToDateThrough`, by the rule
   * `ledgersFor` reads the Overview's with: December's is the year's latest, any other month's the next month's
   * *through last month*). The carrier's figure is cumulative, so a month with no file of its own before the latest
   * held is inside it: what the cell leaves out is the period's months after the latest held (the Overview's
   * `missingMonths`, which — as every cell's — never names the office's current month: `compute`).
   */
  private apeToDate(
    reads: Reads, period: Period, yearToDate: (through: string) => ReadonlyMap<string, HeldFigure | null>,
  ): ScorecardCell {
    if (period.months.length === 0) return PENDING;
    const figures = [...yearToDate(period.months[period.months.length - 1]).values()]
      .filter((held) => held !== null)
      .map((held) => held!.minor);
    if (figures.length === 0) return PENDING;
    const heldMonths = period.months.filter((m) => reads.office.get(m)?.held === true);
    return figure(figures.reduce((sum, v) => sum + v, 0), period.months.filter((m) => !heldMonths.some((h) => h >= m)));
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

  /** `PRODUCING_AGENTS` — *Annual Active Agents* — over the period's months held, each member's flags in the months they belonged in. */
  private producing(reads: Reads, period: Period): ScorecardCell {
    const held = period.months.filter((m) => reads.office.get(m)?.held === true);
    const windows = held.map((m) => this.monthEnd(reads, period, m));
    const flags = reads.everyone.map((p) => held
      .filter((_, i) => belongedDuring(p, windows[i].start, windows[i].endExclusive))
      .map((m) => this.activeIn(reads, p.membershipId, m)));
    return orPending(producingAgents(flags, held.length), period.months.filter((m) => !held.includes(m)));
  }

  /**
   * ***3M new agent %*** — **`NEW_AGENT_ACTIVATION_3M_PCT`** since P19.3-T1 (ADR-0202 §1; the data sources' D7, *"in
   * SLF and Quant B1"*), where it was `ACTIVATION_3M_PCT` (ADR-0171 §2, which New Hires keeps): of the office's new hires
   * who joined in the period — by their join date in the office's calendar, removed or not — those with a policy in the
   * office's file in their join month or the three months after it, over those decided. **A month is held for it when the
   * office's file holds a policy count for it** (the column D7 reads); a hire's month with no row of theirs shows none. A
   * hire whose window is not all held, with no policy yet, is in neither part. *Pending data* while nobody is decided; **it
   * names no month left out** — an undecided hire is in no figure. Read through the cells of the one read; never written.
   */
  private newAgent3m(
    reads: Reads, period: Period, hires: readonly { membershipId: string; joinDate: LocalDate | null }[],
  ): ScorecardCell {
    if (period.months.length === 0) return PENDING;
    const cohort = hires.filter((m) => m.joinDate !== null && m.joinDate >= period.from && m.joinDate <= period.end);
    const share = newAgentActivationShare(cohort.map((hire) => newAgentActivationOf(hire.joinDate!, (m) => {
      const held = reads.policies.get(m);
      return { held: held !== null && held !== undefined, policies: reads.cells.get(hire.membershipId)?.get(m)?.policyCountMonthly ?? null };
    })));
    return share.pct === null ? PENDING : figure(share.pct);
  }

  /**
   * The office's policy count, month by month, over a range — the sum of every figure the office's file holds for the
   * month, a leaver's included (OD-74), `null` where it holds none: one aggregate over the office's rows on the
   * `(kpmId, month, deletedAt)` index, as `officeMonths` sums APE. (*New AA*'s `NEW_ACTIVE_AGENTS` sum went with the
   * row, P18.9-T1 AC-6.)
   */
  private async policyMonths(ctx: RequestContext, range: { from: string; to: string }): Promise<Map<string, number | null>> {
    const rows = await this.monthRows.aggregate(ctx, [
      { $match: { month: { $gte: range.from, $lte: range.to } } },
      {
        $group: {
          _id: '$month',
          policies: { $sum: { $ifNull: ['$values.POLICY_COUNT.value', 0] } },
          policiesHeld: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$values.POLICY_COUNT.value', null] }, null] }, 1, 0] } },
        },
      },
    ]);
    return new Map(rows.map((row) => [String(row._id), (row.policiesHeld as number) > 0 ? (row.policies as number) : null]));
  }

  /**
   * ***AS OF*** (P18.9-T1 AC-13; ADR-0175 §6, UI-010): **the office's day its latest production file was uploaded** —
   * the newest import standing (`committed`) of the months the table reads, by the moment the scorecard is computed,
   * in its calendar — or `null` while it has none, which draws no *AS OF*. One read on the batches' `(kpmId, month,
   * status, …)` index.
   */
  private async latestUpload(ctx: RequestContext, range: { from: string; to: string }, timezone: string): Promise<string | null> {
    const [latest] = await this.batches.find(
      ctx,
      { month: { $gte: range.from, $lte: range.to }, status: 'committed', committedAt: { $ne: null, $lte: this.clock.now() } },
      { sort: { committedAt: -1 }, limit: 1, projection: { committedAt: 1 } },
    );
    return latest?.committedAt ? this.clock.localDateFor(timezone, latest.committedAt) : null;
  }
}
