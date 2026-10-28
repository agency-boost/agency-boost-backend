import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext, isEffectiveCoreLeader } from '@/common/context/request-context';
import { can } from '@/modules/rbac/permissions';
import { NotFoundException } from '@/common/errors/domain.exception';
import { preferredNameOf } from '@/modules/users/display-name';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, MembershipDocument, MembershipStatus } from './membership.schema';
import { rejoinedOn, type RejoinFacts } from './rejoined';
import { DIRECTORY_READ, siblingsWithinReach, visibleTo, withinReach } from './reader-visibility';
import { isLeaderClass, type Gender, type WorkStatus } from '@/domain/constants';

export interface DirectoryQuery {
  q?: string;
  role?: HierarchyRole;
  status?: MembershipStatus;
  cursor?: string;
  limit?: number;
}

export interface DirectoryMember {
  membershipId: string;
  agentCode: string;
  role: HierarchyRole;
  /** The rung, by its ladder code; `role` is the class it gives (ADR-0156). The person page's role select reads it. */
  orgLevelCode: string;
  status: MembershipStatus;
  fullName: string;
  preferredName: string | null;
  email: string;
  initials: string;
  leaderId: string | null;
  leaderName: string | null;
  depth: number;
  directCount: number;
  subtreeCount: number;
  isLeader: boolean;
  isKpmOwner: boolean;
  isKpmAdmin: boolean;
  /** A Core Leader now: tagged, on a leader rung (ADR-0159 §1). */
  isCoreLeader: boolean;
  /** This viewer may tag or untag them from the row (P18.8-T5 AC-3) — an offer, never the gate. */
  canTagCoreLeader: boolean;
  joinedAt: string | null;
  /**
   * The person's **join date** in this office, an office date (ADR-0169 §1): what the person page prints as *Join
   * date*. `null` while pending. Not `joinedAt`, the system's stamp.
   */
  joinDate: string | null;
  /** Set only on a removed row. The Removed tab answers "when", which is the first thing asked. */
  removedAt: string | null;
  /**
   * **The day the person came back to this office, if they did** (P18.97-T4 AC-3, ADR-0176 §5; `rejoinedOn` in
   * `rejoined.ts`): on a live membership that follows a removed one, its own join date — the directory's *Rejoined*;
   * on a removed membership the person has since returned from, the later one's — *Rejoined {date}* under
   * *Removed*. `null` otherwise. Read from the memberships of the same person this reader may see, so it says nothing
   * about a unit outside their reach.
   */
  rejoinedOn: string | null;

  /**
   * What **this viewer** may do to **this person** (P3.5-T13).
   *
   * Sent rather than inferred, for the reason `TeamMember.canChangeRole` already gives:
   * these are server rules, and a screen carrying a second copy of them is a screen that
   * can drift. Three flags rather than one because the permission matrix has three rows —
   * Agent⇄AAB is a direct leader's call, anything involving AB is the office's, and
   * removal has its own refusals. On a leader's own team the three collapse; on a person
   * page, where an Owner sees the whole office, they do not.
   *
   * The API refuses regardless. These decide what is *offered*, never what is *allowed*.
   */
  canChangeRole: boolean;
  canPromoteToAb: boolean;
  canRemove: boolean;

  /**
   * **What the person records** (ADR-0158 §6, P18.8-T4 AC-6): on **one member's read** —
   * `GET /members/:membershipId`, the person page's *Personal* card — and only to the office's
   * Owner, its Admins, or the person themselves. Absent from every other read: the roster's rows,
   * a leader's read of somebody in their unit, the reports list. A `null` inside is *Not recorded*.
   */
  personal?: MemberPersonal;
}

/** A member's birth date, gender, company join month and work status, as the person page shows them. */
export interface MemberPersonal {
  dateOfBirth: string | null;
  gender: Gender | null;
  companyJoinMonth: string | null;
  workStatus: WorkStatus | null;
}

export interface DirectoryPage {
  members: DirectoryMember[];
  nextCursor: string | null;
  /**
   * How many are in each tab, within what this requester may see.
   *
   * The prototype labels its tabs `Directory (187)`, `Pending (14)`, `Removed (3)`
   * (`KPM_Owner.html:1822-1824`). A count that only reflected the current page would be
   * wrong on every page but the last, so these are counted, not measured from `members`.
   */
  counts: { directory: number; pending: number; removed: number };
}

