import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, isValidObjectId } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { can } from '@/modules/rbac/permissions';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { DirectoryService, type DirectoryMember } from './directory.service';
import { HierarchyService } from './hierarchy.service';
import { withOfficeLease } from './leader-limit';
import { MemberNames } from './member-names.service';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, MembershipDocument } from './membership.schema';
import { ORG_REFUSALS } from './org.messages';
import { canHoldUnit } from './role-rules';
import { TransfersService, type PendingMoveView } from './transfers.service';

const SAY = ORG_REFUSALS;

/** The most leaders the picker lists at once; a name or a code narrows it. */
export const LEADER_CHOICES_MAX = 50;

/**
 * **A leader somebody may be moved under** (`GET /members/:id/leader-choices`; P19.12-T4, ADR-0247 §2). `direct`: the
 * move is made at once — every choice the Owner's or an Admin's, a leader's inside their own tree — and otherwise it is
 * asked of the Owner or an Admin.
 */
export interface LeaderMoveChoice {
  membershipId: string;
  fullName: string;
  agentCode: string;
  orgLevelCode: string;
  role: HierarchyRole;
  /** How many active people are below them now (`subtreeCount`). */
  unitSize: number;
  direct: boolean;
}

/** Why a move was made: the Owner's or an Admin's *Ganti*, or a leader's move inside their own tree. */
type Via = 'office' | 'leader';

/**
 * **Changing who somebody reports to** (P19.12-T4; ADR-0247; the client's message of 11 November 2026, item 8).
 *
 * - **The Owner and an Admin move anybody at once** — *Ganti* on *Melapor ke* — but the office's owner, whom only the
 *   platform moves, under anybody active who can hold a unit (`canHoldUnit`: an AB, an AAB, or an Agent who already
 *   leads somebody; ADR-0087, ADR-0234).
 * - **A leader moves a direct report at once inside their own tree** — under themselves or anybody below them —
 *   from *Tim Anda*. **Elsewhere it is a request** to the Owner or an Admin (`requestMove`, ADR-0170 §4's queue), and
 *   moving directly there is `403` with `details.canRequest`. Somebody two levels down is their own leader's to move.
 * - **The person always moves with everybody under them, and their history** (`HierarchyService.reparent`): the
 *   subtree's materialised path is re-spliced, their open edge closes and a `re_parented` one opens at the same
 *   instant (invariant §5), and every leader above the old and the new position is recounted (ADR-0247 §4).
 * - **One move at a time per office**: the move runs holding the office's lease (`withOfficeLease`), and every check
 *   is read with it held, so two crossing moves cannot both pass the cycle check.
 * - A move **closes any transfer request still waiting for them** — it would move them from a leader they no longer
 *   have — and tells whoever asked. It is audited `member.leader_changed`, and the person, the leader they left and the
 *   leader they joined are told (`member.leader_changed` notice).
 *
 * Every read goes through the scoped repository: somebody in another office, or outside a leader's downline, is `404`.
 */
