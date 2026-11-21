import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { endOfMonth } from '@/common/time/local-day';
import { QUANT, QUANT_METRICS, type QuantCode, type QuantMetric } from '@/domain/constants';
import {
  isRunPeriodEnd, latestRunPeriodEnd, monthsEndingAt, peerStatus, periodMonths, plusMonths, quantValues,
  type PeerStatus, type QuantCell, type QuantInput, type QuantMember, type QuantMonth, type QuantNullReason, type QuantValue,
} from '@/domain/metrics/quant';
import { leaderDistribution, leaderUnits } from '@/domain/metrics/quant-leaders';
import { memberAt } from '@/domain/metrics/office-headcount';
import { NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import type { AnalyticsThresholds } from '@/modules/config/analytics-config';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import { ProductionWrites } from '@/modules/production/production-writes.port';
import { monthsBetween, UploadCompleteness } from '@/modules/production/upload-completeness';
import { readCell } from '@/modules/production/production-readings';
import { ADVANCED_ANALYTICS_REFUSALS as SAY } from './advanced-analytics.messages';
import { QuantRunRepository } from './advanced-analytics.repositories';
import type { QuantRunDocument, StoredPeers, StoredQuantValue } from './quant-run.schema';

/** One metric as the *Analitik kuantitatif* tab draws it. */
export interface QuantMetricView {
  code: QuantCode;
  metric: QuantMetric;
  value: number | null;
  complete: boolean;
  missingMonths: string[];
  reason: QuantNullReason;
  /** `QUANT_PEER_MEDIAN`: `null` below `needed` peers. */
  median: number | null;
  /** How many peers held the metric complete. */
  peers: number;
  /** `QUANT_PEER_STATUS`, by the template's current bands; `null` draws no chip. */
  status: PeerStatus | null;
  /**
   * ***Semester lalu*** (P19.22-T4 AC-1; ADR-0275 §4): the same metric in the run six months before — `null` when there is
   * none, or when the two runs are not over the same number of months (a December run frozen before the half-years held
   * the whole year), which no ▲/▼ can be drawn between.
   */
  previous: number | null;
  /** **The distribution per leader** (AC-2): each leader's value over their own unit, high to low, and their median. */
  distribution: QuantDistributionView;
}

/** A leader's bar: who, and the metric over their unit. The service names them. */
export interface QuantLeaderValue {
  membershipId: string;
  role: 'ab' | 'aab';
  value: number;
}

export interface QuantDistributionView {
  leaders: QuantLeaderValue[];
  /** `QUANT_LEADER_MEDIAN` — *Median KPM*. */
  median: number | null;
  /** *x dari y leader di atau di atas median*. */
  atOrAbove: number;
}

/** A run the picker offers: its last month and its first — January or July; January for a December run of before. */
export interface QuantRunRef {
  periodEnd: string;
  fromMonth: string;
}

export interface QuantView {
  /** The run shown, `YYYY-06` or `YYYY-12`; `null` before the first run (the empty state). */
  periodEnd: string | null;
  /** Its first month: the half-year's (P19.22-T4), or January for a December run frozen before the half-years. */
  fromMonth: string | null;
  /** Every run the KPM has, newest first, with the months each covers. */
  runs: QuantRunRef[];
  freezesAt: string | null;
  frozenAt: string | null;
  /** *"Data diunggah setelah periode dikunci"*. */
  lateWriteAt: string | null;
  /** `QUANT.MIN_PEERS`: *"Belum cukup KPM pembanding (n dari 3)"*. */
  needed: number;
  /** The bands the chips are coloured by — the template's now, so a colour-only change re-colours (R6). */
  bands: { peerBandPct: number; diffBand: number };
  metrics: QuantMetricView[];
}

const SYSTEM = ['APE', 'POLICY_COUNT', 'RECRUITMENT'] as const;

/**
 * **Quant runs** (P19.5-T3 AC-5 to AC-9; ADR-0215 §5, §6; AA UI-012, UI-014, UI-023; AT-6, AT-7): a KPM's ten metrics
 * for each semi-annual period, against the median of its company's other KPMs with complete data.
 *
 * - **A run exists from the first day after its period**; the KPM's runs are every June and December from its required
 *   history's start (R5) to the latest ended.
 * - **Recalculated until `freezesAt`** — on every read and on every write into a month it reads (`ProductionWrites`) —
 *   **then frozen** by the first read or write after it, its values and medians stored as they stand.
 * - **A write into a frozen run's months** marks it, and changes nothing in it.
 * - **A read-only context writes nothing** (a Super Admin's platform read, a view-as session): it computes the run as it
 *   would stand, and leaves storing it to the KPM's own next read or write.
 *
 * *As built:* no daily job freezes a run at 00:05 — the backend has no scheduler. The first read or write after
 * `freezesAt` freezes it before anything else, so the stored figures are the ones that stood at `freezesAt`.
 */
@Injectable()
export class QuantRuns implements ProductionWrites {
  constructor(
    private readonly runs: QuantRunRepository,
    private readonly memberships: MembershipRepository,
    private readonly monthRows: MonthlyAgentDataRepository,
    private readonly production: OfficialApe,
    private readonly completeness: UploadCompleteness,
    private readonly clock: Clock,
  ) {}

  /** **`GET /kpm/advanced-analytics/quant`** — a run, the latest by default. */
  async read(ctx: RequestContext, thresholds: AnalyticsThresholds, asked?: string): Promise<QuantView> {
    const office = await this.completeness.office(ctx);
    const currentMonth = this.clock.localDateFor(office.timezone).slice(0, 7);
    const ends = this.runsOf(office.firstMonth, currentMonth);
    const stored = new Map((await this.runs.find(ctx, { periodEnd: { $in: ends } }, { projection: { periodEnd: 1, fromMonth: 1, frozenAt: 1 } }))
      .map((r) => [r.periodEnd, r]));
    const fromOf = (p: string) => {
      const row = stored.get(p);
      return row?.frozenAt && !row.fromMonth ? `${p.slice(0, 4)}-01` : row?.fromMonth ?? periodMonths(p)[0];
    };
    const runs: QuantRunRef[] = ends.map((p) => ({ periodEnd: p, fromMonth: fromOf(p) }));
    const bands = { peerBandPct: thresholds.quantPeerBandPct, diffBand: thresholds.quantDiffBand };
    const empty: QuantView = {
      periodEnd: null, fromMonth: null, runs, freezesAt: null, frozenAt: null, lateWriteAt: null, needed: QUANT.MIN_PEERS, bands,
      metrics: [],
    };
    if (asked !== undefined && (!isRunPeriodEnd(asked) || asked >= currentMonth)) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.periodEndShape, { field: 'periodEnd' });
    }
    const periodEnd = asked ?? ends[0];
    if (periodEnd === undefined) return empty;
    if (!ends.includes(periodEnd)) throw new NotFoundException('Advanced analytics', { periodEnd });

    const fromMonth = fromOf(periodEnd);
    const run = await this.settle(ctx, periodEnd, office.timezone);
    const peers = run.peers ?? await this.runs.peerMediansAcrossTenants(ctx, periodEnd, fromMonth);
    // *Semester lalu*: the run six months before, when the office has it and it covers as many months as this one.
    const before = plusMonths(periodEnd, -QUANT.SEMESTER_MONTHS);
    const halfYear = (p: string) => fromOf(p) === periodMonths(p)[0];
    const previous = ends.includes(before) && halfYear(before) && halfYear(periodEnd)
      ? (await this.settle(ctx, before, office.timezone)).values
      : null;
    const perLeader = await this.perLeader(ctx, periodEnd, office.timezone);
    return {
      periodEnd,
      fromMonth,
      runs,
      freezesAt: this.freezesAt(office.timezone, periodEnd).toISOString(),
      frozenAt: run.frozenAt ? run.frozenAt.toISOString() : null,
      lateWriteAt: run.lateWriteAt ? run.lateWriteAt.toISOString() : null,
      needed: QUANT.MIN_PEERS,
      bands,
      metrics: QUANT_METRICS.map(({ code, metric }) => {
        const own = run.values[metric];
        const peer = peers[metric];
        return {
          code, metric, value: own.value, complete: own.complete, missingMonths: own.missingMonths, reason: own.reason,
          median: peer.median, peers: peer.peers,
          status: peerStatus(own, peer.median, code === 'A2'
            ? { kind: 'absolute', size: bands.diffBand }
            : { kind: 'pct', size: bands.peerBandPct }),
          previous: previous?.[metric]?.value ?? null,
          distribution: this.distributionOf(perLeader, metric),
        };
      }),
    };
  }

  // -------------------------------------------------------------------------------------- ProductionWrites

  /** Before a write into `month`: every run it reaches that is past its freeze is frozen as it stands. */
  async beforeWrite(ctx: RequestContext, month: string): Promise<void> {
    const office = await this.completeness.office(ctx);
    const now = this.clock.now();
    for (const periodEnd of this.reachedBy(month, office.firstMonth, office.timezone)) {
      if (this.freezesAt(office.timezone, periodEnd) <= now) await this.settle(ctx, periodEnd, office.timezone);
    }
  }

  /** After it: a live run that reads `month` is recalculated; a frozen one is marked, and keeps its figures. */
  async afterWrite(ctx: RequestContext, month: string): Promise<void> {
    const office = await this.completeness.office(ctx);
    const touched = await this.runs.reading(ctx, month);
    await this.runs.markLateWrite(ctx, touched.filter((r) => r.frozenAt).map((r) => String(r._id)), this.clock.now());
    for (const run of touched.filter((r) => !r.frozenAt)) await this.settle(ctx, run.periodEnd, office.timezone);
  }

  // ------------------------------------------------------------------------------------------------ parts

  /** The KPM's runs, newest first: each June and December from the first after its history's start to the latest ended. */
  runsOf(firstMonth: string, currentMonth: string): string[] {
    const from = plusMonths(firstMonth, -12);
    const out: string[] = [];
    for (let p = latestRunPeriodEnd(currentMonth); p >= from; p = plusMonths(p, -6)) out.push(p);
    return out.filter(isRunPeriodEnd);
  }

  /** The ended runs a write into `month` reaches: those whose 24 months hold it. */
  private reachedBy(month: string, firstMonth: string, timezone: string): string[] {
    const runs = this.runsOf(firstMonth, this.clock.localDateFor(timezone).slice(0, 7));
    return runs.filter((p) => p >= month && monthsEndingAt(p, QUANT.GROWTH_MONTHS)[0] <= month);
  }

  /** 00:00 on the day after `QUANT.FREEZE_DAY` of the month after the period, in the KPM's calendar. */
  freezesAt(timezone: string, periodEnd: string): Date {
    return this.clock.startOfLocalDay(timezone, `${plusMonths(periodEnd, 1)}-${String(QUANT.FREEZE_DAY + 1).padStart(2, '0')}`);
  }

  /**
   * **The run as it stands now**: a frozen one as stored; a live one computed — and, in a writable context, stored, or
   * frozen when its freeze has passed. A read-only context computes and stores nothing.
   */
  private async settle(ctx: RequestContext, periodEnd: string, timezone: string): Promise<{
    values: Record<QuantMetric, StoredQuantValue>; peers: Record<QuantMetric, StoredPeers> | null;
    frozenAt: Date | null; lateWriteAt: Date | null;
  }> {
    const stored = await this.runs.ofPeriod(ctx, periodEnd);
    if (stored?.frozenAt) return { values: stored.values, peers: stored.peers, frozenAt: stored.frozenAt, lateWriteAt: stored.lateWriteAt };
    const values = await this.compute(ctx, periodEnd, timezone);
    const now = this.clock.now();
    const freezesAt = this.freezesAt(timezone, periodEnd);
    const writable = !ctx.impersonationReadOnly && ctx.kpmId !== null;
    if (!writable) return { values, peers: null, frozenAt: null, lateWriteAt: null };
    const companyId = await this.runs.companyOf(ctx);
    const fromMonth = periodMonths(periodEnd)[0];
    await this.runs.writeLive(ctx, periodEnd, { companyId, values, computedAt: now, freezesAt, fromMonth });
    if (freezesAt > now) return { values, peers: null, frozenAt: null, lateWriteAt: null };
    const peers = await this.runs.peerMediansAcrossTenants(ctx, periodEnd, fromMonth);
    await this.runs.freeze(ctx, periodEnd, { values, peers, at: now });
    const frozen = await this.runs.ofPeriod(ctx, periodEnd);
    return {
      values: frozen?.values ?? values, peers: frozen?.peers ?? peers, frozenAt: frozen?.frozenAt ?? now, lateWriteAt: frozen?.lateWriteAt ?? null,
    };
  }

  /** **The ten metrics for a period**, from one read of the people, the file and its completeness (R1). */
  async compute(ctx: RequestContext, periodEnd: string, timezone: string): Promise<Record<QuantMetric, StoredQuantValue>> {
    const read = await this.inputs(ctx, periodEnd, timezone);
    return quantValues({ ...read.input, members: read.people, months: read.months, cell: read.cell }) as Record<QuantMetric, StoredQuantValue>;
  }

  /**
   * **Each leader's ten metrics over their own unit** (P19.22-T4 AC-2; ADR-0275 §4): the leader and the people whose
   * nearest leader they are (`leaderUnits`), each metric by its own definition over them — the unit's months summed from
   * its members' cells, the office's months held and complete as the office's — the leader its one leader. **The
   * leaders at the period's end**, from today's lines. **Read live**, never frozen with the run: the KPM's own value is
   * the run's.
   */
  async perLeader(ctx: RequestContext, periodEnd: string, timezone: string): Promise<{
    leaders: { membershipId: string; role: 'ab' | 'aab' }[];
    values: Map<string, Record<QuantMetric, QuantValue>>;
  }> {
    const read = await this.inputs(ctx, periodEnd, timezone);
    const units = leaderUnits(read.people.map((p) => ({ membershipId: p.membershipId, role: p.role, leaderId: p.leaderId })));
    const leaders = read.people
      .filter((p) => (p.role === 'ab' || p.role === 'aab') && memberAt(p.counted, read.input.endOfPeriod))
      .map((p) => ({ membershipId: p.membershipId, role: p.role as 'ab' | 'aab' }));
    const values = new Map<string, Record<QuantMetric, QuantValue>>();
    for (const leader of leaders) {
      const ids = new Set(units.get(leader.membershipId) ?? [leader.membershipId]);
      const members = read.people.filter((p) => ids.has(p.membershipId));
      const months = new Map<string, QuantMonth>();
      for (const [m, office] of read.months) {
        const cells = members.map((p) => read.cell(p.membershipId, m)).filter((c): c is QuantCell => c !== undefined);
        const sum = (pick: (c: QuantCell) => number | null, held: boolean) => {
          if (!held) return null;
          return cells.reduce((total, c) => total + (pick(c) ?? 0), 0);
        };
        months.set(m, {
          ...office,
          apeMinor: sum((c) => c.apeMinor, office.held),
          policies: sum((c) => c.policies, office.policiesHeld),
          recruitment: office.recruitment === null ? null : sum((c) => c.recruitment, true),
        });
      }
      values.set(leader.membershipId, quantValues({ ...read.input, members, months, cell: read.cell }));
    }
    return { leaders, values };
  }

  /** One metric's distribution: the leaders holding a value, high to low, and their median. */
  private distributionOf(
    perLeader: Awaited<ReturnType<QuantRuns['perLeader']>>, metric: QuantMetric,
  ): QuantDistributionView {
    const role = new Map(perLeader.leaders.map((l) => [l.membershipId, l.role]));
    const values = perLeader.leaders
      .map((l) => ({ membershipId: l.membershipId, value: perLeader.values.get(l.membershipId)?.[metric]?.value ?? null }))
      .filter((l): l is { membershipId: string; value: number } => l.value !== null);
    const d = leaderDistribution(values);
    return {
      leaders: d.leaders.map((l) => ({ membershipId: l.membershipId, role: role.get(l.membershipId)!, value: l.value })),
      median: d.median,
      atOrAbove: d.atOrAbove,
    };
  }

  /** The reads every computation of a period makes, once: the people, the file and its completeness. */
  private async inputs(ctx: RequestContext, periodEnd: string, timezone: string): Promise<{
    input: Pick<QuantInput, 'periodEnd' | 'endOfPeriod' | 'tenuredBefore'>;
    people: (QuantMember & { leaderId: string | null })[];
    months: Map<string, QuantMonth>;
    cell: (id: string, m: string) => QuantCell | undefined;
  }> {
    const currentMonth = this.clock.localDateFor(timezone).slice(0, 7);
    const from = plusMonths(periodEnd, -(QUANT.GROWTH_MONTHS - 1));
    const lateWindow = plusMonths(periodEnd, QUANT.ACTIVATION_MONTHS_AFTER_JOIN);
    const to = lateWindow < currentMonth ? lateWindow : currentMonth;
    const range = { from, to };
    const [members, rows, office, fill] = await Promise.all([
      // P19.22-T4 (ADR-0267 §1): never a test account; each member's leader, for the units.
      this.memberships.find(
        ctx, { status: { $in: ['active', 'removed'] }, ...NOT_A_TEST_ACCOUNT },
        { projection: { role: 1, status: 1, joinDate: 1, joinedAt: 1, removedAt: 1, joinedAs: 1, leaderId: 1 } },
      ),
      this.monthRows.findByKode(ctx, { month: { $gte: from, $lte: to } }, [...SYSTEM]),
      this.production.officeMonths(ctx, range),
      this.completeness.forRange(ctx, range),
    ]);
    const cells = new Map<string, QuantCell>();
    const policies = new Map<string, { sum: number; held: boolean }>();
    for (const row of rows) {
      const cell: QuantCell = {
        apeMinor: readCell(row.values.APE).value,
        policies: readCell(row.values.POLICY_COUNT).value,
        recruitment: readCell(row.values.RECRUITMENT).value,
      };
      cells.set(`${row.membershipId}|${row.month}`, cell);
      const p = policies.get(row.month) ?? { sum: 0, held: false };
      if (cell.policies !== null) policies.set(row.month, { sum: p.sum + cell.policies, held: true });
      else policies.set(row.month, p);
    }
    const months = new Map<string, QuantMonth>();
    for (const m of monthsBetween(from, to)) {
      const bounds = this.clock.monthBounds(timezone, m);
      const file = office.get(m);
      const p = policies.get(m);
      months.set(m, {
        month: m, start: bounds.start, endExclusive: bounds.endExclusive,
        held: file?.held === true, policiesHeld: p?.held === true, complete: fill.fills.get(m)?.status === 'complete',
        apeMinor: file?.apeMonthlyMinor ?? null, policies: p?.held ? p.sum : null, recruitment: file?.recruitmentMonthly ?? null,
      });
    }
    const people = members.map((m) => {
      const row = m as unknown as {
        _id: unknown; role: 'ab' | 'aab' | 'agent'; status: 'active' | 'removed'; joinDate?: string | null;
        joinedAt?: Date | null; removedAt?: Date | null; joinedAs?: string | null; leaderId?: string | null;
      };
      return {
        membershipId: String(row._id),
        role: row.role,
        leaderId: row.leaderId ?? null,
        joinDate: row.joinDate ?? null,
        newHire: row.joinedAs === 'new_hire',
        counted: {
          status: row.status, joinedAt: row.joinedAt ?? null, removedAt: row.removedAt ?? null,
          joinDateStart: row.joinDate ? this.clock.startOfLocalDay(timezone, row.joinDate) : null,
        },
      };
    });
    const lastDay = endOfMonth(`${periodEnd}-01`);
    return {
      input: {
        periodEnd,
        endOfPeriod: this.clock.monthBounds(timezone, periodEnd).endExclusive,
        tenuredBefore: this.clock.startOfLocalDay(timezone, `${Number(lastDay.slice(0, 4)) - 1}${lastDay.slice(4)}`),
      },
      people,
      months,
      cell: (id, m) => cells.get(`${id}|${m}`),
    };
  }
}

export type { QuantRunDocument };
