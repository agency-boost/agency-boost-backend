import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId, type FilterQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { localDayOf, type LocalDate } from '@/common/time/local-day';
import type { CoachingSessionDocument } from '@/modules/coaching/coaching-session.schema';
import { CoachingSessionRepository } from '@/modules/coaching/coaching-session.repository';
import { latestFinalized } from '@/modules/coaching/coaching-session.rules';
import { EventRepository, EventRsvpRepository, EventTypeRepository } from '@/modules/events/event.repository';
import type { EventDocument } from '@/modules/events/event.schema';
import type { LeadDocument } from '@/modules/leads/lead.schema';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { User, UserDocument } from '@/modules/users/user.schema';
import { officeClockOf, type OfficeTiming } from './calendar-time';

/**
 * **What other features put on a calendar, merged at query time** (UI V1, 2026-10-30, UI-104 point 1; ADR-0180 §11;
 * `functional/calendar.md`, *UI V1*). Nothing is copied into `calendarEvents`: each item is read from its source on
 * every read, so it follows the source — a next action moved, an action item ticked, an RSVP withdrawn — with no sync
 * to break. Read-only in Calendar; a tap opens the source.
 *
 * - **Tugas** — items with a date and no time: **a lead's next action**, for the lead's owner, on its date (open leads
 *   only: a closed lead's next action is no longer work); and **an open coaching action item**, for the coachee, on its
 *   due date — the typed items of the coachee's newest finalized 1:1, whoever led it (the session the next *Start*
 *   reviews), not ticked done. Never a coaching session itself.
 * - **Joined events** — an event (`/events`) whose RSVP is *going*, at its start and end, with its own type. A
 *   cancelled, declined or withdrawn RSVP, an archived or deleted event: not on the calendar.
 *
 * Every read goes through the tenant repositories (invariant §1); the users behind memberships are read by `_id` from a
 * list a scoped read produced, as `MemberNames` reads them, for a coach's phone.
 */

/** Where a task comes from. */
export type CalendarTaskSource = 'lead' | 'coaching';

/** One *Tugas* item in full: the reader's own, or a compared member's whose details they may read. */
export interface CalendarTaskView {
  /** `lead:{leadId}` or `coaching:{sessionId}:{itemId}`: stable across reads, for a tick and its undo. */
  taskId: string;
  source: CalendarTaskSource;
  /** The office date it is due. */
  date: LocalDate;
  /** Whose task it is: the lead's owner, or the coachee. */
  ownerMembershipId: string;
  /** The lead's name, or the coach's — *Dari: {NAME}*. */
  name: string;
  /** The next action's note, or the action item's words; `''` when there is none. */
  note: string;
  /** The lead's WhatsApp number, or the coach's; `null` when none is on file. */
  phone: string | null;
  /** A lead's: its id and the version a tick pins. */
  lead: { leadId: string; version: number } | null;
  /** A coaching item's: its session, its id, and the coach. */
  coaching: { sessionId: string; itemId: string; coachMembershipId: string } | null;
}

/** A task of somebody who hides their calendar's details (ADR-0110): its day, and nothing else. */
export interface CalendarHiddenTaskView {
  busy: true;
  date: LocalDate;
}

/** A joined event, in the office's dates and wall clock. */
export interface CalendarJoinedEventView extends OfficeTiming {
  eventId: string;
  title: string;
  /** The office's event type: its code and its label, as the office typed it. */
  type: { code: string; label: string };
  location: string;
  startsAt: string;
  endsAt: string;
}

/** An instant span's timing: never all-day, so its date and both its times are always there. */
export interface InstantTiming extends OfficeTiming {
  date: LocalDate;
  start: string;
  end: string;
}

/** A joined event as `joinedEventsOf` answers it: an instant span, so its date and times are always there. */
export type JoinedEvent = CalendarJoinedEventView & InstantTiming;

/** The order of a day's *Tugas*: coaching first, then leads, then by name — the Agenda's checklist and Home's. */
export function byTaskOrder(a: CalendarTaskView, b: CalendarTaskView): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.source !== b.source) return a.source === 'coaching' ? -1 : 1;
  return a.name.localeCompare(b.name, 'id') || a.taskId.localeCompare(b.taskId);
}

/**
 * **An instant span in the office's terms**: its date and times, and — when it runs past its first day — its two
 * dates, as a timed trip is answered. An end at midnight belongs to the day before it.
 */
export function instantTiming(startsAt: Date, endsAt: Date, timezone: string): InstantTiming {
  const start = officeClockOf(timezone, startsAt);
  const end = officeClockOf(timezone, endsAt);
  const lastDay = end.minute === 0 && endsAt > startsAt ? localDayOf(new Date(endsAt.getTime() - 1), timezone) : end.date;
  const spans = lastDay !== start.date;
  return {
    allDay: false,
    date: start.date,
    start: start.time,
    end: end.time,
    startsOn: spans ? start.date : null,
    endsOn: spans ? lastDay : null,
  };
}

const COUNTED_SESSIONS = ['finalized', 'reopened'];

