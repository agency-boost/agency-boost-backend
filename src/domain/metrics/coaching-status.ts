import { COACHING_STATUS, type CoachingStatus } from '@/domain/constants/coaching-status';

/**
 * **`COACHING_STATUS` — the coaching status tile, per person** (`metrics-and-definitions.md` §A.3; ADR-0267 §5;
 * `revisions/2026-11-19/DATA-DEFINITIONS.md`, *Coaching*): red ***Belum pernah coaching*** with no 1-on-1 ever, green
 * ***Coaching n hari lalu*** while the latest is at most `COACHING_STATUS.RECENT_MAX_DAYS` (14) days old, yellow after.
 *
 * **One input, `DAYS_SINCE_LAST_COACHING`** (`coaching-recency.ts`): whole days from the latest 1-on-1 — a session
 * finalized at least once, by its `date` (ADR-0079) — to the office's today, `null` with none. So it counts what every
 * coaching metric counts, and a self-logged `DEV_COACHING_RECEIVED` never resets it.
 *
 * **Not the roster's *overdue*** (`oneOnOneOverdue`, `> 7` at the default `COACHING_OVERDUE_DAYS`): a different named
 * metric over the same input, kept apart so neither page redefines the other (invariant §8). A member 10 days from their
 * 1-on-1 is overdue on the coaching roster and green here; both are right about what they say.
 */
export function coachingStatus(daysSinceLastCoaching: number | null): CoachingStatus {
  if (daysSinceLastCoaching === null) return 'never';
  return daysSinceLastCoaching <= COACHING_STATUS.RECENT_MAX_DAYS ? 'recent' : 'lapsed';
}
