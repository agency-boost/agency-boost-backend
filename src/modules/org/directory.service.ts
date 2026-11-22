import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import {
  canManageMember, canOpenMember, isOfficeSteward, officeStewardKind, stewardsWholeOffice,
} from '@/common/auth/office-steward';
import { RequestContext, isEffectiveCoreLeader } from '@/common/context/request-context';
import { can } from '@/modules/rbac/permissions';
import { NotFoundException } from '@/common/errors/domain.exception';
import { render } from '@/common/i18n/sentence';
import { preferredNameOf } from '@/modules/users/display-name';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, MembershipDocument, MembershipStatus } from './membership.schema';
import { ORG_MESSAGES } from './org.messages';
import { rejoinedOn, type RejoinFacts } from './rejoined';
import { DIRECTORY_READ, siblingsWithinReach, visibleTo, withinReach } from './reader-visibility';
import { invitationStateOf, type InvitationState } from './invitation-state';
import {
  canChangeRoleOf, canPromoteToAbOf, DEFAULT_LADDER, readLadder, roleChoices, roleReaderOf, type LadderRung,
} from './role-rules';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { isLeaderClass, LEADER_CLASSES, type Gender, type WorkStatus } from '@/domain/constants';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { OfficeGroups } from '@/modules/reporting/office-groups';
import { NOT_A_TEST_ACCOUNT } from './counted-members';

export interface DirectoryQuery {
  q?: string;
  role?: HierarchyRole;
  status?: MembershipStatus;
  /** *★ Core leader* (P19.20-T1 AC-2): only the core leaders now — tagged, on a leader rung (ADR-0159 §1). */
  coreLeader?: boolean;
  cursor?: string;
  limit?: number;
}

/**
 * **Where a row stands among the informal groups** (P19.20-T1 AC-2; ADR-0270 §1, ADR-0273 §2): an AB's own group, an AAB's
 * or an agent's their AB's (*ikut AB …*), and whether an AB is one of its Group Leaders. Only for a steward of the KPM —
 * the people who change groups — and only on an active row.
 */
export interface DirectoryGroupPlace {
  /** The live group, or `null` — *Tanpa group*. */
  group: { groupId: string; name: string } | null;
  /** The AB whose AB group they are in — themselves for an AB — or `null` under no AB. */
  ab: { membershipId: string; name: string } | null;
  /** An AB who is one of their group's Group Leaders (ADR-0270 §2). */
  isGroupLeader: boolean;
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
  /**
   * **Their profile photo, signed** (P19.20; `DESIGN-RULES.md`, *Names*: *photo next to the name wherever a person is
   * listed*), or `null` — the row draws their initials. `users.avatarUrl`, linked by `AvatarLinks`.
   */
  photoUrl: string | null;
  /** Their informal group, for a steward reading an active row (P19.20-T1 AC-2); absent otherwise. */
  groupPlace?: DirectoryGroupPlace;
  /** A Core Leader now: tagged, on a leader rung (ADR-0159 §1). */
  isCoreLeader: boolean;
  /** This viewer may tag or untag them from the row (P18.5-T5 AC-3) — an offer, never the gate. */
  canTagCoreLeader: boolean;
  /**
   * **This viewer may open them** (ADR-0268 §1): always, but for a core leader, who sees the whole KPM and opens only
   * themselves and their downline — `read` answers the rest `404`, and the row is drawn muted with no chevron.
   */
  openable: boolean;
  joinedAt: string | null;
  /**
   * The person's **join date** in this office, an office date (ADR-0169 §1): what the person page prints as *Join
   * date*. `null` while pending. Not `joinedAt`, the system's stamp.
   */
  joinDate: string | null;
  /** Set only on a removed row. The Removed tab answers "when", which is the first thing asked. */
  removedAt: string | null;
  /**
   * **When the membership was made** — the day they registered here (P19.20-T1 AC-4: *Sudah daftar, belum masuk unit*,
   * *"daftar 4 hari lalu"*). The system's stamp, `createdAt`; `null` on a row written without one.
   */
  registeredAt: string | null;
  /**
   * **Whether they have been invited, and have signed in** (P19.12-T5 AC-4; ADR-0248 §4, `invitationStateOf`): `signed_in`
   * once the account has signed in, else `invited` when an invitation went (`invitedAt`), else `not_invited`. An
   * `active` member who has never signed in is *Diundang* or *Belum diundang* on the Directory and the member page, not
   * *Aktif*; `status` stays what it is.
   */
  invitation: InvitationState;
  /**
   * **The day the person came back to this office, if they did** (P18.9-T4 AC-3, ADR-0176 §5; `rejoinedOn` in
   * `rejoined.ts`): on a live membership that follows a removed one, its own join date — the directory's *Rejoined*;
   * on a removed membership the person has since returned from, the later one's — *Rejoined {date}* under
   * *Removed*. `null` otherwise. Read from the memberships of the same person this reader may see, so it says nothing
   * about a unit outside their reach.
   */
  rejoinedOn: string | null;

