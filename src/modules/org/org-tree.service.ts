import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { preferredNameOf } from '@/modules/users/display-name';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { initialsOf } from './directory.service';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole } from './membership.schema';
import { ORG_MESSAGES, ORG_REFUSALS } from './org.messages';
import { scopeFor } from '@/modules/rbac/permissions';
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
  /**
   * **Today's activity count** (UI V1, UI-059; O-5): the office's day, the total Activity Management saved for it —
   * `ActivityReadings.perPersonPerDay`, the read Home's team list takes too (UI-101). 0 when nothing was logged.
   */
  todayActivityCount: number;
  /** **Their profile photo**, when they have one (UI-059; `users.avatarUrl`, set by *Profil saya*, UI-111). */
  photoUrl: string | null;
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
    /*
     * Today's count per person (UI V1, UI-059; O-5): the activity module's seam, and the office's day. Both are
     * providers of the application; optional so a test that draws only the tree's shape builds it with the two above,
     * and then every count reads 0.
     */
    @Optional() @Inject(ActivityReadings) private readonly activity: ActivityReadings | null = null,
    @Optional() @Inject(TenantDay) private readonly days: TenantDay | null = null,
    /*
     * **Each photo as a signed link** (UI V1, UI-059, UI-111): `users.avatarUrl` holds a storage key and the bucket is
     * private, so the photos are signed here, once per photo per half day (`AvatarLinks`). Optional: without it every
     * row draws its initials, never a key.
     */
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
  ) {}

  /**
   * **`for`: a leader's Group Tree, as that leader sees it, read-only** (P19.3-T3 AC-3, AC-16; UI-152 and its Appendix D
   * row; `/group-tree/[membershipId]`). The leader and everybody below them on today's edges, the leader as the tree's
   * *self* — layer 1 — and their own leader as the card above it, exactly as their own read draws it.
   *
   * - **Reach is the reader's own** (`org_tree:read`, roles §3.4): the Owner and an Admin any active member of the
   *   office; an AB or an AAB — a Core Leader from KPM Analytics included (ADR-0159 §2 widens no hierarchy scope) —
   *   anybody in their own downline. Outside it, somebody who left, a malformed id or another office's member: **404**,
   *   indistinguishable. An Agent, whose grant is `own`, is refused **403**: nobody else's tree is theirs to read.
   * - **Nothing is written**, as the tree records nothing, and nothing in the view writes.
   */
  async read(ctx: RequestContext, forId?: string): Promise<OrgTree> {
    const subject = forId === undefined || forId === ctx.membershipId ? null : await this.subjectOf(ctx, forId);
    const self = subject ?? ctx.membershipId;

    const rows = await this.members.find(
      ctx,
      subject === null
        ? { ...visibleTo(ctx, 'org_tree:read'), status: 'active' }
        // Below a member the reader may see, inside the reader's reach by construction: every reach is downline-closed.
        : { $or: [{ _id: subject }, { ancestorIds: subject }], status: 'active' },
      { sort: { agentSeq: 1 } },
    );

    if (rows.length > ORG_TREE_MAX_NODES) {
      throw new DomainException(
        ErrorCode.ORG_TREE_TOO_LARGE,
        ORG_REFUSALS.ORG_TREE_TOO_LARGE.tooLarge({ count: rows.length }),
        HttpStatus.PAYLOAD_TOO_LARGE,
        { count: rows.length, max: ORG_TREE_MAX_NODES },
      );
    }

    // One lookup for every name, rather than one per node; one for today's counts (UI-059).
    const [named, today] = await Promise.all([
      this.namesFor(rows.map((r) => r.userId)),
      this.todayCounts(ctx, rows.map((r) => String(r._id))),
    ]);

    const present = new Set(rows.map((r) => String(r._id)));
    // A person whose account is gone is still a node, named in the reader's language (P18.10-T5 AC-4).
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);

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
    const photos = this.avatarLinks
      ? await this.avatarLinks.linksFor(rows.map((r) => named.get(r.userId)?.avatarUrl))
      : new Map<string, string>();
    const nodes: OrgTreeNode[] = [];
    const rootIds: string[] = [];

    for (const row of rows) {
      const id = String(row._id);
      const fullName = named.get(row.userId)?.fullName ?? unknown;
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
        todayActivityCount: today.get(id) ?? 0,
        photoUrl: photos.get(named.get(row.userId)?.avatarUrl ?? '') ?? null,
      });
    }

    return {
      nodes,
      leader: await this.leaderContext(ctx, present, self ?? undefined),
      rootIds,
      selfId: self ?? null,
      counts,
    };
  }

  /** `for`'s member, within the reader's reach and active, or 404; an Agent's `own` grant reaches no other tree (403). */
  private async subjectOf(ctx: RequestContext, forId: string): Promise<string> {
    const office = ctx.membership?.isKpmOwner === true || ctx.membership?.isKpmAdmin === true;
    const scope = scopeFor(ctx, 'org_tree:read');
    if (!office && (scope === null || scope === 'own')) throw new PermissionDeniedException('org_tree:read', { for: forId });
    const found = await this.members.findOne(ctx, { $and: [{ _id: forId, status: 'active' }, visibleTo(ctx, 'org_tree:read')] });
    if (!found) throw new NotFoundException('Member');
    return String(found._id);
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
    // The tree's self: the reader, or with `for` the leader whose tree it is (their own leader is the card above).
    self: string | undefined = ctx.membershipId ?? undefined,
  ): Promise<OrgTreeLeader | null> {
    if (!self) return null;

    const me = await this.members.findById(ctx, self);
    if (!me?.leaderId || present.has(me.leaderId)) return null;

    const leader = await this.members.findById(ctx, me.leaderId);
    if (!leader || leader.status === 'removed') return null;

    // Four fields and no more — no photo either (UI-059's upline row draws initials): this card is the registered
    // exception to "you see your downline only" (`multi-tenancy-and-scoping.md`), bounded on purpose.
    const fullName = (await this.namesFor([leader.userId])).get(leader.userId)?.fullName
      ?? render(ORG_MESSAGES.unknownName, ctx.reader);
    return {
      membershipId: String(leader._id),
      fullName,
      initials: initialsOf(fullName),
      role: leader.role,
    };
  }

  /**
   * **Each node's activity count today** (UI V1, UI-059; O-5): the office's day through `TenantDay` — never the
   * server's clock (invariant §9) — and the counts through `ActivityReadings.perPersonPerDay`, one query for the whole
   * tree, within the office. Only the people the tree already holds: the reader may see them, so they may see this.
   */
  private async todayCounts(ctx: RequestContext, membershipIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.activity || !this.days || membershipIds.length === 0) return out;
    const { today } = await this.days.for(ctx);
    const counts = await this.activity.perPersonPerDay(ctx, membershipIds, [today]);
    for (const [id, byDay] of counts) out.set(id, byDay.get(today) ?? 0);
    return out;
  }

  private async namesFor(userIds: string[]) {
    if (userIds.length === 0) return new Map<string, UserDocument>();
    const found = await this.users.find({ _id: { $in: [...new Set(userIds)] } }).exec();
    return new Map(found.map((u) => [String(u._id), u]));
  }
}
