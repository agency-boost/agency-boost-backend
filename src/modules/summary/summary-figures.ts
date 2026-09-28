import { PERFORMANCE, SUMMARY, TIME } from '@/domain/constants';

/**
 * The Personal Summary's arithmetic (P10-T4). Pure: figures in, figures out, so every rule is a unit
 * test and the exit criterion — **a zero denominator is not enough data, never 0 and never `NaN`** —
 * is asserted where it can fail.
 */

/** One period's goal against what was produced — the *Goal vs. actual* and *The gap* cards. */
export interface PeriodFigures {
  /** `null` when there is no goal to measure against. */
  targetMinor: number | null;
  /** `null` when nothing is held yet — this month before its file arrives. Not zero. */
  actualMinor: number | null;
  /** `APE_ATTAINMENT_PCT`: capped for display; `null` without a target, or without an actual. */
  attainmentPct: number | null;
  /** `APE_GAP_TO_TARGET`: never negative. */
  gapMinor: number | null;
  /** How far past the target, when it is passed; 0 otherwise. `null` like the gap. */
  overMinor: number | null;
  /** `POLICIES_NEEDED`: the gap over the case size, rounded up. */
  policiesNeeded: number | null;
  targetMet: boolean;
}

export function periodFigures(
  targetMinor: number | null, actualMinor: number | null, caseSizeMinor: number,
): PeriodFigures {
  const measurable = targetMinor !== null && targetMinor > 0 && actualMinor !== null;
  if (!measurable) {
    return {
      targetMinor: targetMinor !== null && targetMinor > 0 ? targetMinor : null,
      actualMinor, attainmentPct: null, gapMinor: null, overMinor: null, policiesNeeded: null, targetMet: false,
    };
  }
  const gap = Math.max(0, targetMinor - actualMinor);
  return {
    targetMinor,
    actualMinor,
    attainmentPct: Math.min(PERFORMANCE.ATTAINMENT_PCT_CAP, Math.round((actualMinor / targetMinor) * 100)),
    gapMinor: gap,
    overMinor: Math.max(0, actualMinor - targetMinor),
    policiesNeeded: caseSizeMinor > 0 ? Math.ceil(gap / caseSizeMinor) : null,
    targetMet: gap === 0,
  };
}

/**
 * A period whose target is **already made** — this month, once the year's target was reached before it
 * began (ADR-0047). Not *no target*: the month needs nothing more, and says so, rather than going blank
 * beside a pace line saying *reached*.
 */
export function madeFigures(actualMinor: number | null): PeriodFigures {
  return {
    targetMinor: 0, actualMinor, attainmentPct: null, gapMinor: 0, overMinor: actualMinor, policiesNeeded: 0,
    targetMet: true,
  };
}

/**
 * The year to date **before this month** — what this month's target is taken from (ADR-0056).
 *
 * In order: the office's year to date through last month; else the office's year to date this month
 * less this month's own APE, when this month's file is the first; else the agent's own figure, when
 * nothing is uploaded at all (P9-T6). **Never zero because nothing is held**: after January, *nothing
 * uploaded through last month* is not *nothing produced*, and counting it as zero set a target the year
 * had long outgrown.
 */
export function ytdBeforeThisMonth(input: {
  month: number;
  throughLastMonthMinor: number | null;
  thisMonth: { ytdMinor: number; monthlyMinor: number } | null;
  ownFigureMinor: number | null;
}): number {
  if (input.month === 1) return 0;
  if (input.throughLastMonthMinor !== null) return input.throughLastMonthMinor;
  if (input.thisMonth) return Math.max(0, input.thisMonth.ytdMinor - input.thisMonth.monthlyMinor);
  return input.ownFigureMinor ?? 0;
}

/**
 * `MONTHLY_APE_TARGET` (ADR-0056): what is left of the year's target after last month, over the months
 * left including this one — `12 − m + 1` for calendar month `m`.
 *
 * **It never moves with this month's own figure.** The cascade's monthly figure divides what is left
 * *now*, so uploading September's APE shrinks September's target and flatters attainment against it.
 * This one is taken from the year to date through **last** month: it moves once, when last month's file
 * arrives or is corrected, and never because of this month.
 */
export function monthlyApeTarget(annualTargetMinor: number, ytdThroughLastMonthMinor: number, month: number): number {
  const monthsLeft = TIME.MONTHS_PER_YEAR - month + 1;
  return Math.round(Math.max(0, annualTargetMinor - ytdThroughLastMonthMinor) / monthsLeft);
}

/** The pace sentence's figures (ADR-0057). */
export interface Pace {
  /** The month's closing target, from the plan. */
  closingTarget: number;
  closingsLogged: number;
  dayOfMonth: number;
  daysInMonth: number;
  /** `PROJECTED_CLOSINGS_THIS_MONTH`: `null` before `SUMMARY.PACE_MIN_DAYS` — too early to project. */
  projected: number | null;
  /** The days left **today included**, over 7, rounded up — never zero, the month's last day included. */
  weeksLeft: number;
  /** `CLOSINGS_NEEDED_PER_WEEK`: what is left of the closing target over the weeks left; 0 once it is. */
  neededPerWeek: number;
  /**
   * **The APE target is reached** — this month's or the year's (ADR-0047) — the prototype's own test
   * (`policiesNeeded <= 0`, `Overall.html:6330`). Not the closings count: closings are logged by the agent
   * and APE is reported by the carrier, and a line saying *"You've already reached this month's target"*
   * under a card at 89% of it was the first walk of this screen.
   */
  targetMet: boolean;
}

export function paceFor(input: {
  closingTarget: number; closingsLogged: number; dayOfMonth: number; daysInMonth: number; apeTargetMet: boolean;
}): Pace {
  const { closingTarget, closingsLogged, dayOfMonth, daysInMonth } = input;
  const weeksLeft = Math.ceil((daysInMonth - dayOfMonth + 1) / 7);
  const targetMet = input.apeTargetMet;
  return {
    closingTarget,
    closingsLogged,
    dayOfMonth,
    daysInMonth,
    projected: dayOfMonth < SUMMARY.PACE_MIN_DAYS ? null : Math.round((closingsLogged / dayOfMonth) * daysInMonth),
    weeksLeft,
    neededPerWeek: targetMet ? 0 : Math.ceil(Math.max(0, closingTarget - closingsLogged) / weeksLeft),
    targetMet,
  };
}
