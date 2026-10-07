import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { SUMMARY } from '@/domain/constants';
import { endOfMonth, rollingWindow, type LocalDate } from '@/common/time/local-day';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { ActivityService } from '@/modules/activity/activity.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadReadings, type OpenLead } from '@/modules/leads/lead-readings';
import { CoachResolver, type Subject } from '@/modules/org/coach-resolver';
import { ProductionReadings } from '@/modules/production/production-readings';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { insightsFor, type Insight } from './insights';
import {
  activityTargets, madeFigures, paceFor, periodFigures, sectionChips, summaryPlan, totalLogged,
  type ActivityTarget, type Pace, type PeriodFigures, type SectionChip,
} from './summary-figures';

/** Where a production figure came from, said with it (ADR-0008, P9-T6). */
export interface FigureSource {
  provenance: 'imported' | 'corrected' | 'self_reported';
  /** `YYYY-MM` — the month the figure is for, or whose year to date it is; `null` for the agent's own. */
  month: string | null;
}

/** *Your sales activity targets* for one period (P10-T5, ADR-0056). */
export interface SummaryActivity {
  /** The days counted: the calendar month, or the year, to today — the office's. */
  from: LocalDate;
  to: LocalDate;
  /** Leads contacted, appointments, closings — each against the cascade run on the period's APE target. */
  targets: ActivityTarget[];
  /** *N total activities logged … across all categories.* */
  total: number;
  /** One per other section the member's rung is shown — the subject's, on a leader's copy. */
  sections: SectionChip[];
}

