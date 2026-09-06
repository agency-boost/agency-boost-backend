import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Permission, scopeFor } from '@/modules/rbac/permissions';
import { NotFoundException } from '@/common/errors/domain.exception';
import { User, UserDocument } from '@/modules/users/user.schema';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, MembershipDocument, MembershipStatus } from './membership.schema';

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
  joinedAt: string | null;
  /** Set only on a removed row. The Removed tab answers "when", which is the first thing asked. */
  removedAt: string | null;
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
  permission: Permission = 'member:read_profile',
): FilterQuery<MembershipDocument> {
  if (ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin || ctx.isSuperAdmin) return {};
  const self = ctx.membershipId;
  if (!self) return { _id: null };

  switch (scopeFor(ctx, permission)) {
    case 'all':
    case 'own-kpm':
      return {};
    // `ancestorIds` makes the downline arm a single indexed lookup on
    // `(kpmId, ancestorIds, status)`.
    //
    // Both tokens land here: see the note above on rules 1 and 2. A leader reads their
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
  ) {}

  /**
   * What this requester may see.
   *
   * A tenant admin — Owner or KPM Admin — sees everyone. Below that it is the scope
   * `member:read_profile` grants — the permission the roster route is gated on, and
   * documented at the same scopes as `member:list_directory`: an AB their downline, an AAB their own unit. Both
   * arms are an `$or` so an indexed lookup still does the work.
   */
  private visibility(ctx: RequestContext): FilterQuery<MembershipDocument> {
    return visibleTo(ctx, 'member:read_profile');
  }

  async list(ctx: RequestContext, query: DirectoryQuery = {}): Promise<DirectoryPage> {
    const limit = Math.min(Math.max(query.limit ?? DIRECTORY_PAGE_SIZE, 1), DIRECTORY_MAX_PAGE_SIZE);

    const filter: FilterQuery<MembershipDocument> = { ...this.visibility(ctx) };
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
    const visible = this.visibility(ctx);
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

    return rows.map((m) => this.present(m, byUser.get(m.userId), leaderName.get(m.leaderId ?? '') ?? null));
  }

  private present(
    m: MembershipDocument,
    user: UserDocument | undefined,
    leaderNameValue: string | null,
  ): DirectoryMember {
    const fullName = user?.fullName ?? 'Unknown';
    return {
      membershipId: String(m._id),
      agentCode: m.agentCode,
      role: m.role,
      status: m.status,
      fullName,
      preferredName: user?.preferredName ?? null,
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
      isKpmOwner: false,
      isKpmAdmin: m.adminAccess?.isKpmAdmin ?? false,
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
      removedAt: m.removedAt ? m.removedAt.toISOString() : null,
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
    const rows = await this.members.find(
      ctx,
      { leaderId: membershipId, status: { $ne: 'removed' } },
      { sort: { agentSeq: 1 } },
    );
    return this.decorate(ctx, rows);
  }

  async read(ctx: RequestContext, membershipId: string): Promise<DirectoryMember> {
    const scoped = await this.members.findOne(ctx, {
      _id: membershipId,
      ...this.visibility(ctx),
    });
    // 404 rather than 403 for someone outside your scope: a 403 would confirm they
    // exist, which is the same leak the cross-tenant rule closes.
    if (!scoped) throw new NotFoundException('Membership');
    const [decorated] = await this.decorate(ctx, [scoped]);
    return decorated;
  }
}
