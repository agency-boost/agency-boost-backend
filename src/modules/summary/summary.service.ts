import { Injectable, Optional, Inject } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { SUMMARY } from '@/domain/constants';
import { endOfMonth, localDayOf, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { ActivityService } from '@/modules/activity/activity.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings, type OpenLead } from '@/modules/leads/lead-readings';
import { CoachResolver, type Subject } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { ProductionReadings } from '@/modules/production/production-readings';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { boundCodes, countOf, defaultBinding } from '@/modules/config/activity-binding';
import { ActivityBindingService } from '@/modules/config/activity-binding.service';
import { insightsFor, type Insight } from './insights';
import { summaryPeriod, type SummaryPeriodQuery } from './summary-period';
import {
  activityTargets, goalFigures, paceFor, sectionChips, totalLogged,
  type ActivityTarget, type FigureSource, type Pace, type PeriodFigures, type SectionChip,
} from './summary-figures';

export type { FigureSource };

/** *Your sales activity targets* for one period (P10-T5, ADR-0056). */
export interface SummaryActivity {
  /**
   * The days counted: the calendar month, or the year, to today — the office's. A closed month or year is
   * counted whole (P18.8-T11).
   */
  from: LocalDate;
  to: LocalDate;
  /**
   * Leads contacted, appointments, closings — each against the cascade run on the period's APE target: this month's
   * fixed one, or, for the year, what the year still needs (UI-052: the year's *Submission polis* is *Polis yang
   * dibutuhkan*).
   */
  targets: ActivityTarget[];
  /** *n aktivitas*: the sum of `targets`' and `sections`' rows, each code once (UI-052) — what the page shows. */
  total: number;
  /** One per other section the member's rung is shown — the subject's, on a leader's copy. */
  sections: SectionChip[];
}

export interface SummaryView {
  /** The year *Yearly* is about: this one, or with `year` or `month`, an earlier one (P18.8-T11). */
  year: string;
  /** The month *Monthly* is about, `YYYY-MM`: the office's calendar month, or an earlier one. */
  month: string;
  today: LocalDate;
  /**
   * **Which period this is, and which there are** (P18.8-T11, ADR-0161 §4): the office's first month and its
   * current one — the range a `month` may name, and their years a `year` — and whether `month` and `year` are
   * the current ones. A closed period is read whole and carries no pace; the screen shows *The gap* for the
   * current one only.
   */
  period: { firstMonth: string; thisMonth: string; currentMonth: boolean; currentYear: boolean };
  /** Whether a goal has been **saved** for the year. The defaults a first-time reader sees are not one. */
  goal: { set: boolean; savedAt: string | null };
  caseSizeMinor: number;
  /** *Monthly* (ADR-0056): this month's fixed target against this month's uploaded APE. */
  monthly: PeriodFigures & { source: FigureSource | null };
  /** *Yearly*: the annual target against the year to date, from whichever writer holds it (P9-T6). */
  yearly: PeriodFigures & { source: FigureSource };
  /** The pace sentence (ADR-0109); `null` without a goal, and for a month that has ended (P18.8-T11). */
  pace: Pace | null;
  /**
   * **Where this page's counts of policies come from** (UI V1, UI-052), so the screen can say so: every one — the
   * *Submission polis* chips and the pace sentence's *closing N* — is the member's **activity log**
   * (`activity_log`), the codes the office binds to *Submission polis* (`codes`). APE, the gap and *Polis yang
   * dibutuhkan* are the office's **production upload** (`monthly.source`, `yearly.source`).
   */
  policies: { source: 'activity_log'; codes: string[] };
  /**
   * **The day the page's APE is valid for** (UI V1, UI-054: the date header above the goal card): the office's day its
   * latest production file standing for the period was uploaded, in its calendar — for `month`, that month's file; for
   * `year`, the newest file of any of its months up to `month`. `null` while there is none, and the header names the
   * period instead. The upload's date, not today's: a figure from the 12th says the 12th on the 30th.
   */
  uploadedOn: { month: LocalDate | null; year: LocalDate | null };
  /** What was logged against the plan, and the rest of the member's sections (P10-T5). */
  activity: { monthly: SummaryActivity; yearly: SummaryActivity };
  /**
   * *Leads that need you* (P10-T6): the member's own open leads — the reader's, or on a leader's copy
   * the subject's (*Leads that need her*) — nearest next action first and undated last, the first
   * `SUMMARY.LEADS_SHOWN` of them, and how many there are.
   */
  leads: {
    rows: OpenLead[];
    total: number;
    /**
     * **The open leads Leads Management lists the reader besides their own** (P18.8-T15 AC-4; the client's UI
     * review, UI-002): those of everybody else their `lead:read` reaches. Counted only on the reader's own
     * summary while their own card is empty — the one case its sentence reads — and 0 otherwise. An Agent's
     * grant is their own leads alone, so an Agent who leads somebody reads 0.
     */
    unitOpen: number;
  };
  /**
   * The insight cards (P10-T7, ADR-0060): the rules that fired, in their fixed priority, at most four —
   * each naming its rule and carrying the facts it read.
   */
  insights: Insight[];
}

/**
 * The Personal Summary (P10-T4): one page, read from what other modules hold — the goal, the office's
 * production, the member's own log. Nothing of the member's is written here, and nothing is stored.
 *
 * **Yours, or a subject's** (P11-T4 AC-1). Without `for`, or naming the caller, it is the caller's own
 * read, unchanged and unaudited. Naming somebody else, it is the same Summary **computed for them** —
 * their goal, their production and whose figure it is, their log, their leads, their compliance, and
 * **their rung** for the sections and the ratios (ADR-0020): the leader's copy of the coachee's own
 * page, which the person shell's *Personal Summary* tab draws.
 *
 * - **Whose is decided by `CoachResolver.subject`** on `personal_summary:read`, as every subject read
 *   is: `own` reaches only the caller, so an Agent naming somebody else is 404; a hierarchy token
 *   reaches `COACH`; `own-kpm` the office. Outside it, 404, never 403.
 * - **One §3.5 entry per read of somebody else's**, `personal_summary`, **from no date to today**,
 *   written last, once the answer exists (P11-T4 AC-5). Not from the office's year: the answer
 *   discloses their open leads whatever their age, and compliance's `lastLoggedOn` in the
 *   `NOTHING_LOGGED` insight, either of which may fall in an earlier year, so a range starting on
 *   1 January would understate what was read. The `leads` surface records `from: null` for the same reason. The compliance and the ratios are read through
 *   their subject-taking internals, which write nothing of their own: one read, one record.
 */
@Injectable()
export class SummaryService {
  constructor(
    private readonly goals: GoalService,
    private readonly production: ProductionReadings,
    private readonly activity: ActivityReadings,
    private readonly days: TenantDay,
    private readonly leadReadings: LeadReadings,
    /*
     * The ratio engine and the compliance read, for the insight rules (P10-T7) — the same answers the
     * ratio screen and the log screen give, not a second calculation of either.
     */
    private readonly activityLog: ActivityService,
    // Whose Summary it is, and the record a read of somebody else's leaves (P11-T4).
    private readonly coach: CoachResolver,
    private readonly subjectReads: SubjectReadAudit,
    // Who corrected a figure, by name (Phase 15): the source says so on every screen.
    private readonly names: MemberNames,
    /*
     * ADR-0163 §4: which activity types each cascade role counts — the office's binding, the one reader. The
     * application always provides it; optional so a hand-built instance need not, and without it the default binding.
     */
    @Optional() @Inject(ActivityBindingService) private readonly bindings: ActivityBindingService | null = null,
    /*
     * UI-054: the office's production imports, for the day the page's APE is valid for. The application always provides
     * it; optional so a hand-built instance need not (a coaching snapshot reads no date), and without it no date.
     */
    @Optional() @Inject(DataUploadBatchRepository) private readonly batches: DataUploadBatchRepository | null = null,
  ) {}

  /**
   * `asked` is the period (P18.8-T11, ADR-0161 §4): a month or a year, for oneself or with `for`; neither is this
   * month. One outside the office's calendar is refused `400`, after the subject is resolved — so a stranger is
   * still 404 — and before anything is read or recorded.
   */
  async read(ctx: RequestContext, forMembershipId?: string, asked: SummaryPeriodQuery = {}): Promise<SummaryView> {
    const subject = await this.coach.subject(ctx, forMembershipId, 'personal_summary:read');
    const view = await this.of(ctx, subject, asked);
    // Last, once the answer exists; nothing for the caller's own read (`SubjectReadAudit`). Open-ended at
    // the start: open leads of any age and the last day logged are in the answer (see the class comment).
    await this.subjectReads.record(ctx, subject, 'personal_summary', { from: null, to: view.today });
    return view;
  }

  /**
   * **The Summary of a subject the caller already resolved, and no audit entry** (P11-T5): the
   * subject-taking internal of `read`, as `ActivityService.ratiosOf` is of `ratios`. A coaching session's
   * snapshot takes its goal figures from here at finalize — the figures the coachee's Summary tab shows
   * that day — and finalize writes its own entry for what it disclosed, rather than one per figure.
   */
  async of(ctx: RequestContext, subject: Subject, asked: SummaryPeriodQuery = {}): Promise<SummaryView> {
    const member = subject.membershipId;
    // The office's day and the month it opened, in one read; the period checked against them (P18.8-T11).
    const day = await this.days.calendar(ctx);
    const period = summaryPeriod(day, asked);
    const { year } = period;

    // Resolved once, above, on this route's own permission: the plan is read for that member.
    const goal = await this.goals.planOf(ctx, year, member);

    /*
     * **Lead rows only to a reader who may read that member's leads** (roles §3.7: lead records are not
     * admin-readable, "never the lead rows"). `personal_summary:read` reaches the office for the Owner
     * and the Admin, `lead:read` does not, so an Owner or Admin who is not above the member reads the
     * count of open leads and none of the rows, nor the two insights that name a lead.
     */
    const leadReach = subject.self ? null : await this.coach.reach(ctx, 'lead:read');
    const showsLeads = subject.self || leadReach === null || leadReach.includes(member);

    /*
     * **The period's days** (P18.8-T11): this month and this year to today, as ever; a closed month or year whole,
     * so it shows its final figures. The production ledger is the period's month's, which is also what fixes that
     * month's target as it stood when the month began (ADR-0056).
     */
    const { monthWindow, yearWindow } = period;
    // The pace sentence's *tracking to close N* (ADR-0109): the office's last 30 days, today included. Read only
    // for the current month: about a month that has ended the sentence would be false (ADR-0161 §4).
    const paceWindow = rollingWindow(day.today, SUMMARY.PACE_WINDOW_DAYS);
    const [
      ledgers, counts, yearCounts, recentCounts, sections, openLeads, compliance, ratios, binding, monthUpload, yearUpload,
    ] = await Promise.all([
      /*
       * The year to date through last month, this month's own APE and the year's latest year to date, with
       * who corrected each, in one read — the reading the Unit Dashboard makes for a whole unit (Phase 15),
       * so the two answer by one rule.
       */
      this.production.ledgersFor(ctx, [member], period.month),
      this.activity.countsOver(ctx, member, monthWindow),
      this.activity.countsOver(ctx, member, yearWindow),
      period.currentMonth ? this.activity.countsOver(ctx, member, paceWindow) : Promise.resolve(new Map<string, number>()),
      // The subject's rung, not the reader's (ADR-0020): a leader reads the coachee's own page.
      this.activity.sectionsShown(ctx, subject.orgLevelCode),
      this.leadReadings.openOf(ctx, member, day),
      this.activityLog.complianceOf(ctx, member),
      this.activityLog.ratiosOf(ctx, subject),
      // Which codes the three targets and the pace count: the office's binding, today (ADR-0163 §4).
      this.bindings ? this.bindings.resolveCascadeBinding(ctx) : Promise.resolve(defaultBinding()),
      // UI-054: the day the month's APE, and the year's, is valid for — the latest file standing for each.
      this.uploadedOn(ctx, { from: period.month, to: period.month }, day.timezone),
      this.uploadedOn(ctx, { from: `${year}-01`, to: period.month }, day.timezone),
    ]);

    /*
     * **No target is no target**: a saved goal of zero — which the goal form allows — or one whose stored
     * assumptions cannot produce a plan measures nothing, and gets no pace against *a target of 0*. The
     * targets are `summaryPlan`'s, which `GET /activity/summary` pro-rates to the last 7 days (P11-T4).
     *
     * **One computation for the figures** (Phase 15, D-figures): `goalFigures`, which the Unit Dashboard
     * runs over every row of a unit from the same readings fetched in bulk. An unsaved default is an offer,
     * not a goal, and `set` says so: the Summary measures nobody against a plan they never made.
     */
    const { throughLastMonth, thisMonth, yearToDate } = ledgers.get(member)!.standing;
    const correctors = [thisMonth?.correctedBy, yearToDate?.correctedBy].filter((id): id is string => Boolean(id));
    const names = correctors.length ? await this.names.byMembershipId(ctx, correctors) : new Map<string, string>();
    const figures = goalFigures({ goal, month: period.month, throughLastMonth, thisMonth, yearToDate, names });
    const { plan, monthly, yearly } = figures;
    const monthlyTarget = plan.monthlyTargetMinor;

    /*
     * **The chips' targets are the cascade run on the Summary's own APE targets** (ADR-0056, P10-T5).
     *
     * *Monthly*: this month's fixed target — so the closings chip, the policies the gap says are needed and
     * the target the pace sentence names are one number. Goal Settings' plan is re-derived from today and
     * can differ; the manual says why. *Yearly*: the monthly pace annualised — the year's target over
     * twelve, run through the cascade and multiplied back — **rounded once, at the end**, which is the
     * cascade on the year's target. Ceiling each month first would ask for up to twelve extra policies.
     */
    const { monthlyCounts, yearlyCounts } = plan;
    const closingTarget = monthlyCounts?.policies ?? null;

    /*
     * **The office's binding, not the goal's stored mapping** (ADR-0163 §4): a role bound to `[A, B]` counts both,
     * so an activity replaced keeps its history counting and its replacement counts from now. The goal's
     * `cascadeMapping` stays as the record of what it was first counted against, and is not read here.
     */
    const cascadeCodes = boundCodes(binding);
    const activityFor = (
      window: { from: LocalDate; to: LocalDate }, logged: Map<string, number>, plan: typeof monthlyCounts,
    ): SummaryActivity => {
      const targets = activityTargets(plan, binding, logged);
      const chips = sectionChips(sections, logged, cascadeCodes);
      // UI-052: the total is the breakdown's own sum.
      return { ...window, targets, total: totalLogged(logged, targets, chips), sections: chips };
    };

    /*
     * **The prototype's sentence, by the prototype's arithmetic** (ADR-0109): *N* the closings of the last
     * 30 days, *M* the closings chip's target, *K* the policies this month's APE gap still needs over the
     * weeks left. A closing target exists only with a monthly target and a case size, so both are here.
     *
     * **This month's only** (P18.8-T11, ADR-0161 §4): a month that has ended has no pace to keep and no weeks
     * left, so it has no sentence — nor, with no pace, the `BEHIND_PACE` card, which is the sentence's rule.
     */
    const pace = !period.currentMonth || closingTarget === null || monthlyTarget === null ? null : paceFor({
      closingTarget,
      closingsLast30Days: countOf(recentCounts, binding.closings),
      dayOfMonth: Number(day.today.slice(8, 10)),
      daysInMonth: Number(endOfMonth(day.today).slice(8, 10)),
      apeTargetMinor: monthlyTarget,
      apeProducedMinor: thisMonth?.minor ?? null,
      caseSizeMinor: goal.caseSizeMinor,
      apeTargetMet: monthly.targetMet || yearly.targetMet,
    });

    const view: SummaryView = {
      year,
      month: period.month,
      today: day.today,
      period: {
        firstMonth: day.firstMonth, thisMonth: day.month, currentMonth: period.currentMonth, currentYear: period.currentYear,
      },
      goal: { set: figures.set, savedAt: goal.savedAt },
      caseSizeMinor: figures.caseSizeMinor,
      monthly,
      yearly,
      pace,
      policies: { source: 'activity_log', codes: [...binding.closings] },
      uploadedOn: { month: monthUpload, year: yearUpload },
      activity: {
        monthly: activityFor(monthWindow, counts, monthlyCounts),
        yearly: activityFor(yearWindow, yearCounts, yearlyCounts),
      },
      leads: {
        rows: showsLeads ? openLeads.slice(0, SUMMARY.LEADS_SHOWN) : [],
        total: openLeads.length,
        unitOpen: subject.self && openLeads.length === 0 ? await this.unitOpenLeads(ctx, member) : 0,
      },
      insights: insightsFor({
        compliance: { compliant: compliance.compliant7d, windowDays: compliance.windowDays, lastLoggedOn: compliance.lastLoggedOn },
        pace,
        leads: openLeads,
        ratios: ratios.ratios,
      }).filter((i) => showsLeads || (i.rule !== 'LEAD_OVERDUE' && i.rule !== 'LEAD_NEGLECTED')),
    };

    return view;
  }

  /**
   * The open leads of everybody the reader's `lead:read` reaches but themselves (P18.8-T15 AC-4) — the downline
   * `/leads` lists them, by the same `reach`. An office-wide grant is the office; `own` is nobody else.
   */
  private async unitOpenLeads(ctx: RequestContext, member: string): Promise<number> {
    const reach = await this.coach.reach(ctx, 'lead:read');
    return this.leadReadings.countOpenOf(ctx, reach, member);
  }

  /**
   * **The office's day its latest production file for a range of months was uploaded** (UI V1, UI-054): the newest
   * import standing (`committed` — a reverted or a failed one stands for nothing) of those months, in the office's
   * calendar, or `null` while there is none. The office's own: through the tenant-scoped repository, on the batches'
   * `(kpmId, month, status, …)` index. The figure is the office's, so a leader's read of a coachee's Summary reads the
   * same date the coachee does.
   */
  private async uploadedOn(ctx: RequestContext, months: { from: string; to: string }, timezone: string): Promise<LocalDate | null> {
    if (!this.batches) return null;
    const [latest] = await this.batches.find(
      ctx,
      { month: { $gte: months.from, $lte: months.to }, status: 'committed', committedAt: { $ne: null } },
      { sort: { committedAt: -1 }, limit: 1, projection: { committedAt: 1 } },
    );
    return latest?.committedAt ? localDayOf(latest.committedAt, timezone) : null;
  }
}
