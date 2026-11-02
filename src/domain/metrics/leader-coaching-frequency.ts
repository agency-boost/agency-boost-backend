import { coachedWithin } from './coaching-recency';
import { rateOver } from './rate';

/**
 * `LEADER_COACHING_FREQUENCY` (`metrics-and-definitions.md` §A.3; Phase 18, D-coverage) — the Overview's *AB
 * coaching frequency*: *"{name} · {n} in team … {c}/{n} · {p}%"* (`KPM_Owner.html:1024-1042`).
 *
 * **Did this leader do the coaching**: the distinct members of their downline whom **they** led a 1:1 with
 * inside the window, over the downline's size. Distinct coachees, not sessions — coaching one person three
 * times is coverage of one person. Coached by somebody else does not count here (that is `COACHING_COVERAGE`).
 * A 1:1 counts as every coaching metric counts one (`coaching-recency.ts`): finalized at least once, by its
 * `date`, the office's day of its first finalize, `coachedWithin` the window — so `ROLLING_7D` spans today and
 * the seven days before it, as `COACHED_7D` does.
 *
 * Pure. `null` over a downline of nobody, never 0% (roles §6.11). The share is a whole percent rounded half up **in
 * integers** (`rateOver`; P18.97-T3, parity F-254): 23 of 40 is 58%, which `Math.round(23 / 40 * 100)` read 57.
 * *Amended 2026-10-28 (P18.97-T3 AC-5; ADR-0176 §2, UI-017):* the leaderboard lists **every** AB, so an AB who leads
 * nobody is a row — *No team*, its `null` drawn as no rate — where it used to be left out.
 */
export interface FrequencySession {
  coachMembershipId: string;
  coacheeMembershipId: string;
  status: 'draft' | 'finalized' | 'reopened';
  date: string | null;
}

export function leaderCoachingFrequency(input: {
  leaderMembershipId: string;
  /** Everybody below the leader now, at any depth. */
  downline: readonly string[];
  sessions: readonly FrequencySession[];
  windowDays: number;
  today: string;
  /** Whole days between two office dates, in the office's calendar. */
  daysBetween: (from: string, to: string) => number;
}): { teamSize: number; coached: number; pct: number | null } {
  const team = new Set(input.downline);
  team.delete(input.leaderMembershipId);
  const coached = new Set<string>();
  for (const session of input.sessions) {
    if (session.coachMembershipId !== input.leaderMembershipId) continue;
    if (session.status === 'draft' || session.date === null) continue;
    if (!team.has(session.coacheeMembershipId)) continue;
    if (!coachedWithin(input.daysBetween(session.date, input.today), input.windowDays)) continue;
    coached.add(session.coacheeMembershipId);
  }
  return {
    teamSize: team.size,
    coached: coached.size,
    pct: rateOver(coached.size, team.size).pct,
  };
}
