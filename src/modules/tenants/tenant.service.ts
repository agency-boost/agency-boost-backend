import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from './company.schema';
import { DEFAULT_KPM_SETTINGS, Kpm, KpmDocument } from './kpm.schema';

export interface CreateKpmInput {
  companyId: string;
  code: string;
  branchName: string;
  address?: string;
  contactPhone?: string;
  timezone?: string;
  locale?: string;
  currency?: string;
}

/**
 * Tenant provisioning. A KPM comes into existence only here, and only for a Super
 * Admin — the single hard requirement in ADR-0005.
 *
 * These are platform-level operations, so they do not go through the tenant-scoped
 * repository: there is no tenant yet to scope to. The permission check is therefore
 * the only gate, which is why it is explicit at the top of every method.
 */
@Injectable()
export class TenantService {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private require(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
    if (!can(ctx, permission)) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You do not have permission to perform this action.',
        HttpStatus.FORBIDDEN,
        { permission },
      );
    }
  }

  async createKpm(ctx: RequestContext, input: CreateKpmInput): Promise<KpmDocument> {
    this.require(ctx, 'kpm:create');

    const company = await this.companies.findOne({ _id: input.companyId, deletedAt: null }).exec();
    if (!company) throw new NotFoundException('Company');

    const clash = await this.kpms
      .findOne({ companyId: input.companyId, code: input.code, deletedAt: null })
      .exec();
    if (clash) {
      throw new DomainException(
        ErrorCode.TENANT_CODE_TAKEN,
        `KPM code ${input.code} is already used by ${company.name}.`,
        HttpStatus.CONFLICT,
        { companyId: input.companyId, code: input.code },
      );
    }

    const kpm = await this.kpms.create({
      companyId: input.companyId,
      code: input.code,
      branchName: input.branchName,
      address: input.address ?? null,
      contactPhone: input.contactPhone ?? null,
      // The office inherits its company's defaults unless told otherwise.
      timezone: input.timezone ?? company.defaultTimezone,
      locale: input.locale ?? company.defaultLocale,
      currency: input.currency ?? company.defaultCurrency,
      settings: { ...DEFAULT_KPM_SETTINGS },
      counters: { nextAgentCodeSeq: 1 },
      status: 'active',
      ownerUserId: null,
      deletedAt: null,
    });

    await this.audit.record(ctx, {
      action: 'kpm.created',
      targetCollection: 'kpms',
      targetId: String(kpm._id),
      after: { code: kpm.code, branchName: kpm.branchName, companyId: kpm.companyId },
    });

    return kpm;
  }

  /**
   * Assign or transfer the Owner. Both are Super Admin only, and both are audited with
   * the outgoing and incoming user, because ownership is what makes every other
   * tenant-admin grant possible.
   */
  async assignOwner(ctx: RequestContext, kpmId: string, userId: string): Promise<KpmDocument> {
    this.require(ctx, 'kpm:assign_owner');

    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');

    const previousOwnerUserId = kpm.ownerUserId;
    kpm.ownerUserId = userId;
    await kpm.save();

    await this.audit.record(ctx, {
      action: previousOwnerUserId ? 'kpm.owner_transferred' : 'kpm.owner_assigned',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { ownerUserId: previousOwnerUserId },
      after: { ownerUserId: userId },
    });

    return kpm;
  }

  /**
   * A tenant may not be left ownerless. Clearing the owner without naming a successor
   * would leave nobody able to grant admin access or edit branch info.
   */
  async clearOwner(ctx: RequestContext, kpmId: string): Promise<never> {
    this.require(ctx, 'kpm:assign_owner');
    throw new DomainException(
      ErrorCode.PERM_LAST_OWNER,
      'A KPM must always have an Owner. Transfer ownership instead of removing it.',
      HttpStatus.CONFLICT,
      { kpmId },
    );
  }

  async setStatus(
    ctx: RequestContext,
    kpmId: string,
    status: 'active' | 'suspended' | 'archived',
    reason?: string,
  ): Promise<KpmDocument> {
    this.require(ctx, status === 'suspended' ? 'kpm:suspend' : 'kpm:activate');

    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');

    const before = kpm.status;
    kpm.status = status;
    kpm.suspendedAt = status === 'suspended' ? this.clock.now() : null;
    kpm.suspendedReason = status === 'suspended' ? (reason ?? null) : null;
    await kpm.save();

    await this.audit.record(ctx, {
      action: `kpm.${status}`,
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { status: before },
      after: { status, reason: reason ?? null },
    });

    return kpm;
  }

  async listAll(ctx: RequestContext): Promise<KpmDocument[]> {
    this.require(ctx, 'kpm:list_all');
    return this.kpms.find({ deletedAt: null }).sort({ createdAt: -1 }).exec();
  }

  /** A tenant's own profile. Readable by its Owner and Admins as well as Super Admin. */
  async readProfile(ctx: RequestContext, kpmId: string): Promise<KpmDocument> {
    this.require(ctx, 'kpm:read_profile');

    // A non-Super-Admin may only read the office they belong to. Returning 404 rather
    // than 403 keeps the existence of other tenants unobservable.
    if (!ctx.isSuperAdmin && ctx.kpmId !== kpmId) throw new NotFoundException('KPM');

    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');
    return kpm;
  }
}
