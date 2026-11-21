import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import {
  AB_ROLE, abGroupOf, byGroupName, placeInformalGroups, type InformalPlacement, type LiveGroup,
} from '@/domain/metrics/leader-groups';
import { NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { GroupRepository } from '@/modules/org/org.repositories';

/** An active member as the partition reads them. */
export interface PartitionMember {
  membershipId: string;
  userId: string | null;
  agentCode: string | null;
  role: string;
  leaderId: string | null;
  ancestorIds: string[];
  isCoreLeader: boolean;
}

/** One AB group: the AB first, then their AABs and agents, in the order the office's rows were read. */
export interface PartitionAbGroup {
  abMembershipId: string;
  memberIds: string[];
}

/**
 * **The KPM partitioned: informal group → AB group → members** (P19.17-T4; ADR-0270 §1; `DATA-DEFINITIONS.md`, *Who is
 * counted*). Every active member, test accounts left out, is in exactly one AB group or in `unplacedIds`, and every AB
 * group in exactly one informal group or *Tanpa group* — so every total is the sum of its parts.
 */
export interface InformalPartition {
  /** The live groups A to Z: each with its Group Leaders while they hold and its ABs (in the order the rows were read). */
  groups: { groupId: string; name: string; leaderIds: string[]; abIds: string[] }[];
  /** *Tanpa group*: the active ABs with no live group. */
  ungroupedAbIds: string[];
  /** Every active AB → their AB group. */
  abGroups: Map<string, PartitionAbGroup>;
  /** Active members under no active AB: counted in the KPM, in no AB group and no group. */
  unplacedIds: string[];
  /** Every active member read, by membership id. */
  members: Map<string, PartitionMember>;
  placement: InformalPlacement;
}

/** Where one person stands: their AB group's AB, and that AB's informal group. */
export interface InformalGroupOf {
  abMembershipId: string | null;
  group: { groupId: string; name: string } | null;
}

/**
 * **The office's informal groups, read once for everybody who reads them** (P19.17-T4; ADR-0270 §1): the partition the
 * KPM Overview, All members, Compliance, the console and Advanced analytics' *Informal group* read, and where one person
 * stands (`informalGroupOf`). *Changed 2026-11-20:* `list`, `membersOf` and `leaderPlacement` — the group filter of KPM
 * analytics and Compliance and the old *Sub-group* rows — went once every reader took the partition; nothing called them.
 *
 * **Only an AB carries a group**; their AABs and agents follow them (`placeInformalGroups`). Everything through the two
 * tenant repositories, so another office's group or member is never found. **A group grants nothing** (P3-T9 AC-1):
 * this answers which people a reader who already reads the whole office wants the figures over, and widens nobody's
 * reach. Archived groups are not offered and not found.
 *
 * **Test accounts are never counted** (`DATA-DEFINITIONS.md`, *Who is counted*; ADR-0267 §1): a membership carrying the
 * test-account flag (`NOT_A_TEST_ACCOUNT`) is left out of the partition, the counts and every group's people.
 */
@Injectable()
export class OfficeGroups {
  constructor(
    private readonly groups: GroupRepository,
    private readonly members: MembershipRepository,
  ) {}

  /** **The partition** — two reads of the office, whatever its size. */
  async partition(ctx: RequestContext): Promise<InformalPartition> {
    const [groupRows, rows] = await Promise.all([
      this.groups.find(ctx, { status: 'active' }, { sort: { name: 1 } }),
      this.members.find(
        ctx, { status: 'active', ...NOT_A_TEST_ACCOUNT },
        {
          projection: { userId: 1, agentCode: 1, role: 1, leaderId: 1, ancestorIds: 1, groupIds: 1, isCoreLeader: 1 },
          sort: { depth: 1, agentSeq: 1 },
        },
      ),
    ]);
    const counted = rows;
    const live: LiveGroup[] = groupRows
      .map((g) => ({ groupId: String(g._id), name: g.name, leaderMembershipIds: g.leaderMembershipIds ?? [] }))
      .sort(byGroupName);
    const placement = placeInformalGroups(counted.map((m) => ({
      membershipId: String(m._id), role: m.role, ancestorIds: (m.ancestorIds ?? []).map(String), groupIds: m.groupIds ?? [],
    })), live);

    const members = new Map<string, PartitionMember>(counted.map((m) => [String(m._id), {
      membershipId: String(m._id),
      userId: m.userId ? String(m.userId) : null,
      agentCode: m.agentCode ?? null,
      role: m.role,
      leaderId: m.leaderId ?? null,
      ancestorIds: (m.ancestorIds ?? []).map(String),
      isCoreLeader: m.isCoreLeader ?? false,
    }]));
    const abGroups = new Map<string, PartitionAbGroup>();
    for (const ab of placement.groupOfAb.keys()) abGroups.set(ab, { abMembershipId: ab, memberIds: [ab] });
    const unplacedIds: string[] = [];
    for (const [id, ab] of placement.abOf) {
      if (ab === null) unplacedIds.push(id);
      else if (ab !== id) abGroups.get(ab)!.memberIds.push(id);
    }
    const abIdsOf = (groupId: string | null) => [...placement.groupOfAb].filter(([, g]) => g === groupId).map(([ab]) => ab);
    return {
      groups: live.map((g) => ({
        groupId: g.groupId, name: g.name, leaderIds: placement.leadersOf.get(g.groupId) ?? [], abIds: abIdsOf(g.groupId),
      })),
      ungroupedAbIds: abIdsOf(null),
      abGroups,
      unplacedIds,
      members,
      placement,
    };
  }

  /**
   * **`INFORMAL_GROUP_OF(m)`** — one person's AB group's AB and that AB's live group, or `null`s: somebody under no active
   * AB, an AB with no group (*Tanpa group*), or a membership this office does not hold. Two reads: the person and the
   * line above them, then the AB's group.
   */
  async informalGroupOf(ctx: RequestContext, membershipId: string): Promise<InformalGroupOf> {
    const person = await this.members.findById(ctx, membershipId);
    if (!person) return { abMembershipId: null, group: null };
    const line = [String(person._id), ...(person.ancestorIds ?? []).map(String)];
    const abs = await this.members.find(
      ctx, { _id: { $in: line }, status: 'active', role: AB_ROLE }, { projection: { groupIds: 1 } },
    );
    const ab = abGroupOf({ membershipId: String(person._id), ancestorIds: (person.ancestorIds ?? []).map(String) }, new Set(abs.map((m) => String(m._id))));
    if (ab === null) return { abMembershipId: null, group: null };
    const tags = abs.find((m) => String(m._id) === ab)!.groupIds ?? [];
    const live = tags.length === 0 ? [] : await this.groups.find(ctx, { _id: { $in: tags }, status: 'active' });
    const first = live.map((g) => ({ groupId: String(g._id), name: g.name })).sort(byGroupName)[0] ?? null;
    return { abMembershipId: ab, group: first };
  }

  /** The people of the AB groups given, each AB first. */
  peopleOf(partition: InformalPartition, abIds: readonly string[]): string[] {
    return abIds.flatMap((ab) => partition.abGroups.get(ab)?.memberIds ?? []);
  }
}
