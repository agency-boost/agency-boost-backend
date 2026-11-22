import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { requireOfficeSteward } from '@/common/auth/office-steward';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render } from '@/common/i18n/sentence';
import { isLeaderClass } from '@/domain/constants';
import { AB_ROLE, byGroupName } from '@/domain/metrics/leader-groups';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { OfficeGroups, type InformalPartition } from '@/modules/reporting/office-groups';
import { User, UserDocument } from '@/modules/users/user.schema';
import { GroupDocument } from './group.schema';
import type { MembershipDocument } from './membership.schema';
import { GroupRepository } from './org.repositories';
import { MembershipRepository } from './membership.repository';
import { ORG_MESSAGES, ORG_REFUSALS } from './org.messages';

const SAY = ORG_REFUSALS;

/** The counts a group card and an AB group row carry: *n leader · n orang*, and on a card *n AB group*. */
export interface InformalGroupCounts {
  /** ABs and AABs among its people. */
  leaders: number;
  /** Its people: every active member of its AB groups, test accounts not counted. */
  people: number;
  /** Its AB groups: the ABs that carry it. */
  abGroups: number;
}

/** One AB in a group, or in *Tanpa group*: their AB group's size beside them. */
export interface InformalGroupAb {
  membershipId: string;
  name: string;
  agentCode: string | null;
  /** They are one of the group's Group Leaders. Always `false` in *Tanpa group*. */
  isGroupLeader: boolean;
  /** The ★ core leader tag (ADR-0159), for the chips beside the name. */
  isCoreLeader: boolean;
  /** *n orang di grupnya*: the AB group, them included. */
  people: number;
  /** ABs and AABs in their AB group, them included. */
  leaders: number;
}

/** One live group: its Group Leaders while they hold, its ABs A to Z, and its counts. */
export interface InformalGroupRow {
  groupId: string;
  name: string;
  /** The Group Leaders, A to Z — *Group Leader WILSON TANOTO* — or none. */
  leaders: { membershipId: string; name: string }[];
  abs: InformalGroupAb[];
  counts: InformalGroupCounts;
}

/**
 * **`GET /members/groups`, and what every group write answers** (P19.17-T4; ADR-0270): the live groups A to Z, then
 * *Tanpa group*, partitioning every AB group of the office.
 */
export interface InformalGroupsView {
  groups: InformalGroupRow[];
  /** *Tanpa group*: the ABs with no group, and their AB groups' counts. */
  ungrouped: { abs: InformalGroupAb[]; counts: InformalGroupCounts };
  /** Active members under no active AB: in the KPM's total, in no AB group. */
  unplaced: number;
  /** The groups may be written here: the Super Admin in the KPM, the Owner, an Admin or a core leader, never view-as. */
  canWrite: boolean;
}

/** `POST /members/groups`: the group made, and the groups as they now stand. */
export interface InformalGroupCreated {
  groupId: string;
  view: InformalGroupsView;
}

/** *+ Tambah ke grup*'s answer (the Unit Dashboard's *Grup informal* sheet). */
export interface GroupMembersAdded {
  groupId: string;
  name: string;
  /** ABs moved into it by this request; one already in it is not counted again. */
  added: number;
  /** The group's people now: every AB group in it. */
  memberCount: number;
}

/** What one person is tagged with, for the member page's panel. */
export interface MemberTags {
  membershipId: string;
  fullName: string;
  /** An AB's one group, `[]` for none; always `[]` for an AAB or an agent, who follow their AB. */
  groupIds: string[];
  /** The tag as stored. Effective only while `canBeCoreLeader` (ADR-0159 §1). */
  isCoreLeader: boolean;
  /** Their rung is a leader rung (ADR-0159 §1, ADR-0156): the Core leader tag may be set, and has effect. */
  canBeCoreLeader: boolean;
  /** **They are an active AB**: only they carry a group (ADR-0270 §1). An AAB or an agent reads `group` from their AB. */
  canCarryGroup: boolean;
  /** Their informal group — an AAB's or an agent's their AB's (*Group · ikut AB*) — or `null`. */
  group: { groupId: string; name: string } | null;
  /** The AB whose AB group they are in — themselves for an AB — or `null` under no AB. */
  ab: { membershipId: string; name: string } | null;
}

