import type { LocalDate } from '@/common/time/local-day';

/**
 * **Home's pure rules** (UI V1, UI-100, UI-101): what `HomeService` decides without a database, each pinned by
 * `home-figures.spec.ts` with its ticket in the test's name.
 */

/** A scope's count of how many of `of`: *Unit 1/4*, *AAB 3/8*. */
export interface CountOf {
  count: number;
  of: number;
}

/** A leader tile's figure and its *Unit* / *AAB* split, the two adding up to it (UI-003, UI-013, UI-100). */
export interface SplitFigure extends CountOf {
  unit: CountOf;
  aab: CountOf;
}

/** Two scopes' counts summed into the tile's figure. */
export function splitOf(unit: CountOf, aab: CountOf): SplitFigure {
  return { count: unit.count + aab.count, of: unit.of + aab.of, unit, aab };
}

/**
 * **Reported, as the pill draws it** (UI-101; `ActivityPill`): a count above zero is an orange pill, anything else —
 * no saved day, or a saved day of nothing (ADR-0042) — is *Belum lapor*. The sort follows what the row shows, so a row
 * never sorts as reported while it reads *Belum lapor*.
 */
export const reported = (count: number | null): boolean => count !== null && count > 0;

/** One person on *Laporan tim*: whether they reported yesterday and today, in the roster's order. */
export interface TeamDay {
  yesterday: number | null;
  today: number | null;
}

/**
 * **Laporan tim's order** (UI-101: *empty both days → empty today → the rest*): nobody who reported neither day first,
 * then those who have not reported today, then everybody else — each group in the order it came in, the roster's
 * (`UnitDashboardService.people`: the reader's unit, then each AAB unit, A to Z), so two reads never shuffle.
 */
export function byReport<T extends TeamDay>(rows: readonly T[]): T[] {
  const rank = (row: T) => (!reported(row.yesterday) && !reported(row.today) ? 0 : !reported(row.today) ? 1 : 2);
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.at - b.at)
    .map(({ row }) => row);
}

/** Each of a few office days with its count — 0 where nothing was saved — oldest first: the 7-day chart's bars. */
export function daysWithCounts(days: readonly LocalDate[], counts: ReadonlyMap<LocalDate, number> | undefined) {
  return days.map((date) => ({ date, count: counts?.get(date) ?? 0 }));
}
