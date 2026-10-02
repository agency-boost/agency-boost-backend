import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { coached30d, coached7d, daysSinceLastCoaching } from '@/domain/metrics/coaching-recency';
import { CoachingSessionRepository } from './coaching-session.repository';

/** A coachee's latest 1:1: the session, its day, and who led it. */
export interface LastOneOnOne {
  sessionId: string;
  /** The office's day of that session's first finalize (ADR-0079). */
  date: LocalDate;
  coachMembershipId: string;
}

/** The coaching metrics of one coachee, as of the office's today (§A.3). */
export interface CoachingRecency {
  last: LastOneOnOne | null;
  /** `DAYS_SINCE_LAST_COACHING`: `null` is *No 1:1 yet*. */
  daysSinceLastCoaching: number | null;
  /** `COACHED_7D`. */
  coached7d: boolean;
  /** `COACHED_30D`. */
  coached30d: boolean;
}

/**
 * **What counts as a 1:1** for every coaching metric: a session finalized at least once — `finalized`, or
 * `reopened` while a correction is open, which keeps counting from its `date` (ADR-0079). A draft has no
 * `date` and is excluded twice over, by its status and by the date it does not have.
 */
const COUNTED = { status: { $in: ['finalized', 'reopened'] }, date: { $ne: null } } as const;

/**
 * **Coaching sessions, as the metrics read them** (P11-T5 AC-8) — the seam `ProductionReadings` and
 * `ActivityReadings` are for their modules. The roster asks here, and so will the Unit Dashboard's
 * *Last 1:1* and `COACHING_COVERAGE` when they are served.
 *
 * **Sessions only.** `DAYS_SINCE_LAST_COACHING` is never reset by a self-logged `DEV_COACHING_RECEIVED`:
 * that is the member's own report of activity, and it belongs to compliance, not to coaching coverage
 * (§A.3's notes). Nothing here reads `activityLogs`.
 */
@Injectable()
export class CoachingReadings {
  constructor(
    private readonly sessions: CoachingSessionRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * Each coachee's latest 1:1: the newest `date` among their sessions finalized at least once, then the
   * latest `frozenAt` on the same day — **one aggregate for the whole list**, on the
   * `(kpmId, coacheeMembershipId, date, frozenAt)` index. A coachee with none is absent from the map.
   */
  async lastOneOnOnes(ctx: RequestContext, coacheeIds: readonly string[]): Promise<Map<string, LastOneOnOne>> {
    if (coacheeIds.length === 0) return new Map();
    const rows = await this.sessions.aggregate(ctx, [
      { $match: { coacheeMembershipId: { $in: [...new Set(coacheeIds)] }, ...COUNTED } },
      { $sort: { coacheeMembershipId: 1, date: -1, frozenAt: -1 } },
      {
        $group: {
          _id: '$coacheeMembershipId',
          sessionId: { $first: '$_id' },
          date: { $first: '$date' },
          coachMembershipId: { $first: '$coachMembershipId' },
        },
      },
    ]);
    return new Map(rows.map((row) => [String(row._id), {
      sessionId: String(row.sessionId),
      date: row.date as LocalDate,
      coachMembershipId: row.coachMembershipId as string,
    }]));
  }

  /**
   * `DAYS_SINCE_LAST_COACHING`, `COACHED_7D` and `COACHED_30D` for each coachee, **in the office's
   * calendar** (invariant §9): whole days by `Clock.daysBetween` in the office's zone, from the latest
   * 1:1's `date` to the office's today. Every id asked about gets an entry.
   */
  async recencyOf(
    ctx: RequestContext,
    coacheeIds: readonly string[],
    day: { today: LocalDate; timezone: string },
  ): Promise<Map<string, CoachingRecency>> {
    const last = await this.lastOneOnOnes(ctx, coacheeIds);
    const between = (from: string, to: string) => this.clock.daysBetween(day.timezone, from, to);
    return new Map(coacheeIds.map((id) => {
      const latest = last.get(id) ?? null;
      const days = daysSinceLastCoaching(latest?.date ?? null, day.today, between);
      return [id, { last: latest, daysSinceLastCoaching: days, coached7d: coached7d(days), coached30d: coached30d(days) }];
    }));
  }
}
