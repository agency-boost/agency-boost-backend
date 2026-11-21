import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { requireOfficeSteward } from '@/common/auth/office-steward';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AB_GROUP_TARGETS, DEFAULT_CURRENCY } from '@/domain/constants';
import {
  addMonths, effectiveTarget, monthlyApeTarget, rekrutYtdTarget, sumTargets, targetMonthOpen,
  type AbGroupTargetSource, type EffectiveAbGroupTarget, type StoredAbGroupTarget,
} from '@/domain/metrics/ab-group-targets';
import { AB_ROLE } from '@/domain/metrics/leader-groups';
import { AuditService } from '@/modules/audit/audit.service';
import { annualTargetOf } from '@/modules/goals/goal-cascade';
import { GoalRepository } from '@/modules/goals/goal.repository';
import type { GoalDocument } from '@/modules/goals/goal.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { ORG_REFUSALS } from '@/modules/org/org.messages';
import { can } from '@/modules/rbac/permissions';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { OfficeGroups, type InformalPartition } from '../office-groups';
import { AB_GROUP_TARGET_REFUSALS } from './ab-group-targets.messages';
import { AbGroupTargetRepository } from './ab-group-target.repository';

/** One AB group's row on *Performa vs target*: its two targets for the month, and its APE target from Goal Setting. */
export interface AbGroupTargetRow {
  abMembershipId: string;
  name: string;
  agentCode: string | null;
  /** One of their informal group's Group Leaders. */
  isGroupLeader: boolean;
  /** *n orang*: the AB group, the AB included, test accounts not counted. */
  people: number;
  /** *Target Active Agent per bulan* — `null`, *Belum ada target*, with none saved for the month or before it. */
  activeAgentTarget: number | null;
  /** *Target Rekrut per bulan*, as above. */
  rekrutTarget: number | null;
  /** Saved for this month (`set`), carried from an earlier one (`carried`), or none. */
  source: AbGroupTargetSource;
  /** The month the targets were saved for; `null` with none. */
  fromMonth: string | null;
  /** January to this month of its year, each month's Rekrut target: *Rekrut YTD vs target*. */
  rekrutYtdTarget: number;
  /** **The APE target** — the members' Goal Setting for the year ÷ 12, in sen. Not editable here. */
  apeTargetMinor: number;
  /** Members of the AB group with a saved Goal Setting target above zero. */
  goalsSet: number;
}

/** A total: an informal group's, or the KPM's — the sum of its AB groups'. */
export interface AbGroupTargetTotals {
  activeAgentTarget: number;
  rekrutTarget: number;
  rekrutYtdTarget: number;
  apeTargetMinor: number;
  /** AB groups with no target: the sums are over the others. */
  unset: number;
  abGroups: number;
  people: number;
}

/** One informal group, or *Tanpa group* (`group: null`), and its AB groups A to Z. */
export interface AbGroupTargetGroup {
  group: { groupId: string; name: string } | null;
  /** The group's Group Leaders, A to Z — none for *Tanpa group*. */
  leaders: { membershipId: string; name: string }[];
  totals: AbGroupTargetTotals;
  abGroups: AbGroupTargetRow[];
}

/**
 * **`GET /kpm/ab-group-targets?month=`** — *Performa vs target*'s targets for one month (ADR-0270 §4–§6): the navy *Total
 * KPM*, then each informal group's total and its AB groups, then *Tanpa group*.
 */
export interface AbGroupTargetsView {
  /** The month read, `YYYY-MM`. */
  month: string;
  /** The office's month: the month switcher's › stops here. */
  currentMonth: string;
  /** The months a target may be saved for: `AB_GROUP_TARGETS.EARLIEST_MONTH` to a year after `currentMonth`. */
  earliestMonth: string;
  latestMonth: string;
  /** The largest target the steppers take. */
  max: number;
  /** The APE targets' currency. */
  currency: string;
  /**
   * **Total KPM**: every AB group's targets summed. `apeTargetMinor` is everyone's Goal Setting ÷ 12 — the members under
   * no AB too (`unplacedPeople`), who are in no AB group.
   */
  total: AbGroupTargetTotals & { unplacedPeople: number };
  groups: AbGroupTargetGroup[];
  /** The targets may be saved: the Super Admin in the KPM, the Owner, an Admin or a core leader — never view-as. */
  canWrite: boolean;
}

/**
 * **Monthly targets per AB group** (P19.17-T4;
 * [ADR-0270](../../../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md)
 * §4–§6; `DATA-DEFINITIONS.md`, *Targets*): the owner sets *Target Active Agent per bulan* and *Target Rekrut per bulan*
 * for each AB group; an informal group's and the KPM's are sums; the APE target is the members' Goal Setting ÷ 12.
 *
 * - **Who** (§5): the KPM's stewards — the route's `ab_group_target:read` / `:write`, and `requireOfficeSteward` behind it.
 * - **Every read through the tenant repositories** (invariant §1): another KPM's AB is `404`.
 * - **Each write audited**, `ab_group_target.set` with the targets before and after; the same values again write nothing.
 */
