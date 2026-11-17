/**
 * **A leader's informal group, its ★ group leader, and the office partitioned by them** (P19.13-T3; UI-199; ADR-0253
 * §1, §2, §5; `metrics-and-definitions.md` §A.19). Pure: memberships and groups in, the placement out, no rule but these.
 * Pinned at 100% branch by `leader-groups.spec.ts`.
 *
 * - **A leader has one group or none** (ADR-0253 §1). Every write since P19.13-T3 keeps it so; a leader tagged into
 *   several live groups before it — `memberships.groupIds` was a list for everybody (P3-T9) — **reads as one**: the live
 *   group whose ★ they are, else the first of their live groups by name, then by id. Their other tags stay on the row
 *   until the office next saves them.
 * - **The ★ group leader** is the group's `ownerMembershipId` (ADR-0253 §2) **while it holds**: the owner is one of the
 *   leaders placed and this group is the one they read in. A ★ who has left, been moved off a leader rung or into
 *   another group reads *Belum ada group leader* — never a star on somebody the page does not list in that group.
 * - **The partition** (Sub-group, ADR-0253 §5): each person belongs to **the nearest leader** among themselves and their
 *   ancestors, upwards — an active AB or AAB — and so to **that leader's group, or *Tidak ada group* (`null`) when the
 *   leader has none**. A leader is always in their own row; an Agent in their nearest leader's; somebody under no
 *   active leader in *Tidak ada group*. So every person is in exactly one row, the rows sum to the office, and *Tidak
 *   ada group* holds exactly the leaders the page lists *Tanpa group*, with their people — the report's *"Leaders without
 *   a group form the 'Tidak ada group' row"*, and the approved mockup's counts.
 */

/** A live group of the office, as stored. */
export interface LiveGroup {
  groupId: string;
  name: string;
  /** The ★ as stored: `null`, or a membership that may since have left. */
  ownerMembershipId: string | null;
}

/** An active member on a leader rung (AB or AAB), with the group tags their row carries. */
export interface TaggedLeader {
  membershipId: string;
  groupIds: readonly string[];
}

export interface LeaderPlacement {
  /** Every leader given, to their one live group or `null` — *Tanpa group*. */
  groupOf: Map<string, string | null>;
  /** Every live group given, to its ★ group leader or `null` — *Belum ada group leader*. */
  headOf: Map<string, string | null>;
}

/** `name`, then `groupId`: the order a leader's several groups are read in, and the order the page lists groups. */
export function byGroupName(a: LiveGroup, b: LiveGroup): number {
  return a.name.localeCompare(b.name) || a.groupId.localeCompare(b.groupId);
}

/** **`LEADER_GROUP` and `GROUP_HEAD`**: each leader's one group, and each group's ★. */
export function placeLeaders(leaders: readonly TaggedLeader[], groups: readonly LiveGroup[]): LeaderPlacement {
  const sorted = [...groups].sort(byGroupName);
  const groupOf = new Map<string, string | null>();
  for (const leader of leaders) {
    const tagged = new Set(leader.groupIds);
    const mine = sorted.filter((g) => tagged.has(g.groupId));
    const led = mine.find((g) => g.ownerMembershipId === leader.membershipId);
    groupOf.set(leader.membershipId, (led ?? mine[0])?.groupId ?? null);
  }
  const headOf = new Map<string, string | null>();
  for (const group of sorted) {
    const owner = group.ownerMembershipId;
    headOf.set(group.groupId, owner !== null && groupOf.get(owner) === group.groupId ? owner : null);
  }
  return { groupOf, headOf };
}

/** Somebody placed by the leader edges: themselves, and their ancestors root first (`memberships.ancestorIds`). */
export interface PlacedPerson {
  membershipId: string;
  ancestorIds: readonly string[];
}

/**
 * **`SUBGROUP_OF`**: each person's row — the group of the nearest leader among themselves and their ancestors, upwards,
 * or `null`, *Tidak ada group*, when that leader has none or there is none. `groupOf` is `placeLeaders`' (active leaders
 * only, so a leaver is placed by their nearest active leader above, never by themselves).
 */
export function subgroupOf(person: PlacedPerson, groupOf: ReadonlyMap<string, string | null>): string | null {
  for (const id of [person.membershipId, ...[...person.ancestorIds].reverse()]) {
    if (groupOf.has(id)) return groupOf.get(id) ?? null;
  }
  return null;
}
