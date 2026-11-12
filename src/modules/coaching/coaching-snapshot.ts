import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DEFAULT_CURRENCY } from '@/domain/constants';
import { ActivityService } from '@/modules/activity/activity.service';
import { GoalRepository } from '@/modules/goals/goal.repository';
import type { Subject } from '@/modules/org/coach-resolver';
import { SummaryService } from '@/modules/summary/summary.service';
import type { PeriodFigures } from '@/modules/summary/summary-figures';
import type {
  CoachingSnapshot, SnapshotActivity, SnapshotGoal, SnapshotPeriodFigures, SnapshotRatios,
} from './coaching-session.schema';

/** One period's figures as the snapshot keeps them: the five the Goal card and the print read. */
function periodOf(figures: PeriodFigures): SnapshotPeriodFigures {
  return {
    targetMinor: figures.targetMinor,
    actualMinor: figures.actualMinor,
    attainmentPct: figures.attainmentPct,
    gapMinor: figures.gapMinor,
    targetMet: figures.targetMet,
  };
}

/**
 * **What the 1:1 looked at, frozen at the first finalize** (P11-T5 AC-4; `functional/coaching.md`, *The
 * snapshot*; `erd.md`, `coachingSessions.snapshot`).
 *
 * Three figure groups, each **from the read the live card makes, through that service's subject-taking
 * internal** — never a second calculation of any of them:
 *
 * - **The goal**: `GET /summary?for=`'s monthly and yearly figures (`SummaryService.of`) — this month's
 *   and this year's target, the APE produced, the attainment and the gap, `null` wherever the Summary has
 *   none (*Not uploaded yet*, *No goal set*), never a 0 in their place — with **the produced figure's
 *   source** (imported, corrected or self-reported, as of which month) and the goal's version and who
 *   saved it.
 * - **The ratios**: `GET /activity/ratios?for=`'s, on the coachee's rung over the last 30 days
 *   (`ActivityService.ratiosOf`) — with a balance's two `sides`, so the record can say which way it leaned
 *   as the live card does.
 * - **The activity**: `GET /activity/summary`'s 7-day read for the coachee — the three cascade codes
 *   against their pro-rated targets (`SUB_PERIOD_ACTIVITY_TARGET`) and the section breakdown.
 *
 * **No audit entry per figure.** The internals write none; finalize writes its own entries
 * (`coaching_session.finalized` and the session read's §3.5 entry), so one finalize is one record of
 * what it disclosed. Labels are copied beside the codes, because an office may rename a type or a ratio
 * later and the record keeps the words it showed that day.
 *
 * **As of the clock's now**, in the office's calendar: finalize builds it at the moment of the first
 * finalize, and the seed's backfill builds a fixture session's at its own `frozenAt`. Nothing here is a
 * leader note, and nothing could be: no input carries one.
 */
@Injectable()
export class CoachingSnapshotBuilder {
  constructor(
    private readonly summary: SummaryService,
    private readonly activity: ActivityService,
    private readonly goals: GoalRepository,
    private readonly clock: Clock,
  ) {}

  async build(ctx: RequestContext, subject: Subject): Promise<CoachingSnapshot> {
    const takenAt = this.clock.now();
    const [summary, ratios, week] = await Promise.all([
      // The office's figures (P19.11-T4): a member's typed month APE never enters a leader's frozen record.
      this.summary.of(ctx, subject, {}, { official: true }),
      this.activity.ratiosOf(ctx, subject),
      this.activity.weekOf(ctx, subject),
    ]);
    const saved = summary.goal.set
      ? await this.goals.findOne(ctx, { membershipId: subject.membershipId, period: summary.year })
      : null;

    const goal: SnapshotGoal = {
      period: summary.year,
      month: summary.month,
      currency: DEFAULT_CURRENCY,
      monthly: periodOf(summary.monthly),
      yearly: periodOf(summary.yearly),
      // The APE produced is the year to date's figure, and this is whose it is and as of which month.
      source: { provenance: summary.yearly.source.provenance, month: summary.yearly.source.month },
      savedAt: saved?.savedAt ?? null,
      savedByMembershipId: saved?.savedByMembershipId ?? null,
      goalVersion: saved?.version ?? null,
    };

    const ratioRows: SnapshotRatios = {
      from: ratios.from,
      to: ratios.to,
      days: ratios.days,
      rows: ratios.ratios.map((ratio) => ({
        code: ratio.code,
        label: ratio.label,
        comparison: ratio.comparison,
        displayUnit: ratio.displayUnit,
        benchmark: ratio.benchmark,
        value: ratio.value,
        share: ratio.share,
        status: ratio.status,
        // The names the live card leans toward, copied as they read that day; `null` for a rate.
        sides: ratio.sides ? { numerator: ratio.sides.numerator, denominator: ratio.sides.denominator } : null,
      })),
    };

    const activity: SnapshotActivity = {
      from: week.from,
      to: week.to,
      targets: week.targets.map((target) => ({
        key: target.key, code: target.code, logged: target.logged, target: target.target,
      })),
      sections: week.sections.map((section) => ({
        code: section.code,
        label: section.label,
        total: section.total,
        rows: section.rows.map((row) => ({ code: row.code, label: row.label, count: row.count })),
      })),
    };

    return { takenAt, goal, ratios: ratioRows, activity };
  }
}
