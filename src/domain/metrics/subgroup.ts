import { TIME } from '@/domain/constants';
import { eventNps, type NpsReading } from './event-nps';
import { wholePercent } from './rate';

/**
 * **Sub-group improvements' figures, and the events' NPS for a period** (P19.5-T3 AC-3, AC-10; ADR-0215 §4, §7;
 * `metrics-and-definitions.md` §A.15). Pure: each takes what its caller read once.
 */

/** `SUBGROUP_HEAD_ACTIVE_DAYS` / `POWER_USER_COUNT`'s count: the days in the window a member saved an entry on. */
export function daysLogged(savedDays: ReadonlySet<string> | undefined, window: readonly string[]): number {
  if (!savedDays) return 0;
  return window.filter((d) => savedDays.has(d)).length;
}

/** `POWER_USER_COUNT`: the members who logged on at least `minDays` of the window. */
export function powerUserCount(
  memberIds: readonly string[], savedDays: ReadonlyMap<string, ReadonlySet<string>>, window: readonly string[], minDays: number,
): number {
  return memberIds.filter((id) => daysLogged(savedDays.get(id), window) >= minDays).length;
}

/**
 * `SUBGROUP_ONE_ON_ONES_PER_WEEK`: the sessions over the last 30 days ÷ `WEEKS_PER_MONTH_AVG` (4.33), to one decimal.
 * The data sources' *÷ 4.35* is the same idea; one weeks-per-month constant is kept (invariant §7).
 */
export function oneOnOnesPerWeek(sessions: number): number {
  return Math.round((sessions / TIME.WEEKS_PER_MONTH) * 10) / 10;
}

/** `SUBGROUP_WEEKLY_ACTIVITY_TARGET`: `subgroupWeekMultiplier × aaTarget`. */
export function weeklyActivityTarget(multiplier: number, aaTarget: number): number {
  return Math.round(multiplier * aaTarget * 10) / 10;
}

/**
 * `SUBGROUP_TARGET_ATTAINMENT_PCT`: `actual ÷ target × 100`, whole; `null` (*—*) with a target of 0 or no actual. Green
 * at `okPct` or more — a colour-only threshold.
 */
export function targetAttainment(actual: number | null, target: number, okPct: number): { pct: number | null; ok: boolean | null } {
  if (actual === null || target <= 0) return { pct: null, ok: null };
  const pct = wholePercent(actual, target);
  return { pct, ok: pct >= okPct };
}

/** `EVENT_NPS_FOR_PERIOD`: `EVENT_NPS` over the pooled counted answers, with their mean to one decimal and `n`. */
export function eventNpsForPeriod(scores: readonly number[]): NpsReading & { average: number | null } {
  const reading = eventNps(scores);
  return {
    ...reading,
    average: scores.length === 0 ? null : Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
  };
}
