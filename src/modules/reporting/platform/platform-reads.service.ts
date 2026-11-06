import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import {
  DEFAULT_TENANT_TIMEZONE, KPM_COMPARISON_SORTS, PLATFORM_READ, QUANT,
  type KpmComparisonSort, type PlatformMemberRole, type PlatformMemberStatus,
} from '@/domain/constants';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { memberAt, officeHeadcount } from '@/domain/metrics/office-headcount';
import type { Rate } from '@/domain/metrics/rate';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditService, type AuditEntry } from '@/modules/audit/audit.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository, type MembershipListRow } from '@/modules/org/membership.repository';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { INSURERS_ONLY } from '@/modules/tenants/template-library';
import { User, UserDocument } from '@/modules/users/user.schema';
import { ComplianceService, type ComplianceQuery, type ComplianceView } from '../compliance/compliance.service';
import { KpmAnalyticsService, type KpmAnalyticsView } from '../kpm-analytics.service';
import { KpmOverviewService } from '../kpm-overview.service';
import type { Money } from '../office-figures';
import { shiftMonth } from '../office-figures';
import { OfficePeople } from '../office-people';
import type { KpmAnalyticsPeriod } from '@/domain/constants';
import { PLATFORM_READS_REFUSALS } from './platform-reads.messages';

/** A company as a platform read names it. */
export interface CompanyRef { id: string; name: string }

/** One row of *All members* (ADR-0207 §2): the listed fields, and nothing else — never an email or a phone. */
export interface PlatformMemberRow {
  membershipId: string;
  fullName: string;
  agentCode: string;
  company: CompanyRef;
  kpm: { id: string; code: string; branch: string };
  role: { code: string; label: string; isOwner: boolean; isAdmin: boolean };
  leader: { fullName: string } | null;
  status: PlatformMemberStatus;
  /** ADR-0212 §2's state: `signed_in` once the account has signed in, `invited` once an invitation went, else not. */
  invitation: 'invited' | 'not_invited' | 'signed_in';
  joinedOn: string | null;
  /** The last day the member logged an activity (the Overview's `lastLoggedOn`), or `null`: *"Belum pernah"*. */
  lastActiveOn: string | null;
}

