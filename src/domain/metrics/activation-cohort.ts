import type { LocalDate } from '@/common/time/local-day';
import { NEW_AGENT_ACTIVE_MONTHS } from '@/domain/constants/metrics';
import { rateOver, type Rate } from './rate';

/**
 * `ACTIVATION_COHORT` and `NEW_AGENT_3M_ACTIVE_PCT` (Phase 18.1, P18.1-T1; D-cohort, ADR-0102, ADR-0103) — the
 * forum's *3M new agent %* (`KPM_Owner.html:2468`, defined `:2474`) and the cohort it is a share of.
 *
 * **The cohort is read by the activation's start day**, an office date (`activationProgress.startDate`): the day
 * the hire joined, in the office's calendar, unless a leader corrected it (ADR-0102). So the day boundary is the
 * office's (invariant §9) — a hire who joined at 23:59 on a month's last day in Jakarta starts in that month, one
 * who joined at 00:01 the next day in the next. One function, read by the forum and, from 18.5, the compliance tree.
 *
 * **Active is `MONTHLY_ACTIVE_AGENT`** (ADR-0054), read from the office's file: this file defines no *active* of its
 * own (invariant §8). Pure; the caller reads the months.
 */

/** An activation as the cohort reads it: whose, and its day 1. */
export interface CohortActivation {
  membershipId: string;
  startDate: LocalDate;
}

/**
 * `ACTIVATION_COHORT`: the memberships whose activation started in the period, both bounds included, each once. A
 * person who left and rejoined is a new membership with an activation of its own (ADR-0022), so they can be in a
 * cohort twice — as the two people the office's records say they were.
 */
export function activationCohort(
  activations: readonly CohortActivation[], period: { from: LocalDate; to: LocalDate },
): string[] {
  const ids = new Set<string>();
  for (const a of activations) {
    if (a.startDate >= period.from && a.startDate <= period.to) ids.add(a.membershipId);
  }
  return [...ids];
}

/** One of a hire's months, from their start month on, as the office's file and its memberships give it. */
export interface CohortMonth {
  /** The office holds a file for the month. */
  held: boolean;
  /** The hire was a member of the office at some moment of the month. */
  belonged: boolean;
  /** Their `MONTHLY_ACTIVE_AGENT` for the month; `null` where the file says nothing of them. */
  active: boolean | null;
}

export type CohortOutcome = 'producing' | 'not_producing' | 'left_out';

/**
 * **Where one hire stands**, over their start month and the three after it (`NEW_AGENT_ACTIVE_MONTHS`):
 *
 * - **a member through all four**: counted once all four months are held — *producing* if any shows them a Monthly
 *   Active Agent, *not producing* otherwise — and **left out until then**, never counted as not producing for a month
 *   whose file has not come;
 * - **a member through only some of them** — a hire who left within their four months (the spec's *Noted* 4): counted
 *   on the months they belonged to the office, *producing* if any of those held shows them active; **otherwise left
 *   out**, not counted as not producing, until the client confirms the row (OD-144).
 *
 * A held month whose file says nothing of them is not one they were active in, as `MAA_COUNT_IN_UNIT` reads it.
 */
export function cohortOutcome(months: readonly CohortMonth[]): CohortOutcome {
  const theirs = months.slice(0, NEW_AGENT_ACTIVE_MONTHS);
  const activeIn = (m: CohortMonth) => m.held && m.belonged && m.active === true;
  if (theirs.length === NEW_AGENT_ACTIVE_MONTHS && theirs.every((m) => m.belonged)) {
    if (!theirs.every((m) => m.held)) return 'left_out';
    return theirs.some(activeIn) ? 'producing' : 'not_producing';
  }
  return theirs.some(activeIn) ? 'producing' : 'left_out';
}

/**
 * `NEW_AGENT_3M_ACTIVE_PCT`: the share of a period's cohort who were Monthly Active Agents in their start month or
 * any of the three after it, over the hires counted (`cohortOutcome`) — a whole percentage, as every share the Owner
 * reads is (`rateOver`). **`pct: null` while nobody is counted**: *pending data*, never 0%. `leftOut` is how many
 * of the cohort it does not count yet.
 */
export function newAgent3mActive(hires: readonly (readonly CohortMonth[])[]): Rate & { leftOut: number } {
  const outcomes = hires.map(cohortOutcome);
  const counted = outcomes.filter((o) => o !== 'left_out').length;
  return {
    ...rateOver(outcomes.filter((o) => o === 'producing').length, counted),
    leftOut: hires.length - counted,
  };
}
