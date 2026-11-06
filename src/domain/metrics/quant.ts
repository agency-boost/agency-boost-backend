import { LEADER_CLASSES, QUANT, type QuantMetric } from '@/domain/constants';
import { casesPerProducingAgent } from './cases-per-producing-agent';
import { averageCaseSizeRealised, maaMonthlyAvg } from './held-months';
import { maaCountInUnit } from './maa-count-in-unit';
import { monthlyActiveAgent } from './monthly-active-agent';
import { newAgentActivationOf, newAgentActivationShare, type NewAgentActivationResult, type WindowMonth } from './new-agent-activation-3m';
import { countedFrom, memberAt, type CountedMembership } from './office-headcount';
import { belongedDuring, producingAgents } from './producing-agents';
import { rateOver } from './rate';

/**
 * **Quantitative analytics: the ten metrics, A1 to D1** (P19.5-T3 AC-6; ADR-0215 §6; the data sources' *Advanced
 * analytics* field map; `metrics-and-definitions.md` §A.15).
 *
 * - **R1:** every metric reads the four system columns (`APE`, `POLICY_COUNT`, `RECRUITMENT`, `NEW_ACTIVE_AGENTS`) and
 *   the member list, nothing else — the caller hands in the cells of those kodes alone.
 * - **A leader** is a member of the `ab` or `aab` class *Aktif* at the period's end (Q2; ADR-0200 §8). A division by no
 *   leader is `null` with the reason `no_leader` (*—*), never 0.
 * - **Active** is D1, `MONTHLY_ACTIVE_AGENT`. B1 is `NEW_AGENT_ACTIVATION_3M_PCT`, C2 `CASES_PER_PRODUCING_AGENT` and D1
 *   `AVERAGE_CASE_SIZE_REALISED`, each through its own function over the run's months (invariant §8).
 * - **Complete** (R4, AT-6): a metric is complete when every month it reads is `UPLOAD_MONTH_COMPLETE`; its
 *   `missingMonths` name the others. An incomplete value has no chip and is left out of the other KPMs' medians.
 *
 * Pure: the caller reads the office's people and file once (`QuantRuns`).
 */

/** A member as the metrics read them: their class, when they were here, and their join day. */
export interface QuantMember {
  membershipId: string;
  role: 'ab' | 'aab' | 'agent';
  counted: CountedMembership;
  /** `memberships.joinDate`, `YYYY-MM-DD` in the office's calendar; `null` on a row older than the field. */
  joinDate: string | null;
  /** `joinedAs = new_hire` (ADR-0169): who B1 and B2 count. */
  newHire: boolean;
}

/** One member's month of the four system columns; `null` is nothing held, never zero. */
export interface QuantCell {
  apeMinor: number | null;
  policies: number | null;
  recruitment: number | null;
}

/** One month of the office's file, summed, and its bounds in the office's zone. */
export interface QuantMonth {
  month: string;
  start: Date;
  endExclusive: Date;
  /** The office's file holds an APE or a policy figure for it (`OfficeMonth.held`). */
  held: boolean;
  /** The office's file holds a policy count for it — what B1 and B2 decide on (D7). */
  policiesHeld: boolean;
  /** `UPLOAD_MONTH_COMPLETE`: complete for the KPM. */
  complete: boolean;
  apeMinor: number | null;
  policies: number | null;
  recruitment: number | null;
}

export interface QuantInput {
  /** `YYYY-06` or `YYYY-12`. */
  periodEnd: string;
  /** The instant the period ends (exclusive): 00:00 on the first day after it, in the office's zone. */
  endOfPeriod: Date;
  /** The instant 12 months before the period's end: B3's tenured joined before it. */
  tenuredBefore: Date;
  /** Everybody here at any time over the 24 months read, a leaver included (OD-74). */
  members: readonly QuantMember[];
  /** The office's months, from 23 months before `periodEnd` to as late as the file is read. */
  months: ReadonlyMap<string, QuantMonth>;
  cell(membershipId: string, month: string): QuantCell | undefined;
}

/** Why a value is `null` where it is not simply unheld. */
export type QuantNullReason = 'no_leader' | 'not_enough_data' | null;

export interface QuantValue {
  /** Ratios to one decimal, percentages whole, money in whole minor units; `null` is *—*. */
  value: number | null;
  complete: boolean;
  /** The months read that are not complete (*Belum lengkap · <Bul> belum diunggah*). */
  missingMonths: string[];
  reason: QuantNullReason;
}

/** `YYYY-MM` moved by `by` months. */
export function plusMonths(month: string, by: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** `count` months ending at `last`, oldest first. */
export function monthsEndingAt(last: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => plusMonths(last, i - count + 1));
}

