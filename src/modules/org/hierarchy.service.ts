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
  ) {}

  /**
   * Allocate the next agent code for an office.
   *
   * `findOneAndUpdate` with `$inc` so the read and the increment are one atomic
   * operation. A read-then-write would hand two concurrent joins the same number, and
   * the unique index would then reject one of them — turning a race into a user-visible
   * failure on a code nobody chose.
   */
  private async nextAgentCode(kpmId: string): Promise<{ agentCode: string; agentSeq: number }> {
    const kpm = await this.kpms
      .findOneAndUpdate(
        { _id: kpmId, deletedAt: null },
        { $inc: { 'counters.nextAgentCodeSeq': 1 } },
        { new: false },
      )
      .exec();
    if (!kpm) throw new NotFoundException('KPM');
    const agentSeq = kpm.counters?.nextAgentCodeSeq ?? 1;
    return { agentCode: formatAgentCode(kpm.code, agentSeq), agentSeq };
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

  /** Close the open edge of a kind, so a change never overwrites what came before. */
  private async closeEdge(membershipId: string, eventType: MembershipEvent): Promise<void> {
    await this.history
      .updateMany(
        { membershipId, eventType, validTo: null },
        { $set: { validTo: this.clock.now() } },
      )
      .exec();
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

    const { agentCode, agentSeq } = await this.nextAgentCode(kpmId);
    const membership = await this.members.create(ctx, {
      userId: input.userId,
      agentCode,
      agentSeq,
      role: input.role,
      leaderId: leader ? String(leader._id) : null,
      ancestorIds: leader ? [...leader.ancestorIds, String(leader._id)] : [],
      depth: leader ? leader.depth + 1 : 0,
      status: input.status ?? 'pending',
      joinedAt: (input.status ?? 'pending') === 'active' ? this.clock.now() : null,
      recruitedByMembershipId: input.recruitedByMembershipId ?? null,
      sourceLeadId: input.sourceLeadId ?? null,
    });

    await this.record(ctx, String(membership._id), 'joined', {
      toRole: input.role,
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
  async reparent(
    ctx: RequestContext,
    membershipId: string,
    newLeaderId: string | null,
    reason?: string,
  ): Promise<MembershipDocument> {
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');

    const leader = newLeaderId ? await this.requireLeader(ctx, newLeaderId) : null;

    if (leader) {
      // A cycle would make the subtree query infinite and the member their own ancestor.
      // Checking the proposed leader's ancestors catches it in one comparison: if the
      // member is already above them, moving them below closes the loop.
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

    const previousLeaderId = member.leaderId;
    if (previousLeaderId === (leader ? String(leader._id) : null)) return member;

    const oldPath = [...member.ancestorIds, membershipId];
    const newAncestors = leader ? [...leader.ancestorIds, String(leader._id)] : [];
    const newDepth = newAncestors.length;
    const depthShift = newDepth - member.depth;

    const updated = await this.members.updateById(ctx, membershipId, {
      $set: { leaderId: leader ? String(leader._id) : null, ancestorIds: newAncestors, depth: newDepth },
    });

    // Every descendant carries the old path as a prefix, so the whole subtree is one
    // splice rather than a walk — and one round trip rather than one per member.
    await this.members.respliceSubtree(ctx, membershipId, newAncestors, oldPath.length, depthShift);

    await this.closeEdge(membershipId, 're_parented');
    await this.record(ctx, membershipId, 're_parented', {
      fromLeaderId: previousLeaderId,
      toLeaderId: leader ? String(leader._id) : null,
      reason: reason ?? null,
    });

    await this.refreshCounts(ctx, previousLeaderId);
    await this.refreshCounts(ctx, leader ? String(leader._id) : null);
    return updated ?? member;
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
