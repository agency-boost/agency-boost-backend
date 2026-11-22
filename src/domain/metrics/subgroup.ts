import { INFORMAL_GROUP, PROGRESS_TONE } from '@/domain/constants/advanced-analytics';
import { eventNps, type NpsReading } from './event-nps';
import { wholePercent } from './rate';

/**
 * ***Informal group*'s drivers, and the events' NPS for a period** (P19.5-T3 AC-3; P19.22-T5 AC-2 to AC-4; ADR-0215 §4,
 * ADR-0275 §5; `metrics-and-definitions.md` §A.15). Pure: each takes what its caller read once.
 *
 * *Changed 2026-11-20 (P19.22-T5; ADR-0275 §5):* *Perbaikan sub-group* became *Informal group* — four drivers per AB
 * group, informal group and KPM, each coloured by its progress. Its power-user count, weekly activity target and
 * attainment against the template's `subgroupOkPct` are gone with the old table.
 */

/** A driver's colour: green, yellow or red by its progress; `null` (no colour) without a figure. */
export type ProgressTone = 'green' | 'yellow' | 'red';

/**
 * **`SUBGROUP_TARGET_ATTAINMENT_PCT` — a figure against its target, whole %** — `null` (*—*) with no figure, or no target
 * above 0. *MAPA driver*'s *Bulan ini vs target* and *Informal group*'s Monthly Active Agent, 1-on-1 and Rekrut read it.
 */
export function progressPct(actual: number | null, target: number | null): number | null {
  if (actual === null || target === null || target <= 0) return null;
  // `wholePercent`'s rounding, half up — over a figure that may be fractional (*8,5 / 16* one-on-ones a week).
  return Number.isInteger(actual) ? wholePercent(actual, target) : Math.floor((200 * actual + target) / (2 * target));
}

/** **The progress colour** (`PROGRESS_TONE`): green from 100 %, yellow from 67 %, red below; `null` without a figure. */
export function progressTone(pct: number | null): ProgressTone | null {
  if (pct === null) return null;
  if (pct >= PROGRESS_TONE.GREEN_PCT) return 'green';
  return pct >= PROGRESS_TONE.YELLOW_PCT ? 'yellow' : 'red';
}

/**
 * **`SUBGROUP_ONE_ON_ONES_PER_WEEK` — *1-on-1 per minggu*, actual**: the 1-on-1 sessions of the last 30 days ÷
 * `INFORMAL_GROUP.WEEKS_IN_WINDOW` (4,35), to one decimal (`DATA-DEFINITIONS.md`, *Coaching*). *Changed 2026-11-20:* it
 * divided by `TIME.WEEKS_PER_MONTH` (4.33); the client's figure is 4,35.
 */
export function oneOnOnesPerWeek(sessions: number): number {
  return Math.round((sessions / INFORMAL_GROUP.WEEKS_IN_WINDOW) * 10) / 10;
}

/** ***1-on-1 per minggu*, target**: `INFORMAL_GROUP.ONE_ON_ONE_PER_ACTIVE_AGENT` (2) × the Active Agent target. */
export function oneOnOneTarget(activeAgentTarget: number | null): number | null {
  return activeAgentTarget === null ? null : INFORMAL_GROUP.ONE_ON_ONE_PER_ACTIVE_AGENT * activeAgentTarget;
}

/**
 * **`SUBGROUP_DOWNLINE_ADOPTION_PCT` — *Pemakaian AgencyBoost*** over a set of people: of those given, the share who
 * logged at least one day in the window (`APP_USE_IN_PERIOD`), whole; `null` over nobody. The caller splits the people:
 * the downline (agents) and the leaders (AB and AAB).
 */
export function usagePct(used: readonly boolean[]): number | null {
  if (used.length === 0) return null;
  return wholePercent(used.filter(Boolean).length, used.length);
}

/** `EVENT_NPS_FOR_PERIOD`: `EVENT_NPS` over the pooled counted answers, with their mean to one decimal and `n`. */
export function eventNpsForPeriod(scores: readonly number[]): NpsReading & { average: number | null } {
  const reading = eventNps(scores);
  return {
    ...reading,
    average: scores.length === 0 ? null : Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
  };
}