export const DIRECTORY_PAGE_SIZE = 25;
export const DIRECTORY_MAX_PAGE_SIZE = 100;

/**
 * Avatar initials.
 *
 * Exported so the whitespace case can be tested directly: `users.fullName` is required
 * and trimmed, so a blank name cannot be written through the schema today. The guard
 * stays because a future import will not go through the schema, and an avatar is not
 * worth a crash.
 */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  return (parts[0][0] + (parts[parts.length - 1][0] ?? '')).toUpperCase();
}

/**
 * The office roster.
 *
 * Scoped twice. The repository injects `kpmId`, which is the hard boundary; on top of
 * that a leader sees their own downline and a tenant admin sees the whole office. A
 * peer's unit is never reachable, and that second narrowing happens here rather than in
 * a screen — a filter applied only in the UI is not a filter.
 */
@Injectable()
export class DirectoryService {
  constructor(
    private readonly members: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    // The office, for one field: `kpms.ownerUserId`. Ownership is not on the membership
    // — `ContextResolver` derives `isKpmOwner` by comparing the two — so a roster that
    // wants to say who owns the office has to make the same join.
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
  ) {}

  /** The office's owner, as a user id. Null for an office nobody administers yet. */
  private async ownerUserId(ctx: RequestContext): Promise<string | null> {
    if (!ctx.kpmId) return null;
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec();
    return kpm?.ownerUserId ?? null;
  }

  async list(ctx: RequestContext, query: DirectoryQuery = {}): Promise<DirectoryPage> {
    const limit = Math.min(Math.max(query.limit ?? DIRECTORY_PAGE_SIZE, 1), DIRECTORY_MAX_PAGE_SIZE);

    // What this requester may see (`reader-visibility.ts`): a tenant admin the office, below that the scope
    // `DIRECTORY_READ` grants. Spread, because no key of a narrowing is one this page adds; a filter that names an id
    // goes through `withinReach` instead.
    const filter: FilterQuery<MembershipDocument> = { ...visibleTo(ctx, DIRECTORY_READ) };
    // **Active only.** The roster's question is who is here now, and somebody still
    // waiting for a leader is not here yet — they have registered, nothing more.
    //
    // This used to be `$ne: 'removed'`, which put pending members in the Directory *and*
    // counted them under Pending: the same person on two tabs, and a Directory count that
    // disagreed with its own rows by exactly the number of them. The three tabs are
    // disjoint populations, as the prototype's `Directory (187) · Pending (14) ·
    // Removed (3)` implies, and each count now counts what its tab shows.
    filter.status = query.status ?? 'active';
    if (query.role) filter.role = query.role;

    // Cursor rather than offset: an offset skips a row whenever someone joins
    // mid-scroll. The key is the numeric sequence, not the code — the code sorts wrong
    // at four digits, and a cursor on a wrongly-sorted key skips rows silently.
    const after = query.cursor === undefined ? null : Number(query.cursor);
    if (after !== null && Number.isFinite(after)) filter.agentSeq = { $gt: after };

    const matched = await this.byName(filter, query.q);
    const rows = await this.members.find(ctx, matched, {
      sort: { agentSeq: 1 },
      limit: limit + 1,
    });

    const page = rows.slice(0, limit);
    const visible = visibleTo(ctx, DIRECTORY_READ);
    const [directory, pending, removed] = await Promise.all([
      this.members.count(ctx, { ...visible, status: 'active' }),
      this.members.count(ctx, { ...visible, status: 'pending' }),
      this.members.count(ctx, { ...visible, status: 'removed' }),
    ]);

    return {
      members: await this.decorate(ctx, page),
      nextCursor: rows.length > limit ? String(page[page.length - 1].agentSeq) : null,
      // Unfiltered by the search term on purpose: the tab says how many are in that
      // tab, not how many match what you have typed into a different one.
      counts: { directory, pending, removed },
    };
  }

  /**
   * Search spans two collections: the agent code is on the membership, the name and
   * email are on the global user. Resolving the user side first keeps the membership
   * query a single indexed lookup instead of a `$lookup` that would have to be checked
   * for a `kpmId` match of its own.
   */
  private async byName(
    filter: FilterQuery<MembershipDocument>,
    q?: string,
  ): Promise<FilterQuery<MembershipDocument>> {
    const term = q?.trim();
    if (!term) return filter;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matching = await this.users
      .find({ $or: [{ fullName: new RegExp(escaped, 'i') }, { email: new RegExp(escaped, 'i') }] })
      .select('_id')
      .exec();

    return {
      ...filter,
      $and: [
        ...(filter.$and ?? []),
        {
          $or: [
            { agentCode: new RegExp(escaped, 'i') },
            { userId: { $in: matching.map((u) => String(u._id)) } },
          ],
        },
      ],
    };
  }

