/**
 * **The forum's figures over the months the office's file holds** (Phase 18.1, P18.1-T1 AC-3, AC-4; OD-144):
 * `MAA_MONTHLY_AVG`, `CASE_SUBMISSIONS` and `AVERAGE_CASE_SIZE_REALISED` (`KPM_Owner.html:2470-2472`), and since
 * P19.3-T1 `RECRUITMENT_MONTHLY_AVG` (ADR-0203 §2).
 * `NEW_ACTIVE_AGENTS_MONTHLY_AVG` (*New AA (avg. monthly)*, `:2467`) was here: retired by ADR-0175 §2 (P18.9-T1 AC-6) —
 * not on the client's reference slide — as `NEW_AGENT_3M_ACTIVE_PCT` was. Nothing computes it any more; the scorecards
 * frozen with it keep its figures (ADR-0129 §7), and the file's `NEW_ACTIVE_AGENTS` stays.
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
 * `MAA_MONTHLY_AVG` — *Avg. Monthly AA*: `MAA_COUNT_IN_UNIT` over the office for each month held (`null` where the
 * month is not, as that metric answers), averaged.
 */
export function maaMonthlyAvg(counts: readonly (number | null)[]): number | null {
  return averageOverHeld(counts);
}

/**
 * `RECRUITMENT_MONTHLY_AVG` — the forum's *FLC (avg. monthly)* (P19.3-T1; ADR-0203 §2, the data sources' D2): the
 * office's recruitment as its upload reports it, `RECRUITMENT` summed over the office's rows for each month held (a
 * leaver's row included, ADR-0136 §1; `OfficeMonth.recruitmentMonthly`), averaged over those months. A single month's
 * column is that month's sum. `null` with no month held — *pending data*, never 0. Not `NEW_ACTIVE_AGENTS` (the
 * recruits who became productive) and not a lead marked *Berhasil*.
 */
export function recruitmentMonthlyAvg(perMonth: readonly (number | null)[]): number | null {
  return averageOverHeld(perMonth);
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
