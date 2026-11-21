import { NotFoundException } from '@/common/errors/domain.exception';
import type { HierarchyRole } from '@/common/context/request-context';
import { AB_ROLE } from '@/domain/metrics/leader-groups';
import type { InformalPartition } from './office-groups';

/** *Tanpa group* in a query: the ABs with no live group, and the members under no AB (`?group=none`). */
export const NO_GROUP = 'none';

/** One informal group as the Overview names it; `groupId: null` is *Tanpa group*. */
export interface OverviewGroupRef {
  groupId: string | null;
  name: string | null;
}

/**
 * **One person's place in the Overview's tree** (P19.19-T1 AC-3; the brief's §2: *"informal group → AB → AAB (indented) →
 * agents (indented)"*). `depth` is the indent: the AB 0; their AABs and their direct agents 1; an AAB's agents 2. Somebody
 * under no AB sits under *Tanpa group* at 0, as an AB does.
 */
export interface OverviewTreeRow {
  membershipId: string;
  role: HierarchyRole;
  groupId: string | null;
  abMembershipId: string | null;
  depth: 0 | 1 | 2;
  /** The leaders above them in their AB group, the AB first: whose *"n di timnya"* they count toward. */
  leaderIds: string[];
}

/** The tree, and its groups in the order drawn: the live groups A to Z, then *Tanpa group* when it holds anybody. */
export interface OverviewTree {
  groups: (OverviewGroupRef & { memberIds: string[] })[];
  rows: OverviewTreeRow[];
}

/**
 * **The office as the Overview draws it** (P19.19-T1; ADR-0272 §3): `OfficeGroups.partition`'s informal groups → AB groups
 * → people, in the order every list of the page reads — **the brief's *"Order inside a team: AB → AAB → agents"***
 * (`DESIGN-RULES.md`):
 *
 * - the live groups A to Z, then *Tanpa group* — the ABs with no group, and after them the members under no AB;
 * - in a group, its ABs A to Z; under each AB, their AABs A to Z, each followed by their own agents A to Z, then the AB's
 *   direct agents A to Z. An AAB under an AAB is one step in, as every AAB is, and their agents two.
 *
 * Pure: the partition (test accounts already left out, ADR-0267 §1) and the names in; nothing read.
 */
export function overviewTree(partition: InformalPartition, nameOf: (membershipId: string) => string): OverviewTree {
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b);
  const rows: OverviewTreeRow[] = [];
  const roleOf = (id: string): HierarchyRole => (partition.members.get(id)?.role ?? 'agent') as HierarchyRole;

  /** An AB group's rows: the AB, each AAB with their agents, then the AB's direct agents. */
  const abRows = (ab: string, groupId: string | null): string[] => {
    const people = partition.abGroups.get(ab)?.memberIds ?? [ab];
    const others = people.filter((id) => id !== ab);
    const aabs = others.filter((id) => roleOf(id) !== 'agent' && roleOf(id) !== AB_ROLE).sort(byName);
    const aabSet = new Set(aabs);
    /** The nearest AAB above an agent, inside the AB group; `null`: the AB's own. */
    const nearestAab = (id: string): string | null => {
      const line = [...(partition.members.get(id)?.ancestorIds ?? [])].reverse();
      for (const up of line) {
        if (up === ab) return null;
        if (aabSet.has(up)) return up;
      }
      return null;
    };
    const agents = others.filter((id) => !aabSet.has(id));
    const under = new Map<string | null, string[]>();
    for (const id of agents) {
      const head = nearestAab(id);
      under.set(head, [...(under.get(head) ?? []), id]);
    }
    const leadersAbove = (id: string): string[] => {
      const line = partition.members.get(id)?.ancestorIds ?? [];
      return [ab, ...line.filter((up) => aabSet.has(up))];
    };
    const order: string[] = [ab];
    rows.push({ membershipId: ab, role: roleOf(ab), groupId, abMembershipId: ab, depth: 0, leaderIds: [] });
    for (const aab of aabs) {
      order.push(aab);
      rows.push({ membershipId: aab, role: roleOf(aab), groupId, abMembershipId: ab, depth: 1, leaderIds: leadersAbove(aab) });
      for (const id of (under.get(aab) ?? []).sort(byName)) {
        order.push(id);
        rows.push({ membershipId: id, role: roleOf(id), groupId, abMembershipId: ab, depth: 2, leaderIds: leadersAbove(id) });
      }
    }
    for (const id of (under.get(null) ?? []).sort(byName)) {
      order.push(id);
      rows.push({ membershipId: id, role: roleOf(id), groupId, abMembershipId: ab, depth: 1, leaderIds: [ab] });
    }
    return order;
  };

  const groups: OverviewTree['groups'] = partition.groups.map((g) => ({
    groupId: g.groupId,
    name: g.name,
    memberIds: [...g.abIds].sort(byName).flatMap((ab) => abRows(ab, g.groupId)),
  }));
  const ungrouped = [...partition.ungroupedAbIds].sort(byName).flatMap((ab) => abRows(ab, null));
  const unplaced = [...partition.unplacedIds].sort(byName);
  for (const id of unplaced) {
    rows.push({ membershipId: id, role: roleOf(id), groupId: null, abMembershipId: null, depth: 0, leaderIds: [] });
  }
  if (ungrouped.length + unplaced.length > 0) groups.push({ groupId: null, name: null, memberIds: [...ungrouped, ...unplaced] });
  // `rows` were pushed group by group in `groups`' order, so they already read top to bottom.
  return { groups, rows };
}

/**
 * **`?group=` read against the tree** (P19.19-T1 AC-2: *"tapping a group filters the whole page to it"*): `undefined`
 * is *Semua group*; `none` is *Tanpa group*; a live group's id is that group. Anything else — an unknown id, an archived
 * group, another office's — is **`404 NOT_FOUND`**, as every group filter answers (ADR-0204 §4).
 */
export function scopeOf(tree: OverviewTree, group: string | undefined): {
  selected: OverviewGroupRef | null;
  memberIds: string[];
  rows: OverviewTreeRow[];
} {
  if (group === undefined) return { selected: null, memberIds: tree.rows.map((r) => r.membershipId), rows: tree.rows };
  const wanted = group === NO_GROUP ? null : group;
  const found = tree.groups.find((g) => g.groupId === wanted);
  if (!found) {
    // *Tanpa group* with nobody in it is still a filter, and reads empty; any other miss is nobody's group.
    if (wanted === null) return { selected: { groupId: null, name: null }, memberIds: [], rows: [] };
    throw new NotFoundException('Group');
  }
  const ids = new Set(found.memberIds);
  return {
    selected: { groupId: found.groupId, name: found.name },
    memberIds: found.memberIds,
    rows: tree.rows.filter((r) => ids.has(r.membershipId)),
  };
}
