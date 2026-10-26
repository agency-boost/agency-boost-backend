import { formatDate, formatMonth, formatMonthName, formatMonthRange } from '@/common/format/format';
import type { RolledUpGoal } from '@/domain/metrics/unit-rollup';

/** A member, by the membership that identifies them (invariant §2). */
export interface Person {
  membershipId: string;
  name: string;
}

/**
 * **Money against a target** — *"Rp {a} of Rp {t} target"* and its percentage (`KPM_Owner.html:1081`, `:3150`):
 * the rollup rule's sums (`rollUpGoal`), a percentage of the sums, capped as the Summary caps one. `null` is
 * *Not uploaded yet* or *no goal*, never 0.
 */
export interface Money {
  achievedMinor: number | null;
  targetMinor: number | null;
  pct: number | null;
}

export function moneyOf(rolled: RolledUpGoal): Money {
  return { achievedMinor: rolled.actualMinor, targetMinor: rolled.targetMinor, pct: rolled.attainmentPct };
}

/** `YYYY-MM` moved by whole months. Calendar arithmetic, no zone in it. */
export function shiftMonth(month: string, by: number): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/*
 * The periods the Owner's figures name, through the shared formatters (ADR-0167 §1): months and days the Indonesian
 * way, the words between them English (OD-197).
 */

/** *Sep 2026*. */
export function monthLabel(month: string): string {
  return formatMonth(month);
}

/** *Agu and Sep 2026*, or *Des 2025 and Jan 2026*: the two months a `MONTHLY2_AA` count read. */
export function twoMonthsLabel(first: string, second: string): string {
  return first.slice(0, 4) === second.slice(0, 4)
    ? `${formatMonthName(first)} and ${formatMonth(second)}`
    : `${formatMonth(first)} and ${formatMonth(second)}`;
}

/** *Jan – Sep 2026*: a year to date through the month it runs to, a month range; the month alone in January. */
export function yearToDateLabel(through: string): string {
  return formatMonthRange(`${through.slice(0, 4)}-01`, through);
}

/** *9 Okt 2026*: a count read today. */
export function dayLabel(day: string): string {
  return formatDate(day);
}

/** A–Z by name, then by id, so two reads never shuffle. */
export function byName(names: ReadonlyMap<string, string>) {
  return (a: string, b: string) => (names.get(a) ?? '').localeCompare(names.get(b) ?? '') || a.localeCompare(b);
}
