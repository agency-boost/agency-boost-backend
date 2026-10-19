import { PERFORMANCE } from '@/domain/constants';

/**
 * `PACING_TO_MAA` — *pacing to Monthly Active Agent* (`metrics-and-definitions.md` §A.2, as
 * `functional/coaching.md` corrects its *Reads*), computed for the first time by the coaching roster
 * (P11-T6 AC-4).
 *
 * ```
 * projectedSubmissions    = monthlyTarget(SELL_SUBMISSION) × activityAttainmentRatio
 * activityAttainmentRatio = totalLoggedThisMonth ÷ totalTargetThisMonth
 * pacingToMaa             = projectedSubmissions >= MAA_PROJECTED_SUBMISSIONS_MIN   // 1
 * ```
 *
 * As our records hold the inputs: the month's targets are `SUMMARY_ACTIVITY_TARGET` — the cascade run on
 * this month's fixed APE target (ADR-0056) — for the goal's three cascade codes, and the logged total is
 * the member's count on those same three codes this calendar month.
 *
 * **A forward-looking signal, never production** (ADR-0054): an agent can be pacing to MAA and end the
 * month with no APE at all, and the conflict-regression fixture pins exactly that. Never labelled
 * *active* without *pacing* or *potential* beside it.
 *
 * **A year already met never reaches here with zero targets (OD-109, option 2, decided 2026-10-02).**
 * This month's APE target is zero then (ADR-0047), and projecting against zero targets would read every
 * such member as not pacing, whatever they logged. The caller (`monthPaceOf`) projects instead against
 * what one policy takes at the goal's own rates — the cascade run on `MAA_PROJECTED_SUBMISSIONS_MIN`
 * cases — so the gate goes on asking exactly *at least one policy*. Targets summing to zero still
 * project 0 rather than `NaN`, so a division by nothing never reaches a comparison.
 */

/** This month's three cascade targets, and the member's count on the same three codes. */
export interface PacingInputs {
  targets: { leads: number; appointments: number; closings: number };
  /** The member's count this calendar month on the goal's three cascade codes, together. */
  logged: number;
}

/** `projectedSubmissions`: the closings this month's activity is on course for. */
export function projectedSubmissions({ targets, logged }: PacingInputs): number {
  const total = targets.leads + targets.appointments + targets.closings;
  return total > 0 ? (targets.closings * logged) / total : 0;
}

/** `PACING_TO_MAA`: on course for at least one policy submission this month. */
export function pacingToMaa(input: PacingInputs): boolean {
  return projectedSubmissions(input) >= PERFORMANCE.MAA_PROJECTED_SUBMISSIONS_MIN;
}
