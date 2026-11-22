import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { calendarMonth, endOfMonth, type LocalDate } from '@/common/time/local-day';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { CoachingReadings } from '@/modules/coaching/coaching-readings';
import { EventAnalytics } from '@/modules/events/event-analytics.service';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings } from '@/modules/leads/lead-readings';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { recruitsJoined, type Recruit } from '@/modules/org/recruits';
import { daysSinceLastCoaching } from '@/domain/metrics/coaching-recency';
import { coachingStatus } from '@/domain/metrics/coaching-status';
import type { CoachingStatus } from '@/domain/constants/coaching-status';
import { activeAgentsIn } from '@/modules/production/active-agents';
import { OfficialApe } from '@/modules/production/official-ape';
import type { MonthLedger, ProductionReadings } from '@/modules/production/production-readings';
import { AdvancedAnalyticsService } from '@/modules/reporting/advanced-analytics/advanced-analytics.service';
import { ActivationComplianceCategory } from '@/modules/reporting/compliance/activation.category';
import { ActivityComplianceCategory } from '@/modules/reporting/compliance/activity.category';
import { CampaignsComplianceCategory } from '@/modules/reporting/compliance/campaigns.category';
import type { ComplianceCategory, ComplianceCategoryRead, ComplianceScope } from '@/modules/reporting/compliance/compliance-category';
import { EventsComplianceCategory } from '@/modules/reporting/compliance/events.category';
import { GoalsComplianceCategory } from '@/modules/reporting/compliance/goals.category';
import { LeadsComplianceCategory } from '@/modules/reporting/compliance/leads.category';
import { KpmOverviewService } from '@/modules/reporting/kpm-overview.service';
import { shiftMonth } from '@/modules/reporting/office-figures';
import { OfficeGroups } from '@/modules/reporting/office-groups';
import { overviewTree } from '@/modules/reporting/overview-tree';
import { monthBefore } from '@/modules/reporting/platform/platform-console.service';
import { officialGoalFigures } from '@/modules/summary/summary-figures';
import { SurveyPeopleService } from '@/modules/surveys/survey-people.service';
import { SurveyRunsService } from '@/modules/surveys/survey-runs.service';
import { SurveyParticipationRepository } from '@/modules/surveys/survey.repositories';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import {
  inReportOrder, kehadiranMark, pctOf, printedName, reportGroups,
  type ComplianceLine, type KpmReportAppendix, type KpmReportModel, type PerformanceLine, type ReportPerson,
  type ReportRole, type ReportStep,
} from './kpm-report.model';

/** The office as the report's first lines name it: read by the service before the readings. */
export interface ReportOffice {
  kpmId: string;
  name: string;
  company: string;
  code: string;
  ownerName: string | null;
}

/** The six compliance items the report prints from the KPM Overview's categories — every one but *Training* (§11). */
const CATEGORY_KEYS = ['goals', 'activity', 'leads', 'activation', 'events', 'campaigns'] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

const isLeader = (role: string | undefined) => role === 'ab' || role === 'aab';
const roleOf = (role: string | undefined): ReportRole => (role === 'ab' || role === 'aab' ? role : 'agent');

/**
 * **What the KPM report reads, and nothing it computes a second way** (P19.24-T1 AC-1, AC-2;
 * [ADR-0280](../../../../docs/04-adr/0280-the-kpm-report-is-one-pdf-built-on-the-server-from-the-pages-own-readings.md)
 * §2, §3): every figure through the service or reading its page already uses, over the KPM Overview's people.
 *
 * - **The context is the Super Admin inside the KPM** (`RequestContext.superAdminInKpm`, ADR-0268 §3): the KPM as its
 *   Owner sees it — the stewards' services answer it, and the surveys' views are the Owner's. It writes nothing of its
 *   own; the catch-up a page's read takes for any steward (a survey run due to open, a Quant run past its freeze) happens
 *   as on the Owner's own visit.
 * - **Who is counted**: `OfficeGroups.partition` — every active member, **test accounts never** (ADR-0267 §1) — in the
 *   Overview's tree (`overviewTree`), printed in §11's order (`reportGroups`).
 * - **As of one day** (§3): every rolling figure — *Pakai 14 hari terakhir*, *Power user*, coaching, compliance — is read
 *   as of the month's last day, or today in the KPM's month; ▲/▼ compares with the same reading as of last month's day.
 * - **The appendix** is each Advanced analytics section's own read; a section the KPM's template switches off, or that
 *   has nothing yet, is left out (`optional`), and a failure there is logged and leaves that part out rather than the
 *   whole report.
 */
