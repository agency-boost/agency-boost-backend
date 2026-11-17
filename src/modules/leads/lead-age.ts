import type { LocalDate } from '@/common/time/local-day';

/**
 * **The client's age at the next birthday, moved up by the years since it was entered** (P19.7-T1 AC-1; ADR-0224 §2;
 * *since 2026-11-12, P19.14-T1 AC-5, ADR-0254 §4:* a proposal's client, never a lead's; `metrics-and-definitions.md`
 * §B.34, *The client's age*). The rule is written here once; every route answers what it reads, and the frontend never
 * computes it.
 *
 * - **Stored** as an age at the next birthday **on** a day — a proposal's `client.age` on `client.ageSetOn`, the KPM's
 *   day it was entered.
 * - **Read** as today's: `age + whole years from that day to today`, the days on the KPM's calendar (Asia/Jakarta,
 *   invariant §9) — so it moves up by one on each anniversary, at 00:00 WIB. A day on 29 February has its anniversary on
 *   1 March in a year that has none. The next proposal for the lead starts from it (`clientPrefillOf`).
 *
 * *Changed 2026-11-12 (P19.14-T1; ADR-0254, superseding ADR-0224):* a lead carries no age, so `ageWrite` and `isLeadAge`
 * — the lead's write rules — went with it. The file keeps its name and place: the rule is the one ADR-0224 wrote.
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
