import { addDays, type LocalDate } from '@/common/time/local-day';
import { ACTIVATION_3M } from '@/domain/constants/joining';
import { rateOver } from './rate';

/**
 * **`ACTIVATION_3M` and `ACTIVATION_3M_PCT`** (ADR-0171 §2, ADR-0173; P18.8-T6 AC-1, AC-2; amended by UI V1, 2026-10-30,
 * the owner's D-24 – D-26 and UI-023; `metrics-and-definitions.md`, *3M activation*) — whether a new hire made their
 * first sale (*pecah telor*) by day 90 of joining, and the share of the decided ones who did. **Defined here once**:
 * `/new-hires`, the lock written on the membership, the Strategic Leader Forum's *3M new agent %* row and the seed all
 * call these. They replace `NEW_AGENT_3M_ACTIVE_PCT`, which read a hire's four calendar months of the production file
 * (retired, ADR-0171 §2).
 *
 * **A new hire's result** (`activation3MOf`), from their join date (day 1), their first sale (`FIRST_SALE_DATE`) and the
 * office's today, every one an office date (invariant §9). **Leaving decides nothing** (UI V1, D-24: there is no
 * *Keluar*): a hire marked left reads from their sale and their join date like anybody else.
 *
 * - **a first sale on or before day 90 is *activated* at once** — decided by the sale (rule A), not on day 91;
 * - **past day 90 with none by then, *not activated*** — and a sale after day 90 does not change that: it makes them
 *   *Teraktivasi* in amber (`activated_late`, *lewat 3M*), **in neither part of the share**;
 * - **otherwise, in progress** — inside the 90 days with no sale, in neither part either.
 *
 * **Kept once day 90 is over** (`activation3MDecided`). The membership keeps the result the records gave at the end of
 * day 90 (`memberships.activation3M`), and a kept result is the answer from then on, whatever is recorded later — a
 * backdated closing, a production file uploaded late, a join date corrected. Inside the 90 days nothing is kept, so a
 * wrong production file put right (`fileSaleWithdrawn`) still takes its first sale back. Pure: the caller reads the
 * records and keeps the lock (`Activation3MService`).
 */

/** What a new hire's 3M activation is. The screens say *In progress*, *Activated* and *Not activated*. */
export const ACTIVATION_3M_RESULTS = ['in_progress', 'activated', 'not_activated'] as const;
export type Activation3MResult = (typeof ACTIVATION_3M_RESULTS)[number];

/** A decided result: what `memberships.activation3M` keeps. */
export const ACTIVATION_3M_LOCKS = ['activated', 'not_activated'] as const;
export type Activation3MLock = (typeof ACTIVATION_3M_LOCKS)[number];

/**
 * **What a new hire's row says** (UI V1, D-24, UI-023): *Teraktivasi* as soon as there is a first sale — `activated`
 * by day 90, `activated_late` after it (amber, *lewat 3M*) — and `not_yet` without one. *Keluar* is not a status.
 */
export const NEW_HIRE_STATUSES = ['activated', 'activated_late', 'not_yet'] as const;
export type NewHireStatus = (typeof NEW_HIRE_STATUSES)[number];