  /** Join the identity side, and the leader's name, in two queries rather than N. */
  private async decorate(
    ctx: RequestContext,
    rows: MembershipDocument[],
  ): Promise<DirectoryMember[]> {
    if (rows.length === 0) return [];

    const users = await this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).exec();
    const byUser = new Map(users.map((u) => [String(u._id), u]));

    const leaderIds = [...new Set(rows.map((r) => r.leaderId).filter((id): id is string => !!id))];
    const leaders = leaderIds.length ? await this.members.find(ctx, { _id: { $in: leaderIds } }) : [];
    const leaderUsers = leaders.length
      ? await this.users.find({ _id: { $in: leaders.map((l) => l.userId) } }).exec()
      : [];
    const leaderName = new Map(
      leaders.map((l) => [
        String(l._id),
        leaderUsers.find((u) => String(u._id) === l.userId)?.fullName ?? null,
      ]),
    );

    const owner = await this.ownerUserId(ctx);
    const returns = await this.returnsOf(ctx, rows);
    return rows.map((m) => ({
      ...this.present(m, byUser.get(m.userId), leaderName.get(m.leaderId ?? '') ?? null, ctx, owner),
      rejoinedOn: rejoinedOn(rejoinFacts(m), returns.get(m.userId) ?? []),
    }));
  }

  /**
   * **Every membership of these people in this office that the reader may see** (P18.97-T4 AC-3), in one query and
   * whatever their state, by person — what `rejoinedOn` reads to say who came back. Narrowed as the page was
   * (`siblingsWithinReach`), so a leader's roster says nothing of a membership outside their unit.
   */
  private async returnsOf(ctx: RequestContext, rows: MembershipDocument[]): Promise<Map<string, RejoinFacts[]>> {
    const siblings = await this.members.find(
      ctx,
      siblingsWithinReach(ctx, rows.map((r) => r.userId)),
      { projection: { userId: 1, status: 1, joinDate: 1, joinedAt: 1, createdAt: 1 } },
    );
    const out = new Map<string, RejoinFacts[]>();
    for (const sibling of siblings) out.set(sibling.userId, [...(out.get(sibling.userId) ?? []), rejoinFacts(sibling)]);
    return out;
  }

  private present(
    m: MembershipDocument,
    user: UserDocument | undefined,
    leaderNameValue: string | null,
    ctx?: RequestContext,
    ownerUserId?: string | null,
  ): Omit<DirectoryMember, 'rejoinedOn'> {
    const fullName = user?.fullName ?? 'Unknown';
    const tenantAdmin = Boolean(ctx?.membership?.isKpmOwner || ctx?.membership?.isKpmAdmin);
    const isDirectLeader = Boolean(ctx?.membershipId) && m.leaderId === ctx?.membershipId;
    const removed = m.status === 'removed';
    // **This used to be hardcoded `false`**, so the roster's `Owner` tag — gated on it —
    // could never appear. It is also what stops an Admin removing the person who owns the
    // office and leaving it with no working administration.
    const isOwner = Boolean(ownerUserId) && m.userId === ownerUserId;
    return {
      membershipId: String(m._id),
      agentCode: m.agentCode,
      role: m.role,
      orgLevelCode: m.orgLevelCode,
      status: m.status,
      fullName,
      preferredName: preferredNameOf(user?.preferredName),
      email: user?.email ?? '',
      initials: initialsOf(fullName),
      leaderId: m.leaderId,
      leaderName: leaderNameValue,
      depth: m.depth,
      directCount: m.directCounts?.total ?? 0,
      subtreeCount: m.subtreeCount ?? 0,
      // Leadership is a graph property, not a role (OD-23). An AAB with no reports
      // leads nobody, and every surface gated on this is asking about people you lead.
      isLeader: (m.directCounts?.total ?? 0) > 0,
      isKpmOwner: isOwner,
      isKpmAdmin: m.adminAccess?.isKpmAdmin ?? false,
      // ADR-0159 §1: the effective flag — the tag on a leader rung — which is what the row's chip says.
      isCoreLeader: isEffectiveCoreLeader(m),
      // The row's control (P18.8-T5 AC-3): the viewer may tag, and the member leads by rung and has not left.
      // `GroupService.setCoreLeader` refuses regardless.
      canTagCoreLeader: !removed && isLeaderClass(m.role) && ctx !== undefined && can(ctx, 'member:tag_core_leader'),
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
      joinDate: m.joinDate ?? null,
      removedAt: m.removedAt ? m.removedAt.toISOString() : null,
      // Mirrors `RoleChangeService.permitted` and `RemovalService.remove`, which are
      // where these are actually enforced. A refusal the screen did not anticipate is a
      // worse experience than a control that was never offered, so they are computed the
      // same way — but the service is still the gate.
      // The Owner's rung is not the office's to change: demoting them from AB would
      // strip the rights that come with owning it, and only the platform can reassign an
      // office. `RoleChangeService` refuses it too.
      canChangeRole: !removed && !isOwner && (tenantAdmin || isDirectLeader),
      canPromoteToAb: !removed && !isOwner && tenantAdmin,
      canRemove:
        !removed &&
        // Not the office's owner. Normally they are also the root, but after a transfer
        // to somebody who was already a member they keep their old leader — and then
        // nothing else here would stop an Admin removing them.
        !isOwner &&
        // Not yourself, and not the office's root — it has no leader, so removing it
        // would leave the whole office pointing at nothing.
        String(m._id) !== ctx?.membershipId &&
        m.leaderId !== null &&
        (tenantAdmin || isDirectLeader),
    };
  }

  /**
   * One level down, decorated in the same two queries as a page of the roster.
   *
   * Reading each report through `read()` would be 2N queries and would re-check a
   * visibility narrowing the parent already passed — everyone below someone you can see
   * is someone you can see.
   */
  async reportsOf(ctx: RequestContext, membershipId: string): Promise<DirectoryMember[]> {
    await this.read(ctx, membershipId);
    // Narrowed again rather than trusting the parent check. "Everyone below someone you
    // can see is someone you can see" holds for a leader, whose filter is a subtree — it
    // does not hold at `own`, where the only visible id is your own and the people under
    // it are precisely the ones you may not read.
    const rows = await this.members.find(
      ctx,
      withinReach(ctx, { leaderId: membershipId, status: { $ne: 'removed' } }),
      { sort: { agentSeq: 1 } },
    );
    return this.decorate(ctx, rows);
  }

  async read(ctx: RequestContext, membershipId: string): Promise<DirectoryMember> {
    // `$and`, not a spread (`withinReach`). The narrowing for `own` is `{ _id: self }`, which is
    // the one filter shape that collides with the id being asked for — spread second, it
    // replaced the id and the read answered about the caller while claiming to be about
    // somebody else. Under `$and` a colliding narrowing can only ever match nothing.
    const scoped = await this.members.findOne(ctx, withinReach(ctx, { _id: membershipId }));
    // 404 rather than 403 for someone outside your scope: a 403 would confirm they
    // exist, which is the same leak the cross-tenant rule closes.
    if (!scoped) throw new NotFoundException('Membership');
    const [decorated] = await this.decorate(ctx, [scoped]);

    // ADR-0158 §6: the Owner, the Admins and the person — never a leader, whose read of their unit stops here.
    const office = Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
    if (!office && String(scoped._id) !== ctx.membershipId) return decorated;
    const user = await this.users
      .findOne({ _id: scoped.userId })
      .select('dateOfBirth gender companyJoinMonth')
      .exec();
    return {
      ...decorated,
      personal: {
        dateOfBirth: user?.dateOfBirth ?? null,
        gender: user?.gender ?? null,
        companyJoinMonth: user?.companyJoinMonth ?? null,
        workStatus: scoped.workStatus ?? null,
      },
    };
  }
}

/** What `rejoinedOn` reads of a membership: begun when it was made active, else when it was made. */
function rejoinFacts(m: MembershipDocument): RejoinFacts {
  const made = (m as unknown as { createdAt?: Date }).createdAt;
  return {
    id: String(m._id),
    userId: m.userId,
    status: m.status,
    joinDate: m.joinDate ?? null,
    startedAt: m.joinedAt ?? made ?? new Date(0),
  };
}
