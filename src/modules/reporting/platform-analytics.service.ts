import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { rollingWindow } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, PERIOD } from '@/domain/constants';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { INSURERS_ONLY } from '@/modules/tenants/template-library';
import { OrgLevelService, type OrgLevelRow } from '@/modules/tenants/org-level.service';
import { subscriptionStateOf } from '@/modules/tenants/subscription';
import type { RungCount } from './kpm-overview.service';
import { rungsFor } from './office-people';

/** Adoption, counted: composition by rung, who joined and left this month, who signed in lately. */
export interface Adoption {
  members: number;
  byRung: RungCount[];
  joinedThisMonth: number;
  leftThisMonth: number;
  signedIn7d: number;
  signedIn30d: number;
}

/** An office's state as *All KPMs* lists it: its status, or the subscription's end over an active office. */
export type OfficeState = 'active' | 'suspended' | 'archived' | 'ended' | 'ended_kept_active';

export interface PlatformAnalyticsView {
  /** The calendar month *joined* and *left* count, in the platform's zone (ADR-0016: one zone in v1). */
  month: string;
  offices: (Adoption & {
    kpmId: string; code: string; branch: string; company: { id: string; name: string }; state: OfficeState;
  })[];
  companies: (Adoption & { id: string; name: string; offices: number })[];
  platform: Adoption & { offices: number; companies: number };
}

/**
 * ***Cross-platform analytics*** (Phase 18, P18-T8; OD-148 → option 1, D-admin): adoption across offices,
 * **inside ADR-0011's line** — composition is in, business data is out. Per office, per company and for the
 * platform: active members by rung, joined and left this month, signed in within 7 and 30 days.
 *
 * - **A Super Admin, and nobody else, before anything is read** — not even the operator inside a support session,
 *   who is acting as an office's member there. The guard refuses the same; the check here is the service's own, so
 *   the guarantee does not rest on how the route happens to be wired.
 * - **Every cross-office figure through a named unscoped repository method** (invariant §1), each listed in
 *   `named-cross-tenant-reads.tenancy.spec.ts`: `MembershipRepository.adoptionPerOfficeAcrossTenants`,
 *   `.signInsPerOfficeAcrossTenants` and `.distinctAccountsAcrossTenants`, each refusing anybody but a Super Admin.
 *   The offices, the companies and their ladders are platform records, read as `TenantService` reads them.
 * - **An office row counts memberships; a company's and the platform's count people** (the exit review, item 6):
 *   *Members* and both *Signed in* columns are distinct accounts there, so a person in two offices is two
 *   memberships, one in each office's row, and one account in the company's and the platform's. *By rung*, *joined*
 *   and *left* stay the offices' sums: a rung is held per membership, and a join or a removal is an office's event.
 * - **Aggregates only**: no membership id, no name, no lead, activity, coaching or production figure — a
 *   field-by-field test says so (exit test 4). No audit entry, as `/admin`'s counts write none.
 * - **A member of a suspended or ended office counts as the office does**, and the office's state is shown as
 *   *All KPMs* shows it.
 */
