import type { FilterQuery } from 'mongoose';
import type { RequestContext } from '@/common/context/request-context';
import { scopeFor, type Permission, type Scope } from '@/modules/rbac/permissions';
import type { MembershipDocument } from './membership.schema';

/*
 * **Which memberships a reader may see.** The roster, one member's read, their reports and who came back
 * (`DirectoryService`), the org tree (`OrgTreeService`) and where a removal may send a unit (`RemovalService`) all
 * narrow through this file. It decides who reads whose name, agent code and email, so it is permissions code: moved
 * out of `directory.service.ts` at the Phase 18.97 exit permission review (P18.97-T8 L2), answering exactly what it
 * answered there, and held at 100% branch in `jest.config.ts` as `coach-resolver.ts` is, apart from the service
 * around it, whose floor is the module's.
 */

/**
 * **The permission the directory's reads are gated on** — `GET /members`, `/members/:membershipId` and
 * `/members/:membershipId/reports` — and so the one they narrow by. Documented at the same scopes as
 * `member:list_directory`: a tenant admin the office, an AB their downline, an AAB their own unit (the subtree, see
 * `visibleTo`), an Agent themselves.
 */
export const DIRECTORY_READ: Permission = 'member:read_profile';

/**
 * Who this requester may see, as a filter fragment.
 *
 * It is exported and shared because the roster and the org tree must narrow
 * **identically** — two copies of a visibility rule drift, and the drift is a cross-unit
 * leak rather than a rendering bug.
 *
 * **The scope comes from the grant list**, resolved for the permission the caller was
 * gated on, so the matrix column is the implementation rather than a description of one.
 * It was not until 2026-09-06: this returned self-plus-whole-downline for everybody who
 * was not a tenant admin, and no caller passed a scope because it took none.
 *
 * **`own-unit` resolves to the subtree here, and that is deliberate.** The matrix's rules
 * 1 and 2 (`roles-and-permissions.md:187-196`) say so in as many words: *"`own-unit` for
 * an AB resolves to `own-downline`"*, with role change and removal named as the only
 * exceptions, and for an AAB *"`own-downline` is still the correct token"* even where a
 * KPM nests AAB under AAB. This function serves **reading** — the roster and the org
 * tree — and neither is one of those exceptions. The exceptions act on the leader edge
 * the actor owns and check `leaderId` directly; they never come through here.
 *
 * A first pass on 2026-09-06 read the matrix *cells* and not the rules beneath them, and
 * narrowed an AAB to their direct reports. That is a real narrowing: a nested AAB would
 * have lost sight of their own grandchildren in the group tree, on a screen whose manual
 * says it draws "your unit and everyone below it". Corrected the same day, with the test
 * below rewritten to assert the downline rather than the narrowing.
 *
 * Somebody with no membership sees nothing, and says so as an impossible filter rather
 * than an absent one — an absent filter would return the office.
 */
export function visibleTo(
  ctx: RequestContext,
  permission: Permission = DIRECTORY_READ,
): FilterQuery<MembershipDocument> {
  if (ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin || ctx.isSuperAdmin) return {};
  const self = ctx.membershipId;
  if (!self) return { _id: null };
  return scopeFilter(scopeFor(ctx, permission), self);
}

/**
 * **What a scope means as a filter on memberships**, for the reader whose membership is `self`.
 *
 * Apart from `visibleTo` so that every scope is pinned here, whatever a grant list says today: `all` and `own-kpm`
 * reach this only for a permission that hands a whole office to somebody who is not its admin, which none of the
 * three this file's callers pass does — and `null`, no grant at all, fails closed whoever asked.
 */
export function scopeFilter(scope: Scope | null, self: string): FilterQuery<MembershipDocument> {
  switch (scope) {
    case 'all':
    case 'own-kpm':
      return {};
    // `ancestorIds` makes the downline arm a single indexed lookup on
    // `(kpmId, ancestorIds, status)`.
    //
    // Both tokens land here: see the note on `visibleTo` on rules 1 and 2. A leader reads their
    // subtree; the rules that are genuinely limited to direct reports do not use this.
    case 'own-downline':
    case 'own-unit':
      return { $or: [{ _id: self }, { ancestorIds: self }] };
    case 'own':
      return { _id: self };
    // No grant at all. The guard refuses these before a service is reached; a filter
    // that fails closed is the backstop for the day one is not behind the guard.
    default:
      return { _id: null };
  }
}

/**
 * **`filter`, narrowed to what this reader may see of the directory — under `$and`, never spread over it.**
 *
 * The narrowing for `own` is `{ _id: self }`, which is the one filter shape that collides with an id being asked
 * for: spread second, it replaced the id, and the read answered about the caller while claiming to be about somebody
 * else (the Phase 3.5 exit review; `org-hierarchy.md`, *How the narrowing composes, and why it is `$and`*). Under
 * `$and` a colliding narrowing can only ever match nothing, which is the direction a visibility filter must fail in.
 */
export function withinReach(
  ctx: RequestContext,
  filter: FilterQuery<MembershipDocument>,
): FilterQuery<MembershipDocument> {
  return { $and: [filter, visibleTo(ctx, DIRECTORY_READ)] };
}

/**
 * **Every membership of these people that the reader may see, whatever its state** — what `rejoinedOn` reads to say
 * who came back (P18.97-T4 AC-3, ADR-0176 §5), each person asked for once. Narrowed as the page was: a leader's
 * roster says nothing of a membership outside their unit, and an Agent's, whose reach is the one membership they
 * hold, of no other.
 */
export function siblingsWithinReach(
  ctx: RequestContext,
  userIds: readonly string[],
): FilterQuery<MembershipDocument> {
  return withinReach(ctx, { userId: { $in: [...new Set(userIds)] } });
}
