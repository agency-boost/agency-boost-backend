import type { MembershipStatus } from './membership.schema';

/** What the rule reads of one membership: whose it is, its state, and when it began. */
export interface RejoinFacts {
  id: string;
  userId: string;
  status: MembershipStatus;
  /** The office date the person joined on (ADR-0169), `null` while pending. */
  joinDate: string | null;
  /** When the membership began, for ordering: made active (`joinedAt`), else made (`createdAt`). */
  startedAt: Date;
}

/**
 * **The day a member came back, if they did** (P18.97-T4 AC-3, ADR-0176 §5; the client's UI-024): one person, one
 * office, several memberships over time (invariant §2), each kept — so a directory that lists the live one beside a
 * *Removed* tab holding the old one reads as a contradiction unless it says which came back.
 *
 * - **A live membership that follows a removed one** — the person left and returned — answers its own join date:
 *   the directory's *Rejoined*. `null` while it is pending, since nobody has let them back in yet.
 * - **A removed membership with a later one** answers that later one's join date: *Rejoined {date}* under
 *   *Removed*. `null` when the later one is still pending, or there is none.
 * - Anything else — a first membership, or a pending one that follows nothing removed — answers `null`.
 *
 * Memberships are ordered by when they began, the id breaking a tie, so a seed that made both in one second still
 * reads in the order it made them. `siblings` holds every membership of the person the reader may see in the office,
 * `member` among them or not.
 */
export function rejoinedOn(member: RejoinFacts, siblings: readonly RejoinFacts[]): string | null {
  const ordered = [...new Map([member, ...siblings].filter((m) => m.userId === member.userId).map((m) => [m.id, m])).values()]
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  const at = ordered.findIndex((m) => m.id === member.id);
  if (member.status === 'removed') return ordered[at + 1]?.joinDate ?? null;
  return ordered.slice(0, at).some((m) => m.status === 'removed') ? member.joinDate : null;
}