@Injectable()
export class PlatformAnalyticsService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly memberships: MembershipRepository,
    private readonly orgLevels: OrgLevelService,
    private readonly clock: Clock,
  ) {}

  async read(ctx: RequestContext): Promise<PlatformAnalyticsView> {
    if (!ctx.isSuperAdmin || ctx.isImpersonating) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You do not have permission to perform this action.',
        HttpStatus.FORBIDDEN,
        { permission: 'platform_analytics:read' },
      );
    }
    const timezone = DEFAULT_TENANT_TIMEZONE;
    const today = this.clock.localDateFor(timezone);
    const month = today.slice(0, 7);
    const since = (days: number) => this.clock.startOfLocalDay(timezone, rollingWindow(today, days).from);
    const signedInSince = { days7: since(PERIOD.ROLLING_7D_DAYS), days30: since(PERIOD.ROLLING_30D_DAYS) };

    const [kpms, companies, adoption, signIns] = await Promise.all([
      this.kpms.find({ deletedAt: null }).select('code branchName companyId status subscription timezone').lean().exec(),
      // The insurers: the Template library holds templates and no office (ADR-0164 §3).
      this.companies.find({ deletedAt: null, ...INSURERS_ONLY }).select('name').sort({ name: 1 }).lean().exec(),
      this.memberships.adoptionPerOfficeAcrossTenants(ctx, this.clock.monthBounds(timezone, month)),
      this.memberships.signInsPerOfficeAcrossTenants(ctx, signedInSince),
    ]);
    const [ladders, accounts] = await Promise.all([
      this.orgLevels.laddersByCompany(companies.map((c) => String(c._id))),
      this.memberships.distinctAccountsAcrossTenants(
        ctx, kpms.map((kpm) => ({ kpmId: String(kpm._id), companyId: kpm.companyId })), signedInSince,
      ),
    ]);
    const companyName = new Map(companies.map((c) => [String(c._id), (c as { name: string }).name]));

    const rungCounts = new Map<string, Map<string, number>>();
    for (const row of adoption.byRung) {
      const counts = rungCounts.get(row.kpmId) ?? new Map<string, number>();
      counts.set(row.orgLevelCode, row.n);
      rungCounts.set(row.kpmId, counts);
    }
    const adoptionOf = (kpmId: string, ladder: readonly OrgLevelRow[]): Adoption => {
      const counts = rungCounts.get(kpmId) ?? new Map<string, number>();
      const signedIn = signIns.get(kpmId);
      return {
        members: [...counts.values()].reduce((n, c) => n + c, 0),
        byRung: rungsFor(ladder, [...counts.keys()]).map((rung) => ({ ...rung, count: counts.get(rung.code) ?? 0 })),
        joinedThisMonth: adoption.joined.get(kpmId) ?? 0,
        leftThisMonth: adoption.left.get(kpmId) ?? 0,
        signedIn7d: signedIn?.signedIn7d ?? 0,
        signedIn30d: signedIn?.signedIn30d ?? 0,
      };
    };

    const offices = (kpms as unknown as (KpmDocument & { _id: unknown })[])
      .map((kpm) => {
        const companyId = kpm.companyId;
        return {
          kpmId: String(kpm._id),
          code: kpm.code,
          branch: kpm.branchName,
          company: { id: companyId, name: companyName.get(companyId) ?? '' },
          state: stateOf(kpm, this.clock),
          ...adoptionOf(String(kpm._id), ladders.get(companyId) ?? []),
        };
      })
      .sort((a, b) => a.company.name.localeCompare(b.company.name) || a.code.localeCompare(b.code));

    const companyRows = companies.map((company) => {
      const id = String(company._id);
      const theirs = offices.filter((o) => o.company.id === id);
      return {
        id, name: companyName.get(id)!, offices: theirs.length, ...sumOf(theirs, ladders.get(id) ?? []),
        // People, not memberships (item 6): a company with no member in any office counts nobody.
        ...(accounts.companies.get(id) ?? { members: 0, signedIn7d: 0, signedIn30d: 0 }),
      };
    });
    // The platform's rungs: every company's, in the order the companies' ladders give them, senior first.
    const platformLadder = [...ladders.values()].flat();
    return {
      month,
      offices,
      companies: companyRows,
      platform: { offices: offices.length, companies: companyRows.length, ...sumOf(offices, platformLadder), ...accounts.platform },
    };
  }
}

/** *All KPMs*' Status (`tenantStatusWord`): an active office past its subscription's end reads as ended. */
export function stateOf(kpm: Pick<KpmDocument, 'status' | 'subscription' | 'timezone'>, clock: Clock): OfficeState {
  if (kpm.status !== 'active') return kpm.status;
  const subscription = subscriptionStateOf(kpm, clock);
  return subscription === 'ended' || subscription === 'ended_kept_active' ? subscription : 'active';
}

/**
 * The rollup rule over adoption: each count summed; rungs grouped by code, in the order the ladders give them, senior
 * first — **labelled by the label the ladders share, or by the code where two companies label it differently**.
 */
export function sumOf(rows: readonly Adoption[], ladder: readonly OrgLevelRow[]): Adoption {
  const byCode = new Map<string, number>();
  const labels = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const rung of row.byRung) {
      byCode.set(rung.code, (byCode.get(rung.code) ?? 0) + rung.count);
      labels.set(rung.code, (labels.get(rung.code) ?? new Set()).add(rung.label));
    }
  }
  for (const level of ladder) labels.set(level.code, (labels.get(level.code) ?? new Set()).add(level.label));
  const named = new Map<string, OrgLevelRow>();
  for (const level of ladder) if (!named.has(level.code)) named.set(level.code, level);
  const sum = (key: 'members' | 'joinedThisMonth' | 'leftThisMonth' | 'signedIn7d' | 'signedIn30d') =>
    rows.reduce((n, row) => n + row[key], 0);
  return {
    members: sum('members'),
    byRung: rungsFor([...named.values()], [...byCode.keys()]).map((rung) => {
      // Every rung here is one a row or the ladder named, so it has a label.
      const said = labels.get(rung.code)!;
      return { code: rung.code, label: said.size === 1 ? [...said][0] : rung.code, count: byCode.get(rung.code) ?? 0 };
    }),
    joinedThisMonth: sum('joinedThisMonth'),
    leftThisMonth: sum('leftThisMonth'),
    signedIn7d: sum('signedIn7d'),
    signedIn30d: sum('signedIn30d'),
  };
}