  /**
   * What **this viewer** may do to **this person** (P3.1-T13).
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
   * **The rungs this viewer may put them on**, by ladder code, junior first, their own always among them (P19.12-T4;
   * ADR-0247 §1, `roleChoices` in `role-rules.ts` — the one rule `RoleChangeService` enforces). `canChangeRole` and
   * `canPromoteToAb` are read off it, so the person page's select and the write cannot disagree.
   */
  roleChoices: string[];
  /**
   * **This viewer may change who they report to** — *Ganti* on *Melapor ke* (P19.12-T4; ADR-0247 §2): they hold
   * `member:reassign_leader`, the member is active and does not own the office, and — for a leader — reports to them
   * directly. `PUT /members/:id/leader` refuses regardless.
   */
  canChangeLeader: boolean;
  /**
   * **This viewer may change their details in the member sheet** (P19.20-T2 AC-2; ADR-0273 §3): they hold
   * `member:complete_personal` and may manage them — the Owner, an Admin and the Super Admin inside the KPM anybody who
   * has not left, a core leader somebody strictly below them (`canManageMember`). An offer: `PATCH …/personal` refuses
   * regardless.
   */
  canEditDetails: boolean;

  /**
   * **What the person records** (ADR-0158 §6, P18.5-T4 AC-6): on **one member's read** —
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
  /**
   * **Their WhatsApp number** (P19.12-T5 AC-2; ADR-0248 §2), as stored — `+62` and its digits — or `null`: the account's,
   * the number they see on their own profile. To the same three readers as the four above.
   */
  phone: string | null;
  /**
   * **The office's company, by name** (ADR-0205 §4, OWN UI-025): what *Bergabung di <company>* names beside
   * `companyJoinMonth` — *Bergabung di Prudential*. `null` for an office with no company, or a company since removed.
   */
  companyName: string | null;
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

/** *Search agent*'s list (UI V1; UI-012, D-14): ten people unless asked for fewer or more, and never more than twenty. */
export const MEMBER_SEARCH_DEFAULT = 10;
export const MEMBER_SEARCH_MAX = 20;

/**
 * **One person *Search agent* offers** (UI V1, 2026-10-30; UI-012, UI-059, the owner's D-14): the NAME on the left, the
 * agent code on the right, and the membership the pick opens (`/coaching/{membershipId}/summary`). Nothing else — no
 * email, no leader, no counts — so the read records no disclosure, as the org tree, which shows the same, records none.
 */
export interface MemberSearchHit {
  membershipId: string;
  fullName: string;
  preferredName: string | null;
  agentCode: string | null;
  role: HierarchyRole;
  orgLevelCode: string;
}

/** Which of a user's fields a search reads: the roster's three, or *Search agent*'s name alone (its code is the membership's). */
type NameFields = readonly ('fullName' | 'preferredName' | 'email')[];
const ROSTER_SEARCH: NameFields = ['fullName', 'email'];
const PICKER_SEARCH: NameFields = ['fullName', 'preferredName'];

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
    /*
     * The office's company, for one field on one member's read: `personal.companyName` (ADR-0205 §4). Optional so the
     * specs that build this service by hand for the roster need not say it; without it the name is `null`.
     */
    @Optional() @InjectModel(Company.name) private readonly companies: Model<CompanyDocument> | null = null,
    /*
     * The company's ladder, for `roleChoices` (P19.12-T4, ADR-0247 §1). Optional for the specs that build this service
     * by hand; without it the default ladder is read.
     */
    @Optional() @Inject(OrgLevelService) private readonly orgLevels: OrgLevelService | null = null,
    /*
     * **Each photo as a signed link** (P19.20; `users.avatarUrl` holds a storage key and the bucket is private), as the
     * Org tree signs them. Optional: without it every row draws its initials, never a key.
     */
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
    /*
     * **The KPM's informal groups, read once for a page** (P19.20-T1 AC-2; ADR-0270 §1): each row's group chip and *Group
     * Leader*. Optional for the specs that build this service by hand; without it no row carries `groupPlace`.
     */
    @Optional() @Inject(OfficeGroups) private readonly officeGroups: OfficeGroups | null = null,
  ) {}

  /** The office's ladder, junior first, with each rung's class (`role-rules.ts`). */
  private async ladder(ctx: RequestContext): Promise<readonly LadderRung[]> {
    if (!ctx.kpmId || !this.orgLevels) return DEFAULT_LADDER;
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).select('companyId').exec();
    return kpm?.companyId ? readLadder(this.orgLevels, kpm.companyId) : DEFAULT_LADDER;
  }

  /** The office's company's name, or `null` (ADR-0205 §4: *Bergabung di <company>*). */
  private async companyName(ctx: RequestContext): Promise<string | null> {
    if (!ctx.kpmId || !this.companies) return null;
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).select('companyId').exec();
    if (!kpm?.companyId) return null;
    const company = await this.companies.findOne({ _id: kpm.companyId, deletedAt: null }).select('name').lean().exec();
    return (company as { name?: string } | null)?.name ?? null;
  }

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
    // **Never a test account** (P19.20-T1 AC-2; ADR-0267 §1): not listed and not counted on any tab.
    const filter: FilterQuery<MembershipDocument> = { ...visibleTo(ctx, DIRECTORY_READ), ...NOT_A_TEST_ACCOUNT };
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
    // *★ Core leader* (P19.20-T1 AC-2): the effective flag — tagged, on a leader rung (`isEffectiveCoreLeader`).
    if (query.coreLeader) {
      filter.isCoreLeader = true;
      if (!query.role) filter.role = { $in: [...LEADER_CLASSES] };
    }

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
    const visible = { ...visibleTo(ctx, DIRECTORY_READ), ...NOT_A_TEST_ACCOUNT };
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
   * **Search agent** (UI V1, 2026-10-30; UI-012, UI-059, the owner's D-14): the people this reader may see, by part of a
   * name or an agent code, for a picker that opens the one chosen.
   *
   * - **Narrowed as the roster is** (`visibleTo`, `reader-visibility.ts`): a tenant admin the office, an AB their
   *   downline, an AAB their own unit's subtree, an Agent only themselves — and **never the reader**, whose own page is
   *   not somebody to look up, so an Agent finds nobody. Active members only: the picker opens a person's page now.
   * - **Name or agent code, nothing else**: the roster's search also reads the email, which the picker never shows.
   * - **A to Z by name**, then by code, the first `limit`. Every match in reach is read and sorted here, because the
   *   name is on the global user and the reach on the membership; a reader's reach is their office at most.
   * - **No disclosure recorded**: names and codes only, what the org tree shows, which records none either.
   */
  async search(ctx: RequestContext, query: { q?: string; limit?: number } = {}): Promise<MemberSearchHit[]> {
    const limit = Math.min(Math.max(query.limit ?? MEMBER_SEARCH_DEFAULT, 1), MEMBER_SEARCH_MAX);
    // Under `$and`, never spread: the narrowing for an Agent is `{ _id: self }`, which would collide with the `$ne`.
    const filter = await this.byName(
      // Never a test account (ADR-0267 §1): a picker is a list.
      { $and: [visibleTo(ctx, DIRECTORY_READ), { _id: { $ne: ctx.membershipId ?? null }, status: 'active', ...NOT_A_TEST_ACCOUNT }] },
      query.q,
      PICKER_SEARCH,
    );
    const rows = await this.members.find(ctx, filter, {
      projection: { userId: 1, agentCode: 1, role: 1, orgLevelCode: 1 },
    });
    if (rows.length === 0) return [];

    const users = await this.users
      .find({ _id: { $in: rows.map((r) => r.userId) } })
      .select('fullName preferredName')
      .exec();
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    return rows
      .map((m): MemberSearchHit => {
        const user = byUser.get(m.userId);
        return {
          membershipId: String(m._id),
          fullName: user?.fullName ?? '',
          preferredName: preferredNameOf(user?.preferredName),
          agentCode: m.agentCode ?? null,
          role: m.role,
          orgLevelCode: m.orgLevelCode,
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'id', { sensitivity: 'base' })
        || (a.agentCode ?? '').localeCompare(b.agentCode ?? ''))
      .slice(0, limit);
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
    fields: NameFields = ROSTER_SEARCH,
  ): Promise<FilterQuery<MembershipDocument>> {
    const term = q?.trim();
    if (!term) return filter;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matching = await this.users
      .find({ $or: fields.map((name) => ({ [name]: new RegExp(escaped, 'i') })) })
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
    const ladder = await this.ladder(ctx);
    const [returns, photos, places] = await Promise.all([
      this.returnsOf(ctx, rows),
      this.avatarLinks ? this.avatarLinks.linksFor(users.map((u) => u.avatarUrl)) : Promise.resolve(new Map<string, string>()),
      this.groupPlaces(ctx, rows),
    ]);
    return rows.map((m) => {
      const place = places.get(String(m._id));
      return {
        ...this.present(m, byUser.get(m.userId), leaderName.get(m.leaderId ?? '') ?? null, ctx, owner, ladder),
        photoUrl: photos.get(byUser.get(m.userId)?.avatarUrl ?? '') ?? null,
        ...(place ? { groupPlace: place } : {}),
        rejoinedOn: rejoinedOn(rejoinFacts(m), returns.get(m.userId) ?? []),
      };
    });
  }

  /**
   * **Each active row's informal group** (P19.20-T1 AC-2; ADR-0270 §1): the partition's two reads of the KPM, and one of
   * the accounts of the ABs the rows follow, for *ikut AB …*. Only for a steward — the people who change groups; a
   * leader's read of their unit carries none. Test accounts are in no group (`OfficeGroups`).
   */
  private async groupPlaces(ctx: RequestContext, rows: MembershipDocument[]): Promise<Map<string, DirectoryGroupPlace>> {
    const out = new Map<string, DirectoryGroupPlace>();
    const active = rows.filter((m) => m.status === 'active');
    if (!this.officeGroups || active.length === 0 || !isOfficeSteward(ctx)) return out;
    const partition = await this.officeGroups.partition(ctx);
    const { placement } = partition;
    const groupName = new Map(partition.groups.map((g) => [g.groupId, g.name]));
    const abIds = [...new Set(active.map((m) => placement.abOf.get(String(m._id))).filter((id): id is string => !!id))];
    const abUsers = abIds.map((id) => partition.members.get(id)?.userId).filter((id): id is string => !!id);
    const named = abUsers.length
      ? await this.users.find({ _id: { $in: [...new Set(abUsers)] } }).select('fullName').exec()
      : [];
    const nameOfUser = new Map(named.map((u) => [String(u._id), u.fullName]));
    for (const m of active) {
      const id = String(m._id);
      const ab = placement.abOf.get(id) ?? null;
      const groupId = ab ? placement.groupOfAb.get(ab) ?? null : null;
      const abUser = ab ? partition.members.get(ab)?.userId ?? null : null;
      out.set(id, {
        group: groupId ? { groupId, name: groupName.get(groupId) ?? '' } : null,
        ab: ab ? { membershipId: ab, name: (abUser && nameOfUser.get(abUser)) || render(ORG_MESSAGES.unknownName, ctx.reader) } : null,
        isGroupLeader: ab === id && groupId !== null && (placement.leadersOf.get(groupId) ?? []).includes(id),
      });
    }
    return out;
  }

  /**
   * **Every membership of these people in this office that the reader may see** (P18.9-T4 AC-3), in one query and
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
    ctx: RequestContext,
    ownerUserId: string | null,
    ladder: readonly LadderRung[] = DEFAULT_LADDER,
  ): Omit<DirectoryMember, 'rejoinedOn' | 'photoUrl' | 'groupPlace'> {
    // A person whose account is gone is still named, in the reader's language (P18.10-T5 AC-4).
    const fullName = user?.fullName ?? render(ORG_MESSAGES.unknownName, ctx.reader);
    // The Super Admin inside the KPM is its Owner (ADR-0268 §3); a core leader is not the office here but where they open.
    const tenantAdmin = ctx !== undefined && stewardsWholeOffice(ctx);
    const inReach = { membershipId: String(m._id), ancestorIds: m.ancestorIds };
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
      // The row's control (P18.5-T5 AC-3): the viewer may tag, and the member leads by rung and has not left.
      // `GroupService.setCoreLeader` refuses regardless.
      canTagCoreLeader: !removed && isLeaderClass(m.role) && ctx !== undefined && can(ctx, 'member:tag_core_leader'),
      openable: ctx === undefined || officeStewardKind(ctx) !== 'core_leader' || canOpenMember(ctx, inReach),
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
      joinDate: m.joinDate ?? null,
      removedAt: m.removedAt ? m.removedAt.toISOString() : null,
      registeredAt: (m as unknown as { createdAt?: Date }).createdAt?.toISOString() ?? null,
      // ADR-0248 §4: a first sign-in decides it; before one, whether an invitation went.
      invitation: invitationStateOf(user?.lastLoginAt, m.invitedAt),
      // The rung and the leader by the rules the writes enforce (`role-rules.ts`, ADR-0247), never a copy of them;
      // removal mirrors `RemovalService.remove`. A refusal the screen did not anticipate is a worse experience than a
      // control that was never offered — but the service is still the gate.
      ...this.rungAndLeaderOffers(m, ctx, isOwner, ladder, tenantAdmin, isDirectLeader),
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
      canEditDetails: !removed && ctx !== undefined && can(ctx, 'member:complete_personal') && canManageMember(ctx, inReach),
    };
  }

  /**
   * **What this viewer may change about where this person stands** (P19.12-T4; ADR-0247 §1–§2): their rung, by the one
   * rule `RoleChangeService` enforces (`roleChoices`), and their leader, as `LeaderChangeService` decides it — the Owner
   * and an Admin anybody active but the office's owner, a leader their direct reports. Offers only; the writes refuse
   * regardless.
   */
  private rungAndLeaderOffers(
    m: MembershipDocument,
    ctx: RequestContext,
    isOwner: boolean,
    ladder: readonly LadderRung[],
    office: boolean,
    isDirectLeader: boolean,
  ): Pick<DirectoryMember, 'roleChoices' | 'canChangeRole' | 'canPromoteToAb' | 'canChangeLeader'> {
    // ADR-0268 §1: a core leader decides as the office for somebody below them.
    const roleChoicesOf = roleChoices(roleReaderOf(ctx, { membershipId: String(m._id), ancestorIds: m.ancestorIds }), {
      leaderId: m.leaderId, role: m.role, orgLevelCode: m.orgLevelCode, status: m.status, isOwner,
    }, ladder);
    return {
      roleChoices: roleChoicesOf,
      canChangeRole: canChangeRoleOf(roleChoicesOf),
      canPromoteToAb: canPromoteToAbOf(roleChoicesOf, ladder),
      canChangeLeader: m.status === 'active' && !isOwner && String(m._id) !== ctx.membershipId
        && (office || isDirectLeader || canManageBelow(ctx, m)) && can(ctx, 'member:reassign_leader'),
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

    // ADR-0158 §6: the Owner, the Admins and the person — never a leader, whose read of their unit stops here. *Since
    // ADR-0268 §1, §3:* every steward — the Super Admin inside the KPM, and a core leader, whose reach `withinReach` has
    // already narrowed to their downline.
    const office = isOfficeSteward(ctx);
    if (!office && String(scoped._id) !== ctx.membershipId) return decorated;
    return { ...decorated, personal: await this.personalOf(ctx, scoped) };
  }

  /**
   * **A member as the roster shows them**, never opened (ADR-0268 §1): the reader may see them — a core leader sees the
   * whole KPM — and the answer is `list`'s row, `openable` saying whether they may go further, without the personal data
   * `read` adds. What a core leader is answered after moving somebody out of their own downline. `404` beyond sight.
   */
  async readListed(ctx: RequestContext, membershipId: string): Promise<DirectoryMember> {
    const seen = await this.members.findOne(ctx, { $and: [{ _id: membershipId }, visibleTo(ctx, DIRECTORY_READ)] });
    if (!seen) throw new NotFoundException('Membership');
    const [decorated] = await this.decorate(ctx, [seen]);
    return decorated;
  }

  /**
   * **What a person records, and their WhatsApp number** (ADR-0158 §6; P19.12-T5 AC-2, ADR-0248 §2): the account's four
   * and its number, the membership's work status, and the office's company by name. The caller has decided the reader
   * may see them — `read` above, and `MemberPersonalService` answering the Owner's or an Admin's *Lengkapi data*.
   */
  async personalOf(ctx: RequestContext, membership: MembershipDocument): Promise<MemberPersonal> {
    const [user, companyName] = await Promise.all([
      this.users.findOne({ _id: membership.userId }).select('dateOfBirth gender companyJoinMonth phone').exec(),
      this.companyName(ctx),
    ]);
    return {
      dateOfBirth: user?.dateOfBirth ?? null,
      gender: user?.gender ?? null,
      companyJoinMonth: user?.companyJoinMonth ?? null,
      workStatus: membership.workStatus ?? null,
      // An empty string on file is no number (`MemberPhoneService` reads it the same way).
      phone: user?.phone || null,
      companyName,
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

/** **A core leader moves somebody below them as the office would** (ADR-0268 §1): `LeaderChangeService`'s rule, offered. */
function canManageBelow(ctx: RequestContext, m: MembershipDocument): boolean {
  return officeStewardKind(ctx) === 'core_leader'
    && canManageMember(ctx, { membershipId: String(m._id), ancestorIds: m.ancestorIds });
}
