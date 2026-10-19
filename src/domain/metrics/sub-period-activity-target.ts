import { SUB_PERIOD } from '@/domain/constants';

/**
 * `SUB_PERIOD_ACTIVITY_TARGET` — *the last 7 days' activity target, pro-rated*
 * (`metrics-and-definitions.md` §A.4), first served by `GET /activity/summary` for the coaching session's
 * Activity card (P11-T4 AC-4).
 *
 * ```
 * leads        = round(monthly.leads        × SUB_PERIOD_TARGET_SCALING)            // 7 ÷ 30.44
 * appointments = round(monthly.appointments × SUB_PERIOD_TARGET_SCALING)
 * closings     = max(SUB_PERIOD_CLOSING_TARGET_FLOOR, round(monthly.closings × SUB_PERIOD_TARGET_SCALING))
 *                when monthly.closings > 0, else 0
 * ```
 *
 * The prototype's `derive(p, '7')` (`Overall.html:7055-7061`), whose own comment concedes the
 * proportion: *"Last 7 days is a genuine sub-window of the month, so it's fine to derive
 * proportionally"*. Every screen labels the result *pro-rated* (§B.3).
 *
 * **The base is this month's `SUMMARY_ACTIVITY_TARGET`**: the cascade run on `MONTHLY_APE_TARGET`, fixed
 * when the month starts (ADR-0056), so the session's Activity card and the coachee's Summary tab never
 * disagree about the month. The caller computes it with the Summary's own function (`summaryPlan`).
 *
 * - **`null` in, `null` out**: no APE target to derive one from, as the Summary's targets are.
 * - **A month that needs nothing more** — a year met before it began (ADR-0047) — is all zeroes, and
 *   the floor does not apply: it asks a week for one closing only when the month asks for any.
 */

/** The cascade's three counts, as `cascadeCounts` names them. */
export interface CascadeTargets {
  leads: number;
  appointments: number;
  policies: number;
}

export function subPeriodActivityTarget(monthly: CascadeTargets | null): CascadeTargets | null {
  if (monthly === null) return null;
  const scaled = (n: number) => Math.round(n * SUB_PERIOD.TARGET_SCALING);
  return {
    leads: scaled(monthly.leads),
    appointments: scaled(monthly.appointments),
    policies: monthly.policies > 0
      ? Math.max(SUB_PERIOD.CLOSING_TARGET_FLOOR, scaled(monthly.policies))
      : 0,
  };
}
