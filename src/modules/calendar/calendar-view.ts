import type { LocalDate } from '@/common/time/local-day';
import type { CalendarEntryType } from '@/domain/constants';
import type { CalendarAnswer, CalendarEvent } from './calendar-event.schema';
import { officeTimingOf, type OfficeTiming } from './calendar-time';

/**
 * **What each reader is answered of an entry** (`functional/calendar.md`, *Who reads what* and the Data
 * contract's *An entry* and *A busy block*). Pure: the service resolves who the reader is, whom they
 * coach and everybody's name, and this decides the shape — so the rule a test reads is the rule the
 * wire carries.
 */

/** How the reader stands to one entry. */
export type ReaderIs = 'organiser' | 'invitee' | 'placed' | 'ancestor';

export interface CalendarPersonView {
  membershipId: string;
  name: string;
}

export interface CalendarInviteeView extends CalendarPersonView {
  /** The member a block was placed on (ADR-0098). */
  placed: boolean;
  /**
   * `pending`, `accepted` or `declined` — **served to the organiser alone**, and never on a placed
   * member. Absent for every other reader, who gets the names (ADR-0097).
   */
  answer?: CalendarAnswer;
  /** On a *1:1 coaching* entry, the reader coaches this invitee now (ADR-0099); `false` everywhere else. */
  readerCoaches: boolean;
}

/** An entry, as one reader is answered it. */
export interface CalendarEntryView extends OfficeTiming {
  entryId: string;
  version: number;
  type: CalendarEntryType;
  title: string;
  notes: string;
  startsAt: string;
  endsAt: string;
  organiser: CalendarPersonView;
  invitees: CalendarInviteeView[];
  readerIs: ReaderIs;
  /** The reader's own answer when they are an invitee; `null` for anybody else. */
  myAnswer: CalendarAnswer | null;
}

/**
 * **A busy block**: an entry a compared member attends that the reader could not read in their own
 * right, answered by its time and nothing else — no id, no type, no title, no notes, no people (roles §2
 * rule 4: compare is never a way above the reader's own line).
 */
export interface CalendarBusyView extends OfficeTiming {
  busy: true;
  startsAt: string;
  endsAt: string;
}

/** The stored entry, as far as answering it goes. */
export type StoredEntry = Pick<
  CalendarEvent,
  'organiserMembershipId' | 'type' | 'title' | 'notes' | 'startsAt' | 'endsAt' | 'startsOn' | 'endsOn' | 'attendees' | 'version'
> & { _id: unknown };

/** Who is reading, and what the service has resolved about them. */
export interface Reader {
  membershipId: string;
  /** Everybody the reader coaches now (`COACH`), for `readerCoaches` and for compare's own-right rule. */
  coaches: ReadonlySet<string>;
  /** `membershipId → full name`; a member who has left keeps theirs. */
  names: ReadonlyMap<string, string>;
  timezone: string;
}

/** The reader's own place on an entry, or `null` when they are not on it at all. */
export function standingOf(entry: StoredEntry, readerId: string): Exclude<ReaderIs, 'ancestor'> | null {
  if (entry.organiserMembershipId === readerId) return 'organiser';
  const mine = entry.attendees.find((a) => a.membershipId === readerId);
  if (!mine) return null;
  return mine.placed ? 'placed' : 'invitee';
}

/** An entry in full, as `reader` stands to it. */
export function entryView(entry: StoredEntry, reader: Reader, readerIs: ReaderIs): CalendarEntryView {
  const name = (id: string) => reader.names.get(id) ?? '';
  const mine = entry.attendees.find((a) => a.membershipId === reader.membershipId && !a.placed);
  return {
    entryId: String(entry._id),
    version: entry.version,
    type: entry.type,
    title: entry.title,
    notes: entry.notes,
    ...officeTimingOf(entry, reader.timezone),
    startsAt: entry.startsAt.toISOString(),
    endsAt: entry.endsAt.toISOString(),
    organiser: { membershipId: entry.organiserMembershipId, name: name(entry.organiserMembershipId) },
    invitees: entry.attendees.map((a) => ({
      membershipId: a.membershipId,
      name: name(a.membershipId),
      placed: a.placed,
      ...(readerIs === 'organiser' && !a.placed ? { answer: a.answer as CalendarAnswer } : {}),
      readerCoaches: entry.type === 'coaching' && reader.coaches.has(a.membershipId),
    })),
    readerIs,
    myAnswer: readerIs === 'invitee' && mine ? (mine.answer as CalendarAnswer) : null,
  };
}

/** An entry by its time alone. */
export function busyView(entry: StoredEntry, timezone: string): CalendarBusyView {
  return {
    busy: true,
    ...officeTimingOf(entry, timezone),
    startsAt: entry.startsAt.toISOString(),
    endsAt: entry.endsAt.toISOString(),
  };
}

/**
 * **One entry of a compared member's calendar, as an ancestor is answered it** (ADR-0093; P12-T5 AC-4).
 *
 * - **Every entry the member organised is answered in full**, a *Client meeting*'s title, notes and
 *   invitees included — `readerIs` the reader's own place on it, or `ancestor`.
 * - **An entry the member only attends** is in full only when the reader could read it in their own
 *   right: they organised it, they are on it (whatever their answer), or they coach its organiser.
 *   Otherwise it is a busy block, because its organiser may be the reader's peer or their own leader.
 */
export function comparedView(
  entry: StoredEntry, subjectId: string, reader: Reader,
): CalendarEntryView | CalendarBusyView {
  const own = standingOf(entry, reader.membershipId);
  if (own) return entryView(entry, reader, own);
  if (entry.organiserMembershipId === subjectId || reader.coaches.has(entry.organiserMembershipId)) {
    return entryView(entry, reader, 'ancestor');
  }
  return busyView(entry, reader.timezone);
}

/** Every membership an entry names, for one batched name read. */
export function namedIn(entries: readonly StoredEntry[]): string[] {
  return entries.flatMap((e) => [e.organiserMembershipId, ...e.attendees.map((a) => a.membershipId)]);
}

/** The period read's own fields, as `periodOf` and the office answer them. */
export interface CalendarPeriodView {
  view: 'week' | 'month';
  from: LocalDate;
  to: LocalDate;
  month: string | null;
  days: { date: LocalDate; inPeriod: boolean }[];
  previous: LocalDate;
  next: LocalDate;
  today: LocalDate;
  now: { at: string; minute: number };
  subject: { membershipId: string; name: string; rung: { code: string; label: string } };
  entries: (CalendarEntryView | CalendarBusyView)[];
}