@Injectable()
export class AbGroupTargetsService {
  constructor(
    private readonly targets: AbGroupTargetRepository,
    private readonly groups: OfficeGroups,
    private readonly members: MembershipRepository,
    private readonly goals: GoalRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly tenantDay: TenantDay,
    private readonly audit: AuditService,
  ) {}

  /** **`GET /kpm/ab-group-targets?month=`** — the month asked, or the office's. */
  async read(ctx: RequestContext, month?: string): Promise<AbGroupTargetsView> {
    requireOfficeSteward(ctx, 'KPM');
    const office = await this.tenantDay.office(ctx);
    const wanted = month ?? office.month;
    this.requireOpen(wanted, office.month);
    return this.view(ctx, wanted, office.month);
  }

  /**
   * **`PUT /kpm/ab-group-targets/:abMembershipId`** — the target dialog's *Simpan*: one AB group, one month. An active AB
   * of this KPM (`404` otherwise; an AAB or an agent `422 ORG_GROUP_AB_ONLY`); a month outside the open range `422
   * AB_GROUP_TARGET_MONTH_CLOSED`. Answers the month's view, so the row, its informal group and the KPM total update.
   */
  async set(
    ctx: RequestContext, abMembershipId: string, input: { month: string; activeAgentTarget: number; rekrutTarget: number },
  ): Promise<AbGroupTargetsView> {
    requireOfficeSteward(ctx, 'KPM');
    const office = await this.tenantDay.office(ctx);
    this.requireOpen(input.month, office.month);
    const ab = await this.members.findById(ctx, abMembershipId);
    if (!ab || ab.status !== 'active') throw new NotFoundException('Membership');
    if (ab.role !== AB_ROLE) {
      throw new DomainException(
        ErrorCode.ORG_GROUP_AB_ONLY, ORG_REFUSALS.ORG_GROUP_AB_ONLY.abOnly, HttpStatus.UNPROCESSABLE_ENTITY,
        { membershipId: abMembershipId, role: ab.role },
      );
    }
    const after = { activeAgentTarget: input.activeAgentTarget, rekrutTarget: input.rekrutTarget };
    const { id, before } = await this.targets.set(ctx, abMembershipId, input.month, after);
    if (!before || before.activeAgentTarget !== after.activeAgentTarget || before.rekrutTarget !== after.rekrutTarget) {
      await this.audit.record(ctx, {
        action: 'ab_group_target.set',
        targetCollection: 'abGroupTargets',
        targetId: id,
        targetMembershipId: abMembershipId,
        before: before ? { month: input.month, ...before } : null,
        after: { month: input.month, ...after },
      });
    }
    return this.view(ctx, input.month, office.month);
  }

  /**
   * **The targets of the AB groups given, for one month** — what *Informal group* (Advanced analytics) sums per row:
   * each AB's targets for `month` and their Rekrut YTD target.
   */
  async forAbs(
    ctx: RequestContext, abMembershipIds: readonly string[], month: string,
  ): Promise<Map<string, EffectiveAbGroupTarget & { rekrutYtdTarget: number }>> {
    const stored = await this.targets.upTo(ctx, abMembershipIds, month);
    return new Map([...stored].map(([ab, rows]) => [ab, { ...effectiveTarget(rows, month), rekrutYtdTarget: rekrutYtdTarget(rows, month) }]));
  }

  private requireOpen(month: string, officeMonth: string): void {
    if (!targetMonthOpen(month, officeMonth)) {
      throw new DomainException(
        ErrorCode.AB_GROUP_TARGET_MONTH_CLOSED, AB_GROUP_TARGET_REFUSALS.AB_GROUP_TARGET_MONTH_CLOSED.closed,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { month, earliestMonth: AB_GROUP_TARGETS.EARLIEST_MONTH, latestMonth: addMonths(officeMonth, AB_GROUP_TARGETS.MONTHS_AHEAD) },
      );
    }
  }

