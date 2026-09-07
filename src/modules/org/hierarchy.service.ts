import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { formatAgentCode } from './agent-code';
import { MembershipHistory, MembershipHistoryDocument, MembershipEvent } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { HierarchyRole, MembershipDocument } from './membership.schema';

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
    @InjectModel(MembershipHistory.name)
    private readonly history: Model<MembershipHistoryDocument>,
    private readonly clock: Clock,
    // No cycle: OrgLevelService knows nothing about the hierarchy.
    private readonly orgLevels: OrgLevelService,
  ) {}

  /**
   * Allocate the next agent code for an office.
   *
   * `findOneAndUpdate` with `$inc` so the read and the increment are one atomic
   * operation. A read-then-write would hand two concurrent joins the same number, and
   * the unique index would then reject one of them — turning a race into a user-visible
   * failure on a code nobody chose.
   */
  private async nextAgentCode(
    kpmId: string,
  ): Promise<{ agentCode: string; agentSeq: number; companyId: string }> {
    const kpm = await this.kpms
      .findOneAndUpdate(
        { _id: kpmId, deletedAt: null },
        { $inc: { 'counters.nextAgentCodeSeq': 1 } },
        { new: false },
      )
      .exec();
    if (!kpm) throw new NotFoundException('KPM');
    const agentSeq = kpm.counters?.nextAgentCodeSeq ?? 1;
    // The company comes back with it. The ladder a membership references belongs to the
    // company, and this read has already paid for the document.
    return { agentCode: formatAgentCode(kpm.code, agentSeq), agentSeq, companyId: kpm.companyId };
  }

  private async record(
    ctx: RequestContext,
    membershipId: string,
    eventType: MembershipEvent,
    fields: Partial<MembershipHistory> = {},
  ): Promise<void> {
    await this.history.create({
      kpmId: ctx.kpmId,
      membershipId,
      eventType,
      validFrom: this.clock.now(),
      validTo: null,
      actorMembershipId: ctx.membershipId,
      actorUserId: ctx.auditActors.actorUserId,
      ...fields,
    });
  }

  /**
   * Close the open edge of a kind, so a change never overwrites what came before.
   *
   * `kpmId` leads the filter because it leads every index on `membershipHistory`
   * (`{kpmId, membershipId, validFrom}`) — without it this is a collection scan. It is
   * also invariant §1: a query is scoped because the collection is scoped, not because
   * the id it happens to use is unique enough to get away with it.
   */
  private async closeEdge(
    kpmId: string,
    membershipId: string,
    eventType: MembershipEvent,
  ): Promise<void> {
    await this.history
      .updateMany(
        { kpmId, membershipId, eventType, validTo: null },
        { $set: { validTo: this.clock.now() } },
      )
      .exec();
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
      $set: { orgLevelId: String(level._id), role },
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

    const { agentCode, agentSeq, companyId } = await this.nextAgentCode(kpmId);

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
      orgLevelId: String(level._id),
      role,
      leaderId: leader ? String(leader._id) : null,
      ancestorIds: leader ? [...leader.ancestorIds, String(leader._id)] : [],
      depth: leader ? leader.depth + 1 : 0,
      status: input.status ?? 'pending',
      joinedAt: (input.status ?? 'pending') === 'active' ? this.clock.now() : null,
      recruitedByMembershipId: input.recruitedByMembershipId ?? null,
      sourceLeadId: input.sourceLeadId ?? null,
    });

    await this.record(ctx, String(membership._id), 'joined', {
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

    // The membership's own tenant, not the context's: it was just read through the
    // tenant repository so the two agree, and this one is typed non-null.
    await this.closeEdge(String(member.kpmId), membershipId, 're_parented');
    await this.record(ctx, membershipId, 're_parented', {
      fromLeaderId: previousLeaderId,
      toLeaderId: member.leaderId,
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
    const counts = { ab: 0, aab: 0, agent: 0, total: directs.length };
    for (const d of directs) counts[d.role] += 1;

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
   * then, which the current `leaderId` cannot. An edge counts if it had opened by the
   * date and had not yet closed.
   */
  async leaderAsOf(ctx: RequestContext, membershipId: string, at: Date): Promise<string | null> {
    const edges = await this.history
      .find({
        kpmId: ctx.kpmId,
        membershipId,
        eventType: { $in: ['joined', 're_parented'] },
        validFrom: { $lte: at },
        $or: [{ validTo: null }, { validTo: { $gt: at } }],
      })
      .sort({ validFrom: -1 })
      .limit(1)
      .exec();
    return edges[0]?.toLeaderId ?? null;
  }
}
