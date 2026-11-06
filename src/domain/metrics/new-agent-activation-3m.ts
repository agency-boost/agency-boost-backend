import type { LocalDate } from '@/common/time/local-day';
import { NEW_AGENT_ACTIVATION_MONTHS_AFTER_JOIN } from '@/domain/constants/leader-forum';
import { rateOver } from './rate';

/**
 * **`NEW_AGENT_ACTIVATION_3M_PCT` — *3M new agent %*, the forum's row** (P19.3-T1; ADR-0202 §1, the owner's data
 * sources of 3 November, D7 *"A new agent counts as activated if they have their first policy in the join month or the 3
 * months after. The same rule applies in SLF and Quant B1"*; `metrics-and-definitions.md` §A.14).
 *
 * **Not `ACTIVATION_3M_PCT`** (`activation-3m.ts`), which New Hires, Home and the Unit Dashboard keep: a first paid and
 * issued case by day 90 of the join date, decided the day of the sale (ADR-0171, ADR-0180 §6). This one reads **the
 * office's file, month by month**: a policy in the join month or the `NEW_AGENT_ACTIVATION_MONTHS_AFTER_JOIN` calendar
 * months after it. One person can be activated on one and not yet on the other; each has its own name (invariant §8).
 *
 * - **Who**: the office's new hires (`joinedAs = new_hire`, ADR-0169), removed or not, whose join date is in the period
 *   — the caller's set. A leaving decides nothing by itself.
 * - **Activated**: some month of the window the file holds shows **policies > 0** for them (`policyCountMonthly`).
 *   APE alone does not activate: D7 says *policy*.
 * - **Not activated**: every month of the window is held, and none shows a policy for them. A held month with no row of
 *   theirs, or a row with no policy count, shows none.
 * - **Undecided**: neither — a window month not held yet, and no policy in the months that are. Left out of both parts
 *   until decided (ADR-0180 §6's rule A).
 *
 * **A month is held for this metric when the office's file holds a policy count for it** — the column D7 reads — so a
 * file carrying APE and no policy count (ADR-0051) decides nobody. Pure: the caller reads the file once.
 */

/** A new hire's D7 result. */
export const NEW_AGENT_ACTIVATION_RESULTS = ['activated', 'not_activated', 'undecided'] as const;
export type NewAgentActivationResult = (typeof NEW_AGENT_ACTIVATION_RESULTS)[number];

/** `YYYY-MM` plus a number of calendar months. */
function plusMonths(month: string, months: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * **The window**: the join month and the `NEW_AGENT_ACTIVATION_MONTHS_AFTER_JOIN` calendar months after it, `YYYY-MM`,
 * in the office's calendar — four months. Joined 31 January: January to April.
 */
export function newAgentActivationWindow(joinDate: LocalDate): string[] {
  const first = joinDate.slice(0, 7);
  return Array.from({ length: NEW_AGENT_ACTIVATION_MONTHS_AFTER_JOIN + 1 }, (_, i) => plusMonths(first, i));
}

/** One month of the window, as the file stands: whether it is held, and the hire's policies in it (`null` none). */
export interface WindowMonth {
  held: boolean;
  policies: number | null;
}

/** **One new hire's D7 result**, given each window month as the file holds it. */
export function newAgentActivationOf(joinDate: LocalDate, monthOf: (month: string) => WindowMonth): NewAgentActivationResult {
  const months = newAgentActivationWindow(joinDate).map(monthOf);
  if (months.some((m) => m.held && m.policies !== null && m.policies > 0)) return 'activated';
  return months.every((m) => m.held) ? 'not_activated' : 'undecided';
}

/** **`NEW_AGENT_ACTIVATION_3M_PCT` over a set of new hires**: how many of each, and the share. */
export interface NewAgentActivationShare {
  activated: number;
  notActivated: number;
  /** Not decided yet: in neither part. */
  undecided: number;
  /** `activated ÷ (activated + not activated)`, a whole percent, half up (`rateOver`); `null` while nobody is decided. */
  pct: number | null;
}

export function newAgentActivationShare(results: readonly NewAgentActivationResult[]): NewAgentActivationShare {
  const activated = results.filter((r) => r === 'activated').length;
  const notActivated = results.filter((r) => r === 'not_activated').length;
  return {
    activated,
    notActivated,
    undecided: results.length - activated - notActivated,
    pct: rateOver(activated, activated + notActivated).pct,
  };
}
