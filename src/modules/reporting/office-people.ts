import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipStatus } from '@/modules/org/membership.schema';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService, type OrgLevelRow } from '@/modules/tenants/org-level.service';

/** A membership as the Owner's reporting reads it: where they stand, and when they were here. */
export interface OfficePerson {
  membershipId: string;
  orgLevelCode: string;
  leaderId: string | null;
  ancestorIds: string[];
  status: MembershipStatus;
  joinedAt: Date | null;
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
 * repository, with the names of the active ones in two more (`MemberNames`), whatever the office's size.
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

  async read(ctx: RequestContext, leaversSince: Date | null): Promise<{
    /** Active, and removed since `leaversSince`. */
    everyone: OfficePerson[];
    active: OfficePerson[];
    names: Map<string, string>;
  }> {
    const rows = await this.memberships.find(
      ctx,
      leaversSince === null
        ? { status: 'active' }
        : { $or: [{ status: 'active' }, { status: 'removed', removedAt: { $gte: leaversSince } }] },
      { projection: { orgLevelCode: 1, leaderId: 1, ancestorIds: 1, status: 1, joinedAt: 1, removedAt: 1 } },
    );
    const everyone = rows.map((row): OfficePerson => ({
      membershipId: String(row._id),
      orgLevelCode: row.orgLevelCode,
      leaderId: row.leaderId ?? null,
      // Hydrated with the schema's default, `[]`, where a row predates the cache.
      ancestorIds: [...row.ancestorIds],
      status: row.status,
      joinedAt: row.joinedAt ?? null,
      removedAt: row.removedAt ?? null,
    }));
    const active = everyone.filter((p) => p.status === 'active');
    const names = await this.names.byMembershipId(ctx, active.map((p) => p.membershipId));
    return { everyone, active, names };
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
