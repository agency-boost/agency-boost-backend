import { PERIOD } from '@/domain/constants';

/**
 * `DAYS_SINCE_LAST_COACHING`, `COACHED_7D` and `COACHED_30D` (`metrics-and-definitions.md` §A.3,
 * P11-T5 AC-8), and the roster's *overdue* (P11-T6 AC-3).
 *
 * **One input: the whole days from the latest 1:1 to today**, which the caller counts in the office's
 * calendar with `Clock.daysBetween` (invariant §9) from the newest `date` among the coachee's sessions
 * finalized at least once. A session's `date` is the office's day of its **first** finalize and nothing
 * moves it (ADR-0079), so a reopened session keeps counting from it while it is corrected, and fixing
 * Tuesday's session on Friday does not make Friday a 1:1. A draft has no `date` and never counts; a
 * self-logged `DEV_COACHING_RECEIVED` is activity, not a session, and never reaches here at all.
 *
 * Pure, so every boundary is a unit test; the reads that feed it are `CoachingReadings`.
 */

/**
 * `DAYS_SINCE_LAST_COACHING`: whole days from the latest 1:1 to today, or `null` — *No 1:1 yet* — when
 * the member has none. `daysBetween` is the office's calendar arithmetic.
 */
export function daysSinceLastCoaching(
  lastDate: string | null,
  today: string,
  daysBetween: (from: string, to: string) => number,
): number | null {
  return lastDate === null ? null : daysBetween(lastDate, today);
}

/**
 * `COACHED_7D` / `COACHED_30D`: `DAYS_SINCE_LAST_COACHING != null && DAYS_SINCE_LAST_COACHING <= n`.
 *
 * **The formula is the definition**: `<= 7` spans eight calendar dates, today and the seven before it,
 * which makes *coached in the last 7 days* exactly the complement of the roster's *overdue* (`> 7`) at the
 * default `COACHING_OVERDUE_DAYS` (§A.3's dated note).
 */
export function coachedWithin(daysSince: number | null, windowDays: number): boolean {
  return daysSince !== null && daysSince <= windowDays;
}

/** `COACHED_7D`, over `ROLLING_7D`'s length. */
export function coached7d(daysSince: number | null): boolean {
  return coachedWithin(daysSince, PERIOD.ROLLING_7D_DAYS);
}

/** `COACHED_30D`, over `ROLLING_30D`'s length: the safety net. */
export function coached30d(daysSince: number | null): boolean {
  return coachedWithin(daysSince, PERIOD.ROLLING_30D_DAYS);
}

/**
 * The roster's *overdue*: a 1:1 older than the office's `coachingOverdueDays` (`Overall.html:10622`,
 * `> 7` at the default). A member with no 1:1 is not *overdue* here: the screen draws *No 1:1 yet* in red
 * from the `null` itself, and an overdue flag on nothing would be a date that does not exist.
 */
export function oneOnOneOverdue(daysSince: number, overdueAfterDays: number): boolean {
  return daysSince > overdueAfterDays;
}