/** One new hire, as the result reads them. Office dates throughout. */
export interface Activation3MInput {
  /** Day 1. */
  joinDate: LocalDate;
  /** `FIRST_SALE_DATE`; `null` with none. */
  firstSaleDate: LocalDate | null;
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

/**
 * **The result as the records stand**, a kept lock first. A first sale on or before day 90 is *activated* the day it
 * is recorded (rule A, UI V1); the rest wait for day 91.
 */
export function activation3MOf(input: Activation3MInput, today: LocalDate): Activation3MResult {
  const decided = activation3MDecided(input, today);
  if (decided !== null) return decided;
  const sale = input.firstSaleDate;
  return sale !== null && sale <= activation3MLastDay(input.joinDate) && sale <= today ? 'activated' : 'in_progress';
}

/**
 * **The result the lock keeps, or `null` while there is nothing to keep**: a kept lock; else, once today is past day
 * 90, *activated* if the first sale was on or before day 90 and *not activated* if not. Nothing is kept inside the 90
 * days — not a sale, which `activation3MOf` reads as *activated* at once, and not a leaving, which decides nothing.
 */
export function activation3MDecided(input: Activation3MInput, today: LocalDate): Activation3MLock | null {
  if (input.locked !== null) return input.locked;
  const lastDay = activation3MLastDay(input.joinDate);
  if (today <= lastDay) return null;
  return input.firstSaleDate !== null && input.firstSaleDate <= lastDay ? 'activated' : 'not_activated';
}

/**
 * **The row's status** (UI V1, D-24): *activated* by day 90; any other first sale — after day 90, or recorded after a
 * *not activated* was kept — *activated late*, amber; none, *not yet*.
 */
export function newHireStatusOf(result: Activation3MResult, firstSaleDate: LocalDate | null): NewHireStatus {
  if (result === 'activated') return 'activated';
  return firstSaleDate !== null ? 'activated_late' : 'not_yet';
}

/** **The day of the first sale** — *"Pecah telor di hari ke-X"*: the join date is day 1. `null` without one. */
export function activation3MFirstSaleDay(joinDate: LocalDate, firstSaleDate: LocalDate | null): number | null {
  return firstSaleDate === null ? null : activation3MDay(joinDate, firstSaleDate);
}

/**
 * **The two years `/new-hires` offers** (ADR-0233, the owner's R2 and R3 of 6 November 2026): *Tahun berjalan* — this
 * calendar year, the page's default — and *Tahun lalu*, the one before it.
 */
export const NEW_HIRE_YEARS = ['current', 'previous'] as const;
export type NewHireYear = (typeof NEW_HIRE_YEARS)[number];

/** A span of join dates, both ends in it: office dates. */
export interface JoinDateSpan {
  from: LocalDate;
  to: LocalDate;
}

/**
 * **The join dates `/new-hires` lists for a year** (ADR-0233, amending ADR-0173 §1): `current` is 1 January of the
 * office's year to the office's today — so on 1 January it holds that day alone, and the count starts again from 0 —
 * and `previous` is all of last year, 1 January to 31 December. Office dates throughout: `today` is the office's, and
 * the year is read off it, never off the server's clock. On 8 November 2026, 2026-01-01 to 2026-11-08 and 2025-01-01 to
 * 2025-12-31.
 */
export function newHiresYear(today: LocalDate, year: NewHireYear): JoinDateSpan {
  const y = Number(today.slice(0, 4));
  return year === 'current' ? { from: `${y}-01-01`, to: today } : { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
}

/**
 * **Both years at once**: 1 January of last year to the office's today — what decides whether `/new-hires` has anybody
 * to show at all (a 404 only when neither year does) and the session's `newHires` flag (P19.9-T3 AC-2, AC-3).
 */
export function newHiresReach(today: LocalDate): JoinDateSpan {
  return { from: newHiresYear(today, 'previous').from, to: today };
}

/** Whether an office date is in a span, both ends included. `YYYY-MM-DD` sorts as the calendar does. */
export function inSpan(date: LocalDate | null | undefined, span: JoinDateSpan): date is LocalDate {
  return date != null && date >= span.from && date <= span.to;
}

/** A new hire as the share reads them: their result and whether they have a first sale. */
export interface Activation3MOutcome {
  result: Activation3MResult;
  firstSaleDate: LocalDate | null;
}

/** **`ACTIVATION_3M_PCT`** over a set of new hires: how many of each, and the share. */
export interface Activation3MShare {
  /** Activated by day 90: the numerator, and part of the denominator. */
  activated: number;
  /** Past day 90 with no first sale: the rest of the denominator. */
  notActivated: number;
  /** A first sale after day 90 (`activated_late`): *Teraktivasi*, and in neither part. */
  late: number;
  /** Inside the 90 days with no first sale: not decided yet, and in neither part (rule A). */
  inProgress: number;
  /** `activated ÷ (activated + not activated)`, a whole percent (`rateOver`); `null` while nobody is decided. */
  pct: number | null;
}

/**
 * **`ACTIVATION_3M_PCT`** (rule A, UI V1): activated by day 90 ÷ the new hires whose result is decided — activated by
 * day 90, or past it with no first sale. Inside the 90 days without a sale is not counted yet (Arief 2 of 2 is 100%,
 * not 2 of 3), and a first sale after day 90 is in neither part (Lukman, day 96). A whole percent, as every share the
 * product serves (`rateOver`) — `null` while none of them is decided, never 0%. Whose results they are — a unit, an
 * AAB's group, the tree, the office — is the caller's set.
 */
export function activation3MShare(hires: readonly Activation3MOutcome[]): Activation3MShare {
  let activated = 0;
  let notActivated = 0;
  let late = 0;
  for (const { result, firstSaleDate } of hires) {
    const status = newHireStatusOf(result, firstSaleDate);
    if (status === 'activated') activated += 1;
    else if (status === 'activated_late') late += 1;
    else if (result === 'not_activated') notActivated += 1;
  }
  return {
    activated, notActivated, late, inProgress: hires.length - activated - notActivated - late,
    pct: rateOver(activated, activated + notActivated).pct,
  };
}

/**
 * **By join month** (ADR-0171 §2, *"by join month"*): the share of each month's new hires — their cohort — keyed
 * `YYYY-MM`, newest month first. A month with nobody in it is not listed.
 */
export function activation3MByJoinMonth(
  hires: readonly (Activation3MOutcome & { joinDate: LocalDate })[],
): { month: string; share: Activation3MShare }[] {
  const months = new Map<string, Activation3MOutcome[]>();
  for (const hire of hires) {
    const month = hire.joinDate.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), hire]);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([month, outcomes]) => ({ month, share: activation3MShare(outcomes) }));
}
