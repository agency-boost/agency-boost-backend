import { isLocalDate, type LocalDate } from '@/common/time/local-day';
import { PERSONAL_DATA } from '@/domain/constants';

/**
 * The rules on what a person records (ADR-0158 §2), as plain functions of the value and **today in the
 * office's calendar** — so the roster file, registration and `/profile` refuse the same things in the
 * same words, and a test can put today anywhere without a clock.
 *
 * Each answers `null` for a value that is fine, or the sentence the caller shows, naming what is wrong.
 * The caller supplies `today`, from the injected clock and the office's timezone (invariant §9): nothing
 * here reads one.
 */

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `YYYY-MM`, a real month. The shape `users.companyJoinMonth` is stored in. */
export function isYearMonth(value: unknown): value is string {
  return typeof value === 'string' && YEAR_MONTH.test(value);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The latest birth date of somebody who is `PERSONAL_DATA.MIN_AGE_YEARS` old on `today`.
 *
 * The same day and month that many years back — **29 February becomes the 28th** in a year that has no
 * 29th, so somebody born on 1 March is never taken a day early. Calendar arithmetic, in UTC because it
 * has no transitions; no instant crosses in or out.
 */
export function latestAdultBirthDate(today: LocalDate): LocalDate {
  const [y, m, d] = today.split('-').map(Number);
  const year = y - PERSONAL_DATA.MIN_AGE_YEARS;
  const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${pad(m)}-${pad(Math.min(d, daysInMonth))}`;
}

/** A birth date: a real day, in the past, and at least `MIN_AGE_YEARS` ago (ADR-0158 §2). */
export function birthDateProblem(value: string, today: LocalDate): string | null {
  if (!isLocalDate(value)) return `"${value}" is not a date of birth. Write it YYYY-MM-DD, like 1990-03-15.`;
  if (value >= today) return 'A date of birth must be in the past.';
  if (value > latestAdultBirthDate(today)) {
    return `A date of birth must be at least ${PERSONAL_DATA.MIN_AGE_YEARS} years ago.`;
  }
  return null;
}

/** The month somebody joined their insurer: a real month, and not one still to come (ADR-0158 §2). */
export function joinMonthProblem(value: string, today: LocalDate): string | null {
  if (!isYearMonth(value)) return `"${value}" is not a month. Write the company join month YYYY-MM, like 2021-07.`;
  if (value > today.slice(0, 7)) return 'The company join month cannot be in the future.';
  return null;
}
