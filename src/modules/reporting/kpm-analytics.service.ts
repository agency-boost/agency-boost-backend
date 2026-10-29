import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { render } from '@/common/i18n/sentence';
import { addDays } from '@/common/time/local-day';
import { KPM_REPORTING, PERIOD, TIME, type KpmAnalyticsPeriod } from '@/domain/constants';
import { coachingCoverage } from '@/domain/metrics/coaching-coverage';
import { maaCountInUnit, monthly2ActiveCount } from '@/domain/metrics/maa-count-in-unit';
import { mocRuleFor, mocRulesText, mocStatus, type Moc, type MocInput } from '@/domain/metrics/moc-status';
import { memberAt } from '@/domain/metrics/office-headcount';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { productionClubTier, type ClubTier } from '@/domain/metrics/production-club-tier';
import { rateOver, type Rate } from '@/domain/metrics/rate';
import { rollUpGoal, rollUpLeadCounts, type GoalFigure, type LeadCountsRow } from '@/domain/metrics/unit-rollup';
import { CarrierRules, type CarrierRule } from '@/modules/campaigns/carrier-rules';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { ProductionReadings, type MonthStanding } from '@/modules/production/production-readings';
import { goalFigures, type PlannedGoal } from '@/modules/summary/summary-figures';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { AGENCY_CLASS, AGENT_CLASS, UNIT_CLASS, partitionAgencies } from './agency-partition';
import {
  asOfLabel, byName, monthLabel, moneyOf, shiftMonth, twoMonthsLabel, yearToDateLabel, type Money, type Person,
} from './office-figures';
import { OfficePeople, rungsFor, type OfficePerson } from './office-people';
import { REPORTING_MESSAGES } from './reporting.messages';

/** The comparison's columns for one row: every figure the prototype draws (`KPM_Owner.html:1247-1248`). */
export interface Figures {
  apeMonth: Money;
  apeAnnual: Money;
  coached7d: Rate;
  activeAgents: number | null;
  /**
   * *Producing this month*'s share (P18.97-T3 AC-10; ADR-0176 §12): `activeAgents` over **the members it counts from**,
   * the prototype's `m.active / row.team` (`KPM_Owner.html:3342`), a whole percent through `rateOver` — the server's, so
   * the screen computes none (invariant §7). `null` while the month is not uploaded, and over nobody. *This month*: over
   * the row's `manpower.total`, today's. **A past month** (OD-235 → option 1, 2026-10-28): over that month's members —
   * the ones on its last day, a leaver since included — so it never passes 100%; `manpower` beside it stays today's.
   */
  activePct: number | null;
  /**
   * **The members `activePct` is over** (OD-235, clarified 2026-10-29): `manpower.total` for *This month*, the period's
   * members on its last day for a past month — so the cell writes its count over the same members as its percent,
   * *4 / 5 · 80%*, never *4 / 3 · 80%*. Served whether or not the month is uploaded; *Manpower* stays today's.
   */
  activeOf: number;
  leads: { sales: number; salesPotential: number; recruit: number; recruitPotential: number };
  manpower: { aab: number; agents: number; total: number };
}

export interface AnalyticsRow extends Figures {
  /** `leads`: the head has at least one active direct report — the screen offers *Coach* only to a leader (item 7). */
  head: Person & { isReader: boolean; leads: boolean };
}

export interface AnalyticsAgency extends AnalyticsRow {
  club: { code: string; label: string } | null;
  moc: Moc | null;
  direct: AnalyticsRow;
  aabUnits: (AnalyticsRow & { moc: Moc | null })[];
  members: (Person & { rung: { code: string; label: string } })[];
}

/** `GET /kpm/analytics?period=`: the unit comparison by AB agency, MOC, the clubs, and six months of production. */
export interface KpmAnalyticsView {
  period: KpmAnalyticsPeriod;
  month: string;
  thresholds: { statusSplitPct: number };
  /**
   * The MOC column's tooltip (`KPM_Owner.html:1248`), composed from the company's `moc` rules — a line per rule,
   * the junior rung first, as the prototype writes it; `''` when the company has none (item 8).
   */
  mocRulesText: string;
  agencies: AnalyticsAgency[];
  total: Figures & {
    abCount: number;
    mocMet: number;
    mocOf: number;
    /**
     * The year to date of members who left this year (OD-74): the Overview's, in no row — what the total's *APE —
     * Annual* falls short of the Overview's by. `null` when no leaver holds a figure.
     */
    leaversExcludedMinor: number | null;
  };
  monthly: { month: string; apeMinor: number | null }[];
}

