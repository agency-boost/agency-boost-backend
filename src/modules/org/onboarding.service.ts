import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { HierarchyService } from './hierarchy.service';
import { JoinRequestRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { MembershipDocument } from './membership.schema';

export interface KpmDirectoryEntry {
  kpmId: string;
  code: string;
  branchName: string;
  /**
   * The insurer, named and identified.
   *
   * The id travels because somebody whose branch is not on the platform has to say which
   * company they would belong to, and the directory is the only place a newcomer can
   * learn which companies exist. It names no office and leaks nothing an outsider could
   * not read from the list itself.
   */
  companyId: string;
  companyName: string;
  city: string | null;
}

export interface LeaderChoice {
  membershipId: string;
  fullName: string;
  role: 'ab' | 'aab';
  unitSize: number;
  isCurrentLeader: boolean;
  requestSent: boolean;
}

export interface JoinState {
  kpmId: string | null;
  kpmLabel: string | null;
  registeredAt: string | null;
  leaderMembershipId: string | null;
  leaderName: string | null;
  status: 'none' | 'pending' | 'active' | 'removed';
  pendingRequestTo: string | null;
}

/**
 * Joining an office: registering to one, then asking a leader to take you.
 *
 * The prototype gates these as a chain — the leader panel is *"locked entirely until a
 * KPM exists"* (`Overall.html:8824-8827`) — and so does this, but by state rather than
 * by hiding a card. Registering creates a **pending membership**, which is what gives
 * the request a tenant to be scoped to; without one there is no office to search.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly requests: JoinRequestRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  /**
   * The office directory — the one cross-tenant read a non-Super-Admin has.
   *
   * Deliberately projection-limited to code, branch name, company and city. Somebody
   * with no office can call this, because otherwise nobody could ever join one, so it
   * must reveal nothing an outsider should not see: no member counts, no production,
   * no owner name.
   */
  async searchKpms(q?: string): Promise<KpmDirectoryEntry[]> {
    const term = q?.trim();
    const filter: Record<string, unknown> = { deletedAt: null, status: 'active' };
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Code substring or branch-name substring, as the prototype's own filter does.
      filter.$or = [
        { code: new RegExp(escaped, 'i') },
        { branchName: new RegExp(escaped, 'i') },
      ];
    }

    const offices = await this.kpms.find(filter).sort({ code: 1 }).limit(50).exec();
    if (offices.length === 0) return [];

    const companies = await this.companies
      .find({ _id: { $in: [...new Set(offices.map((o) => o.companyId))] } })
      .exec();
    const nameOf = new Map(companies.map((c) => [String(c._id), c.name]));

    return offices.map((o) => ({
      kpmId: String(o._id),
      code: o.code,
      branchName: o.branchName,
      companyId: o.companyId,
      companyName: nameOf.get(o.companyId) ?? 'Unknown',
      city: o.address,
    }));
  }

  /** Where the person asking stands: office, leader, and any outstanding request. */
  async myState(ctx: RequestContext): Promise<JoinState> {
    const empty: JoinState = {
      kpmId: null, kpmLabel: null, registeredAt: null,
      leaderMembershipId: null, leaderName: null, status: 'none', pendingRequestTo: null,
    };
    if (!ctx.membership) return empty;

    const membership = await this.members.findById(ctx, ctx.membershipId!);
    if (!membership) return empty;

    const kpm = await this.kpms.findOne({ _id: membership.kpmId, deletedAt: null }).exec();
    const company = kpm ? await this.companies.findOne({ _id: kpm.companyId }).exec() : null;

    // The caller may be in no office yet, so this reads by membership across offices —
    // the named cross-tenant escape rather than an absent filter (invariant §1).
    const request = await this.requests.pendingForMembership(
      membership.kpmId,
      String(membership._id),
    );

    return {
      kpmId: membership.kpmId,
      kpmLabel: kpm ? `${company?.name ?? 'Unknown'} — KPM ${kpm.code} · ${kpm.branchName}` : null,
      registeredAt: membership.get('createdAt')?.toISOString() ?? null,
      leaderMembershipId: membership.leaderId,
      leaderName: membership.leaderId ? await this.nameOfMembership(ctx, membership.leaderId) : null,
      status: membership.status,
      pendingRequestTo: request?.leaderMembershipId ?? null,
    };
  }

  private async nameOfMembership(ctx: RequestContext, membershipId: string): Promise<string | null> {
    const row = await this.members.findById(ctx, membershipId);
    if (!row) return null;
    const user = await this.users.findOne({ _id: row.userId }).exec();
    return user?.fullName ?? null;
  }

  /**
   * Attach yourself to an office.
   *
   * Creates a `pending` membership with no leader — the "unassigned agent" the
   * permission matrix describes: inside the tenant, in the untagged pool, with no
   * unit-scoped grants at all.
   *
   * It allocates an agent code even though nobody has approved them. A declined request
   * therefore leaves a gap in the office's numbering, which is the right trade: the
   * alternative is a membership row without a code, and `agentCode` being always
   * present is what lets every other collection rely on it.
   */
  async registerKpm(ctx: RequestContext, kpmId: string): Promise<JoinState> {
    if (ctx.membership) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        'You are already registered to an office.',
        HttpStatus.CONFLICT,
        { kpmId: ctx.kpmId },
      );
    }

    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null, status: 'active' }).exec();
    // An office that is suspended, archived or absent all read the same to an outsider.
    if (!kpm) throw new NotFoundException('KPM');

    const scoped = RequestContext.joiningTenant(ctx, kpmId);
    const membership = await this.hierarchy.create(scoped, {
      userId: ctx.userId,
      role: 'agent',
      leaderId: null,
      status: 'pending',
    });

    await this.audit.record(scoped, {
      action: 'kpm_registration.created',
      targetCollection: 'memberships',
      targetId: String(membership._id),
      after: { userId: ctx.userId, kpmId },
    });

    // Resolve against the membership just made, so the caller sees their new state
    // rather than the one their token was issued under.
    return this.myState(await this.contextFor(membership));
  }

  private async contextFor(membership: MembershipDocument): Promise<RequestContext> {
    return new RequestContext(membership.userId, 'none', {
      membershipId: String(membership._id),
      kpmId: membership.kpmId,
      hierarchyRole: membership.role,
      status: membership.status,
      isKpmOwner: false,
      isKpmAdmin: false,
      directCount: membership.directCounts?.total ?? 0,
    });
  }

  /**
   * The leaders you may ask.
   *
   * Everyone in your office holding AB or AAB — by role, not by the graph. This is the
   * one place the role is the right question: you are asking who *may* take you on, and
   * someone with no reports yet has to be askable or a new AAB could never get their
   * first (OD-23 governs who *is* a leader, not who may become one).
   */
  async leaders(ctx: RequestContext, q?: string): Promise<LeaderChoice[]> {
    if (!ctx.kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'Register an office before looking for a leader.',
        HttpStatus.FORBIDDEN,
      );
    }

    const rows = await this.members.find(
      ctx,
      { role: { $in: ['ab', 'aab'] }, status: 'active' },
      { sort: { agentSeq: 1 } },
    );
    const users = await this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).exec();
    const byUser = new Map(users.map((u) => [String(u._id), u]));

    const mine = ctx.membershipId
      ? await this.requests.findOne(ctx, { membershipId: ctx.membershipId, status: 'pending' })
      : null;
    const self = ctx.membershipId ? await this.members.findById(ctx, ctx.membershipId) : null;

    const term = q?.trim().toLowerCase();
    return rows
      .map((r) => ({
        membershipId: String(r._id),
        fullName: byUser.get(r.userId)?.fullName ?? 'Unknown',
        role: r.role as 'ab' | 'aab',
        unitSize: r.subtreeCount ?? 0,
        isCurrentLeader: self?.leaderId === String(r._id),
        requestSent: mine?.leaderMembershipId === String(r._id),
      }))
      // Name only, as the prototype's own filter does — code and role are not searchable
      // here, and adding them would diverge without a reason.
      .filter((l) => !term || l.fullName.toLowerCase().includes(term))
      .filter((l) => l.membershipId !== ctx.membershipId);
  }

  /** Ask a leader to take you. Notifies them; they decide (P3-T5). */
  async requestLeader(ctx: RequestContext, leaderMembershipId: string): Promise<JoinState> {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'Register an office before asking for a leader.',
        HttpStatus.FORBIDDEN,
      );
    }

    /**
     * **This is the joining flow, and only the joining flow.**
     *
     * Nothing here checked whether the *caller* already had a leader, and `approve()`
     * checked the request's status rather than the member's — so an active member with a
     * unit of their own could ask a different leader, be approved, and be moved. That is
     * a re-parent by another name, reachable with no `member:remove_from_team` and no
     * re-parent permission, of which the matrix has none. Changing an established leader
     * is a decision the product has not designed; a side door is not the place to
     * discover that.
     */
    const mine = await this.members.findById(ctx, ctx.membershipId);
    if (mine?.leaderId) {
      throw new DomainException(
        ErrorCode.ORG_AGENT_ALREADY_TAGGED,
        'You already report to somebody. Moving to another leader is not something you can ask for here.',
        HttpStatus.CONFLICT,
        { leaderId: mine.leaderId },
      );
    }

    // Checked first, and deliberately. Asking for yourself also fails the leader test
    // below — a pending agent is not a valid leader — but "you cannot report to
    // yourself" names the actual mistake, and the more specific message should win.
    if (leaderMembershipId === ctx.membershipId) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED,
        'You cannot ask to report to yourself.',
        HttpStatus.CONFLICT,
      );
    }

    const leader = await this.members.findById(ctx, leaderMembershipId);
    if (!leader || leader.status !== 'active' || !['ab', 'aab'].includes(leader.role)) {
      throw new DomainException(
        ErrorCode.ORG_LEADER_NOT_IN_KPM,
        'That leader is not available in this office.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { leaderMembershipId },
      );
    }

    // Replace rather than stack: asking someone else is a change of mind, not a second
    // request, and two open rows would let two approvers both say yes.
    await this.requests.updateMany(
      ctx,
      { membershipId: ctx.membershipId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );

    await this.requests.create(ctx, {
      membershipId: ctx.membershipId,
      leaderMembershipId,
      status: 'pending',
      createdBy: ctx.membershipId,
    });

    const asker = await this.users.findOne({ _id: ctx.userId }).exec();
    await this.notifications.send({
      userId: leader.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.JOIN_REQUEST_RECEIVED,
      payload: {
        askerName: asker?.fullName ?? 'Somebody',
        membershipId: ctx.membershipId,
      },
    });

    await this.audit.record(ctx, {
      action: 'leader_request.created',
      targetCollection: 'joinRequests',
      targetMembershipId: leaderMembershipId,
      after: { leaderMembershipId },
    });

    return this.myState(ctx);
  }

  /** Withdraw an outstanding ask. */
  async cancelRequest(ctx: RequestContext): Promise<JoinState> {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You have no request to withdraw.',
        HttpStatus.FORBIDDEN,
      );
    }
    const cancelled = await this.requests.updateMany(
      ctx,
      { membershipId: ctx.membershipId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
    );
    if (cancelled === 0) throw new NotFoundException('Join request');
    return this.myState(ctx);
  }
}
