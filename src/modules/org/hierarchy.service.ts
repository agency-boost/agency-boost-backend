import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { EdgeEvent, MembershipHistory } from './membership-history.schema';
import { MembershipHistoryRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { generateLeaderCode } from './leader-code';
import { DirectCounts, HierarchyRole, MembershipDocument } from './membership.schema';

export interface CreateMembershipInput {
  userId: string;
  role: HierarchyRole;
  leaderId?: string | null;
  status?: 'active' | 'pending';
  recruitedByMembershipId?: string | null;
  sourceLeadId?: string | null;
}

/**
 * The hierarchy: who reports to whom, and everything derived from it.
 *
 * The parent reference keeps writes cheap; the materialised `ancestorIds` makes the
 * descendant query — the most common in the product, behind every rollup, every
 * coaching permission and every compliance tree — a single indexed lookup.
 *
 * Both are maintained here and nowhere else. A caller that sets `leaderId` directly
 * would leave the materialisation stale, so nothing outside this service writes it.
 */
@Injectable()
export class HierarchyService {
  constructor(
    private readonly members: MembershipRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly history: MembershipHistoryRepository,
    private readonly clock: Clock,
    // No cycle: OrgLevelService knows nothing about the hierarchy.
    private readonly orgLevels: OrgLevelService,
  ) {}

  /**
   * Take the next join-order number for an office.
   *
   * **This used to mint the agent code too.** It does not any more (ADR-0017): the code
   * belongs to the person, issued by their insurer and entered when they registered. What
   * survives is the sequence, because the directory cursor is a `$gt` on it and seven
   * services sort by it — none of which has anything to do with who issues a code.
   *
   * `findOneAndUpdate` with `$inc` so the read and the increment are one atomic
   * operation. A read-then-write would hand two concurrent joins the same number, and the
   * sort index would then hold two rows the cursor cannot separate — one of which the
   * roster would skip.
   */
  private async nextMemberSeq(kpmId: string): Promise<{ agentSeq: number }> {
    const kpm = await this.kpms
      .findOneAndUpdate(
        { _id: kpmId, deletedAt: null },
        { $inc: { 'counters.nextMemberSeq': 1 } },
        { new: false },
      )
      .exec();
    if (!kpm) throw new NotFoundException('KPM');
    return { agentSeq: kpm.counters?.nextMemberSeq ?? 1 };
  }

  /**
   * A leader code nobody else holds.
   *
   * Unique across every office and generated rather than derived, so a collision is
   * possible and has to be handled: probe, and try again. Five attempts against a space
   * of 32⁶ is not a real limit — it is a way of failing loudly if the generator ever
   * stops being random, rather than looping until the request times out.
   *
   * The probe is deliberately **unscoped**. The uniqueness is global, and asking within
   * one office would hand two offices the same code.
   */
  private async freshLeaderCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateLeaderCode();
      const taken = await this.members.existsWithLeaderCode(code);
      if (!taken) return code;
    }
    throw new DomainException(
      ErrorCode.INTERNAL_ERROR,
      'Could not allocate a leader code.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /** The insurer an office belongs to. The ladder and the agent code both hang off it. */
  private async companyOf(kpmId: string): Promise<string> {
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');
    return kpm.companyId;
  }

  /**
   * The agent code this person carries, checked against the office they are joining.
   *
   * The code is the insurer's, so an office may only admit somebody the insurer issued a
   * code for — and only its own insurer's. A user whose company differs from the office's
   * reads as **not found**, the same answer as an office that does not exist, because
   * confirming otherwise would let anybody map which insurer runs which office.
   */
  private async agentCodeOf(userId: string, companyId: string): Promise<string> {
    const user = await this.users.findOne({ _id: userId, deletedAt: null }).exec();
    if (!user) throw new NotFoundException('User');
    if (!user.agentCode || user.companyId !== companyId) {
      throw new NotFoundException('KPM');
    }
    return user.agentCode;
  }

  /**
   * The first edge. A membership that did not exist a moment ago has nothing open to close, so
   * this is the one edge written without `MembershipHistoryRepository.openEdge`; every later one
   * goes through it, and it closes whatever is open first (P11-T3).
   */
  private async recordJoined(
    ctx: RequestContext,
    membershipId: string,
    fields: Partial<MembershipHistory>,
  ): Promise<void> {
    await this.history.create(ctx, {
      membershipId,
      eventType: 'joined',
      validFrom: this.clock.now(),
      validTo: null,
      actorMembershipId: ctx.membershipId,
      actorUserId: ctx.auditActors.actorUserId,
      ...fields,
    });
  }

  /**
   * Move somebody to a different rung.
   *
   * Here rather than in `RoleChangeService` for the same reason `leaderId` is: **both
   * fields are written in one place or they drift.** A caller doing
   * `$set: { role: toRole }` on its own would leave `orgLevelId` pointing at the rung
   * they left, and nothing would notice — the enum would answer every question correctly
   * while the reference, which is the stored truth, said something else.
   *
   * Returns the rung, so the caller can record it in history.
   */
  /**
   * Is this membership the one that owns the office?
   *
   * Ownership lives on `kpms.ownerUserId`, not on the membership — `ContextResolver`
   * derives `isKpmOwner` by comparing the two — so anything that needs the answer has to
   * make the same join. Here because this service already holds the Kpm model, and
   * because both callers that need it already depend on it.
   */
  async ownsTheOffice(ctx: RequestContext, membership: { userId: string }): Promise<boolean> {
    if (!ctx.kpmId) return false;
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec();
    return Boolean(kpm?.ownerUserId) && kpm!.ownerUserId === membership.userId;
  }

  async setLevel(
    ctx: RequestContext,
    membershipId: string,
    toRole: HierarchyRole,
  ): Promise<{ orgLevelId: string; role: HierarchyRole }> {
    const kpmId = ctx.kpmId;
    if (!kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
        HttpStatus.FORBIDDEN,
      );
    }
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) throw new NotFoundException('KPM');

    const level = await this.orgLevels.resolveByCode(kpm.companyId, toRole);
    const role = level.code.toLowerCase() as HierarchyRole;
    await this.members.updateById(ctx, membershipId, {
      // All three together, always. `orgLevelCode` is what a permission grant reads and
      // `role` is what the display services read; writing one without the others is how
      // somebody comes to hold rights their badge does not show (P4-T9).
      $set: { orgLevelId: String(level._id), orgLevelCode: level.code, role },
    });
    return { orgLevelId: String(level._id), role };
  }

  async create(ctx: RequestContext, input: CreateMembershipInput): Promise<MembershipDocument> {
    const kpmId = ctx.kpmId;
    if (!kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
        HttpStatus.FORBIDDEN,
      );
    }

    const leader = input.leaderId ? await this.requireLeader(ctx, input.leaderId) : null;

    // **The refusal comes before the increment.** `nextMemberSeq` is a `$inc`, and a
    // rejected join that had already taken a number would leave a gap in the office's
    // ordering for somebody who never arrived.
    const companyId = await this.companyOf(kpmId);
    const agentCode = await this.agentCodeOf(input.userId, companyId);
    const { agentSeq } = await this.nextMemberSeq(kpmId);
    const leaderCode = await this.freshLeaderCode();

    // **The level is resolved first, and `role` is taken from what came back.**
    //
    // `input.role` is a lookup key, not the value stored: writing the caller's role
    // beside a level resolved from it is how the two come to disagree. Taking the code
    // off the resolved rung means they cannot — there is only one source, and it is the
    // ladder (ADR-0012).
    const level = await this.orgLevels.resolveByCode(companyId, input.role);
    const role = level.code.toLowerCase() as HierarchyRole;

    const membership = await this.members.create(ctx, {
      userId: input.userId,
      agentCode,
      agentSeq,
      leaderCode,
      orgLevelId: String(level._id),
      orgLevelCode: level.code,
      role,
      leaderId: leader ? String(leader._id) : null,
      ancestorIds: leader ? [...leader.ancestorIds, String(leader._id)] : [],
      depth: leader ? leader.depth + 1 : 0,
      status: input.status ?? 'pending',
      joinedAt: (input.status ?? 'pending') === 'active' ? this.clock.now() : null,
      recruitedByMembershipId: input.recruitedByMembershipId ?? null,
      sourceLeadId: input.sourceLeadId ?? null,
    });

    await this.recordJoined(ctx, String(membership._id), {
      toRole: role,
      toOrgLevelId: String(level._id),
      toLeaderId: membership.leaderId,
    });

    if (membership.status === 'active') await this.refreshCounts(ctx, membership.leaderId);
    return membership;
  }

  /** A leader must exist, be live, and be in this office. The repository enforces the last. */
  private async requireLeader(ctx: RequestContext, leaderId: string): Promise<MembershipDocument> {
    const leader = await this.members.findById(ctx, leaderId);
    if (!leader || leader.status === 'removed') {
      throw new DomainException(
        ErrorCode.ORG_LEADER_NOT_IN_KPM,
        'That leader is not a member of this office.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { leaderId },
      );
    }
    return leader;
  }

  /**
   * Move someone, and their whole subtree, under a new leader.
   *
   * The subtree moves with them because `ancestorIds` is materialised: every descendant
   * carries the moved member's old ancestors and must carry the new ones instead. This
   * is the price of making the descendant query one lookup, and it is paid here.
   */
  /**
   * Move a member under a new leader, correctly: cycle check, subtree re-splice, and
   * `refreshCounts` on **both** the leader they left and the one they joined.
   *
   * Extracted because `ApprovalsService.attach` had its own copy of the move — a bare
   * `$set` of `leaderId`, `ancestorIds` and `depth` — and did none of those three. So
   * approving a request or tagging somebody who already led a unit left every descendant
   * carrying the old ancestry: the previous leader kept read reach over a unit that had
   * gone, the new leader could not see the unit they now owned, and the old leader's
   * counts were never refreshed. Two ways of doing one thing is how the wrong one gets
   * called.
   *
   * The history row is the caller's to write, because the *meaning* differs: joining an
   * office for the first time is not the same event as being moved between leaders.
   *
   * Returns the leader they had before, or `undefined` when nothing moved.
   */
  /**
   * Would this move be refused? Asked **before** anything is written.
   *
   * `moveUnder` checks the same thing, and keeps checking it — it is the one place the
   * graph changes and it does not get to assume its callers were careful. This exists so
   * a caller that must write something *else* first can find out beforehand.
   *
   * `ApprovalsService.attach` is that caller. It has to set `status: 'active'` before the
   * move, because `refreshCounts` counts active members — so a refusal inside `moveUnder`
   * used to leave the joiner active with no leader and a `recruitedByMembershipId` naming
   * a leader who never took them on, with their request still pending. There are no
   * transactions here (ADR-0002, and MongoDB sessions are not configured), so the only
   * way to avoid a half-write is not to start one.
   */
  async assertCanMoveUnder(
    ctx: RequestContext,
    membershipId: string,
    newLeaderId: string,
  ): Promise<void> {
    // No member read and no nullable leader: the only caller has both in hand already,
    // and `moveUnder` re-reads and re-checks regardless. Accepting shapes nobody passes
    // would be two branches no test could reach except by inventing a caller for them.
    this.refuseCycle(membershipId, newLeaderId, await this.requireLeader(ctx, newLeaderId));
  }

  /** A cycle would make the subtree query infinite and the member their own ancestor. */
  private refuseCycle(
    membershipId: string,
    newLeaderId: string,
    leader: MembershipDocument,
  ): void {
    const wouldCycle =
      String(leader._id) === membershipId || leader.ancestorIds.includes(membershipId);
    if (wouldCycle) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED,
        'That would make this member their own leader.',
        HttpStatus.CONFLICT,
        { membershipId, leaderId: newLeaderId },
      );
    }
  }

  async moveUnder(
    ctx: RequestContext,
    membershipId: string,
    newLeaderId: string | null,
  ): Promise<{ previousLeaderId: string | null; moved: boolean }> {
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');

    const leader = newLeaderId ? await this.requireLeader(ctx, newLeaderId) : null;

    if (leader) this.refuseCycle(membershipId, newLeaderId as string, leader);

    const previousLeaderId = member.leaderId;
    const target = leader ? String(leader._id) : null;
    if (previousLeaderId === target) return { previousLeaderId, moved: false };

    const oldPath = [...member.ancestorIds, membershipId];
    const newAncestors = leader ? [...leader.ancestorIds, String(leader._id)] : [];
    const newDepth = newAncestors.length;

    await this.members.updateById(ctx, membershipId, {
      $set: { leaderId: target, ancestorIds: newAncestors, depth: newDepth },
    });

    // Every descendant carries the old path as a prefix, so the whole subtree is one
    // splice rather than a walk — and one round trip rather than one per member.
    await this.members.respliceSubtree(
      ctx, membershipId, newAncestors, oldPath.length, newDepth - member.depth,
    );

    await this.refreshCounts(ctx, previousLeaderId);
    await this.refreshCounts(ctx, target);
    return { previousLeaderId, moved: true };
  }

  async reparent(
    ctx: RequestContext,
    membershipId: string,
    newLeaderId: string | null,
    reason?: string,
  ): Promise<MembershipDocument> {
    const { previousLeaderId, moved } = await this.moveUnder(ctx, membershipId, newLeaderId);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    if (!moved) return member;

    // Every open edge closes, not only an earlier re-parent: this closed `re_parented` rows
    // alone, so a member's first move left the edge they joined on open beside the new one
    // (P11-T3). The row carries the rung they keep, so the open edge says all of where they
    // stand.
    await this.history.openEdge(ctx, this.clock.now(), {
      membershipId,
      eventType: 're_parented',
      fromLeaderId: previousLeaderId,
      toLeaderId: member.leaderId,
      toRole: member.role,
      toOrgLevelId: member.orgLevelId,
      reason: reason ?? null,
    });
    return member;
  }

  /**
   * Recompute one leader's caches.
   *
   * `directCounts.total` is what makes someone a leader (OD-23), so it is derived from
   * live rows rather than incremented — an increment that drifts would silently grant or
   * remove access to the unit dashboard and the coaching roster.
   */
  async refreshCounts(ctx: RequestContext, leaderId: string | null): Promise<void> {
    if (!leaderId) return;
    const directs = await this.members.find(ctx, { leaderId, status: 'active' });
    /*
     * Counted by **ladder code**, and built from what is actually there (P4-T9).
     *
     * It was three fixed keys seeded to zero, which counts nothing for a rung a second
     * insurer publishes — a leader with four reports on a new rung would have read as
     * leading nobody on every screen that groups by role, while `total` said four.
     */
    /*
     * Seeded from the **company's own ladder**, so a rung nobody stands on reads `0`
     * rather than being absent. That is what the old three fixed keys bought, and losing
     * it would turn "no AABs yet" into "this screen has no idea".
     */
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec();
    const ladder = kpm ? await this.orgLevels.activeCodesFor(kpm.companyId) : [];
    const counts: DirectCounts = { total: directs.length };
    for (const code of ladder) counts[code] = 0;
    for (const d of directs) {
      counts[d.orgLevelCode] = (counts[d.orgLevelCode] ?? 0) + 1;
    }

    const subtreeCount = await this.members.count(ctx, {
      ancestorIds: leaderId,
      status: 'active',
    });

    await this.members.updateById(ctx, leaderId, {
      $set: { directCounts: counts, subtreeCount },
    });
  }

  /** Everyone below X, in one indexed query — never a recursive walk. */
  async descendantsOf(ctx: RequestContext, membershipId: string): Promise<MembershipDocument[]> {
    return this.members.find(ctx, { ancestorIds: membershipId, status: { $ne: 'removed' } });
  }

  async directReportsOf(ctx: RequestContext, membershipId: string): Promise<MembershipDocument[]> {
    return this.members.find(
      ctx,
      { leaderId: membershipId, status: { $ne: 'removed' } },
      { sort: { agentSeq: 1 } },
    );
  }

  /**
   * The hierarchy as it stood on a date (P3-T2 AC-5).
   *
   * Read from history, not from the current rows: the point is to answer what was true
   * then, which the current `leaderId` cannot.
   *
   * **The latest event by that date that set the leader**, rather than the edge still open
   * then (P11-T3). Every edge now closes when the next one opens, a promotion included, so the
   * edge open on a date can be a role change. One written since carries the leader it kept; one
   * written before does not, and sits beside the edge it should have closed. Joining, a
   * re-parent, a removal and a reinstatement are the events that set the leader, and each
   * names the one it leaves them with: a removal and a reinstatement, none.
   */
  async leaderAsOf(ctx: RequestContext, membershipId: string, at: Date): Promise<string | null> {
    const latest = await this.history.find(
      ctx,
      { membershipId, eventType: { $in: LEADER_EVENTS }, validFrom: { $lte: at } },
      // Two events in one instant are told apart by the order they were written in.
      { sort: { validFrom: -1, _id: -1 }, limit: 1 },
    );
    return latest[0]?.toLeaderId ?? null;
  }
}

/** The edge events that set who the member reports to. A role change keeps the leader it found. */
const LEADER_EVENTS: EdgeEvent[] = ['joined', 're_parented', 'removed', 'reinstated'];
