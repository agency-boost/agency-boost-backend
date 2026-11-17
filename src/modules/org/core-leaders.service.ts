import { HttpStatus, Injectable } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LEADER_CLASSES } from '@/domain/constants';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { can } from '@/modules/rbac/permissions';
import { AnalyticsTargetRepository } from '@/modules/reporting/advanced-analytics/advanced-analytics.repositories';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { GroupService } from './group.service';
import { MemberNames } from './member-names.service';
import type { MembershipDocument } from './membership.schema';
import { MembershipRepository } from './membership.repository';
import { ORG_REFUSALS as SAY } from './org.messages';

/** A leader's AA and recruitment targets for the year: their own, or the template's until set. */
export interface CoreLeaderTargets {
  aa: number;
  rec: number;
  /** Nothing set for this leader this year: the template's `subgroupHeadDefaults`. */
  isDefault: boolean;
}

/** One row of *Core leaders & groups*: an active AB or AAB of the office, and their three tags. */
export interface CoreLeaderRow {
  membershipId: string;
  name: string;
  agentCode: string | null;
  role: 'ab' | 'aab';
  /** Their one live group (ADR-0253 §1), or `null` — *Tanpa group*. */
  groupId: string | null;
  /** They are their group's ★ (ADR-0253 §2). */
  isGroupLeader: boolean;
  isCoreLeader: boolean;
  /** `null` while the template's *Perbaikan sub-group* is off: nothing reads the targets then. */
  targets: CoreLeaderTargets | null;
}

/** One live group, A to Z: its ★ while it holds, and how many leaders read in it. */
export interface CoreLeaderGroup {
  groupId: string;
  name: string;
  headMembershipId: string | null;
  headName: string | null;
  leaders: number;
}

/** **`GET /members/core-leaders`** — the page. */
export interface CoreLeadersView {
  /** `YYYY` on the office's clock: *Target 2026*. */
  year: string;
  /** Every active AB and AAB of the office, A to Z by name. */
  leaders: CoreLeaderRow[];
  groups: CoreLeaderGroup[];
  /** The tiles: *Core leader · Punya group · Tanpa group*, over `leaders`. */
  counts: { leaders: number; core: number; withGroup: number; withoutGroup: number };
  /** The tags and the groups may be written: the Owner and an Admin, never a view-as session. */
  canWrite: boolean;
  /** The targets may be written (`advanced_analytics:write`), with *Perbaikan sub-group* on. */
  canEditTargets: boolean;
}

/**
 * ***Core leaders & groups*** (P19.13-T3; UI-199; [ADR-0253](../../../../docs/04-adr/0253-core-leaders-and-groups-a-leader-has-one-group-a-group-one-star-leader-and-targets-are-per-leader-per-year.md);
 * `functional/org-hierarchy.md`, *Core leaders & groups*): every leader (AB and AAB) of the office with **one group or
 * none**, a **★ group leader** flag — the group's `ownerMembershipId`, at most one per group and only a member of it —
 * the **Core leader** tag (`memberships.isCoreLeader`, ADR-0159's), independent of the group, and **this year's AA and
 * recruitment targets**, which Perbaikan sub-group sums per group.
 *
 * - **Who:** the Owner and the Admins, equal (`member:read_tags` to read, `member:tag_group` to write; the Core leader tag
 *   asks `member:tag_core_leader` when it changes). The Super Admin's view-as session reads it and writes nothing.
 * - **Every row through the tenant repositories** (invariant §1): another office's leader or group is `404`.
 * - **Nothing here grants anything** (P3-T9 AC-1): a group is a label; Core leader opens what ADR-0159 says and no more.
 * - The targets are written by `PUT /kpm/advanced-analytics/targets/subgroup/:headMembershipId`, read here.
 */
@Injectable()
export class CoreLeadersService {
  constructor(
    private readonly groups: GroupService,
    private readonly members: MembershipRepository,
    private readonly names: MemberNames,
    private readonly targets: AnalyticsTargetRepository,
    private readonly analytics: AnalyticsConfigReader,
    private readonly tenantDay: TenantDay,
  ) {}

