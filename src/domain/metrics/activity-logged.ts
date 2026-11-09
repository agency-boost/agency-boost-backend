import { addDays, endOfMonth, type LocalDate } from '@/common/time/local-day';
import { rateOver, type Rate } from './rate';

/**
 * The Overview's logging figures (Phase 18; OD-142 → option 2, D-figures): `ACTIVITY_COMPLIANCE_RATE` over the office —
 * *Pengguna aktif* on every screen since P19.3-T1 (ADR-0200 §3), never *active*. `ACTIVITY_LOGGED_THIS_MONTH`, the
 * first card's count, is retired: that tile counts production (`MAA_COUNT_IN_UNIT`, *Aktif bulan ini*).
 *
 * **Both read one fact per member**: the latest day they saved, on or before a day — `ACTIVITY_COMPLIANCE_7D`'s
 * and `ACTIVITY_COMPLIANCE_MONTH`'s own question, *did this person report* (ADR-0042: an all-zero day counts,
 * silence does not). A member logged inside a window when their latest day on or before its end falls inside
 * it. Pure; the reading is `ActivityReadings.lastLoggedOnMany`.
 */

/** Logged at least once from `window.from` to `window.to`, given the latest day logged on or before `window.to`. */
export function loggedWithin(latestOnOrBefore: LocalDate | null | undefined, window: { from: LocalDate; to: LocalDate }): boolean {
  return latestOnOrBefore !== null && latestOnOrBefore !== undefined
    && latestOnOrBefore >= window.from && latestOnOrBefore <= window.to;
}

/**
 * **`ACTIVITY_COMPLIANCE_RATE` as a count**: of the members given, how many logged at least once in the window, over all
 * of them, with the share. *Pengguna aktif* over that window. (Until P19.3-T1 this was `ACTIVITY_LOGGED_THIS_MONTH`'s
 * function, the same count over the calendar month; that name is retired, ADR-0200 §3.)
 */
export function loggedCount(
  members: readonly string[],
  latest: ReadonlyMap<string, LocalDate>,
  window: { from: LocalDate; to: LocalDate },
): Rate {
  return rateOver(members.filter((id) => loggedWithin(latest.get(id), window)).length, members.length);
}

/**
 * `ACTIVITY_COMPLIANCE_RATE` over a window (the *Activity logging — this week* card, `KPM_Owner.html:980-985`):
 * the members who logged, those who did not, and the share who did. *Logged* is `ACTIVITY_COMPLIANCE_7D` over
 * `ROLLING_7D` — the card's *"in the last 7 days"*.
 */
export function activityComplianceRate(
  members: readonly string[],
  latest: ReadonlyMap<string, LocalDate>,
  window: { from: LocalDate; to: LocalDate },
): { logged: number; notLogged: number; pct: number | null } {
  const { count, of, pct } = loggedCount(members, latest, window);
  return { logged: count, notLogged: of - count, pct };
}

/**
 * **Last month to the same day** (D-figures): the trend under the card compares this month so far with the
 * same stretch of last month — from its first day to the same day of the month, or its last day when last
 * month is shorter — never a whole month against part of one (`KPM_Owner.html:977`, contradiction 3).
 */
export function lastMonthToSameDay(today: LocalDate): { from: LocalDate; to: LocalDate } {
  const lastMonthEnd = addDays(`${today.slice(0, 7)}-01`, -1);
  const from = `${lastMonthEnd.slice(0, 7)}-01`;
  const sameDay = `${lastMonthEnd.slice(0, 7)}-${today.slice(8, 10)}`;
  const last = endOfMonth(from);
  return { from, to: sameDay > last ? last : sameDay };
}