/**
 * **Informal groups, Group Leaders, and the Core Leader tag** (P19.17-T4;
 * [ADR-0270](../../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md)).
 *
 * - **Only an AB carries a group** (§1), one or none (*Tanpa group*), on `memberships.groupIds`; their AABs and agents
 *   **follow them** — nothing is copied, so moving an AB moves the whole team, and the KPM's totals regroup at once.
 * - **A group has any number of Group Leaders, ABs only, each in the group** (§2), `groups.leaderMembershipIds`. Made
 *   with none: *Group baru* is a name only; *Jadikan group leader · <group>* adds, *Hapus sebagai group leader* removes.
 *   An AB moved out of the group stops being one of its leaders in the same change.
 * - **Deleting a group** archives it — never deletes — and moves its ABs to *Tanpa group* (§3).
 * - **Who** (§5): the Super Admin inside the KPM, the Owner, an Admin and a core leader — the permission on each route
 *   (`group_informal:*`, `member:tag_group`, `member:read_tags`) and `requireOfficeSteward` behind it. **Every change is
 *   audited**: `member.tagged` per AB moved, before and after; `group.created`, `group.updated` (name or leaders),
 *   `group.archived`.
 *
 * P3-T9 AC-1 stands: **a group never participates in scope resolution.** Nothing in `visibleTo` reads it; a tag that
 * quietly granted access would be an access-control mechanism nobody designed.
 */
@Injectable()
export class GroupService {
  private readonly reader: OfficeGroups;

  constructor(
    private readonly groups: GroupRepository,
    private readonly members: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /** The partition, shared with every reader of the groups. Built from the two repositories when not given. */
    @Optional() reader?: OfficeGroups,
  ) {
    this.reader = reader ?? new OfficeGroups(groups, members);
  }

  /** The KPM's id, for a steward of it (`office-steward.ts`): anybody else `404`, a request in no KPM `403`. */
  requireTenantAdmin(ctx: RequestContext): string {
    return requireOfficeSteward(ctx, 'Group');
  }

  /** **`GET /members/groups`** — every live group with its Group Leaders, ABs and counts, then *Tanpa group*. */
  async list(ctx: RequestContext): Promise<InformalGroupsView> {
    this.requireTenantAdmin(ctx);
    return this.view(ctx);
  }

  /**
   * **`POST /members/groups`** — *Group baru*: **a name only** (§2), no Group Leader. With `abMembershipId` — the AB whose
   * picker made it, *"… dan timnya masuk ke group ini"* — that AB is moved into it at once, their team with them.
   */
  async create(ctx: RequestContext, input: { name: string; abMembershipId?: string | null }): Promise<InformalGroupCreated> {
    this.requireTenantAdmin(ctx);
    const name = input.name.trim();
    const ab = input.abMembershipId ? await this.requireAb(ctx, input.abMembershipId) : null;
    await this.requireNameFree(ctx, name, null);

    const created = await this.groups.create(ctx, {
      name,
      leaderMembershipIds: [],
      status: 'active',
      createdByMembershipId: ctx.membershipId,
    } as Partial<GroupDocument>);
    const groupId = String(created._id);
    await this.audit.record(ctx, {
      action: 'group.created',
      targetCollection: 'groups',
      targetId: groupId,
      after: { name, leaderMembershipIds: [] },
    });
    if (ab) await this.moveAbs(ctx, [ab], groupId);
    return { groupId, view: await this.view(ctx) };
  }