export interface PlatformMembersPage {
  rows: PlatformMemberRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PlatformMembersQuery {
  companyId?: string;
  kpmId?: string;
  role?: PlatformMemberRole;
  status?: PlatformMemberStatus;
  q?: string;
  page?: number;
}

/** One row of the KPM comparison (ADR-0207 §2): the Overview's own figures for the KPM, counts and sums only. */
export interface KpmComparisonRow {
  kpmId: string;
  code: string;
  branch: string;
  company: CompanyRef;
  /** *Total members*: `OFFICE_HEADCOUNT`, the Overview's `composition.total`. */
  members: number;
  /** *Aktif bulan ini* (ADR-0200 §2): the Overview's `engagement.activeThisMonth`, `null` counts while not uploaded. */
  activeThisMonth: { count: number | null; of: number; pct: number | null; month: string };
  /** *Pengguna aktif* (ADR-0200 §3): the Overview's `engagement.loggedThisWeek`, over the rolling 7 days. */
  activeUsers: { logged: number; notLogged: number; pct: number | null };
  coached: { d7: Rate; d30: Rate };
  /** *Production this year* against target (ADR-0204 §1, §3): the Overview's `production.ytd`. */
  production: Money;
  /** *Recruitment pipeline* against the month's target: the Overview's `recruitment`. */
  recruitment: { pipeline: number; target: number | null };
}

export interface KpmComparisonPage {
  rows: KpmComparisonRow[];
  page: number;
  pageSize: number;
  total: number;
  sort: string;
}

/** A month of *Data bulanan*'s grid: *Lengkap · Belum · —*. */
export interface KpmDataMonth { month: string; status: 'complete' | 'missing' | 'none' }

/** One upload of *Data bulanan*'s history: month, by whom, when, how many agents, the note. */
export interface KpmDataUpload {
  month: string;
  by: string | null;
  at: string | null;
  agents: number;
  note: { status: 'committed' | 'reverting' | 'reverted'; asOf: string | null };
}

export interface KpmDataView {
  kpmId: string;
  months: KpmDataMonth[];
  uploads: KpmDataUpload[];
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

/** How many KPMs a comparison computes at once: each is the Overview's fixed number of queries. */
const CONCURRENCY = 4;

/**
 * **The Super Admin's reads across KPMs** (ADR-0207; P19.4-T3 AC-1 to AC-5, AC-9, AC-15, AC-16): *All members*, the KPM
 * comparison, *Lihat sebagai KPM*'s two tabs, *Data bulanan* and the company's *KPM & data*.
 *
 * - **Read-only.** Every figure is the KPM's own, computed by the Phase 19.3 function its Owner's page uses, through a
 *   platform read's context (`RequestContext.platformRead`: the office named, no membership, read-only) — so nothing is
 *   computed a second way, and no read-time write happens.
 * - **Named cross-tenant reads** (invariant §1): the memberships through `listMembershipsAcrossTenants`, the per-KPM
 *   figures through the `…ForOffice` methods, the lists through the `…AcrossTenants` methods here — each registered in
 *   `named-cross-tenant-reads.tenancy.spec.ts`. Each refuses anybody but a Super Admin outside a session.
 * - **Audited per read** (ADR-0207 §5): one entry in the platform's log and one in each KPM's whose data was returned,
 *   with the fixed purpose, written after the answer is computed and before it is sent; **a failure fails the read**.
 * - **The listed fields alone** (ADR-0207 §2, §6): never an email, a phone, a survey answer or a note.
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
    private readonly overview: KpmOverviewService,
    private readonly analytics: KpmAnalyticsService,
    private readonly compliance: ComplianceService,
    private readonly production: OfficialApe,
    private readonly batches: DataUploadBatchRepository,
    private readonly names: MemberNames,
    private readonly people: OfficePeople,
    private readonly audit: AuditService,
    private readonly clock: Clock,
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
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.role) filter.role = query.role;
    if (q) filter.userId = { $in: await this.usersMatching(q) };
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
      status: query.status ?? null, q: q || null };
    await this.record(ctx, PLATFORM_READ.ACTION.members, PLATFORM_READ.PURPOSE.members, {
      filters, page, rows: rows.map((r) => ({ kpmId: r.kpm.id, membershipId: r.membershipId })),
    });
    return { rows, page, pageSize: PLATFORM_READ.PAGE_SIZE, total: found.length };
  }

  /** The accounts a search names: by name, by email, or by phone — whichever way the number was typed. */
  private async usersMatching(q: string): Promise<string[]> {
    const pattern = new RegExp(escape(q), 'i');
    const or: Record<string, unknown>[] = [{ fullName: pattern }, { email: pattern }];
    const digits = q.replace(/[\s\-().]/g, '');
    if (/^\+?\d{4,}$/.test(digits)) {
      // `0812…`, `62812…` and `+62812…` are one number: matched on what follows the country or trunk prefix.
      const national = digits.replace(/^\+/, '').replace(/^62/, '').replace(/^0/, '');
      or.push({ phone: new RegExp(escape(national)) });
    }
    const rows = await this.users.find({ $or: or }).select('_id').lean().exec();
    return rows.map((u) => String(u._id));
  }

  private async peopleOf(userIds: readonly string[]): Promise<Map<string, { fullName: string; signedIn: boolean }>> {
    const ids = [...new Set(userIds)].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return new Map();
    const rows = await this.users.find({ _id: { $in: ids } }).select('fullName lastLoginAt').lean().exec() as
      { _id: unknown; fullName: string; lastLoginAt?: Date | null }[];
    return new Map(rows.map((u) => [String(u._id), { fullName: u.fullName, signedIn: Boolean(u.lastLoginAt) }]));
  }

  private async memberRows(
    ctx: RequestContext,
    slice: readonly MembershipListRow[],
    byOffice: ReadonlyMap<string, KpmDocument>,
    people: ReadonlyMap<string, { fullName: string; signedIn: boolean }>,
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

    return slice.map((m) => {
      const office = byOffice.get(m.kpmId)!;
      const rung = ladders.get(office.companyId)?.find((l) => l.code === m.orgLevelCode);
      const person = people.get(m.userId);
      const id = String(m._id);
      const leader = m.leaderId ? leaderName.get(m.leaderId) ?? null : null;
      return {
        membershipId: id,
        fullName: person?.fullName ?? '',
        agentCode: m.agentCode,
        company: { id: office.companyId, name: companyName.get(office.companyId) ?? '' },
        kpm: { id: m.kpmId, code: office.code, branch: office.branchName },
        role: {
          code: m.orgLevelCode,
          label: rung?.label ?? m.orgLevelCode,
          isOwner: office.ownerUserId === m.userId,
          isAdmin: m.adminAccess?.isKpmAdmin === true,
        },
        leader: leader === null ? null : { fullName: leader },
        status: m.status,
        invitation: person?.signedIn ? 'signed_in' : m.invitedAt ? 'invited' : 'not_invited',
        joinedOn: m.joinDate ?? (m.joinedAt ? this.clock.localDateFor(office.timezone, m.joinedAt) : null),
        lastActiveOn: latest.get(m.kpmId)?.get(id) ?? null,
      };
    });
  }

