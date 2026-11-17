import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { PermissionDeniedException } from '@/common/errors/domain.exception';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { INSURERS_ONLY } from '@/modules/tenants/template-library';
import { ProductDataAccess } from './product-data-access.service';

/** One company the reader may open on *Data produk*: full (`canManage`) or read-only. */
export interface ReadableCompany {
  companyId: string;
  name: string;
  canManage: boolean;
  /** The company of the reader's own KPM. */
  own: boolean;
}

export interface ReadableCompanies {
  items: ReadableCompany[];
}

/** A 24-character hex id. */
const isObjectId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

/**
 * ***Data produk*'s companies** (ADR-0260 §5; P19.15-T4 AC-2, AC-3): `GET /product-data/companies`, what the tenant page
 * `/kpm/data-produk` mounts the company *Proposal* tab for — the reader's own KPM's company, read-only unless their
 * *Kelola data produk* ticks it, and every insurer it ticks, in full. The Super Admin, every insurer. Each answer is
 * `ProductDataAccess`'s, so the list and each route under `/product-data/companies/:companyId` agree on every company.
 *
 * Read on each visit, from the grant as the request resolved it: a grant removed since the page loaded answers the
 * own company alone, read-only, and the screen reads the session again so *Data produk* leaves the menu.
 */
@Injectable()
export class ProductDataCompaniesService {
  constructor(
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly access: ProductDataAccess,
  ) {}

  async readable(ctx: RequestContext): Promise<ReadableCompanies> {
    if (!can(ctx, 'product_data:read')) throw new PermissionDeniedException('product_data:read');
    const own = await this.ownCompanyOf(ctx);
    const filter = ctx.isSuperAdmin
      ? { deletedAt: null, ...INSURERS_ONLY }
      : { _id: { $in: [own, ...ctx.productDataCompanyIds].filter(isObjectId) }, deletedAt: null, ...INSURERS_ONLY };
    const rows = await this.companies.find(filter, { name: 1 }).lean().exec() as { _id: unknown; name: string }[];

    const items: ReadableCompany[] = [];
    for (const row of rows) {
      const companyId = String(row._id);
      if (!(await this.access.canRead(ctx, companyId))) continue;
      items.push({ companyId, name: row.name, canManage: await this.access.canManage(ctx, companyId), own: companyId === own });
    }
    items.sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
    return { items };
  }

  /** The company of the reader's KPM, or `null` — a Super Admin is in none. */
  private async ownCompanyOf(ctx: RequestContext): Promise<string | null> {
    if (!ctx.kpmId || !isObjectId(ctx.kpmId)) return null;
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }, { companyId: 1 }).lean().exec() as
      { companyId?: string | null } | null;
    return kpm?.companyId ? String(kpm.companyId) : null;
  }
}
