import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import { addDays, daysBetween, isLocalDate, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { ACTIVITY, PERIOD } from '@/domain/constants';
import { ACTIVITY_REFUSALS } from './activity.messages';

const SAY = ACTIVITY_REFUSALS.VALIDATION_FAILED;

/**
 * The Activity Dashboard's range and its columns (P10-T1). Pure: no clock, no repository — the
 * service hands in the office's today, and every rule here is a test away.
 */

export const DASHBOARD_RANGES = ['ROLLING_7D', 'ROLLING_30D', 'CUSTOM'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

/**
 * One column of the table. **Most recent first**, as the prototype orders them.
 *
 * `day` is one date; `week` is a 7-day block; `remainder` is what is left at the old end of a range
 * that does not divide into sevens — the prototype's *Remaining 2 days*. The screen writes the labels;
 * the server says what each column is.
 */
export interface DashboardBucket {
  from: LocalDate;
  to: LocalDate;
  days: number;
  kind: 'day' | 'week' | 'remainder';
}

export interface ResolvedRange {
  range: DashboardRange;
  from: LocalDate;
  to: LocalDate;
  days: number;
}

function refuse(message: Sentence<'VALIDATION_FAILED'>, details: Record<string, unknown>): never {
  throw new DomainException(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
}

/**
 * The dates a range covers, ending **today in the office's timezone** for the two presets.
 *
 * A custom range is refused rather than trimmed when it cannot be shown — the prototype quietly kept
 * the latest 30 days of anything longer, so an agent asking about a quarter read a month and was not
 * told.
 */
export function dashboardRange(
  input: { range?: string; from?: string; to?: string },
  today: LocalDate,
): ResolvedRange {
  const range = (input.range ?? 'ROLLING_7D') as DashboardRange;
  if (!DASHBOARD_RANGES.includes(range)) {
    refuse(SAY.notARange({ range: input.range as string, ranges: DASHBOARD_RANGES }), { field: 'range' });
  }

  if (range !== 'CUSTOM') {
    // A preset with dates would be a request answered as a different one; `from` and `to` are the
    // custom range's, and saying so is cheaper than a reader wondering why their dates were ignored.
    if (input.from || input.to) {
      refuse(SAY.presetWithDates({ range }), { field: 'range' });
    }
    const length = range === 'ROLLING_7D' ? PERIOD.ROLLING_7D_DAYS : PERIOD.ROLLING_30D_DAYS;
    return { range, ...rollingWindow(today, length), days: length };
  }

  for (const field of ['from', 'to'] as const) {
    const value = input[field];
    if (!value) refuse(SAY.customNeedsBoth({ field }), { field });
    if (!isLocalDate(value)) refuse(SAY.notADay({ value }), { field });
  }
  const from = input.from as LocalDate;
  const to = input.to as LocalDate;
  if (from > to) refuse(SAY.rangeBackwards, { field: 'from', from, to });
  if (to > today) refuse(SAY.rangeAfterToday({ today }), { field: 'to', to, today });

  // Counted by arithmetic, **before** anything is built per day: a `from` in the year 0100 is a valid
  // date, and listing seven hundred thousand of them to learn the range is too long took a third of a
  // second on a single-threaded server — reachable by typing a year into a date field one digit at a time.
  const days = spanDays(from, to);
  if (days > ACTIVITY.DASHBOARD_RANGE_MAX_DAYS) {
    refuse(
      SAY.rangeTooLong({ days, max: ACTIVITY.DASHBOARD_RANGE_MAX_DAYS }),
      { field: 'from', days, max: ACTIVITY.DASHBOARD_RANGE_MAX_DAYS },
    );
  }
  return { range, from, to, days };
}

/** Days from `from` to `to` inclusive, from their numbers — nothing is built per day. */
function spanDays(from: LocalDate, to: LocalDate): number {
  const at = (day: LocalDate) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000) + 1;
}

/**
 * The columns, most recent first.
 *
 * - **Last 7 days**, and a custom range up to `DASHBOARD_DAILY_MAX_DAYS`: a column a day.
 * - **Last 30 days**, and a longer custom range: 7-day blocks counted back from the range's end —
 *   *Week 1* is the most recent seven days, not a calendar week — and a remainder for what is left.
 *   The prototype's own shape (`Overall.html:5031-5050`); a calendar week would split the range into a
 *   part-week at both ends.
 */
export function bucketsFor({ range, from, to, days }: ResolvedRange): DashboardBucket[] {
  const daily = range === 'ROLLING_7D' || (range === 'CUSTOM' && days <= ACTIVITY.DASHBOARD_DAILY_MAX_DAYS);
  if (daily) {
    return daysBetween(from, to).reverse().map((day) => ({ from: day, to: day, days: 1, kind: 'day' }));
  }

  const width = ACTIVITY.DASHBOARD_BLOCK_DAYS;
  const buckets: DashboardBucket[] = [];
  let end = to;
  for (let i = 0; i < Math.floor(days / width); i += 1) {
    buckets.push({ from: addDays(end, -(width - 1)), to: end, days: width, kind: 'week' });
    end = addDays(end, -width);
  }
  const left = days % width;
  if (left > 0) buckets.push({ from, to: end, days: left, kind: 'remainder' });
  return buckets;
}

/** Which column a day falls in, or -1 outside the range. Buckets are contiguous and most recent first. */
export function bucketIndex(buckets: readonly DashboardBucket[], day: LocalDate): number {
  return buckets.findIndex((b) => day >= b.from && day <= b.to);
}
