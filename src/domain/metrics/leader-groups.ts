/**
 * **Informal groups: an AB's tag, the AB group that follows it, and the KPM partitioned by them** (P19.17-T4;
 * [ADR-0270](../../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md);
 * `revisions/2026-11-19/DATA-DEFINITIONS.md`, *Who is counted*; `metrics-and-definitions.md` §A.19). Pure: memberships
 * and groups in, the placement out, no rule but these. Pinned at 100% branch by `leader-groups.spec.ts`.
 *
 * - **An AB group** (`AB_GROUP`) is an active AB, their AABs and every agent under them — **down to, and not including,
 *   the next AB**, whose AB group is their own. So it is exactly the agency `partitionAgencies` computes
 *   (`reporting/agency-partition.ts`), and a test says so: each person belongs to **the nearest active AB among
 *   themselves and their ancestors, upwards**, or to none (*under no AB*).
 * - **Only an AB carries an informal group** (ADR-0270 §1): `memberships.groupIds` on an active AB, one live group or
 *   none — *Tanpa group*. An AB tagged into several live groups before the rule (P3-T9 let anybody carry several) **reads
 *   as one**: the first of them by name, then by id, until migration `0068` or the next write makes it one. A tag on an
 *   AAB or an agent is **never read**: they follow their AB.
 * - **A person's informal group** (`INFORMAL_GROUP_OF`) is their AB group's AB's group; somebody under no active AB is in
 *   none. So the groups and *Tanpa group* partition the KPM, and every total is the sum of its AB groups.
 * - **Group Leaders** (ADR-0270 §2): a group's `leaderMembershipIds`, any number, **while each holds** — an active AB who
 *   reads in this group. A leader who has left, is no longer an AB, or has moved to another group is not shown, though
 *   the row keeps the id until the next write.
 */

/** A live group of the KPM, as stored. */
export interface LiveGroup {
  groupId: string;
  name: string;
  /** The Group Leaders as stored, in the order they were appointed: ABs, any number, `[]` for none. */
  leaderMembershipIds: readonly string[];
}

/** A member as the placement reads them: the class, the cached path, and the tags their row carries. */
export interface GroupedMember {
  membershipId: string;
  /** The class (ADR-0156): `ab`, `aab` or `agent`. Only an `ab` heads an AB group or carries a group. */
  role: string;
  /** Root first, excluding self: the cache the org module writes with every edge (`memberships.ancestorIds`). */
  ancestorIds: readonly string[];
  /** `memberships.groupIds` as stored. Read on an active AB only. */
  groupIds: readonly string[];
  /** Here now (default). A leaver heads nothing and carries no group, and is placed by the edges they left with. */
  active?: boolean;
}

export interface InformalPlacement {
  /** Every member given → the AB whose AB group they are in (an active AB → themselves), or `null` under no active AB. */
  abOf: Map<string, string | null>;
  /** Every active AB given → their one live group, or `null` — *Tanpa group*. */
  groupOfAb: Map<string, string | null>;
  /** Every member given → their informal group, their AB's (`INFORMAL_GROUP_OF`), or `null`. */
  groupOf: Map<string, string | null>;
  /** Every live group given → its Group Leaders while they hold, in the stored order. */
  leadersOf: Map<string, string[]>;
}

/** The class that heads an AB group and carries a group. */
export const AB_ROLE = 'ab';

/** `name`, then `groupId`: the order an AB's several legacy tags are read in, and the order groups are listed. */
export function byGroupName(a: { groupId: string; name: string }, b: { groupId: string; name: string }): number {
  return a.name.localeCompare(b.name) || a.groupId.localeCompare(b.groupId);
}

const isActive = (m: GroupedMember) => m.active !== false;

/**
 * **`AB_GROUP_OF`**: the nearest id among the member themselves and their ancestors, upwards, that `abs` holds (the
 * active ABs), or `null`. A leaver is never in `abs`, so they are placed by the AB above them.
 */
export function abGroupOf(member: Pick<GroupedMember, 'membershipId' | 'ancestorIds'>, abs: ReadonlySet<string>): string | null {
  for (const id of [member.membershipId, ...[...member.ancestorIds].reverse()]) {
    if (abs.has(id)) return id;
  }
  return null;
}

/** **`AB_GROUP_OF`, `GROUP_OF_AB`, `INFORMAL_GROUP_OF` and the Group Leaders**, for every member and group given. */
export function placeInformalGroups(members: readonly GroupedMember[], groups: readonly LiveGroup[]): InformalPlacement {
  const sorted = [...groups].sort(byGroupName);
  const abs = new Set(members.filter((m) => isActive(m) && m.role === AB_ROLE).map((m) => m.membershipId));

  const groupOfAb = new Map<string, string | null>();
  for (const m of members) {
    if (!abs.has(m.membershipId)) continue;
    const tagged = new Set(m.groupIds);
    groupOfAb.set(m.membershipId, sorted.find((g) => tagged.has(g.groupId))?.groupId ?? null);
  }

  const abOf = new Map<string, string | null>();
  const groupOf = new Map<string, string | null>();
  for (const m of members) {
    const ab = abGroupOf(m, abs);
    abOf.set(m.membershipId, ab);
    groupOf.set(m.membershipId, ab === null ? null : groupOfAb.get(ab) ?? null);
  }

  const leadersOf = new Map<string, string[]>();
  for (const g of sorted) {
    leadersOf.set(g.groupId, [...new Set(g.leaderMembershipIds)].filter((id) => groupOfAb.get(id) === g.groupId));
  }
  return { abOf, groupOfAb, groupOf, leadersOf };
}

/** Somebody placed by the leader edges: themselves, and their ancestors root first (`memberships.ancestorIds`). */
export interface PlacedPerson {
  membershipId: string;
  ancestorIds: readonly string[];
}

/**
 * **`SUBGROUP_OF`**: each person's row on *Informal group* (Advanced analytics) — the group of the nearest id among
 * themselves and their ancestors, upwards, that `groupOf` places, or `null`, *Tanpa group*. Given the active ABs' and
 * AABs' groups from `placeInformalGroups` (an AAB's group is their AB's), it is `INFORMAL_GROUP_OF` for anybody, a
 * leaver included: the nearest leader's group is their AB's.
 */
export function subgroupOf(person: PlacedPerson, groupOf: ReadonlyMap<string, string | null>): string | null {
  for (const id of [person.membershipId, ...[...person.ancestorIds].reverse()]) {
    if (groupOf.has(id)) return groupOf.get(id) ?? null;
  }
  return null;
}
