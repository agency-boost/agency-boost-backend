import { DateTime } from 'luxon';
import type { Clock } from '@/common/clock/clock.port';
import { addDays, type LocalDate } from '@/common/time/local-day';
import { ACTIVATION, ACTIVATION_ACTIVITY_WEEKS, ACTIVATION_FIRST_CASE_CODE } from '@/domain/constants';
import type { ActivationItemState } from './activation-progress.schema';

/**
 * **The activation's arithmetic, in one place** (Phase 13): the day, the end, the state, and progress —
 * the one computation every reader is served (P13-T2 AC-5, exit criterion 2), so the hire's page, a
 * leader's detail, the roster and both coaching tabs cannot disagree about a percentage.
 *
 * Pure: no database, no ambient clock. Every day is an office date in the zone the caller names, and
 * every day count goes through `Clock.daysBetween` and every week through `Clock.weekBounds` — never by
 * dividing milliseconds, which is what the prototype does with the browser's clock (`:6615`, F-01).
 */

/** What an activation is now: open, graduated by the hire (OD-28), or past its six months (OD-120). */
export type ActivationState = 'open' | 'graduated' | 'expired';

/** An aspect's status, as the prototype's table pills it: *Done*, *In progress*, *Not started* (`:6537-6551`). */
export type AspectStatus = 'done' | 'in_progress' | 'not_started';

/**
 * `ACTIVATION_DAY_INDEX`: `Clock.daysBetween(timezone, startDate, today) + 1`, **never below 1**
 * (`ACTIVATION.DAY_INDEX_BASE`). The start date itself is day 1; a start date the office's today has not
 * reached yet reads as day 1 too, as the prototype's `Math.max(1, …)` has it (`:6615`).
 */
export function activationDay(clock: Clock, timezone: string, startDate: LocalDate, today: LocalDate): number {
  return Math.max(ACTIVATION.DAY_INDEX_BASE, clock.daysBetween(timezone, startDate, today) + ACTIVATION.DAY_INDEX_BASE);
}

/**
 * **The day an activation ends** (OD-120): `ACTIVATION.VISIBLE_MONTHS` calendar months after its start,
 * counted in the office's timezone. A start on a day the end month lacks ends on that month's last day —
 * 31 August ends on the last day of February — which is what calendar months mean and what luxon does.
 */
export function activationEndsOn(timezone: string, startDate: LocalDate): LocalDate {
  return DateTime.fromFormat(startDate, 'yyyy-MM-dd', { zone: timezone })
    .plus({ months: ACTIVATION.VISIBLE_MONTHS })
    .toFormat('yyyy-MM-dd');
}

/**
 * Open until graduated, or until the office's today reaches the end day — **derived on every read**,
 * never written by a job (D-notify). An expired activation is kept, read-only.
 */
export function activationState(
  graduatedAt: Date | null, today: LocalDate, endsOn: LocalDate,
): ActivationState {
  if (graduatedAt) return 'graduated';
  return today >= endsOn ? 'expired' : 'open';
}

/** Past the office's window, below 100%, and still open: the roster's red day (`:6754`). */
export function isOverdue(day: number, window: number, pct: number, state: ActivationState): boolean {
  return state === 'open' && day > window && pct < 100;
}

/** One item of the pinned version, as the arithmetic needs it. */
export interface PinnedItem {
  code: string;
}

export interface PinnedAspect<I extends PinnedItem> {
  code: string;
  label: string;
  items: I[];
}

/** The aspects of a version with each item's done flag, and the totals: what every reader is served. */
export interface Progress<I extends PinnedItem> {
  done: number;
  total: number;
  pct: number;
  aspects: Array<{
    code: string;
    label: string;
    status: AspectStatus;
    done: number;
    total: number;
    items: Array<{ item: I; done: boolean }>;
  }>;
}

/**
 * **`ACTIVATION_COMPLETION_PCT` and each aspect's status, computed once** (P13-T2 AC-5). The percentage
 * is `round(done / total × 100)` over the **pinned version's items** (`:6619`); an aspect is *Done* when
 * every item in it is, *Not started* when none is, *In progress* between (`:6537-6551`). A version with no
 * items — refused at publish, so never seen — reads as 0%.
 */
