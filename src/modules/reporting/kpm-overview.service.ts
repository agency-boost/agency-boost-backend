import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { addDays, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { KPM_REPORTING, PERIOD } from '@/domain/constants';
import { activityComplianceRate } from '@/domain/metrics/activity-logged';
import { apeYearProjection, projectionMonth } from '@/domain/metrics/ape-year-projection';
import { coachingCoverage } from '@/domain/metrics/coaching-coverage';
import { goalSet } from '@/domain/metrics/goal-set';
import { leaderCoachingFrequency } from '@/domain/metrics/leader-coaching-frequency';
import { maaCountInUnit } from '@/domain/metrics/maa-count-in-unit';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { memberAt, officeHeadcount, officeNewMembers } from '@/domain/metrics/office-headcount';
import { rateOver, type Rate } from '@/domain/metrics/rate';
import { recruitmentLastMonth } from '@/domain/metrics/recruitment-closed';
import { rollUpGoal, type GoalFigure } from '@/domain/metrics/unit-rollup';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { OfficialApe } from '@/modules/production/official-ape';
import type { MonthLedger } from '@/modules/production/production-readings';
import { officialGoalFigures } from '@/modules/summary/summary-figures';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { AGENCY_CLASS, partitionAgencies } from './agency-partition';
import { KpmRecruitTargetRepository } from './kpm-recruit-target.repository';
import { KpmSetup, type SettingsWaiting, type SetupView } from './kpm-setup.service';
import { byName, moneyOf, shiftMonth, type Money, type Person } from './office-figures';
import { OfficePeople, rungsFor, type OfficeHeader, type OfficePerson } from './office-people';
import { OfficePhones } from './office-phones';
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
   * Has an active direct report (ADR-0087). `false` is an AB who leads nobody (P18.9-T3 AC-5, UI-017): listed last, its
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
    /**
     * ***Aktif bulan ini*** (P19.3-T1 AC-1; ADR-0200 §2, D1): `MAA_COUNT_IN_UNIT` over the office for **the current
     * calendar month**, over today's headcount (D3). `count` and `pct` are `null` while the month is not uploaded —
     * *"–"* and *Belum diunggah*, never *0 / 28* — and `asOf` is the office's day the month's rows were last written,
     * by an import or a correction (D8, *"per 3 Nov"*). App logging changes nothing in it.
     */
    activeThisMonth: { count: number | null; of: number; pct: number | null; month: string; asOf: LocalDate | null };
    /*
     * `loggedThisMonth` was here — the members who logged this calendar month, beside last month to the same day — for
     * the first tile drawn until P19.3-T2. *Removed 2026-11-05 (P19.3-T2; ADR-0200 §2, §3):* the tile is *Aktif bulan
     * ini* (D1) and logging is the week's *Pengguna aktif* alone, so the Overview compares no month-to-date figure (OWN
     * R3 holds by there being none: nothing reads *−100%* against a full month).
     */
    /** *Pengguna aktif* over the rolling 7 days (`ACTIVITY_COMPLIANCE_RATE`, `ROLLING_7D`): the tile's *"7 hari: n belum"*. */
    loggedThisWeek: { logged: number; notLogged: number; pct: number | null };
  };
  coaching: { coverage7d: Rate; coverage30d: Rate; leaderboard: OverviewLeader[] };
  recruitment: {
    expectedToClose: number;
    pipelineNow: number;
    /**
     * *Recruitment last month* (`RECRUITMENT_CLOSED_LAST_MONTH`, P19.3-T1 AC-3; ADR-0200 §5, D2): the upload's
     * `RECRUITMENT` for the previous calendar month, summed over the office's rows — `null` (*"–"*) when not uploaded.
     */
    closedLastMonth: number | null;
    target: number | null;
    targetMonth: string;
  };
  production: {
    ytd: Money & {
      /**
       * The months the year to date waits on **that are still open for upload** (P19.3-T2 AC-7; UI-150, Overview R3):
       * from `from`, after the latest month held, this month included while it is not uploaded — each one a
       * *"<Bulan> belum diunggah ›"* opening `/kpm/data-upload?month=` on itself. A month locked, or before the KPM, is
       * never named.
       */
      missingMonths: string[];
      /** The first month *"this year"* counts: January, or the KPM's first month when it began this year (UI-150). */
      from: string;
      membersWithoutGoal: number;
    };
    projectionMinor: number | null;
    /**
     * The month the projection runs from (P19.3-T1 AC-12; D8, Q4): the latest month of the year held and ended — a
     * month in progress never enters it — or `null` when there is none, and the projection with it.
     */
    projectionThrough: string | null;
    agencies: OverviewAgency[];
  };
  /**
   * ***Siapkan KPM*** (P19.3-T2 AC-4, AC-5; UI-149, Overview R2): the seven steps while any is open; `null` once all
   * seven are done, which is stored, so the card never comes back.
   */
  setup: SetupView | null;
  /** What waits for the Owner on the settings pages (P19.3-T2 AC-3; UI-148, Appendix D): *"Pengaturan KPM ›"*'s line. */
  settings: SettingsWaiting;
}

