import { RequestContext, type HierarchyRole } from '@/common/context/request-context';
import { can } from '@/modules/rbac/permissions';
import type { OrgLevelService } from '@/modules/tenants/org-level.service';

/**
 * **Who may put somebody on which rung** (P19.12-T4; ADR-0247 §1, amending the prototype-derived rule of roles §6.5 and
 * ADR-0014's reading of it): one pure function, read by the write (`RoleChangeService`) and by every screen's offer
 * (`TeamMember.roleChoices`, `DirectoryMember.roleChoices`), so the control a screen draws and the refusal the server
 * makes cannot drift apart. `DirectoryService` kept a hand copy of the old rule until then.
 *
 * - **The Owner and an Admin** may set any rung of the company's ladder, **except on the office owner's own
 *   membership**: demoting the owner off the senior rung would strip the rights owning the office brings, and only the
 *   platform reassigns an office.
 * - **The direct leader** may set any rung whose **class is no higher than their own** — an AB leader *Agent · AAB · AB*
 *   (an AB under an AB is ordinary, ADR-0014), an AAB leader *Agent · AAB* — and take one away the same: a report who
 *   stands above the leader is not theirs to move. *Direct* is literal: two levels down is not theirs (`own-unit`).
 * - **Nobody else**: an Agent holds no `member:change_role`, a read-only support session no write, a Super Admin no
 *   office. Their choices are the rung the person stands on, and nothing to change it to.
 *
 * What is **not** here, because it is not a matter of who may: the leader limit (`409 LEADER_LIMIT_REACHED`, ADR-0113,
 * with ADR-0157's request), a leader demoted while people still report to them (`409 ORG_HAS_DIRECT_REPORTS`), and a
 * removed member (`404`). Those are refused by the write, with what to do about them.
 */

/** A rung of the company's ladder, junior first, and the class it gives whoever stands on it (ADR-0156 §2). */
export interface LadderRung {
  code: string;
  role: HierarchyRole;
}

/** Who is asking. */
export interface RoleReader {
  membershipId: string | null;
  /** The office's Owner or an Admin. */
  office: boolean;
  /** Their own class, for a leader's ceiling. `null` with no membership. */
  role: HierarchyRole | null;
  /** They hold `member:change_role` at all — false for an Agent, a read-only support session, anybody with no office. */
  mayChangeRoles: boolean;
}

/** Whom it is about. */
export interface RoleTarget {
  leaderId: string | null;
  role: HierarchyRole;
  orgLevelCode: string;
  status: 'active' | 'pending' | 'removed';
  /** They own the office (`kpms.ownerUserId`). */
  isOwner: boolean;
}

/** The order the classes stand in: an Agent below an AAB below an AB. */
const RANK: Readonly<Record<HierarchyRole, number>> = { agent: 0, aab: 1, ab: 2 };

/** The rank of a class, for comparing two. */
export function rankOf(role: HierarchyRole): number {
  return RANK[role];
}

/**
 * **The default ladder**, junior first — for a caller built without the company's ladder (a spec, a seed's hand-built
 * service). Every office's real ladder is read from its company (`HierarchyService.ladderOf`).
 */
export const DEFAULT_LADDER: readonly LadderRung[] = [
  { code: 'AGENT', role: 'agent' },
  { code: 'AAB', role: 'aab' },
  { code: 'AB', role: 'ab' },
];

/**
 * **A company's ladder, junior first, with each rung's class** — its active rungs by display order (`activeCodesFor`)
 * and the class each gives (`classesByCode`, ADR-0156 §2). A rung with no class answer is an Agent's.
 */
export async function readLadder(
  orgLevels: Pick<OrgLevelService, 'activeCodesFor' | 'classesByCode'>,
  companyId: string,
): Promise<LadderRung[]> {
  const [codes, classes] = await Promise.all([orgLevels.activeCodesFor(companyId), orgLevels.classesByCode(companyId)]);
  return codes.map((code) => ({ code, role: classes.get(code) ?? 'agent' }));
}

/** **Can this member hold a unit** — be somebody's leader (ADR-0087, ADR-0234): active, and an AB, an AAB, or an Agent who already leads somebody. */
export function canHoldUnit(m: { status: string; role: HierarchyRole; directCounts?: { total?: number } | null }): boolean {
  return m.status === 'active' && (m.role !== 'agent' || (m.directCounts?.total ?? 0) > 0);
}

/** The reader as the rules see them, from the request. */
export function roleReaderOf(ctx: RequestContext): RoleReader {
  return {
    membershipId: ctx.membershipId ?? null,
    office: Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin),
    role: ctx.membership?.hierarchyRole ?? null,
    mayChangeRoles: can(ctx, 'member:change_role'),
  };
}

/**
 * **The rung codes this reader may put this person on**, junior first in the ladder's order, **always including the
 * rung they stand on** — so a screen checks the current one, and offers a change only when there is more than one.
 * A current rung since taken off the ladder is kept, first.
 */
export function roleChoices(reader: RoleReader, target: RoleTarget, ladder: readonly LadderRung[]): string[] {
  const current = target.orgLevelCode;
  const only = [current];
  if (!reader.mayChangeRoles || target.status === 'removed' || target.isOwner) return only;

  let allowed: readonly LadderRung[];
  if (reader.office) {
    allowed = ladder;
  } else if (reader.membershipId !== null && target.leaderId === reader.membershipId && reader.role !== null) {
    const ceiling = rankOf(reader.role);
    // Somebody standing above their own leader is not that leader's to move, up or down.
    if (rankOf(target.role) > ceiling) return only;
    allowed = ladder.filter((rung) => rankOf(rung.role) <= ceiling);
  } else {
    return only;
  }

  const codes = allowed.map((rung) => rung.code);
  return codes.some((code) => sameCode(code, current)) ? codes : [current, ...codes];
}

/** May this reader change this person's rung at all: there is a rung to change it to. */
export function canChangeRoleOf(choices: readonly string[]): boolean {
  return choices.length > 1;
}

/** Is a senior-class (AB) rung among the choices to change to — the person page's *AB* option. */
export function canPromoteToAbOf(
  choices: readonly string[],
  ladder: readonly LadderRung[],
): boolean {
  if (!canChangeRoleOf(choices)) return false;
  const classOf = new Map(ladder.map((rung) => [rung.code.toUpperCase(), rung.role]));
  return choices.some((code) => classOf.get(code.toUpperCase()) === 'ab');
}

/** Rung codes compare without case: a request names `aab`, the ladder stores `AAB`. */
export function sameCode(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}
