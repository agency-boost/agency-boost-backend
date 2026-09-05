import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Group, GroupDocument } from './group.schema';
import { MembershipRepository } from './membership.repository';

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
  isCoreLeader: boolean;
}

/**
 * Groups and the Core Leader tag.
 *
 * **Neither is hierarchy, and neither is access.** A group is a label an office puts on
 * people it wants to organise — a mentoring circle, a task force. Core Leader is a
 * separate label with exactly one consequence, and it arrives in Phase 14: who may
 * co-edit a Strategic Leader Forum minute (`KPM_Owner.html:2842`). Until then it is
 * stored and shown and does nothing, which is the honest state to be in.
 *
 * P3-T9 AC-1 is the load-bearing one: **a group never participates in scope
 * resolution.** `visibleTo` reads the graph and nothing else, and there is a test that
 * fails if tagging somebody changes what anybody can see. A tag that quietly granted
 * access would be an access-control mechanism nobody designed.
 */
@Injectable()
export class GroupService {
  constructor(
    @InjectModel(Group.name) private readonly groups: Model<GroupDocument>,
    private readonly members: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private requireTenantAdmin(ctx: RequestContext): string {
    if (!ctx.kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You are not in an office.',
        HttpStatus.FORBIDDEN,
      );
    }
    return ctx.kpmId;
  }

  async list(ctx: RequestContext): Promise<GroupSummary[]> {
    const kpmId = this.requireTenantAdmin(ctx);

    const rows = await this.groups
      .find({ kpmId, status: 'active', deletedAt: null })
      .sort({ name: 1 })
      .exec();
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
    const byMembership = new Map(
      owners.map((o) => [
        String(o._id),
        { name: named.get(o.userId) ?? 'Unknown', hasLeft: o.status === 'removed' },
      ]),
    );

    return rows.map((g) => ({
      groupId: String(g._id),
      name: g.name,
      ownerMembershipId: g.ownerMembershipId,
      ownerName: byMembership.get(g.ownerMembershipId)?.name ?? 'Unknown',
      ownerHasLeft: byMembership.get(g.ownerMembershipId)?.hasLeft ?? true,
      memberCount: counts.get(String(g._id)) ?? 0,
    }));
  }

  async create(
    ctx: RequestContext,
    input: { name: string; ownerMembershipId: string },
  ): Promise<GroupSummary[]> {
    const kpmId = this.requireTenantAdmin(ctx);
    const name = input.name.trim();
    await this.requireOwnerInOffice(ctx, input.ownerMembershipId);
    await this.requireNameFree(kpmId, name, null);

    const created = await this.groups.create({
      kpmId,
      name,
      ownerMembershipId: input.ownerMembershipId,
      status: 'active',
      createdByMembershipId: ctx.membershipId,
    });

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
    const kpmId = this.requireTenantAdmin(ctx);
    const group = await this.find(kpmId, groupId);
    const name = input.name.trim();
    await this.requireOwnerInOffice(ctx, input.ownerMembershipId);
    await this.requireNameFree(kpmId, name, groupId);

    const before = { name: group.name, ownerMembershipId: group.ownerMembershipId };
    await this.groups
      .updateOne({ _id: groupId, kpmId }, { $set: { name, ownerMembershipId: input.ownerMembershipId } })
      .exec();

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
    const kpmId = this.requireTenantAdmin(ctx);
    const group = await this.find(kpmId, groupId);

    await this.groups
      .updateOne(
        { _id: groupId, kpmId },
        { $set: { status: 'archived', archivedAt: this.clock.now() } },
      )
      .exec();

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
      fullName: named.get(member.userId) ?? 'Unknown',
      // Only groups that still exist: an archived one stays on the row but is not offered
      // back, so re-saving the panel does not silently re-add it.
      groupIds: member.groupIds ?? [],
      isCoreLeader: member.isCoreLeader ?? false,
    };
  }

  async tag(
    ctx: RequestContext,
    membershipId: string,
    input: { groupIds: string[]; isCoreLeader: boolean },
  ): Promise<MemberTags> {
    const kpmId = this.requireTenantAdmin(ctx);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');

    // Every id has to be a live group in **this** office. Without the check, a group id
    // from another tenant would sit on the row unnoticed and count nowhere.
    const wanted = [...new Set(input.groupIds)];
    if (wanted.length > 0) {
      const found = await this.groups
        .find({ _id: { $in: wanted }, kpmId, status: 'active', deletedAt: null })
        .exec();
      if (found.length !== wanted.length) {
        throw new DomainException(
          ErrorCode.ORG_GROUP_NOT_FOUND,
          'One of those groups is not in this office, or has been retired.',
          HttpStatus.NOT_FOUND,
          { membershipId },
        );
      }
    }

    // Tags on archived groups are kept — they are the record of a past cohort — so the
    // write is a union of what the panel offered and what it could not.
    const offered = new Set(
      (await this.groups.find({ kpmId, status: 'active', deletedAt: null }).exec()).map((g) =>
        String(g._id),
      ),
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

  private async find(kpmId: string, groupId: string): Promise<GroupDocument> {
    const group = await this.groups
      .findOne({ _id: groupId, kpmId, status: 'active', deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500.
      .catch(() => null);
    if (!group) throw new NotFoundException('Group');
    return group;
  }

  private async requireOwnerInOffice(ctx: RequestContext, membershipId: string): Promise<void> {
    const owner = await this.members.findById(ctx, membershipId);
    if (!owner || owner.status === 'removed') {
      throw new DomainException(
        ErrorCode.ORG_GROUP_OWNER_NOT_IN_KPM,
        'Give the group an owner who is in this office.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { ownerMembershipId: membershipId },
      );
    }
  }

  private async requireNameFree(kpmId: string, name: string, exceptId: string | null): Promise<void> {
    const clash = await this.groups
      .findOne({ kpmId, name, status: 'active', deletedAt: null })
      .exec();
    if (clash && String(clash._id) !== exceptId) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_NAME_TAKEN,
        `This office already has a group called “${name}”.`,
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