@Injectable()
export class KpmReportReadings {
  private readonly logger = new Logger(KpmReportReadings.name);

  constructor(
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly groups: OfficeGroups,
    private readonly names: MemberNames,
    private readonly memberships: MembershipRepository,
    private readonly activity: ActivityReadings,
    private readonly coaching: CoachingReadings,
    private readonly leads: LeadReadings,
    private readonly production: OfficialApe,
    private readonly goals: GoalService,
    private readonly overview: KpmOverviewService,
    private readonly analytics: AdvancedAnalyticsService,
    private readonly surveyRuns: SurveyRunsService,
    private readonly surveyPeople: SurveyPeopleService,
    private readonly participation: SurveyParticipationRepository,
    /** *Event › Kehadiran* and *Feedback* (P19.25): the past events of the month, their figures and each person's marks. */
    private readonly eventAnalytics: EventAnalytics,
    @Inject(GoalsComplianceCategory) private readonly goalsCategory: ComplianceCategory<unknown>,
    @Inject(ActivityComplianceCategory) private readonly activityCategory: ComplianceCategory<unknown>,
    @Inject(LeadsComplianceCategory) private readonly leadsCategory: ComplianceCategory<unknown>,
    @Inject(ActivationComplianceCategory) private readonly activationCategory: ComplianceCategory<unknown>,
    @Inject(EventsComplianceCategory) private readonly eventsCategory: ComplianceCategory<unknown>,
    @Inject(CampaignsComplianceCategory) private readonly campaignsCategory: ComplianceCategory<unknown>,
  ) {}

  /** `activeAgentsIn`'s two reads, through the official port (as the KPM Overview hands them). */
  private get months(): Pick<ProductionReadings, 'monthCellsFor' | 'officeMonths'> {
    return {
      monthCellsFor: async (ctx, ids, range) => (await this.production.monthCellsAndYearToDateFor(ctx, ids, range)).cells,
      officeMonths: (ctx, range) => this.production.officeMonths(ctx, range),
    };
  }