  private async view(ctx: RequestContext, month: string, officeMonth: string): Promise<AbGroupTargetsView> {
    const partition = await this.groups.partition(ctx);
    const abIds = [...partition.abGroups.keys()];
    const everyone = [...partition.members.keys()];
    const [stored, goalRows, names] = await Promise.all([
      this.targets.upTo(ctx, abIds, month),
      everyone.length === 0 ? Promise.resolve([] as GoalDocument[]) : this.goals.find(ctx, { membershipId: { $in: everyone }, period: month.slice(0, 4) }),
      this.namesOf(partition, [...abIds, ...partition.groups.flatMap((g) => g.leaderIds)]),
    ]);
    const annual = new Map(goalRows.filter((g) => g.savedAt !== null).map((g) => [g.membershipId, annualOf(g)]));
    const byName = <T extends { name: string }>(a: T & { id: string }, b: T & { id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

    const rowOf = (ab: string, leaders: ReadonlySet<string>): AbGroupTargetRow => {
      const people = partition.abGroups.get(ab)!.memberIds;
      const rows: StoredAbGroupTarget[] = stored.get(ab) ?? [];
      const target = effectiveTarget(rows, month);
      const targetsOf = people.map((id) => annual.get(id) ?? 0);
      return {
        abMembershipId: ab,
        name: names.get(ab) ?? '',
        agentCode: partition.members.get(ab)?.agentCode ?? null,
        isGroupLeader: leaders.has(ab),
        people: people.length,
        ...target,
        rekrutYtdTarget: rekrutYtdTarget(rows, month),
        apeTargetMinor: monthlyApeTarget(targetsOf),
        goalsSet: targetsOf.filter((v) => v > 0).length,
      };
    };
    const totalsOf = (rows: readonly AbGroupTargetRow[]): AbGroupTargetTotals => {
      const sums = sumTargets(rows);
      return {
        activeAgentTarget: sums.activeAgentTarget,
        rekrutTarget: sums.rekrutTarget,
        unset: sums.unset,
        rekrutYtdTarget: rows.reduce((s, r) => s + r.rekrutYtdTarget, 0),
        apeTargetMinor: rows.reduce((s, r) => s + r.apeTargetMinor, 0),
        abGroups: rows.length,
        people: rows.reduce((s, r) => s + r.people, 0),
      };
    };
    const sortRows = (rows: AbGroupTargetRow[]) => rows
      .map((r) => ({ ...r, id: r.abMembershipId }))
      .sort(byName)
      .map(({ id: _id, ...r }) => r);

    const groups: AbGroupTargetGroup[] = partition.groups.map((g) => {
      const leaders = new Set(g.leaderIds);
      const rows = sortRows(g.abIds.map((ab) => rowOf(ab, leaders)));
      return {
        group: { groupId: g.groupId, name: g.name },
        leaders: g.leaderIds.map((id) => ({ id, membershipId: id, name: names.get(id) ?? '' })).sort(byName).map(({ id: _id, ...l }) => l),
        totals: totalsOf(rows),
        abGroups: rows,
      };
    });
    const ungrouped = sortRows(partition.ungroupedAbIds.map((ab) => rowOf(ab, new Set())));
    if (ungrouped.length > 0) groups.push({ group: null, leaders: [], totals: totalsOf(ungrouped), abGroups: ungrouped });

    const all = groups.flatMap((g) => g.abGroups);
    const unplacedApe = monthlyApeTarget(partition.unplacedIds.map((id) => annual.get(id) ?? 0));
    const total = totalsOf(all);
    return {
      month,
      currentMonth: officeMonth,
      earliestMonth: AB_GROUP_TARGETS.EARLIEST_MONTH,
      latestMonth: addMonths(officeMonth, AB_GROUP_TARGETS.MONTHS_AHEAD),
      max: AB_GROUP_TARGETS.MAX,
      currency: DEFAULT_CURRENCY,
      total: { ...total, apeTargetMinor: total.apeTargetMinor + unplacedApe, unplacedPeople: partition.unplacedIds.length },
      groups,
      canWrite: can(ctx, 'ab_group_target:write'),
    };
  }

  /** Names from the partition's rows' accounts, one read. */
  private async namesOf(partition: InformalPartition, membershipIds: readonly string[]): Promise<Map<string, string>> {
    const userOf = new Map<string, string>();
    for (const id of membershipIds) {
      const userId = partition.members.get(id)?.userId;
      if (userId) userOf.set(id, userId);
    }
    if (userOf.size === 0) return new Map();
    const users = await this.users.find({ _id: { $in: [...new Set(userOf.values())] } }, { fullName: 1 }).lean().exec();
    const fullName = new Map(users.map((u) => [String(u._id), u.fullName as string]));
    return new Map([...userOf].flatMap(([id, userId]) => (fullName.has(userId) ? [[id, fullName.get(userId)!]] : [])));
  }
}

/** A saved goal's annual target, in sen — a plan whose stored inputs make none (a zero commission rate) counts nothing. */
function annualOf(goal: GoalDocument): number {
  try {
    return annualTargetOf({
      mode: goal.mode, annualApeTargetMinor: goal.annualApeTargetMinor, savingsTargetMinor: goal.savingsTargetMinor,
      commissionRatePct: goal.commissionRatePct, monthsLeft: 12, apeAchievedMinor: 0, caseSizeMinor: goal.caseSizeMinor,
      leadsToApptPct: goal.leadsToApptPct, closingRatePct: goal.closingRatePct,
    });
  } catch {
    return 0;
  }
}
