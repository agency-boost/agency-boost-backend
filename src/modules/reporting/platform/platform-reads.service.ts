import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import {
  DEFAULT_TENANT_TIMEZONE, PLATFORM_READ, QUANT,
  type PlatformAccountKpmFilter, type PlatformMemberRole, type PlatformMemberStatus,
} from '@/domain/constants';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { memberAt, officeHeadcount } from '@/domain/metrics/office-headcount';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditService, type AuditEntry } from '@/modules/audit/audit.service';
import { MembershipRepository, type MembershipListRow } from '@/modules/org/membership.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { INSURERS_ONLY } from '@/modules/tenants/template-library';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { withoutTestAccounts } from '@/modules/org/counted-members';
import { daysFrom, usageStatus } from '@/domain/metrics/usage';
import type { UsageStatus } from '@/domain/constants/usage';
import { shiftMonth } from '../office-figures';
import { OfficePeople } from '../office-people';
import { PLATFORM_READS_REFUSALS } from './platform-reads.messages';
import { invitationStateOf } from '@/modules/org/invitation-state';

/** A company as a platform read names it. */
export interface CompanyRef { id: string; name: string }

/**
 * One row of *All members* (ADR-0207 §2): the listed fields, and nothing else — never an email or a phone. Since
 * P19.23-T3 (*Anggota*, ADR-0277) the row also carries the person (`userId`), their photo as a signed link, the rung's
 * class — the orange *AB* / *AAB* label — and whether the account is a test account; the phone and the email are the
 * detail's (`memberDetail`), never a row's.
 */
export interface PlatformMemberRow {
  membershipId: string;
  /** The person (`users._id`): what the test-account switch writes (P19.23-T3 AC-1). */
  userId: string;
  fullName: string;
  /** Their photo as a signed link (`AvatarLinks`), or `null`: the initials are drawn. */
  avatarUrl: string | null;
  agentCode: string;
  company: CompanyRef;
  kpm: { id: string; code: string; branch: string };
  /** `class`: the rung's class (ADR-0156) — `ab` and `aab` draw the orange label, `agent` none. */
  role: { code: string; label: string; class: 'ab' | 'aab' | 'agent'; isOwner: boolean; isAdmin: boolean };
  /** `users.testAccount` (ADR-0267 §1): listed only under *Akun tes* (OD-421), never counted. */
  testAccount: boolean;
  leader: { fullName: string } | null;
  status: PlatformMemberStatus;
  /** ADR-0212 §2's state: `signed_in` once the account has signed in, `invited` once an invitation went, else not. */
  invitation: 'invited' | 'not_invited' | 'signed_in';
  joinedOn: string | null;
  /** The last day the member logged an activity (the Overview's `lastLoggedOn`), or `null`: *"Belum pernah"*. */
  lastActiveOn: string | null;
  /**
   * ***Terakhir pakai*, read by the server** (P19.23-T3 AC-1; ADR-0267 §4): whole days from `lastActiveOn` to the KPM's
   * today, and the bucket — `recent` within `USAGE.RECENT_MAX_DAYS`, `lapsed` past it, `never` — so the pill's colour is
   * the one definition's (`usageStatus`), never a threshold of the page's own.
   */
  lastActive: { days: number | null; status: UsageStatus };
}

export interface PlatformMembersPage {
  rows: PlatformMemberRow[];
  page: number;
  pageSize: number;
  total: number;
  /** How many KPMs the matched memberships are in: *Anggota*'s *"n anggota di m KPM"* (P19.23-T3 AC-1). */
  kpmCount: number;
}

export interface PlatformMembersQuery {
  companyId?: string;
  kpmId?: string;
  role?: PlatformMemberRole;
  status?: PlatformMemberStatus;
  q?: string;
  page?: number;
  /**
   * **`only`: the test accounts alone** (P19.23-T3 AC-1; OD-421): *Semua status*' *Akun tes*. Absent, test accounts are
   * left out of the rows and the counts (ADR-0267 §1), as every list of members leaves them out.
   */
  testAccount?: 'only';
}

/**
 * ***Anggota*'s detail** (P19.23-T3 AC-1; the Super Admin spec §6; ADR-0277): the row, and the two ways to reach the
 * person — their WhatsApp number and their email — which no row of the list carries (ADR-0207 §2 kept for the list).
 */