  /** **The model** for one KPM and month. `ctx` is the Super Admin inside the KPM; `month` already checked in range. */
  async read(ctx: RequestContext, office: ReportOffice, month: string): Promise<KpmReportModel> {
    const day = await this.days.office(ctx);
    const { timezone } = day;
    const current = month === day.month;
    const asOf: LocalDate = current ? day.today : endOfMonth(`${month}-01`);
    const previousMonth = shiftMonth(month, -1);
    const comparedWith: LocalDate = current ? monthBefore(day.today) : endOfMonth(`${previousMonth}-01`);
    const monthFrom = `${month}-01`;
    const previousFrom = `${previousMonth}-01`;
    const year = month.slice(0, 4);

    const partition = await this.groups.partition(ctx);
    const ids = [...partition.members.keys()];
    const named = await this.names.byMembershipId(ctx, ids);
    const tree = overviewTree(partition, (id) => named.get(id) ?? '');
    const roleById = (id: string) => partition.members.get(id)?.role;

    const [
      usage, usageBefore, coaching, active, activeBefore, recruitsYear, recruitsBefore, potensi, potensiBefore,
      leadsNow, leadsBefore, countsNow, countsBefore, ledgers, performance,
    ] = await Promise.all([
      this.activity.usageOf(ctx, ids, asOf, { from: monthFrom, to: asOf }),
      this.activity.usageOf(ctx, ids, comparedWith, { from: previousFrom, to: comparedWith }),
      this.coachingAsOf(ctx, ids, asOf, timezone, current),
      activeAgentsIn(this.months, ctx, ids, month),
      activeAgentsIn(this.months, ctx, ids, previousMonth),
      recruitsJoined(this.memberships, ctx, { from: `${year}-01-01`, to: asOf }),
      recruitsJoined(this.memberships, ctx, calendarMonth(previousFrom)),
      this.leads.potensiOfManyIn(ctx, ids, { month, timezone }),
      this.leads.potensiOfManyIn(ctx, ids, { month: previousMonth, timezone }),
      current
        ? this.leads.countsOfMany(ctx, ids, { month })
        : this.leads.countsOfManyAt(ctx, ids, { month, at: this.clock.endOfLocalDay(timezone, asOf) }),
      this.leads.countsOfManyAt(ctx, ids, { month: previousMonth, at: this.clock.endOfLocalDay(timezone, comparedWith) }),
      this.activity.countsOverMany(ctx, ids, { from: monthFrom, to: asOf }),
      this.activity.countsOverMany(ctx, ids, { from: previousFrom, to: comparedWith }),
      this.production.ledgersFor(ctx, ids, month),
      this.overview.performance(ctx, { month }),
    ]);
    const plans = await this.goals.plansOf(ctx, year, ids, new Map(
      ids.map((id) => [id, (ledgers.get(id) as MonthLedger | undefined)?.standing.yearToDate ?? null]),
    ));

    // ---- Compliance: the KPM Overview's categories over the same scope, as of the report's day.
    const scope: ComplianceScope = {
      ctx,
      office: { ...day, today: asOf, month: asOf.slice(0, 7) },
      today: asOf,
      year: {
        from: `${asOf.slice(0, 4)}-01-01`,
        to: `${asOf.slice(0, 4)}-12-31`,
        start: this.clock.startOfLocalDay(timezone, `${asOf.slice(0, 4)}-01-01`),
        end: this.clock.endOfLocalDay(timezone, `${asOf.slice(0, 4)}-12-31`),
      },
      memberIds: tree.rows.map((r) => r.membershipId),
    };
    const readers: Record<CategoryKey, ComplianceCategory<unknown>> = {
      goals: this.goalsCategory,
      activity: this.activityCategory,
      leads: this.leadsCategory,
      activation: this.activationCategory,
      events: this.eventsCategory,
      campaigns: this.campaignsCategory,
    };
    const categories = new Map<CategoryKey, ComplianceCategoryRead<unknown>>(await Promise.all(
      CATEGORY_KEYS.map(async (key) => [key, await readers[key].read(scope, { selected: true, item: null })] as const),
    ));
    const cellDone = (key: CategoryKey, id: string) => categories.get(key)?.cells?.get(id)?.done ?? null;

    // ---- The surveys and the month's events: each its page's read, left out where there is none.
    const [npsView, qualView, monthEvents] = await Promise.all([
      this.optional('nps', () => this.surveyRuns.results(ctx, 'nps')),
      this.optional('qual', () => this.surveyRuns.results(ctx, 'qual')),
      this.monthEvents(ctx, month),
    ]);
    const npsRun = npsView?.selected ?? null;
    const npsParticipants = npsRun ? await this.participation.ofRun(ctx, npsRun.runId) : [];
    const npsAnswered = new Map(npsParticipants
      .filter((p) => partition.members.has(p.membershipId))
      .map((p) => [p.membershipId, p.submittedAt !== null]));

    const qualRun = qualView?.selected ?? null;
    const qualPeople = qualRun ? await this.optional('qual people', () => this.surveyPeople.people(ctx, qualRun.runId)) : null;
    const qualOf = new Map((qualPeople?.people ?? []).map((p) => [p.membershipId, { answered: p.answered, issues: p.issues }]));

    // ---- Each person, in the tree's order.
    const activeIds = new Set(active.people.map((p) => p.membershipId));
    const person = new Map<string, ReportPerson>();
    for (const row of tree.rows) {
      const id = row.membershipId;
      const u = usage.get(id);
      const c = coaching.get(id);
      const ledger = ledgers.get(id) as MonthLedger | undefined;
      const plan = plans.get(id);
      const goalMinor = plan && ledger
        ? officialGoalFigures({ goal: plan, month, ...ledger.standing, names: new Map() }).yearly.targetMinor
        : null;
      const counts = countsNow.get(id);
      const lead = leadsNow.get(id);
      person.set(id, {
        membershipId: id,
        name: printedName(named.get(id) ?? ''),
        role: roleOf(roleById(id)),
        groupName: row.groupId === null ? null : tree.groups.find((g) => g.groupId === row.groupId)?.name ?? null,
        abId: row.abMembershipId,
        // Set below, once the units are drawn (`reportGroups`): the unit decides, not the row.
        unitHeadId: null,
        usage: {
          ever: u?.everLogged ?? false,
          recent14: u?.usedLast14Days ?? false,
          days: u?.daysSinceLastLogged ?? null,
          powerUser: u?.powerUser ?? false,
          usedInMonth: u?.usedInPeriod === true,
        },
        coaching: { status: c?.status ?? 'never', days: c?.daysSinceLastCoaching ?? null },
        compliance: {
          goals: cellDone('goals', id),
          activity: cellDone('activity', id),
          leads: cellDone('leads', id),
          activation: cellDone('activation', id),
          events: cellDone('events', id),
          campaigns: cellDone('campaigns', id),
        },
        nps: npsAnswered.has(id) ? npsAnswered.get(id)! : null,
        activeAgent: active.held ? activeIds.has(id) : null,
        potensi: (potensi.get(id)?.sales.potensi ?? 0) > 0 && !activeIds.has(id),
        goalMinor: goalMinor && goalMinor > 0 ? goalMinor : null,
        ytdMinor: ledger?.standing.yearToDate?.minor ?? null,
        activities: counts ? [...counts.values()].reduce((s, n) => s + n, 0) : 0,
        leads: { sales: lead?.salesOpen ?? 0, recruit: lead?.recruitOpen ?? 0 },
        qualIssues: qualOf.get(id)?.issues ?? null,
        attendance: Object.fromEntries(monthEvents.list.map((e) => [e.id, e.marks.get(id) ?? null])),
      });
    }
    const groups = reportGroups(tree.groups, tree.rows, (id) => person.get(id)!);
    for (const unit of groups.flatMap((g) => g.abGroups.flatMap((ab) => ab.units))) {
      for (const p of unit.people) p.unitHeadId = unit.headId;
    }
    const people = inReportOrder(groups);
    const leaders = people.filter((p) => isLeader(p.role)).length;

    // ---- Pemakaian AgencyBoost, now and as of last month's day, over the same people.
    const step = (key: 'everLogged' | 'usedLast14Days' | 'powerUser'): ReportStep => {
      const now = ids.filter((id) => usage.get(id)?.[key] === true).length;
      const before = ids.filter((id) => usageBefore.get(id)?.[key] === true).length;
      return { count: now, pct: pctOf(now, ids.length), previousCount: before, previousPct: pctOf(before, ids.length) };
    };

    // ---- Performa vs target: the KPM Overview's own rows, with *Rekrut YTD* credited as its *Rekrut* is.
    const creditedYtd = (people: readonly string[]) => {
      const set = new Set(people);
      return recruitsYear.filter((r) => r.registeredByMembershipId !== null && set.has(r.registeredByMembershipId)).length;
    };
    const rows: PerformanceLine[] = performance.groups.flatMap((g) => g.abGroups.map((row): PerformanceLine => ({
      abId: row.abMembershipId,
      label: printedName(row.name),
      groupName: g.group?.name ?? null,
      apeMinor: row.actual.apeMinor,
      apePct: row.actual.apePct,
      activeAgents: { value: row.actual.activeAgents, target: row.source === 'none' ? null : row.activeAgentTarget },
      rekrutYtd: {
        value: creditedYtd(partition.abGroups.get(row.abMembershipId)?.memberIds ?? []),
        target: row.source === 'none' ? null : row.rekrutYtdTarget,
      },
    })));
    const anyTarget = rows.some((r) => r.activeAgents.target !== null);
    const total: PerformanceLine = {
      abId: null,
      label: 'Total KPM',
      groupName: null,
      apeMinor: performance.total.actual.apeMinor,
      apePct: performance.total.actual.apePct,
      activeAgents: { value: performance.total.actual.activeAgents, target: anyTarget ? performance.total.activeAgentTarget : null },
      rekrutYtd: { value: recruitsYear.length, target: anyTarget ? performance.total.rekrutYtdTarget : null },
    };

    // ---- Compliance's eight items: six cards, coaching ≤ 14 days, and the latest NPS run.
    const compliance: ComplianceLine[] = [
      ...CATEGORY_KEYS.map((key): ComplianceLine => ({ key, done: categories.get(key)!.chip.count, of: categories.get(key)!.chip.of })),
      { key: 'coaching', done: people.filter((p) => p.coaching.status === 'recent').length, of: people.length },
      { key: 'nps', done: [...npsAnswered.values()].filter(Boolean).length, of: npsAnswered.size },
    ];

    const recruitNames = await this.names.byMembershipId(ctx, [
      ...recruitsYear.map((r) => r.membershipId),
      ...recruitsYear.map((r) => r.registeredByMembershipId).filter((id): id is string => id !== null),
    ]);
    const recruitsMonth = recruitsYear.filter((r) => r.joinDate >= monthFrom && r.joinDate <= asOf);
    const monthTarget = anyTarget ? performance.total.rekrutTarget : null;

    const sumLeads = (m: Map<string, { salesOpen: number; recruitOpen: number }>) =>
      ids.reduce((s, id) => s + (m.get(id)?.salesOpen ?? 0) + (m.get(id)?.recruitOpen ?? 0), 0);
    const sumCounts = (m: Map<string, Map<string, number>>) =>
      ids.reduce((s, id) => s + [...(m.get(id)?.values() ?? [])].reduce((a, n) => a + n, 0), 0);

    const appendix = await this.appendix(ctx, month, npsRun, qualView, qualPeople, monthEvents, partition.members, named);

    return {
      office,
      month,
      asOf,
      comparedWith,
      madeOn: day.today,
      groups,
      people,
      members: { total: people.length, leaders, agents: people.length - leaders },
      newMembers: recruitsMonth.length,
      funnel: { everUsed: step('everLogged'), used14: step('usedLast14Days'), powerUsers: step('powerUser') },
      performance: {
        held: performance.held,
        rows,
        total,
        aboveTarget: rows.filter((r) => r.apePct !== null && r.apePct >= 100).length,
      },
      activity: {
        total: sumCounts(countsNow),
        previousTotal: sumCounts(countsBefore),
        leadsSales: ids.reduce((s, id) => s + (leadsNow.get(id)?.salesOpen ?? 0), 0),
        leadsRecruit: ids.reduce((s, id) => s + (leadsNow.get(id)?.recruitOpen ?? 0), 0),
        previousLeads: sumLeads(leadsBefore),
        withoutActivity: ids.filter((id) => usage.get(id)?.usedInPeriod !== true).length,
        previousWithout: ids.filter((id) => usageBefore.get(id)?.usedInPeriod !== true).length,
      },
      activeAgents: {
        held: active.held,
        count: active.count,
        target: total.activeAgents.target,
        previousCount: activeBefore.count,
        potensi: people.filter((p) => p.potensi).length,
        previousPotensi: ids.filter((id) => (potensiBefore.get(id)?.sales.potensi ?? 0) > 0
          && !activeBefore.people.some((a) => a.membershipId === id)).length,
        recruitsMonth: recruitsMonth.length,
        previousRecruitsMonth: recruitsBefore.length,
        recruitsMonthTarget: monthTarget,
        recruitsYtd: recruitsYear.length,
        recruitsYtdTarget: total.rekrutYtd.target,
        recruits: recruitsYear.map((r: Recruit) => ({
          name: printedName(recruitNames.get(r.membershipId) ?? ''),
          recruiter: r.registeredByMembershipId
            ? { name: printedName(recruitNames.get(r.registeredByMembershipId) ?? ''), role: roleOf(roleById(r.registeredByMembershipId)) }
            : null,
          joinDate: r.joinDate,
        })),
      },
      compliance,
      npsPeriod: npsRun?.periodKey ?? null,
      appendix,
    };
  }

