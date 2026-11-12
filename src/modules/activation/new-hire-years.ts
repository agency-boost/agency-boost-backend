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

/** What the readers here read with: the same `COACH` and the same memberships as every route of New Hires. */
export interface NewHireReaders {
  coach: CoachResolver;
  memberships: MembershipRepository;
}

/**
 * **A new hire who left, below the reader** (ADR-0173 §2; ADR-0169 §4 as amended 2026-10-27): *Mark left* removed them
 * from the office (`status: 'removed'`, `leftAt` set), so `COACH` reaches them no more — they are read below the reader on
 * the edges they were removed with (`ancestorIds`), a new hire (`joinedAs`) whose join date is in the span. **One filter**,
 * for the list (`newHiresIn`) and for one hire (`newHireReached`), so the two cannot disagree about who left.
 */
function leaversFilter(me: string, span: JoinDateSpan) {
  return {
    joinedAs: 'new_hire', joinDate: { $gte: span.from, $lte: span.to }, ancestorIds: me, status: 'removed',
    leftAt: { $ne: null },
  } as const;
}

/**
 * **Who `/new-hires` lists for a span of join dates — one definition** (ADR-0173 §1, §2 as amended by ADR-0233; P19.9-T3
 * AC-1, AC-3, AC-6): the page's rows, the session's `newHires` flag and Home's *New hires* tile all read it, so the three
 * cannot disagree about a count (the lesson of the owner's R1).
 *
 * - **Every new hire the reader coaches now** (`COACH`, at any depth, never themselves) — `joinedAs = new_hire`, never an
 *   existing agent — whose join date is in the span;
 * - **and the ones who left** (`leaversFilter`).
 *
 * **Everybody listed opens** (P19.11-T2 AC-1, UX-3; ADR-0239): `newHireReached` reaches each of them by the same two
 * halves — `COACH` itself, whose `coachee` and `coacheesOf` agree member by member, and the same leavers' filter.
 *
 * `coachees` is everybody the reader coaches, listed or not: the roster names each hire's unit from it. Plain, taking its
 * readers, so the services that call it need nothing new injected.
 */
export async function newHiresIn(
  readers: NewHireReaders, ctx: RequestContext, me: string, span: JoinDateSpan,
): Promise<{ coachees: Coachee[]; listed: ListedNewHire[] }> {
  const [coachees, gone] = await Promise.all([
    readers.coach.coacheesOf(ctx, me),
    readers.memberships.find(ctx, leaversFilter(me, span)),
  ]);
  return {
    coachees,
    listed: [
      ...coachees.filter(({ membership: m }) => m.joinedAs === 'new_hire' && inSpan(m.joinDate, span)),
      ...gone.map((m) => ({ membershipId: String(m._id), membership: m })),
    ],
  };
}

/** One hire as `GET /new-hires/:membershipId` reaches them: their membership, and whether they left. */
export interface ReachedNewHire {
  membership: MembershipDocument;
  /**
   * A new hire who left (`leaversFilter`): their activation is read and **never written** — nobody coaches them now, so
   * every write route still answers 404 (`COACH`), and the detail is served `readOnly`.
   */
  left: boolean;
}

/**
 * **Whom one hire's detail reaches — the list's own two halves** (P19.11-T2 AC-1, UX-3: *visibility and clickability use
 * the same permission check*; ADR-0239). Before it, a new hire who left was listed by `newHiresIn` and refused by the
 * detail, which asked `COACH` alone; their row opened nothing (the Phase 19.9 exit review, L4).
 *
 * - **Somebody the reader coaches now** (`COACH`, `coachee`) — a listed new hire, and anybody else with an activation the
 *   coaching *Activation* tab opens, as before;
 * - **or a new hire who left below them, joined in `span`** — the same `leaversFilter` the list reads — `left: true`.
 *
 * `null` for anybody else: a stranger, a peer's hire, another office's member (the tenant repository finds nobody), an id
 * that is nobody's, the reader themselves.
 */
export async function newHireReached(
  readers: NewHireReaders, ctx: RequestContext, me: string, membershipId: string, span: JoinDateSpan,
): Promise<ReachedNewHire | null> {
  const coached = await readers.coach.coachee(ctx, me, membershipId);
  if (coached) return { membership: coached, left: false };
  if (membershipId === me) return null;
  // A malformed id finds nothing rather than throwing: the repository's `findOne` says so.
  const gone = await readers.memberships.findOne(ctx, { _id: membershipId, ...leaversFilter(me, span) });
  return gone ? { membership: gone, left: true } : null;
}
