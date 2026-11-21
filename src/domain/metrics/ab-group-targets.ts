import { AB_GROUP_TARGETS } from '@/domain/constants';

/**
 * **Monthly targets per AB group** (P19.17-T4;
 * [ADR-0270](../../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md)
 * §4–§6; `DATA-DEFINITIONS.md`, *Targets*; `metrics-and-definitions.md` §A.19). Pure: the stored rows in, the month's
 * targets out. Pinned by `ab-group-targets.spec.ts`.
 *
 * - **`AB_GROUP_TARGET(ab, M)`** — *Target Active Agent per bulan* and *Target Rekrut per bulan* — is the row saved for
 *   the AB group and month M; **with none, the latest month before M that has one** (*berlaku sampai diubah*, OD-386);
 *   with none earlier either, **no target** (`null`, *Belum ada target*). Never a template default.
 * - **An informal group's and the KPM's targets are sums** of their AB groups' — an AB group with no target adds 0, and
 *   the total says how many had none (`unset`).
 * - **Rekrut YTD target** (*Informal group*'s *Rekrut YTD vs target*) is the sum of the AB group's Rekrut targets for
 *   January to M of M's year.
 * - **`APE_TARGET(ab, M)`** is the sum of the AB group's members' saved Goal Setting annual APE targets for M's year,
 *   **÷ 12**, rounded to whole sen (invariant §9). Not editable here.
 */

/** One stored row: an AB group's two targets for one month. */
export interface StoredAbGroupTarget {
  /** `YYYY-MM`. */
  month: string;
  activeAgentTarget: number;
  rekrutTarget: number;
}

/** Where a month's target comes from: saved for it, carried from an earlier month, or none. */
export type AbGroupTargetSource = 'set' | 'carried' | 'none';

export interface EffectiveAbGroupTarget {
  activeAgentTarget: number | null;
  rekrutTarget: number | null;
  source: AbGroupTargetSource;
  /** The month the row was saved for; `null` with none. */
  fromMonth: string | null;
}

export interface TargetSums {
  activeAgentTarget: number;
  rekrutTarget: number;
  /** AB groups counted with no target: the sum is over the others. */
  unset: number;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A `YYYY-MM` month. */
export function isMonth(value: string): boolean {
  return MONTH.test(value);
}

/** `month` moved by `by` months, `YYYY-MM`. */
export function addMonths(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * **The months a target may be written for**, given the office's month: from `AB_GROUP_TARGETS.EARLIEST_MONTH` to
 * `MONTHS_AHEAD` months after it.
 */
export function targetMonthOpen(month: string, officeMonth: string): boolean {
  return isMonth(month) && month >= AB_GROUP_TARGETS.EARLIEST_MONTH && month <= addMonths(officeMonth, AB_GROUP_TARGETS.MONTHS_AHEAD);
}

/** **`AB_GROUP_TARGET(ab, M)`** over one AB group's stored rows, in any order. */
export function effectiveTarget(rows: readonly StoredAbGroupTarget[], month: string): EffectiveAbGroupTarget {
  let best: StoredAbGroupTarget | null = null;
  for (const row of rows) {
    if (row.month <= month && (best === null || row.month > best.month)) best = row;
  }
  if (best === null) return { activeAgentTarget: null, rekrutTarget: null, source: 'none', fromMonth: null };
  return {
    activeAgentTarget: best.activeAgentTarget,
    rekrutTarget: best.rekrutTarget,
    source: best.month === month ? 'set' : 'carried',
    fromMonth: best.month,
  };
}

/** **An informal group's or the KPM's targets**: the sum of its AB groups', each with none adding 0. */
export function sumTargets(targets: readonly EffectiveAbGroupTarget[]): TargetSums {
  return targets.reduce<TargetSums>((sum, t) => ({
    activeAgentTarget: sum.activeAgentTarget + (t.activeAgentTarget ?? 0),
    rekrutTarget: sum.rekrutTarget + (t.rekrutTarget ?? 0),
    unset: sum.unset + (t.source === 'none' ? 1 : 0),
  }), { activeAgentTarget: 0, rekrutTarget: 0, unset: 0 });
}

/** **Rekrut YTD target**: one AB group's Rekrut targets for January to `month` of its year, each month's own. */
export function rekrutYtdTarget(rows: readonly StoredAbGroupTarget[], month: string): number {
  let sum = 0;
  for (let m = `${month.slice(0, 4)}-01`; m <= month; m = addMonths(m, 1)) sum += effectiveTarget(rows, m).rekrutTarget ?? 0;
  return sum;
}

/** **`APE_TARGET`**: the members' annual Goal Setting targets, in sen, summed and divided by 12, to the whole sen. */
export function monthlyApeTarget(annualTargetsMinor: readonly number[]): number {
  const year = annualTargetsMinor.reduce((sum, v) => sum + Math.max(0, v), 0);
  return Math.round(year / AB_GROUP_TARGETS.MONTHS_PER_YEAR);
}

/**
 * **A year's target spread over its twelve months, whole numbers that add up to it** (migration `0069`, OD-387): month
 * *i* takes `⌊total·i/12⌋ − ⌊total·(i−1)/12⌋`, so January to any month holds the year's share to that month, rounded
 * down, and December closes on the total. 6 a year reads 0, 1, 0, 1, …; 24 reads 2 every month.
 */
export function spreadOverYear(total: number): number[] {
  const n = AB_GROUP_TARGETS.MONTHS_PER_YEAR;
  const whole = Math.max(0, Math.floor(total));
  return Array.from({ length: n }, (_, i) => Math.floor((whole * (i + 1)) / n) - Math.floor((whole * i) / n));
}