  /**
   * **`COACHING_STATUS` as of the report's day** (ADR-0280 §3). In the KPM's month, `CoachingReadings.statusOf` itself. For
   * a past month the latest 1-on-1 **on or before** that month's last day — the same counted sessions
   * (`countedSince`), the same days in the office's calendar (`daysSinceLastCoaching`) and the same buckets
   * (`coachingStatus`) — so a 1-on-1 held after the month never shows as one held *-16 hari lalu*.
   */
  private async coachingAsOf(
    ctx: RequestContext, ids: readonly string[], asOf: LocalDate, timezone: string, current: boolean,
  ): Promise<Map<string, { status: CoachingStatus; daysSinceLastCoaching: number | null }>> {
    if (current) return this.coaching.statusOf(ctx, ids, { today: asOf, timezone });
    const sessions = await this.coaching.countedSince(ctx, ids, '0000-01-01');
    const latest = new Map<string, LocalDate>();
    for (const s of sessions) {
      if (s.date > asOf) continue;
      const was = latest.get(s.coacheeMembershipId);
      if (!was || s.date > was) latest.set(s.coacheeMembershipId, s.date);
    }
    const between = (from: string, to: string) => this.clock.daysBetween(timezone, from, to);
    return new Map(ids.map((id) => {
      const days = daysSinceLastCoaching(latest.get(id) ?? null, asOf, between);
      return [id, { status: coachingStatus(days), daysSinceLastCoaching: days }];
    }));
  }