@Injectable()
export class LeaderChangeService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly transfers: TransfersService,
    private readonly directory: DirectoryService,
    private readonly names: MemberNames,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  /** The reader's membership; a reader in no office has nobody to move. */
  private requireMember(ctx: RequestContext): string {
    if (!ctx.kpmId || !ctx.membershipId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        SAY.TENANT_NO_MEMBERSHIP.notInOffice,
        HttpStatus.FORBIDDEN,
      );
    }
    return ctx.membershipId;
  }

  private isOffice(ctx: RequestContext): boolean {
    return Boolean(ctx.membership?.isKpmOwner || ctx.membership?.isKpmAdmin);
  }

  /**
   * **The person, as this reader may move them** — every refusal about *who* before anything about *where*:
   * another office or, for a leader, outside their downline → `404`; removed → `409 ORG_ALREADY_REMOVED`; pending →
   * `409 ORG_MEMBER_NOT_ACTIVE`; the office's owner → `403`; for a leader, not their direct report → `403`.
   */
  private async subject(ctx: RequestContext, membershipId: string, me: string, office: boolean): Promise<MembershipDocument> {
    const member = await this.members.findById(ctx, membershipId);
    // A leader reaches their downline and no further; the reader themselves is nobody's to move by their own hand.
    if (!member || (!office && !member.ancestorIds.includes(me))) throw new NotFoundException('Membership');
    if (member.status === 'removed') {
      throw new DomainException(
        ErrorCode.ORG_ALREADY_REMOVED, SAY.ORG_ALREADY_REMOVED.alreadyRemoved, HttpStatus.CONFLICT, { membershipId },
      );
    }
    if (member.status !== 'active') {
      throw new DomainException(
        ErrorCode.ORG_MEMBER_NOT_ACTIVE, SAY.ORG_MEMBER_NOT_ACTIVE.notJoinedYet, HttpStatus.CONFLICT, { membershipId },
      );
    }
    if (await this.hierarchy.ownsTheOffice(ctx, member)) {
      throw new DomainException(
        ErrorCode.ORG_LEADER_CHANGE_NOT_PERMITTED, SAY.ORG_LEADER_CHANGE_NOT_PERMITTED.owner, HttpStatus.FORBIDDEN,
        { membershipId },
      );
    }
    if (!office && member.leaderId !== me) {
      throw new DomainException(
        ErrorCode.ORG_LEADER_CHANGE_NOT_PERMITTED, SAY.ORG_LEADER_CHANGE_NOT_PERMITTED.directReportsOnly,
        HttpStatus.FORBIDDEN, { membershipId },
      );
    }
    return member;
  }

  /**
   * **The new leader, checked** — in the office and active (`422 ORG_LEADER_NOT_IN_KPM`), not the person nor anybody
   * below them (`409 ORG_CYCLE_DETECTED`), able to hold a unit (`422 ORG_LEADER_CANNOT_LEAD`). `null` when it is the
   * leader they already have: nothing to do.
   */
  private async destination(
    ctx: RequestContext, member: MembershipDocument, leaderId: string,
  ): Promise<MembershipDocument | null> {
    const membershipId = String(member._id);
    const leader = isValidObjectId(leaderId) ? await this.members.findById(ctx, leaderId) : null;
    if (!leader || leader.status !== 'active') {
      throw new DomainException(
        ErrorCode.ORG_LEADER_NOT_IN_KPM, SAY.ORG_LEADER_NOT_IN_KPM.notAMember, HttpStatus.UNPROCESSABLE_ENTITY, { leaderId },
      );
    }
    if (member.leaderId === String(leader._id)) return null;
    if (String(leader._id) === membershipId || leader.ancestorIds.includes(membershipId)) {
      throw new DomainException(
        ErrorCode.ORG_CYCLE_DETECTED, SAY.ORG_CYCLE_DETECTED.ownLeader, HttpStatus.CONFLICT, { membershipId, leaderId },
      );
    }
    if (!canHoldUnit(leader)) {
      throw new DomainException(
        ErrorCode.ORG_LEADER_CANNOT_LEAD, SAY.ORG_LEADER_CANNOT_LEAD.agentLeadsNobody, HttpStatus.UNPROCESSABLE_ENTITY,
        { leaderId },
      );
    }
    return leader;
  }

  /** Is this leader inside the reader's own tree: the reader, or anybody below them. */
  private inTree(leader: MembershipDocument, me: string): boolean {
    return String(leader._id) === me || leader.ancestorIds.includes(me);
  }

  /**
   * **The leaders this reader may move somebody under**, by part of a name or an agent code (`q`): never the person,
   * anybody below them, their leader now, or anybody who cannot hold a unit. The Owner and an Admin: the office, all
   * `direct`. A leader: their own tree `direct`, and the office's ABs and AABs outside it to ask for. Moved-at-once
   * first, then by name; at most {@link LEADER_CHOICES_MAX}.
   */
  async choices(ctx: RequestContext, membershipId: string, q?: string): Promise<LeaderMoveChoice[]> {
    const me = this.requireMember(ctx);
    const office = this.isOffice(ctx);
    const member = await this.subject(ctx, membershipId, me, office);

    const filter: FilterQuery<MembershipDocument> = {
      $and: [
        { status: 'active', _id: { $nin: [membershipId, ...(member.leaderId ? [member.leaderId] : [])] } },
        { ancestorIds: { $ne: membershipId } },
        // Who can hold a unit (`canHoldUnit`), as a query.
        { $or: [{ role: { $ne: 'agent' } }, { 'directCounts.total': { $gt: 0 } }] },
        // A leader: their tree, or a senior or associate leader elsewhere — never an Agent outside their own tree.
        ...(office ? [] : [{ $or: [{ _id: me }, { ancestorIds: me }, { role: { $in: ['ab', 'aab'] } }] }]),
        ...(await this.byNameOrCode(q)),
      ],
    };
    const rows = await this.members.find(ctx, filter, {
      projection: { userId: 1, agentCode: 1, orgLevelCode: 1, role: 1, subtreeCount: 1, ancestorIds: 1, status: 1 },
    });
    if (rows.length === 0) return [];
    const users = await this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).select('fullName').exec();
    const nameOf = new Map(users.map((u) => [String(u._id), u.fullName]));
    return rows
      .map((r): LeaderMoveChoice => ({
        membershipId: String(r._id),
        fullName: nameOf.get(r.userId) ?? '',
        agentCode: r.agentCode,
        orgLevelCode: r.orgLevelCode,
        role: r.role,
        unitSize: r.subtreeCount ?? 0,
        direct: office || this.inTree(r, me),
      }))
      .sort((a, b) => Number(b.direct) - Number(a.direct)
        || a.fullName.localeCompare(b.fullName, 'id', { sensitivity: 'base' })
        || a.agentCode.localeCompare(b.agentCode))
      .slice(0, LEADER_CHOICES_MAX);
  }

  /** A name (full or preferred) or an agent code, case-insensitive; nothing for an empty term. */
  private async byNameOrCode(q?: string): Promise<FilterQuery<MembershipDocument>[]> {
    const term = q?.trim();
    if (!term) return [];
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    const matching = await this.users
      .find({ $or: [{ fullName: pattern }, { preferredName: pattern }] })
      .select('_id')
      .exec();
    return [{ $or: [{ agentCode: pattern }, { userId: { $in: matching.map((u) => String(u._id)) } }] }];
  }

  /**
   * **Move somebody, with everybody under them, now** — `PUT /members/:id/leader`. Every check is read with the office's
   * lease held, then `HierarchyService.reparent` moves them. The same leader again writes nothing. Answers the member as
   * they now stand.
   */
  async move(ctx: RequestContext, membershipId: string, leaderId: string, reason?: string): Promise<DirectoryMember> {
    const me = this.requireMember(ctx);
    const office = this.isOffice(ctx);
    const why = reason?.trim() || null;

    const moved = await withOfficeLease({ kpms: this.kpms, members: this.members, clock: this.clock }, ctx, async () => {
      const member = await this.subject(ctx, membershipId, me, office);
      const leader = await this.destination(ctx, member, leaderId);
      if (!leader) return null;
      if (!office && !this.inTree(leader, me)) {
        throw new DomainException(
          ErrorCode.ORG_LEADER_CHANGE_NOT_PERMITTED, SAY.ORG_LEADER_CHANGE_NOT_PERMITTED.outsideYourTree,
          HttpStatus.FORBIDDEN,
          { membershipId, leaderId, canRequest: can(ctx, 'member:transfer_request') },
        );
      }
      const subtreeSize = await this.members.count(ctx, { ancestorIds: membershipId, status: 'active' });
      await this.hierarchy.reparent(ctx, membershipId, String(leader._id), why ?? undefined);
      return { member, leader, subtreeSize };
    });

    if (moved) await this.afterMove(ctx, moved, why, office ? 'office' : 'leader');
    return this.directory.read(ctx, membershipId);
  }

  /** What a move leaves behind it: a request it overtook closed, the audit row, and the three notices. */
  private async afterMove(
    ctx: RequestContext,
    moved: { member: MembershipDocument; leader: MembershipDocument; subtreeSize: number },
    why: string | null,
    via: Via,
  ): Promise<void> {
    const membershipId = String(moved.member._id);
    const fromLeaderId = moved.member.leaderId;
    const toLeaderId = String(moved.leader._id);
    await this.transfers.closeOvertaken(ctx, membershipId);

    await this.audit.record(ctx, {
      action: 'member.leader_changed',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before: { leaderId: fromLeaderId },
      after: { leaderId: toLeaderId, reason: why, subtreeSize: moved.subtreeSize, via },
    });

    const names = await this.names.byMembershipId(ctx, [membershipId, toLeaderId]);
    const payload = {
      membershipId,
      memberName: names.get(membershipId) ?? '',
      toLeaderName: names.get(toLeaderId) ?? '',
      reason: why,
      subtreeSize: moved.subtreeSize,
    };
    const told = new Set<string>();
    const tell = async (person: MembershipDocument | null, audience: 'member' | 'from_leader' | 'to_leader') => {
      // Never the reader: they made the move, and the screen already said so.
      if (!person || told.has(person.userId) || person.userId === ctx.userId) return;
      told.add(person.userId);
      await this.notifications.send({
        userId: person.userId,
        kpmId: ctx.kpmId,
        templateId: NotificationTemplate.MEMBER_LEADER_CHANGED,
        payload: { ...payload, audience },
      });
    };
    await tell(moved.member, 'member');
    await tell(fromLeaderId ? await this.members.findById(ctx, fromLeaderId) : null, 'from_leader');
    await tell(moved.leader, 'to_leader');
  }

  /**
   * **A leader asks the Owner or an Admin to move a direct report to a leader outside their tree** —
   * `POST /members/:id/transfer-request`. The same refusals as a move about who and where; a destination inside their
   * own tree is `400 VALIDATION_FAILED` — move them directly — and one already waiting `409 ORG_TRANSFER_PENDING`
   * (`TransfersService.requestMove`). The person stays where they are until it is decided.
   */
  async requestMove(ctx: RequestContext, membershipId: string, leaderId: string, note?: string): Promise<PendingMoveView> {
    const me = this.requireMember(ctx);
    // The Owner and an Admin move anybody directly; standing on AB they hold AB's grant, and are told so.
    if (this.isOffice(ctx)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.officeMovesDirectly, HttpStatus.BAD_REQUEST, { membershipId },
      );
    }
    const member = await this.subject(ctx, membershipId, me, false);
    const leader = await this.destination(ctx, member, leaderId);
    if (!leader || this.inTree(leader, me)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.moveDirectly, HttpStatus.BAD_REQUEST,
        { membershipId, leaderId },
      );
    }
    return this.transfers.requestMove(ctx, member, leader, note?.trim() || null);
  }

  /** **Whoever asked withdraws a move, or any transfer, still waiting** — `DELETE /transfer-requests/:id`. */
  async cancelRequest(ctx: RequestContext, transferId: string): Promise<{ transferId: string; status: 'cancelled' }> {
    this.requireMember(ctx);
    return this.transfers.cancelOwn(ctx, transferId);
  }
}