  /** **`PUT /members/groups/:groupId`** — *Ubah nama*. The ABs carry the group's id, never its name, so they follow. */
  async rename(ctx: RequestContext, groupId: string, input: { name: string }): Promise<InformalGroupsView> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const name = input.name.trim();
    await this.requireNameFree(ctx, name, groupId);
    if (name !== group.name) {
      await this.groups.updateById(ctx, groupId, { $set: { name } });
      await this.audit.record(ctx, {
        action: 'group.updated',
        targetCollection: 'groups',
        targetId: groupId,
        before: { name: group.name },
        after: { name },
      });
    }
    return this.view(ctx);
  }

  /**
   * **`DELETE /members/groups/:groupId`** — *Hapus group* (§3): **archived**, never deleted, its Group Leaders cleared,
   * and **every row carrying it untagged**, so its ABs — and their teams — read *Tanpa group*. One `member.tagged` per
   * row untagged, then `group.archived` with the leaders it had and how many it untagged.
   */
  async archive(ctx: RequestContext, groupId: string): Promise<InformalGroupsView> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const id = String(group._id);

    const tagged = await this.members.find(ctx, { groupIds: id });
    if (tagged.length > 0) {
      await this.members.updateMany(ctx, { _id: { $in: tagged.map((m) => String(m._id)) } }, { $pull: { groupIds: id } });
      await this.audit.recordMany(ctx, tagged.map((m) => this.tagEntry(m, (m.groupIds ?? []).filter((g) => g !== id))));
    }
    await this.groups.updateById(ctx, groupId, {
      $set: { status: 'archived', archivedAt: this.clock.now(), leaderMembershipIds: [] },
    });
    await this.audit.record(ctx, {
      action: 'group.archived',
      targetCollection: 'groups',
      targetId: groupId,
      before: { status: 'active', name: group.name, leaderMembershipIds: group.leaderMembershipIds ?? [] },
      after: { status: 'archived', untagged: tagged.length },
    });
    return this.view(ctx);
  }

  /**
   * **`PUT /members/:membershipId/group`** — the AB's group chip and the *Group* dialog (§1): an active AB of this KPM into
   * a live group, or `null` — *Tanpa group*. **The whole team follows**: it is derived, so nothing else is written. An
   * AAB or an agent is `422 ORG_GROUP_AB_ONLY` — they follow their AB; anybody not active here `404`.
   */
  async setAbGroup(ctx: RequestContext, membershipId: string, groupId: string | null): Promise<InformalGroupsView> {
    this.requireTenantAdmin(ctx);
    const ab = await this.requireAb(ctx, membershipId);
    if (groupId !== null) await this.find(ctx, groupId);
    await this.moveAbs(ctx, [ab], groupId);
    return this.view(ctx);
  }

  /**
   * **`PUT /members/groups/:groupId/leaders/:membershipId`** — *Jadikan group leader · <group>* (§2): **adds**, never
   * replaces. An active AB who is in this group — an AB in another group or none `422 ORG_GROUP_LEADER_NOT_IN_GROUP`, an
   * AAB or an agent `422 ORG_GROUP_AB_ONLY`. One already a leader of it writes nothing.
   */
  async addLeader(ctx: RequestContext, groupId: string, membershipId: string): Promise<InformalGroupsView> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const ab = await this.requireAb(ctx, membershipId);
    if ((await this.groupOfAb(ctx, ab)) !== String(group._id)) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_LEADER_NOT_IN_GROUP, SAY.ORG_GROUP_LEADER_NOT_IN_GROUP.inGroup({ name: group.name }),
        HttpStatus.UNPROCESSABLE_ENTITY, { groupId, membershipId },
      );
    }
    const before = group.leaderMembershipIds ?? [];
    if (!before.includes(membershipId)) await this.setLeaders(ctx, group, [...before, membershipId]);
    return this.view(ctx);
  }

  /**
   * **`DELETE /members/groups/:groupId/leaders/:membershipId`** — *Hapus sebagai group leader*: the AB is no longer one of
   * the group's leaders, and stays in it. Somebody not among its leaders writes nothing.
   */
  async removeLeader(ctx: RequestContext, groupId: string, membershipId: string): Promise<InformalGroupsView> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const before = group.leaderMembershipIds ?? [];
    if (before.includes(membershipId)) await this.setLeaders(ctx, group, before.filter((id) => id !== membershipId));
    return this.view(ctx);
  }

  /**
   * ***+ Tambah ke grup*** (the Unit Dashboard's *Grup informal* sheet; ADR-0249 §4 as ADR-0270 amends it): **several ABs
   * into one group at once**, each with their team. Everything is checked first — the group a live one of this KPM, every
   * id an active member of it (`404` otherwise, and nothing moved), every one an AB (`422 ORG_GROUP_AB_ONLY`) — then one
   * write; an AB already in the group is not counted again.
   */
  async addMembers(ctx: RequestContext, groupId: string, membershipIds: readonly string[]): Promise<GroupMembersAdded> {
    this.requireTenantAdmin(ctx);
    const group = await this.find(ctx, groupId);
    const wanted = [...new Set(membershipIds)];
    if (!wanted.every((id) => isValidObjectId(id))) throw new NotFoundException('Membership');
    const found = await this.members.find(ctx, { _id: { $in: wanted }, status: 'active' });
    if (found.length !== wanted.length) throw new NotFoundException('Membership');
    for (const m of found) this.requireAbRole(m);

    const id = String(group._id);
    const moved = await this.moveAbs(ctx, found, id);
    const partition = await this.reader.partition(ctx);
    const abIds = partition.groups.find((g) => g.groupId === id)?.abIds ?? [];
    return { groupId: id, name: group.name, added: moved, memberCount: this.reader.peopleOf(partition, abIds).length };
  }

  /** **`GET /members/:membershipId/tags`** — what this person is tagged with, and their group if they follow an AB. */
  async tagsFor(ctx: RequestContext, membershipId: string): Promise<MemberTags> {
    this.requireTenantAdmin(ctx);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    const where = await this.reader.informalGroupOf(ctx, membershipId);
    const named = await this.namesOf(ctx, [membershipId, ...(where.abMembershipId ? [where.abMembershipId] : [])]);
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    const isAb = this.isActiveAb(member);
    return {
      membershipId,
      fullName: named.get(membershipId) ?? unknown,
      groupIds: isAb && where.group ? [where.group.groupId] : [],
      isCoreLeader: member.isCoreLeader ?? false,
      canBeCoreLeader: isLeaderClass(member.role),
      canCarryGroup: isAb,
      group: where.group,
      ab: where.abMembershipId ? { membershipId: where.abMembershipId, name: named.get(where.abMembershipId) ?? unknown } : null,
    };
  }

  /**
   * **`PUT /members/:membershipId/tags`** — the member page's panel: an AB's one group (`[]` for *Tanpa group*; two or
   * more `400 ORG_GROUP_ONE_PER_LEADER`), and the Core leader tag. A group on an AAB or an agent is `422
   * ORG_GROUP_AB_ONLY`; `[]` for them clears whatever their row carried from before the rule.
   */
  async tag(ctx: RequestContext, membershipId: string, input: { groupIds: string[]; isCoreLeader: boolean }): Promise<MemberTags> {
    this.requireTenantAdmin(ctx);
    const member = await this.members.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    this.requireCoreLeaderChange(ctx, member, input.isCoreLeader);

    const wanted = [...new Set(input.groupIds)];
    if (wanted.length > 0) {
      const found = await this.groups.find(ctx, { _id: { $in: wanted }, status: 'active' });
      if (found.length !== wanted.length) {
        throw new DomainException(ErrorCode.ORG_GROUP_NOT_FOUND, SAY.ORG_GROUP_NOT_FOUND.notHere, HttpStatus.NOT_FOUND, { membershipId });
      }
      this.requireAbRole(member);
    }
    if (wanted.length > 1) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_ONE_PER_LEADER, SAY.ORG_GROUP_ONE_PER_LEADER.oneGroup, HttpStatus.BAD_REQUEST,
        { membershipId, groupIds: wanted },
      );
    }

    const before = { groupIds: member.groupIds ?? [], isCoreLeader: member.isCoreLeader ?? false };
    const after = { groupIds: wanted, isCoreLeader: input.isCoreLeader };
    if (!sameList(before.groupIds, after.groupIds) || before.isCoreLeader !== after.isCoreLeader) {
      await this.members.updateById(ctx, membershipId, { $set: after });
      await this.dropLeadership(ctx, [membershipId], wanted[0] ?? null);
      await this.audit.record(ctx, {
        action: 'member.tagged', targetCollection: 'memberships', targetId: membershipId, targetMembershipId: membershipId,
        before, after,
      });
    }
    return this.tagsFor(ctx, membershipId);
  }

  /**
   * **`PUT /members/:membershipId/core-leader`** — *Jadikan core leader* / *Hapus dari core leader* (ADR-0159 §1; All
   * members ⋯): the Core Leader flag alone, the group untouched. A leader's only. The same value again writes nothing.
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
        action: 'member.tagged', targetCollection: 'memberships', targetId: membershipId, targetMembershipId: membershipId,
        before: { groupIds, isCoreLeader: before },
        after: { groupIds, isCoreLeader },
      });
    }
    return this.tagsFor(ctx, membershipId);
  }

  /**
   * **A change to the Core Leader tag** (ADR-0159 §1): checked against `member:tag_core_leader` — the Super Admin in the
   * KPM, the Owner and an Admin, **never a core leader** (PERMISSIONS.md) — and set only on a leader: `400
   * CORE_LEADER_NOT_A_LEADER` otherwise. Nothing is asked when the tag is not changing.
   */
  requireCoreLeaderChange(ctx: RequestContext, member: MembershipDocument, wanted: boolean): void {
    if (wanted === (member.isCoreLeader ?? false)) return;
    if (!can(ctx, 'member:tag_core_leader')) throw new PermissionDeniedException('member:tag_core_leader');
    if (wanted && !isLeaderClass(member.role)) {
      throw new DomainException(
        ErrorCode.CORE_LEADER_NOT_A_LEADER, SAY.CORE_LEADER_NOT_A_LEADER.leadersOnly, HttpStatus.BAD_REQUEST,
        { membershipId: String(member._id), role: member.role },
      );
    }
  }

  /** One live group of this KPM, or `404` — a malformed id, an archived group and another KPM's alike. */
  async find(ctx: RequestContext, groupId: string): Promise<GroupDocument> {
    const group = await this.groups.findOne(ctx, { _id: groupId, status: 'active' });
    if (!group) throw new NotFoundException('Group');
    return group;
  }

  // ------------------------------------------------------------------------------------------------ the writes

  /**
   * **ABs into one group, or none** — each AB's `groupIds` set to `[groupId]` or `[]`, one write for all, one
   * `member.tagged` entry per AB whose tags changed; then each comes off the leaders of every other group. Answers how
   * many changed.
   */
  private async moveAbs(ctx: RequestContext, abs: readonly MembershipDocument[], groupId: string | null): Promise<number> {
    const next = groupId === null ? [] : [groupId];
    const changed = abs.filter((m) => !sameList(m.groupIds ?? [], next));
    if (changed.length > 0) {
      await this.members.updateMany(ctx, { _id: { $in: changed.map((m) => String(m._id)) } }, { $set: { groupIds: next } });
      await this.audit.recordMany(ctx, changed.map((m) => this.tagEntry(m, next)));
    }
    await this.dropLeadership(ctx, abs.map((m) => String(m._id)), groupId);
    return changed.length;
  }

  /** **Out of a group, out of its leaders** (§2): every live group but `kept` that lists one of them loses them. */
  private async dropLeadership(ctx: RequestContext, membershipIds: readonly string[], kept: string | null): Promise<void> {
    if (membershipIds.length === 0) return;
    const led = await this.groups.find(ctx, { status: 'active', leaderMembershipIds: { $in: [...membershipIds] } });
    const leaving = new Set(membershipIds);
    for (const group of led.filter((g) => String(g._id) !== kept)) {
      await this.setLeaders(ctx, group, (group.leaderMembershipIds ?? []).filter((id) => !leaving.has(id)));
    }
  }

  /** **A group's leaders set**, audited `group.updated` with the list before and after. */
  private async setLeaders(ctx: RequestContext, group: GroupDocument, after: string[]): Promise<void> {
    const groupId = String(group._id);
    await this.groups.updateById(ctx, groupId, { $set: { leaderMembershipIds: after } });
    await this.audit.record(ctx, {
      action: 'group.updated',
      targetCollection: 'groups',
      targetId: groupId,
      before: { name: group.name, leaderMembershipIds: group.leaderMembershipIds ?? [] },
      after: { name: group.name, leaderMembershipIds: after },
    });
  }

  private tagEntry(m: MembershipDocument, groupIds: string[]) {
    const isCoreLeader = m.isCoreLeader ?? false;
    return {
      action: 'member.tagged',
      targetCollection: 'memberships',
      targetId: String(m._id),
      targetMembershipId: String(m._id),
      before: { groupIds: m.groupIds ?? [], isCoreLeader },
      after: { groupIds, isCoreLeader },
    };
  }

  // ------------------------------------------------------------------------------------------------ the reads

  /** The view every read and write answers: the partition, named. */
  private async view(ctx: RequestContext): Promise<InformalGroupsView> {
    const partition = await this.reader.partition(ctx);
    const abIds = [...partition.abGroups.keys()];
    const leaderIds = partition.groups.flatMap((g) => g.leaderIds);
    const names = await this.namesOf(ctx, [...new Set([...abIds, ...leaderIds])], partition);
    const byName = (a: { name: string; membershipId: string }, b: { name: string; membershipId: string }) =>
      a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId);

    const abRow = (ab: string, leaders: ReadonlySet<string>): InformalGroupAb => {
      const people = partition.abGroups.get(ab)!.memberIds;
      const member = partition.members.get(ab)!;
      return {
        membershipId: ab,
        name: names.get(ab) ?? '',
        agentCode: member.agentCode,
        isGroupLeader: leaders.has(ab),
        isCoreLeader: member.isCoreLeader,
        people: people.length,
        leaders: people.filter((id) => isLeaderClass(partition.members.get(id)?.role)).length,
      };
    };
    const counts = (rows: readonly InformalGroupAb[]): InformalGroupCounts => ({
      leaders: rows.reduce((sum, r) => sum + r.leaders, 0),
      people: rows.reduce((sum, r) => sum + r.people, 0),
      abGroups: rows.length,
    });

    const groups = partition.groups.map((g) => {
      const leaders = new Set(g.leaderIds);
      const abs = g.abIds.map((ab) => abRow(ab, leaders)).sort(byName);
      return {
        groupId: g.groupId,
        name: g.name,
        leaders: g.leaderIds.map((id) => ({ membershipId: id, name: names.get(id) ?? '' })).sort(byName),
        abs,
        counts: counts(abs),
      };
    });
    const ungrouped = partition.ungroupedAbIds.map((ab) => abRow(ab, new Set())).sort(byName);
    return {
      groups,
      ungrouped: { abs: ungrouped, counts: counts(ungrouped) },
      unplaced: partition.unplacedIds.length,
      canWrite: can(ctx, 'member:tag_group'),
    };
  }

  /** The live group an AB reads in — their one tag, or the first by name of several left from before the rule. */
  private async groupOfAb(ctx: RequestContext, ab: MembershipDocument): Promise<string | null> {
    const tags = ab.groupIds ?? [];
    if (tags.length === 0) return null;
    const live = await this.groups.find(ctx, { _id: { $in: tags }, status: 'active' });
    return live.map((g) => ({ groupId: String(g._id), name: g.name })).sort(byGroupName)[0]?.groupId ?? null;
  }

  /** **An active AB of this KPM**: anybody not active here `404`, an AAB or an agent `422 ORG_GROUP_AB_ONLY`. */
  private async requireAb(ctx: RequestContext, membershipId: string): Promise<MembershipDocument> {
    const member = await this.members.findById(ctx, membershipId);
    if (!member || member.status !== 'active') throw new NotFoundException('Membership');
    this.requireAbRole(member);
    return member;
  }

  private requireAbRole(member: MembershipDocument): void {
    if (member.role !== AB_ROLE) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_AB_ONLY, SAY.ORG_GROUP_AB_ONLY.abOnly, HttpStatus.UNPROCESSABLE_ENTITY,
        { membershipId: String(member._id), role: member.role },
      );
    }
  }

  private isActiveAb(member: MembershipDocument): boolean {
    return member.status === 'active' && member.role === AB_ROLE;
  }

  private async requireNameFree(ctx: RequestContext, name: string, exceptId: string | null): Promise<void> {
    const clash = await this.groups.findOne(ctx, { name, status: 'active' });
    if (clash && String(clash._id) !== exceptId) {
      throw new DomainException(ErrorCode.ORG_GROUP_NAME_TAKEN, SAY.ORG_GROUP_NAME_TAKEN.taken({ name }), HttpStatus.CONFLICT, { name });
    }
  }

  /** Names by membership: from the partition's rows where read, else one read of the memberships; then the accounts. */
  private async namesOf(ctx: RequestContext, membershipIds: readonly string[], partition?: InformalPartition): Promise<Map<string, string>> {
    if (membershipIds.length === 0) return new Map();
    const userOf = new Map<string, string>();
    const missing: string[] = [];
    for (const id of membershipIds) {
      const userId = partition?.members.get(id)?.userId;
      if (userId) userOf.set(id, userId);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const rows = await this.members.find(ctx, { _id: { $in: missing } }, { projection: { userId: 1 } });
      for (const m of rows) if (m.userId) userOf.set(String(m._id), String(m.userId));
    }
    const users = userOf.size === 0 ? [] : await this.users.find({ _id: { $in: [...new Set(userOf.values())] } }).exec();
    const fullName = new Map(users.map((u) => [String(u._id), u.fullName]));
    const out = new Map<string, string>();
    for (const [id, userId] of userOf) {
      const name = fullName.get(userId);
      if (name !== undefined) out.set(id, name);
    }
    return out;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
