import { TIME } from '@/domain/constants';

/**
 * `APE_YEAR_PROJECTION` (`metrics-and-definitions.md` §A.11; Phase 18, D-figures) — the Overview's
 * *"Projected: Rp {x}"* marker (`KPM_Owner.html:1087-1088`), a fixed pixel in the prototype (contradiction 9).
 *
 * **A run-rate over the months the year to date covers**: the year to date as of the latest month held ÷ that
 * month's number (1–12) × 12. The carrier's year-to-date figure is cumulative from January, so it already holds a
 * month whose own file is missing: with September held and August not, the year to date covers nine months, and
 * dividing by the eight files held would overstate the pace (data honesty). **`null` until a month of the year is
 * held.**
 */
export function apeYearProjection(ytdMinor: number | null, latestMonthHeld: number): number | null {
  if (ytdMinor === null || latestMonthHeld <= 0) return null;
  return Math.round((ytdMinor / latestMonthHeld) * TIME.MONTHS_PER_YEAR);
}

/**
 * **The month a projection runs from** (P19.3-T1; D8 with Q4, `metrics-and-definitions.md` §A.11 *Decided
 * 2026-11-05*): the latest month of the calendar year **held and already ended** — before the office's current month —
 * as its number (1–12), or `0` when there is none. **A month in progress never enters the projection**: the office may
 * upload the current month at any time (D8, *"per 3 Nov"*), and its year to date is part of a month — divided by the
 * whole month's number it understates the pace, divided by the fraction elapsed it multiplies a month's first days
 * (a 3 January upload by 124). The year to date the projection divides is the one through this month, not the
 * current month's.
 */
export function projectionMonth(heldMonths: readonly string[], currentMonth: string): { month: string | null; number: number } {
  const year = currentMonth.slice(0, 4);
  const ended = heldMonths.filter((m) => m.startsWith(year) && m < currentMonth).sort();
  const month = ended.length === 0 ? null : ended[ended.length - 1];
  return { month, number: month === null ? 0 : Number(month.slice(5, 7)) };
}