/** `GET /kpm/overview/not-logged`: how many are silent over the last 7 days, and the first three of them. */
export interface NotLoggedView {
  /** Everybody silent: the reveal's *"+ {total − 3} more"*. */
  total: number;
  /** The first `KPM_REPORTING.NOT_LOGGED_SHOWN`, never-logged first, then the longest silent. */
  members: (Person & {
    rung: { code: string; label: string };
    lastLoggedOn: LocalDate | null;
    daysSince: number | null;
    /** Their leader now — *"Agent · ke Sari"* (P19.3-T2 AC-2) — or `null` at the top of the tree. */
    leader: Person | null;
    /** Their WhatsApp number (`users.phone`, UI-101), for the D-22 reminder; `null` when none is on file. */
    phone: string | null;
  })[];
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
 * - **engagement**: *Aktif bulan ini*, `MAA_COUNT_IN_UNIT` over the office for the current month (D1, P19.3-T1 — where
 *   it counted logging, `ACTIVITY_LOGGED_THIS_MONTH`, retired), and *Pengguna aktif*: `ACTIVITY_COMPLIANCE_RATE` over
 *   `ROLLING_7D`, and over the calendar month for the tile drawn until P19.3-T2, from `ActivityReadings`;
 * - **coaching**: `COACHING_COVERAGE` from coaching's own `coachingCoverage` over the office — the head of
 *   nothing, so nobody is left out — and `LEADER_COACHING_FREQUENCY` for **every** AB, lowest first, one who leads
 *   nobody last (P18.9-T3 AC-5);
 * - **recruitment**: `LeadService.summary`'s two counts from the same facets (`LeadReadings.recruitmentPipeline`) —
 *   candidates, by stage — `RECRUITMENT_CLOSED_LAST_MONTH` from the office's file (D2, P19.3-T1), and the office's
 *   target for the month, carried forward;
 * - **production**: the office's year to date from its file (`ProductionReadings`) against the sum of its
 *   members' goals as the Summary sets them (`goalFigures`, OD-143), a member who left this year keeping their
 *   production in it and their goal gone from the targets (OD-74); `APE_YEAR_PROJECTION`; and each AB agency's
 *   (D-units), whose rows hold members — so the office's year to date can exceed their sum by what leavers made.
 *   The projection runs the year to date over the months it covers — the latest held month's number — so a month
 *   with no file of its own is neither dropped from the pace nor invented; **since P19.3-T1 only whole months**: the
 *   current month, uploaded mid-month (D8), never enters it (`projectionMonth`).
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
    private readonly production: OfficialApe,
    private readonly goals: GoalService,
    private readonly subjectReads: SubjectReadAudit,
    private readonly audit: AuditService,
    // P19.3-T2: the setup card, what waits on the settings pages, the months still open; the not-logged rows' numbers.
    private readonly setup: KpmSetup,
    private readonly phones: OfficePhones,
  ) {}

  async read(ctx: RequestContext): Promise<KpmOverviewView> {
    OfficePeople.require(ctx);
    const { view, leaderboard, week } = await this.compute(ctx);
    // Last, once the answer exists: one entry per leader on the leaderboard, whose own coaching it carries (D-audit).
    // An AB who leads nobody carries no coaching of theirs — *No team* is the tree's shape — so writes none.
    await this.subjectReads.recordMany(ctx, leaderboard.filter((row) => row.leads), 'kpm_overview', week);
    return view;
  }

  /**
   * **The same Overview, for the Super Admin's KPM comparison** (ADR-0207 §2, §4; P19.4-T3 AC-3): `read`'s figures,
   * computed by the same code over the named office, through a platform read's context (`RequestContext.platformRead`:
   * no membership, read-only). The comparison serves counts and sums of it alone, never the leaderboard's names, so the
   * leaderboard's per-leader entries are not written here: the platform read's own audit entry, in the platform's log
   * and the KPM's, records the read (ADR-0207 §5). Anything but a platform read is refused (`TENANT_NO_MEMBERSHIP`).
   */
  async figuresForOffice(ctx: RequestContext): Promise<KpmOverviewView> {
    OfficePeople.requirePlatformRead(ctx);
    return (await this.compute(ctx)).view;
  }

  /** The Overview's figures over the context's office: what `read` and `figuresForOffice` both serve. */
  private async compute(ctx: RequestContext): Promise<{
    view: KpmOverviewView; leaderboard: OverviewLeader[]; week: { from: LocalDate; to: LocalDate };
  }> {
    const office = await this.days.office(ctx);
    const { timezone, today, month } = office;
    const year = today.slice(0, 4);
    const endOfToday = this.clock.endOfLocalDay(timezone, today);
    const lastMonth = shiftMonth(month, -1);
    const week = rollingWindow(today, PERIOD.ROLLING_7D_DAYS);
    // Since P19.3-T2 logging is the week's alone (ADR-0200 §3): a latest day before the week's first answers *no*.
    const engagementFrom = week.from;
    // Leavers since the earlier of January and last month's first day: this year's production, and last month's headcount.
    const since = [`${year}-01`, lastMonth].sort()[0];
    // Each member counted from their join date, in the office's zone (ADR-0172 §1).
    const roster = await this.people.read(ctx, this.clock.startOfLocalDay(timezone, `${since}-01`), timezone);
    const members = roster.everyone.filter((p) => memberAt(p, endOfToday));
    const memberIds = members.map((p) => p.membershipId);
    // Production is everybody's who was here this year, a leaver's included (OD-74).
    const producers = roster.everyone.filter((p) => p.status === 'active' || (p.removedAt !== null
      && p.removedAt.getTime() >= this.clock.startOfLocalDay(timezone, `${year}-01-01`).getTime()));
    const producerIds = producers.map((p) => p.membershipId);

    const [header, ladder, latest, sessions, pipeline, standing, ledgers, months, file] = await Promise.all([
      this.people.header(ctx),
      this.people.ladder(ctx, office.companyId),
      this.activity.lastLoggedOnMany(ctx, memberIds, { from: engagementFrom }),
      this.sessions.countedSince(ctx, memberIds, addDays(today, -PERIOD.ROLLING_30D_DAYS)),
      this.leads.recruitmentPipeline(ctx),
      this.targets.standingFor(ctx, month),
      this.production.ledgersFor(ctx, producerIds, month),
      // From the earlier of January and last month: this year's months, and last month's recruitment (D2).
      this.production.officeMonths(ctx, { from: since, to: month }),
      // This month's cells, for *Aktif bulan ini* (D1): one lean read of today's members' rows for the month.
      this.production.monthCellsAndYearToDateFor(ctx, memberIds, { from: month, to: month }),
    ]);
    const headcount = officeHeadcount(roster.everyone, endOfToday);
    // This year's months held: last month's December, read for its recruitment in January, is not one of them.
    const held = [...months].filter(([key, m]) => m.held && key.startsWith(year)).map(([key]) => key).sort();
    const [plans, setup] = await Promise.all([
      this.goals.plansOf(ctx, year, memberIds, new Map(
        memberIds.map((id) => [id, (ledgers.get(id) as MonthLedger).standing.yearToDate]),
      )),
      // P19.3-T2: the setup card, what waits on the settings pages, and the months "this year" counts and waits on.
      this.setup.read(ctx, { today, month, timezone, headcount, target: standing?.target ?? null, held }),
    ]);
    const names = roster.names;
    const daysBetween = (from: string, to: string) => this.clock.daysBetween(timezone, from, to);

    // ---- Team composition (OD-24).
    const rungs = rungsFor(ladder, members.map((p) => p.orgLevelCode)).map((rung) => ({
      ...rung, count: members.filter((p) => p.orgLevelCode === rung.code).length,
    }));

    // ---- Engagement (D1, D8; ADR-0200 §2, §3). *Aktif bulan ini* is production in the office's file for the current
    // calendar month, over today's headcount; logging is *Pengguna aktif*, and moves none of it.
    const thisMonthFile = months.get(month);
    const active = maaCountInUnit(memberIds.map((id) => {
      const cell = file.cells.get(id)?.get(month);
      return cell ? monthlyActiveAgent(cell.apeMonthly, cell.policyCountMonthly) : null;
    }), thisMonthFile?.held === true);
    const activeThisMonth = {
      count: active,
      of: headcount,
      pct: active === null ? null : rateOver(active, headcount).pct,
      month,
      asOf: active === null || !thisMonthFile?.writtenAt ? null : this.clock.localDateFor(timezone, thisMonthFile.writtenAt),
    };

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
        // The office's figures alone (ADR-0195): no member's estimate reaches the Overview.
        ? officialGoalFigures({ goal: plans.get(id)!, month, ...ledger.standing, names: new Map() }).yearly.targetMinor
        : null;
      return [id, { targetMinor: target, actualMinor: ledger.standing.yearToDate?.minor ?? null }];
    }));
    const ytd = rollUpGoal(producerIds.map((id) => figure.get(id)!));
    // The projection's whole months (D8, Q4): the year to date through the latest month held that has ended.
    const through = projectionMonth(held, month);
    const ytdThrough = through.month === null ? null : rollUpGoal(producerIds.map((id) => {
      const standingAt = (ledgers.get(id) as MonthLedger).standing;
      // The year to date through last month is each producer's latest held to the end of last month (ADR-0056).
      return { targetMinor: null, actualMinor: standingAt.throughLastMonth?.minor ?? null };
    })).actualMinor;
    // The agencies hold members (D-units): a leaver's production is the office's year to date, in no row (OD-74).
    const agencies = this.agencies(members, figure, names);

    const view: KpmOverviewView = {
      office: header,
      today,
      month,
      year,
      thresholds: { statusSplitPct: KPM_REPORTING.STATUS_SPLIT_PCT },
      composition: {
        total: headcount,
        newThisMonth: officeNewMembers(roster.everyone, this.clock.monthBounds(timezone, month).start, endOfToday),
        rungs,
      },
      engagement: {
        activeThisMonth,
        loggedThisWeek: activityComplianceRate(memberIds, latest, week),
      },
      coaching: { coverage7d, coverage30d, leaderboard },
      recruitment: {
        expectedToClose: pipeline.expectedToClose,
        pipelineNow: pipeline.pipelineNow,
        // D2: the office's file for the previous calendar month, never a lead closed won.
        closedLastMonth: recruitmentLastMonth(months.get(lastMonth)),
        target: standing?.target ?? null,
        targetMonth: month,
      },
      production: {
        ytd: {
          ...moneyOf(ytd),
          // Item 3 of the exit review: the months the year to date is waiting on — those after the latest month held. A
          // gap before it is not waiting on anything: the held month's year to date already covers it. *Since P19.3-T2
          // (UI-150, Overview R3):* counted from the KPM's first month, this month included, and **only the months still
          // open for upload** — what Data upload offers. A month locked, or before the KPM, is never named.
          missingMonths: setup.missing.map((m) => m.month),
          from: setup.from,
          // OD-160: *a goal set* is one registered predicate, the compliance tree's Goal Setting chip's too (P18.3-T1 AC-5).
          membersWithoutGoal: memberIds.filter((id) => !goalSet(plans.get(id))).length,
        },
        // The months the year to date covers — the latest ended month held's number, a month with no file included —
        // over the year to date through it: a month in progress never enters the pace (P19.3-T1 AC-12).
        projectionMinor: apeYearProjection(ytdThrough, through.number),
        projectionThrough: through.month,
        agencies,
      },
      setup: setup.setup,
      settings: setup.settings,
    };

    return { view, leaderboard, week };
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
          // *"Agent · ke Sari"* (P19.3-T2 AC-2): the leader now, a member of the office; nobody at the top of the tree.
          leader: p.leaderId !== null && roster.names.has(p.leaderId)
            ? { membershipId: p.leaderId, name: roster.names.get(p.leaderId) as string }
            : null,
          phone: null as string | null,
        };
      })
      .sort((a, b) => (a.lastLoggedOn === null ? '' : a.lastLoggedOn).localeCompare(b.lastLoggedOn === null ? '' : b.lastLoggedOn)
        || a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));

    const listed = silent.slice(0, KPM_REPORTING.NOT_LOGGED_SHOWN);
    // The D-22 reminder's number (P19.3-T2 AC-2; UI-101), for the rows listed alone: one read, whatever the office's size.
    const numbers = await this.phones.of(ctx, listed.map((p) => p.membershipId));
    const shown = listed.map((p) => ({ ...p, phone: numbers.get(p.membershipId) ?? null }));
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
   * *Amended 2026-10-28 (P18.9-T3 AC-5; ADR-0176 §2, UI-017):* an AB who leads nobody is listed too, **last**, A to Z
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