/** A run's own months: January to its last month. */
export function periodMonths(periodEnd: string): string[] {
  return monthsEndingAt(periodEnd, Number(periodEnd.slice(5, 7)));
}

/** Is `month` the last month of a run's period (June or December)? */
export function isRunPeriodEnd(month: string): boolean {
  return /^\d{4}-\d{2}$/.test(month) && (QUANT.RUN_MONTHS as readonly number[]).includes(Number(month.slice(5, 7)));
}

/** The latest run period that has ended by `currentMonth` (a run exists from the first day after its period). */
export function latestRunPeriodEnd(currentMonth: string): string {
  let m = plusMonths(currentMonth, -1);
  while (!isRunPeriodEnd(m)) m = plusMonths(m, -1);
  return m;
}

/** One decimal, half away from zero — the ratios' rounding. */
export function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * **A new hire's result over a window of `monthsAfter` calendar months after the join month** — D7's rule, with the
 * window B2 reads (the join month and 12 after). B1 keeps `newAgentActivationOf`, D7's four months.
 */
export function activationWithin(joinDate: string, monthsAfter: number, monthOf: (month: string) => WindowMonth): NewAgentActivationResult {
  const window = Array.from({ length: monthsAfter + 1 }, (_, i) => plusMonths(joinDate.slice(0, 7), i)).map(monthOf);
  if (window.some((m) => m.held && m.policies !== null && m.policies > 0)) return 'activated';
  return window.every((m) => m.held) ? 'not_activated' : 'undecided';
}

