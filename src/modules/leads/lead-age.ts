import { LEAD_AGE } from '@/domain/constants';
import type { LocalDate } from '@/common/time/local-day';

/**
 * **The client's age at the next birthday, as a lead carries it** (P19.7-T1 AC-1; ADR-0224 §2, §3;
 * `metrics-and-definitions.md` §B.34, *The client's age*). The rule is written here once; every route answers what it
 * reads, and the frontend never computes it.
 *
 * - **Stored** as `age`, the age at the next birthday **on** `ageRecordedOn`, the KPM's day it was written.
 * - **Read** as today's: `age + whole years from ageRecordedOn to today`, the days on the KPM's calendar
 *   (Asia/Jakarta, invariant §9) — so it moves up by one on each anniversary of `ageRecordedOn`, at 00:00 WIB.
 *   A day recorded on 29 February has its anniversary on 1 March in a year that has none.
 * - **Written** as today's: a write of the age the lead already reads today moves nothing, so saving the sheet with the
 *   age it shows leaves `ageRecordedOn` where it was.
 */

/** Whole years from one day to a later one, counted on anniversaries (`YYYY-MM-DD`, string order is day order). */
export function wholeYearsBetween(from: LocalDate | string, to: LocalDate | string): number {
  if (to <= from) return 0;
  const [fy, md] = [Number(from.slice(0, 4)), from.slice(5)];
  const [ty, td] = [Number(to.slice(0, 4)), to.slice(5)];
  return ty - fy - (td < md ? 1 : 0);
}

/** **Today's age**, from what is stored. `null` when the lead carries none. */
export function ageToday(age: number | null | undefined, recordedOn: string | null | undefined, today: string): number | null {
  if (age === null || age === undefined) return null;
  return recordedOn ? age + wholeYearsBetween(recordedOn, today) : age;
}

/** Whether an age is one a lead may be given (`LEAD_AGE`, 1 to 100). */
export function isLeadAge(age: number): boolean {
  return Number.isInteger(age) && age >= LEAD_AGE.MIN && age <= LEAD_AGE.MAX;
}

/**
 * **What a write of `age` sets** (ADR-0224 §3), or `null` when it sets nothing:
 *
 * - `null` clears both fields (and is nothing when there was none);
 * - the age the lead reads today moves nothing — not the age, not the day;
 * - any other age is stored with today as its day.
 */
export function ageWrite(
  stored: { age?: number | null; ageRecordedOn?: string | null },
  written: number | null,
  today: string,
): { age: number | null; ageRecordedOn: string | null } | null {
  const reading = ageToday(stored.age, stored.ageRecordedOn, today);
  if (written === null) return reading === null ? null : { age: null, ageRecordedOn: null };
  if (reading === written) return null;
  return { age: written, ageRecordedOn: today };
}
