import { isLocalDate, type LocalDate } from '@/common/time/local-day';
import { PERSONAL_DATA } from '@/domain/constants';
import type { Sentence } from '@/common/i18n/sentence';
import { USERS_REFUSALS } from './users.messages';

const SAY = USERS_REFUSALS.VALIDATION_FAILED;

/**
 * The rules on what a person records (ADR-0158 §2), as plain functions of the value and **today in the
 * office's calendar** — so the roster file, registration and `/profile` refuse the same things in the
 * same words, and a test can put today anywhere without a clock.
 *
 * Each answers `null` for a value that is fine, or the sentence the caller shows, naming what is wrong — in both
 * languages (P18.10-T5 AC-3), written for its reader by whoever answers with it.
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
export function birthDateProblem(value: string, today: LocalDate): Sentence<'VALIDATION_FAILED'> | null {
  if (!isLocalDate(value)) return SAY.birthDateNotADate({ value });
  if (value >= today) return SAY.birthDateNotPast;
  if (value > latestAdultBirthDate(today)) return SAY.birthDateTooRecent({ years: PERSONAL_DATA.MIN_AGE_YEARS });
  return null;
}

/** The month somebody joined their insurer: a real month, and not one still to come (ADR-0158 §2). */
export function joinMonthProblem(value: string, today: LocalDate): Sentence<'VALIDATION_FAILED'> | null {
  if (!isYearMonth(value)) return SAY.joinMonthNotAMonth({ value });
  if (value > today.slice(0, 7)) return SAY.joinMonthFuture;
  return null;
}
