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

/** One row of the console's `Needs your attention` queue (`Superadmin.html:232-273`). */
export interface AttentionItem {
  /** The chip: `KPM owner`, `KPM request`, `Role ladder`, `Product`. */
  tag: string;
  /** Drives the chip's colour. `structural` is the platform's own to fix. */
  severity: 'structural' | 'approval' | 'template';
  title: string;
  detail: string;
  /** Where the reader goes to act on it. */
  href: string;
  actionLabel: string;
}

export interface CompanyCard {
  companyId: string;
  name: string;
  initials: string;
  kpmCount: number;
  memberCount: number;
}

export interface PlatformOverview {
  tiles: { companies: number; kpms: number; totalMembers: number; agencyBuilders: number };
  attention: AttentionItem[];
  companies: CompanyCard[];
}

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

  /**
   * The console's front page.
   *
   * **The overview is a queue, not four counters** — the prototype puts `Needs your
   * attention` above the tiles and its footer says why: *"4 items need Superadmin action
   * — nothing here can be delegated to a KPM Owner or Admin"* (`Superadmin.html:272`).
   * The tiles are context for the queue, so they are returned together and rendered in
   * that order.
   *
   * **Two of the tiles are cross-tenant headcounts**, which ADR-0011 deliberately allows:
   * it retook ADR-0005's claim that this console "never reads an office's business data"
   * once the prototype turned up with `Total members` and `Agency Builders` on the front
   * page. Aggregate composition is in; leads, activity, coaching notes and production
   * stay out, and nothing here reads them.
   *
   * One cross-tenant read serves all of it — the totals, the role split and the
   * per-company breakdown — rather than a count per office. At the phase's own benchmark
   * of 500 members that is a few thousand documents; if the platform outgrows that, this
   * becomes a grouped aggregate rather than more round trips.
   */
  async platformOverview(ctx: RequestContext): Promise<PlatformOverview> {
    this.require(ctx, 'platform_metrics:read');

    const [companies, kpms, members] = await Promise.all([
      this.companies.find({ deletedAt: null }).sort({ name: 1 }).exec(),
      this.kpms.find({ deletedAt: null }).exec(),
      this.memberships.findAcrossAllTenants(ctx, { status: 'active' }),
    ]);

    const membersByKpm = new Map<string, number>();
    let agencyBuilders = 0;
    for (const m of members) {
      membersByKpm.set(m.kpmId, (membersByKpm.get(m.kpmId) ?? 0) + 1);
      if (m.role === 'ab') agencyBuilders += 1;
    }

    const kpmsByCompany = new Map<string, KpmDocument[]>();
    for (const kpm of kpms) {
      const list = kpmsByCompany.get(kpm.companyId) ?? [];
      list.push(kpm);
      kpmsByCompany.set(kpm.companyId, list);
    }

    return {
      tiles: {
        companies: companies.length,
        kpms: kpms.length,
        totalMembers: members.length,
        agencyBuilders,
      },
      attention: this.attentionQueue(kpms),
      companies: companies.map((c) => {
        const theirs = kpmsByCompany.get(String(c._id)) ?? [];
        return {
          companyId: String(c._id),
          name: c.name,
          initials: c.name.slice(0, 2).toUpperCase(),
          kpmCount: theirs.length,
          memberCount: theirs.reduce((n, k) => n + (membersByKpm.get(String(k._id)) ?? 0), 0),
        };
      }),
    };
  }

  /**
   * What needs the platform's own hand.
   *
   * The prototype seeds four rows from sources we mostly do not have yet: a role-ladder
   * request (P3.5-T7), pending KPM registrations (P3.5-T2), template adoption and a
   * product publish (Phases 4 and 5). **Only one of its sources exists today**, so only
   * one kind of row is produced. A queue with one real row is honest; four invented ones
   * would make the screen look finished and tell the reader nothing true.
   */
  private attentionQueue(kpms: KpmDocument[]): AttentionItem[] {
    const items: AttentionItem[] = [];

    const unowned = kpms.filter((k) => !k.ownerUserId && k.status !== 'archived');
    if (unowned.length > 0) {
      items.push({
        tag: 'KPM owner',
        severity: 'structural',
        title:
          unowned.length === 1
            ? '1 office has no Owner'
            : `${unowned.length} offices have no Owner`,
        detail:
          'Nobody can administer an office until an Owner is assigned, and only the platform can assign one.',
        href: '/admin/tenants',
        actionLabel: 'Review',
      });
    }

    return items;
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
