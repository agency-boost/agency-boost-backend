import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { preferredNameOf } from '@/modules/users/display-name';
import { User, UserDocument } from '@/modules/users/user.schema';
import { initialsOf } from './directory.service';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole } from './membership.schema';
import { visibleTo } from './reader-visibility';

export interface OrgTreeNode {
  membershipId: string;
  fullName: string;
  preferredName: string | null;
  initials: string;
  agentCode: string;
  role: HierarchyRole;
  /** Office depth, as stored. 0 is a root of the office. */
  depth: number;
  /**
   * Depth **within this projection**, one-based — the number on the column label.
   *
   * Not the same as `depth + 1`, and that is the whole point of sending it. An AB two
   * layers down the office is *Layer 1* of their own tree, because AC-1 says layer one
   * is you. Computing it here keeps one coordinate frame: a client that subtracted its
   * own root's depth would be a second one, and the two disagree the moment a projection
   * has roots at different depths.
   */
  layer: number;
  leaderId: string | null;
  directCount: number;
  /**
   * The direct reports split by role.
   *
   * The prototype's node writes a sentence — *"3 direct agents, 2 AAB"*
   * (`Group_Overview.html:219-228`) — not a bare number. A total alone cannot be
   * rendered as that sentence, so the split travels rather than being recomputed from a
   * second query per node.
   */
  directCounts: { ab: number; aab: number; agent: number; total: number };
  subtreeCount: number;
  /** The graph, not the role (OD-23). */
  isLeader: boolean;
  isSelf: boolean;
}

/**
 * The requester's own leader. Structurally *not* an `OrgTreeNode`, so it cannot be
 * given a layer, an edge or a click by accident — AC-1 is a type, not a CSS rule.
 */
export interface OrgTreeLeader {
  membershipId: string;
  fullName: string;
  initials: string;
  role: HierarchyRole;
}

export interface OrgTree {
  nodes: OrgTreeNode[];
  leader: OrgTreeLeader | null;
  /** Every node whose leader is not in `nodes`. Usually one; never assume one. */
  rootIds: string[];
  selfId: string | null;
  counts: { ab: number; aab: number; agent: number; total: number };
}

/**
 * A cap, not a page size.
 *
 * The office ceiling is 500 members (`performance-and-scale.md`). This refuses at four
 * times that rather than shipping a response no phone can render: a tree is not
 * paginable — a page of a tree is not a tree — so the honest failure is a refusal
 * naming the number, not a silent truncation that draws a wrong org chart.
 */
export const ORG_TREE_MAX_NODES = 2000;

/**
 * The hierarchy, read as a graph.
 *
 * **One query, one narrowing.** The nodes are whatever `visibleTo` allows — the same
 * expression the roster uses, imported rather than copied, so the office-versus-downline
 * rule in AC-2 has exactly one implementation. For a tenant admin that is the office;
 * for anybody else it is themselves plus `ancestorIds` — one indexed lookup either way.
 *
 * **The result is a forest, and that is not an edge case.** A root is any visible node
 * whose leader is not also visible. For a leader that is themselves. For an Owner it is
 * the office root *and* everybody orphaned by a removal (P3-T7 AC-3) and everybody
 * registered but not yet tagged — all of whom carry `leaderId: null`. Rooting the query
 * at the Owner instead would have hidden them: on a 500-member office, one orphaning
 * hides 51 people. So the query asks for members, and the roots fall out.
 *
 * **Flat, not nested.** `depth` is already materialised, so a layer is a subtraction
 * rather than a walk; a flat list is smaller on the wire, and the client builds whatever
 * shape it renders. Nesting would also make the response's size depend on its shape.
 */