export interface PlatformMemberDetail extends PlatformMemberRow {
  /** `users.phone`, `+62…`, or `null` with none on file. */
  phone: string | null;
  email: string;
}

/**
 * **One row of *Akun terdaftar*** (P19.12-T2 AC-1; ADR-0245 §1, §2): a registered account, whether or not it holds a KPM —
 * the listed fields, and nothing else. The email is the one address a platform read returns (ADR-0245 §2: the account is
 * what the row is about, and the email is how the person was told to look for it); never a phone, a birth date or a
 * gender.
 */
export interface PlatformAccountRow {
  userId: string;
  fullName: string;
  email: string;
  /** The insurer the person registered with (`users.companyId`); `null` with none on the account. */
  company: CompanyRef | null;
  /** The day the account was made, `YYYY-MM-DD` in `Asia/Jakarta` (ADR-0016): it belongs to no office. */
  registeredOn: string;
  emailVerified: boolean;
  /** The day of the last sign-in, as `registeredOn`; `null`, *"Belum pernah"*. */
  lastSignInOn: string | null;
  /** Its live memberships — active or pending — in any KPM; `0` is *Belum punya KPM*. */
  kpmCount: number;
}

export interface PlatformAccountsPage {
  rows: PlatformAccountRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PlatformAccountsQuery {
  q?: string;
  kpm?: PlatformAccountKpmFilter;
  page?: number;
}

/** One KPM of the company's *KPM & data* (ADR-0207 §2), for the month. */
export interface CompanyKpmRow {
  kpmId: string;
  code: string;
  branch: string;
  /** `OFFICE_HEADCOUNT` on the month's last day (today's, for the current month). */
  manpower: number;
  /** `MAA_COUNT_IN_UNIT` for the month, `null` while it is not uploaded. */
  maa: number | null;
  /** The KPM's APE from January through the month, from its file (`null` with no month held), IDR minor units. */
  apeYtdMinor: number | null;
  /** The upload's `RECRUITMENT` from January through the month, `null` with none held. */
  recruitmentYtd: number | null;
  data: 'complete' | 'missing';
  /** The D4 rule (ADR-0215 §5): other KPMs of the company complete for the month, `QUANT.MIN_PEERS` needed. */
  peers: { status: 'enough' | 'not_enough' | 'not_counted'; count: number; needed: number };
}

export interface CompanyKpmsView {
  company: CompanyRef;
  month: string;
  tiles: {
    kpms: number;
    activeOwners: number;
    members: number;
    notSignedIn: number;
    complete: number;
    needed: number;
  };
  rows: CompanyKpmRow[];
}

/** What the list of every office reads beside each office (`GET /admin/tenants`, P19.4-T3 AC-8). */
export interface KpmDataStatus {
  /** The latest month held in the office's file, or `null`. */
  latestMonth: string | null;
  /** The last ended month, when it is not held and the office existed in it: *"Data <bulan> belum diunggah"*. */
  missingMonth: string | null;
}

/** How many KPMs a read computes at once: each is a fixed number of tenant-scoped queries. */
const CONCURRENCY = 4;

/**
 * **The Super Admin's reads across KPMs** (ADR-0207; P19.4-T3 AC-1, AC-2, AC-15, AC-16): *Anggota* (P19.23-T3) with its
 * *Akun terdaftar*, the company's *KPM & data*, and each KPM's data status for the console's KPMs (`dataStatusAcrossTenants`).
 * *Retired 2026-11-20 (P19.23; ADR-0277):* the KPM comparison (`GET /admin/analytics/kpms`, replaced by the Dashboard's
 * *Adopsi per KPM*) and *Data bulanan* (`GET /admin/tenants/:id/data`, replaced by the Owner's *Data upload* inside the
 * KPM).
 *
 * - **Read-only.** Every figure is the KPM's own, computed by the Phase 19.3 function its Owner's page uses, through a
 *   platform read's context (`RequestContext.platformRead`: the office named, no membership, read-only) — so nothing is
 *   computed a second way, and no read-time write happens.
 * - **Named cross-tenant reads** (invariant §1): the memberships through `listMembershipsAcrossTenants`, the per-KPM
 *   figures through the `…ForOffice` methods, the lists through the `…AcrossTenants` methods here — each registered in
 *   `named-cross-tenant-reads.tenancy.spec.ts`. Each refuses anybody but a Super Admin outside a session.
 * - **Audited per read** (ADR-0207 §5): one entry in the platform's log and one in each KPM's whose data was returned,
 *   with the fixed purpose, written after the answer is computed and before it is sent; **a failure fails the read**.
 * - **The listed fields alone** (ADR-0207 §2, §6): never an email, a phone, a survey answer or a note — but for *Akun
 *   terdaftar*'s rows, which carry the account's own email (P19.12-T2; ADR-0245 §2).
 */
@Injectable()
export class PlatformReads {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    private readonly orgLevels: OrgLevelService,
    private readonly activity: ActivityReadings,
    private readonly production: OfficialApe,
    private readonly people: OfficePeople,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /*
     * *Anggota*'s photos (P19.23-T3 AC-1): each row's `users.avatarUrl` as a signed link. Optional so the specs that build
     * this service by hand need not wire storage; without it every row draws its initials.
     */
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
  ) {}

