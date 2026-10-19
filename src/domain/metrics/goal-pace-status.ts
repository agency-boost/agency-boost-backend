/**
 * `GOAL_PACE_STATUS` — the coaching triage of a member's month (`metrics-and-definitions.md` §A.4,
 * ADR-0080), the roster's *Status* (P11-T6 AC-4).
 *
 * ```
 * if (noTarget(m))                                          -> 'no_goal_set'     // ADR-0080
 * else if (!PACING_TO_MAA(m))                               -> 'needs_attention' // "full stop"
 * else if (APE_TARGET == 0)                                 -> 'on_track'        // OD-109: the year is met
 * else if (pace(m) >= PACE_ON_TRACK_RATIO)                  -> 'on_track'
 * else                                                       -> 'watch_closely'
 *
 * pace(m) = APE_ACHIEVED / APE_TARGET                                  once this month's file is in
 *         = CLOSINGS_LAST_30_DAYS / POLICY_COUNT_TARGET                until then (OD-110, ADR-0109)
 * ```
 *
 * **Evaluated on the calendar month** (ADR-0080): this month's APE produced against this month's target,
 * `MONTHLY_APE_TARGET`, which is fixed when the month starts (ADR-0056) — the Summary's *Monthly* card,
 * so the roster and the coachee's Summary never disagree about the same person.
 *
 * **No target is tested first.** No goal saved for the office's year, or an annual target of zero, is
 * *No goal set*: with no target both the MAA projection and the pace ratio divide by nothing, and neither
 * later branch can answer. A member whose year is already met **has** a goal and is not *No goal set*.
 *
 * **A year already met (OD-109, option 2, decided 2026-10-02).** This month's target is zero, because the
 * month needs nothing more (ADR-0047). The MAA gate still comes first — it asks for at least one policy,
 * which the caller projects against the cascade run on one case (`monthPaceOf`), never against zero
 * targets — and then **the pace reads met**: a member who made their year and is still working is
 * *On track*; one who has stopped fails the gate and is *Needs attention*, the prototype's *"full stop"*.
 *
 * **Before this month's file lands (OD-110, option 3, decided 2026-10-02)** there is no APE for the month:
 * a file lands after its month ends (ADR-0050). The last two branches then judge the pace on the activity,
 * as the Summary's pace sentence does: its *tracking to close N* over its *target of M* —
 * `CLOSINGS_LAST_30_DAYS` over `POLICY_COUNT_TARGET` — at `PACE_ON_TRACK_RATIO`. Once the file lands, APE
 * decides. *Amended 2026-10-07 (ADR-0109): it read `PROJECTED_CLOSINGS_THIS_MONTH`, a run-rate with no
 * answer before the 7th; the Summary's sentence changed, and the roster reads what the sentence says.*
 */

/** The four values, rendered *On track*, *Watch closely*, *Needs attention* and *No goal set*. */
export type GoalPaceStatus = 'on_track' | 'watch_closely' | 'needs_attention' | 'no_goal_set';

export const GOAL_PACE_STATUSES: readonly GoalPaceStatus[] = [
  'on_track', 'watch_closely', 'needs_attention', 'no_goal_set',
];

export interface GoalPaceInputs {
  /** `null` is *no target*: no goal for the office's year, or an annual target of zero (ADR-0080). */
  month: null | {
    /** `MONTHLY_APE_TARGET`, in minor units. Zero when the year was met before the month began. */
    targetMinor: number;
    /** This month's APE produced, in minor units; `null` until the month's file arrives. */
    apeMinor: number | null;
    /** `PACING_TO_MAA` for the month. */
    pacing: boolean;
    /**
     * The Summary's pace sentence (OD-110, ADR-0109), read only while `apeMinor` is `null`:
     * `CLOSINGS_LAST_30_DAYS` and `POLICY_COUNT_TARGET`.
     */
    closings: { last30Days: number; target: number } | null;
  };
  /** `PACE_ON_TRACK_RATIO`: the office's `onTrackPaceThreshold`, else `ON_TRACK_PACE_THRESHOLD`. */
  onTrackRatio: number;
}

export function goalPaceStatus({ month, onTrackRatio }: GoalPaceInputs): GoalPaceStatus {
  if (month === null) return 'no_goal_set';
  if (!month.pacing) return 'needs_attention';
  // OD-109: a zero target is a month that needs nothing more — met, never a pace of 0 over nothing.
  if (month.targetMinor <= 0) return 'on_track';
  return monthPace(month) >= onTrackRatio ? 'on_track' : 'watch_closely';
}

/**
 * The share of this month's target the member is at: APE once the month's file is in, the last 30 days'
 * closings over the closing target until then (OD-110, ADR-0109), and 0 when neither can answer.
 */
function monthPace(month: NonNullable<GoalPaceInputs['month']>): number {
  if (month.apeMinor !== null) return month.apeMinor / month.targetMinor;
  const closings = month.closings;
  if (closings && closings.target > 0) return closings.last30Days / closings.target;
  // Nothing to divide by: the prototype's pace of 0 (`Overall.html:7042`).
  return 0;
}
