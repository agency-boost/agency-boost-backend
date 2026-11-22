import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { NOT_A_TEST_ACCOUNT } from './counted-members';
import type { MembershipRepository } from './membership.repository';
import type { MembershipStatus } from './membership.schema';

/** One recruit: the new hire, the day they joined, and whom they are credited to. */
export interface Recruit {
  membershipId: string;
  userId: string;
  /** *Tanggal bergabung*, an office date (ADR-0169 §1). */
  joinDate: LocalDate;
  /** The member who registered them — the recruiter (`registeredByMembershipId`); `null` where nobody is on record. */
  registeredByMembershipId: string | null;
  /** Their leader today. */
  leaderId: string | null;
  /** `active`, or `removed` for a new hire who has left since: they were recruited all the same. */
  status: MembershipStatus;
}

/**
 * **`RECRUITS_JOINED` — *Recruitment* / *Rekrut*: the new hires who joined in a period, each credited to whoever
 * registered them** (P19.17-T1 AC-3; ADR-0267 §3; `revisions/2026-11-19/DATA-DEFINITIONS.md`, *Production*;
 * `metrics-and-definitions.md` §A.8).
 *
 * - **A new hire** (`joinedAs = new_hire`, ADR-0169 §3 as ADR-0264 amends it) **whose join date falls in the period**,
 *   both ends included — an office date, so no zone moves it. Candidates and potensi never count: a recruitment lead is
 *   not a person in the office until somebody registers them.
 * - **Credited to `registeredByMembershipId`**: who placed them — the inviter on *+ Tambah agent*, the leader whose code
 *   or link they joined on, the leader they asked to join, the leader or the office who tagged them in. `creditedTo`
 *   narrows the read to recruits credited to those members (a unit's people, a group's); omitted, the office's.
 * - **A new hire who left since still counts** (`status: removed`): they joined in the period, and New Hires lists them
 *   for their year too (ADR-0173 §2). A pending person has no join date and never counts. **Never a test account**
 *   (`NOT_A_TEST_ACCOUNT`), nor a soft-deleted row (the repository's default).
 * - **One read**, within the office (the repository adds `kpmId`), oldest join date first.
 *
 * Plain, taking its reader, as `newHiresIn` is: a service that holds `MembershipRepository` needs nothing new injected.
 */
export async function recruitsJoined(
  memberships: Pick<MembershipRepository, 'find'>,
  ctx: RequestContext,
  period: { from: LocalDate; to: LocalDate },
  scope: { creditedTo?: readonly string[] } = {},
): Promise<Recruit[]> {
  if (scope.creditedTo !== undefined && scope.creditedTo.length === 0) return [];
  const rows = await memberships.find(
    ctx,
    {
      joinedAs: 'new_hire',
      joinDate: { $gte: period.from, $lte: period.to },
      status: { $in: ['active', 'removed'] },
      ...(scope.creditedTo === undefined ? {} : { registeredByMembershipId: { $in: [...new Set(scope.creditedTo)] } }),
      ...NOT_A_TEST_ACCOUNT,
    },
    {
      sort: { joinDate: 1, agentSeq: 1 },
      projection: { userId: 1, joinDate: 1, registeredByMembershipId: 1, leaderId: 1, status: 1 },
    },
  );
  return rows.map((row) => ({
    membershipId: String(row._id),
    userId: String(row.userId),
    joinDate: row.joinDate as LocalDate,
    registeredByMembershipId: row.registeredByMembershipId ?? null,
    leaderId: row.leaderId ?? null,
    status: row.status,
  }));
}

/** How many recruits each recruiter is credited with: the green number on a person (`recruitsJoined`'s rows). */
export function recruitCountsByRecruiter(recruits: readonly Recruit[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of recruits) {
    if (r.registeredByMembershipId === null) continue;
    out.set(r.registeredByMembershipId, (out.get(r.registeredByMembershipId) ?? 0) + 1);
  }
  return out;
}
