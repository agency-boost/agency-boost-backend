import { PERFORMANCE, TIME } from '@/domain/constants';
import { cascadeCounts, type CascadeCounts } from '@/modules/goals/goal-cascade';

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

/** What the plan for this month reads of a member's goal: `GoalService.planOf`'s answer. */
export interface PlannedGoal {
  /** `null` for the defaults a first-time reader sees: an offer, not a goal. */
  savedAt: string | null;
  /** The cascade's resolved plan, or `null` when the goal's stored assumptions cannot make one. */
  projected: { annualApeTargetMinor: number } | null;
  /** The year to date the goal reads, and whose figure it is (P9-T6). */
  achieved: { minor: number; month: string | null; provenance: string };
  caseSizeMinor: number;
  leadsToApptPct: number;
  closingRatePct: number;
}

/** The Summary's targets for the month and the year, before anything is measured against them. */
export interface SummaryPlan {
  /** The year's APE target: `null` without a saved goal, or with a plan that targets nothing. */
  annualTargetMinor: number | null;
  /** `MONTHLY_APE_TARGET`: `null` without an annual target; 0 when the year was made before the month. */
  monthlyTargetMinor: number | null;
  /** `SUMMARY_ACTIVITY_TARGET` for the month: the cascade on `monthlyTargetMinor` at the goal's own rates. */
  monthlyCounts: CascadeCounts | null;
  /** `SUMMARY_ACTIVITY_TARGET` for the year: the cascade on the annual target, rounded once (ADR-0056). */
  yearlyCounts: CascadeCounts | null;
}

/**
 * **The month's and the year's targets, as the Personal Summary sets them** (ADR-0056, P10-T4, P10-T5) —
 * the one place they are computed, so every reader of *this month's activity targets* reads one number.
 * `GET /summary` reads it, and so does `GET /activity/summary`, whose 7-day targets are this month's
 * pro-rated (`SUB_PERIOD_ACTIVITY_TARGET`, P11-T4): the session's Activity card and the coachee's Summary
 * tab cannot disagree about the month.
 *
 * - **No target is no target**: an unsaved default, a saved goal of zero, or one whose stored assumptions
 *   cannot produce a plan measures nothing.
 * - **This month's target never moves with this month's own figure**: it is taken from the year to date
 *   before the month (`ytdBeforeThisMonth`, `monthlyApeTarget`).
 * - **The counts need a case size** to divide by; without one there is a target and no plan for it.
 */
export function summaryPlan(input: {
  goal: PlannedGoal;
  /** The office's calendar month, `YYYY-MM`. */
  month: string;
  /** The office's year to date through last month; `null` when nothing is held, and in January. */
  throughLastMonthMinor: number | null;
  /** This month's own APE; `null` until the month's file arrives. */
  thisMonthMinor: number | null;
}): SummaryPlan {
  const { goal, month } = input;
  const monthNumber = Number(month.slice(5, 7));
  const planned = goal.projected?.annualApeTargetMinor ?? 0;
  const annual = goal.savedAt !== null && planned > 0 ? planned : null;

  const before = ytdBeforeThisMonth({
    month: monthNumber,
    throughLastMonthMinor: input.throughLastMonthMinor,
    // This month's own year to date is what the goal already reads when it is the latest the office holds.
    thisMonth: input.thisMonthMinor !== null && goal.achieved.month === month
      ? { ytdMinor: goal.achieved.minor, monthlyMinor: input.thisMonthMinor } : null,
    ownFigureMinor: goal.achieved.provenance === 'self_reported' ? goal.achieved.minor : null,
  });
  const monthly = annual !== null ? monthlyApeTarget(annual, before, monthNumber) : null;
  const rates = goal.caseSizeMinor > 0 ? goal : null;
  return {
    annualTargetMinor: annual,
    monthlyTargetMinor: monthly,
    monthlyCounts: monthly !== null && rates ? cascadeCounts(monthly, rates) : null,
    yearlyCounts: annual !== null && rates ? cascadeCounts(annual, rates) : null,
  };
}

