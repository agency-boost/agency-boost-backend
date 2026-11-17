import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { holdsGrant } from '@/modules/rbac/permissions';
import { Kpm } from '@/modules/tenants/kpm.schema';
import { PRODUCT_DATA_REFUSALS } from './product-data.messages';

/**
 * **Who may read and who may manage an insurer's proposal data** (P19.15-T4; ADR-0258 §9; the P1b spec's *Who can do
 * what*). One answer for every route under `/product-data/companies/:companyId/…`, asked after the guard's permission
 * (`product_data:read`, `product_data:manage`) — the permission says *what kind of person*, this says *for which
 * company*.
 *
 * - **Super Admin**: every company, read and manage.
 * - **A KPM Owner or Admin**: their own KPM's company, **read only** — status, dates, which products calculate.
 * - **A holder of *Kelola data produk*** (D2, ADR-0260): read and manage for the companies ticked for them.
 * - **A view-as session** reads as the member it views and manages nothing (ADR-0206 §4).
 *
 * A company the reader may not read is `404` — its existence is not confirmed — and one they may read but not manage is
 * `403 PERM_DENIED` on a write.
 */
@Injectable()
export class ProductDataAccess {
  constructor(
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<Kpm>,
  ) {}

  /** May `ctx` read `companyId`'s proposal data? */
  async canRead(ctx: RequestContext, companyId: string): Promise<boolean> {
    if (!(await this.exists(companyId))) return false;
    if (ctx.isSuperAdmin) return true;
    if (await this.ownCompany(ctx) === companyId) return true;
    return (await this.grantedCompanies(ctx)).includes(companyId);
  }

  /** May `ctx` change `companyId`'s proposal data? Never in a view-as session. */
  async canManage(ctx: RequestContext, companyId: string): Promise<boolean> {
    if (ctx.impersonationReadOnly || ctx.isImpersonating) return false;
    if (!(await this.exists(companyId))) return false;
    if (ctx.isSuperAdmin) return true;
    return (await this.grantedCompanies(ctx)).includes(companyId);
  }

  /** `404` unless `ctx` may read `companyId`. */
  async assertRead(ctx: RequestContext, companyId: string): Promise<void> {
    if (!(await this.canRead(ctx, companyId))) throw new NotFoundException('Company');
  }

  /** `404` unless `ctx` may read `companyId`; `403 PERM_DENIED` when they may read it and not manage it. */
  async assertManage(ctx: RequestContext, companyId: string): Promise<void> {
    await this.assertRead(ctx, companyId);
    if (!(await this.canManage(ctx, companyId))) {
      throw new DomainException(ErrorCode.PERM_DENIED, PRODUCT_DATA_REFUSALS.PERM_DENIED.readOnly, HttpStatus.FORBIDDEN);
    }
  }

  /**
   * **The companies `ctx` holds *Kelola data produk* for** (ADR-0260 §2; P19.15-T4 AC-2): the companies their live grant
   * ticks, as `ContextResolver` read it on this request — so a grant removed or changed is in force from the next
   * request — and only while they hold it: an active KPM Owner or KPM Admin (`holdsGrant`, the `grant` grantee's own
   * test). Anybody else, none. Kept here so every route asks one place.
   */
  protected async grantedCompanies(ctx: RequestContext): Promise<string[]> {
    return holdsGrant(ctx, 'product_data') ? [...ctx.productDataCompanyIds] : [];
  }

  /** The reader's own KPM's company, for an Owner or an Admin; `null` for anyone else. */
  private async ownCompany(ctx: RequestContext): Promise<string | null> {
    const member = ctx.membership;
    if (!member || member.status === 'removed' || !(member.isKpmOwner || member.isKpmAdmin)) return null;
    const kpm = await this.kpms.findById(member.kpmId).select('companyId').lean().exec();
    return (kpm as { companyId?: string } | null)?.companyId ?? null;
  }

  private async exists(companyId: string): Promise<boolean> {
    if (!isValidObjectId(companyId)) return false;
    return (await this.companies.exists({ _id: companyId, deletedAt: null }).exec()) !== null;
  }
}
