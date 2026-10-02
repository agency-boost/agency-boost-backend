import { COACHING } from '@/domain/constants';
import { coachedWithin, daysSinceLastCoaching } from './coaching-recency';

/**
 * `COACHING_COVERAGE` (`metrics-and-definitions.md` §A.3, P11-T10 AC-5): the share of the members in a
 * scope who were coached inside the window.
 *
 * **The formula is the definition**: `count(members where COACHED_nD) / count(members in scope)`, rounded
 * to a whole percent, read once for each window of `COACHING_COVERAGE_WINDOWS` (§B.4) — `COACHED_7D`, the
 * primary, then `COACHED_30D`. `COACHED_nD` is `coaching-recency.ts`'s, over `DAYS_SINCE_LAST_COACHING`,
 * so every rule that metric carries holds here without being restated:
 *
 * - **only a session finalized at least once counts** — `finalized`, or `reopened` while a correction is
 *   open — by its `date`, the office's day of its first finalize, which nothing moves (ADR-0079). A draft
 *   has no `date` and never counts; a self-logged `DEV_COACHING_RECEIVED` is activity, never a session,
 *   and never reaches here;
 * - **by anyone**: a member coached by a leader outside the scope, or by one who has since left, was
 *   coached. *Did this leader do the coaching* is `LEADER_COACHING_FREQUENCY`, a different metric;
 * - **in the office's calendar**: `daysBetween` is `Clock.daysBetween` in the office's zone (invariant §9).
 *
 * **The denominator is the scope less its leader** — a leader never coaches themselves (§A.3's notes,
 * `KPM_Owner.html:3341`'s `coached / team`). `leaderMembershipId` is `null` for a scope with no leader in
 * it, the Owner's office-wide figure. **A scope of nobody is `null`, never 0% and never a division by
 * zero** (`KPM_Owner.html:3341` divides by `team` unguarded): there is no share of nobody.
 *
 * Pure: records in, figures out. No route serves it in this phase (P18-T1 does, and P18-T6 reconciles it
 * with the Owner's number); `coaching-coverage.spec.ts` pins it to the definition.
 */

/** A session as coverage reads one: whose it is, and whether and when it counts. */
export interface CoverageSession {
  coacheeMembershipId: string;
  status: 'draft' | 'finalized' | 'reopened';
  /** The office's day of its first finalize, `YYYY-MM-DD`; `null` until then. */
  date: string | null;
}

/** `COACHING_COVERAGE` over one window. */
export interface CoachingCoverage {
  /** The window, in days: part of the label, always (*Coached in last 7 days*). */
  windowDays: number;
  /** Members of the scope, less its leader, with `COACHED_nD`. */
  coached: number;
  /** Members of the scope, less its leader. */
  members: number;
  /** `coached / members`, a whole percent, rounded half up as the prototype rounds; `null` for nobody. */
  pct: number | null;
}

/** Finalized at least once: the statuses every coaching metric counts. */
const COUNTED = new Set<CoverageSession['status']>(['finalized', 'reopened']);

/** Each member's latest 1:1: the newest `date` among their sessions finalized at least once. */
function latestDates(sessions: readonly CoverageSession[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const session of sessions) {
    if (!COUNTED.has(session.status) || session.date === null) continue;
    const seen = latest.get(session.coacheeMembershipId);
    if (seen === undefined || session.date > seen) latest.set(session.coacheeMembershipId, session.date);
  }
  return latest;
}

export function coachingCoverage(input: {
  /** The members in the scope, by membership id: a leader's downline, or the office. */
  scope: readonly string[];
  /** The scope's leader, left out of the denominator; `null` when the scope has none. */
  leaderMembershipId: string | null;
  /** Sessions about the scope's members. Anybody else's are ignored, drafts and the leader's own included. */
  sessions: readonly CoverageSession[];
  /** The office's today, `YYYY-MM-DD`. */
  today: string;
  /** Whole days between two office dates, in the office's calendar. */
  daysBetween: (from: string, to: string) => number;
}): CoachingCoverage[] {
  const members = [...new Set(input.scope)].filter((id) => id !== input.leaderMembershipId);
  const latest = latestDates(input.sessions);
  const daysSince = members.map((id) => daysSinceLastCoaching(latest.get(id) ?? null, input.today, input.daysBetween));

  return COACHING.COVERAGE_WINDOWS.map((windowDays) => {
    const coached = daysSince.filter((days) => coachedWithin(days, windowDays)).length;
    return {
      windowDays,
      coached,
      members: members.length,
      pct: members.length === 0 ? null : Math.round((coached / members.length) * 100),
    };
  });
}