  // ---- The KPM comparison (SA UI-013, SA R4; AC-3).

  async kpmComparisonAcrossTenants(
    ctx: RequestContext, query: { companyId?: string; sort?: string; page?: number },
  ): Promise<KpmComparisonPage> {
    this.require(ctx, 'platform_kpm_figures:read');
    const sort = parseSort(query.sort);
    const page = query.page ?? 1;
    const offices = (await this.officesFor({ companyId: query.companyId })).filter((k) => k.status !== 'archived');
    const companies = await this.companyNames(offices);
    const all = await inBatches(offices, CONCURRENCY, async (kpm) => this.comparisonRow(ctx, kpm, companies));
    const sorted = all.sort(compareBy(sort.key, sort.descending));
    const rows = sorted.slice((page - 1) * PLATFORM_READ.PAGE_SIZE, page * PLATFORM_READ.PAGE_SIZE);
    await this.record(ctx, PLATFORM_READ.ACTION.kpmComparison, PLATFORM_READ.PURPOSE.figures, {
      filters: { companyId: query.companyId ?? null, sort: query.sort ?? null }, page,
      rows: rows.map((r) => ({ kpmId: r.kpmId })),
    });
    return { rows, page, pageSize: PLATFORM_READ.PAGE_SIZE, total: all.length, sort: query.sort ?? 'kpm' };
  }

  /** One KPM's row: the Overview, computed by its own code over the office, and the figures it shows the Owner. */
  private async comparisonRow(
    ctx: RequestContext, kpm: KpmDocument, companies: ReadonlyMap<string, string>,
  ): Promise<KpmComparisonRow> {
    const view = await this.overview.figuresForOffice(RequestContext.platformRead(ctx, String(kpm._id)));
    const { activeThisMonth, loggedThisWeek } = view.engagement;
    return {
      kpmId: String(kpm._id),
      code: kpm.code,
      branch: kpm.branchName,
      company: { id: kpm.companyId, name: companies.get(kpm.companyId) ?? '' },
      members: view.composition.total,
      activeThisMonth: {
        count: activeThisMonth.count, of: activeThisMonth.of, pct: activeThisMonth.pct, month: activeThisMonth.month,
      },
      activeUsers: { logged: loggedThisWeek.logged, notLogged: loggedThisWeek.notLogged, pct: loggedThisWeek.pct },
      coached: { d7: view.coaching.coverage7d, d30: view.coaching.coverage30d },
      production: {
        achievedMinor: view.production.ytd.achievedMinor,
        targetMinor: view.production.ytd.targetMinor,
        pct: view.production.ytd.pct,
      },
      recruitment: { pipeline: view.recruitment.pipelineNow, target: view.recruitment.target },
    };
  }

  // ---- Lihat sebagai KPM (SA R4, A2, A-R8; AC-4; P19.4-T2 AC-6).

  async kpmAnalytics(
    ctx: RequestContext, kpmId: string, query: { period?: KpmAnalyticsPeriod; group?: string },
  ): Promise<KpmAnalyticsView> {
    this.require(ctx, 'platform_kpm_figures:read');
    const kpm = await this.liveOffice(kpmId);
    const view = await this.analytics.analyticsForOffice(RequestContext.platformRead(ctx, String(kpm._id)), query);
    await this.recordVisit(ctx, kpm, 'overview', { period: view.period, group: query.group ?? null });
    return view;
  }

  async kpmCompliance(ctx: RequestContext, kpmId: string, query: ComplianceQuery): Promise<ComplianceView> {
    this.require(ctx, 'platform_kpm_figures:read');
    const kpm = await this.liveOffice(kpmId);
    const view = await this.compliance.complianceForOffice(RequestContext.platformRead(ctx, String(kpm._id)), query);
    await this.recordVisit(ctx, kpm, 'compliance', {
      category: view.selected.category, item: view.selected.item ?? null, group: query.group ?? null,
    });
    return view;
  }

