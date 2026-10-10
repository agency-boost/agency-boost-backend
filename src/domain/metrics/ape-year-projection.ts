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
