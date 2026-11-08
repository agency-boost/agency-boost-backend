import { RequestContext } from '@/common/context/request-context';
import { inSpan, type JoinDateSpan } from '@/domain/metrics/activation-3m';
import type { Coachee, CoachResolver } from '@/modules/org/coach-resolver';
import type { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument } from '@/modules/org/membership.schema';

/** A new hire `/new-hires` lists: their membership, and its id. */
export interface ListedNewHire {
  membershipId: string;
  membership: MembershipDocument;
}

/**
 * **Who `/new-hires` lists for a span of join dates — one definition** (ADR-0173 §1, §2 as amended by ADR-0233; P19.9-T3
 * AC-1, AC-3, AC-6): the page's rows, the session's `newHires` flag and Home's *New hires* tile all read it, so the three
 * cannot disagree about a count (the lesson of the owner's R1).
 *
 * - **Every new hire the reader coaches now** (`COACH`, at any depth, never themselves) — `joinedAs = new_hire`, never an
 *   existing agent — whose join date is in the span;
 * - **and the ones who left** (ADR-0173 §2; ADR-0169 §4 as amended 2026-10-27): *Mark left* removes a new hire from the
 *   office, so `COACH` reaches them no more — they are read below the reader on the edges they were removed with.
 *
 * `coachees` is everybody the reader coaches, listed or not: the roster names each hire's unit from it. Plain, taking its
 * readers, so the services that call it need nothing new injected.
 */
export async function newHiresIn(
  readers: { coach: CoachResolver; memberships: MembershipRepository },
  ctx: RequestContext, me: string, span: JoinDateSpan,
): Promise<{ coachees: Coachee[]; listed: ListedNewHire[] }> {
  const [coachees, gone] = await Promise.all([
    readers.coach.coacheesOf(ctx, me),
    readers.memberships.find(ctx, {
      joinedAs: 'new_hire', joinDate: { $gte: span.from, $lte: span.to }, ancestorIds: me, status: 'removed', leftAt: { $ne: null },
    }),
  ]);
  return {
    coachees,
    listed: [
      ...coachees.filter(({ membership: m }) => m.joinedAs === 'new_hire' && inSpan(m.joinDate, span)),
      ...gone.map((m) => ({ membershipId: String(m._id), membership: m })),
    ],
  };
}