@Injectable()
export class CalendarAutoItems {
  constructor(
    private readonly leads: LeadRepository,
    private readonly sessions: CoachingSessionRepository,
    private readonly rsvps: EventRsvpRepository,
    private readonly events: EventRepository,
    private readonly eventTypes: EventTypeRepository,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  /** A member's *Tugas* from `from` to `to`, inclusive, in the checklist's order. */
  async tasksOf(ctx: RequestContext, membershipId: string, from: LocalDate, to: LocalDate): Promise<CalendarTaskView[]> {
    const [leads, session] = await Promise.all([
      this.leads.find(ctx, {
        ownerMembershipId: membershipId, outcome: null, nextActionDate: { $gte: from, $lte: to },
      } as FilterQuery<LeadDocument>),
      this.newestFinalized(ctx, membershipId),
    ]);
    const items = session ? this.openItems(session, from, to) : [];
    const coachId = session?.coachMembershipId ?? null;
    const [coachNames, phones] = await Promise.all([
      coachId ? this.names.byMembershipId(ctx, [coachId]) : Promise.resolve(new Map<string, string>()),
      coachId && items.length > 0 ? this.phonesOf(ctx, [coachId]) : Promise.resolve(new Map<string, string>()),
    ]);

    const tasks: CalendarTaskView[] = [
      ...leads.map((lead): CalendarTaskView => ({
        taskId: `lead:${String(lead._id)}`,
        source: 'lead',
        date: lead.nextActionDate as LocalDate,
        ownerMembershipId: membershipId,
        name: lead.name,
        note: lead.nextActionNote?.trim() ?? '',
        phone: lead.contact?.phone ?? null,
        lead: { leadId: String(lead._id), version: lead.version },
        coaching: null,
      })),
      ...items.map((item): CalendarTaskView => ({
        taskId: `coaching:${String(session!._id)}:${item.itemId}`,
        source: 'coaching',
        date: item.dueDate as LocalDate,
        ownerMembershipId: membershipId,
        name: coachNames.get(coachId as string) ?? '',
        note: item.text.trim(),
        phone: phones.get(coachId as string) ?? null,
        lead: null,
        coaching: { sessionId: String(session!._id), itemId: item.itemId, coachMembershipId: coachId as string },
      })),
    ];
    return tasks.sort(byTaskOrder);
  }

  /** The events a member has said they are going to, overlapping `[start, endExclusive)`, by start. */
  async joinedEventsOf(
    ctx: RequestContext, membershipId: string, start: Date, endExclusive: Date, timezone: string,
  ): Promise<JoinedEvent[]> {
    const going = await this.rsvps.find(ctx, { membershipId, rsvpStatus: 'going' });
    const ids = [...new Set(going.map((r) => r.eventId))].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return [];
    const events = await this.events.find(
      ctx,
      { _id: { $in: ids }, status: 'active', startsAt: { $lt: endExclusive }, endsAt: { $gt: start } } as FilterQuery<EventDocument>,
      { sort: { startsAt: 1, _id: 1 } },
    );
    if (events.length === 0) return [];
    const types = await this.eventTypes.find(ctx, { code: { $in: [...new Set(events.map((e) => e.typeCode))] } });
    const labels = new Map(types.map((t) => [t.code, t.label]));
    return events.map((event) => ({
      eventId: String(event._id),
      title: event.title,
      type: { code: event.typeCode, label: labels.get(event.typeCode) ?? event.typeCode },
      location: event.location,
      ...instantTiming(event.startsAt, event.endsAt, timezone),
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
    }));
  }

  /**
   * **The coachee's newest 1:1 that counts** — the session the next *Start* reviews, whoever led it (ADR-0081): its
   * finalized version agreed the items still open.
   */
  private async newestFinalized(ctx: RequestContext, coacheeId: string): Promise<CoachingSessionDocument | null> {
    const [newest] = await this.sessions.find(
      ctx,
      { coacheeMembershipId: coacheeId, status: { $in: COUNTED_SESSIONS }, date: { $ne: null } },
      { sort: { date: -1, frozenAt: -1 }, limit: 1 },
    );
    return newest ?? null;
  }

  /** Its typed items with a due date in the range, not ticked done. */
  private openItems(session: CoachingSessionDocument, from: LocalDate, to: LocalDate) {
    const agreed = latestFinalized(session);
    if (!agreed) return [];
    const done = new Set(session.actionItemsDone.map((d) => d.itemId));
    return agreed.actionItems.filter((item) => (
      item.dueDate !== null && item.dueDate >= from && item.dueDate <= to && !done.has(item.itemId) && item.text.trim() !== ''
    ));
  }

  /**
   * `membershipId → phone`, for **active** memberships of this office whose person has one on file.
   *
   * A coach who has left keeps their name on the items they agreed — *Dari: NAME* is the item's history — but their
   * number is not served (the Phase 18.99 exit review, L1): a membership that is not `active` is somebody this office no
   * longer puts its members in touch with, and their `users.phone` is their own account's, not the office's to hand out.
   */
  async phonesOf(ctx: RequestContext, membershipIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(membershipIds)].filter((id) => isValidObjectId(id));
    if (unique.length === 0) return new Map();
    const members = await this.memberships.find(ctx, { _id: { $in: unique }, status: 'active' });
    const userIds = [...new Set(members.map((m) => String(m.userId)))];
    const users = await this.users.find({ _id: { $in: userIds } }).select('phone').lean().exec();
    const byUser = new Map(
      (users as unknown as { _id: unknown; phone?: string | null }[]).map((u) => [String(u._id), u.phone ?? null]),
    );
    const out = new Map<string, string>();
    for (const member of members) {
      const phone = byUser.get(String(member.userId));
      if (phone) out.set(String(member._id), phone);
    }
    return out;
  }
}
