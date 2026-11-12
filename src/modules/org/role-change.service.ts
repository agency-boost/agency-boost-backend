import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { isLeaderClass, shortOfRung } from '@/domain/constants';
import { can } from '@/modules/rbac/permissions';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { User, UserDocument } from '@/modules/users/user.schema';
import { initialsOf } from './directory.service';
import { HierarchyService } from './hierarchy.service';
import { MembershipHistoryRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, MembershipDocument } from './membership.schema';
import type { ApprovedPastLimit } from './leader-limit';
import { ORG_MESSAGES, ORG_REFUSALS } from './org.messages';
import { canChangeRoleOf, rankOf, roleChoices, roleReaderOf, sameCode, type LadderRung } from './role-rules';
import { TransfersService, type PendingMoveView } from './transfers.service';

const SAY = ORG_REFUSALS;

export interface TeamMember {
  membershipId: string;
  fullName: string;
  initials: string;
  agentCode: string;
  role: HierarchyRole;
  /** The rung they stand on, by its ladder code; `role` is the class it gives (ADR-0156). */
  orgLevelCode: string;
  directCount: number;
  /** Everybody active below them — who moves with them (*{nama} dan {n} orang di bawahnya pindah…*, ADR-0247 §2). */
  subtreeCount: number;
  /**
   * Whether this viewer may change *this* person's role. Sent rather than inferred,
   * because the rule is a server rule and the screen should not carry a second copy of
   * it that can drift. `roleChoices` has more than one rung.
   */
  canChangeRole: boolean;
  /**
   * **The rungs this viewer may put them on**, by ladder code, junior first, their own always among them (P19.12-T4;
   * ADR-0247 §1, `role-rules.ts`): an AB leader *Agent · AAB · AB*, an AAB leader *Agent · AAB*. The role sheet offers
   * exactly these and checks the current one.
   */
  roleChoices: string[];
  /** This viewer may move them to another leader — *Pindahkan ke leader lain* (ADR-0247 §2). Not the office's owner. */
  canChangeLeader: boolean;
  /** **A move this viewer asked the office for, still waiting** (ADR-0247 §3), or `null`. */
  pendingTransfer: PendingMoveView | null;
}

export interface RoleChangeEntry {
  membershipId: string;
  fullName: string;
  agentCode: string;
  fromRole: HierarchyRole | null;
  toRole: HierarchyRole | null;
  reason: string | null;
  actorName: string | null;
  changedAt: string;
}

/**
 * Changing what somebody is.
 *
 * **One rule, `roleChoices`** (`role-rules.ts`; P19.12-T4, ADR-0247 §1 — the client's message of 11 November 2026,
 * item 4, and the owner's: *AB on AB must be possible*). The direct leader may set any rung no higher than their own —
 * an AB leader makes an AB, an AAB leader an AAB at most — and take it away the same; the Owner and an Admin any rung,
 * on anybody but the office's owner. Until then anything involving AB was the office's alone, a rule the prototype's
 * select implied and nothing else asked for.
 *
 * A role change never moves anybody. The prototype is explicit about this in its own
 * copy — *"they'll keep reporting to you"* — and it is right: promoting somebody is a
 * statement about them, not a reorganisation.
 */
