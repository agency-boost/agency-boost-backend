import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext, type HierarchyRole } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument, MembershipStatus } from '@/modules/org/membership.schema';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService, type OrgLevelRow } from '@/modules/tenants/org-level.service';

/** A membership as the Owner's reporting reads it: where they stand, and when they were here. */
export interface OfficePerson {
  membershipId: string;
  orgLevelCode: string;
  /** The class, from the rung's leader tier (ADR-0156): what the agency and unit partitions read. */
  role: HierarchyRole;
  leaderId: string | null;
  ancestorIds: string[];
  status: MembershipStatus;
  /** The system's stamp: when the membership was made active. A headcount reads it only where `joinDate` is null. */
  joinedAt: Date | null;
  /** ***Join date***, the office date their leader gave (ADR-0169 §1); `null` on a row older than the field. */
  joinDate: LocalDate | null;
  /**
   * **The instant `joinDate` begins in the office's zone** — what `OFFICE_HEADCOUNT`, `memberAt` and `belongedDuring`
   * count from (ADR-0172 §1); `null` with no join date, which counts from `joinedAt`.
   */
  joinDateStart: Date | null;
  removedAt: Date | null;
}

/** The office as its console names it: *"{company} · KPM {code} — {branch}"* (`KPM_Owner.html:933`). */
export interface OfficeHeader {
  companyName: string;
  code: string;
  branch: string;
}

/**
 * **The office's people, read once per report** (Phase 18, D-api): every active membership, and the ones removed
 * since a day — a leaver's production stays the office's (OD-74) — in **one** read through the tenant-scoped
 * repository, with the names of the active ones in one more — the users behind the rows read
 * (`MemberNames.byReadMemberships`; two more until 2026-10-29, the memberships read again whole) — whatever the
 * office's size; `everyone` is the one read alone, for a reader that names nobody.
 *
 * **Each with the instant their join date begins** (ADR-0172 §1, P18.8-T5 AC-1), in the office's zone (invariant §9),
 * so every count of people it feeds counts a member from the day they joined rather than the day the system let them
 * in. A caller that holds the office's zone passes it; one that does not costs one read of the office's row.
 */