/**
 * The pace sentence's figures (ADR-0109, superseding ADR-0057) — the prototype's own arithmetic
 * (`Overall.html:6326-6347`): *"At your current pace, you're tracking to close **N** policies this month
 * against a target of **M**. With **W** weeks left, you'd need to close roughly **K** policies/week to
 * catch up."*
 */
export interface Pace {
  /** *M*: the month's closing target, from the plan — the closings chip's own target. */
  closingTarget: number;
  /**
   * *N*, `CLOSINGS_LAST_30_DAYS`: the goal's closing code logged over the last `SUMMARY.PACE_WINDOW_DAYS`,
   * today included, in the office's calendar — the prototype's `loggedClosing` (`:6316`). Early in a month
   * it counts last month's closings too; that is the prototype's reading, and every day has one.
   */
  closingsLast30Days: number;
  dayOfMonth: number;
  daysInMonth: number;
  /** *W*: the days left **today included**, over 7, rounded up — never zero, the month's last day included. */
  weeksLeft: number;
  /**
   * `POLICIES_NEEDED` for the month: what is left of this month's APE target over the case size, rounded
   * up (`:6328-6329`). Until this month's file lands nothing is counted as produced, so it is the whole
   * target's. 0 once the target is reached.
   */
  policiesNeeded: number;
  /** *K*, `CLOSINGS_NEEDED_PER_WEEK`: the policies still needed over the weeks left, rounded up (`:6331`). */
  neededPerWeek: number;
  /**
   * **The APE target is reached** — this month's or the year's (ADR-0047) — the prototype's own test
   * (`paceOnTrack = policiesNeeded <= 0`, `:6330`), and what turns the danger box green. Not the closings
   * count: closings are logged by the agent and APE is reported by the carrier.
   */
  targetMet: boolean;
}

export function paceFor(input: {
  closingTarget: number;
  closingsLast30Days: number;
  dayOfMonth: number;
  daysInMonth: number;
  /** `MONTHLY_APE_TARGET`. */
  apeTargetMinor: number;
  /** This month's APE produced; `null` until the month's file lands, which counts as nothing produced yet. */
  apeProducedMinor: number | null;
  caseSizeMinor: number;
  apeTargetMet: boolean;
}): Pace {
  const { closingTarget, closingsLast30Days, dayOfMonth, daysInMonth, caseSizeMinor } = input;
  const weeksLeft = Math.ceil((daysInMonth - dayOfMonth + 1) / 7);
  const targetMet = input.apeTargetMet;
  const remaining = Math.max(0, input.apeTargetMinor - (input.apeProducedMinor ?? 0));
  const policiesNeeded = targetMet || caseSizeMinor <= 0 ? 0 : Math.ceil(remaining / caseSizeMinor);
  return {
    closingTarget,
    closingsLast30Days,
    dayOfMonth,
    daysInMonth,
    weeksLeft,
    policiesNeeded,
    neededPerWeek: Math.ceil(policiesNeeded / weeksLeft),
    targetMet,
  };
}

/** Which of the cascade's three counts a chip is (`Overall.html:3146-3160`). */
export type ActivityTargetKey = 'leads' | 'appointments' | 'closings';

/** One of *Your sales activity targets* (P10-T5): a cascade code logged against the period's target. */
export interface ActivityTarget {
  key: ActivityTargetKey;
  /** The goal's own code for this count — `cascadeMapping`, never an item number (invariant §4). */
  code: string;
  logged: number;
  /**
   * `SUMMARY_ACTIVITY_TARGET`: `null` without an APE target to derive it from. **0 is a month that needs
   * nothing more** — the year was made before it began — which is met, not unmeasured.
   */
  target: number | null;
  /** `ACTIVITY_TARGET_ATTAINMENT_PCT`, capped; `null` on a zero or missing target — never `NaN%` (F-25). */
  attainmentPct: number | null;
  targetMet: boolean;
}

/**
 * The three chips, in the prototype's order: leads contacted, appointments, closings.
 *
 * `counts` is the cascade run on the period's APE target — this month's fixed one, or the year's — so
 * the closings chip and the pace sentence name one number. `null` is no target to run it on.
 */