  /** **`GET /members/core-leaders`** — every leader, every group, the tiles' counts, this year's targets. */
  async read(ctx: RequestContext): Promise<CoreLeadersView> {
    this.groups.requireTenantAdmin(ctx);
    const [{ groups, leaders, groupOf, headOf }, office, published] = await Promise.all([
      this.groups.placement(ctx),
      this.tenantDay.office(ctx),
      this.analytics.publishedFor(ctx),
    ]);
    const year = office.month.slice(0, 4);
    const subgroupOn = published.config.sections.some((s) => s.kode === 'SUBGROUP' && s.enabled);
    const defaults = published.config.thresholds.subgroupHeadDefaults;
    const ids = leaders.map((m) => String(m._id));
    const [names, set] = await Promise.all([
      this.names.byMembershipId(ctx, ids),
      subgroupOn ? this.targets.subgroupFor(ctx, year) : Promise.resolve(new Map<string, { aaTarget: number; recTarget: number }>()),
    ]);

    const rows: CoreLeaderRow[] = leaders.map((m) => {
      const id = String(m._id);
      const groupId = groupOf.get(id) ?? null;
      const own = set.get(id);
      return {
        membershipId: id,
        name: names.get(id) ?? '',
        agentCode: m.agentCode ?? null,
        role: m.role as 'ab' | 'aab',
        groupId,
        isGroupLeader: groupId !== null && headOf.get(groupId) === id,
        isCoreLeader: m.isCoreLeader ?? false,
        targets: !subgroupOn ? null : own
          ? { aa: own.aaTarget, rec: own.recTarget, isDefault: false }
          : { aa: defaults.aa, rec: defaults.rec, isDefault: true },
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));

    const inGroup = new Map<string, number>();
    for (const row of rows) if (row.groupId) inGroup.set(row.groupId, (inGroup.get(row.groupId) ?? 0) + 1);
    const withGroup = rows.filter((r) => r.groupId !== null).length;
    return {
      year,
      leaders: rows,
      groups: groups.map((g) => {
        const groupId = String(g._id);
        const head = headOf.get(groupId) ?? null;
        return {
          groupId,
          name: g.name,
          headMembershipId: head,
          headName: head === null ? null : names.get(head) ?? '',
          leaders: inGroup.get(groupId) ?? 0,
        };
      }),
      counts: {
        leaders: rows.length,
        core: rows.filter((r) => r.isCoreLeader).length,
        withGroup,
        withoutGroup: rows.length - withGroup,
      },
      canWrite: can(ctx, 'member:tag_group'),
      canEditTargets: subgroupOn && can(ctx, 'advanced_analytics:write'),
    };
  }

  /**
   * **`PUT /members/core-leaders/:membershipId`** — one leader's *Simpan* (AC-2): their group (`null`, *Tanpa group*),
   * whether they are its ★, and the Core leader tag. An active AB or AAB of this office, else `404`; a group that is no
   * live group of it `404`; ★ with no group `400 ORG_GROUP_LEADER_NEEDS_GROUP`. Appointing moves the
   * star from the group's former ★; leaving a group they led, or turning ★ off, clears it. Answers the page.
   */
  async save(
    ctx: RequestContext, membershipId: string, input: { groupId: string | null; isGroupLeader: boolean; isCoreLeader: boolean },
  ): Promise<CoreLeadersView> {
    this.groups.requireTenantAdmin(ctx);
    const [leader] = await this.leadersOf(ctx, [membershipId]);
    const group = input.groupId === null ? null : await this.groups.find(ctx, input.groupId);
    if (input.isGroupLeader && group === null) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_LEADER_NEEDS_GROUP, SAY.ORG_GROUP_LEADER_NEEDS_GROUP.chooseGroup, HttpStatus.BAD_REQUEST,
        { membershipId },
      );
    }
    this.groups.requireCoreLeaderChange(ctx, leader, input.isCoreLeader);

    await this.groups.retag(ctx, [leader], { groupId: input.groupId, isCoreLeader: input.isCoreLeader });
    if (group !== null) {
      const owner = group.ownerMembershipId ?? null;
      if (input.isGroupLeader && owner !== membershipId) {
        await this.groups.setOwner(ctx, String(group._id), group.name, owner, membershipId);
      } else if (!input.isGroupLeader && owner === membershipId) {
        await this.groups.setOwner(ctx, String(group._id), group.name, owner, null);
      }
    }
    return this.read(ctx);
  }

  /**
   * **`PUT /members/core-leaders/bulk`** — *Atur group*, *Masukkan ke GROUP* and *★ Jadikan core* (AC-5): **one request
   * for every ticked leader**. `groupId` (a live group, or `null` for *Tanpa group*) and/or `isCoreLeader`; neither is
   * `400`. Everything is checked first — every id an active AB or AAB of this office, else `404` and **nothing written**
   * — then one write per field; a leader moved out of a group they led takes its ★ off. One `member.tagged` entry per
   * leader whose tags changed. Answers the page.
   */
  async bulk(
    ctx: RequestContext, input: { membershipIds: readonly string[]; groupId?: string | null; isCoreLeader?: boolean },
  ): Promise<CoreLeadersView> {
    this.groups.requireTenantAdmin(ctx);
    if (input.groupId === undefined && input.isCoreLeader === undefined) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.bulkNothing, { field: 'groupId' });
    }
    const leaders = await this.leadersOf(ctx, input.membershipIds);
    if (typeof input.groupId === 'string') await this.groups.find(ctx, input.groupId);
    if (input.isCoreLeader !== undefined) {
      for (const leader of leaders) this.groups.requireCoreLeaderChange(ctx, leader, input.isCoreLeader);
    }
    await this.groups.retag(ctx, leaders, { groupId: input.groupId, isCoreLeader: input.isCoreLeader });
    return this.read(ctx);
  }

  /** Every id an active AB or AAB of this office — or `404 NOT_FOUND`, the same for another office's and a malformed id. */
  private async leadersOf(ctx: RequestContext, membershipIds: readonly string[]): Promise<MembershipDocument[]> {
    const wanted = [...new Set(membershipIds)];
    if (wanted.length === 0 || !wanted.every((id) => isValidObjectId(id))) throw new NotFoundException('Membership');
    const found = await this.members.find(ctx, { _id: { $in: wanted }, status: 'active', role: { $in: [...LEADER_CLASSES] } });
    if (found.length !== wanted.length) throw new NotFoundException('Membership');
    return found;
  }
}
