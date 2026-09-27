/**
 * `MONTHLY_ACTIVE_AGENT` — the one definition of *active* for a calendar month (ADR-0054, resolving
 * OD-21).
 *
 * A member is a Monthly Active Agent for a month when that month's production shows **APE above zero
 * or a policy written**. It reads the carrier's figures as the office holds them — imported, or
 * corrected by hand — and never the APE an agent types on their goal screen, which is a claim about
 * production and not production (P9-T6).
 *
 * **Three answers, and the third is the point.** `null` is *not reported*, which is not `false`: an
 * office that has not uploaded September must see a dash against every name, never a column of
 * *not active*.
 *
 * **Unknown only where it could change the answer.** The prototype asks whether *any* of the row's
 * twelve figures is held (`KPM_Owner.html:4807-4813`). That was sound while every upload wrote every
 * cell. ADR-0051 lets a file carry only some, and a file of persistency alone would then have marked
 * the whole office *not active* on a figure this metric does not read. So a positive figure settles
 * it, two zeroes settle it, and anything short of either is not known yet.
 */
export function monthlyActiveAgent(
  apeMonthlyMinor: number | null, policiesMonthly: number | null,
): boolean | null {
  if ((apeMonthlyMinor ?? 0) > 0 || (policiesMonthly ?? 0) > 0) return true;
  if (apeMonthlyMinor === null || policiesMonthly === null) return null;
  return false;
}
