/**
 * `MAA_COUNT_IN_UNIT` and `MONTHLY2_AA` (`metrics-and-definitions.md` §A.2, §A.7; Phase 18, D-period, OD-22; the
 * average since P19.3-T1).
 *
 * Both count `MONTHLY_ACTIVE_AGENT` (`monthly-active-agent.ts`, ADR-0054) over a group's members: neither has a
 * definition of *active* of its own (invariant §8). Pure; the flags are the month table's cells read through
 * `monthlyActiveAgent`.
 */

/**
 * `MAA_COUNT_IN_UNIT` — *Active this month* / *Active last month* (`KPM_Owner.html:1248`, `:3367`): the members
 * who are Monthly Active Agents for the month. **`null` when the office holds no file for the month** — *Not
 * uploaded yet*, never 0. A member whose own figures are not reported (`null`) is counted in the denominator
 * the screen draws beside it and not here.
 */
export function maaCountInUnit(flags: readonly (boolean | null)[], monthHeld: boolean): number | null {
  if (!monthHeld) return null;
  return flags.filter((flag) => flag === true).length;
}

/**
 * `MONTHLY2_AA` — and, over the Direct Unit and the Direct Group, `MONTHLY2_AA_DU` and `MONTHLY2_AA_DG` (§A.7; P19.3-T1,
 * ADR-0201 §4, the data sources' Q6 default, *"Average monthly AA (D1)"*): **the mean, over the calendar year's months
 * held up to the latest — the APE criterion's months — of the scope's members who were a Monthly Active Agent that
 * month.** Each member's `MONTHLY_ACTIVE_AGENT` per month, in the months' order; the caller passes `false` for a month
 * the member was not yet a member, so a new agent counts only from their month. A member the held month's file says
 * nothing of (`null`) is not active in it — `MAA_COUNT_IN_UNIT`'s reading. **Exact**: compared with the company's
 * threshold as it is, never rounded first. **`null` only when no month is held.**
 *
 * *Until P19.3-T1* it counted the members active in **each** of the last two months held (ADR-0134 §1), `null` with
 * fewer than two.
 */
export function monthly2AverageCount(members: readonly (readonly (boolean | null)[])[], monthsHeld: number): number | null {
  if (monthsHeld <= 0) return null;
  let total = 0;
  for (let month = 0; month < monthsHeld; month += 1) {
    total += members.filter((flags) => flags[month] === true).length;
  }
  return total / monthsHeld;
}
