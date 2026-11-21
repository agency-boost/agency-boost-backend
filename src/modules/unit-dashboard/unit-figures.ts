import { addDays, calendarMonth, localDayOf, type LocalDate } from '@/common/time/local-day';
import type { activeAgentsIn } from '@/modules/production/active-agents';
import type { OfficialApe } from '@/modules/production/official-ape';

/*
 * **The Unit Dashboard's UI V1 figures** (Phase 18.11 T4; `functional/unit-dashboard.md`, *UI V1 (2026-10-30)*): the
 * rules the read and the Activities read apply, pure, so each is a unit test.
 */

/** *Minggu | Bulan* (UI-001): a week Monday to Sunday, or a calendar month. */
export const ACTIVITY_SPANS = ['week', 'month'] as const;
export type ActivitySpan = (typeof ACTIVITY_SPANS)[number];

/** A week is Monday to Sunday (UI-001, D-17): Monday is 0. */
export function mondayOf(date: LocalDate): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  return addDays(date, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
}

/** One period of the Activities tab, and where ‹ and › go from it. */
export interface ActivityPeriod {
  span: ActivitySpan;
  from: LocalDate;
  to: LocalDate;
  /** The period holds the office's today: › goes nowhere (UI-001, *› disabled on the current period*). */
  current: boolean;
  /** A day in the period before. */
  previous: LocalDate;
  /** A day in the period after, or `null` on the current one. */
  next: LocalDate | null;
}

/**
 * **The period holding `date`** (UI-001): its week, Monday to Sunday, or its calendar month. ‹ moves one period back
 * and › one forward, never past the one holding today.
 */
export function activityPeriodOf(span: ActivitySpan, date: LocalDate, today: LocalDate): ActivityPeriod {
  const { from, to } = span === 'week'
    ? { from: mondayOf(date), to: addDays(mondayOf(date), 6) }
    : calendarMonth(date);
  const current = from <= today && today <= to;
  return {
    span,
    from,
    to,
    current,
    previous: addDays(from, -1),
    next: current || to >= today ? null : addDays(to, 1),
  };
}

/**
 * ***Closing*** (UI-028; O-4, ADR-0180 §9): **a sales lead that reached *Paid and issued* within the window** — its
 * first move there (`LeadReadings.closingsOfMany`), on the office's calendar. A lead moved there before the window, or
 * after it, is not counted; a lead's later moves never undo it.
 */
export function closingsIn(
  closings: readonly { at: Date }[], window: { from: LocalDate; to: LocalDate }, timezone: string,
): number {
  return closings.filter((c) => {
    const day = localDayOf(c.at, timezone);
    return window.from <= day && day <= window.to;
  }).length;
}

/** Who a unit's roster holds, by the coaching roster's model (`UnitDashboardService.read`), placed in its view. */
export interface RosterMember {
  membershipId: string;
  /**
   * Their parent in the view (`placeView`, ADR-0249 §2): their leader on the current edge — the head's id for a direct
   * report — or the head for somebody hung from it (`attached`); `null` under *Belum punya leader*.
   */
  leaderId: string | null;
  /** `agent`, `aab`, `ab`. */
  role: string;
  /** Hung from the head though the head is not their leader: a unit of their own, never *Your Unit*. */
  attached?: boolean;
}

/**
 * **The roster's order within a level** (P19.18-T1 AC-6; ADR-0271 §4; the brief of 19 November 2026, part A: *"Order
 * inside every unit and team: the AB first, then their AAB(s), then the other agents"*): by class — `ab`, then `aab`, then
 * everybody else — then A to Z by name, ties by id. It was A to Z alone.
 */
export const CLASS_ORDER: Readonly<Record<string, number>> = { ab: 0, aab: 1 };
export const classRank = (role: string): number => CLASS_ORDER[role] ?? 2;

/**
 * **Who sits in a unit's own rows** (ADR-0271 §2, `DIRECT_UNIT`): a direct report who leads nobody and is no AB — an
 * agent, or an AAB with no team of their own, who sits after the AB. An AB is always a unit of their own, and so is
 * somebody hung from the head (`attached`). It was the agents alone: an AAB with no team was a unit of one.
 */
export const inOwnRows = (m: { role: string; attached?: boolean }, leads: boolean): boolean =>
  !m.attached && m.role !== 'ab' && !leads;

/**
 * **The roster's order and its two scopes** (UI-001's *Unit | Group*; D-16): ***Unit*** is `DIRECT_UNIT` — the head and
 * their direct reports who lead nobody and are no AB (`inOwnRows`) — the rows of *Your Unit*; ***Group*** is everybody in
 * the view, in the order the roster draws them: the Unit, then each unit below the head — the head's own reports first,
 * then those hung from it (ADR-0249 §2) — its head, its members who lead nobody, then the units nested in it; then *Belum
 * punya leader*. Each level AB → AAB → the rest, then A to Z by name, ties by id (`classRank`) — the same order
 * `UnitDashboardService.read` draws.
 */
export function rosterScopes(
  headId: string, members: readonly RosterMember[], nameOf: (id: string) => string,
): { unit: string[]; group: string[] } {
  const below = new Map<string, RosterMember[]>();
  const unled: RosterMember[] = [];
  for (const m of members) {
    if (m.leaderId === null) unled.push(m);
    else below.set(m.leaderId, [...(below.get(m.leaderId) ?? []), m]);
  }
  const order = (a: RosterMember, b: RosterMember) => classRank(a.role) - classRank(b.role)
    || nameOf(a.membershipId).localeCompare(nameOf(b.membershipId)) || a.membershipId.localeCompare(b.membershipId);
  for (const level of below.values()) level.sort(order);
  unled.sort(order);
  const leads = (m: RosterMember) => below.has(m.membershipId);
  const rowsOf = (m: RosterMember): string[] => {
    const children = below.get(m.membershipId) ?? [];
    return [
      m.membershipId,
      ...children.filter((c) => !leads(c)).map((c) => c.membershipId),
      ...children.filter(leads).flatMap(rowsOf),
    ];
  };
  const direct = below.get(headId) ?? [];
  const inUnit = (c: RosterMember) => inOwnRows(c, leads(c));
  const unit = [headId, ...direct.filter(inUnit).map((c) => c.membershipId)];
  const units = [...direct.filter((c) => !inUnit(c) && !c.attached), ...direct.filter((c) => c.attached === true)];
  return { unit, group: [...unit, ...units.flatMap(rowsOf), ...unled.map((m) => m.membershipId)] };
}

/**
 * **The month cells `activeAgentsIn` reads, through the official port** (ADR-0195 §5; P19.18-T1 AC-3, T3 AC-1): the
 * office's file, imported or corrected — never a member's estimate. `OfficialApe` answers them beside the year to date,
 * from the same one read; the office's months as it answers them.
 */
export function officialCells(production: OfficialApe): Parameters<typeof activeAgentsIn>[0] {
  return {
    monthCellsFor: async (ctx, ids, range) => (await production.monthCellsAndYearToDateFor(ctx, ids, range)).cells,
    officeMonths: (ctx, range) => production.officeMonths(ctx, range),
  };
}
