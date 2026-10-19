import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Company, CompanyDocument } from './company.schema';
import { KpmRequest, KpmRequestDocument, KpmRequestStatus } from './kpm-request.schema';
import { TenantService } from './tenant.service';

export interface KpmRequestRow {
  requestId: string;
  branchName: string;
  companyId: string;
  companyName: string;
  /** The prototype writes this as one string: *"Rangga Wibisono (proposed KPM Owner)"*. */
  requestedByName: string;
  requestedByEmail: string;
  note: string | null;
  status: KpmRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  reason: string | null;
  createdKpmId: string | null;
}

/**
 * Asking for an office, and deciding whether it exists.
 *
 * **The one flow the prototype defines and our model had no entity for** (ADR-0011). An
 * office was created *by* a Super Admin; nobody could ask for one, so a branch that had
 * never been provisioned left its people with no way in at all — they would search the
 * directory, find nothing, and stop.
 *
 * The requester **is** the proposed Owner. `Superadmin.html:329-331` writes them as one
 * person with one intent — *"Rangga Wibisono (proposed KPM Owner)"* — and that is right:
 * somebody asking for an office is asking to run one.
 */
@Injectable()
export class KpmRequestService {
  constructor(
    @InjectModel(KpmRequest.name) private readonly requests: Model<KpmRequestDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly tenants: TenantService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private require(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
    if (!can(ctx, permission)) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You cannot do that.',
        HttpStatus.FORBIDDEN,
        { permission },
      );
    }
  }

  /**
   * Ask for an office.
   *
   * Refused to anybody who already belongs to one: they have a way in, and a second
   * office created for them is not what they meant. That rule lives here rather than in
   * the grant, because a permission cannot say *"unless you already did this"* — the same
   * reason `kpm_registration:create` is granted to everybody signed in.
   */
  async create(
    ctx: RequestContext,
    input: { companyId: string; branchName: string; note?: string },
  ): Promise<KpmRequestRow> {
    this.require(ctx, 'kpm_request:create');

    if (ctx.membership) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        'You are already registered to an office.',
        HttpStatus.CONFLICT,
        { kpmId: ctx.kpmId },
      );
    }

    const company = await this.companies
      .findOne({ _id: input.companyId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500.
      .catch(() => null);
    if (!company) throw new NotFoundException('Company');

    // One open ask per person. The unique index is the real guarantee; this is what turns
    // it into a sentence somebody can act on.
    const open = await this.requests
      .findOne({ requestedByUserId: ctx.userId, status: 'pending', deletedAt: null })
      .exec();
    if (open) {
      throw new DomainException(
        ErrorCode.TENANT_REQUEST_ALREADY_OPEN,
        'You have already asked for an office. Wait for that one to be decided.',
        HttpStatus.CONFLICT,
        { requestId: String(open._id) },
      );
    }

    const created = await this.requests.create({
      companyId: input.companyId,
      branchName: input.branchName.trim(),
      requestedByUserId: ctx.userId,
      note: input.note?.trim() || null,
      status: 'pending',
    });

    await this.audit.record(ctx, {
      action: 'kpm_request.created',
      targetCollection: 'kpmRequests',
      targetId: String(created._id),
      after: { companyId: input.companyId, branchName: created.branchName },
    });

    return (await this.rows([created]))[0];
  }

  /** What the requester asked for, so their own screen can say where it stands. */
  async mine(ctx: RequestContext): Promise<KpmRequestRow | null> {
    this.require(ctx, 'kpm_request:create');
    const own = await this.requests
      .findOne({ requestedByUserId: ctx.userId, deletedAt: null })
      .sort({ createdAt: -1 })
      .exec();
    return own ? (await this.rows([own]))[0] : null;
  }

  /** The platform's queue. Pending first, because that is what needs deciding. */
  async queue(ctx: RequestContext): Promise<KpmRequestRow[]> {
    this.require(ctx, 'kpm_request:read');
    const rows = await this.requests.find({ deletedAt: null }).sort({ createdAt: -1 }).exec();

    // Ranked, not sorted by the field: `status: 1` orders alphabetically, which puts
    // `approved` and `declined` ahead of `pending` — the exact inverse of what a queue
    // is for. A test asserts the order for that reason.
    const RANK: Record<KpmRequestStatus, number> = { pending: 0, approved: 1, declined: 2 };
    return this.rows([...rows].sort((a, b) => RANK[a.status] - RANK[b.status]));
  }

  /**
   * Approve: create the office and hand it to the person who asked.
   *
   * The **code is supplied here**, not by the requester. It has to be unique within the
   * company and nobody outside the platform can know what is free, so the prototype's
   * `KPM name` is a branch name and the number is ours to issue.
   *
   * `TenantService` does both halves, so provisioning stays in one place: the settings
   * seeded from the company, the counters, the owner's membership and both audit rows are
   * the same ones a Super Admin creating an office by hand would produce.
   */
  async approve(
    ctx: RequestContext,
    requestId: string,
    input: { code: string },
  ): Promise<KpmRequestRow[]> {
    this.require(ctx, 'kpm_request:decide');
    const request = await this.open(requestId);

    const kpm = await this.tenants.createKpm(ctx, {
      companyId: request.companyId,
      code: input.code,
      branchName: request.branchName,
    });
    await this.tenants.assignOwner(ctx, String(kpm._id), { userId: request.requestedByUserId });

    const now = this.clock.now();
    await this.requests
      .updateOne(
        { _id: requestId },
        {
          $set: {
            status: 'approved',
            decidedAt: now,
            decidedByUserId: ctx.auditActors.actorUserId,
            createdKpmId: String(kpm._id),
          },
        },
      )
      .exec();

    await this.audit.record(ctx, {
      action: 'kpm_request.approved',
      targetCollection: 'kpmRequests',
      targetId: requestId,
      before: { status: 'pending' },
      after: { status: 'approved', createdKpmId: String(kpm._id) },
    });

    return this.queue(ctx);
  }

  /** Decline: nothing is created, and the reason travels back. */
  async decline(
    ctx: RequestContext,
    requestId: string,
    input: { reason?: string },
  ): Promise<KpmRequestRow[]> {
    this.require(ctx, 'kpm_request:decide');
    await this.open(requestId);

    await this.requests
      .updateOne(
        { _id: requestId },
        {
          $set: {
            status: 'declined',
            decidedAt: this.clock.now(),
            decidedByUserId: ctx.auditActors.actorUserId,
            reason: input.reason?.trim() || null,
          },
        },
      )
      .exec();

    await this.audit.record(ctx, {
      action: 'kpm_request.declined',
      targetCollection: 'kpmRequests',
      targetId: requestId,
      before: { status: 'pending' },
      after: { status: 'declined', reason: input.reason?.trim() || null },
    });

    return this.queue(ctx);
  }

  /** The request, if it is still open. Deciding twice says which way the first went. */
  private async open(requestId: string): Promise<KpmRequestDocument> {
    const request = await this.requests
      .findOne({ _id: requestId, deletedAt: null })
      .exec()
      .catch(() => null);
    if (!request) throw new NotFoundException('KPM request');

    if (request.status !== 'pending') {
      throw new DomainException(
        ErrorCode.TENANT_REQUEST_DECIDED,
        `That request was already ${request.status}.`,
        HttpStatus.CONFLICT,
        { requestId, status: request.status, decidedAt: request.decidedAt?.toISOString() ?? null },
      );
    }
    return request;
  }

  private async rows(requests: KpmRequestDocument[]): Promise<KpmRequestRow[]> {
    if (requests.length === 0) return [];

    const [companies, users] = await Promise.all([
      this.companies.find({ _id: { $in: [...new Set(requests.map((r) => r.companyId))] } }).exec(),
      this.users.find({ _id: { $in: [...new Set(requests.map((r) => r.requestedByUserId))] } }).exec(),
    ]);
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));
    const byUser = new Map(users.map((u) => [String(u._id), u]));

    return requests.map((r) => {
      const who = byUser.get(r.requestedByUserId);
      return {
        requestId: String(r._id),
        branchName: r.branchName,
        companyId: r.companyId,
        companyName: companyName.get(r.companyId) ?? 'Unknown',
        requestedByName: who?.fullName ?? 'Unknown',
        requestedByEmail: who?.email ?? '',
        note: r.note,
        status: r.status,
        requestedAt: r.get('createdAt')?.toISOString() ?? '',
        decidedAt: r.decidedAt?.toISOString() ?? null,
        reason: r.reason,
        createdKpmId: r.createdKpmId,
      };
    });
  }
}
