import { localDayOf, type LocalDate } from '@/common/time/local-day';

/**
 * **`PROPOSALS_MADE` — how many proposals a member finished in a period** (P19.7-T2; `metrics-and-definitions.md` §A.16;
 * ADR-0221 §7; the proposal spec's decision 4). The one figure a leader reads about a member's proposals.
 *
 * ```
 * PROPOSALS_MADE(m, window) = |{ p ∈ proposals : p.ownerMembershipId = m, p.deletedAt = null, p.firstDoneAt ∈ window }|
 * ```
 *
 * A draft never counts (`firstDoneAt` is `null`). A proposal finished, changed and saved again counts once, in the period
 * of its first save. A deleted one leaves the count (the read takes live proposals only). **The window is the KPM's
 * calendar** (invariant §9): an instant counts when its day in the office's zone is within `from`..`to`, both included.
 */
export function proposalsMade(
  firstDoneAts: readonly (Date | null)[], window: { from: LocalDate; to: LocalDate }, timezone: string,
): number {
  return firstDoneAts.filter((at) => {
    if (at === null) return false;
    const day = localDayOf(at, timezone);
    return window.from <= day && day <= window.to;
  }).length;
}
