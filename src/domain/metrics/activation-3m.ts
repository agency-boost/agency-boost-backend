import { addDays, type LocalDate } from '@/common/time/local-day';
import { ACTIVATION_3M } from '@/domain/constants/joining';
import { rateOver } from './rate';

/**
 * **`ACTIVATION_3M` and `ACTIVATION_3M_PCT`** (ADR-0171 §2, ADR-0173; P18.96-T6 AC-1, AC-2;
 * `metrics-and-definitions.md`, *3M activation*) — whether a new hire's first 90 days ended in a first sale, and the
 * share of new hires whose did. **Defined here once**: `/new-hires`, the lock written on the membership, the Strategic
 * Leader Forum's *3M new agent %* row and the seed all call these. They replace `NEW_AGENT_3M_ACTIVE_PCT`, which read
 * a hire's four calendar months of the production file (retired, ADR-0171 §2).
 *
 * **A new hire's result** (`activation3MOf`), from their join date (day 1), their first sale (`FIRST_SALE_DATE`), the
 * day they were marked left and the office's today, every one an office date (invariant §9):
 *
 * - **left on or before day 90** — decided the day they left: *activated* if their first sale was on or before that
 *   day, else *not activated* (ADR-0171 §2: *"leaving before a first sale is not activated"*);
 * - **otherwise, in progress through day 90**, a first sale or not, then decided: *activated* if the first sale was on
 *   or before day 90, else *not activated*. A sale after day 90 makes them active and does not change it.
 *
 * **Locked once decided.** The membership keeps the decided result (`memberships.activation3M`), and a kept result is
 * the answer from then on, whatever is recorded later — a backdated closing, a production file uploaded late, a join
 * date corrected. Pure: the caller reads the records and keeps the lock (`Activation3MService`).
 */

/** What a new hire's 3M activation is. The screens say *In progress*, *Activated* and *Not activated*. */
export const ACTIVATION_3M_RESULTS = ['in_progress', 'activated', 'not_activated'] as const;
export type Activation3MResult = (typeof ACTIVATION_3M_RESULTS)[number];

/** A decided result: what `memberships.activation3M` keeps. */
export const ACTIVATION_3M_LOCKS = ['activated', 'not_activated'] as const;
export type Activation3MLock = (typeof ACTIVATION_3M_LOCKS)[number];

/** One new hire, as the result reads them. Office dates throughout. */
export interface Activation3MInput {
  /** Day 1. */
  joinDate: LocalDate;
  /** `FIRST_SALE_DATE`; `null` with none. */
  firstSaleDate: LocalDate | null;
  /** The office day they were marked left; `null` while they have not been. */
  leftOn: LocalDate | null;
  /** The result kept on the membership once decided; `null` until then. */
  locked: Activation3MLock | null;
}

const DAY_MS = 86_400_000;
const utc = (date: LocalDate) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

/** **Day 90**: the last day a first sale activates them — the join date plus 89 (`ACTIVATION_3M.DAYS`). */
export function activation3MLastDay(joinDate: LocalDate): LocalDate {
  return addDays(joinDate, ACTIVATION_3M.DAYS - 1);
}

/** **Which day of it today is**: the join date is day 1. Never below 1. */
export function activation3MDay(joinDate: LocalDate, today: LocalDate): number {
  return Math.max(1, Math.round((utc(today) - utc(joinDate)) / DAY_MS) + 1);
}

/** **The result as the records stand**, a kept lock first. */
export function activation3MOf(input: Activation3MInput, today: LocalDate): Activation3MResult {
  return activation3MDecided(input, today) ?? 'in_progress';
}

/**
 * **The result once it is decided, or `null` while it is not** — what a lock writes. A kept lock is decided; so is a
 * new hire who left within the 90 days, on the day they left; anybody else once today is past day 90.
 */
export function activation3MDecided(input: Activation3MInput, today: LocalDate): Activation3MLock | null {
  if (input.locked !== null) return input.locked;
  const lastDay = activation3MLastDay(input.joinDate);
  const soldBy = (day: LocalDate): Activation3MLock =>
    (input.firstSaleDate !== null && input.firstSaleDate <= day ? 'activated' : 'not_activated');
  // A leaving counts from its day: read as of an earlier day — a scorecard frozen before it — it has not happened yet.
  if (input.leftOn !== null && input.leftOn <= lastDay && input.leftOn <= today) return soldBy(input.leftOn);
  if (today > lastDay) return soldBy(lastDay);
  return null;
}

/** Twelve calendar months before an office date, the day clamped to the shorter month: 29 Feb 2028 → 28 Feb 2027. */
function monthsBefore(date: LocalDate, months: number): LocalDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 - months;
  const target = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(Number(date.slice(8, 10)), last));
  return target.toISOString().slice(0, 10);
}

/**
 * **The join dates `/new-hires` lists** (ADR-0173 §1): after the same day `ACTIVATION_3M.WINDOW_MONTHS` months back, to
 * the office's today — `from` is the first day in it. On 27 October 2026, 28 October 2025 to 27 October 2026.
 */
export function newHiresWindow(today: LocalDate): { from: LocalDate; to: LocalDate } {
  return { from: addDays(monthsBefore(today, ACTIVATION_3M.WINDOW_MONTHS), 1), to: today };
}

/** **`ACTIVATION_3M_PCT`** over a set of new hires: how many of each result, and the share. */
export interface Activation3MShare {
  activated: number;
  notActivated: number;
  /** Not in either part of the share: their 90 days are not over. */
  inProgress: number;
  /** `activated ÷ (activated + not activated)`, a whole percent (`rateOver`); `null` while nobody is decided. */
  pct: number | null;
}

/**
 * **`ACTIVATION_3M_PCT`**: activated ÷ (activated + not activated), a whole percent as every share the product serves
 * (`rateOver`) — `null` while none of them is decided, never 0%. Whose results they are — a join month, a unit, an AAB's
 * unit, the office — is the caller's set.
 */
export function activation3MShare(results: readonly Activation3MResult[]): Activation3MShare {
  const activated = results.filter((r) => r === 'activated').length;
  const notActivated = results.filter((r) => r === 'not_activated').length;
  return {
    activated, notActivated, inProgress: results.length - activated - notActivated,
    pct: rateOver(activated, activated + notActivated).pct,
  };
}

/**
 * **By join month** (ADR-0171 §2, *"by join month"*): the share of each month's new hires — their cohort — keyed
 * `YYYY-MM`, newest month first. A month with nobody in it is not listed.
 */
export function activation3MByJoinMonth(
  hires: readonly { joinDate: LocalDate; result: Activation3MResult }[],
): { month: string; share: Activation3MShare }[] {
  const months = new Map<string, Activation3MResult[]>();
  for (const hire of hires) {
    const month = hire.joinDate.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), hire.result]);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([month, results]) => ({ month, share: activation3MShare(results) }));
}