  /** The route's own guard has asked; this is the second wall (ADR-0207 §1): a Super Admin, outside any session. */
  private require(ctx: RequestContext, permission: 'platform_members:read' | 'platform_kpm_figures:read'): void {
    if (!ctx.isSuperAdmin || ctx.isImpersonating || !can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  // ---- All members (SA UI-010, SA R1; AC-1, AC-2).

  async members(ctx: RequestContext, query: PlatformMembersQuery): Promise<PlatformMembersPage> {
    this.require(ctx, 'platform_members:read');
    const page = query.page ?? 1;
    const q = query.q?.trim() ?? '';
    if (query.q !== undefined && q.length < PLATFORM_READ.SEARCH_MIN_LENGTH) {
      throw new InvalidRequestException(PLATFORM_READS_REFUSALS.VALIDATION_FAILED.searchTooShort, { field: 'q' });
    }
    const offices = await this.officesFor({ companyId: query.companyId, kpmId: query.kpmId });
    let filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.role) filter.role = query.role;
    if (q) filter.userId = { $in: await this.usersMatching(q) };
    /*
     * **Test accounts: never listed or counted, but under *Akun tes*** (P19.23-T3 AC-1; ADR-0267 §1; OD-421): the
     * membership's copy of the flag, one clause on the read; `testAccount=only` lists them alone, so one flagged by
     * mistake can be found and its switch turned off again.
     */
    filter = query.testAccount === 'only' ? { ...filter, testAccount: true } : withoutTestAccounts(filter);
    const found = await this.memberships.listMembershipsAcrossTenants(ctx, offices.map((k) => String(k._id)), filter);

    const people = await this.peopleOf(found.map((m) => m.userId));
    const byOffice = new Map(offices.map((k) => [String(k._id), k]));
    const sorted = [...found].sort((a, b) =>
      (people.get(a.userId)?.fullName ?? '').localeCompare(people.get(b.userId)?.fullName ?? '')
      || byOffice.get(a.kpmId)!.code.localeCompare(byOffice.get(b.kpmId)!.code)
      || String(a._id).localeCompare(String(b._id)));
    const slice = sorted.slice((page - 1) * PLATFORM_READ.PAGE_SIZE, page * PLATFORM_READ.PAGE_SIZE);
    const rows = await this.memberRows(ctx, slice, byOffice, people);

    const filters = { companyId: query.companyId ?? null, kpmId: query.kpmId ?? null, role: query.role ?? null,
      status: query.status ?? null, q: q || null, testAccount: query.testAccount ?? null };
    await this.record(ctx, PLATFORM_READ.ACTION.members, PLATFORM_READ.PURPOSE.members, {
      filters, page, rows: rows.map((r) => ({ kpmId: r.kpm.id, membershipId: r.membershipId })),
    });
    return {
      rows, page, pageSize: PLATFORM_READ.PAGE_SIZE, total: found.length, kpmCount: new Set(found.map((m) => m.kpmId)).size,
    };
  }

  /**
   * ***Anggota*'s detail** (P19.23-T3 AC-1; the Super Admin spec §6 *"Tap a row → detail: phone, email, joined, last used,
   * status, upline"*; ADR-0277): one membership, anywhere — the row as the list reads it, and the person's WhatsApp number
   * and email, which the list never returns (ADR-0207 §2 kept there). A test account's too: the detail is how its switch
   * is reached. `404` for an id that names no live membership, malformed included. **Audited per read** as
   * `platform_read.member_detail` (ADR-0207 §5), in the platform's log and the KPM's, written before the answer is sent.
   */
  async memberDetail(ctx: RequestContext, membershipId: string): Promise<PlatformMemberDetail> {
    this.require(ctx, 'platform_members:read');
    if (!isValidObjectId(membershipId)) throw new NotFoundException('Membership');
    const offices = await this.officesFor({});
    const [found] = await this.memberships.listMembershipsAcrossTenants(
      ctx, offices.map((k) => String(k._id)), { _id: membershipId },
    );
    if (!found) throw new NotFoundException('Membership');
    const byOffice = new Map(offices.map((k) => [String(k._id), k]));
    const people = await this.peopleOf([found.userId]);
    const [row] = await this.memberRows(ctx, [found], byOffice, people);
    const account = isValidObjectId(found.userId)
      ? await this.users.findOne({ _id: found.userId }).select('phone email').lean().exec() as
        { phone?: string | null; email?: string } | null
      : null;
    await this.record(ctx, PLATFORM_READ.ACTION.memberDetail, PLATFORM_READ.PURPOSE.members, {
      filters: { membershipId }, page: null, rows: [{ kpmId: row.kpm.id, membershipId: row.membershipId }],
    });
    return { ...row, phone: account?.phone ?? null, email: account?.email ?? '' };
  }

  /** The accounts a search names: by name, by email, or by phone — whichever way the number was typed. */
  private async usersMatching(q: string): Promise<string[]> {
    const rows = await this.users.find({ $or: searchOf(q, { phone: true }) }).select('_id').lean().exec();
    return rows.map((u) => String(u._id));
  }

  private async peopleOf(userIds: readonly string[]): Promise<Map<string, PersonFacts>> {
    const ids = [...new Set(userIds)].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return new Map();
    const rows = await this.users.find({ _id: { $in: ids } }).select('fullName lastLoginAt avatarUrl testAccount').lean().exec() as
      { _id: unknown; fullName: string; lastLoginAt?: Date | null; avatarUrl?: string | null; testAccount?: boolean }[];
    return new Map(rows.map((u) => [
      String(u._id), {
        fullName: u.fullName, signedIn: Boolean(u.lastLoginAt), lastLoginAt: u.lastLoginAt ?? null,
        avatarKey: u.avatarUrl ?? null, testAccount: u.testAccount === true,
      },
    ]));
  }

  private async memberRows(
    ctx: RequestContext,
    slice: readonly MembershipListRow[],
    byOffice: ReadonlyMap<string, KpmDocument>,
    people: ReadonlyMap<string, PersonFacts>,
  ): Promise<PlatformMemberRow[]> {
    if (slice.length === 0) return [];
    const kpmIds = [...new Set(slice.map((m) => m.kpmId))];
    const companyIds = [...new Set(kpmIds.map((id) => byOffice.get(id)!.companyId))];
    const leaderIds = [...new Set(slice.flatMap((m) => (m.leaderId ? [m.leaderId] : [])))];
    const [companies, ladders, leaders, lastLogged] = await Promise.all([
      this.companies.find({ _id: { $in: companyIds } }).select('name').lean().exec() as Promise<{ _id: unknown; name: string }[]>,
      this.orgLevels.laddersByCompany(companyIds),
      leaderIds.length === 0 ? Promise.resolve([] as MembershipListRow[])
        : this.memberships.listMembershipsAcrossTenants(ctx, kpmIds, { _id: { $in: leaderIds } }),
      // The Overview's `lastLoggedOn`, office by office through each one's own reading (tenant-scoped).
      Promise.all(kpmIds.map(async (kpmId) => [kpmId, await this.activity.lastLoggedOnMany(
        RequestContext.platformRead(ctx, kpmId), slice.filter((m) => m.kpmId === kpmId).map((m) => String(m._id)),
      )] as const)),
    ]);
    const leaderPeople = await this.peopleOf(leaders.map((l) => l.userId));
    const leaderName = new Map(leaders.map((l) => [String(l._id), leaderPeople.get(l.userId)?.fullName ?? null]));
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));
    const latest = new Map(lastLogged);
    // P19.23-T3 AC-1: each photo as a signed link, signed once per key (`AvatarLinks`); none, the initials.
    const photos = this.avatarLinks
      ? await this.avatarLinks.linksFor(slice.map((m) => people.get(m.userId)?.avatarKey ?? null))
      : new Map<string, string>();