@Injectable()
export class OrgTreeService {
  constructor(
    private readonly members: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async read(ctx: RequestContext): Promise<OrgTree> {
    const self = ctx.membershipId;

    const rows = await this.members.find(
      ctx,
      { ...visibleTo(ctx, 'org_tree:read'), status: 'active' },
      { sort: { agentSeq: 1 } },
    );

    if (rows.length > ORG_TREE_MAX_NODES) {
      throw new DomainException(
        ErrorCode.ORG_TREE_TOO_LARGE,
        `This office has ${rows.length} members, more than the tree can draw.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { count: rows.length, max: ORG_TREE_MAX_NODES },
      );
    }

    // One lookup for every name, rather than one per node.
    const named = await this.namesFor(rows.map((r) => r.userId));

    const present = new Set(rows.map((r) => String(r._id)));

    // Every root sits at layer 1, whatever its office depth. Orphaning already rewrites
    // the orphan's depth to 0 and shifts its subtree (P3-T7 via `reparent`), so an
    // admin's roots are all at 0; a leader's single root is themselves, at whatever
    // depth the office put them.
    const rootDepth = Math.min(
      ...rows
        .filter((r) => r.leaderId === null || !present.has(r.leaderId))
        .map((r) => r.depth),
    );
    const counts = { ab: 0, aab: 0, agent: 0, total: 0 };
    const nodes: OrgTreeNode[] = [];
    const rootIds: string[] = [];

    for (const row of rows) {
      const id = String(row._id);
      const fullName = named.get(row.userId)?.fullName ?? 'Unknown';
      const directCount = row.directCounts?.total ?? 0;

      // A node whose leader is outside what this requester may see is a root of *their*
      // projection. That covers the office root, an orphan, and — for a leader — the
      // leader themselves, whose own leader is above their visibility.
      if (row.leaderId === null || !present.has(row.leaderId)) rootIds.push(id);

      // The self node is excluded from the breakdown, as the prototype excludes it
      // (`Overall.html:8250-8251`): the question is how many people are *under* you.
      if (id !== self) {
        counts[row.role] += 1;
        counts.total += 1;
      }

      nodes.push({
        membershipId: id,
        fullName,
        preferredName: preferredNameOf(named.get(row.userId)?.preferredName),
        initials: initialsOf(fullName),
        agentCode: row.agentCode,
        role: row.role,
        depth: row.depth,
        layer: row.depth - rootDepth + 1,
        leaderId: row.leaderId,
        directCount,
        directCounts: {
          ab: row.directCounts?.ab ?? 0,
          aab: row.directCounts?.aab ?? 0,
          agent: row.directCounts?.agent ?? 0,
          total: directCount,
        },
        subtreeCount: row.subtreeCount ?? 0,
        isLeader: directCount > 0,
        isSelf: id === self,
      });
    }

    return {
      nodes,
      leader: await this.leaderContext(ctx, present),
      rootIds,
      selfId: self ?? null,
      counts,
    };
  }

  /**
   * The card above the tree.
   *
   * Only when the requester's own leader is *outside* the tree — which is the ego-centric
   * case. A tenant admin already sees their leader as an ordinary node, and drawing them
   * twice would be two of the same person on one screen.
   */
  private async leaderContext(
    ctx: RequestContext,
    present: Set<string>,
  ): Promise<OrgTreeLeader | null> {
    const self = ctx.membershipId;
    if (!self) return null;

    const me = await this.members.findById(ctx, self);
    if (!me?.leaderId || present.has(me.leaderId)) return null;

    const leader = await this.members.findById(ctx, me.leaderId);
    if (!leader || leader.status === 'removed') return null;

    const fullName = (await this.namesFor([leader.userId])).get(leader.userId)?.fullName ?? 'Unknown';
    return {
      membershipId: String(leader._id),
      fullName,
      initials: initialsOf(fullName),
      role: leader.role,
    };
  }

  private async namesFor(userIds: string[]) {
    if (userIds.length === 0) return new Map<string, UserDocument>();
    const found = await this.users.find({ _id: { $in: [...new Set(userIds)] } }).exec();
    return new Map(found.map((u) => [String(u._id), u]));
  }
}
