import type { LocalDate } from '@/common/time/local-day';
import { activationCohort, type CohortActivation } from './activation-cohort';
import { rateOver, type Rate } from './rate';

/**
 * `ACTIVATION_COMPLETION_RATE` (Phase 18.3, P18.3-T1 AC-7; OD-159 → option 1) — **what share of a set's
 * activations graduated**, and the one reading of an activation the Owner's compliance tree draws.
 *
 * **Not `ACTIVATION_COMPLETION_PCT`**, which is one hire's items done over their checklist's (`activation-rules.ts`,
 * `progressOf`). This is a set's activations: how many of them the hire **graduated** — declared complete (OD-28,
 * ADR-0100) — over all of them, whatever state the rest are in. One word, two scopes, two names.
 *
 * - **Completed is graduated**, and nothing else: an open activation at 100% the hire has not declared is still
 *   *in progress*; an expired one is not completed, whatever it held when it ended.
 * - **The denominator is the activations of the set** — a member with none is outside it, never a miss (D-chips).
 * - **`pct: null` over nobody** — never 0% (`rateOver`).
 *
 * Two readers, one function (invariant §8): the tree's *Activation* chip passes the tree's members' activations; the
 * PRD's *"New hires completing the 90-day activation — ≥60% of the cohort"* is the same function over
 * `ACTIVATION_COHORT` of the last finished calendar year (`cohortCompletionRate`), so open hires do not depress it —
 * pinned by a test on the seed's shape, drawn on no screen. Pure: states in, the share out.
 */

/** An activation's state, as `activationState` derives it on every read (OD-28, OD-120). */
export type ActivationStateForRate = 'open' | 'graduated' | 'expired';

/** What the tree draws for one hire (OD-159): the *90-day checklist* pill's three words, by code. */
export type ActivationOutcome = 'completed' | 'in_progress' | 'overdue';

/**
 * **The tree's reading of one activation** (OD-159 → option 1): *Completed* when graduated; *Overdue* when open past
 * the office's window below 100% (`isOverdue`, the roster's red day) **or expired** — its end said beside it; *In
 * progress* otherwise, an undeclared 100% included. The same two facts the leader's roster and detail read.
 */
export function activationOutcome(activation: { state: ActivationStateForRate; overdue: boolean }): ActivationOutcome {
  if (activation.state === 'graduated') return 'completed';
  if (activation.state === 'expired' || activation.overdue) return 'overdue';
  return 'in_progress';
}

/** `ACTIVATION_COMPLETION_RATE`: graduated activations over every activation of the set. */
export function activationCompletionRate(activations: readonly { state: ActivationStateForRate }[]): Rate {
  return rateOver(activations.filter((a) => a.state === 'graduated').length, activations.length);
}

/**
 * **The PRD's figure** (`prd.md` §8, OD-159): `ACTIVATION_COMPLETION_RATE` over the activations of
 * `ACTIVATION_COHORT` for a period — the last finished calendar year (`lastFinishedYear`) — read by **each
 * activation's own start day** in the office's calendar, both bounds included, as the cohort reads it
 * (`activationCohort`). An activation is in or out by its own day: a membership's other activation, started outside the
 * period, is never counted because this one was in it (the exit review, round 1, 6).
 */
export function cohortCompletionRate(
  activations: readonly (CohortActivation & { state: ActivationStateForRate })[],
  period: { from: LocalDate; to: LocalDate },
): Rate {
  return activationCompletionRate(activations.filter((a) => activationCohort([a], period).length === 1));
}

/** The calendar year before the office's today's: the last one finished, as office days. */
export function lastFinishedYear(today: LocalDate): { from: LocalDate; to: LocalDate } {
  const year = String(Number(today.slice(0, 4)) - 1);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