    return slice.map((m) => {
      const office = byOffice.get(m.kpmId)!;
      const rung = ladders.get(office.companyId)?.find((l) => l.code === m.orgLevelCode);
      const person = people.get(m.userId);
      const id = String(m._id);
      const leader = m.leaderId ? leaderName.get(m.leaderId) ?? null : null;
      // *Terakhir pakai* (P19.23-T3 AC-1): against the KPM's own today (invariant §9), a later day read as today.
      const last = latest.get(m.kpmId)?.get(id) ?? null;
      const lastDays = last === null ? null : Math.max(0, daysFrom(last, this.clock.localDateFor(office.timezone)));
      return {
        membershipId: id,
        userId: m.userId,
        fullName: person?.fullName ?? '',
        avatarUrl: person?.avatarKey ? photos.get(person.avatarKey) ?? null : null,
        agentCode: m.agentCode,
        company: { id: office.companyId, name: companyName.get(office.companyId) ?? '' },
        kpm: { id: m.kpmId, code: office.code, branch: office.branchName },
        role: {
          code: m.orgLevelCode,
          label: rung?.label ?? m.orgLevelCode,
          class: m.role,
          isOwner: office.ownerUserId === m.userId,
          isAdmin: m.adminAccess?.isKpmAdmin === true,
        },
        testAccount: person?.testAccount ?? false,
        leader: leader === null ? null : { fullName: leader },
        status: m.status,
        // One rule with the office's own Directory (ADR-0248 §4).
        invitation: invitationStateOf(person?.lastLoginAt, m.invitedAt),
        joinedOn: m.joinDate ?? (m.joinedAt ? this.clock.localDateFor(office.timezone, m.joinedAt) : null),
        lastActiveOn: last,
        lastActive: { days: lastDays, status: usageStatus(lastDays) },
      };
    });
  }

  // ---- Akun terdaftar (P19.12-T2 AC-1, AC-2; ADR-0245 §1).

  /**
   * **Every registered account, a KPM or none** (the client's message of 11 November 2026, item 2): *All members* is built
   * from memberships, so a person who registered and joined no KPM was in no row of it, by email or by name. This reads
   * the accounts themselves — Super Admins and erased accounts left out — newest registration first, 50 a page, searched
   * by a name or an email and filtered by whether the account holds a live membership anywhere.
   *
   * The memberships are counted through the named cross-tenant read (`liveMembershipCountsPerUserAcrossTenants`, a count
   * per account and nothing else). Audited per read in the platform's log with the account ids returned (ADR-0207 §5);
   * no KPM's log, because no KPM's data is returned. A failure to write the entry fails the read.
   */
  async accounts(ctx: RequestContext, query: PlatformAccountsQuery): Promise<PlatformAccountsPage> {
    this.require(ctx, 'platform_members:read');
    const page = query.page ?? 1;
    const q = query.q?.trim() ?? '';
    if (query.q !== undefined && q.length < PLATFORM_READ.SEARCH_MIN_LENGTH) {
      throw new InvalidRequestException(PLATFORM_READS_REFUSALS.VALIDATION_FAILED.accountSearchTooShort, { field: 'q' });
    }
    const live = await this.memberships.liveMembershipCountsPerUserAcrossTenants(ctx);
    const withKpm = [...live.keys()].filter((id) => isValidObjectId(id));
    const filter: Record<string, unknown> = { deletedAt: null, platformRole: { $ne: 'super_admin' } };
    if (q) filter.$or = searchOf(q, { phone: false });
    if (query.kpm === 'none') filter._id = { $nin: withKpm };
    if (query.kpm === 'some') filter._id = { $in: withKpm };

    const [total, found] = await Promise.all([
      this.users.countDocuments(filter).exec(),
      this.users.find(filter)
        .select('fullName email companyId createdAt emailVerifiedAt lastLoginAt')
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * PLATFORM_READ.PAGE_SIZE)
        .limit(PLATFORM_READ.PAGE_SIZE)
        .lean()
        .exec() as Promise<{
          _id: unknown; fullName: string; email: string; companyId?: string | null; createdAt?: Date;
          emailVerifiedAt?: Date | null; lastLoginAt?: Date | null;
        }[]>,
    ]);
    const companyIds = [...new Set(found.flatMap((u) => (u.companyId && isValidObjectId(u.companyId) ? [u.companyId] : [])))];
    const companies = companyIds.length === 0 ? [] : await this.companies.find({ _id: { $in: companyIds } })
      .select('name').lean().exec() as { _id: unknown; name: string }[];
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));
    // An account belongs to no office: its days are read in the one zone v1 has (ADR-0016), never the server's.
    const day = (at: Date | null | undefined) => (at ? this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE, at) : null);

    const rows: PlatformAccountRow[] = found.map((u) => {
      const userId = String(u._id);
      const name = u.companyId ? companyName.get(u.companyId) : undefined;
      return {
        userId,
        fullName: u.fullName,
        email: u.email,
        company: u.companyId && name !== undefined ? { id: u.companyId, name } : null,
        registeredOn: day(u.createdAt) ?? '',
        emailVerified: Boolean(u.emailVerifiedAt),
        lastSignInOn: day(u.lastLoginAt),
        kpmCount: live.get(userId) ?? 0,
      };
    });

    await this.audit.recordInScopesOrFail(ctx, [{
      kpmId: null,
      entry: {
        action: PLATFORM_READ.ACTION.accounts,
        targetCollection: 'users',
        targetId: null,
        after: {
          purpose: PLATFORM_READ.PURPOSE.accounts,
          filters: { q: q || null, kpm: query.kpm ?? null },
          page,
          rows: rows.length,
          userIds: rows.map((r) => r.userId),
        },
      },
    }]);
    return { rows, page, pageSize: PLATFORM_READ.PAGE_SIZE, total };
  }

  // ---- KPM & data (A2 `/admin/companies/:id`; AC-15).

  async companyKpmsAcrossTenants(ctx: RequestContext, companyId: string, asked?: string): Promise<CompanyKpmsView> {
    this.require(ctx, 'platform_kpm_figures:read');
    const company = isValidObjectId(companyId)
      ? await this.companies.findOne({ _id: companyId, deletedAt: null, ...INSURERS_ONLY }).lean().exec() as
        { _id: unknown; name: string } | null
      : null;
    if (!company) throw new NotFoundException('Company');
    const offices = (await this.officesFor({ companyId })).filter((k) => k.status !== 'archived');
    const facts = await inBatches(offices, CONCURRENCY, (kpm) => this.monthFacts(ctx, kpm));
    // The latest month any of the company's KPMs has uploaded, when none is asked; this month with none.
    const latestHeld = facts.flatMap((f) => (f.latestHeld ? [f.latestHeld] : [])).sort().pop();
    const month = asked ?? latestHeld ?? (offices[0] ? this.officeMonth(offices[0]).month : this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE).slice(0, 7));
    const perKpm = await inBatches(offices, CONCURRENCY, (kpm) => this.companyRow(ctx, kpm, month));
    const complete = perKpm.filter((r) => r.data === 'complete').length;
    const rows = perKpm.map((r) => {
      if (r.data !== 'complete') return { ...r, peers: { status: 'not_counted' as const, count: 0, needed: QUANT.MIN_PEERS } };
      const count = complete - 1;
      return { ...r, peers: { status: count >= QUANT.MIN_PEERS ? 'enough' as const : 'not_enough' as const, count, needed: QUANT.MIN_PEERS } };
    }).sort((a, b) => a.code.localeCompare(b.code));

    const ownerIds = offices.flatMap((k) => (k.ownerUserId ? [k.ownerUserId] : []));
    const [ownersSignedIn, people] = await Promise.all([
      this.peopleOf(ownerIds),
      this.memberships.listMembershipsAcrossTenants(ctx, offices.map((k) => String(k._id)), { status: { $in: ['active', 'pending'] } }),
    ]);
    const signedIn = await this.peopleOf(people.map((m) => m.userId));
    const view: CompanyKpmsView = {
      company: { id: String(company._id), name: company.name },
      month,
      tiles: {
        kpms: offices.length,
        activeOwners: [...ownersSignedIn.values()].filter((p) => p.signedIn).length,
        members: people.length,
        notSignedIn: people.filter((m) => !signedIn.get(m.userId)?.signedIn).length,
        complete,
        needed: QUANT.MIN_PEERS,
      },
      rows,
    };
    await this.record(ctx, PLATFORM_READ.ACTION.companyKpms, PLATFORM_READ.PURPOSE.figures, {
      filters: { companyId: String(company._id), month }, page: null, rows: rows.map((r) => ({ kpmId: r.kpmId })),
    });
    return view;
  }

  /** The latest month the office's file holds, read for the default month. */
  private async monthFacts(ctx: RequestContext, kpm: KpmDocument): Promise<{ latestHeld: string | null }> {
    const { month } = this.officeMonth(kpm);
    const held = await this.production.officeMonths(RequestContext.platformRead(ctx, String(kpm._id)),
      { from: shiftMonth(month, -(PLATFORM_READ.DATA_MONTHS - 1)), to: month });
    return { latestHeld: [...held].filter(([, m]) => m.held).map(([key]) => key).sort().pop() ?? null };
  }

  /** One KPM's month: the headcount, MAA, the year to date and recruitment from its file — the Overview's functions. */
  private async companyRow(ctx: RequestContext, kpm: KpmDocument, month: string): Promise<Omit<CompanyKpmRow, 'peers'>> {
    const office = RequestContext.platformRead(ctx, String(kpm._id));
    const timezone = kpm.timezone;
    const { month: current } = this.officeMonth(kpm);
    const end = month >= current ? this.clock.endOfLocalDay(timezone, this.clock.localDateFor(timezone))
      : this.clock.monthBounds(timezone, month).endExclusive;
    const roster = await this.people.read(office, this.clock.startOfLocalDay(timezone, `${month}-01`), timezone);
    const members = roster.everyone.filter((p) => memberAt(p, end)).map((p) => p.membershipId);
    const [months, cells] = await Promise.all([
      this.production.officeMonths(office, { from: `${month.slice(0, 4)}-01`, to: month }),
      this.production.monthCellsAndYearToDateFor(office, members, { from: month, to: month }),
    ]);
    const thisMonth = months.get(month);
    const heldMonths = [...months.values()];
    const sumOf = (pick: (m: (typeof heldMonths)[number]) => number | null) => {
      const values = heldMonths.map(pick).filter((v): v is number => v !== null);
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
    };
    return {
      kpmId: String(kpm._id),
      code: kpm.code,
      branch: kpm.branchName,
      manpower: officeHeadcount(roster.everyone, end),
      maa: maaCountInUnit(members.map((id) => {
        const cell = cells.cells.get(id)?.get(month);
        return cell ? monthlyActiveAgent(cell.apeMonthly, cell.policyCountMonthly) : null;
      }), thisMonth?.held === true),
      apeYtdMinor: sumOf((m) => m.apeMonthlyMinor),
      recruitmentYtd: sumOf((m) => m.recruitmentMonthly),
      data: thisMonth?.held ? 'complete' : 'missing',
    };
  }

  // ---- The offices list's data status (P19.4-T3 AC-8).

  /**
   * **Each office's latest month held, and the last ended month when it is missing** (`GET /admin/tenants`, *Data
   * terakhir* and *Perlu tindakan*): whether a month was uploaded, never a figure of it — what the offices list says
   * beside each office. Read office by office through each one's own reading.
   */
  async dataStatusAcrossTenants(
    ctx: RequestContext, kpms: readonly { _id: string; timezone: string; createdAt: string | Date | null }[],
  ): Promise<Map<string, KpmDataStatus>> {
    if (!ctx.isSuperAdmin || ctx.isImpersonating) throw new PermissionDeniedException('kpm:list_all');
    const out = await inBatches([...kpms], CONCURRENCY, async (kpm) => {
      const { month, firstMonth } = this.officeMonth(kpm);
      const held = await this.production.officeMonths(RequestContext.platformRead(ctx, String(kpm._id)),
        { from: shiftMonth(month, -(PLATFORM_READ.DATA_MONTHS - 1)), to: month });
      const latestMonth = [...held].filter(([, m]) => m.held).map(([key]) => key).sort().pop() ?? null;
      const lastEnded = shiftMonth(month, -1);
      const missingMonth = lastEnded >= firstMonth && !held.get(lastEnded)?.held ? lastEnded : null;
      return [String(kpm._id), { latestMonth, missingMonth }] as const;
    });
    return new Map(out);
  }

  // ---- Shared.

  /** The live offices a read covers: one, one company's, or all — insurers' offices only. */
  private async officesFor(scope: { companyId?: string; kpmId?: string }): Promise<KpmDocument[]> {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (scope.companyId) filter.companyId = scope.companyId;
    if (scope.kpmId) {
      if (!isValidObjectId(scope.kpmId)) return [];
      filter._id = scope.kpmId;
    }
    return this.kpms.find(filter).sort({ code: 1 }).exec();
  }

  /** The office's current month and its first, in its own zone (invariant §9). */
  private officeMonth(kpm: { timezone: string; createdAt?: string | Date | null }): { month: string; firstMonth: string } {
    const today = this.clock.localDateFor(kpm.timezone);
    const created = (kpm as { createdAt?: string | Date | null }).createdAt;
    const first = created ? this.clock.localDateFor(kpm.timezone, new Date(created)) : today;
    return { month: today.slice(0, 7), firstMonth: (first < today ? first : today).slice(0, 7) };
  }

  /**
   * **The read's entries** (ADR-0207 §5): one in the platform's scope with the purpose, the filters, the page and the
   * number of rows (and, for the members list, the `membershipId`s returned); one in each KPM's scope whose data it
   * returned, with the purpose and its own rows. One insert, after the answer is computed; a failure fails the read.
   */
  private async record(
    ctx: RequestContext,
    action: string,
    purpose: string,
    read: {
      filters: Record<string, unknown>;
      page: number | null;
      rows: { kpmId: string; membershipId?: string }[];
      target?: KpmDocument;
    },
  ): Promise<void> {
    const byKpm = new Map<string, string[]>();
    for (const row of read.rows) {
      const list = byKpm.get(row.kpmId) ?? [];
      if (row.membershipId) list.push(row.membershipId);
      byKpm.set(row.kpmId, list);
    }
    const members = read.rows.some((r) => r.membershipId !== undefined);
    const platform: AuditEntry = {
      action,
      targetCollection: 'kpms',
      targetId: read.target ? String(read.target._id) : null,
      after: {
        purpose,
        filters: read.filters,
        page: read.page,
        rows: read.rows.length,
        ...(members ? { membershipIds: read.rows.map((r) => r.membershipId) } : { kpmIds: [...byKpm.keys()] }),
      },
    };
    const perKpm = [...byKpm].map(([kpmId, ids]) => ({
      kpmId,
      entry: {
        action,
        targetCollection: 'kpms',
        targetId: kpmId,
        after: { purpose, rows: members ? ids.length : 1, ...(members ? { membershipIds: ids } : {}), ...read.filters },
      } satisfies AuditEntry,
    }));
    await this.audit.recordInScopesOrFail(ctx, [{ kpmId: null, entry: platform }, ...perKpm]);
  }
}