@Injectable()
export class OfficePeople {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    /** The office's own row, by `_id` from the context: the scope is the id (`repositories.tenancy.spec.ts`). */
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly orgLevels: OrgLevelService,
    private readonly clock: Clock,
  ) {}

  /** The office's company's ladder, archived rungs included; none for an office whose row names no company. */
  async ladder(ctx: RequestContext, companyId: string | null): Promise<OrgLevelRow[]> {
    return companyId ? this.orgLevels.list(ctx, companyId) : [];
  }

  /** The caller's membership, or `TENANT_NO_MEMBERSHIP`: a Super Admin outside a support session reads no office. */
  static require(ctx: RequestContext): string {
    if (!ctx.membershipId || !ctx.kpmId) throw new NoMembershipException();
    return ctx.membershipId;
  }

  /**
   * **A reader of KPM analytics** (ADR-0159 §2, P18.5-T5 AC-4): the Owner, an Admin, or a **Core Leader** — tagged,
   * on a leader rung, as the context reads it on every request. Any other member of the office holding the grant —
   * an AB or an AAB not tagged — is answered **`404 NOT_FOUND`**, the forum's rule: the refusal does not say there
   * is a reading they are kept from. `TENANT_NO_MEMBERSHIP` first, as `require`.
   */
  /**
   * **A platform read of one KPM** (ADR-0207 §4; P19.4-T3): the Super Admin, the office named, no membership, read-only
   * (`RequestContext.platformRead`) — what every `…ForOffice` read asks before it runs the KPM's own functions. Anything
   * else is refused as a read with no office is: `TENANT_NO_MEMBERSHIP`. The route's own guard has already asked for
   * `platform_kpm_figures:read` or `platform_members:read`; this is the second wall, so the method cannot be reached
   * with a member's context, or a writable one.
   */
  static requirePlatformRead(ctx: RequestContext): string {
    if (!ctx.isPlatformRead || !ctx.kpmId) throw new NoMembershipException();
    return ctx.kpmId;
  }

  static requireAnalyticsReader(ctx: RequestContext): string {
    const me = OfficePeople.require(ctx);
    const office = ctx.membership?.isKpmOwner === true || ctx.membership?.isKpmAdmin === true;
    if (!office && !ctx.isCoreLeader) throw new NotFoundException('KPM analytics');
    return me;
  }

  async read(ctx: RequestContext, leaversSince: Date | null, timezone?: string): Promise<{
    /** Active, and removed since `leaversSince`. */
    everyone: OfficePerson[];
    active: OfficePerson[];
    names: Map<string, string>;
  }> {
    const rows = await this.rows(ctx, leaversSince, timezone);
    const everyone = rows.map(({ person }) => person);
    const active = everyone.filter((p) => p.status === 'active');
    // The active members' names from the rows just read (2026-10-29): the users alone, where `byMembershipId` read
    // every one of the memberships again, whole, for its `userId`.
    const names = await this.names.byReadMemberships(rows.filter(({ person }) => person.status === 'active').map(({ row }) => row));
    return { everyone, active, names };
  }

  /**
   * **`read`'s people without their names** — the one read of the memberships, and of the office's zone where none is
   * given — for a reader that names nobody: the forum's scorecard counts and sums the office's people, and the two name
   * reads it made beside them hydrated every one of a 500-member office's memberships whole, for nothing (2026-10-28).
   */
  async everyone(ctx: RequestContext, leaversSince: Date | null, timezone?: string): Promise<OfficePerson[]> {
    return (await this.rows(ctx, leaversSince, timezone)).map(({ person }) => person);
  }

  /** The one read of the memberships, each row with the person it is — and the `userId` that names it (`read`). */
  private async rows(
    ctx: RequestContext, leaversSince: Date | null, timezone?: string,
  ): Promise<{ row: MembershipDocument; person: OfficePerson }[]> {
    const [rows, zone] = await Promise.all([
      this.memberships.find(
        ctx,
        leaversSince === null
          ? { status: 'active' }
          : { $or: [{ status: 'active' }, { status: 'removed', removedAt: { $gte: leaversSince } }] },
        {
          projection: {
            orgLevelCode: 1, role: 1, leaderId: 1, ancestorIds: 1, status: 1, joinedAt: 1, joinDate: 1, removedAt: 1, userId: 1,
          },
        },
      ),
      timezone === undefined ? this.timezoneOf(ctx) : Promise.resolve(timezone),
    ]);
    return rows.map((row) => ({ row, person: this.personOf(row, zone) }));
  }

  private personOf(row: MembershipDocument, zone: string): OfficePerson {
    return {
      membershipId: String(row._id),
      orgLevelCode: row.orgLevelCode,
      role: row.role,
      leaderId: row.leaderId ?? null,
      // Hydrated with the schema's default, `[]`, where a row predates the cache.
      ancestorIds: [...row.ancestorIds],
      status: row.status,
      joinedAt: row.joinedAt ?? null,
      joinDate: row.joinDate ?? null,
      joinDateStart: row.joinDate ? this.clock.startOfLocalDay(zone, row.joinDate) : null,
      removedAt: row.removedAt ?? null,
    };
  }

  /** The office's zone (`kpms.timezone`), or the platform default for a row that names none — `TenantDay.timezoneOf`. */
  private async timezoneOf(ctx: RequestContext): Promise<string> {
    const kpm = await this.kpms.findById(ctx.kpmId).select('timezone').lean().exec();
    return (kpm as { timezone?: string } | null)?.timezone ?? DEFAULT_TENANT_TIMEZONE;
  }

  /** The office's name parts. An office with no company row reads an empty company name rather than failing. */
  async header(ctx: RequestContext): Promise<OfficeHeader> {
    const kpm = await this.kpms.findById(ctx.kpmId).select('code branchName companyId').lean().exec();
    const office = kpm as { code?: string; branchName?: string; companyId?: string } | null;
    const company = office?.companyId
      ? await this.companies.findById(office.companyId).select('name').lean().exec()
      : null;
    return {
      companyName: (company as { name?: string } | null)?.name ?? '',
      code: office?.code ?? '',
      branch: office?.branchName ?? '',
    };
  }
}

/**
 * **The company's rungs, senior first**, as the prototype draws its tiles (*Agency Builders*, *Associate AB*,
 * *Agents*, `KPM_Owner.html:944-962`), labelled by the ladder; an archived rung only while somebody still
 * stands on it, and a code no rung names under its own code — so the tiles always add up to the people.
 */
export function rungsFor(ladder: readonly OrgLevelRow[], codes: readonly string[]): { code: string; label: string }[] {
  const standing = new Set(codes);
  const known = [...ladder]
    .sort((a, b) => b.displayOrder - a.displayOrder)
    .filter((level) => level.status === 'active' || standing.has(level.code))
    .map((level) => ({ code: level.code, label: level.label }));
  const named = new Set(known.map((rung) => rung.code));
  const unnamed = [...standing].filter((code) => !named.has(code)).sort().map((code) => ({ code, label: code }));
  return [...known, ...unnamed];
}
