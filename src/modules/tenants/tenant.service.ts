import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
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
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly hierarchy: HierarchyService,
    private readonly memberships: MembershipRepository,
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
   *
   * **The person is resolved before anything is written.** An earlier version took a
   * user id on trust and stored it, so an office could be left pointing at an account
   * that does not exist — permanently, with nothing to notice it, and with nobody able
   * to administer the office. The console's screen asserted a "user not found" error
   * the service never produced; the API test and the screen test each passed against a
   * contract the other did not implement.
   *
   * Identified by **email or id**. Email is what a Super Admin actually knows and is
   * what §6.1 of roles-and-permissions.md describes; the id is kept because Swagger and
   * the seed output give you one.
   */
  async assignOwner(
    ctx: RequestContext,
    kpmId: string,
    who: { userId?: string; email?: string },
  ): Promise<KpmDocument> {
    this.require(ctx, 'kpm:assign_owner');

    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');

    const user = await this.resolveOwner(who);

    const previousOwnerUserId = kpm.ownerUserId;
    kpm.ownerUserId = String(user._id);
    await kpm.save();

    // An Owner who is not a member cannot be resolved into the office, so nothing they
    // own is reachable. §6.1 of roles-and-permissions.md creates this on first login;
    // creating it here instead means the office is administrable the moment it is
    // assigned, rather than the first time someone happens to sign in.
    await this.ensureOwnerMembership(ctx, kpmId, String(user._id));

    await this.audit.record(ctx, {
      action: previousOwnerUserId ? 'kpm.owner_transferred' : 'kpm.owner_assigned',
      targetCollection: 'kpms',
      targetId: kpmId,
      before: { ownerUserId: previousOwnerUserId },
      after: { ownerUserId: String(user._id), email: user.email },
    });

    return kpm;
  }

  /**
   * The Owner's own membership: an AB at the root of the office's tree.
   *
   * Idempotent, because a transfer back to a previous owner must not mint a second row —
   * the partial unique index would reject it, and the right answer is the row they
   * already have. Their hierarchy role is left alone if they are already a member:
   * an office may promote its Owner's account through the ranks like anyone else's.
   */
  private async ensureOwnerMembership(
    ctx: RequestContext,
    kpmId: string,
    userId: string,
  ): Promise<void> {
    const scoped = ctx.kpmId === kpmId
      ? ctx
      : RequestContext.superAdminInTenant(ctx.auditActors.actorUserId, kpmId);

    const existing = await this.memberships.findOne(scoped, {
      userId,
      status: { $in: ['active', 'pending'] },
    });
    if (existing) {
      if (existing.status !== 'active') {
        await this.memberships.updateById(scoped, String(existing._id), {
          $set: { status: 'active', joinedAt: this.clock.now() },
        });
      }
      return;
    }

    await this.hierarchy.create(scoped, { userId, role: 'ab', leaderId: null, status: 'active' });
  }

  private async resolveOwner(who: { userId?: string; email?: string }): Promise<UserDocument> {
    const email = who.email?.toLowerCase().trim();
    if (!who.userId && !email) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Name the new owner by email or by user id.',
        HttpStatus.BAD_REQUEST,
        { fields: ['email', 'userId'] },
      );
    }

    // An id that is not a valid ObjectId would make Mongoose throw a CastError, which
    // surfaces as a 500. It is a caller mistake, so it is a 404 like any other unknown.
    const byId =
      who.userId && isValidObjectId(who.userId)
        ? await this.users.findOne({ _id: who.userId, deletedAt: null }).exec()
        : null;
    const user = byId ?? (email ? await this.users.findOne({ email, deletedAt: null }).exec() : null);

    if (!user) throw new NotFoundException('User');

    if (user.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'That account is deactivated and cannot own an office.',
        HttpStatus.BAD_REQUEST,
        { userId: String(user._id) },
      );
    }
    return user;
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