export interface SummaryView {
  year: string;
  /** The office's calendar month, `YYYY-MM`. */
  month: string;
  today: LocalDate;
  /** Whether a goal has been **saved** for the year. The defaults a first-time reader sees are not one. */
  goal: { set: boolean; savedAt: string | null };
  caseSizeMinor: number;
  /** *Monthly* (ADR-0056): this month's fixed target against this month's uploaded APE. */
  monthly: PeriodFigures & { source: FigureSource | null };
  /** *Yearly*: the annual target against the year to date, from whichever writer holds it (P9-T6). */
  yearly: PeriodFigures & { source: FigureSource };
  /** The pace sentence (ADR-0109); `null` without a goal. */
  pace: Pace | null;
  /** What was logged against the plan, and the rest of the member's sections (P10-T5). */
  activity: { monthly: SummaryActivity; yearly: SummaryActivity };
  /**
   * *Leads that need you* (P10-T6): the member's own open leads — the reader's, or on a leader's copy
   * the subject's (*Leads that need her*) — nearest next action first and undated last, the first
   * `SUMMARY.LEADS_SHOWN` of them, and how many there are.
   */
  leads: { rows: OpenLead[]; total: number };
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
  ) {}

  async read(ctx: RequestContext, forMembershipId?: string): Promise<SummaryView> {
    const subject = await this.coach.subject(ctx, forMembershipId, 'personal_summary:read');
    const view = await this.of(ctx, subject);
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
  async of(ctx: RequestContext, subject: Subject): Promise<SummaryView> {
    const member = subject.membershipId;
    const day = await this.days.for(ctx);
    const year = day.today.slice(0, 4);
    const monthNumber = Number(day.month.slice(5, 7));
    const previous = monthNumber === 1 ? null : `${year}-${String(monthNumber - 1).padStart(2, '0')}`;

    // Resolved once, above, on this route's own permission: the plan is read for that member.
    const goal = await this.goals.planOf(ctx, year, member);
    // An unsaved default is an offer, not a goal: the Summary measures nobody against a plan they never made.
    const set = goal.savedAt !== null;

    /*
     * **Lead rows only to a reader who may read that member's leads** (roles §3.7: lead records are not
     * admin-readable, "never the lead rows"). `personal_summary:read` reaches the office for the Owner
     * and the Admin, `lead:read` does not, so an Owner or Admin who is not above the member reads the
     * count of open leads and none of the rows, nor the two insights that name a lead.
     */
    const leadReach = subject.self ? null : await this.coach.reach(ctx, 'lead:read');
    const showsLeads = subject.self || leadReach === null || leadReach.includes(member);

    const monthWindow = { from: `${day.month}-01` as LocalDate, to: day.today };
    const yearWindow = { from: `${year}-01-01` as LocalDate, to: day.today };
    // The pace sentence's *tracking to close N* (ADR-0109): the office's last 30 days, today included.
    const paceWindow = rollingWindow(day.today, SUMMARY.PACE_WINDOW_DAYS);
    const [through, thisMonth, counts, yearCounts, recentCounts, sections, openLeads, compliance, ratios] = await Promise.all([
      previous ? this.production.apeYearToDateThrough(ctx, member, previous) : Promise.resolve(null),
      this.production.apeForMonth(ctx, member, day.month),
      this.activity.countsOver(ctx, member, monthWindow),
      this.activity.countsOver(ctx, member, yearWindow),
      this.activity.countsOver(ctx, member, paceWindow),
      // The subject's rung, not the reader's (ADR-0020): a leader reads the coachee's own page.
      this.activity.sectionsShown(ctx, subject.orgLevelCode),
      this.leadReadings.openOf(ctx, member, day),
      this.activityLog.complianceOf(ctx, member),
      this.activityLog.ratiosOf(ctx, subject),
    ]);

    /*
     * **No target is no target**: a saved goal of zero — which the goal form allows — or one whose stored
     * assumptions cannot produce a plan measures nothing, and gets no pace against *a target of 0*. The
     * targets are `summaryPlan`'s, which `GET /activity/summary` pro-rates to the last 7 days (P11-T4).
     */
    const plan = summaryPlan({
      goal, month: day.month, throughLastMonthMinor: through?.minor ?? null, thisMonthMinor: thisMonth?.minor ?? null,
    });
    const annual = plan.annualTargetMinor;
    const monthlyTarget = plan.monthlyTargetMinor;
    // A year made before this month began: the month needs nothing more (ADR-0047), which is not *no target*.
    const monthly = monthlyTarget === 0
      ? madeFigures(thisMonth?.minor ?? null)
      : periodFigures(monthlyTarget, thisMonth?.minor ?? null, goal.caseSizeMinor);
    const yearly = periodFigures(annual, goal.achieved.minor, goal.caseSizeMinor);

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

    const mapping = goal.cascadeMapping;
    const cascadeCodes = [mapping.leadsCode, mapping.appointmentsCode, mapping.closingsCode];
    const activityFor = (
      window: { from: LocalDate; to: LocalDate }, logged: Map<string, number>, plan: typeof monthlyCounts,
    ): SummaryActivity => ({
      ...window,
      targets: activityTargets(plan, mapping, logged),
      total: totalLogged(logged),
      sections: sectionChips(sections, logged, cascadeCodes),
    });

    /*
     * **The prototype's sentence, by the prototype's arithmetic** (ADR-0109): *N* the closings of the last
     * 30 days, *M* the closings chip's target, *K* the policies this month's APE gap still needs over the
     * weeks left. A closing target exists only with a monthly target and a case size, so both are here.
     */
    const pace = closingTarget === null || monthlyTarget === null ? null : paceFor({
      closingTarget,
      closingsLast30Days: recentCounts.get(mapping.closingsCode) ?? 0,
      dayOfMonth: Number(day.today.slice(8, 10)),
      daysInMonth: Number(endOfMonth(day.today).slice(8, 10)),
      apeTargetMinor: monthlyTarget,
      apeProducedMinor: thisMonth?.minor ?? null,
      caseSizeMinor: goal.caseSizeMinor,
      apeTargetMet: monthly.targetMet || yearly.targetMet,
    });

    const view: SummaryView = {
      year,
      month: day.month,
      today: day.today,
      goal: { set, savedAt: goal.savedAt },
      caseSizeMinor: goal.caseSizeMinor,
      monthly: { ...monthly, source: thisMonth ? { provenance: thisMonth.provenance, month: thisMonth.month } : null },
      yearly: { ...yearly, source: { provenance: goal.achieved.provenance, month: goal.achieved.month } },
      pace,
      activity: {
        monthly: activityFor(monthWindow, counts, monthlyCounts),
        yearly: activityFor(yearWindow, yearCounts, yearlyCounts),
      },
      leads: { rows: showsLeads ? openLeads.slice(0, SUMMARY.LEADS_SHOWN) : [], total: openLeads.length },
      insights: insightsFor({
        compliance: { compliant: compliance.compliant7d, windowDays: compliance.windowDays, lastLoggedOn: compliance.lastLoggedOn },
        pace,
        leads: openLeads,
        ratios: ratios.ratios,
      }).filter((i) => showsLeads || (i.rule !== 'LEAD_OVERDUE' && i.rule !== 'LEAD_NEGLECTED')),
    };

    return view;
  }
}