/** **The ten metrics for one run**, each with whether it is complete and the months it misses. */
export function quantValues(input: QuantInput): Record<QuantMetric, QuantValue> {
  const { months, members } = input;
  const own = periodMonths(input.periodEnd);
  const l12 = monthsEndingAt(input.periodEnd, QUANT.ROLLING_MONTHS);
  const both = monthsEndingAt(input.periodEnd, QUANT.GROWTH_MONTHS);
  const p12 = both.slice(0, QUANT.GROWTH_MONTHS - QUANT.ROLLING_MONTHS);
  const month = (m: string) => months.get(m);
  const missing = (read: readonly string[]) => read.filter((m) => month(m)?.complete !== true);
  const held = (read: readonly string[]) => read.filter((m) => month(m)?.held === true);

  const leaders = members.filter((p) => (LEADER_CLASSES as readonly string[]).includes(p.role) && memberAt(p.counted, input.endOfPeriod)).length;
  const active = (id: string, m: string): boolean | null => {
    const c = input.cell(id, m);
    return c ? monthlyActiveAgent(c.apeMinor, c.policies) : null;
  };
  /** `MAA_COUNT_IN_UNIT` over the office for a month: its members on its last day. */
  const maaCount = (m: string): number | null => {
    const at = month(m);
    if (!at) return null;
    const here = members.filter((p) => memberAt(p.counted, at.endExclusive));
    return maaCountInUnit(here.map((p) => active(p.membershipId, m)), at.held);
  };
  const perLeader = (figure: number | null): { value: number | null; reason: QuantNullReason } => {
    if (figure === null) return { value: null, reason: null };
    if (leaders === 0) return { value: null, reason: 'no_leader' };
    return { value: oneDecimal(figure / leaders), reason: null };
  };
  const result = (read: readonly string[], value: number | null, reason: QuantNullReason = null): QuantValue => {
    const gaps = missing(read);
    return { value, complete: gaps.length === 0, missingMonths: gaps, reason };
  };

  // A1 — recruitment over the period, per leader.
  const recruitment = own.map((m) => month(m)?.recruitment ?? null).filter((v): v is number => v !== null);
  const a1 = perLeader(recruitment.length === 0 ? null : recruitment.reduce((a, b) => a + b, 0));

  // A2 — agents active at least once in the last 12, less the 12 before; all 24 held, or *Belum cukup data*.
  const activeOver = (read: readonly string[]) => new Set(members
    .filter((p) => read.some((m) => active(p.membershipId, m) === true))
    .map((p) => p.membershipId)).size;
  const a2: QuantValue = held(both).length < both.length
    ? result(both, null, 'not_enough_data')
    : result(both, activeOver(l12) - activeOver(p12));

  // A3 — the period's annual active agents (`PRODUCING_AGENTS`), per leader.
  const heldOwn = held(own);
  const flags = members.map((p) => heldOwn
    .filter((m) => belongedDuring(p.counted, month(m)!.start, month(m)!.endExclusive))
    .map((m) => active(p.membershipId, m)));
  const a3 = perLeader(producingAgents(flags, heldOwn.length));

  // B1 and B2 — the period's new hires activated in their join month and the 3 (12) months after.
  const year = input.periodEnd.slice(0, 4);
  const lastDay = `${input.periodEnd}-31`;
  const hires = members.filter((p) => p.newHire && p.joinDate !== null && p.joinDate >= `${year}-01-01` && p.joinDate <= lastDay);
  const windowMonth = (id: string) => (m: string): WindowMonth => ({
    held: month(m)?.policiesHeld === true,
    policies: input.cell(id, m)?.policies ?? null,
  });
  const b1 = newAgentActivationShare(hires.map((p) => newAgentActivationOf(p.joinDate!, windowMonth(p.membershipId)))).pct;
  const b2 = newAgentActivationShare(hires.map((p) => activationWithin(p.joinDate!, QUANT.ACTIVATION_MONTHS_AFTER_JOIN, windowMonth(p.membershipId)))).pct;

  // B3 — of the members at the period's end who joined more than 12 months before it, the share active in the period.
  const tenured = members.filter((p) => {
    if (!memberAt(p.counted, input.endOfPeriod)) return false;
    const from = countedFrom(p.counted);
    return from === null || from.getTime() < input.tenuredBefore.getTime();
  });
  const b3 = heldOwn.length === 0 ? null
    : rateOver(tenured.filter((p) => heldOwn.some((m) => active(p.membershipId, m) === true)).length, tenured.length).pct;

  // C1 — `MAA_MONTHLY_AVG` over the period, per leader.
  const c1 = perLeader(maaMonthlyAvg(own.map(maaCount)));

  // C2 — cases per active agent per month (ADR-0203 §5).
  const c2raw = casesPerProducingAgent(own.map((m) => ({ policies: month(m)?.policies ?? null, activeAgents: maaCount(m) })));

  // C3 — among agents active at least once in the last 12 months, the mean of the months they were active.
  const counts = members.map((p) => l12.filter((m) => active(p.membershipId, m) === true).length).filter((n) => n > 0);
  const c3 = held(l12).length === 0 || counts.length === 0 ? null : oneDecimal(counts.reduce((a, b) => a + b, 0) / counts.length);

  // D1 — the realised case size over the period's months holding both.
  const d1raw = averageCaseSizeRealised(own.map((m) => ({ apeMinor: month(m)?.apeMinor ?? null, policies: month(m)?.policies ?? null })));

  return {
    QUANT_RECRUITS_PER_LEADER: result(own, a1.value, a1.reason),
    QUANT_ANNUAL_ACTIVE_NET_GROWTH: a2,
    QUANT_ACTIVE_PER_LEADER: result(own, a3.value, a3.reason),
    NEW_AGENT_ACTIVATION_3M_PCT: result(own, b1),
    QUANT_ACTIVATION_12M_PCT: result(own, b2),
    QUANT_TENURED_ACTIVE_PCT: result(own, b3),
    QUANT_AVG_MAA_PER_LEADER: result(own, c1.value, c1.reason),
    CASES_PER_PRODUCING_AGENT: result(own, typeof c2raw === 'number' ? oneDecimal(c2raw) : null),
    QUANT_AVG_ACTIVE_MONTHS: result(l12, c3),
    AVERAGE_CASE_SIZE_REALISED: result(own, typeof d1raw === 'number' ? d1raw : null),
  };
}

// ------------------------------------------------------------------------------------------------- the peers

/** `QUANT_PEER_MEDIAN`: the middle value, or the mean of the two middle values; `null` below `minPeers`. */
export function peerMedian(values: readonly number[], minPeers: number = QUANT.MIN_PEERS): number | null {
  if (values.length < minPeers) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median * 100) / 100;
}

export type PeerStatus = 'above' | 'in_line' | 'below';

/**
 * `QUANT_PEER_STATUS`: above or below when the value differs from the median by more than `bandPct` % of it — for A2
 * (`absolute`), by more than `band` agents. A median of 0 makes any positive value `above` and 0 `in_line`. `null` (no
 * chip) when the median is `null` or the KPM's own value is incomplete or `null`.
 */
export function peerStatus(
  own: { value: number | null; complete: boolean }, median: number | null, band: { kind: 'pct' | 'absolute'; size: number },
): PeerStatus | null {
  if (median === null || own.value === null || !own.complete) return null;
  const diff = own.value - median;
  if (band.kind === 'absolute') return diff > band.size ? 'above' : diff < -band.size ? 'below' : 'in_line';
  if (median === 0) return own.value > 0 ? 'above' : own.value < 0 ? 'below' : 'in_line';
  const pct = (diff / Math.abs(median)) * 100;
  return pct > band.size ? 'above' : pct < -band.size ? 'below' : 'in_line';
}
