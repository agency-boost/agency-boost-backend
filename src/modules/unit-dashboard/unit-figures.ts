import { addDays, calendarMonth, localDayOf, type LocalDate } from '@/common/time/local-day';

/*
 * **The Unit Dashboard's UI V1 figures** (Phase 18.99 T4; `functional/unit-dashboard.md`, *UI V1 (2026-10-30)*): the
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

/** Who a unit's roster holds, by the coaching roster's model (`UnitDashboardService.read`). */
export interface RosterMember {
  membershipId: string;
  /** Their leader on the current edge: the head's id for a direct report. */
  leaderId: string;
  /** `agent`, `aab`, `ab`. */
  role: string;
}

/**
 * **The roster's order and its two scopes** (UI-001's *Unit | Group*; D-16): ***Unit*** is the head and their direct
 * agents who lead nobody — the rows of *Your Unit*; ***Group*** is everybody, in the order the roster draws them: the
 * Unit, then each unit below the head, its head, its members who lead nobody, then the units nested in it. Each level
 * A to Z by name, ties by id — the same order `UnitDashboardService.read` draws.
 */
export function rosterScopes(
  headId: string, members: readonly RosterMember[], nameOf: (id: string) => string,
): { unit: string[]; group: string[] } {
  const below = new Map<string, RosterMember[]>();
  for (const m of members) below.set(m.leaderId, [...(below.get(m.leaderId) ?? []), m]);
  const aToZ = (a: RosterMember, b: RosterMember) =>
    nameOf(a.membershipId).localeCompare(nameOf(b.membershipId)) || a.membershipId.localeCompare(b.membershipId);
  for (const level of below.values()) level.sort(aToZ);
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
  const unit = [headId, ...direct.filter((c) => c.role === 'agent' && !leads(c)).map((c) => c.membershipId)];
  const units = direct.filter((c) => c.role !== 'agent' || leads(c));
  return { unit, group: [...unit, ...units.flatMap(rowsOf)] };
}