/**
 * What one member contributes to a row: the period's figures for a member on its last day, `null` for anybody who
 * joined since; and today's year to date for a member here today, `null` for a leaver, in no annual figure (OD-74).
 */
interface MemberFigures {
  apeMonth: GoalFigure | null;
  apeAnnual: GoalFigure | null;
  maa: boolean | null;
  leads: LeadCountsRow | null;
}

/**
 * **KPM analytics** (Phase 18, P18-T2; `functional/kpm-analytics.md`): *Unit comparison*, MOC, the production
 * clubs and *Monthly production*, `KPM_Owner.html:1225-1260` and its logic `:3090-3445`.
 *
 * **One row per AB agency** (D-units: `partitionAgencies`), each expanding into its *(Direct)* row and a row per
 * AAB unit; the rows partition the office, so **the total is the sum of its rows** — computed over their union,
 * which is the same thing — and a member under no AB is in neither. **Every figure through the function its
 * owner uses** (D-figures), in bulk, in a fixed number of queries whatever the office's size:
 *
 * - **APE — This Month** (D-period, OD-143): the period's month's own APE from the file against the members'
 *   monthly targets **as the Summary fixed them when that month began** (`goalFigures`, ADR-0056);
 * - **APE — Annual**: the year to date from the file against the members' annual goals — today's, whatever the
 *   period, as drawn (`:3340-3342`). The rows hold members: a member who has left is in none, and their
 *   production is the Overview's year to date (OD-74), which the total can fall short of by it;
 * - **Coached (7d)**: coaching's `coachingCoverage` over the row's members, **its head included** (D-coverage),
 *   so the rows add up to the office's coverage; period-independent;
 * - **Active this month / last month** — *Producing this month / last month* on the screen since P18.97-T3 (ADR-0176
 *   §3): `MAA_COUNT_IN_UNIT` for the period's month — `null` while the office holds no file for it — and its share of
 *   the members it counts from, `rateOver`'s whole percent (`activePct`, AC-10), so the screen divides nothing: this
 *   month's of the row's manpower, a past month's of that month's members (OD-235);
 * - **Total leads** (D-period): Phase 15's counts (`LeadReadings`) — now, or as they stood at last month's end;
 * - **Manpower**: today's people, by rung.
 *
 * **The period's three — APE — This Month, the active count and the leads — are over the members the month had
 * on its last day** (OD-24; the Phase 18 exit review, item 1): for *Previous month*, a member who has left since
 * is in them, placed in the row the edges they left with put them in (OD-74), and a member who joined since is
 * not. Manpower, Coached (7d), APE — Annual and MOC are today's members whatever the period. Each row's head says
 * whether they lead anybody (`head.leads`), and the MOC column's tooltip is composed from the company's rules
 * (`mocRulesText`).
 *
 * **MOC** (OD-22 → option 1, D-moc): the company's `moc` rule for the head's rung, read through the campaigns
 * module's one named reader (`CarrierRules`), over OD-22's stated reading (§A.7) and the client PRD's scopes —
 * `NET_APE` the year to date of the leader and their Direct Group (an AB) or Direct Unit (an AAB), the
 * `MONTHLY2_AA` counts over the last two months held — a member active in both, a member not yet one in either
 * month not active in it — `DIRECT_AB_COUNT` the ABs reporting to the AB now, and
 * `MOC_PERSISTENCY` the leader's own row for the latest month held. **The clubs** (D-clubs): `PRODUCTION_CLUB_TIER` over the agency's
 * year to date, from the same reader. Both period-independent. Nothing else of that module is touched.
 *
 * **Nothing is written**: the figures are over groups, never a member's own record (D-audit).
 */
@Injectable()
export class KpmAnalyticsService {
  constructor(
    private readonly people: OfficePeople,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly sessions: CoachingReadings,
    private readonly leads: LeadReadings,
    private readonly production: ProductionReadings,
    private readonly goals: GoalService,
    private readonly carrierRules: CarrierRules,
  ) {}