/** Run `work` over `items`, `size` at a time, keeping the order. */
async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return out;
}

/**
 * **What a search matches on an account**: a name or an email, in part and in any case — and, for *All members*, a phone
 * number, whichever way it was typed. *Akun terdaftar* (ADR-0245 §1) asks a name or an email alone.
 */
/** What a platform read needs of a person (`peopleOf`): never a phone or an email (the detail reads those apart). */
interface PersonFacts {
  fullName: string;
  signedIn: boolean;
  lastLoginAt: Date | null;
  /** `users.avatarUrl`, the storage key — signed into a link by `AvatarLinks` (P19.23-T3). */
  avatarKey: string | null;
  testAccount: boolean;
}

function searchOf(q: string, { phone }: { phone: boolean }): Record<string, unknown>[] {
  const pattern = new RegExp(escape(q), 'i');
  const or: Record<string, unknown>[] = [{ fullName: pattern }, { email: pattern }];
  const digits = q.replace(/[\s\-().]/g, '');
  if (phone && /^\+?\d{4,}$/.test(digits)) {
    // `0812…`, `62812…` and `+62812…` are one number: matched on what follows the country or trunk prefix.
    const national = digits.replace(/^\+/, '').replace(/^62/, '').replace(/^0/, '');
    or.push({ phone: new RegExp(escape(national)) });
  }
  return or;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
