import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { addDays, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { KPM_REPORTING, PERIOD } from '@/domain/constants';
import { activityComplianceRate, activityLogged, lastMonthToSameDay } from '@/domain/metrics/activity-logged';
import { apeYearProjection } from '@/domain/metrics/ape-year-projection';
import { coachingCoverage } from '@/domain/metrics/coaching-coverage';
import { goalSet } from '@/domain/metrics/goal-set';
import { leaderCoachingFrequency } from '@/domain/metrics/leader-coaching-frequency';
import { memberAt, officeHeadcount, officeNewMembers } from '@/domain/metrics/office-headcount';
import { rateOver, type Rate } from '@/domain/metrics/rate';
import { rollUpGoal, type GoalFigure } from '@/domain/metrics/unit-rollup';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { ProductionReadings, type MonthLedger } from '@/modules/production/production-readings';
import { goalFigures } from '@/modules/summary/summary-figures';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { AGENCY_CLASS, partitionAgencies } from './agency-partition';
import { KpmRecruitTargetRepository } from './kpm-recruit-target.repository';
import { byName, moneyOf, shiftMonth, type Money, type Person } from './office-figures';
import { OfficePeople, rungsFor, type OfficeHeader, type OfficePerson } from './office-people';
import { REPORTING_REFUSALS } from './reporting.messages';

export interface RungCount {
  code: string;
  label: string;
  count: number;
}

export interface OverviewLeader extends Person {
  teamSize: number;
  coached: number;
  pct: number | null;
  /**
   * Has an active direct report (ADR-0087). `false` is an AB who leads nobody (P18.97-T3 AC-5, UI-017): listed last, its
   * team 0 and its rate `null` — *No team* where the rate would be.
   */
  leads: boolean;
}

export interface OverviewUnit extends Person, Money {}

export interface OverviewAgency extends Person, Money {
  aabUnits: OverviewUnit[];
}

/** `GET /kpm/overview`: the five sections of `KPM_Owner.html:936-1222`, every figure computed on the read. */
export interface KpmOverviewView {
  office: OfficeHeader;
  today: LocalDate;
  month: string;
  year: string;
  /** The attainment split a row is coloured by (`KPM_REPORTING.STATUS_SPLIT_PCT`), served so no screen re-declares it. */
  thresholds: { statusSplitPct: number };
  composition: { total: number; newThisMonth: number; rungs: RungCount[] };
  engagement: {
    loggedThisMonth: Rate & { lastMonthToDate: number | null };
    loggedThisWeek: { logged: number; notLogged: number; pct: number | null };
  };
  coaching: { coverage7d: Rate; coverage30d: Rate; leaderboard: OverviewLeader[] };
  recruitment: {
    expectedToClose: number;
    pipelineNow: number;
    closedLastMonth: number;
    target: number | null;
    targetMonth: string;
  };
  production: {
    ytd: Money & { missingMonths: string[]; membersWithoutGoal: number };
    projectionMinor: number | null;
    agencies: OverviewAgency[];
  };
}

/** `GET /kpm/overview/not-logged`: how many are silent over the last 7 days, and the first three of them. */
export interface NotLoggedView {
  /** Everybody silent: the reveal's *"+ {total − 3} more"*. */
  total: number;
  /** The first `KPM_REPORTING.NOT_LOGGED_SHOWN`, never-logged first, then the longest silent. */
  members: (Person & { rung: { code: string; label: string }; lastLoggedOn: LocalDate | null; daysSince: number | null })[];
}

/** What `PUT /kpm/overview/recruit-target` answers: the month's target as it now stands. */
export interface RecruitTargetView {
  month: string;
  target: number;
}

/**
 * **The KPM Overview** (Phase 18, P18-T1; `functional/kpm-analytics.md`): the page the Owner and the Admin land
 * on, `KPM_Owner.html:936-1222`, and the two calls beside it — the not-logged list, and the recruitment target.
 *
 * **Every figure is the one the office's own records already give, through the function that already computes
 * it** (D-figures), in bulk, on each read, **in a fixed number of queries whatever the office's size**
 * (`kpm-overview.performance.spec.ts`), not paginated and nothing materialised (D-api):
 *
 * - **composition**: `OFFICE_HEADCOUNT` (OD-24 — one headcount, every denominator's) and
 *   `OFFICE_NEW_MEMBERS_THIS_MONTH`, a tile per rung of the company's ladder;
 * - **engagement**: `ACTIVITY_LOGGED_THIS_MONTH` (OD-142) with last month to the same day beside it, and
 *   `ACTIVITY_COMPLIANCE_RATE` over `ROLLING_7D`, from `ActivityReadings`;
 * - **coaching**: `COACHING_COVERAGE` from coaching's own `coachingCoverage` over the office — the head of
 *   nothing, so nobody is left out — and `LEADER_COACHING_FREQUENCY` for **every** AB, lowest first, one who leads
 *   nobody last (P18.97-T3 AC-5);
 * - **recruitment**: `LeadService.summary`'s two counts from the same facets (`LeadReadings.recruitmentPipeline`),
 *   `RECRUITMENT_CLOSED_LAST_MONTH`, and the office's target for the month, carried forward;
 * - **production**: the office's year to date from its file (`ProductionReadings`) against the sum of its
 *   members' goals as the Summary sets them (`goalFigures`, OD-143), a member who left this year keeping their
 *   production in it and their goal gone from the targets (OD-74); `APE_YEAR_PROJECTION`; and each AB agency's
 *   (D-units), whose rows hold members — so the office's year to date can exceed their sum by what leavers made.
 *   The projection runs the year to date over the months it covers — the latest held month's number — so a month
 *   with no file of its own is neither dropped from the pace nor invented.
 *
 * **No figure is 0 for want of data**: `null` is *Not uploaded yet* or *—*, and a rate over nobody is `null`.
 * **Nothing here reads training, events or campaigns** (`reporting.imports.spec.ts`).
 */
@Injectable()
export class KpmOverviewService {
  constructor(
    private readonly people: OfficePeople,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly activity: ActivityReadings,
    private readonly sessions: CoachingReadings,
    private readonly leads: LeadReadings,
    private readonly targets: KpmRecruitTargetRepository,
    private readonly production: ProductionReadings,
    private readonly goals: GoalService,
    private readonly subjectReads: SubjectReadAudit,
    private readonly audit: AuditService,
  ) {}

  async read(ctx: RequestContext): Promise<KpmOverviewView> {
    OfficePeople.require(ctx);
    const office = await this.days.office(ctx);
    const { timezone, today, month } = office;
    const year = today.slice(0, 4);
    const endOfToday = this.clock.endOfLocalDay(timezone, today);
    const lastMonth = shiftMonth(month, -1);
    const lastMonthWindow = lastMonthToSameDay(today);
    const week = rollingWindow(today, PERIOD.ROLLING_7D_DAYS);
    // The earliest day either engagement card asks about (the exit review, item 5): last month's first, or the
    // week's first should that ever be earlier. A latest day before it answers *no* to both cards, so neither read
    // walks further back.
    const engagementFrom = [lastMonthWindow.from, week.from].sort()[0];
    // Leavers since the earlier of January and last month's first day: this year's production, and last month's headcount.
    const since = [`${year}-01`, lastMonth].sort()[0];
    // Each member counted from their join date, in the office's zone (ADR-0172 §1).
    const roster = await this.people.read(ctx, this.clock.startOfLocalDay(timezone, `${since}-01`), timezone);
    const members = roster.everyone.filter((p) => memberAt(p, endOfToday));
    const memberIds = members.map((p) => p.membershipId);
    const membersThen = roster.everyone.filter((p) => memberAt(p, this.clock.endOfLocalDay(timezone, lastMonthWindow.to)));
    // Production is everybody's who was here this year, a leaver's included (OD-74).
    const producers = roster.everyone.filter((p) => p.status === 'active' || (p.removedAt !== null
      && p.removedAt.getTime() >= this.clock.startOfLocalDay(timezone, `${year}-01-01`).getTime()));
    const producerIds = producers.map((p) => p.membershipId);

    const [header, ladder, latest, latestThen, sessions, pipeline, closedLastMonth, standing, ledgers, months] = await Promise.all([
      this.people.header(ctx),
      this.people.ladder(ctx, office.companyId),
      this.activity.lastLoggedOnMany(ctx, memberIds, { from: engagementFrom }),
      this.activity.lastLoggedOnMany(ctx, membersThen.map((p) => p.membershipId), { from: engagementFrom, to: lastMonthWindow.to }),
      this.sessions.countedSince(ctx, memberIds, addDays(today, -PERIOD.ROLLING_30D_DAYS)),
      this.leads.recruitmentPipeline(ctx),
      this.leads.recruitmentClosed(ctx, this.clock.monthBounds(timezone, lastMonth)),
      this.targets.standingFor(ctx, month),
      this.production.ledgersFor(ctx, producerIds, month),
      this.production.officeMonths(ctx, { from: `${year}-01`, to: month }),
    ]);
    const plans = await this.goals.plansOf(ctx, year, memberIds, new Map(
      memberIds.map((id) => [id, (ledgers.get(id) as MonthLedger).standing.yearToDate]),
    ));
    const names = roster.names;
    const daysBetween = (from: string, to: string) => this.clock.daysBetween(timezone, from, to);

    // ---- Team composition (OD-24).
    const rungs = rungsFor(ladder, members.map((p) => p.orgLevelCode)).map((rung) => ({
      ...rung, count: members.filter((p) => p.orgLevelCode === rung.code).length,
    }));

    // ---- Engagement (OD-142, D-figures).
    const thisMonth = { from: `${month}-01`, to: today };
    const loggedThisMonth = activityLogged(memberIds, latest, thisMonth);
    const thenIds = membersThen.map((p) => p.membershipId);

    // ---- Coaching coverage (D-coverage): coaching's own function, over the office, nobody left out.
    const [coverage7d, coverage30d] = coachingCoverage({
      scope: memberIds, leaderMembershipId: null, sessions, today, daysBetween,
    }).map((c) => rateOver(c.coached, c.members));
    const leaderboard = this.leaderboard(members, sessions, names, today, daysBetween);

    // ---- Production — this year (OD-143, D-figures, D-units, OD-74).
    const memberSet = new Set(memberIds);
    const figure = new Map<string, GoalFigure>(producerIds.map((id) => {
      const ledger = ledgers.get(id) as MonthLedger;
      const target = memberSet.has(id)
        ? goalFigures({ goal: plans.get(id)!, month, ...ledger.standing, names: new Map() }).yearly.targetMinor
        : null;
      return [id, { targetMinor: target, actualMinor: ledger.standing.yearToDate?.minor ?? null }];
    }));
    const ytd = rollUpGoal(producerIds.map((id) => figure.get(id)!));
    const held = [...months].filter(([, m]) => m.held).map(([key]) => key).sort();
    const monthsOfYear = Array.from({ length: Number(month.slice(5, 7)) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    // The agencies hold members (D-units): a leaver's production is the office's year to date, in no row (OD-74).
    const agencies = this.agencies(members, figure, names);

    const view: KpmOverviewView = {
      office: header,
      today,
      month,
      year,
      thresholds: { statusSplitPct: KPM_REPORTING.STATUS_SPLIT_PCT },
      composition: {
        total: officeHeadcount(roster.everyone, endOfToday),
        newThisMonth: officeNewMembers(roster.everyone, this.clock.monthBounds(timezone, month).start, endOfToday),
        rungs,
      },
      engagement: {
        loggedThisMonth: {
          ...loggedThisMonth,
          lastMonthToDate: thenIds.length === 0 ? null : activityLogged(thenIds, latestThen, lastMonthWindow).count,
        },
        loggedThisWeek: activityComplianceRate(memberIds, latest, week),
      },
      coaching: { coverage7d, coverage30d, leaderboard },
      recruitment: {
        expectedToClose: pipeline.expectedToClose,
        pipelineNow: pipeline.pipelineNow,
        closedLastMonth,
        target: standing?.target ?? null,
        targetMonth: month,
      },
      production: {
        ytd: {
          ...moneyOf(ytd),
          // Item 3 of the exit review: the months the year to date is waiting on — those after the latest month
          // held, before this one. A gap before it is not waiting on anything: the held month's year to date
          // already covers it, and this month's file is not due yet.
          missingMonths: monthsOfYear.filter((m) => m < month && (held.length === 0 || m > held[held.length - 1])),
          // OD-160: *a goal set* is one registered predicate, the compliance tree's Goal Setting chip's too (P18.6-T1 AC-5).
          membersWithoutGoal: memberIds.filter((id) => !goalSet(plans.get(id))).length,
        },
        // The months the year to date covers: the latest held month's number, a month with no file included.
        projectionMinor: apeYearProjection(ytd.actualMinor, held.length === 0 ? 0 : Number(held[held.length - 1].slice(5, 7))),
        agencies,
      },
    };

    // Last, once the answer exists: one entry per leader on the leaderboard, whose own coaching it carries (D-audit).
    // An AB who leads nobody carries no coaching of theirs — *No team* is the tree's shape — so writes none.
    await this.subjectReads.recordMany(ctx, leaderboard.filter((row) => row.leads), 'kpm_overview', week);
    return view;
  }

  /**
   * **Who has not logged in the last 7 days** (D-figures; *View who hasn't logged →*, `KPM_Owner.html:986-1002`):
   * how many, and the first `KPM_REPORTING.NOT_LOGGED_SHOWN` of them — never-logged first, then the longest
   * silent, A to Z within a day. The rest are the People screen's (*"full list on the People screen"*), whose
   * *Last activity* column carries the same fact. One §3.5 entry per member **listed** — the three disclosed,
   * never the rest counted — in one insert, written only when the list is read (D-audit); it fails open.
   */
  async notLogged(ctx: RequestContext): Promise<NotLoggedView> {
    OfficePeople.require(ctx);
    const office = await this.days.office(ctx);
    const roster = await this.people.read(ctx, null, office.timezone);
    const ids = roster.active.map((p) => p.membershipId);
    const [ladder, latest] = await Promise.all([
      this.people.ladder(ctx, office.companyId),
      this.activity.lastLoggedOnMany(ctx, ids),
    ]);
    const window = rollingWindow(office.today, PERIOD.ROLLING_7D_DAYS);
    const labels = new Map(ladder.map((level) => [level.code, level.label]));
    const silent = roster.active
      .filter((p) => {
        const last = latest.get(p.membershipId);
        return last === undefined || last < window.from;
      })
      .map((p) => {
        const last = latest.get(p.membershipId) ?? null;
        return {
          membershipId: p.membershipId,
          name: roster.names.get(p.membershipId) ?? '',
          rung: { code: p.orgLevelCode, label: labels.get(p.orgLevelCode) ?? p.orgLevelCode },
          lastLoggedOn: last,
          daysSince: last === null ? null : this.clock.daysBetween(office.timezone, last, office.today),
        };
      })
      .sort((a, b) => (a.lastLoggedOn === null ? '' : a.lastLoggedOn).localeCompare(b.lastLoggedOn === null ? '' : b.lastLoggedOn)
        || a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));

    const shown = silent.slice(0, KPM_REPORTING.NOT_LOGGED_SHOWN);
    // `from: null`: the latest day logged is disclosed, whenever it was — as a member's own compliance read records it.
    await this.subjectReads.recordMany(ctx, shown, 'kpm_overview', { from: null, to: office.today });
    return { total: silent.length, members: shown };
  }

  /**
   * **The *Target* for the office's current month** (D-recruit): stored, audited with before and after, read by
   * every later month that sets none. Another month is 400 — a target is set for the month the office is in.
   * **One atomic write** (the exit review, item 4): the audit's *before* is the row that write replaced, as the
   * write itself returned it. The same target again changes no figure and records no entry.
   */
  async setRecruitTarget(ctx: RequestContext, body: { month: string; target: number }): Promise<RecruitTargetView> {
    OfficePeople.require(ctx);
    const office = await this.days.office(ctx);
    if (body.month !== office.month) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        REPORTING_REFUSALS.VALIDATION_FAILED.recruitTargetMonth({ month: office.month }),
        HttpStatus.BAD_REQUEST,
        { field: 'month', month: office.month },
      );
    }
    const { id, before } = await this.targets.setTarget(ctx, office.month, body.target);
    if (before === null || before.target !== body.target) {
      await this.audit.record(ctx, {
        action: 'kpm_overview.recruit_target_set',
        targetCollection: 'kpmRecruitTargets',
        targetId: id,
        before,
        after: { month: office.month, target: body.target },
      });
    }
    return { month: office.month, target: body.target };
  }

  /**
   * *AB coaching frequency* (D-coverage): `LEADER_COACHING_FREQUENCY` over `ROLLING_7D` for **every member of the `ab`
   * class** (a *Senior Leader* rung, ADR-0156), over their whole downline now — lowest first, A to Z within a share.
   * *Amended 2026-10-28 (P18.97-T3 AC-5; ADR-0176 §2, UI-017):* an AB who leads nobody is listed too, **last**, A to Z
   * among themselves — `leads: false`, a team of 0 and no rate, *No team* on the card — where the board left them out,
   * so *"Showing 4 of {n} ABs"* counted four of 0417's five. Who leads is ADR-0087's: an active direct report.
   */
  private leaderboard(
    members: readonly OfficePerson[],
    sessions: Parameters<typeof leaderCoachingFrequency>[0]['sessions'],
    names: ReadonlyMap<string, string>,
    today: LocalDate,
    daysBetween: (from: string, to: string) => number,
  ): OverviewLeader[] {
    const leaders = new Set(members.flatMap((q) => (q.leaderId === null ? [] : [q.leaderId])));
    return members
      .filter((p) => p.role === AGENCY_CLASS)
      .map((ab): OverviewLeader => {
        const person = { membershipId: ab.membershipId, name: names.get(ab.membershipId) ?? '' };
        // Nobody to coach: no rate to draw, never 0% (roles §6.11).
        if (!leaders.has(ab.membershipId)) return { ...person, teamSize: 0, coached: 0, pct: null, leads: false };
        return {
          ...person,
          ...leaderCoachingFrequency({
            leaderMembershipId: ab.membershipId,
            downline: members.filter((q) => q.ancestorIds.includes(ab.membershipId)).map((q) => q.membershipId),
            sessions,
            windowDays: PERIOD.ROLLING_7D_DAYS,
            today,
            daysBetween,
          }),
          leads: true,
        };
      })
      .sort((a, b) => Number(b.leads) - Number(a.leads)
        || (a.leads ? (a.pct as number) - (b.pct as number) : 0)
        || a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));
  }

  /** *Units furthest behind target* (D-units): every agency, lowest attainment first, a row with none last. */
  private agencies(
    members: readonly OfficePerson[], figure: ReadonlyMap<string, GoalFigure>, names: ReadonlyMap<string, string>,
  ): OverviewAgency[] {
    const partition = partitionAgencies(members.map((p) => ({ ...p, active: true })));
    const money = (ids: readonly string[]) => moneyOf(rollUpGoal(ids.map((id) => figure.get(id)!)));
    const rows = partition.agencies.map((agency) => ({
      membershipId: agency.headId,
      name: names.get(agency.headId) ?? '',
      ...money(agency.memberIds),
      aabUnits: [...agency.units]
        .sort((a, b) => byName(names)(a.headId, b.headId))
        .map((unit) => ({ membershipId: unit.headId, name: names.get(unit.headId) ?? '', ...money(unit.memberIds) })),
    }));
    return rows.sort((a, b) => {
      if (a.pct === null || b.pct === null) return a.pct === b.pct ? byName(names)(a.membershipId, b.membershipId) : a.pct === null ? 1 : -1;
      return a.pct - b.pct || byName(names)(a.membershipId, b.membershipId);
    });
  }
}