  /**
   * **The month's past events and each person's mark** — *Advanced analytics › Event › Kehadiran*'s own read
   * (`EventAnalytics.attendance`, P19.25): its events newest first, each with its figure (*hadir* of *expected*), and every
   * person's marks in that order (`1` hadir, `0` tidak hadir, `.` not expected, `?` not recorded); with *Feedback*'s NPS
   * per event (`feedbackView`). Nothing when the KPM held no event that month.
   */
  private async monthEvents(ctx: RequestContext, month: string) {
    const [kehadiran, feedback] = await Promise.all([
      this.optional('events attendance', () => this.eventAnalytics.attendance(ctx, { month })),
      this.optional('events feedback', () => this.eventAnalytics.feedbackView(ctx, { month })),
    ]);
    const past = kehadiran?.past ?? [];
    const nps = new Map((feedback?.rows ?? []).map((r) => [r.eventId, r]));
    const people = new Map((kehadiran?.people ?? []).map((p) => [p.membershipId, p.marks]));
    return {
      summaryPct: kehadiran?.summary.pct ?? null,
      list: past.map((event, i) => ({
        id: event.eventId,
        title: event.title,
        startsOn: event.startsOn,
        recorded: event.recorded,
        figure: event.figure,
        nps: nps.get(event.eventId)?.nps ?? null,
        answers: nps.get(event.eventId)?.answers ?? 0,
        marks: new Map([...people].map(([id, marks]) => [id, kehadiranMark(marks[i])])),
      })),
    };
  }

