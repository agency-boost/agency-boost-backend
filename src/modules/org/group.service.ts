import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { isLeaderClass, LEADER_CLASSES } from '@/domain/constants';
import { placeLeaders } from '@/domain/metrics/leader-groups';
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
  /** The ★ group leader as stored (ADR-0253 §2), or `null` — *Belum ada group leader*. */
  ownerMembershipId: string | null;
  ownerName: string | null;
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

/** *+ Tambah ke grup*'s answer (ADR-0249 §4). */
export interface GroupMembersAdded {
  groupId: string;
  name: string;
  /** Tagged by this request; somebody already in the group is not counted again. */
  added: number;
  /** The group's active members now. */
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
 * **Since P19.13-T3 (ADR-0253)** a leader (AB or AAB) has one group or none, and a group has at most one ★ group
 * leader — its `ownerMembershipId`, a leader who is a member of it. *Core leaders & groups* (`CoreLeadersService`) reads
 * and writes them through `placement`, `retag`, `appoint` and `releaseStars` below; deleting a group untags its members.
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

  requireTenantAdmin(ctx: RequestContext): string {
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

    const ownerIds = [...new Set(rows.flatMap((g) => (g.ownerMembershipId ? [g.ownerMembershipId] : [])))];
    const owners = ownerIds.length > 0 ? await this.members.find(ctx, { _id: { $in: ownerIds } }) : [];
    const named = await this.namesFor(owners.map((o) => o.userId));
    // An owner whose account is gone is still named, in the reader's language (P18.10-T5 AC-4).
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    const byMembership = new Map(
      owners.map((o) => [
        String(o._id),
        { name: named.get(o.userId) ?? unknown, hasLeft: o.status === 'removed' },
      ]),
    );

    return rows.map((g) => {
      const owner = g.ownerMembershipId ?? null;
      return {
        groupId: String(g._id),
        name: g.name,
        ownerMembershipId: owner,
        // No ★ (ADR-0253 §2): nobody named, and nobody to have left.
        ownerName: owner === null ? null : byMembership.get(owner)?.name ?? unknown,
        ownerHasLeft: owner === null ? false : byMembership.get(owner)?.hasLeft ?? true,
        memberCount: counts.get(String(g._id)) ?? 0,
      };
    });
  }

  /**
   * **A new group** — with no ★ (*+ Group baru*, ADR-0253 §2), or with one named, who is appointed: an active leader of
   * this office, placed in the group (their one group from now, a ★ they held elsewhere released) and given its star.
   */
  async create(
    ctx: RequestContext,
    input: { name: string; ownerMembershipId?: string | null },
  ): Promise<GroupSummary[]> {
    this.requireTenantAdmin(ctx);
    const name = input.name.trim();
    const owner = input.ownerMembershipId ? await this.requireLeaderInOffice(ctx, input.ownerMembershipId) : null;
    await this.requireNameFree(ctx, name, null);

    const created = await this.groups.create(ctx, {
      name,
      ownerMembershipId: null,
      status: 'active',
      createdByMembershipId: ctx.membershipId,
    } as Partial<GroupDocument>);

    await this.audit.record(ctx, {
      action: 'group.created',
      targetCollection: 'groups',
      targetId: String(created._id),
      after: { name, ownerMembershipId: null },
    });
    if (owner) await this.appoint(ctx, created, owner);

    return this.list(ctx);
  }

  /**
   * **Rename a group, and appoint or clear its ★** (ADR-0253 §2). `ownerMembershipId` absent keeps the ★; `null` clears
   * it (*Belum ditunjuk*); a membership appoints them — an active leader of this office, placed in the group if they
   * were not, so **the ★ is always a member**, and the star moves: the group's former ★ keeps their place in it. The
   * members follow a rename: they carry the group's id, never its name.
   */
  async rename(
    ctx: RequestContext,
    groupId: string,
    input: { name: string; ownerMembershipId?: string | null },
  ): Promise<GroupSummary[]> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const name = input.name.trim();
    const owner = input.ownerMembershipId ? await this.requireLeaderInOffice(ctx, input.ownerMembershipId) : null;
    await this.requireNameFree(ctx, name, groupId);