export function activityTargets(
  counts: { leads: number; appointments: number; policies: number } | null,
  mapping: { leadsCode: string; appointmentsCode: string; closingsCode: string },
  logged: ReadonlyMap<string, number>,
): ActivityTarget[] {
  const chip = (key: ActivityTargetKey, code: string, target: number | null): ActivityTarget => {
    const n = logged.get(code) ?? 0;
    return {
      key,
      code,
      logged: n,
      target,
      attainmentPct: target !== null && target > 0
        ? Math.min(PERFORMANCE.ATTAINMENT_PCT_CAP, Math.round((n / target) * 100)) : null,
      targetMet: target !== null && n >= target,
    };
  };
  return [
    chip('leads', mapping.leadsCode, counts?.leads ?? null),
    chip('appointments', mapping.appointmentsCode, counts?.appointments ?? null),
    chip('closings', mapping.closingsCode, counts?.policies ?? null),
  ];
}

/** A section as the reader is shown it, with every type it has held — the office's order. */
export interface ShownSection {
  code: string;
  label: string;
  /**
   * The summary tile the section counts toward (ADR-0064), or none: a section with a tile of its own
   * carries neither field. Both or neither — the settings write refuses one alone.
   */
  summaryGroupCode?: string | null;
  summaryGroupLabel?: string | null;
  types: { code: string; label: string; status: 'active' | 'archived' }[];
}

export interface SectionChip {
  /** The tile's group code, or the section's own code when it has a tile of its own. */
  code: string;
  /** The group's label, or the section's own — the screen adds *activities*. */
  label: string;
  /** `ACTIVITY_TOTAL_BY_CATEGORY` over the period, summed over the tile's sections — the rows add up to it. */
  total: number;
  rows: { code: string; label: string; count: number }[];
}

/**
 * **One chip per summary tile the reader is shown** (ADR-0064, P10.1-T6 AC-5), less the tiles holding
 * any of the cascade's three codes, which the target chips already count. On the seed that is the
 * prototype's two, *Recruitment activities* and *Development activities* (`Overall.html:3164-3183`):
 * Personal and Team Development share the tile `DEVELOPMENT`.
 *
 * - **A tile is the sections sharing a `summaryGroupCode`**, labelled by the group; a section with
 *   neither field is a tile of its own, under its own label, so a section an office adds is always
 *   counted somewhere. The grouping is presentation: it moves a count between chips and never
 *   changes one.
 * - **A tile sits where its first section sits** — `sections` arrive in the office's order.
 * - **A tile is excluded whole** when any of its sections holds a cascade code, as a section was
 *   before there were tiles.
 *
 * A type the office archived stays as a row while the period holds a count against it, so the chip's rows
 * add up to its total; one with nothing in the period is gone, as it is from the log screen.
 */
export function sectionChips(
  sections: readonly ShownSection[], counts: ReadonlyMap<string, number>, cascadeCodes: readonly string[],
): SectionChip[] {
  // A `Map` keeps insertion order: each tile's first section. Keys are prefixed because a section's own
  // code may equal another section's group code, and the two are different tiles.
  const tiles = new Map<string, { code: string; label: string; sections: ShownSection[] }>();
  for (const section of sections) {
    const group = section.summaryGroupCode?.trim() || null;
    const key = group ? `group:${group}` : `own:${section.code}`;
    const tile = tiles.get(key);
    if (tile) tile.sections.push(section);
    else {
      tiles.set(key, {
        code: group ?? section.code,
        label: (group && section.summaryGroupLabel?.trim()) || section.label,
        sections: [section],
      });
    }
  }
  return [...tiles.values()]
    .filter((tile) => !tile.sections.some((section) => section.types.some((type) => cascadeCodes.includes(type.code))))
    .map((tile) => {
      const rows = tile.sections
        .flatMap((section) => section.types)
        .filter((type) => type.status === 'active' || (counts.get(type.code) ?? 0) > 0)
        .map((type) => ({ code: type.code, label: type.label, count: counts.get(type.code) ?? 0 }));
      return { code: tile.code, label: tile.label, total: rows.reduce((n, row) => n + row.count, 0), rows };
    });
}

/** *N total activities logged … across all categories* — every code, archived and unshown included. */
export function totalLogged(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}
