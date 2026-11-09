import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { StartFrom } from '@/modules/config/provisioning.service';
import type { Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { DomainException, InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Company, CompanyDocument } from './company.schema';
import { KpmRequest, KpmRequestDocument, KpmRequestStatus } from './kpm-request.schema';
import { TenantService } from './tenant.service';
import { INSURERS_ONLY } from './template-library';
import { TENANTS_MESSAGES, TENANTS_REFUSALS } from './tenants.messages';

/** How long one approval holds a request (ADR-0191 §3): longer than any approval takes, short enough to recover. */
const APPROVAL_LEASE_MS = 2 * 60 * 1000;

export interface KpmRequestRow {
  requestId: string;
  branchName: string;
  /** The company the office is asked for: the applicant's, unless the Super Admin corrected it on approving. */
  companyId: string;
  companyName: string;
  /** The prototype writes this as one string: *"Rangga Wibisono (proposed KPM Owner)"*. */
  requestedByName: string;
  requestedByEmail: string;
  /** P19-T3 AC-1 (UI-168 card 1): the applicant's number as they gave it, so the Super Admin can call before deciding. */
  requestedByPhone: string | null;
  /**
   * **The company the applicant signed up with** (ADR-0191 §1–§2, P19-T3 AC-2) — what the card's picker starts on, and
   * what an Owner must belong to. `null` for an account that chose none.
   */
  requesterCompanyId: string | null;
  requesterCompanyName: string | null;
  /** ADR-0190 §4: only a verified address may own an office — said on the card before *Setujui* is pressed. */
  requesterEmailVerified: boolean;
  note: string | null;
  status: KpmRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  reason: string | null;
  createdKpmId: string | null;
  /** P19-T3 AC-3: what an approved request made — `deleted` once the office has since been deleted. */
  createdKpm: { kpmId: string; code: string; branchName: string; deleted: boolean } | null;
}

/** What `GET /join/kpm-request` answers: the reader's own request, and the company it would be for. */
export interface MyKpmRequestState {
  request: KpmRequestRow | null;
  /** The company the reader signed up with — a request is for it (ADR-0191 §1). `null`: the form asks for one. */
  company: { companyId: string; name: string } | null;
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
 *
 * **Since P19 (ADR-0191)** a request carries the company the applicant signed up with, never one picked off a search
 * result, and approving it is one step that either makes the office *and* its Owner or leaves nothing behind.
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
        TENANTS_REFUSALS.PERM_DENIED.cannotDoThat,
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
   *
   * **The company is the applicant's** (ADR-0191 §1, P19-T2 AC-3): `users.companyId`, the one they signed up with. The
   * screen took it from the directory's first result, so a Manulife applicant whose first result was Prudential asked
   * Prudential (UI-165), and one with no result could not ask at all (UI-164). `companyId` in the body is optional now:
   * naming another company is refused `409 TENANT_COMPANY_MISMATCH`, and an account with no company must name one.
   */
  async create(
    ctx: RequestContext,
    input: { companyId?: string; branchName: string; note?: string },
  ): Promise<KpmRequestRow> {
    this.require(ctx, 'kpm_request:create');

    if (ctx.membership) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        TENANTS_REFUSALS.ORG_AGENT_ALREADY_TAGGED.alreadyInOffice,
        HttpStatus.CONFLICT,
        { kpmId: ctx.kpmId },
      );
    }

    const own = await this.companyOfUser(ctx.userId);
    if (own && input.companyId && input.companyId !== own.companyId) {
      throw new DomainException(
        ErrorCode.TENANT_COMPANY_MISMATCH,
        TENANTS_REFUSALS.TENANT_COMPANY_MISMATCH.askOwnCompany({ company: own.name }),
        HttpStatus.CONFLICT,
        { userCompanyId: own.companyId, requestedCompanyId: input.companyId },
      );
    }
    const companyId = own?.companyId ?? input.companyId;
    if (!companyId) {
      throw new InvalidRequestException(TENANTS_REFUSALS.VALIDATION_FAILED.chooseCompany, { field: 'companyId' });
    }

    const company = await this.companies
      // **Not the Template library** (ADR-0164 §3): it holds no office, so nobody may ask for one in it.
      .findOne({ _id: companyId, deletedAt: null, ...INSURERS_ONLY })
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
        TENANTS_REFUSALS.TENANT_REQUEST_ALREADY_OPEN.alreadyAsked,
        HttpStatus.CONFLICT,
        { requestId: String(open._id) },
      );
    }

    const created = await this.requests.create({
      companyId,
      branchName: input.branchName.trim(),
      requestedByUserId: ctx.userId,
      note: input.note?.trim() || null,
      status: 'pending',
    });

    await this.audit.record(ctx, {
      action: 'kpm_request.created',
      targetCollection: 'kpmRequests',
      targetId: String(created._id),
      after: { companyId, branchName: created.branchName },
    });

    return (await this.rows([created], ctx.reader))[0];
  }

  /**
   * What the requester asked for, so their own screen can say where it stands — and the company a request of theirs
   * is for, so the form says it rather than asking (ADR-0191 §1, P19-T2 AC-2).
   */
  async mine(ctx: RequestContext): Promise<MyKpmRequestState> {
    this.require(ctx, 'kpm_request:create');
    const [own, company] = await Promise.all([
      this.requests.findOne({ requestedByUserId: ctx.userId, deletedAt: null }).sort({ createdAt: -1 }).exec(),
      this.companyOfUser(ctx.userId),
    ]);
    return {
      request: own ? (await this.rows([own], ctx.reader))[0] : null,
      company,
    };
  }

  /** The company an account signed up with, named — or `null` for one with none, or one that has gone. */
  private async companyOfUser(userId: string): Promise<{ companyId: string; name: string } | null> {
    const user = await this.users.findOne({ _id: userId, deletedAt: null }).exec().catch(() => null);
    if (!user?.companyId) return null;
    const company = await this.companies
      .findOne({ _id: user.companyId, deletedAt: null, ...INSURERS_ONLY }).exec().catch(() => null);
    return company ? { companyId: String(company._id), name: company.name } : null;
  }

  /** The platform's queue. Pending first, because that is what needs deciding. */
  async queue(ctx: RequestContext): Promise<KpmRequestRow[]> {
    this.require(ctx, 'kpm_request:read');
    const rows = await this.requests.find({ deletedAt: null }).sort({ createdAt: -1 }).exec();

    // Ranked, not sorted by the field: `status: 1` orders alphabetically, which puts
    // `approved` and `declined` ahead of `pending` — the exact inverse of what a queue
    // is for. A test asserts the order for that reason.
    const RANK: Record<KpmRequestStatus, number> = { pending: 0, approved: 1, declined: 2 };
    return this.rows([...rows].sort((a, b) => RANK[a.status] - RANK[b.status]), ctx.reader);
  }

  /**
   * **"Setujui & jadikan Owner"** (ADR-0191 §3, P19-T3 AC-3): create the office and make the applicant its Owner, as
   * one step that either completes or leaves nothing behind, and that a second press answers with the first result.
   *
   * The **code** is supplied here, not by the requester: it has to be unique within the company and nobody outside
   * the platform can know what is free. The **company** may be corrected on the card (`companyId`, P19-T3 AC-2); the
   * request then records the company it was approved for, audited from and to.
   *
   * There are no transactions (ADR-0002), so the guarantee is built from three parts:
   *
   * 1. **Every check before any write** — the company, the code (`TENANT_CODE_TAKEN` naming who holds it) and the
   *    applicant as an Owner (`TenantService.refuseOwner`: the office's company, an agent code, a verified address).
   *    UI-165's half-made offices came from the last one being asked only after the office existed.
   * 2. **A lease on the request** (`approvingSince`), so two presses at once make one office: the second meets
   *    `409 TENANT_REQUEST_IN_PROGRESS`. The office's id is written to the request the moment it exists, so a run that
   *    died between the office and its Owner is finished by the next press, on the same office.
   * 3. **A compensating undo**: if setting the Owner fails, the office this press made is soft-deleted with whatever
   *    it wrote (`TenantService.discardHalfMade`), the lease and the id are cleared, and the refusal is answered. The
   *    code is free again (the index counts live offices only).
   *
   * Pressing again after it succeeded answers the queue as it stands — the request approved, naming the same office —
   * rather than `TENANT_REQUEST_DECIDED`. A declined request is still refused.
   */
  async approve(
    ctx: RequestContext,
    requestId: string,
    input: { code: string; companyId?: string; startFrom?: StartFrom },
  ): Promise<KpmRequestRow[]> {
    this.require(ctx, 'kpm_request:decide');
    const request = await this.find(requestId);

    // A second press after the first finished: the same office, not a second one, and not an error.
    if (request.status === 'approved') return this.queue(ctx);
    if (request.status !== 'pending') throw this.decided(request);

    // ---- 1. Every check, before anything is written. ----
    const companyId = input.companyId ?? request.companyId;
    const company = await this.companies
      .findOne({ _id: companyId, deletedAt: null, ...INSURERS_ONLY }).exec().catch(() => null);
    if (!company) throw new NotFoundException('Company');

    const applicant = await this.users
      .findOne({ _id: request.requestedByUserId, deletedAt: null }).exec().catch(() => null);
    if (!applicant) throw new NotFoundException('User');
    await this.tenants.refuseOwner(applicant, companyId, { requireVerified: true });

    // A run that died after making the office left its id here: that office is finished, not a second one made.
    const resumable = request.createdKpmId
      ? (await this.tenants.officesByIds([request.createdKpmId])).get(request.createdKpmId)
      : undefined;
    const resume = resumable && !resumable.deleted ? request.createdKpmId : null;
    if (!resume) {
      const holder = await this.tenants.codeHolder(companyId, input.code);
      if (holder) throw this.tenants.codeTaken(holder, company.name);
    }

    // ---- 2. The lease: one press at a time. ----
    const now = this.clock.now();
    const leased = await this.requests.findOneAndUpdate(
      {
        _id: request._id, status: 'pending', deletedAt: null,
        $or: [{ approvingSince: null }, { approvingSince: { $lt: new Date(now.getTime() - APPROVAL_LEASE_MS) } }],
      },
      { $set: { approvingSince: now } },
      { new: true },
    ).exec();
    if (!leased) {
      const latest = await this.find(requestId);
      if (latest.status === 'approved') return this.queue(ctx);
      if (latest.status !== 'pending') throw this.decided(latest);
      throw new DomainException(
        ErrorCode.TENANT_REQUEST_IN_PROGRESS,
        TENANTS_REFUSALS.TENANT_REQUEST_IN_PROGRESS.beingApproved,
        HttpStatus.CONFLICT,
        { requestId },
      );
    }

    // ---- 3. The office, then its Owner; undone if the second fails. ----
    let kpmId = resume;
    let madeHere = false;
    try {
      if (!kpmId) {
        // *Mulai dari* where the card offered it (ADR-0213 §3); absent, the company's default — or the built-in one.
        const kpm = await this.tenants.createKpm(ctx, {
          companyId, code: input.code, branchName: request.branchName, ...(input.startFrom ? { startFrom: input.startFrom } : {}),
        });
        kpmId = kpm._id;
        madeHere = true;
        await this.requests.updateOne({ _id: request._id }, { $set: { createdKpmId: kpmId } }).exec();
      }
      await this.tenants.assignOwner(ctx, kpmId, { userId: String(applicant._id) });
    } catch (err) {
      if (kpmId && madeHere) {
        await this.tenants.discardHalfMade(ctx, kpmId, 'kpm_request.approval_failed');
      }
      await this.requests.updateOne(
        { _id: request._id },
        { $set: { approvingSince: null, ...(madeHere ? { createdKpmId: null } : {}) } },
      ).exec();
      throw err;
    }

    await this.requests.updateOne(
      { _id: request._id },
      {
        $set: {
          status: 'approved',
          decidedAt: now,
          decidedByUserId: ctx.auditActors.actorUserId,
          createdKpmId: kpmId,
          companyId,
          approvingSince: null,
        },
      },
    ).exec();

    await this.audit.record(ctx, {
      action: 'kpm_request.approved',
      targetCollection: 'kpmRequests',
      targetId: requestId,
      before: { status: 'pending', companyId: request.companyId },
      after: { status: 'approved', createdKpmId: kpmId, companyId, ownerUserId: String(applicant._id) },
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
    const request = await this.find(requestId);
    if (request.status !== 'pending') throw this.decided(request);
    this.refuseWhileApproving(request);

    await this.requests
      .updateOne(
        { _id: requestId, status: 'pending' },
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

  /**
   * ***Hapus*: remove a wrong or duplicate request** (ADR-0191 §5, P19-T3 AC-7) — pending or decided. A soft delete
   * (invariant §6): it leaves the queue and the applicant's own screen, and nothing it made is touched — an office an
   * approved request made is the office's to delete. Audited as `kpm_request.deleted`. Refused while an approval holds
   * it, so a request is never removed from under the office it is making.
   */
  async remove(ctx: RequestContext, requestId: string): Promise<KpmRequestRow[]> {
    this.require(ctx, 'kpm_request:decide');
    const request = await this.find(requestId);
    this.refuseWhileApproving(request);

    const now = this.clock.now();
    await this.requests.updateOne({ _id: request._id, deletedAt: null }, { $set: { deletedAt: now } }).exec();
    await this.audit.record(ctx, {
      action: 'kpm_request.deleted',
      targetCollection: 'kpmRequests',
      targetId: requestId,
      before: {
        status: request.status, branchName: request.branchName, companyId: request.companyId,
        requestedByUserId: request.requestedByUserId, deletedAt: null,
      },
      after: { deletedAt: now },
    });
    return this.queue(ctx);
  }

  /** The request, live, or 404 — a malformed id included. */
  private async find(requestId: string): Promise<KpmRequestDocument> {
    const request = await this.requests
      .findOne({ _id: requestId, deletedAt: null })
      .exec()
      .catch(() => null);
    if (!request) throw new NotFoundException('KPM request');
    return request;
  }

  /** Deciding twice says which way the first went. */
  private decided(request: KpmRequestDocument): DomainException {
    const status = request.status === 'approved' ? 'approved' : 'declined';
    return new DomainException(
      ErrorCode.TENANT_REQUEST_DECIDED,
      TENANTS_REFUSALS.TENANT_REQUEST_DECIDED.alreadyDecided({ status }),
      HttpStatus.CONFLICT,
      { requestId: String(request._id), status, decidedAt: request.decidedAt?.toISOString() ?? null },
    );
  }

  /** An approval running now holds the request; nothing else changes it until the lease ends. */
  private refuseWhileApproving(request: KpmRequestDocument): void {
    const since = request.approvingSince;
    if (since && since.getTime() > this.clock.now().getTime() - APPROVAL_LEASE_MS) {
      throw new DomainException(
        ErrorCode.TENANT_REQUEST_IN_PROGRESS,
        TENANTS_REFUSALS.TENANT_REQUEST_IN_PROGRESS.beingApproved,
        HttpStatus.CONFLICT,
        { requestId: String(request._id) },
      );
    }
  }

  /** The rows, a missing company or requester named *Unknown* in the reader's language (P18.10-T7). */
  private async rows(requests: KpmRequestDocument[], reader: Reader): Promise<KpmRequestRow[]> {
    if (requests.length === 0) return [];

    const users = await this.users
      .find({ _id: { $in: [...new Set(requests.map((r) => r.requestedByUserId))] } }).exec().catch(() => []);
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    const companyIds = [...new Set([
      ...requests.map((r) => r.companyId),
      ...users.map((u) => u.companyId).filter((id): id is string => Boolean(id)),
    ])];
    const [companies, made] = await Promise.all([
      this.companies.find({ _id: { $in: companyIds } }).exec().catch(() => []),
      this.tenants.officesByIds(requests.map((r) => r.createdKpmId).filter((id): id is string => Boolean(id))),
    ]);
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));
    const unknown = render(TENANTS_MESSAGES.unknownPerson, reader);

    return requests.map((r) => {
      const who = byUser.get(r.requestedByUserId);
      const office = r.createdKpmId ? made.get(r.createdKpmId) : undefined;
      return {
        requestId: String(r._id),
        branchName: r.branchName,
        companyId: r.companyId,
        companyName: companyName.get(r.companyId) ?? unknown,
        requestedByName: who?.fullName ?? unknown,
        requestedByEmail: who?.email ?? '',
        requestedByPhone: who?.phone ?? null,
        requesterCompanyId: who?.companyId ?? null,
        requesterCompanyName: who?.companyId ? (companyName.get(who.companyId) ?? unknown) : null,
        requesterEmailVerified: Boolean(who?.emailVerifiedAt),
        note: r.note,
        status: r.status,
        requestedAt: r.get('createdAt')?.toISOString() ?? '',
        decidedAt: r.decidedAt?.toISOString() ?? null,
        reason: r.reason,
        createdKpmId: r.createdKpmId,
        createdKpm: r.createdKpmId && office
          ? { kpmId: r.createdKpmId, code: office.code, branchName: office.branchName, deleted: office.deleted }
          : null,
      };
    });
  }
}