@Injectable()
export class RoleChangeService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    private readonly history: MembershipHistoryRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
    /*
     * The moves this reader asked the office for, for *Tim Anda*'s rows (P19.12-T4, ADR-0247 §3). Optional so the specs
     * that build this service by hand need not say it; without it no row has one waiting.
     */
    @Optional() private readonly transfers: TransfersService | null = null,
  ) {}

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

  /** The office's ladder, junior first (`HierarchyService.ladderOf`). */
  private async ladder(ctx: RequestContext): Promise<LadderRung[]> {
    return this.hierarchy.ladderOf(ctx.kpmId as string);
  }

  /** The people who report to this leader, with what they may do to each. */
  async team(ctx: RequestContext): Promise<TeamMember[]> {
    const me = this.requireMember(ctx);

    const rows = await this.members.find(
      ctx,
      { leaderId: me, status: 'active' },
      { sort: { agentSeq: 1 } },
    );
    if (rows.length === 0) return [];

    const [users, ladder, owner, waiting] = await Promise.all([
      this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).exec(),
      this.ladder(ctx),
      this.hierarchy.officeOwnerUserId(ctx),
      this.transfers ? this.transfers.pendingMovesBy(ctx, rows.map((r) => String(r._id))) : new Map<string, PendingMoveView>(),
    ]);
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    const reader = roleReaderOf(ctx);
    const mayMove = can(ctx, 'member:reassign_leader');

    return rows.map((r) => {
      const fullName = byUser.get(r.userId)?.fullName ?? unknown;
      const isOwner = owner !== null && r.userId === owner;
      // ADR-0247 §1: the one rule the write below enforces — an AB report is an AB leader's to change too.
      const choices = roleChoices(reader, { leaderId: r.leaderId, role: r.role, orgLevelCode: r.orgLevelCode, status: r.status, isOwner }, ladder);
      return {
        membershipId: String(r._id),
        fullName,
        initials: initialsOf(fullName),
        agentCode: r.agentCode,
        role: r.role,
        orgLevelCode: r.orgLevelCode,
        directCount: r.directCounts?.total ?? 0,
        subtreeCount: r.subtreeCount ?? 0,
        canChangeRole: canChangeRoleOf(choices),
        roleChoices: choices,
        canChangeLeader: mayMove && !isOwner,
        pendingTransfer: waiting.get(String(r._id)) ?? null,
      };
    });
  }

  async change(
    ctx: RequestContext,
    membershipId: string,
    toRole: string,
    reason?: string,
  ): Promise<TeamMember[]> {
    const me = this.requireMember(ctx);
    const checked = await this.checked(ctx, membershipId, toRole);
    if (checked) await this.apply(ctx, checked.target, toRole, reason, me);
    return this.team(ctx);
  }

  /**
   * **May this reader ask AgencyBoost to approve this change past the limit?** (ADR-0157 §1). Only if they could
   * make it themselves — every refusal `change` would meet is met here, in the same words — and only if it is a
   * change the limit stops: from a rung that leads nobody onto one that leads. Anything else needs nobody's
   * approval, and is refused as such, so no request is ever made for a write that would simply be served.
   */
  async assertMayAsk(
    ctx: RequestContext,
    membershipId: string,
    toRole: string,
  ): Promise<{ target: MembershipDocument; toCode: string }> {
    this.requireMember(ctx);
    const checked = await this.checked(ctx, membershipId, toRole);
    if (!checked || isLeaderClass(checked.target.role) || !isLeaderClass(checked.toClass)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        SAY.VALIDATION_FAILED.changeDirectly,
        HttpStatus.BAD_REQUEST,
        { membershipId, toRole },
      );
    }
    return { target: checked.target, toCode: checked.levelCode };
  }

  /**
   * **AgencyBoost approved it: the change the office asked for, made past the limit** (ADR-0157 §3).
   *
   * `ctx` is the Super Admin acting in the request's office. The write is the one `change` makes — the rung, the
   * history row with the asker as its actor and their reason, the counts, the member's notice, the audit row —
   * through `setLevel` with `pastLimit`, which re-checks the request still applies with the office's leader lease
   * held. The asker's own permission was settled when they asked (`assertMayAsk`).
   */
  async carryOutApproved(
    ctx: RequestContext,
    request: { requestId: string; subjectMembershipId: string; toOrgLevelCode: string; reason: string | null; requestedByMembershipId: string },
    stillApplies: (target: MembershipDocument | null) => Promise<void>,
  ): Promise<void> {
    const target = await this.members.findById(ctx, request.subjectMembershipId);
    await stillApplies(target);
    await this.apply(ctx, target as MembershipDocument, request.toOrgLevelCode, request.reason ?? undefined, request.requestedByMembershipId, {
      approvedRequestId: request.requestId,
      stillApplies: async () => stillApplies(await this.members.findById(ctx, request.subjectMembershipId)),
    });
  }

  /**
   * Every refusal a role change can meet, before anything is written: the member, the rung, the Owner, who may
   * change whom, and a leader who still leads. `null` when the member already stands on that rung — nothing to do.
   */
  private async checked(
    ctx: RequestContext,
    membershipId: string,
    toRole: string,
  ): Promise<{ target: MembershipDocument; toClass: HierarchyRole; levelCode: string } | null> {
    const target = await this.members.findById(ctx, membershipId);
    if (!target || target.status === 'removed') throw new NotFoundException('Membership');
    const reader = roleReaderOf(ctx);
    // 404, not 403, for somebody outside a leader's own downline (P19.12's permission review): a refusal would confirm
    // the id exists. The reader's own membership is theirs to know of, and the rules below refuse it.
    const inReach = reader.office || String(target._id) === reader.membershipId
      || (reader.membershipId !== null && (target.ancestorIds ?? []).includes(reader.membershipId));
    if (!inReach) throw new NotFoundException('Membership');
    // `toRole` names the rung — `ab` is the `AB` rung, and a company's own rung (`SM`) is named the same way
    // (OD-50, the custom-rung placement gap); what the rules below weigh is the **class** that rung gives
    // (ADR-0156 §2), so a rung marked otherwise than its code suggests is judged by what it makes somebody.
    const { level, role: toClass } = await this.hierarchy.rungFor(ctx, toRole);
    if (target.role === toClass && target.orgLevelCode === level.code) return null;

    // The same reasoning as removal: an Owner demoted out of AB keeps owning the office
    // while losing the rung that goes with it, and only the platform can reassign an
    // office. Refused for everybody, including the Owner themselves.
    if (await this.hierarchy.ownsTheOffice(ctx, target)) {
      throw new DomainException(
        ErrorCode.ORG_ROLE_CHANGE_NOT_PERMITTED,
        SAY.ORG_ROLE_CHANGE_NOT_PERMITTED.owner,
        HttpStatus.FORBIDDEN,
        { membershipId, fromRole: target.role, toRole },
      );
    }

    // ADR-0247 §1: the rung asked for must be one `roleChoices` offers this reader — the same answer the screen drew.
    const choices = roleChoices(reader, {
      leaderId: target.leaderId, role: target.role, orgLevelCode: target.orgLevelCode, status: target.status, isOwner: false,
    }, await this.ladder(ctx));
    if (!choices.some((code) => sameCode(code, level.code))) {
      throw new DomainException(
        ErrorCode.ORG_ROLE_CHANGE_NOT_PERMITTED,
        await this.refusalFor(ctx, reader, target, toClass, level),
        HttpStatus.FORBIDDEN,
        { membershipId, fromRole: target.role, toRole },
      );
    }

    // AC-3. Demoting somebody who still leads people would leave those people reporting
    // to somebody who, by the role they now hold, cannot lead them. Refused with the
    // count, so the caller knows what has to happen first rather than being told "no".
    const demoting = target.role !== 'agent' && toClass === 'agent';
    const directCount = target.directCounts?.total ?? 0;
    if (demoting && directCount > 0) {
      throw new DomainException(
        ErrorCode.ORG_HAS_DIRECT_REPORTS,
        SAY.ORG_HAS_DIRECT_REPORTS.moveFirst({ count: directCount }),
        HttpStatus.CONFLICT,
        { membershipId, directCount },
      );
    }
    return { target, toClass, levelCode: level.code };
  }

  /**
   * **Why a change `roleChoices` does not offer is refused, in words that say what to do** (ADR-0247 §1): somebody who
   * is not their direct leader is told only a direct leader may; a direct leader asking for a rung above their own is
   * told they may set one up to theirs, and who can make somebody that; a leader moving somebody who stands above
   * them is told the office does.
   */
  private async refusalFor(
    ctx: RequestContext,
    reader: ReturnType<typeof roleReaderOf>,
    target: MembershipDocument,
    toClass: HierarchyRole,
    level: { code: string; label: string },
  ) {
    const direct = reader.membershipId !== null && target.leaderId === reader.membershipId && reader.role !== null;
    if (!direct || !reader.role) return SAY.ORG_ROLE_CHANGE_NOT_PERMITTED.directLeaderOnly;
    if (rankOf(target.role) > rankOf(reader.role)) {
      return SAY.ORG_ROLE_CHANGE_NOT_PERMITTED.officeOnly({ rung: await this.seniorRungName(ctx, target, toClass, level) });
    }
    return SAY.ORG_ROLE_CHANGE_NOT_PERMITTED.aboveOwnRung({ rung: shortOfRung(level) });
  }

  /**
   * **The senior rung a refused change involves, by the name a role is called** (ADR-0167 §10, OD-205; P18.7-T9
   * AC-1): the rung asked for when the change is onto it, the one they stand on when it is off it — `shortOfRung`,
   * so the default ladder says *AB* and a company's own rung its own name. Read only to word the refusal; a rung
   * since taken off the ladder is named by its code.
   */
  private async seniorRungName(
    ctx: RequestContext,
    target: MembershipDocument,
    toClass: HierarchyRole,
    level: { code: string; label: string },
  ): Promise<string> {
    if (toClass === 'ab') return shortOfRung(level);
    const held = await this.hierarchy.rungFor(ctx, target.orgLevelCode).then(
      ({ level: rung }) => rung,
      (err: unknown) => {
        if (err instanceof DomainException && err.code === ErrorCode.ORG_LEVEL_NOT_ON_LADDER) return null;
        throw err;
      },
    );
    return shortOfRung(held ?? { code: target.orgLevelCode, label: target.orgLevelCode });
  }

  /** The write, once every refusal has been met: the rung, the edge, the counts, the notice and the audit row. */
  private async apply(
    ctx: RequestContext,
    target: MembershipDocument,
    toRole: string,
    reason: string | undefined,
    actorMembershipId: string,
    pastLimit?: ApprovedPastLimit,
  ): Promise<void> {
    const membershipId = String(target._id);
    const fromRole = target.role;
    const fromOrgLevelId = target.orgLevelId;
    // Through the hierarchy service, which writes the reference and the enum together.
    // A `$set: { role }` here would leave `orgLevelId` on the rung they left.
    const moved = await this.hierarchy.setLevel(ctx, membershipId, toRole, pastLimit);

    // Append-only: the open edge is closed, and a new one opened. The Role change log
    // reads exactly these rows, and nothing else could reconstruct them.
    //
    // **Every open edge, not only an earlier role change** (P11-T3). This closed
    // `role_changed` rows alone, so a promotion left the edge they joined or moved on open
    // beside it: two current edges. The row carries the leader they keep, since a role
    // change moves nobody (ADR-0014), so the one open edge says all of where they stand.
    await this.history.openEdge(ctx, this.clock.now(), {
      membershipId,
      eventType: 'role_changed',
      fromRole,
      // The class written, which is the rung's tier's (ADR-0156) — the one the log and the badge read.
      toRole: moved.role,
      // The rungs those names referred to at the time. A company that later renames a
      // level leaves this row still legible.
      fromOrgLevelId,
      toOrgLevelId: moved.orgLevelId,
      toLeaderId: target.leaderId,
      // Whoever made the change — or, approved past the limit, whoever asked for it (ADR-0157 §3).
      actorMembershipId,
      reason: reason?.trim() || null,
    });

    // The leader's cached counts break down by role, so a promotion changes them even
    // though nobody moved.
    await this.hierarchy.refreshCounts(ctx, target.leaderId);

    await this.notifications.send({
      userId: target.userId,
      kpmId: ctx.kpmId,
      templateId: NotificationTemplate.ROLE_CHANGED,
      payload: { fromRole, toRole: moved.role, reason: reason?.trim() ?? null },
    });

    await this.audit.record(ctx, {
      action: 'member.role_changed',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before: { role: fromRole },
      after: {
        role: moved.role,
        reason: reason?.trim() ?? null,
        ...(pastLimit ? { leaderLimitRequestId: pastLimit.approvedRequestId } : {}),
      },
    });
  }

  /**
   * The Role change log — the only audit surface either prototype has.
   *
   * Read from `membershipHistory` rather than the audit log: this is a product screen
   * about people, not a security trail, and the history rows are the ones that carry
   * the before-and-after of a role.
   */
  async log(ctx: RequestContext, limit = 100): Promise<RoleChangeEntry[]> {
    this.requireMember(ctx);

    const rows = await this.history.find(
      ctx,
      { eventType: 'role_changed' },
      { sort: { validFrom: -1 }, limit },
    );
    if (rows.length === 0) return [];

    const memberships = await this.members.find(ctx, {
      _id: { $in: [...new Set([...rows.map((r) => r.membershipId), ...rows.map((r) => r.actorMembershipId).filter((a): a is string => !!a)])] },
    });
    const byMembership = new Map(memberships.map((m) => [String(m._id), m]));

    const users = await this.users
      .find({ _id: { $in: memberships.map((m) => m.userId) } })
      .exec();
    const nameOf = new Map(users.map((u) => [String(u._id), u.fullName]));
    const named = (membershipId: string | null) => {
      const membership = membershipId ? byMembership.get(membershipId) : null;
      return membership ? (nameOf.get(membership.userId) ?? null) : null;
    };

    return rows.map((r) => {
      const membership = byMembership.get(r.membershipId);
      return {
        membershipId: r.membershipId,
        fullName: named(r.membershipId) ?? render(ORG_MESSAGES.unknownName, ctx.reader),
        agentCode: membership?.agentCode ?? '',
        fromRole: r.fromRole,
        toRole: r.toRole,
        reason: r.reason,
        actorName: named(r.actorMembershipId),
        changedAt: r.validFrom.toISOString(),
      };
    });
  }
}
