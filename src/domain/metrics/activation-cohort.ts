import type { LocalDate } from '@/common/time/local-day';

/**
 * `ACTIVATION_COHORT` (Phase 18.1, P18.1-T1; D-cohort, ADR-0102, ADR-0103) — the hires whose activation started in a
 * period. The forum's *3M new agent %* read it until P18.8-T6 (below); `ACTIVATION_COMPLETION_RATE` still does.
 *
 * **The cohort is read by the activation's start day**, an office date (`activationProgress.startDate`): the day
 * the hire joined, in the office's calendar, unless a leader corrected it (ADR-0102). So the day boundary is the
 * office's (invariant §9) — a hire who joined at 23:59 on a month's last day in Jakarta starts in that month, one
 * who joined at 00:01 the next day in the next. Pure.
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

/*
 * `CohortMonth`, `cohortOutcome` and `newAgent3mActive` — `NEW_AGENT_3M_ACTIVE_PCT`, a hire's start month and the three
 * after it read from the production file — were here until P18.8-T6, when ADR-0171 §2 retired the metric for
 * `ACTIVATION_3M_PCT` (`activation-3m.ts`): a first sale by day 90 of the join date, the one 3M metric (invariant §8).
 * The cohort stays, for `ACTIVATION_COMPLETION_RATE`'s calendar year (`activation-completion-rate.ts`).
 */
