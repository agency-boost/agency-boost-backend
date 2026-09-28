/**
 * Calendar days in a tenant's timezone.
 *
 * **The defect this exists to close.** The prototype produces every date key with
 * `d.toISOString().split('T')[0]` (`activity-management.md` §4). That is the day *in UTC*, so for a
 * Jakarta agent at UTC+7 any local time before 07:00 files against **yesterday** — an evening logged
 * at 06:30 lands on the wrong day, and every metric computed from it is wrong by one day for that
 * agent. Invariant §9 names this: a day boundary computed in the server's clock is a bug.
 *
 * Everything here takes the zone explicitly. Nothing reads the process timezone, and nothing calls
 * `new Date()` — instants arrive from the clock port so a test can put the server anywhere.
 */

/** `YYYY-MM-DD`. The shape every `localDate` is stored in. */
export type LocalDate = string;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar day an instant falls on, in `timezone`.
 *
 * `en-CA` because it formats as `YYYY-MM-DD` — the same shape we store, so there is no
 * re-assembly step to get wrong.
 */
export function localDayOf(instant: Date, timezone: string): LocalDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string' || !LOCAL_DATE.test(value)) return false;
  // `2026-02-31` matches the pattern and is not a day. Round-tripping catches it.
  const [y, m, d] = value.split('-').map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  return asUtc.getUTCFullYear() === y && asUtc.getUTCMonth() === m - 1 && asUtc.getUTCDate() === d;
}

/**
 * Calendar arithmetic, done in UTC on purpose.
 *
 * Adding a day to a *calendar date* has no timezone in it — `2026-03-31` plus one day is
 * `2026-04-01` everywhere. UTC is used because it is the one zone with no DST transition to trip
 * over; this is not a conversion, and no instant crosses in or out.
 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return moved.toISOString().slice(0, 10);
}

/** The last calendar day of the month `date` belongs to. */
export function endOfMonth(date: LocalDate): LocalDate {
  const [y, m] = date.split('-').map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * The last day on which `date` may still be edited without leaving a correction behind
 * (ADR-0042): the end of its own calendar month, plus the office's grace window.
 *
 * So in a seven-day window, 3 March is freely editable until 7 April — and so is 31 March. The
 * window belongs to the **month**, not to the day, because that is what an office's month-end
 * close actually is.
 */
export function editableUntil(date: LocalDate, graceDays: number): LocalDate {
  return addDays(endOfMonth(date), graceDays);
}

/** Is `date` still inside its correction window, as of `today`? Both are local days. */
export function isWithinCorrectionWindow(
  date: LocalDate, today: LocalDate, graceDays: number,
): boolean {
  // String comparison is date comparison: `YYYY-MM-DD` sorts lexicographically in calendar order,
  // which is the reason to store it in this shape rather than any other.
  return today <= editableUntil(date, graceDays);
}

/** A day that has not happened in the office's timezone cannot be reported. */
export function isFutureDay(date: LocalDate, today: LocalDate): boolean {
  return date > today;
}

/** Every calendar day from `from` to `to` inclusive. Used to size a compliance window. */
export function daysBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const days: LocalDate[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The window of `length` days ending on `today` inclusive — `ROLLING_7D` and its peers. */
export function rollingWindow(today: LocalDate, length: number): { from: LocalDate; to: LocalDate } {
  return { from: addDays(today, -(length - 1)), to: today };
}

/** The calendar month `date` belongs to, as its first and last day. */
export function calendarMonth(date: LocalDate): { from: LocalDate; to: LocalDate } {
  return { from: `${date.slice(0, 7)}-01`, to: endOfMonth(date) };
}