    if (name !== group.name) {
      await this.groups.updateById(ctx, groupId, { $set: { name } });
      await this.audit.record(ctx, {
        action: 'group.updated',
        targetCollection: 'groups',
        targetId: groupId,
        before: { name: group.name, ownerMembershipId: group.ownerMembershipId ?? null },
        after: { name, ownerMembershipId: group.ownerMembershipId ?? null },
      });
    }
    if (owner) {
      await this.appoint(ctx, (await this.find(ctx, groupId)), owner);
    } else if (input.ownerMembershipId === null && (group.ownerMembershipId ?? null) !== null) {
      await this.setOwner(ctx, groupId, name, group.ownerMembershipId ?? null, null);
    }

    return this.list(ctx);
  }

  /**
   * **Deleting a group** (*Hapus*, ADR-0253 §3, amending P3-T9): the group is **archived** — never deleted — **and every
   * member's tag on it is removed**, so its members read *Tanpa group*; their Core leader tag is untouched. One
   * `member.tagged` entry per member, before and after, then `group.archived` with how many it untagged: the record that
   * the cohort existed is the audit log now, as the owner's *"n leader di group ini akan jadi Tanpa group"* asks.
   *
   * *Changed 2026-11-12 (P19.13-T3):* until now the tags stayed on the members as the cohort's record (P3-T9).
   */
  async archive(ctx: RequestContext, groupId: string): Promise<GroupSummary[]> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const id = String(group._id);

    const tagged = await this.members.find(ctx, { groupIds: id });
    if (tagged.length > 0) {
      await this.members.updateMany(ctx, { _id: { $in: tagged.map((m) => String(m._id)) } }, { $pull: { groupIds: id } });
      await this.audit.recordMany(ctx, tagged.map((m) => {
        const before = m.groupIds ?? [];
        const isCoreLeader = m.isCoreLeader ?? false;
        return {
          action: 'member.tagged',
          targetCollection: 'memberships',
          targetId: String(m._id),
          targetMembershipId: String(m._id),
          before: { groupIds: before, isCoreLeader },
          after: { groupIds: before.filter((g) => g !== id), isCoreLeader },
        };
      }));
    }

    await this.groups.updateById(ctx, groupId, {
      $set: { status: 'archived', archivedAt: this.clock.now() },
    });

    await this.audit.record(ctx, {
      action: 'group.archived',
      targetCollection: 'groups',
      targetId: groupId,
      before: { status: 'active', name: group.name },
      after: { status: 'archived', untagged: tagged.length },
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

    // A leader has one group or none (ADR-0253 §1); an Agent may carry several, as before.
    if (wanted.length > 1 && isLeaderClass(member.role)) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_ONE_PER_LEADER,
        SAY.ORG_GROUP_ONE_PER_LEADER.oneGroup,
        HttpStatus.BAD_REQUEST,
        { membershipId, groupIds: wanted },
      );
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
    // Out of a group they led, the ★ goes with them (ADR-0253 §2).
    await this.releaseStars(ctx, [membershipId], new Set(groupIds));

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
   * **Tag or untag one member *Core Leader*, and nothing else** (ADR-0159 §1, P18.5-T5 AC-2, AC-3): the directory
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
   * ***+ Tambah ke grup*** (the client's message of 11 November 2026, item 7; ADR-0249 §4): **tag several members into one
   * group at once** — the Unit Dashboard's *Grup informal* sheet, for the ABs below a leader not yet in their group.
   *
   * Everything is checked before anything is written: the group a live one of **this** office, and **every** id an active
   * member of it — or `404`, the group's or the membership's, and nothing is tagged (another office's group or member, an
   * archived group, somebody who left and a malformed id are indistinguishable). Then `$addToSet`, so somebody already in
   * the group changes nothing; **one `member.tagged` entry per member it tagged**, before and after, as `tag` writes.
   * Their other groups and their Core Leader tag are untouched. A tag grants nothing (P3-T9 AC-1).
   */
  async addMembers(ctx: RequestContext, groupId: string, membershipIds: readonly string[]): Promise<GroupMembersAdded> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const wanted = [...new Set(membershipIds)];
    if (!wanted.every((id) => isValidObjectId(id))) throw new NotFoundException('Membership');
    const found = await this.members.find(ctx, { _id: { $in: wanted }, status: 'active' });
    if (found.length !== wanted.length) throw new NotFoundException('Membership');

    const id = String(group._id);
    const tagging = found.filter((m) => !(m.groupIds ?? []).includes(id));
    /*
     * **A leader is moved, an Agent added** (ADR-0253 §1): a leader has one group, so an AB tagged here leaves the group
     * they were in — and its ★, if it was theirs — while an Agent keeps their other groups, as before.
     */
    const leaders = tagging.filter((m) => isLeaderClass(m.role));
    const agents = tagging.filter((m) => !isLeaderClass(m.role));
    if (leaders.length > 0) await this.retag(ctx, leaders, { groupId: id });
    if (agents.length > 0) {
      await this.members.updateMany(
        ctx, { _id: { $in: agents.map((m) => String(m._id)) } }, { $addToSet: { groupIds: id } },
      );
      await this.audit.recordMany(ctx, agents.map((m) => {
        const before = m.groupIds ?? [];
        return {
          action: 'member.tagged',
          targetCollection: 'memberships',
          targetId: String(m._id),
          targetMembershipId: String(m._id),
          before: { groupIds: before, isCoreLeader: m.isCoreLeader ?? false },
          after: { groupIds: [...before, id], isCoreLeader: m.isCoreLeader ?? false },
        };
      }));
    }
    const memberCount = await this.members.count(ctx, { groupIds: id, status: 'active' });
    return { groupId: id, name: group.name, added: tagging.length, memberCount };
  }

  /**
   * **Leaders into one group, or none, and their Core leader tag** (ADR-0253 §1, §6): what *Core leaders & groups* writes
   * for one leader or many. `groupId` (when given) replaces each leader's groups — `[groupId]`, or `[]` for *Tanpa
   * group* — and the ★ of any group a leader leaves is released; `isCoreLeader` (when given) is set. The values are the
   * same for every leader, so **one write** carries them all; one `member.tagged` entry per leader whose tags changed,
   * before and after. Callers have checked every row an active leader of this office, the group live, and the Core
   * leader permission. Answers how many changed.
   */
  async retag(
    ctx: RequestContext, rows: readonly MembershipDocument[], change: { groupId?: string | null; isCoreLeader?: boolean },
  ): Promise<number> {
    const nextGroups = (m: MembershipDocument): string[] => (change.groupId === undefined
      ? m.groupIds ?? []
      : change.groupId === null ? [] : [change.groupId]);
    const nextCore = (m: MembershipDocument): boolean => change.isCoreLeader ?? m.isCoreLeader ?? false;
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const changed = rows.filter((m) => !same(m.groupIds ?? [], nextGroups(m)) || (m.isCoreLeader ?? false) !== nextCore(m));
    if (changed.length > 0) {
      const set: Record<string, unknown> = {};
      if (change.groupId !== undefined) set.groupIds = change.groupId === null ? [] : [change.groupId];
      if (change.isCoreLeader !== undefined) set.isCoreLeader = change.isCoreLeader;
      await this.members.updateMany(ctx, { _id: { $in: changed.map((m) => String(m._id)) } }, { $set: set });
      await this.audit.recordMany(ctx, changed.map((m) => ({
        action: 'member.tagged',
        targetCollection: 'memberships',
        targetId: String(m._id),
        targetMembershipId: String(m._id),
        before: { groupIds: m.groupIds ?? [], isCoreLeader: m.isCoreLeader ?? false },
        after: { groupIds: nextGroups(m), isCoreLeader: nextCore(m) },
      })));
    }
    if (change.groupId !== undefined) {
      await this.releaseStars(ctx, rows.map((m) => String(m._id)), new Set(change.groupId ? [change.groupId] : []));
    }
    return changed.length;
  }

  /**
   * **The ★ of a group its leader has left is released** (ADR-0253 §2): each live group one of `membershipIds` leads,
   * other than the groups in `kept`, loses its star — `group.updated`, before and after.
   */
  async releaseStars(ctx: RequestContext, membershipIds: readonly string[], kept: ReadonlySet<string>): Promise<void> {
    if (membershipIds.length === 0) return;
    const led = await this.groups.find(ctx, { status: 'active', ownerMembershipId: { $in: [...membershipIds] } });
    for (const group of led.filter((g) => !kept.has(String(g._id)))) {
      await this.setOwner(ctx, String(group._id), group.name, group.ownerMembershipId ?? null, null);
    }
  }

  /**
   * **Appoint a ★** (ADR-0253 §2): the leader placed in the group if they were not — their one group from now, a star
   * they held elsewhere released — and the group's owner set to them, so the former ★ loses theirs.
   */
  async appoint(ctx: RequestContext, group: GroupDocument, leader: MembershipDocument): Promise<void> {
    const groupId = String(group._id);
    await this.retag(ctx, [leader], { groupId });
    const owner = group.ownerMembershipId ?? null;
    if (owner !== String(leader._id)) await this.setOwner(ctx, groupId, group.name, owner, String(leader._id));
  }

  /** **A group's ★ set or cleared**, audited `group.updated` before and after. */
  async setOwner(ctx: RequestContext, groupId: string, name: string, before: string | null, after: string | null): Promise<void> {
    await this.groups.updateById(ctx, groupId, { $set: { ownerMembershipId: after } });
    await this.audit.record(ctx, {
      action: 'group.updated',
      targetCollection: 'groups',
      targetId: groupId,
      before: { name, ownerMembershipId: before },
      after: { name, ownerMembershipId: after },
    });
  }

  /** The office's live groups and its active leaders, placed (`placeLeaders`): each leader's one group, each group's ★. */
  async placement(ctx: RequestContext): Promise<{
    groups: GroupDocument[]; leaders: MembershipDocument[]; groupOf: Map<string, string | null>; headOf: Map<string, string | null>;
  }> {
    const [groups, leaders] = await Promise.all([
      this.groups.find(ctx, { status: 'active' }, { sort: { name: 1 } }),
      this.members.find(ctx, { status: 'active', role: { $in: [...LEADER_CLASSES] } }),
    ]);
    const { groupOf, headOf } = placeLeaders(
      leaders.map((m) => ({ membershipId: String(m._id), groupIds: m.groupIds ?? [] })),
      groups.map((g) => ({ groupId: String(g._id), name: g.name, ownerMembershipId: g.ownerMembershipId ?? null })),
    );
    return { groups, leaders, groupOf, headOf };
  }

  /**
   * **A change to the Core Leader tag** (ADR-0159 §1): checked against `member:tag_core_leader` — the permission the
   * matrix names for it, which `member:tag_group` on the route does not imply — and **set only on a leader**:
   * `400 CORE_LEADER_NOT_A_LEADER` for a member whose rung is not a leader rung. Nothing is asked when the tag is
   * not changing, so a member tagged and since moved to an Agent's rung can still have their groups saved, the tag
   * kept and without effect; and untagging them is always taken.
   */
  requireCoreLeaderChange(ctx: RequestContext, member: MembershipDocument, wanted: boolean): void {
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
  async find(ctx: RequestContext, groupId: string): Promise<GroupDocument> {
    const group = await this.groups.findOne(ctx, { _id: groupId, status: 'active' });
    if (!group) throw new NotFoundException('Group');
    return group;
  }

  /**
   * **A ★ to appoint** (ADR-0253 §2): an active member of this office — `422 ORG_GROUP_OWNER_NOT_IN_KPM` otherwise, another
   * office's, a leaver and a pending member alike — on a leader rung: `422 ORG_GROUP_LEADER_NOT_A_LEADER` for an Agent.
   */
  private async requireLeaderInOffice(ctx: RequestContext, membershipId: string): Promise<MembershipDocument> {
    const owner = await this.members.findById(ctx, membershipId);
    if (!owner || owner.status !== 'active') {
      throw new DomainException(
        ErrorCode.ORG_GROUP_OWNER_NOT_IN_KPM,
        SAY.ORG_GROUP_OWNER_NOT_IN_KPM.ownerInOffice,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { ownerMembershipId: membershipId },
      );
    }
    if (!isLeaderClass(owner.role)) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_LEADER_NOT_A_LEADER,
        SAY.ORG_GROUP_LEADER_NOT_A_LEADER.leadersOnly,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { ownerMembershipId: membershipId, role: owner.role },
      );
    }
    return owner;
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
