import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { isLeaderClass } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { GroupDocument } from './group.schema';
import type { MembershipDocument } from './membership.schema';
import { GroupRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { ORG_MESSAGES, ORG_REFUSALS } from './org.messages';

const SAY = ORG_REFUSALS;

export interface GroupSummary {
  groupId: string;
  name: string;
  ownerMembershipId: string;
  ownerName: string;
  /**
   * The owner has been removed from the office.
   *
   * They are still named — they really are the recorded owner, and a blank would look
   * like a fault. But an Owner reading the list needs to know the group has nobody
   * running it, so the flag travels and the screen says both.
   */
  ownerHasLeft: boolean;
  memberCount: number;
}

/** What one person is tagged with. */
export interface MemberTags {
  membershipId: string;
  fullName: string;
  groupIds: string[];
  /** The tag as stored. Effective only while `canBeCoreLeader` (ADR-0159 §1). */
  isCoreLeader: boolean;
  /**
   * **Their rung is a leader rung** (ADR-0159 §1, ADR-0156): the tag may be set, and has effect. False for an Agent,
   * whose tag is refused `CORE_LEADER_NOT_A_LEADER` — and for a member tagged and since moved off a leader rung,
   * whose tag stays and does nothing until they lead again. Sent so the person page offers the box only where the
   * write would be taken.
   */
  canBeCoreLeader: boolean;
}

/**
 * Groups and the Core Leader tag.
 *
 * **Neither is hierarchy.** A group is a label an office puts on people it wants to organise — a mentoring
 * circle, a task force — and grants nothing. Core Leader is a separate label, **a leader's** (ADR-0159 §1): set
 * only on a member whose rung is a leader rung, under `member:tag_core_leader`, and it opens two readings — the
 * Strategic Leader Forum (Phase 18.1, D-coeditors) and the office's KPM analytics, read-only (ADR-0159 §2). It
 * widens no scope of the hierarchy: what a Core Leader sees of their own unit is what they saw before.
 *
 * P3-T9 AC-1 is the load-bearing one: **a group never participates in scope
 * resolution.** `visibleTo` reads the graph and nothing else, and there is a test that
 * fails if tagging somebody changes what anybody can see. A tag that quietly granted
 * access would be an access-control mechanism nobody designed.
 */
@Injectable()
export class GroupService {
  constructor(
    private readonly groups: GroupRepository,
    private readonly members: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private requireTenantAdmin(ctx: RequestContext): string {
    if (!ctx.kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        SAY.TENANT_NO_MEMBERSHIP.notInOffice,
        HttpStatus.FORBIDDEN,
      );
    }
    return ctx.kpmId;
  }

  async list(ctx: RequestContext): Promise<GroupSummary[]> {
    this.requireTenantAdmin(ctx);

    const rows = await this.groups.find(ctx, { status: 'active' }, { sort: { name: 1 } });
    if (rows.length === 0) return [];

    // One count for every group, rather than one query per group.
    const tagged = await this.members.find(ctx, {
      groupIds: { $in: rows.map((g) => String(g._id)) },
      status: { $ne: 'removed' },
    });
    const counts = new Map<string, number>();
    for (const member of tagged) {
      for (const groupId of member.groupIds ?? []) {
        counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
      }
    }

    const owners = await this.members.find(ctx, {
      _id: { $in: [...new Set(rows.map((g) => g.ownerMembershipId))] },
    });
    const named = await this.namesFor(owners.map((o) => o.userId));
    // An owner whose account is gone is still named, in the reader's language (P18.98-T5 AC-4).
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    const byMembership = new Map(
      owners.map((o) => [
        String(o._id),
        { name: named.get(o.userId) ?? unknown, hasLeft: o.status === 'removed' },
      ]),
    );

    return rows.map((g) => ({
      groupId: String(g._id),
      name: g.name,
      ownerMembershipId: g.ownerMembershipId,
      ownerName: byMembership.get(g.ownerMembershipId)?.name ?? unknown,
      ownerHasLeft: byMembership.get(g.ownerMembershipId)?.hasLeft ?? true,
      memberCount: counts.get(String(g._id)) ?? 0,
    }));
  }

  async create(
    ctx: RequestContext,
    input: { name: string; ownerMembershipId: string },
  ): Promise<GroupSummary[]> {
    this.requireTenantAdmin(ctx);
    const name = input.name.trim();
    await this.requireOwnerInOffice(ctx, input.ownerMembershipId);
    await this.requireNameFree(ctx, name, null);

    const created = await this.groups.create(ctx, {
      name,
      ownerMembershipId: input.ownerMembershipId,
      status: 'active',
      createdByMembershipId: ctx.membershipId,
    } as Partial<GroupDocument>);

    await this.audit.record(ctx, {
      action: 'group.created',
      targetCollection: 'groups',
      targetId: String(created._id),
      after: { name, ownerMembershipId: input.ownerMembershipId },
    });

    return this.list(ctx);
  }

  async rename(
    ctx: RequestContext,
    groupId: string,
    input: { name: string; ownerMembershipId: string },
  ): Promise<GroupSummary[]> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const name = input.name.trim();
    await this.requireOwnerInOffice(ctx, input.ownerMembershipId);
    await this.requireNameFree(ctx, name, groupId);

    const before = { name: group.name, ownerMembershipId: group.ownerMembershipId };
    await this.groups.updateById(ctx, groupId, {
      $set: { name, ownerMembershipId: input.ownerMembershipId },
    });

    await this.audit.record(ctx, {
      action: 'group.updated',
      targetCollection: 'groups',
      targetId: groupId,
      before,
      after: { name, ownerMembershipId: input.ownerMembershipId },
    });

    return this.list(ctx);
  }

  /**
   * Retiring a group.
   *
   * The prototype splices the row and strips the id from everybody's tags in the same
   * breath, with no confirmation — so the record that these people were ever a cohort is
   * gone. Here the group is archived and **the tags stay**: the group stops being offered
   * and stops being counted, and anybody looking at last year's mentoring circle can
   * still see who was in it.
   */
  async archive(ctx: RequestContext, groupId: string): Promise<GroupSummary[]> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);

    await this.groups.updateById(ctx, groupId, {
      $set: { status: 'archived', archivedAt: this.clock.now() },
    });

    await this.audit.record(ctx, {
      action: 'group.archived',
      targetCollection: 'groups',
      targetId: groupId,
      before: { status: 'active', name: group.name },
      after: { status: 'archived' },
    });

    return this.list(ctx);
  }

  /** What this person is tagged with, and every group they could be. */
  async tagsFor(ctx: RequestContext, membershipId: string): Promise<MemberTags> {
    this.requireTenantAdmin(ctx);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');

    const named = await this.namesFor([member.userId]);
    return {
      membershipId,
      fullName: named.get(member.userId) ?? render(ORG_MESSAGES.unknownName, ctx.reader),
      // Only groups that still exist: an archived one stays on the row but is not offered
      // back, so re-saving the panel does not silently re-add it.
      groupIds: member.groupIds ?? [],
      isCoreLeader: member.isCoreLeader ?? false,
      canBeCoreLeader: isLeaderClass(member.role),
    };
  }

  async tag(
    ctx: RequestContext,
    membershipId: string,
    input: { groupIds: string[]; isCoreLeader: boolean },
  ): Promise<MemberTags> {
    this.requireTenantAdmin(ctx);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    this.requireCoreLeaderChange(ctx, member, input.isCoreLeader);

    // Every id has to be a live group in **this** office. Without the check, a group id
    // from another tenant would sit on the row unnoticed and count nowhere.
    const wanted = [...new Set(input.groupIds)];
    if (wanted.length > 0) {
      const found = await this.groups.find(ctx, { _id: { $in: wanted }, status: 'active' });
      if (found.length !== wanted.length) {
        throw new DomainException(
          ErrorCode.ORG_GROUP_NOT_FOUND,
          SAY.ORG_GROUP_NOT_FOUND.notHere,
          HttpStatus.NOT_FOUND,
          { membershipId },
        );
      }
    }

    // Tags on archived groups are kept — they are the record of a past cohort — so the
    // write is a union of what the panel offered and what it could not.
    const offered = new Set(
      (await this.groups.find(ctx, { status: 'active' })).map((g) => String(g._id)),
    );
    const retained = (member.groupIds ?? []).filter((id) => !offered.has(id));
    const groupIds = [...new Set([...wanted, ...retained])];

    const before = { groupIds: member.groupIds ?? [], isCoreLeader: member.isCoreLeader ?? false };
    await this.members.updateById(ctx, membershipId, {
      $set: { groupIds, isCoreLeader: input.isCoreLeader },
    });

    await this.audit.record(ctx, {
      action: 'member.tagged',
      targetCollection: 'memberships',
      targetId: membershipId,
      targetMembershipId: membershipId,
      before,
      after: { groupIds, isCoreLeader: input.isCoreLeader },
    });

    return this.tagsFor(ctx, membershipId);
  }

  /**
   * **Tag or untag one member *Core Leader*, and nothing else** (ADR-0159 §1, P18.8-T5 AC-2, AC-3): the directory
   * row's control. Their groups are untouched, so the row needs no copy of them to send back. The same refusals as
   * `tag`, and the same audit entry, with both halves of the tags before and after. Setting what is already set
   * writes nothing.
   */
  async setCoreLeader(ctx: RequestContext, membershipId: string, isCoreLeader: boolean): Promise<MemberTags> {
    this.requireTenantAdmin(ctx);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    this.requireCoreLeaderChange(ctx, member, isCoreLeader);

    const before = member.isCoreLeader ?? false;
    if (before !== isCoreLeader) {
      const groupIds = member.groupIds ?? [];
      await this.members.updateById(ctx, membershipId, { $set: { isCoreLeader } });
      await this.audit.record(ctx, {
        action: 'member.tagged',
        targetCollection: 'memberships',
        targetId: membershipId,
        targetMembershipId: membershipId,
        before: { groupIds, isCoreLeader: before },
        after: { groupIds, isCoreLeader },
      });
    }
    return this.tagsFor(ctx, membershipId);
  }

  /**
   * **A change to the Core Leader tag** (ADR-0159 §1): checked against `member:tag_core_leader` — the permission the
   * matrix names for it, which `member:tag_group` on the route does not imply — and **set only on a leader**:
   * `400 CORE_LEADER_NOT_A_LEADER` for a member whose rung is not a leader rung. Nothing is asked when the tag is
   * not changing, so a member tagged and since moved to an Agent's rung can still have their groups saved, the tag
   * kept and without effect; and untagging them is always taken.
   */
  private requireCoreLeaderChange(ctx: RequestContext, member: MembershipDocument, wanted: boolean): void {
    if (wanted === (member.isCoreLeader ?? false)) return;
    if (!can(ctx, 'member:tag_core_leader')) throw new PermissionDeniedException('member:tag_core_leader');
    if (wanted && !isLeaderClass(member.role)) {
      throw new DomainException(
        ErrorCode.CORE_LEADER_NOT_A_LEADER,
        SAY.CORE_LEADER_NOT_A_LEADER.leadersOnly,
        HttpStatus.BAD_REQUEST,
        { membershipId: String(member._id), role: member.role },
      );
    }
  }

  /**
   * One live group of this office.
   *
   * A malformed id is "not here", not a 500 — the repository already answers `null` for an
   * id that cannot match anything, so the `catch` this used to carry is gone with it.
   */
  private async find(ctx: RequestContext, groupId: string): Promise<GroupDocument> {
    const group = await this.groups.findOne(ctx, { _id: groupId, status: 'active' });
    if (!group) throw new NotFoundException('Group');
    return group;
  }

  private async requireOwnerInOffice(ctx: RequestContext, membershipId: string): Promise<void> {
    const owner = await this.members.findById(ctx, membershipId);
    if (!owner || owner.status === 'removed') {
      throw new DomainException(
        ErrorCode.ORG_GROUP_OWNER_NOT_IN_KPM,
        SAY.ORG_GROUP_OWNER_NOT_IN_KPM.ownerInOffice,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { ownerMembershipId: membershipId },
      );
    }
  }

  private async requireNameFree(
    ctx: RequestContext,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await this.groups.findOne(ctx, { name, status: 'active' });
    if (clash && String(clash._id) !== exceptId) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_NAME_TAKEN,
        SAY.ORG_GROUP_NAME_TAKEN.taken({ name }),
        HttpStatus.CONFLICT,
        { name },
      );
    }
  }

  private async namesFor(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const found = await this.users.find({ _id: { $in: [...new Set(userIds)] } }).exec();
    return new Map(found.map((u) => [String(u._id), u.fullName]));
  }
}