export function progressOf<I extends PinnedItem>(
  aspects: readonly PinnedAspect<I>[], doneCodes: ReadonlySet<string>,
): Progress<I> {
  let done = 0;
  let total = 0;
  const out = aspects.map((aspect) => {
    const items = aspect.items.map((item) => ({ item, done: doneCodes.has(item.code) }));
    const aspectDone = items.filter((i) => i.done).length;
    done += aspectDone;
    total += items.length;
    const status: AspectStatus = aspectDone === items.length
      ? 'done'
      : aspectDone > 0 ? 'in_progress' : 'not_started';
    return { code: aspect.code, label: aspect.label, status, done: aspectDone, total: items.length, items };
  });
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100), aspects: out };
}

/**
 * **The roster's *Active Agent* ✓ and the coaching renderer's *New Active Agent*** (`:6755`, `:6472`): the
 * item coded `FIRST_CASE_CLOSED` is done — by code, never item 13 by position (invariant §4). An office
 * whose version has no such item reads false.
 */
export function firstCaseClosed(progress: Progress<PinnedItem>): boolean {
  return progress.aspects.some((a) => a.items.some(({ item, done }) => done && item.code === ACTIVATION_FIRST_CASE_CODE));
}

/**
 * The Monday of the office week an office date falls in, **through `Clock.weekBounds`** in the office's
 * zone (ADR-0031: weeks run Monday to Sunday in `kpms.timezone`).
 */
export function officeMondayOf(clock: Clock, timezone: string): (date: LocalDate) => LocalDate {
  return (date) => clock.localDateFor(timezone, clock.weekBounds(timezone, clock.startOfLocalDay(timezone, date)).start);
}

/**
 * **`feature:activity`'s predicate** (ADR-0031, D-links): `ACTIVATION_ACTIVITY_WEEKS` consecutive Monday
 * to Sunday office weeks, each holding at least one day logged above zero. The days are the hire's own,
 * from the start date on; an all-zero saved day is not among them, so a week of zeroes counts for none.
 *
 * Answers **the day that completed it** — the first active day of the last week of the first run long
 * enough — or `null`. The caller names its record and its author.
 */
export function activityWeeksCompletedOn<D extends { date: LocalDate }>(
  activeDays: readonly D[], mondayOf: (date: LocalDate) => LocalDate,
  weeks: number = ACTIVATION_ACTIVITY_WEEKS,
): D | null {
  const firstOfWeek = new Map<LocalDate, D>();
  for (const day of [...activeDays].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const monday = mondayOf(day.date);
    if (!firstOfWeek.has(monday)) firstOfWeek.set(monday, day);
  }
  const mondays = [...firstOfWeek.keys()].sort();
  let run = 0;
  let previous: LocalDate | null = null;
  for (const monday of mondays) {
    run = previous !== null && addDays(previous, 7) === monday ? run + 1 : 1;
    if (run >= weeks) return firstOfWeek.get(monday)!;
    previous = monday;
  }
  return null;
}

/**
 * **`coaching:weekly:4`'s predicate** (P18.96-T4 AC-2, ADR-0171 §3): the `n`th 1:1 with the hire **since their join
 * date** — a coaching session finalized at least once, on its office `date` (`CoachingReadings.countedSince`), a draft
 * never — oldest first, ties by session id so two reads agree. Two 1:1s on one day are two (ADR-0081). `null` before
 * there are `n`. A session dated before the start is not the hire's activation's.
 */
export function nthOneOnOne<S extends { date: LocalDate; sessionId: string }>(
  sessions: readonly S[], startDate: LocalDate, n: number,
): S | null {
  const since = sessions
    .filter((s) => s.date >= startDate)
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return since.length >= n ? since[n - 1] : null;
}

/**
 * An item's row as it reads before anybody touched it: not done, by nobody, nothing written by the hire.
 * An activation is written with one per item of its pinned version — by a placement, the backfill and the
 * seed alike — so every later write addresses its item's row by code.
 */
export function freshItemState(code: string): ActivationItemState {
  return {
    code, done: false, doneAt: null, source: null, doneByMembershipId: null,
    recordCollection: null, recordId: null, note: null, date: null,
  };
}