  private async recordVisit(ctx: RequestContext, kpm: KpmDocument, tab: string, filters: Record<string, unknown>) {
    await this.record(ctx, PLATFORM_READ.ACTION.kpmAnalytics, PLATFORM_READ.PURPOSE.figures, {
      filters: { tab, ...filters }, page: null, rows: [{ kpmId: String(kpm._id) }], target: kpm,
    });
  }

  // ---- Data bulanan (A2; AC-9).

  async kpmData(ctx: RequestContext, kpmId: string): Promise<KpmDataView> {
    this.require(ctx, 'platform_kpm_figures:read');
    const kpm = await this.liveOffice(kpmId);
    const office = RequestContext.platformRead(ctx, String(kpm._id));
    const { month, firstMonth } = this.officeMonth(kpm);
    const from = shiftMonth(month, -(PLATFORM_READ.DATA_MONTHS - 1));
    const [held, batches] = await Promise.all([
      this.production.officeMonths(office, { from, to: month }),
      this.batches.find(office, { month: { $gte: from, $lte: month }, status: { $in: ['committed', 'reverting', 'reverted'] } },
        { sort: { committedAt: -1, monthRevision: -1 } }),
    ]);
    const months: KpmDataMonth[] = monthRange(from, month).map((m) => ({
      month: m,
      status: held.get(m)?.held ? 'complete' : m < firstMonth ? 'none' : 'missing',
    }));
    const uploaders = [...new Set(batches.flatMap((b) => (b.committedBy ? [b.committedBy] : [])))];
    const names = await this.names.byMembershipId(office, uploaders);
    const uploads: KpmDataUpload[] = batches.map((b) => ({
      month: b.month,
      by: b.committedBy ? names.get(b.committedBy) ?? null : null,
      at: b.committedAt ? b.committedAt.toISOString() : null,
      agents: b.writtenRowCount,
      note: { status: b.status as KpmDataUpload['note']['status'], asOf: b.asOf ?? null },
    }));
    await this.record(ctx, PLATFORM_READ.ACTION.kpmData, PLATFORM_READ.PURPOSE.figures, {
      filters: { from, to: month }, page: null, rows: [{ kpmId: String(kpm._id) }], target: kpm,
    });
    return { kpmId: String(kpm._id), months, uploads };
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

  private async liveOffice(kpmId: string): Promise<KpmDocument> {
    const kpm = isValidObjectId(kpmId) ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec() : null;
    if (!kpm) throw new NotFoundException('KPM');
    return kpm;
  }

  private async companyNames(offices: readonly KpmDocument[]): Promise<Map<string, string>> {
    const ids = [...new Set(offices.map((k) => k.companyId))];
    const rows = await this.companies.find({ _id: { $in: ids } }).select('name').lean().exec() as { _id: unknown; name: string }[];
    return new Map(rows.map((c) => [String(c._id), c.name]));
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

/** `kpm`, `-production`: a column of the comparison and its direction; an unknown one is 400. */
function parseSort(raw: string | undefined): { key: KpmComparisonSort; descending: boolean } {
  const descending = raw?.startsWith('-') ?? false;
  const key = (raw ?? 'kpm').replace(/^-/, '');
  if (!(KPM_COMPARISON_SORTS as readonly string[]).includes(key)) {
    throw new InvalidRequestException(PLATFORM_READS_REFUSALS.VALIDATION_FAILED.sortUnknown({ sorts: KPM_COMPARISON_SORTS }), {
      field: 'sort',
    });
  }
  return { key: key as KpmComparisonSort, descending };
}

/** A figure to sort by: `null` (no data) always last, whichever the direction; then by code. */
function compareBy(key: KpmComparisonSort, descending: boolean) {
  const value = (r: KpmComparisonRow): string | number | null => {
    switch (key) {
      case 'kpm': return r.code;
      case 'company': return r.company.name;
      case 'members': return r.members;
      case 'activeThisMonth': return r.activeThisMonth.pct;
      case 'activeUsers': return r.activeUsers.pct;
      case 'coached7d': return r.coached.d7.pct;
      case 'coached30d': return r.coached.d30.pct;
      case 'production': return r.production.pct;
      case 'recruitment': return r.recruitment.pipeline;
    }
  };
  return (a: KpmComparisonRow, b: KpmComparisonRow): number => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return x === y ? a.code.localeCompare(b.code) : x === null ? 1 : -1;
    const order = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return (descending ? -order : order) || a.code.localeCompare(b.code);
  };
}

/** Run `work` over `items`, `size` at a time, keeping the order. */
async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return out;
}

/** `from` to `to`, inclusive, month by month. */
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