  /** *Lampiran · Advanced analytics*: each section's own read, a missing one `null`. */
  private async appendix(
    ctx: RequestContext,
    month: string,
    npsRun: Awaited<ReturnType<SurveyRunsService['results']>>['selected'] | null,
    qualView: Awaited<ReturnType<SurveyRunsService['results']>> | null,
    qualPeople: Awaited<ReturnType<SurveyPeopleService['people']>> | null,
    monthEvents: Awaited<ReturnType<KpmReportReadings['monthEvents']>>,
    members: ReadonlyMap<string, { role: string }>,
    named: ReadonlyMap<string, string>,
  ): Promise<KpmReportAppendix> {
    const [demo, mapa, quant, subgroup] = await Promise.all([
      this.optional('demographics', () => this.analytics.demographics(ctx, { month })),
      this.optional('mapa', () => this.analytics.mapa(ctx, { month })),
      this.optional('quant', () => this.analytics.quantView(ctx, {})),
      this.optional('subgroup', () => this.analytics.subgroup(ctx, { month })),
    ]);

    const nps = npsRun?.nps ? {
      period: npsRun.periodKey,
      sent: npsRun.responses.sent,
      invited: npsRun.responses.invited,
      leaders: npsRun.responses.leaders,
      agents: npsRun.responses.agents,
      lines: [...(npsRun.nps.headline ? [npsRun.nps.headline] : []), ...npsRun.nps.questions].map((line) => ({
        text: line.text.id,
        score: line.score,
        change: line.change,
        shares: line.shares,
        reasons: (line.reasons ?? []).map((q) => ({ text: q.text, who: q.who })),
      })),
    } : null;

    const qualRun = qualView?.selected ?? null;
    const qual = qualRun?.qual ? {
      period: qualRun.periodKey,
      respondents: qualRun.responses.sent,
      invited: qualRun.responses.invited,
      blocks: qualRun.qual.blocks.filter((b) => b.asked).map((b) => ({
        title: b.title.id,
        respondents: b.respondents,
        rows: b.rows.map((r) => ({ label: r.label.id, issuePct: r.issuePct, previousPct: r.previousPct })),
      })),
      people: new Map((qualPeople?.people ?? [])
        .filter((p) => members.has(p.membershipId))
        .map((p) => [p.membershipId, { answered: p.answered, issues: p.issues }])),
    } : null;

    const events = monthEvents.list.length === 0 ? null : {
      summaryPct: monthEvents.summaryPct,
      list: monthEvents.list.map((e) => ({
        id: e.id,
        title: e.title,
        startsOn: e.startsOn,
        attended: e.figure?.hadir ?? null,
        audience: e.figure?.expected ?? null,
        pct: e.figure?.pct ?? null,
        nps: e.nps,
        answers: e.answers,
      })),
    };

    return {
      demographics: demo ? {
        manpower: demo.summary.manpower,
        complete: demo.summary.complete,
        incomplete: demo.summary.incomplete,
        completePct: demo.summary.completePct,
        role: demo.role,
        workStatus: demo.workStatus,
        tenureBand: demo.tenureBand,
        ageBand: demo.ageBand,
        gender: demo.gender,
        missing: new Map(demo.members.filter((m) => m.missing.length > 0).map((m) => [m.membershipId, [...m.missing]])),
      } : null,
      mapa: mapa ? {
        headline: {
          ape: { value: mapa.headline.ape.value, target: mapa.headline.ape.target },
          activeAgent: { value: mapa.headline.activeAgent.value, target: mapa.headline.activeAgent.target },
          rekrut: { value: mapa.headline.rekrut.value, target: mapa.headline.rekrut.target },
        },
        rows: mapa.rows.map((r) => ({
          key: r.key, unit: r.unit, ytdLastYear: r.ytdLastYear, ytd: r.ytd, sameMonthLastYear: r.sameMonthLastYear,
          thisMonth: r.thisMonth, target: r.target,
        })),
      } : null,
      nps,
      quant: quant && quant.periodEnd ? {
        fromMonth: quant.fromMonth,
        periodEnd: quant.periodEnd,
        metrics: quant.metrics.map((m) => ({
          code: m.code, value: m.value, median: m.median, previous: m.previous, status: m.status,
          percent: m.code === 'B1' || m.code === 'B2' || m.code === 'B3',
        })),
      } : null,
      qual,
      informal: subgroup ? {
        groups: subgroup.groups.map((g) => ({
          name: g.group?.name ?? null,
          rows: g.abGroups.map((row) => ({
            abId: row.ab.membershipId,
            label: printedName(named.get(row.ab.membershipId) ?? row.ab.name),
            people: row.people,
            maa: { value: row.drivers.maa.value, target: row.drivers.maa.target },
            usagePct: row.drivers.usage.downlinePct ?? row.drivers.usage.leaderPct,
            oneOnOne: { value: row.drivers.oneOnOne.value, target: row.drivers.oneOnOne.target },
            rekrut: { value: row.drivers.rekrut.value, target: row.drivers.rekrut.target },
          })),
        })),
      } : null,
      events,
    };
  }

  /**
   * **A part that may be absent**: a section the KPM's template switches off answers `404` — left out, as the page
   * leaves its tab out. Any other failure is logged, with the part's name and no person, and leaves that part out: an
   * appendix part never takes the whole report with it.
   */
  private async optional<T>(part: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      if (!(err instanceof NotFoundException)) this.logger.warn({ err, part }, 'a KPM report part could not be read');
      return null;
    }
  }
}
