import { rateOver, type Rate } from './rate';

/**
 * **A goal set**, and `GOAL_SET_RATE` (Phase 18.6, P18.6-T1 AC-5; OD-160 → option 1) — the PRD's *"Agents with a goal
 * set for the current period ≥80%"* (`prd.md` §8), and the Overview's *"{n} members have no goal set…"*.
 *
 * **A member has a goal set when they saved a goal for the office's current year whose annual APE target is above
 * zero.** The defaults a first-time reader is offered are no goal (`savedAt: null`), and a saved goal that targets
 * nothing — a zero target, or stored assumptions that make no plan — is no goal anybody can be measured against
 * (`summaryPlan`: *"`null` without a saved goal, or with a plan that targets nothing"*). That is the Overview's
 * predicate since Phase 18 — `goalFigures(…).yearly.targetMinor === null` — written once here, and the Overview's
 * `membersWithoutGoal` now reads it (invariant §8).
 *
 * `GOAL_SET_RATE` counts it over the members given — every member the reader lists, as ADR-0127 reads the PRD's
 * *Agents* — `null` over nobody. Pure: plans in, the share out. The caller reads the plans (`GoalService.plansOf`) for
 * the office's calendar year.
 */

/** A member's plan for the year, as far as *set* goes: `GoalService.plansOf`'s answer is one. */
export interface PlannedGoalForRate {
  /** `null` for the defaults a reader with no saved goal is offered: an offer, not a goal. */
  savedAt: string | null;
  /** The plan's resolved figures; `null` when the stored inputs cannot make one. */
  projected: { annualApeTargetMinor: number } | null;
}

/** **A goal set** (OD-160): saved, with an annual APE target above zero. No plan at all is none. */
export function goalSet(goal: PlannedGoalForRate | null | undefined): boolean {
  return goal !== null && goal !== undefined && goal.savedAt !== null && (goal.projected?.annualApeTargetMinor ?? 0) > 0;
}

/** `GOAL_SET_RATE`: of the members given, those with a goal set, over all of them. */
export function goalSetRate(members: readonly string[], plans: ReadonlyMap<string, PlannedGoalForRate>): Rate {
  return rateOver(members.filter((id) => goalSet(plans.get(id))).length, members.length);
}
