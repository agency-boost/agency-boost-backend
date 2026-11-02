import { countedFrom, type CountedMembership } from './office-headcount';

/**
 * `PRODUCING_AGENTS` (Phase 18.1, P18.1-T1 AC-4; OD-144) — the forum's *Producing agents* (`KPM_Owner.html:2465`),
 * over *FY* and *YTD*.
 *
 * **The members who were a Monthly Active Agent in at least one month of the period held, in a month they belonged
 * to the office** (ADR-0136): a leaver's months before they left count, as their production does, and a member's
 * months before they joined do not. Active is `MONTHLY_ACTIVE_AGENT` (ADR-0054), never a definition of this file's
 * (invariant §8). Pure; the caller reads the flags.
 */

/**
 * **A membership belonged to the office at some moment of `[start, endExclusive)`** — joined before it ended, by their
 * join date (`countedFrom`, ADR-0172 §1; `joinedAt` for a row with none), and not removed before it began. The month's
 * reading of `memberAt` (OD-24, `office-headcount.ts`), whose rows it reads the same way: a pending membership never,
 * an active one with neither date always, a removed one with no `removedAt` never — nobody can say when it was here.
 */
export function belongedDuring(membership: CountedMembership, start: Date, endExclusive: Date): boolean {
  if (membership.status === 'pending') return false;
  const from = countedFrom(membership);
  if (from !== null && from.getTime() >= endExclusive.getTime()) return false;
  if (membership.status === 'removed') {
    return membership.removedAt !== null && membership.removedAt.getTime() > start.getTime();
  }
  return true;
}

/**
 * `PRODUCING_AGENTS`: each member's `MONTHLY_ACTIVE_AGENT` over the period's held months **they belonged to the office
 * in** — the caller leaves the others out — counted where any is `true`. **`null` when no month of the period is
 * held**: *pending data*, never 0.
 */
export function producingAgents(members: readonly (readonly (boolean | null)[])[], monthsHeld: number): number | null {
  if (monthsHeld === 0) return null;
  return members.filter((flags) => flags.some((flag) => flag === true)).length;
}
