import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { isEffectiveCoreLeader, RequestContext } from '@/common/context/request-context';
import { NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { CONSOLE, DEFAULT_TENANT_TIMEZONE, type KpmIssue } from '@/domain/constants';
import type { UsageStatus } from '@/domain/constants/usage';
import type { UsageReading } from '@/domain/metrics/usage';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { withoutTestAccounts } from '@/modules/org/counted-members';
import { LeaderLimitRequestService } from '@/modules/org/leader-limit-request.service';
import { MembershipRepository, type MembershipListRow } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { KpmRequest, KpmRequestDocument } from '@/modules/tenants/kpm-request.schema';
import { INSURERS_ONLY } from '@/modules/tenants/template-library';
import { TenantService, type KpmAdminView, type OwnerState } from '@/modules/tenants/tenant.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { OfficeGroups } from '../office-groups';
import { PlatformReads } from './platform-reads.service';

/** A person's class: `ab` and `aab` are leaders (*Leader*), `agent` an agent (`LEADER_CLASSES`). */
export type PersonClass = 'ab' | 'aab' | 'agent';

/** One audience's usage of one KPM (*Leader* or *Agent*): its members and how many of them reached each step. */
export interface UsageCounts {
  members: number;
  everUsed: number;
  used14: number;
  powerUsers: number;
}

/** One KPM as the dashboard's tree and the KPM list read it (P19.23-T1 AC-4, T2 AC-1). */
export interface ConsoleKpm {
  kpmId: string;
  name: string;
  code: string;
  companyId: string;
  companyName: string;
  status: 'active' | 'suspended' | 'archived';
  /** In *KPM aktif* and the adoption tree: active, and its subscription not ended (ADR-0277 §2). */
  active: boolean;
  /** The Owner's name, or the named Owner who waits (`pendingOwner`); `null`: no Owner. */
  ownerName: string | null;
  ownerState: OwnerState;
  createdAt: string;
  /** Counted members — active, test accounts never — by class. */
  usage: { leader: UsageCounts; agent: UsageCounts };
  /** Everything to say about the KPM, in `KPM_ISSUES`' order: the card shows the first, the dashboard each action. */
  issues: KpmIssue[];
  /** `data_missing`'s month, `YYYY-MM`, or `null`. */
  missingMonth: string | null;
}

/** The funnel's step against last month (P19.23-T1 AC-2): this month's count and percentage, and last month's. */
export interface FunnelStep {
  count: number;
  pct: number;
  previousCount: number;
  previousPct: number;
}

/** **`GET /admin/dashboard`** — the console's Dashboard, and the KPM list's figures (ADR-0277 §1, §2). */
export interface ConsoleDashboard {
  /** The platform's today (`Asia/Jakarta`, ADR-0016), and the day a month earlier the funnel compares with. */
  asOf: string;
  comparedWith: string;
  scale: { greenFromPct: number; yellowFromPct: number };
  overall: {
    kpms: number;
    kpmsNewThisMonth: number;
    companies: number;
    activeKpms: number;
    leaders: number;
    agents: number;
  };
  /** *Pemakaian AgencyBoost* over the active KPMs' members. */
  funnel: { members: number; everUsed: FunnelStep; used14: FunnelStep; powerUsers: FunnelStep };
  /** Pending approvals: KPM registrations and leaders past the limit. */
  approvalsPending: number;
  /** The insurers, by name, each with or without a KPM — the tree's companies. */
  companies: { companyId: string; name: string }[];
  /** Every live KPM, archived included, by company name then KPM name. */
  kpms: ConsoleKpm[];
}

/** A person of one KPM on its page (P19.23-T2 AC-4, AC-7): names, never a contact. */
export interface ConsolePerson {
  membershipId: string;
  userId: string;
  fullName: string;
  class: PersonClass;
}

/** **`GET /admin/tenants/:id/people`** — a KPM page's *Owner & admin*, *Anggota* and *Lihat sebagai* (ADR-0277 §3). */
export interface ConsoleKpmPeople {
  kpm: { kpmId: string; name: string; code: string; companyId: string; companyName: string; status: ConsoleKpm['status'] };
  owner: { state: OwnerState; person: ConsolePerson | null; pendingName: string | null };
  admins: ConsolePerson[];
  coreLeaders: ConsolePerson[];
  members: {
    total: number;
    leaders: number;
    agents: number;
    first: (ConsolePerson & { groupName: string | null; lastUsedDays: number | null; lastUsedStatus: UsageStatus })[];
  };
  viewAs: { owner: ConsolePerson[]; admin: ConsolePerson[]; ab: ConsolePerson[]; agent: ConsolePerson[] };
}

const EMPTY = (): UsageCounts => ({ members: 0, everUsed: 0, used14: 0, powerUsers: 0 });
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const leaderClass = (role: string) => role === 'ab' || role === 'aab';
const CLASS_ORDER: Record<string, number> = { ab: 0, aab: 1, agent: 2 };

/**
 * **The Super Admin console's reads** (P19.23-T1, T2; [ADR-0277](../../../../../docs/04-adr/0277-the-super-admin-console-works-inside-every-kpm-and-reads-adoption-across-them.md)):
 * the Dashboard — the summary, *Pemakaian AgencyBoost*, *Perlu tindakan* and *Adopsi per KPM* — which the KPM list reads
 * too, and a KPM page's people.
 *
 * - **Counts across KPMs, names within one.** The dashboard answers counts per KPM and per class — never a member — so it
 *   is ADR-0011's aggregate, and is not audited per read (ADR-0277 §1). A KPM's page names its people, as the Owner's own
 *   pages do, to the Super Admin who is that KPM's Owner (ADR-0268 §3).
 * - **Tenancy** (invariant §1): the memberships through the named `listMembershipsAcrossTenants`, test accounts left out
 *   (`withoutTestAccounts`, ADR-0267 §1); every KPM's activity through that KPM's own reading
 *   (`ActivityReadings.usageOf`) in a platform read's context (`RequestContext.platformRead`) — tenant-scoped, the KPM
 *   named, read-only — as *All members*' *Terakhir pakai* is read.
 * - **One definition per number** (invariant §8; ADR-0267 §4): *Pernah pakai*, *Pakai 14 hari terakhir* and *Power user*
 *   are `usageOf`'s, over each KPM's own today (`kpms.timezone`, invariant §9). Last month's are the same reading as of
 *   the same day a month earlier, over the same people.
 */
@Injectable()
export class PlatformConsole {
  constructor(
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(KpmRequest.name) private readonly kpmRequests: Model<KpmRequestDocument>,
    private readonly tenants: TenantService,
    private readonly reads: PlatformReads,
    private readonly memberships: MembershipRepository,
    private readonly activity: ActivityReadings,
    private readonly leaderLimit: LeaderLimitRequestService,
    private readonly groups: OfficeGroups,
    private readonly clock: Clock,
  ) {}

  /** The route's guard has asked; this is the second wall: a Super Admin, outside any session (ADR-0207 §1). */
  private require(ctx: RequestContext, permission: 'platform_metrics:read' | 'kpm:read_profile'): void {
    if (!ctx.isSuperAdmin || ctx.isImpersonating || !can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  // ---- The Dashboard (P19.23-T1 AC-2 to AC-4) and the KPM list (T2 AC-1).

  async dashboard(ctx: RequestContext): Promise<ConsoleDashboard> {
    this.require(ctx, 'platform_metrics:read');
    const [offices, insurers, kpmRequestsPending, leaderLimitRows] = await Promise.all([
      this.tenants.listAll(ctx),
      this.companies.find({ deletedAt: null, ...INSURERS_ONLY }).select('name').sort({ name: 1 }).lean().exec() as
        Promise<{ _id: unknown; name: string }[]>,
      this.kpmRequests.countDocuments({ status: 'pending', deletedAt: null }).exec(),
      this.leaderLimit.queue(ctx),
    ]);
    const insurerIds = new Set(insurers.map((c) => String(c._id)));
    const live = offices.filter((k) => insurerIds.has(k.companyId));
    const open = live.filter((k) => k.status !== 'archived');

    const [dataStatus, counted] = await Promise.all([
      this.reads.dataStatusAcrossTenants(ctx, open),
      this.memberships.listMembershipsAcrossTenants(ctx, open.map((k) => k._id), withoutTestAccounts({ status: 'active' })),
    ]);
    const membersOf = new Map<string, MembershipListRow[]>();
    for (const m of counted) membersOf.set(m.kpmId, [...(membersOf.get(m.kpmId) ?? []), m]);

    // Each KPM's today and the same day a month before, in its own zone (invariant §9).
    const today = this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
    const comparedWith = monthBefore(today);
    const usage = new Map(await inBatches(open, CONSOLE.CONCURRENCY, async (kpm) => {
      const people = membersOf.get(kpm._id) ?? [];
      const ids = people.map((m) => String(m._id));
      const kpmToday = this.clock.localDateFor(kpm.timezone);
      const office = RequestContext.platformRead(ctx, kpm._id);
      const [now, before] = await Promise.all([
        this.activity.usageOf(office, ids, kpmToday),
        this.activity.usageOf(office, ids, monthBefore(kpmToday)),
      ]);
      return [kpm._id, { people, now, before }] as const;
    }));

    const kpms = live.map((kpm): ConsoleKpm => {
      const read = usage.get(kpm._id);
      const counts = { leader: EMPTY(), agent: EMPTY() };
      for (const m of read?.people ?? []) {
        const into = leaderClass(m.role) ? counts.leader : counts.agent;
        tally(into, read!.now.get(String(m._id)));
      }
      const subscriptionEnded = kpm.subscriptionState === 'ended';
      const missingMonth = dataStatus.get(kpm._id)?.missingMonth ?? null;
      return {
        kpmId: kpm._id,
        name: kpm.branchName,
        code: kpm.code,
        companyId: kpm.companyId,
        companyName: kpm.companyName,
        status: kpm.status,
        active: kpm.status === 'active' && !subscriptionEnded,
        ownerName: kpm.ownerName ?? kpm.pendingOwner?.fullName ?? null,
        ownerState: kpm.ownerState,
        createdAt: kpm.createdAt,
        usage: counts,
        issues: issuesOf(kpm, subscriptionEnded, missingMonth),
        missingMonth,
      };
    }).sort((a, b) => a.companyName.localeCompare(b.companyName) || a.name.localeCompare(b.name));

    // The funnel and the summary: the active KPMs' members (*KPM aktif*), as the tree.
    const active = kpms.filter((k) => k.active);
    const now = EMPTY();
    const before = EMPTY();
    let leaders = 0;
    for (const kpm of active) {
      const read = usage.get(kpm.kpmId)!;
      for (const m of read.people) {
        if (leaderClass(m.role)) leaders += 1;
        tally(now, read.now.get(String(m._id)));
        tally(before, read.before.get(String(m._id)));
      }
    }
    const step = (key: keyof Omit<UsageCounts, 'members'>): FunnelStep => ({
      count: now[key], pct: pct(now[key], now.members), previousCount: before[key], previousPct: pct(before[key], before.members),
    });
    const month = today.slice(0, 7);

    return {
      asOf: today,
      comparedWith,
      scale: { greenFromPct: CONSOLE.SCALE.GREEN_FROM_PCT, yellowFromPct: CONSOLE.SCALE.YELLOW_FROM_PCT },
      overall: {
        kpms: open.length,
        kpmsNewThisMonth: open.filter((k) => this.clock.localDateFor(k.timezone, new Date(k.createdAt)).startsWith(month)).length,
        companies: insurers.length,
        activeKpms: active.length,
        leaders,
        agents: now.members - leaders,
      },
      funnel: { members: now.members, everUsed: step('everUsed'), used14: step('used14'), powerUsers: step('powerUsers') },
      approvalsPending: kpmRequestsPending + leaderLimitRows.filter((r) => r.status === 'pending').length,
      companies: insurers.map((c) => ({ companyId: String(c._id), name: c.name })),
      kpms,
    };
  }

  // ---- A KPM's page (P19.23-T2 AC-4, AC-7).

  async kpmPeople(ctx: RequestContext, kpmId: string): Promise<ConsoleKpmPeople> {
    this.require(ctx, 'kpm:read_profile');
    if (!isValidObjectId(kpmId)) throw new NotFoundException('KPM');
    // The Super Admin's read of one KPM, its Owner's state and its company with it; `404` for one that is not there.
    const kpm = await this.tenants.readProfile(ctx, kpmId) as KpmAdminView;
    const office = RequestContext.platformRead(ctx, kpmId);

    const rows = await this.memberships.find(office, withoutTestAccounts({ status: 'active' }), {
      projection: { userId: 1, role: 1, isCoreLeader: 1, adminAccess: 1 },
    });
    const names = await this.namesOf(rows.map((m) => String(m.userId)));
    const person = (m: (typeof rows)[number]): ConsolePerson => ({
      membershipId: String(m._id),
      userId: String(m.userId),
      fullName: names.get(String(m.userId)) ?? '',
      class: (m.role as PersonClass) ?? 'agent',
    });
    const byClassThenName = (a: ConsolePerson, b: ConsolePerson) =>
      (CLASS_ORDER[a.class] ?? 3) - (CLASS_ORDER[b.class] ?? 3) || a.fullName.localeCompare(b.fullName);
    const people = rows.map(person).sort(byClassThenName);

    const ownerRow = kpm.ownerUserId ? rows.find((m) => String(m.userId) === kpm.ownerUserId) ?? null : null;
    const owner = ownerRow ? person(ownerRow) : null;
    const admins = rows.filter((m) => m.adminAccess?.isKpmAdmin === true && String(m.userId) !== kpm.ownerUserId)
      .map(person).sort(byClassThenName);
    const coreLeaders = rows.filter((m) => isEffectiveCoreLeader(m)).map(person).sort(byClassThenName);

    // *Anggota*'s first five: leaders first, then by name — each with their informal group and the days since they
    // last used the app (`usageOf`, the KPM's today).
    const first = people.slice(0, CONSOLE.LANDING_MEMBERS);
    const [partition, readings] = await Promise.all([
      this.groups.partition(office),
      this.activity.usageOf(office, first.map((p) => p.membershipId), this.clock.localDateFor(kpm.timezone)),
    ]);
    const groupName = new Map(partition.groups.map((g) => [g.groupId, g.name]));

    return {
      kpm: {
        kpmId, name: kpm.branchName, code: kpm.code, companyId: kpm.companyId, companyName: kpm.companyName, status: kpm.status,
      },
      owner: { state: kpm.ownerState, person: owner, pendingName: kpm.pendingOwner?.fullName ?? null },
      admins,
      coreLeaders,
      members: {
        total: people.length,
        leaders: people.filter((p) => p.class !== 'agent').length,
        agents: people.filter((p) => p.class === 'agent').length,
        first: first.map((p) => {
          const placed = partition.placement.groupOf.get(p.membershipId) ?? null;
          return {
            ...p,
            groupName: placed ? groupName.get(placed) ?? null : null,
            lastUsedDays: readings.get(p.membershipId)?.daysSinceLastLogged ?? null,
            // The pill's colour, the server's bucket (`USAGE.RECENT_MAX_DAYS`): the page keeps no threshold of its own.
            lastUsedStatus: readings.get(p.membershipId)?.status ?? 'never',
          };
        }),
      },
      viewAs: {
        owner: owner ? [owner] : [],
        admin: admins,
        ab: people.filter((p) => p.class === 'ab'),
        agent: people.filter((p) => p.class === 'agent'),
      },
    };
  }

  private async namesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return new Map();
    const rows = await this.users.find({ _id: { $in: ids } }).select('fullName').lean().exec() as { _id: unknown; fullName: string }[];
    return new Map(rows.map((u) => [String(u._id), u.fullName]));
  }
}

/** A reading added to an audience's counts. A member with no reading is one who never logged anything. */
function tally(into: UsageCounts, reading: UsageReading | undefined): void {
  into.members += 1;
  if (!reading) return;
  if (reading.everLogged) into.everUsed += 1;
  if (reading.usedLast14Days) into.used14 += 1;
  if (reading.powerUser) into.powerUsers += 1;
}

/**
 * **A KPM's issues** (ADR-0277 §2), in `KPM_ISSUES`' order. A suspended or archived KPM says only that: the Super Admin
 * set it, and nothing in it can be acted on until it is undone.
 */
export function issuesOf(
  kpm: Pick<KpmAdminView, 'status' | 'ownerState' | 'membersBesidesOwner'>, subscriptionEnded: boolean, missingMonth: string | null,
): KpmIssue[] {
  if (kpm.status === 'suspended') return ['suspended'];
  if (kpm.status === 'archived') return ['archived'];
  const issues: KpmIssue[] = [];
  if (subscriptionEnded) issues.push('subscription_ended');
  if (kpm.ownerState === 'none' || kpm.ownerState === 'not_invited') issues.push('owner_not_invited');
  if (kpm.membersBesidesOwner === 0) issues.push('no_members');
  if (missingMonth !== null) issues.push('data_missing');
  return issues;
}

/** The same day a calendar month earlier, clamped to that month's last day (`2026-03-31` → `2026-02-28`). */
export function monthBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return out;
}
