/**
 * **The forum's figures over the months the office's file holds** (Phase 18.1, P18.1-T1 AC-3, AC-4; OD-144):
 * `NEW_ACTIVE_AGENTS_MONTHLY_AVG`, `MAA_MONTHLY_AVG`, `CASE_SUBMISSIONS` and `AVERAGE_CASE_SIZE_REALISED`
 * (`KPM_Owner.html:2467`, `:2470-2472`).
 *
 * Each takes **one figure per month of its period, `null` for a month whose file the office does not hold** — a
 * month's file lands after it ends (ADR-0050), and a month not held is not zero. A figure over part of its period
 * leaves the months not held out, and the caller names them; **no month held is `null`**, *pending data*, never 0.
 * Exact: no rounding here but money's to whole minor units. Pure.
 */

function held(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

function averageOverHeld(values: readonly (number | null)[]): number | null {
  const months = held(values);
  return months.length === 0 ? null : months.reduce((sum, v) => sum + v, 0) / months.length;
}

/**
 * `NEW_ACTIVE_AGENTS_MONTHLY_AVG` — *New AA (avg. monthly)* (D-cohort): the file's `NEW_ACTIVE_AGENTS` summed over
 * the office for each month held, ÷ the months held. A fraction where it falls between; the screen rounds.
 */
export function newActiveAgentsMonthlyAvg(perMonth: readonly (number | null)[]): number | null {
  return averageOverHeld(perMonth);
}

/**
 * `MAA_MONTHLY_AVG` — *Avg. Monthly AA*: `MAA_COUNT_IN_UNIT` over the office for each month held (`null` where the
 * month is not, as that metric answers), averaged.
 */
export function maaMonthlyAvg(counts: readonly (number | null)[]): number | null {
  return averageOverHeld(counts);
}

/** `CASE_SUBMISSIONS` — *Case submission*: the file's policy count (`policyCountMonthly`) summed over the months held. */
export function caseSubmissions(perMonth: readonly (number | null)[]): number | null {
  const months = held(perMonth);
  return months.length === 0 ? null : months.reduce((sum, v) => sum + v, 0);
}

/**
 * `AVERAGE_CASE_SIZE_REALISED` — *Average Case Size*: the office's APE ÷ its policies **over the same months**, the
 * months the file holds both for — the realised figure, not the plan's assumed case size (`caseSizeMinor`). In whole
 * minor units, as money is (invariant §9). **`'none'` over no policies** — *—*, a ratio over nothing whose months are
 * held — and `null` when no month holds both.
 */
export function averageCaseSizeRealised(
  months: readonly { apeMinor: number | null; policies: number | null }[],
): number | 'none' | null {
  const both = months.filter((m) => m.apeMinor !== null && m.policies !== null);
  if (both.length === 0) return null;
  const policies = both.reduce((sum, m) => sum + (m.policies as number), 0);
  if (policies === 0) return 'none';
  return Math.round(both.reduce((sum, m) => sum + (m.apeMinor as number), 0) / policies);
}
