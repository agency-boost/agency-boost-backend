import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException } from '@/common/errors/domain.exception';
import { endOfMonth, type LocalDate } from '@/common/time/local-day';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { cascadeCounts } from '@/modules/goals/goal-cascade';
import { GoalService } from '@/modules/goals/goal.service';
import { ProductionReadings } from '@/modules/production/production-readings';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import {
  activityTargets, madeFigures, monthlyApeTarget, paceFor, periodFigures, sectionChips, totalLogged,
  ytdBeforeThisMonth, type ActivityTarget, type Pace, type PeriodFigures, type SectionChip,
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
  /** One per other section the reader is shown. */
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
  /** The pace sentence (ADR-0057); `null` without a goal. */
  pace: Pace | null;
  /** What was logged against the plan, and the rest of the reader's sections (P10-T5). */
  activity: { monthly: SummaryActivity; yearly: SummaryActivity };
}

/**
 * The Personal Summary (P10-T4): one page, first-person, read from what other modules hold — the goal,
 * the office's production, the member's own log. Nothing is written here, and nothing is stored.
 *
 * **Your own, only.** `personal_summary:read` reaches further on the matrix, and a leader's view of a
 * downline's Summary is Phase 13's coaching copy; this route takes no subject.
 */
@Injectable()
export class SummaryService {
  constructor(
    private readonly goals: GoalService,
    private readonly production: ProductionReadings,
    private readonly activity: ActivityReadings,
    private readonly days: TenantDay,
  ) {}

  async read(ctx: RequestContext): Promise<SummaryView> {
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();
    const day = await this.days.for(ctx);
    const year = day.today.slice(0, 4);
    const monthNumber = Number(day.month.slice(5, 7));
    const previous = monthNumber === 1 ? null : `${year}-${String(monthNumber - 1).padStart(2, '0')}`;

    const goal = await this.goals.readOrDefaults(ctx, year);
    // An unsaved default is an offer, not a goal: the Summary measures nobody against a plan they never made.
    const set = goal.savedAt !== null;
    /*
     * **No target is no target**: a saved goal of zero — which the goal form allows — or one whose stored
     * assumptions cannot produce a plan measures nothing, and gets no pace against *a target of 0*.
     */
    const planned = goal.projected?.annualApeTargetMinor ?? 0;
    const annual = set && planned > 0 ? planned : null;

    const monthWindow = { from: `${day.month}-01` as LocalDate, to: day.today };
    const yearWindow = { from: `${year}-01-01` as LocalDate, to: day.today };
    const [through, thisMonth, counts, yearCounts, sections] = await Promise.all([
      previous ? this.production.apeYearToDateThrough(ctx, me, previous) : Promise.resolve(null),
      this.production.apeForMonth(ctx, me, day.month),
      this.activity.countsOver(ctx, me, monthWindow),
      this.activity.countsOver(ctx, me, yearWindow),
      this.activity.sectionsShown(ctx, ctx.membership?.orgLevelCode ?? ''),
    ]);

    const before = ytdBeforeThisMonth({
      month: monthNumber,
      throughLastMonthMinor: through?.minor ?? null,
      // This month's own year to date is what the goal already reads when it is the latest the office holds.
      thisMonth: thisMonth && goal.achieved.month === day.month
        ? { ytdMinor: goal.achieved.minor, monthlyMinor: thisMonth.minor } : null,
      ownFigureMinor: goal.achieved.provenance === 'self_reported' ? goal.achieved.minor : null,
    });
    const monthlyTarget = annual !== null ? monthlyApeTarget(annual, before, monthNumber) : null;
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
    const rates = goal.caseSizeMinor > 0 ? goal : null;
    const monthlyCounts = monthlyTarget !== null && rates ? cascadeCounts(monthlyTarget, rates) : null;
    const yearlyCounts = annual !== null && rates ? cascadeCounts(annual, rates) : null;
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

    return {
      year,
      month: day.month,
      today: day.today,
      goal: { set, savedAt: goal.savedAt },
      caseSizeMinor: goal.caseSizeMinor,
      monthly: { ...monthly, source: thisMonth ? { provenance: thisMonth.provenance, month: thisMonth.month } : null },
      yearly: { ...yearly, source: { provenance: goal.achieved.provenance, month: goal.achieved.month } },
      pace: closingTarget === null ? null : paceFor({
        closingTarget,
        closingsLogged: counts.get(mapping.closingsCode) ?? 0,
        dayOfMonth: Number(day.today.slice(8, 10)),
        daysInMonth: Number(endOfMonth(day.today).slice(8, 10)),
        apeTargetMet: monthly.targetMet || yearly.targetMet,
      }),
      activity: {
        monthly: activityFor(monthWindow, counts, monthlyCounts),
        yearly: activityFor(yearWindow, yearCounts, yearlyCounts),
      },
    };
  }
}
