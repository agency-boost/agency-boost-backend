import { Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { rollingWindow, type LocalDate } from '@/common/time/local-day';
import { PERFORMANCE, SUMMARY } from '@/domain/constants';
import { goalPaceStatus, type GoalPaceStatus } from '@/domain/metrics/goal-pace-status';
import { pacingToMaa } from '@/domain/metrics/pacing-to-maa';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { cascadeCounts, computeCascade } from '@/modules/goals/goal-cascade';
import { GoalRepository } from '@/modules/goals/goal.repository';
import type { Goal } from '@/modules/goals/goal.schema';
import { OfficialApe } from '@/modules/production/official-ape';
import type { MonthStanding } from '@/modules/production/production-readings';
import { monthlyApeTarget, ytdBeforeThisMonth } from '@/modules/summary/summary-figures';
import { boundCodes, countOf, defaultBinding, type CascadeBinding } from '@/modules/config/activity-binding';
import { ActivityBindingService } from '@/modules/config/activity-binding.service';

/**
 * What a stored goal contributes to the month: its plan and its own APE figure. **Not its codes**: what each
 * cascade role counts is the office's binding (ADR-0163 §4), handed in beside it.
 */
export type GoalPlan = Pick<
  Goal,
  | 'savedAt' | 'mode' | 'annualApeTargetMinor' | 'savingsTargetMinor' | 'commissionRatePct' | 'apeAchievedMinor'
  | 'caseSizeMinor' | 'leadsToApptPct' | 'closingRatePct'
>;

/** A member's calendar month, as the roster reads it. */
export interface MonthPace {
  /** `GOAL_PACE_STATUS`. */
  status: GoalPaceStatus;
  /** `PACING_TO_MAA`; `null` with no target, when nothing can be projected (ADR-0080). */
  pacingToMaa: boolean | null;
  /** `MONTHLY_APE_TARGET`; `null` with no target. */
  monthlyTargetMinor: number | null;
}

/**
 * The annual target a stored goal plans for — **as the Summary reads it**: the cascade's resolved
 * target, or `null` when the goal's stored assumptions cannot make a plan (a zero case size, a savings
 * plan with no commission rate). `monthsLeft` and the APE achieved do not move the annual target, so
 * the cascade is asked with neutral ones.
 */
function plannedAnnualTarget(goal: GoalPlan): number | null {
  try {
    return computeCascade({
      mode: goal.mode,
      annualApeTargetMinor: goal.annualApeTargetMinor,
      savingsTargetMinor: goal.savingsTargetMinor,
      commissionRatePct: goal.commissionRatePct,
      monthsLeft: 1,
      apeAchievedMinor: 0,
      caseSizeMinor: goal.caseSizeMinor,
      leadsToApptPct: goal.leadsToApptPct,
      closingRatePct: goal.closingRatePct,
    }).annualApeTargetMinor;
  } catch {
    return null;
  }
}

/**
 * **One member's month: `GOAL_PACE_STATUS` over `PACING_TO_MAA`** (P11-T6 AC-4, ADR-0080), from the
 * rows the readings fetched. Pure, so every branch is a unit test.
 *
 * **The Summary's *Monthly* figures, step for step** (`SummaryService.read`, ADR-0056): no target is no
 * goal saved for the year, an unusable plan, or an annual target of zero; this month's target is
 * `MONTHLY_APE_TARGET`, taken from the year to date through last month; its activity targets are
 * `SUMMARY_ACTIVITY_TARGET`, the cascade on that target at the goal's own rates; and the month's count is
 * the member's on the codes the office binds to the three cascade roles (ADR-0163 §4). The tenancy spec holds the roster and the Summary to
 * the same monthly target for the same person, so the two cannot drift apart.
 */
export function monthPaceOf(input: {
  goal: GoalPlan | null;
  standing: MonthStanding;
  /** The member's counts this calendar month, by activity code. */
  counts: ReadonlyMap<string, number>;
  /**
   * The member's counts over the last `SUMMARY.PACE_WINDOW_DAYS`, today included, by activity code: what
   * the Summary's pace sentence says they are *tracking to close* (OD-110, ADR-0109).
   */
  recentCounts: ReadonlyMap<string, number>;
  /** The office's month, `YYYY-MM`. */
  month: string;
  onTrackRatio: number;
  /** Which activity types each cascade role counts: the office's binding (ADR-0163 §4). */
  binding: CascadeBinding;
}): MonthPace {
  const { goal, standing, counts, recentCounts, month, onTrackRatio, binding } = input;
  // An unsaved default is an offer, not a goal, as the Summary says: it measures nobody.
  const planned = goal && goal.savedAt !== null ? plannedAnnualTarget(goal) : null;
  if (goal === null || planned === null || planned <= 0) {
    return { status: goalPaceStatus({ month: null, onTrackRatio }), pacingToMaa: null, monthlyTargetMinor: null };
  }

  const monthNumber = Number(month.slice(5, 7));
  const before = ytdBeforeThisMonth({
    month: monthNumber,
    throughLastMonthMinor: standing.throughLastMonth?.minor ?? null,
    // This month's own year to date is what the goal reads when it is the latest the office holds.
    thisMonth: standing.thisMonth && standing.yearToDate?.month === month
      ? { ytdMinor: standing.yearToDate.minor, monthlyMinor: standing.thisMonth.minor } : null,
    /*
     * **The office's figures alone** (ADR-0195; P19.1-T4 AC-12, UI-157 item 5): the roster's status is a leader's
     * screen, so a member's own estimate fixes no target here. It stood in, while the office held no year to date,
     * until November 2026 (P9-T6); the member's own Summary still takes it (`summaryPlan`).
     */
    ownFigureMinor: null,
  });
  const targetMinor = monthlyApeTarget(planned, before, monthNumber);
  const plan = cascadeCounts(targetMinor, goal);

  /*
   * **OD-109, option 2 (decided 2026-10-02): a year already met asks for one policy.** This month's target
   * is zero, so its cascade is zero and would project nothing whatever the member logged. The gate is
   * asked against what one policy takes at the goal's own rates instead — the cascade run on
   * `MAA_PROJECTED_SUBMISSIONS_MIN` cases — which is what *at least one policy* means (§B.4).
   */
  const gate = targetMinor > 0
    ? plan
    : cascadeCounts(goal.caseSizeMinor * PERFORMANCE.MAA_PROJECTED_SUBMISSIONS_MIN, goal);

  // Every code the office binds, summed: a role bound to `[A, B]` counts both (ADR-0163 §4).
  const logged = countOf(counts, boundCodes(binding));
  const pacing = pacingToMaa({
    targets: { leads: gate.leads, appointments: gate.appointments, closings: gate.policies }, logged,
  });

  /*
   * **OD-110, option 3 (decided 2026-10-02): until this month's file lands, the pace is the activity's** —
   * the Summary's own pace sentence, so the roster and the coachee's Summary say the same thing about the
   * same person: its *tracking to close N*, the closings of the last 30 days, over its *target of M*, this
   * month's closing target. *Amended 2026-10-07 (ADR-0109): N was ADR-0057's run-rate, with no answer
   * before the 7th; the sentence now counts the last 30 days, and has an answer every day.*
   */
  const apeMinor = standing.thisMonth?.minor ?? null;
  const closings = apeMinor !== null ? null : { last30Days: countOf(recentCounts, binding.closings), target: plan.policies };

  return {
    status: goalPaceStatus({ month: { targetMinor, apeMinor, pacing, closings }, onTrackRatio }),
    pacingToMaa: pacing,
    monthlyTargetMinor: targetMinor,
  };
}

/**
 * **`GOAL_PACE_STATUS` for many members at once** (P11-T6 AC-4, AC-9): the goals for the office's year,
 * the year's production, the month's activity and the last 30 days' (ADR-0109), **four queries for the
 * whole list** whatever its length, then `monthPaceOf` per member. Served first by the coaching roster; the Unit Dashboard's
 * *Status* (Phase 15) is the same metric.
 *
 * The counts it reads stay here: the roster answers a verdict per person, never a figure (AC-6).
 */
@Injectable()
export class PaceStatusReadings {
  constructor(
    private readonly goals: GoalRepository,
    private readonly production: OfficialApe,
    private readonly activity: ActivityReadings,
    /*
     * ADR-0163 §4: which activity types each cascade role counts — the office's binding, the one reader. Optional,
     * the token named (a `X | null` parameter is emitted as `Object`), and without it the default binding.
     */
    @Optional() @Inject(ActivityBindingService) private readonly bindings: ActivityBindingService | null = null,
  ) {}

  async paceOf(
    ctx: RequestContext,
    membershipIds: readonly string[],
    office: { today: LocalDate; month: string; onTrackRatio: number },
  ): Promise<Map<string, MonthPace>> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return new Map();
    const [goals, standings, counts, recent, binding] = await Promise.all([
      this.goals.find(ctx, { membershipId: { $in: ids }, period: office.month.slice(0, 4) }),
      this.production.standingsFor(ctx, ids, office.month),
      // The calendar month so far: no day after today can hold a log (ADR-0042).
      this.activity.countsOverMany(ctx, ids, { from: `${office.month}-01` as LocalDate, to: office.today }),
      // The pace sentence's last 30 days, the office's, as the Summary counts them (ADR-0109).
      this.activity.countsOverMany(ctx, ids, rollingWindow(office.today, SUMMARY.PACE_WINDOW_DAYS)),
      this.bindings ? this.bindings.resolveCascadeBinding(ctx) : Promise.resolve(defaultBinding()),
    ]);
    const goalOf = new Map(goals.map((goal) => [goal.membershipId, goal]));
    return new Map(ids.map((id) => [id, monthPaceOf({
      goal: goalOf.get(id) ?? null,
      standing: standings.get(id) as MonthStanding,
      counts: counts.get(id) ?? new Map(),
      recentCounts: recent.get(id) ?? new Map(),
      month: office.month,
      onTrackRatio: office.onTrackRatio,
      binding,
    })]));
  }
}
