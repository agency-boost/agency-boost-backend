import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@/common/errors/domain.exception';
import { EventReadings, type EventAttendance, type EventFacts } from '@/modules/events/event-readings';
import type { ComplianceCategory, ComplianceCategoryRead, ComplianceCell, ComplianceScope } from './compliance-category';

/** One event the Owner's *Events* picker lists (D-window: this year, archived never). */
export interface ComplianceEventEntry {
  id: string;
  title: string;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** The office day it starts on. */
  startsOn: string;
  phase: 'upcoming' | 'running' | 'past';
}

export type EventsComplianceCatalog = ComplianceEventEntry[];

/** The latest instant a `Date` holds: `eventsBetween`'s upper bound when the window has none. */
export const NO_END = new Date(8_640_000_000_000_000);

/** Neither status nor feedback: a member outside the event's audience as at its start (D-chips). */
const OUTSIDE: ComplianceCell = { status: null, done: null, on: null, second: null };

/**
 * **One member's cell for one event** (P18.6-T2 AC-2) — the roll call's `EVENT_ATTENDANCE_STATUS` as the code, so the
 * tree and the roll call cannot disagree. `event` is the attendance reading's own, read with the row's status.
 *
 * - Before the end: `registered` (done, the event's day) or `not_registered`.
 * - After it: `attended` (done, the day) — a confirmer's mark, never a claim (OD-31); `unconfirmed` — RSVP'd or
 *   said they came and nobody has confirmed: in the audience and **not done**, drawn *—* (*awaiting confirmation*);
 *   `no_show` — marked absent; `not_registered`.
 * - Feedback (`second`): only after the end, for a member who attended or awaits confirmation — the two whose form
 *   is open (OD-31) — `shared` or `not_shared`; `null` for anybody who did not attend.
 */
export function eventCell(row: EventAttendance['rows'][number] | undefined, event: EventFacts): ComplianceCell {
  if (row === undefined) return OUTSIDE;
  const done = event.ended ? row.status === 'attended' : row.status === 'registered';
  const feedbackOpen = event.ended && (row.status === 'attended' || row.status === 'unconfirmed');
  return {
    status: row.status,
    done,
    on: done ? event.startsOn : null,
    second: feedbackOpen ? (row.gaveFeedback ? 'shared' : 'not_shared') : null,
  };
}

/** The picker's order: not past soonest first (a running one leads), then past latest first (`Owner:3577-3580`). */
export function eventOrder(a: Pick<EventFacts, 'phase' | 'startsAt' | 'id'>, b: Pick<EventFacts, 'phase' | 'startsAt' | 'id'>): number {
  const pastA = a.phase === 'past';
  const pastB = b.phase === 'past';
  if (pastA !== pastB) return pastA ? 1 : -1;
  const by = a.startsAt.getTime() - b.startsAt.getTime();
  return (pastA ? -by : by) || a.id.localeCompare(b.id);
}

/**
 * **Events in the Owner's compliance tree** (P18.6-T1 AC-3, P18.6-T2 AC-1, AC-2; D-window, D-chips).
 *
 * - **The catalog**: the office's events starting this year in its zone **and every one not started yet, whatever
 *   its year** (the exit review, round 2: members RSVP before an event starts, so the Owner sees it from then) —
 *   archived ones never (D-window) — in the picker's order; the screen groups them *Upcoming* (a running one among
 *   them) and *Past*. Without an `item`, the first one: the prototype opens on its first event (`Owner:3497`).
 * - **The chip**: of the tree's members in at least one listed event's audience as at its start, those who
 *   attended (confirmed) one that has ended, or are registered for one that has not.
 * - **The cells**: the selected event's, through `EventReadings.attendanceOfMany` — the roll call's own computation.
 * - **404** for an `item` the catalog does not list: another office's event, an archived one, one outside the year,
 *   or no id at all. Nothing here is audited (D-audit-tree: attendance is no activity row).
 */
@Injectable()
export class EventsComplianceCategory implements ComplianceCategory<EventsComplianceCatalog> {
  constructor(private readonly readings: EventReadings) {}

  async read(
    scope: ComplianceScope,
    selection: { selected: boolean; item: string | null },
  ): Promise<ComplianceCategoryRead<EventsComplianceCatalog>> {
    // This year, or not started yet: the office's day is in this year, so that is every event from the year's start
    // on — one read, open-ended (the latest instant a date holds), the same two queries as the year alone.
    const listed = (await this.readings.eventsBetween(scope.ctx, scope.year.start, NO_END))
      .filter((event) => event.status !== 'archived')
      .sort(eventOrder);
    const catalog = listed.map((event): ComplianceEventEntry => ({
      id: event.id,
      title: event.title,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      startsOn: event.startsOn,
      phase: event.phase,
    }));
    if (selection.item !== null && !listed.some((event) => event.id === selection.item)) {
      throw new NotFoundException('Event');
    }
    const item = selection.item ?? listed[0]?.id ?? null;
    if (listed.length === 0) {
      return { catalog, chip: { count: 0, of: 0 }, item, cells: selection.selected ? new Map() : null };
    }

    const attendance = await this.readings.attendanceOfMany(scope.ctx, listed.map((event) => event.id));
    const members = new Set(scope.memberIds);
    const inAudience = new Set<string>();
    const done = new Set<string>();
    // Each cell reads the attendance's own event — the same clock read as its rows' statuses (the exit review's L3),
    // so an event ending between the two reads cannot be *ended* for one and not the other.
    for (const event of listed) {
      const reading = attendance.get(event.id);
      if (!reading) continue;
      for (const row of reading.rows) {
        if (!members.has(row.membershipId)) continue;
        inAudience.add(row.membershipId);
        if (eventCell(row, reading.event).done) done.add(row.membershipId);
      }
    }

    let cells: Map<string, ComplianceCell> | null = null;
    if (selection.selected) {
      const reading = attendance.get(item!);
      const rows = new Map((reading?.rows ?? []).map((row) => [row.membershipId, row]));
      cells = new Map(scope.memberIds.map((id) => [id, reading ? eventCell(rows.get(id), reading.event) : OUTSIDE]));
    }
    return { catalog, chip: { count: done.size, of: inAudience.size }, item, cells };
  }
}