  async read(ctx: RequestContext, query: { period?: KpmAnalyticsPeriod } = {}): Promise<KpmAnalyticsView> {
    // The Owner, an Admin, or a Core Leader (ADR-0159 §2); any other field member 404.
    const me = OfficePeople.requireAnalyticsReader(ctx);
    const period = query.period ?? KPM_REPORTING.ANALYTICS_DEFAULT_PERIOD;
    const office = await this.days.office(ctx);
    const { timezone, today, month } = office;
    const year = today.slice(0, 4);
    const periodMonth = period === 'this_month' ? month : shiftMonth(month, -1);
    const periodYear = periodMonth.slice(0, 4);
    // OD-24: the period's month counts the members it had on its last day — somebody who joined since is not one.
    const endOfPeriod = period === 'this_month'
      ? this.clock.endOfLocalDay(timezone, today)
      : this.clock.monthBounds(timezone, periodMonth).endExclusive;
    // The rows hold members (D-units, OD-74): a member who has left is in none of today's figures, their production
    // the Overview's — read here to say how much of it the total leaves out, and for the period below.
    // Each member counted from their join date, in the office's zone (ADR-0172 §1).
    const roster = await this.people.read(ctx, this.clock.startOfLocalDay(timezone, `${year}-01-01`), timezone);
    const leaverIds = roster.everyone.filter((p) => p.status === 'removed').map((p) => p.membershipId);
    const active = roster.active;
    const activeIds = active.map((p) => p.membershipId);
    /*
     * **The period's members** (the exit review, item 1): the month's own figures — its APE, its active count and
     * its leads as they stood at its end — are over the members it had on its last day, **a leaver since included**,
     * placed in their row by the edges they left with (OD-74). *This month*, that is today's members. Manpower,
     * Coached (7d), APE — Annual and MOC stay today's: who is here now, whatever the period.
     */
    const periodPeople = roster.everyone.filter((p) => memberAt(p, endOfPeriod));
    const periodIds = periodPeople.map((p) => p.membershipId);
    const periodLeavers = periodPeople.filter((p) => p.status === 'removed');
    const periodLeaverIds = periodLeavers.map((p) => p.membershipId);
    const readFrom = shiftMonth(month, -TIME.MONTHS_PER_YEAR);
    const everyoneIds = [...activeIds, ...leaverIds];

    const [ladder, file, months, sessions, leadCounts, rules] = await Promise.all([
      this.people.ladder(ctx, office.companyId),
      /*
       * **The members' file in one lean read** (2026-10-29; the CI run of 2026-10-28 took 2.1 s and 2.5 s of the 3 s): the
       * cells MAA, Monthly2 AA and persistency read, twelve months back, and every standing below — **this year whole**,
       * January to December, the year `ledgersFor` reads. It was `ledgersFor` once (twice for *Previous month*) beside
       * `monthCellsFor`, the same rows hydrated each time: two-thirds of the read. Same figures, one query.
       */
      this.production.monthCellsAndYearToDateFor(ctx, everyoneIds, { from: readFrom, to: `${year}-12` }),
      this.production.officeMonths(ctx, { from: readFrom, to: month }),
      this.sessions.countedSince(ctx, activeIds, addDays(today, -PERIOD.ROLLING_7D_DAYS)),
      period === 'this_month'
        ? this.leads.countsOfMany(ctx, periodIds, { month })
        : this.leads.countsOfManyAt(ctx, periodIds, { month: periodMonth, at: endOfPeriod }),
      this.carrierRules.ofOffice(ctx),
    ]);
    // `ledgersFor`'s standings, from that read: everybody's at this month, and the period's members' at theirs.
    const standings = file.standingsFor(everyoneIds, month);
    const standingsThen = period === 'this_month' ? null : file.standingsFor(periodIds, periodMonth);
    const cells = file.cells;
    const ytdOf = (from: ReadonlyMap<string, MonthStanding>, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, from.get(id)!.yearToDate]));
    const plans = await this.goals.plansOf(ctx, year, [...activeIds, ...periodLeaverIds], ytdOf(standings, [...activeIds, ...periodLeaverIds]));
    const plansThen = periodYear === year ? plans : await this.goals.plansOf(ctx, periodYear, periodIds, ytdOf(standingsThen!, periodIds));

    // ---- Each member's figures.
    const monthHeld = months.get(periodMonth)?.held ?? false;
    const activeSet = new Set(activeIds);
    const periodSet = new Set(periodIds);
    const maaIn = (id: string, m: string): boolean | null => {
      const cell = cells.get(id)?.get(m);
      return cell ? monthlyActiveAgent(cell.apeMonthly, cell.policyCountMonthly) : null;
    };
    const member = new Map<string, MemberFigures>([...active, ...periodLeavers].map((p) => {
      const id = p.membershipId;
      const now = standings.get(id)!;
      const annual = goalFigures({ goal: plans.get(id)!, month, ...now, names: new Map() });
      const inPeriod = periodSet.has(id);
      let apeMonth: GoalFigure | null = null;
      if (inPeriod && period === 'this_month') {
        apeMonth = { targetMinor: annual.monthly.targetMinor, actualMinor: now.thisMonth?.minor ?? null };
      } else if (inPeriod) {
        const then = standingsThen!.get(id)!;
        const fixed = goalFigures({
          goal: this.asOf(plansThen.get(id)!, periodYear === year ? now.throughLastMonth : then.yearToDate),
          month: periodMonth, ...then, names: new Map(),
        });
        apeMonth = { targetMinor: fixed.monthly.targetMinor, actualMinor: then.thisMonth?.minor ?? null };
      }
      return [id, {
        apeMonth,
        apeAnnual: activeSet.has(id) ? { targetMinor: annual.yearly.targetMinor, actualMinor: now.yearToDate?.minor ?? null } : null,
        maa: inPeriod ? maaIn(id, periodMonth) : null,
        leads: inPeriod ? leadCounts.get(id)! : null,
      }];
    }));

    const byId = new Map(active.map((p) => [p.membershipId, p]));
    const names = roster.names;
    // Whole days in the office's calendar, worked out once a pair (2026-10-29): every row's coverage asks the same few
    // dates against today — some 1,500 times at 500 members, 7% of the read, for at most eight answers.
    const days = new Map<string, number>();
    const daysBetween = (from: string, to: string) => {
      const key = `${from}/${to}`;
      let n = days.get(key);
      if (n === undefined) {
        n = this.clock.daysBetween(timezone, from, to);
        days.set(key, n);
      }
      return n;
    };
    // A row's ids are its members today and, for the previous month, its leavers since (item 1): the period's
    // figures over who it had on the month's last day, today's over who it has now.
    const figuresOf = (ids: readonly string[]): Figures => {
      const now = ids.filter((id) => activeSet.has(id));
      const then = ids.filter((id) => periodSet.has(id));
      const sum = rollUpLeadCounts(then.map((id) => member.get(id)!.leads!));
      const [coverage] = coachingCoverage({ scope: now, leaderMembershipId: null, sessions, today, daysBetween });
      const activeAgents = maaCountInUnit(then.map((id) => member.get(id)!.maa), monthHeld);
      // The prototype's `m.active / row.team` (`:3342`) over the members the count reads (OD-235, option 1): *This
      // month*'s over today's manpower, as before; a past month's over that month's (`then`), so a leaver who produced
      // cannot take it past 100%. The base is served beside the share (clarified 2026-10-29), so the cell's count is
      // over the same members; the manpower drawn beside it stays today's.
      const activeOf = (period === 'this_month' ? now : then).length;
      return {
        apeMonth: moneyOf(rollUpGoal(then.map((id) => member.get(id)!.apeMonth!))),
        apeAnnual: moneyOf(rollUpGoal(now.map((id) => member.get(id)!.apeAnnual!))),
        coached7d: rateOver(coverage.coached, coverage.members),
        activeAgents,
        activePct: activeAgents === null ? null : rateOver(activeAgents, activeOf).pct,
        activeOf,
        leads: { sales: sum.salesOpen, salesPotential: sum.salesClosing, recruit: sum.recruitOpen, recruitPotential: sum.recruitNominated },
        manpower: {
          // By class (ADR-0156): an *Associate Leader* rung's members are the AABs, whatever it is called.
          aab: now.filter((id) => byId.get(id)!.role === UNIT_CLASS).length,
          agents: now.filter((id) => byId.get(id)!.role === AGENT_CLASS).length,
          total: now.length,
        },
      };
    };
    const leaders = new Set(active.flatMap((p) => (p.leaderId === null ? [] : [p.leaderId])));
    const head = (id: string) => ({ membershipId: id, name: names.get(id) ?? '', isReader: id === me, leads: leaders.has(id) });

    // ---- MOC's inputs (OD-22, §A.7) and the clubs (D-clubs): today's, whatever the period.
    const held = [...months].filter(([m, o]) => o.held && m <= month).map(([m]) => m).sort();
    const lastTwo = held.slice(-KPM_REPORTING.MONTHLY2_MONTHS);
    const latestHeld = held.length > 0 ? held[held.length - 1] : null;
    const heldThisYear = held.filter((m) => m.startsWith(year));
    // Each period in the reader's words and figures (P18.98-T5 AC-4): *Jan – Sep 2026*, *Agu and Sep 2026*.
    const reader = ctx.reader;
    const notUploaded = render(REPORTING_MESSAGES.notUploadedYet, reader);
    const ytdPeriod = heldThisYear.length === 0 ? year : yearToDateLabel(heldThisYear[heldThisYear.length - 1], reader);
    const twoPeriod = lastTwo.length < KPM_REPORTING.MONTHLY2_MONTHS ? notUploaded : twoMonthsLabel(lastTwo[0], lastTwo[1], reader);
    // The client PRD's scopes (§2): a leader's Direct Unit is their direct reports of the Agent class; an AB's Direct
    // Group is the Direct Unit and each AAB reporting to the AB, with that AAB's own Direct Unit — classes, ADR-0156.
    const directUnit = (leaderId: string) => active
      .filter((p) => p.leaderId === leaderId && p.role === AGENT_CLASS).map((p) => p.membershipId);
    const directGroup = (abId: string) => [
      ...directUnit(abId),
      ...active.filter((p) => p.leaderId === abId && p.role === UNIT_CLASS)
        .flatMap((aab) => [aab.membershipId, ...directUnit(aab.membershipId)]),
    ];
    const netApe = (ids: readonly string[]): MocInput => {
      const held = ids.map((id) => member.get(id)!.apeAnnual!.actualMinor).filter((v): v is number => v !== null);
      return { current: held.length === 0 ? null : held.reduce((sum, v) => sum + v, 0), period: ytdPeriod };
    };
    // Item 2: a member who was not yet a member on a month's last day was not active in it (`false`), so a new
    // agent cannot count; the count is `null` only while fewer than two months are held.
    const endOf = new Map(lastTwo.map((m) => [m, this.clock.monthBounds(timezone, m).endExclusive]));
    const monthly2 = (ids: readonly string[]): MocInput => ({
      current: monthly2ActiveCount(
        ids.map((id) => lastTwo.map((m) => (memberAt(byId.get(id)!, endOf.get(m)!) ? maaIn(id, m) : false))),
        lastTwo.length,
        KPM_REPORTING.MONTHLY2_MONTHS,
      ),
      period: twoPeriod,
    });
    const persistency = (id: string): MocInput => ({
      current: latestHeld === null ? null : cells.get(id)?.get(latestHeld)?.persistencyMonthly ?? null,
      period: latestHeld === null ? notUploaded : monthLabel(latestHeld, reader),
    });
    const mocRules = rules.filter((r) => r.kind === 'moc');
    const mocOf = (headId: string, inputs: Record<string, MocInput>): Moc | null => {
      const rule = mocRuleFor(mocRules, byId.get(headId)!.orgLevelCode);
      return rule ? mocStatus(rule, inputs, reader) : null;
    };
    const tiers = clubTiers(rules);

    // Today's members head and lead; the period's leavers are placed by the edges they left with, heading nothing.
    const partition = partitionAgencies([
      ...active.map((p) => ({ ...p, active: true })),
      ...periodLeavers.map((p) => ({ ...p, active: false })),
    ]);
    const agencies = partition.agencies.map((agency): AnalyticsAgency => {
      const figures = figuresOf(agency.memberIds);
      const group = directGroup(agency.headId);
      return {
        head: head(agency.headId),
        ...figures,
        club: productionClubTier(figures.apeAnnual.achievedMinor, tiers),
        moc: mocOf(agency.headId, {
          NET_APE: netApe([agency.headId, ...group]),
          MONTHLY2_AA_DU: monthly2(directUnit(agency.headId)),
          MONTHLY2_AA_DG: monthly2(group),
          MOC_PERSISTENCY: persistency(agency.headId),
          DIRECT_AB_COUNT: {
            current: active.filter((p) => p.leaderId === agency.headId && p.role === AGENCY_CLASS).length,
            period: asOfLabel(today, reader),
          },
        }),
        direct: { head: head(agency.headId), ...figuresOf(agency.directIds) },
        aabUnits: [...agency.units]
          .sort((a, b) => byName(names)(a.headId, b.headId))
          .map((unit) => {
            const unitDirect = directUnit(unit.headId);
            return {
              head: head(unit.headId),
              ...figuresOf(unit.memberIds),
              moc: mocOf(unit.headId, {
                NET_APE: netApe([unit.headId, ...unitDirect]),
                MONTHLY2_AA: monthly2(unitDirect),
                MOC_PERSISTENCY: persistency(unit.headId),
              }),
            };
          }),
        members: this.membersOf(agency.memberIds.filter((id) => id !== agency.headId && activeSet.has(id)), byId, names, ladder),
      };
    }).sort((a, b) => byName(names)(a.head.membershipId, b.head.membershipId));

    return {
      period,
      month: periodMonth,
      thresholds: { statusSplitPct: KPM_REPORTING.STATUS_SPLIT_PCT },
      mocRulesText: mocRulesText(juniorFirst(mocRules, ladder), reader),
      agencies,
      total: {
        // The rows partition the members placed under an AB, so their union's figures are the rows' sum.
        ...figuresOf(partition.agencies.flatMap((a) => a.memberIds)),
        abCount: agencies.length,
        mocMet: agencies.filter((a) => a.moc?.status === 'met').length,
        mocOf: agencies.filter((a) => a.moc !== null).length,
        leaversExcludedMinor: sumHeld(leaverIds.map((id) => standings.get(id)!.yearToDate?.minor ?? null)),
      },
      monthly: Array.from({ length: KPM_REPORTING.MONTHLY_CHART_MONTHS }, (_, i) => {
        const m = shiftMonth(month, i - KPM_REPORTING.MONTHLY_CHART_MONTHS);
        return { month: m, apeMinor: months.get(m)?.apeMonthlyMinor ?? null };
      }),
    };
  }

  /**
   * **A plan as it stood when an earlier month began** (ADR-0056): the same goal, measured against the year to
   * date the office held then — or, where it held none, the member's own figure — so last month's target is the
   * one the Summary fixed for it, not one recomputed from this month's file.
   */
  private asOf(plan: PlannedGoal & { apeAchievedMinor: number }, held: { minor: number; provenance: 'imported' | 'corrected'; month: string } | null): PlannedGoal {
    return {
      ...plan,
      achieved: held
        ? { minor: held.minor, provenance: held.provenance, month: held.month }
        : { minor: plan.apeAchievedMinor, provenance: 'self_reported', month: null },
    };
  }

  /** The manpower toggle (`KPM_Owner.html:3241-3252`): the agency's people by name, senior rungs first. */
  private membersOf(
    ids: readonly string[], byId: ReadonlyMap<string, OfficePerson>, names: ReadonlyMap<string, string>,
    ladder: Parameters<typeof rungsFor>[0],
  ): AnalyticsAgency['members'] {
    const rungs = rungsFor(ladder, ids.map((id) => byId.get(id)!.orgLevelCode));
    const order = new Map(rungs.map((rung, i) => [rung.code, i]));
    const labels = new Map(rungs.map((rung) => [rung.code, rung.label]));
    return [...ids]
      .sort((a, b) => order.get(byId.get(a)!.orgLevelCode)! - order.get(byId.get(b)!.orgLevelCode)! || byName(names)(a, b))
      .map((id) => ({
        membershipId: id,
        name: names.get(id) ?? '',
        rung: { code: byId.get(id)!.orgLevelCode, label: labels.get(byId.get(id)!.orgLevelCode)! },
      }));
  }
}

