import { Inject, Injectable, Optional } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { render } from '@/common/i18n/sentence';
import { addDays } from '@/common/time/local-day';
import { KPM_REPORTING, PERIOD, TIME, type KpmAnalyticsPeriod } from '@/domain/constants';
import { coachingCoverage } from '@/domain/metrics/coaching-coverage';
import { maaCountInUnit, monthly2AverageCount } from '@/domain/metrics/maa-count-in-unit';
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
import { OfficialApe } from '@/modules/production/official-ape';
import type { MonthStanding } from '@/modules/production/production-readings';
import { officialGoalFigures, type PlannedGoal } from '@/modules/summary/summary-figures';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { AGENCY_CLASS, AGENT_CLASS, UNIT_CLASS, partitionAgencies } from './agency-partition';
import {
  byName, monthLabel, monthsLabel, moneyOf, shiftMonth, yearToDateLabel, type Money, type Person,
} from './office-figures';
import { OfficeGroups, type OfficeGroup } from './office-groups';
import { OfficePeople, rungsFor, type OfficePerson } from './office-people';
import { REPORTING_MESSAGES } from './reporting.messages';

/** The comparison's columns for one row: every figure the prototype draws (`KPM_Owner.html:1247-1248`). */
export interface Figures {
  apeMonth: Money;
  apeAnnual: Money;
  coached7d: Rate;
  activeAgents: number | null;
  /**
   * *Producing this month*'s share (P18.9-T3 AC-10; ADR-0176 §12): `activeAgents` over **the members it counts from**,
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
  /**
   * *Manpower* (D3, ADR-0200 §6): today's active members of the row by class — `ab` since P19.3-T1, for the split
   * *"x AB · y AAB · z Agents"*, an AB counted once, as AB (the Owner on an AB rung is the AB they are). `total` is
   * every member of the row, the head included.
   */
  manpower: { ab: number; aab: number; agents: number; total: number };
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

/**
 * **One leader of KPM Analytics' *Leader* list** (UI-152, its Appendix D row; P19.3-T3 AC-1, AC-2): every member of the
 * `ab` or `aab` class with status *Aktif* (ADR-0200 §8, Q2), whether or not they lead anybody — Dewi Lestari, an AAB
 * leading nobody, is one, with a Group of one.
 *
 * **Every figure is over the leader's *Group*** (ADR-0204 §2): the leader and everybody below them on today's edges,
 * reaching below the next AB — the Unit Dashboard's `tiles.team.total` for that leader, through the same `ancestorIds`.
 * The period's month's figures (*APE bulan ini*, *Active*) are over the Group's members on the month's last day, a
 * leaver since placed by the edges they left with (OD-24, OD-74), as every row of the comparison is.
 */
export interface AnalyticsLeader {
  head: Person & { isReader: boolean; leads: boolean };
  /** The class (ADR-0156): *AB* or *AAB* — the row's pill and the chips' count. */
  role: 'ab' | 'aab';
  /**
   * **The reader may open this leader's Unit Dashboard and Group Tree** (P19.3-T3 AC-3; ADR-0159 §2): the Owner and an
   * Admin any leader's; a Core Leader their own and those of the leaders below them — the reach those two reads answer,
   * 404 outside it. The sheet offers the links only where this is true, so a Core Leader is never sent to a refusal.
   */
  opens: boolean;
  /** *Leader dari* / *"ke Agus"*: the leader's own upline today, `null` for a root (*—*). */
  above: Person | null;
  /** *"12 di Group"*: the leader and everybody below them today (ADR-0204 §2). */
  group: number;
  /** *"4 di Unit"*: the leader and their direct agents who lead nobody — the Unit Dashboard's *Your Unit*. */
  unit: number;
  /**
   * The Group by class (ADR-0156), the leader included — for the split *"3 AAB · 8 Agents"* (UI-094, AC-10): every AAB
   * counted, one who leads nobody included. `total` is `group`.
   */
  manpower: Figures['manpower'];
  /** *APE bulan ini* over the Group, against the members' own monthly targets (ADR-0128, ADR-0204 §3). */
  apeMonth: Money;
  /**
   * ***Active this month*** (D1, ADR-0200 §1): `MAA_COUNT_IN_UNIT` over the Group for the period's month — `null` while
   * the office holds no file for it — out of `of`, with its *Unit* and *AAB* halves (*"Unit 1/4 · AAB 3/8"*), which add
   * up to it: the Unit Dashboard's split (UI-013), here counted from the office's file.
   */
  active: {
    count: number | null;
    of: number;
    pct: number | null;
    unit: { count: number | null; of: number };
    aab: { count: number | null; of: number };
  };
  /** *Coached 7D*: `COACHED_7D` over the Group today, the leader included. */
  coached7d: Rate;
  /** The Group's open leads and the period's promised ones (AC-13's line, *"48 penjualan · 19 rekrut"*). */
  leads: Figures['leads'];
  /** An AB's production club, over their agency's year to date (Q9, D-clubs); an AAB has none. */
  club: { code: string; label: string } | null;
  /** `MOC_STATUS` for the leader's rung: an AB's over their Direct Group, an AAB's over their Direct Unit (ADR-0134). */
  moc: Moc | null;
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
  /**
   * **The KPM's totals** (UI-109's tiles, above the Leader list; P19.3-T3 AC-4, AC-5): every member of the office —
   * or of the group read — not only those placed under an AB. **`apeAnnual` is the KPM's production this year, a
   * leaver's included** (ADR-0204 §1, OWN R1): the Overview's *Production — this year*, the same sum, so the two pages
   * read one number. It is no longer the sum of the rows, which count today's members (*"Anggota saat ini"*). Over a
   * group it is that group's members', who are all current.
   */
  total: Figures & {
    abCount: number;
    mocMet: number;
    mocOf: number;
  };
  /** Every AB and AAB, lowest *APE bulan ini* % first — *"↓ Perlu perhatian dulu"* — a leader with no % last. */
  leaders: AnalyticsLeader[];
  /** The office's custom groups (*All members → Groups*), A to Z, for *Lihat untuk* (OD-258). */
  groups: OfficeGroup[];
  /** *Seluruh KPM · n orang*: the office's members today, whichever group the figures are over. */
  officePeople: number;
  /** The group the figures are over (`?group=`), or `null` for the whole KPM (*Seluruh KPM*). */
  group: OfficeGroup | null;
  /** Six months **ending with the current one** (UI-091), oldest first; `null` is a month with no file. */
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
 * - **Active this month / last month** — *Producing this month / last month* on the screen since P18.9-T3 (ADR-0176
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
 * **MOC** (OD-22 → option 1, D-moc; the client's corrected reading since P19.3-T1, ADR-0201): the company's `moc`
 * rule for the head's rung, read through the campaigns module's one named reader (`CarrierRules`), over the client
 * PRD's scopes — `MOC_APE` (*APE*, D5) the year to date of the leader and their Direct Group (an AB) or Direct Unit
 * (an AAB); the `MONTHLY2_AA` counts the mean, over the year's months held up to the latest (the APE criterion's
 * months), of the scope's members active that month — a member not yet one in a month not active in it (Q6);
 * `DIRECT_AB_COUNT` the ABs reporting to the AB now, *berdasarkan upline saat ini* (Q7); and `MOC_PERSISTENCY` the
 * leader's own uploaded `UNIT_PERSISTENCY` for the latest month held, *Belum diunggah* where that month carries none,
 * never an agent's percentage (D6). **The clubs** (D-clubs, Q9): `PRODUCTION_CLUB_TIER` over the agency's (the unit's)
 * year to date, never the AB's own, from the same reader. Both period-independent. Nothing else of that module is
 * touched.
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
    private readonly production: OfficialApe,
    private readonly goals: GoalService,
    private readonly carrierRules: CarrierRules,
    /*
     * **The group filter** (OD-258; P19.3-T3 AC-15). Optional so a spec that draws the comparison alone builds the
     * service with the eight above; the application always provides it, and a `group` asked of a service without it
     * is answered 404, as an unknown group is.
     */
    @Optional() @Inject(OfficeGroups) private readonly officeGroups: OfficeGroups | null = null,
  ) {}

  async read(ctx: RequestContext, query: { period?: KpmAnalyticsPeriod; group?: string } = {}): Promise<KpmAnalyticsView> {
    // The Owner, an Admin, or a Core Leader (ADR-0159 §2); any other field member 404.
    const me = OfficePeople.requireAnalyticsReader(ctx);
    const officeReader = ctx.membership?.isKpmOwner === true || ctx.membership?.isKpmAdmin === true;
    return this.compute(ctx, query, { me, officeReader });
  }

  /**
   * ***Lihat sebagai KPM*'s *Overview*** (ADR-0207 §2, §3; P19.4-T3 AC-4): exactly what `read` answers the KPM's Owner,
   * through the same code over the named office — a platform read's context (`RequestContext.platformRead`: no
   * membership, read-only), the reader taken as the office's, as nobody in it. Nothing is written here, as `read` writes
   * nothing; the platform read's audit entries record the visit. Anything but a platform read is `TENANT_NO_MEMBERSHIP`.
   */
  async analyticsForOffice(
    ctx: RequestContext, query: { period?: KpmAnalyticsPeriod; group?: string } = {},
  ): Promise<KpmAnalyticsView> {
    OfficePeople.requirePlatformRead(ctx);
    return this.compute(ctx, query, { me: null, officeReader: true });
  }

  /** The comparison over the context's office, read as `reader` reads it: what `read` and `readForOffice` both serve. */
  private async compute(
    ctx: RequestContext,
    query: { period?: KpmAnalyticsPeriod; group?: string },
    { me, officeReader }: { me: string | null; officeReader: boolean },
  ): Promise<KpmAnalyticsView> {
    const period = query.period ?? KPM_REPORTING.ANALYTICS_DEFAULT_PERIOD;
    /*
     * **The group first** (ADR-0204 §4): another office's group, an archived one or an unknown id is 404 before
     * anything else is read. A group grants nothing — the reader reads the whole office already — so it only names
     * the people every figure below is over.
     */
    const [chosen, offered] = await Promise.all([
      query.group === undefined ? Promise.resolve(null) : this.groupMembers(ctx, query.group),
      this.officeGroups ? this.officeGroups.list(ctx) : Promise.resolve([] as OfficeGroup[]),
    ]);
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
    const officeRoster = await this.people.read(ctx, this.clock.startOfLocalDay(timezone, `${year}-01-01`), timezone);
    // Over a group, its members today and nobody else: a leaver is in no group's figures (ADR-0204 §4).
    const inScope = (p: OfficePerson) => chosen === null || chosen.memberIds.has(p.membershipId);
    const roster = chosen === null ? officeRoster : {
      everyone: officeRoster.everyone.filter(inScope),
      active: officeRoster.active.filter(inScope),
      names: officeRoster.names,
    };
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
      // The office's figures alone (ADR-0195, UI-157 item 5): a member's estimate fixes no target here.
      const annual = officialGoalFigures({ goal: plans.get(id)!, month, ...now, names: new Map() });
      const inPeriod = periodSet.has(id);
      let apeMonth: GoalFigure | null = null;
      if (inPeriod && period === 'this_month') {
        apeMonth = { targetMinor: annual.monthly.targetMinor, actualMinor: now.thisMonth?.minor ?? null };
      } else if (inPeriod) {
        const then = standingsThen!.get(id)!;
        const fixed = officialGoalFigures({
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
          // By class (ADR-0156): a *Senior Leader* rung's members are the ABs, an *Associate Leader* rung's the AABs,
          // whatever each is called — so the split counts the AB once, as AB (D3).
          ab: now.filter((id) => byId.get(id)!.role === AGENCY_CLASS).length,
          aab: now.filter((id) => byId.get(id)!.role === UNIT_CLASS).length,
          agents: now.filter((id) => byId.get(id)!.role === AGENT_CLASS).length,
          total: now.length,
        },
      };
    };
    const leaders = new Set(active.flatMap((p) => (p.leaderId === null ? [] : [p.leaderId])));
    const head = (id: string) => ({ membershipId: id, name: names.get(id) ?? '', isReader: id === me, leads: leaders.has(id) });

    // ---- MOC's inputs (§A.7, ADR-0201) and the clubs (D-clubs): today's, whatever the period.
    const held = [...months].filter(([m, o]) => o.held && m <= month).map(([m]) => m).sort();
    const latestHeld = held.length > 0 ? held[held.length - 1] : null;
    // The calendar year's months held, up to the latest: what *APE* runs through and *Monthly2 AA* averages over (Q6).
    const heldThisYear = held.filter((m) => m.startsWith(year));
    // Each period in the reader's words and figures (P18.10-T5 AC-4): *Jan – Sep 2026*, *Jan – Jul, Sep 2026*.
    const reader = ctx.reader;
    const notUploaded = render(REPORTING_MESSAGES.notUploadedYet, reader);
    const ytdPeriod = heldThisYear.length === 0 ? year : yearToDateLabel(heldThisYear[heldThisYear.length - 1], reader);
    // The months the average read, named as they are — a month the office has no file for is not one of them.
    const averagePeriod = heldThisYear.length === 0 ? notUploaded : monthsLabel(heldThisYear, reader);
    // The client PRD's scopes (§2): a leader's Direct Unit is their direct reports of the Agent class; an AB's Direct
    // Group is the Direct Unit and each AAB reporting to the AB, with that AAB's own Direct Unit — classes, ADR-0156.
    const directUnit = (leaderId: string) => active
      .filter((p) => p.leaderId === leaderId && p.role === AGENT_CLASS).map((p) => p.membershipId);
    const directGroup = (abId: string) => [
      ...directUnit(abId),
      ...active.filter((p) => p.leaderId === abId && p.role === UNIT_CLASS)
        .flatMap((aab) => [aab.membershipId, ...directUnit(aab.membershipId)]),
    ];
    // `MOC_APE` (D5): the scope's official year to date, through the latest month of the year held — `NET_APE`'s.
    const mocApe = (ids: readonly string[]): MocInput => {
      const held = ids.map((id) => member.get(id)!.apeAnnual!.actualMinor).filter((v): v is number => v !== null);
      return { current: held.length === 0 ? null : held.reduce((sum, v) => sum + v, 0), period: ytdPeriod };
    };
    // `MONTHLY2_AA` (Q6): the mean over the year's months held of the scope's members active that month. A member who
    // was not yet a member on a month's last day was not active in it (`false`); `null` only with no month held.
    const endOf = new Map(heldThisYear.map((m) => [m, this.clock.monthBounds(timezone, m).endExclusive]));
    const monthly2 = (ids: readonly string[]): MocInput => ({
      current: monthly2AverageCount(
        ids.map((id) => heldThisYear.map((m) => (memberAt(byId.get(id)!, endOf.get(m)!) ? maaIn(id, m) : false))),
        heldThisYear.length,
      ),
      period: averagePeriod,
    });
    // `MOC_PERSISTENCY` (D6): the leader's own `UNIT_PERSISTENCY` for the latest month held — the insurer's figure for
    // their unit, uploaded on their row. *Belum diunggah* where that month carries none; never an agent's, never averaged.
    const persistency = (id: string): MocInput => {
      const current = latestHeld === null ? null : cells.get(id)?.get(latestHeld)?.unitPersistencyMonthly ?? null;
      return { current, period: latestHeld === null || current === null ? notUploaded : monthLabel(latestHeld, reader) };
    };
    // `DIRECT_AB_COUNT` (Q7): the app keeps only today's upline, and the dialog's line says so.
    const directAbPeriod = render(REPORTING_MESSAGES.byTodaysUpline, reader);
    const mocRules = rules.filter((r) => r.kind === 'moc');
    const mocOf = (headId: string, inputs: Record<string, MocInput>): Moc | null => {
      const rule = mocRuleFor(mocRules, byId.get(headId)!.orgLevelCode);
      return rule ? mocStatus(rule, inputs, reader) : null;
    };
    const tiers = clubTiers(rules);
    // Each leader's MOC on their rung's own scope (ADR-0134): an AB's Direct Group, an AAB's Direct Unit.
    const abMoc = (id: string) => {
      const group = directGroup(id);
      return mocOf(id, {
        MOC_APE: mocApe([id, ...group]),
        MONTHLY2_AA_DU: monthly2(directUnit(id)),
        MONTHLY2_AA_DG: monthly2(group),
        MOC_PERSISTENCY: persistency(id),
        DIRECT_AB_COUNT: {
          current: active.filter((p) => p.leaderId === id && p.role === AGENCY_CLASS).length,
          period: directAbPeriod,
        },
      });
    };
    const aabMoc = (id: string) => {
      const unitDirect = directUnit(id);
      return mocOf(id, { MOC_APE: mocApe([id, ...unitDirect]), MONTHLY2_AA: monthly2(unitDirect), MOC_PERSISTENCY: persistency(id) });
    };

    // Today's members head and lead; the period's leavers are placed by the edges they left with, heading nothing.
    const partition = partitionAgencies([
      ...active.map((p) => ({ ...p, active: true })),
      ...periodLeavers.map((p) => ({ ...p, active: false })),
    ]);
    const agencies = partition.agencies.map((agency): AnalyticsAgency => {
      const figures = figuresOf(agency.memberIds);
      return {
        head: head(agency.headId),
        ...figures,
        club: productionClubTier(figures.apeAnnual.achievedMinor, tiers),
        moc: abMoc(agency.headId),
        direct: { head: head(agency.headId), ...figuresOf(agency.directIds) },
        aabUnits: [...agency.units]
          .sort((a, b) => byName(names)(a.headId, b.headId))
          .map((unit) => ({ head: head(unit.headId), ...figuresOf(unit.memberIds), moc: aabMoc(unit.headId) })),
        members: this.membersOf(agency.memberIds.filter((id) => id !== agency.headId && activeSet.has(id)), byId, names, ladder),
      };
    }).sort((a, b) => byName(names)(a.head.membershipId, b.head.membershipId));

    // ---- The Leader list (UI-152; P19.3-T3 AC-1, AC-2, AC-6, AC-10). Every figure over the leader's Group.
    const universe = [...active, ...periodLeavers];
    // Everybody below each person, from the cached path (`ancestorIds`), once: what the Unit Dashboard's group reads.
    const below = new Map<string, string[]>();
    for (const p of universe) {
      for (const ancestor of p.ancestorIds) below.set(ancestor, [...(below.get(ancestor) ?? []), p.membershipId]);
    }
    // The office's people today, the group's or not: a leader's upline may stand outside the group read.
    const officeById = new Map(officeRoster.active.map((p) => [p.membershipId, p]));
    const activeOver = (ids: readonly string[]) => {
      const then = ids.filter((id) => periodSet.has(id));
      return {
        count: maaCountInUnit(then.map((id) => member.get(id)!.maa), monthHeld),
        of: (period === 'this_month' ? ids.filter((id) => activeSet.has(id)) : then).length,
      };
    };
    const agencyClubs = new Map(agencies.map((a) => [a.head.membershipId, a.club]));
    const leaderRows = active
      .filter((p) => p.role === AGENCY_CLASS || p.role === UNIT_CLASS)
      .map((p): AnalyticsLeader => {
        const id = p.membershipId;
        const groupIds = [id, ...(below.get(id) ?? [])];
        // *Unit* (ADR-0204 §2): the leader and their direct agents who lead nobody — the Unit Dashboard's *Your Unit*.
        const unitIds = [id, ...universe
          .filter((q) => q.leaderId === id && q.role === AGENT_CLASS && !leaders.has(q.membershipId))
          .map((q) => q.membershipId)];
        const unitSet = new Set(unitIds);
        const figures = figuresOf(groupIds);
        const upline = p.leaderId === null ? undefined : officeById.get(p.leaderId);
        const ab = p.role === AGENCY_CLASS;
        return {
          head: head(id),
          role: ab ? 'ab' : 'aab',
          opens: officeReader || (me !== null && (id === me || p.ancestorIds.includes(me))),
          above: upline ? { membershipId: upline.membershipId, name: names.get(upline.membershipId) ?? '' } : null,
          group: figures.manpower.total,
          unit: unitIds.filter((x) => activeSet.has(x)).length,
          manpower: figures.manpower,
          apeMonth: figures.apeMonth,
          active: {
            count: figures.activeAgents,
            of: figures.activeOf,
            pct: figures.activePct,
            unit: activeOver(unitIds),
            aab: activeOver(groupIds.filter((x) => !unitSet.has(x))),
          },
          coached7d: figures.coached7d,
          leads: figures.leads,
          club: ab ? agencyClubs.get(id) ?? null : null,
          moc: ab ? abMoc(id) : aabMoc(id),
        };
      })
      .sort(needsAttentionFirst(names));

    // ---- The KPM's totals (UI-109's tiles): everybody in scope, under an AB or not.
    const totals = figuresOf(universe.map((p) => p.membershipId));
    return {
      period,
      month: periodMonth,
      thresholds: { statusSplitPct: KPM_REPORTING.STATUS_SPLIT_PCT },
      mocRulesText: mocRulesText(juniorFirst(mocRules, ladder), reader),
      agencies,
      total: {
        ...totals,
        /*
         * **One production total per KPM** (ADR-0204 §1, OWN R1; P19.3-T3 AC-5): the office's year to date, a leaver's
         * production included, against today's members' own goals — the Overview's sum, over the same people (everyone
         * active, and everyone who left this year). Over a group, its members' alone, who are all current.
         */
        apeAnnual: chosen === null
          ? moneyOf(rollUpGoal([
            ...activeIds.map((id) => member.get(id)!.apeAnnual!),
            ...leaverIds.map((id) => ({ targetMinor: null, actualMinor: standings.get(id)!.yearToDate?.minor ?? null })),
          ]))
          : totals.apeAnnual,
        abCount: agencies.length,
        mocMet: agencies.filter((a) => a.moc?.status === 'met').length,
        mocOf: agencies.filter((a) => a.moc !== null).length,
      },
      leaders: leaderRows,
      groups: offered,
      officePeople: officeRoster.active.length,
      group: chosen?.group ?? null,
      // UI-091: the six months ending with this one. Over a group, its members' cells, in a month the office holds.
      monthly: Array.from({ length: KPM_REPORTING.MONTHLY_CHART_MONTHS }, (_, i) => {
        const m = shiftMonth(month, i - (KPM_REPORTING.MONTHLY_CHART_MONTHS - 1));
        if (chosen === null) return { month: m, apeMinor: months.get(m)?.apeMonthlyMinor ?? null };
        if (!(months.get(m)?.held ?? false)) return { month: m, apeMinor: null };
        return { month: m, apeMinor: activeIds.reduce((sum, id) => sum + (cells.get(id)?.get(m)?.apeMonthly ?? 0), 0) };
      }),
    };
  }

  /** `?group=`'s members, or 404: an unknown, archived or another office's group (and none without the reader). */
  private async groupMembers(ctx: RequestContext, groupId: string) {
    if (!this.officeGroups) throw new NotFoundException('Group');
    return this.officeGroups.membersOf(ctx, groupId);
  }

  /**
   * **A plan as it stood when an earlier month began** (ADR-0056): the same goal, measured against the year to
   * date the office held then, so last month's target is the one the office's figures fixed for it, not one
   * recomputed from this month's file.
   *
   * **Where the office held none, nothing** (ADR-0195; P19.1-T4 AC-12, UI-157 item 5). This fell back to the member's
   * own typed figure until November 2026, so an estimate fixed an earlier month's target on the office's screen. The
   * figure is still marked `self_reported` — the plan's own, at nothing — and `officialGoalFigures` reads it as
   * nothing held: no month's target is taken from it.
   */
  private asOf(plan: PlannedGoal, held: { minor: number; provenance: 'imported' | 'corrected'; month: string } | null): PlannedGoal {
    return {
      ...plan,
      achieved: held
        ? { minor: held.minor, provenance: held.provenance, month: held.month }
        : { minor: 0, provenance: 'self_reported', month: null },
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

/**
 * ***"↓ Perlu perhatian dulu"*** (UI-152): the lowest *APE bulan ini* % first; a leader with no % — no goal, or the month
 * not uploaded — after every one with a %; A to Z among equals.
 */
export function needsAttentionFirst(names: ReadonlyMap<string, string>) {
  const order = byName(names);
  return (a: AnalyticsLeader, b: AnalyticsLeader): number => {
    const pa = a.apeMonth.pct;
    const pb = b.apeMonth.pct;
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    }
    return order(a.head.membershipId, b.head.membershipId);
  };
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
