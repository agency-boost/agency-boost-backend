/**
 * `MAA_COUNT_IN_UNIT` and `MONTHLY2_AA` (`metrics-and-definitions.md` §A.2, §A.7; Phase 18, D-period, OD-22).
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
 * `MONTHLY2_AA` (OD-22 → option 1, as registered: *"the scope's members who were Monthly Active Agents in **each**
 * of the last two months the office's file holds"*) — and, over the Direct Unit and the Direct Group,
 * `MONTHLY2_AA_DU` and `MONTHLY2_AA_DG`. Each member's `MONTHLY_ACTIVE_AGENT` for the two months, `== true` in
 * both: **only active in both counts.** The caller passes `false` for a month the member was not yet a member, so
 * a new agent cannot count; a member the held month's file says nothing of is not active in it — the same reading
 * `MAA_COUNT_IN_UNIT` gives a month (the exit review, item 2). **`null` only while fewer than two months are
 * held** — the one *Not uploaded yet*.
 */
export function monthly2ActiveCount(
  members: readonly (readonly (boolean | null)[])[], monthsHeld: number, monthsNeeded: number,
): number | null {
  if (monthsHeld < monthsNeeded) return null;
  return members.filter((flags) => flags.every((flag) => flag === true)).length;
}