/** The rules a line each, the junior rung first — the AAB's before the AB's, as `KPM_Owner.html:1248` writes them. */
export function juniorFirst<R extends CarrierRule>(rules: readonly R[], ladder: readonly { code: string; displayOrder: number }[]): R[] {
  const order = new Map(ladder.map((level) => [level.code, level.displayOrder]));
  const rank = (rule: R) => order.get(rule.appliesToOrgLevelCodes[0]) ?? Number.MAX_SAFE_INTEGER;
  return [...rules].sort((a, b) => rank(a) - rank(b));
}

/** The sum of the figures held, or `null` when none is — the rollup rule's. */
function sumHeld(values: readonly (number | null)[]): number | null {
  const held = values.filter((v): v is number => v !== null);
  return held.length === 0 ? null : held.reduce((sum, v) => sum + v, 0);
}

/** The company's club tiers, from its `production_club` rules: each one's annual APE threshold (D-clubs). */
export function clubTiers(rules: readonly CarrierRule[]): ClubTier[] {
  return rules
    .filter((rule) => rule.kind === 'production_club')
    .flatMap((rule) => {
      const criterion = rule.criteriaGroups.flatMap((group) => group.criteria)
        .find((c) => c.metricKey === 'APE_ACHIEVED' && c.comparator === 'gte');
      return criterion ? [{ code: rule.code, label: rule.name, minAnnualApeMinor: criterion.value }] : [];
    });
}
