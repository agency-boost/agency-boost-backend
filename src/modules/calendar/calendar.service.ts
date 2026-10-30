import { HttpStatus, Injectable } from '@nestjs/common';
import { FilterQuery, isValidObjectId } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { ResourceName } from '@/common/errors/resources';
import { addDays, isLocalDate, type LocalDate } from '@/common/time/local-day';
import { refuseWith, type FieldSentence } from '@/common/validation/fields';
import { CALENDAR_ALL_DAY_TYPE, type CalendarEntryType } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { scopeFor } from '@/modules/rbac/permissions';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay, type Office } from '@/modules/tenants/tenant-day.service';
import { CalendarAutoItems, type CalendarTaskView, type JoinedEvent } from './calendar-auto-items';
import { CalendarEventRepository, type CalendarEntryFields } from './calendar-event.repository';
import type { CalendarAnswer, CalendarAttendee, CalendarEventDocument } from './calendar-event.schema';
import { CalendarNotices } from './calendar-notices';
import { CALENDAR_REFUSALS } from './calendar.messages';
import {
  isAllDayTrip, officeClockOf, officeDateOf, officeTimingOf, periodOf, startOfOfficeDay, timingOf,
  type CalendarView, type TimingInput,
} from './calendar-time';
import {
  comparedView, entryView, namedIn, standingOf, type CalendarEntryView, type CalendarPeriodView, type Reader,
} from './calendar-view';

/** `GET /calendar/entries`'s query, as the DTO has validated its shape. */
export interface CalendarReadQuery {
  view?: CalendarView;
  date?: string;
  for?: string;
}

/** A new entry, as the DTO has validated its shape. */
export interface CalendarEntryInput extends TimingInput {
  type: CalendarEntryType;
  title?: string | null;
  notes?: string | null;
  inviteeIds?: string[];
}

/** An edit: the version it was read at, and any field it changes. */
export interface CalendarEntryEdit extends Partial<CalendarEntryInput> {
  version: number;
}

/** A block: the member it is placed on, and an entry's fields. */
export interface CalendarBlockInput extends CalendarEntryInput {
  membershipId: string;
}

/**
 * **What each calendar write records** (B1, the Phase 12 exit permission review): one `auditLog` row per
 * write that landed, so a write in a support session names both people — the support user who made it and
 * the member it was made as (`AuditService.record`, roles §3.13).
 */
export type CalendarAuditAction =
  | 'calendar_entry.created' | 'calendar_entry.updated' | 'calendar_entry.deleted'
  | 'calendar_entry.answered' | 'calendar_entry.block_placed';

/** What a delete answers. */
export interface CalendarDeleted {
  entryId: string;
  deletedAt: string;
}

/**
 * **The reader's own calendar settings** (ADR-0110; `GET` and `PUT /calendar/settings`). One today:
 * *Hide my personal activities*, off until the member turns it on.
 */
export interface CalendarSettings {
  hideDetails: boolean;
}

/** One timed thing on the reader's today, for Home's *Aksi hari ini* to fill up with (UI-100, UI-104 point 7). */
export interface CalendarTodayItem {
  kind: 'entry' | 'event';
  /** The calendar entry's id, or the event's. */
  id: string;
  title: string;
  /** A calendar entry's type code, or the event's type label as the office typed it. */
  type: string;
  start: string;
  end: string;
  startsAt: string;
}

/**
 * **The reader's today on their calendar, counted** (UI V1, UI-104 point 7; Home's *Jadwal hari ini* and *Aksi hari
 * ini*, UI-100). `CalendarService.today` — the read the Home endpoint calls, so the two screens count alike.
 */
export interface CalendarTodayView {
  today: LocalDate;
  /** **Timed things today** (*n meeting*): the reader's entries not declined — a trip of any kind left out — and the events they joined. */
  meetings: number;
  /** **Open Tugas today** (*Tugas n*): lead next actions and coaching action items due today, a ticked one excluded. */
  tasks: number;
  /** Today's Tugas, in the Agenda checklist's order. */
  taskItems: CalendarTaskView[];
  /** Today's timed things not yet ended, soonest first. */
  upcoming: CalendarTodayItem[];
}

/** The record a change of the settings leaves: ids and the setting, never anything typed. */
export const CALENDAR_SETTINGS_AUDIT_ACTION = 'calendar_settings.updated';

const ENTRY: ResourceName = 'Calendar entry';
const TIMING_FIELDS = ['date', 'start', 'end', 'startsOn', 'endsOn'] as const;

/**
 * **A member's calendar** (Phase 12; `functional/calendar.md`, the Data contract).
 *
 * One record per entry, read four ways: by its organiser, by the members on it, by the organiser's
 * leaders through compare, and — names only — through the people picker (`CalendarPeopleService`).
 * Three rules, applied route by route:
 *
 * 1. **Only the organiser writes an entry** (D-write). Anybody else — an attendee, an ancestor — is
 *    answered 404, so a refusal never confirms an entry to somebody who may not read it.
 * 2. **A leader's read of somebody else's calendar leaves a record** (D-audit, ADR-0093), and nothing in
 *    that read reaches above the reader's own line: an entry the compared member only attends is busy
 *    unless the reader could read it in their own right. **A member who hides their details**
 *    (*Hide my personal activities*, ADR-0110, their own setting on their membership) is read the same
 *    way in every pane: what they organised is busy to a reader who is not on it.
 * 3. **Days, weeks and months are the office's** (invariant §9), served by the read with its `today`
 *    and `now`, never worked out in the browser.
 *
 * **The order of refusals** is the contract's: the guard's 403; validation (400); reach (404); state
 * (409 `CALENDAR_BLOCK_NOT_ANSWERABLE`); the version (409). **Nothing here creates, edits or deletes a
 * coaching session** (ADR-0099, ADR-0081), and no entry counts as coaching.
 *
 * **Every write that lands leaves an `auditLog` row** (`CalendarAuditAction`): the entry's id and the
 * version it is at, and the member a block is placed on — never a title, a note or a name, since a title
 * can name a client (ADR-0093). A refused write records nothing.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly entries: CalendarEventRepository,
    private readonly memberships: MembershipRepository,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly orgLevels: OrgLevelService,
    private readonly days: TenantDay,
    private readonly notices: CalendarNotices,
    private readonly subjectReads: SubjectReadAudit,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly auto: CalendarAutoItems,
  ) {}

  // ------------------------------------------------------------------ reads

  /**
   * **`GET /calendar/entries`** (P12-T2, P12-T3, P12-T5): a week or a month of one calendar, with the
   * period's dates, ‹ and ›, the office's `today` and `now`.
   *
   * - **Without `for`**, the reader's own: every entry they organise and every one they attend but have
   *   not declined, each in full. Never audited: a self-read.
   * - **With `for`**, a compared pane: `COACH(reader, member)` resolved now, 404 outside it — a peer, a
   *   peer AAB's agent, another office's member, a member who left, nobody's id, and the reader
   *   themselves, since compare never reaches oneself. An empty `for` is the DTO's 400, never the
   *   reader's own calendar. A week or a month alike (*amended 2026-10-26, P18.95-T8 AC-2: it was Week
   *   only — the client asked for compare in Month, UI-020*). In *Who reads what*'s projection
   *   (`comparedView`), and one §3.5 entry, surface `calendar`, with the period's `from` and `to`,
   *   written last, so a refused read writes none. **Each organiser in the period who hides their
   *   details** (ADR-0110) is read in the same round trip as the names, so their entries go out as busy
   *   blocks to a reader who is not on them.
   */
  async read(ctx: RequestContext, query: CalendarReadQuery): Promise<CalendarPeriodView> {
    const me = requireMembership(ctx);
    const view = query.view ?? 'week';
    const compared = query.for !== undefined;
    const office = await this.days.office(ctx);
    const date = query.date ?? office.today;
    if (!isLocalDate(date)) refuseWith([CALENDAR_REFUSALS.VALIDATION_FAILED.dayShape({ field: 'date' })]);

    let subject = { membershipId: me, orgLevelCode: ctx.membership!.orgLevelCode };
    if (compared) {
      // Naming nobody is not naming oneself: the DTO refuses an empty `for` (400), and so does this.
      if (!query.for || query.for === me) throw new NotFoundException('Membership');
      subject = await this.coach.subject(ctx, query.for, 'calendar_entry:read');
    }

    const period = periodOf(view, date);
    const timezone = office.timezone;
    const start = startOfOfficeDay(timezone, period.from);
    const endExclusive = startOfOfficeDay(timezone, addDays(period.to, 1));
    const [rows, tasks, joined] = await Promise.all([
      this.entries.overlapping(ctx, onCalendarOf(subject.membershipId), start, endExclusive),
      // What other features put on the calendar, read from their sources now (UI-104 point 1).
      this.auto.tasksOf(ctx, subject.membershipId, period.from, period.to),
      this.auto.joinedEventsOf(ctx, subject.membershipId, start, endExclusive, timezone),
    ]);
    const [coaches, names, labels, hidden, phones] = await Promise.all([
      compared || rows.some((e) => e.type === 'coaching') ? this.coachedBy(ctx, me) : Promise.resolve(new Set<string>()),
      this.names.byMembershipId(ctx, [subject.membershipId, ...namedIn(rows)]),
      this.rungLabels(ctx, office),
      compared
        ? this.hidingDetails(ctx, [subject.membershipId, ...rows.map((e) => e.organiserMembershipId)])
        : Promise.resolve(new Set<string>()),
      // A compared person's number, for the one WhatsApp beside their tasks (UI-104 point 9).
      compared ? this.auto.phonesOf(ctx, [subject.membershipId]) : Promise.resolve(new Map<string, string>()),
    ]);
    const reader: Reader = { membershipId: me, coaches, names, timezone };
    const now = this.clock.now();
    const clock = officeClockOf(timezone, now);

    const answer: CalendarPeriodView = {
      ...period,
      today: office.today,
      now: { at: now.toISOString(), minute: clock.minute },
      subject: {
        membershipId: subject.membershipId,
        name: names.get(subject.membershipId) ?? '',
        rung: { code: subject.orgLevelCode, label: labels.get(subject.orgLevelCode) ?? subject.orgLevelCode },
        // A person who hides their details hides their number as well (the Phase 18.99 exit review, L2), as their tasks
        // and events go out as *Sibuk*: the WhatsApp beside their tasks is part of what they chose not to show.
        phone: hidden.has(subject.membershipId) ? null : phones.get(subject.membershipId) ?? null,
      },
      entries: rows.map((entry) => (compared
        ? comparedView(entry, subject.membershipId, reader, hidden)
        : entryView(entry, reader, standingOf(entry, me)!))),
      /*
       * **A member who hides their details** (ADR-0110, UI-104 point 9) is read by a leader as *Sibuk*: each task as its
       * day alone — a count — and each event they joined as a busy block at its time. Their own read is in full.
       */
      ...(compared && hidden.has(subject.membershipId)
        ? {
          tasks: tasks.map((task) => ({ busy: true as const, date: task.date })),
          events: joined.map((event) => ({
            busy: true as const,
            allDay: event.allDay, date: event.date, start: event.start, end: event.end,
            startsOn: event.startsOn, endsOn: event.endsOn, startsAt: event.startsAt, endsAt: event.endsAt,
          })),
        }
        : { tasks, events: joined }),
    };
    if (compared) {
      await this.subjectReads.record(ctx, { membershipId: subject.membershipId }, 'calendar', { from: period.from, to: period.to });
    }
    return answer;
  }

  /**
   * **`GET /calendar/entries/:entryId`** (P12-T2, P12-T4): its organiser, and each attendee whatever
   * their answer — declined and placed included, from a notice that opens it. **Not an ancestor**:
   * compare reads through `for` alone, the audited path. Anybody else, a deleted entry, nobody's id and
   * another office's are 404.
   */
  async readOne(ctx: RequestContext, entryId: string): Promise<CalendarEntryView> {
    const me = requireMembership(ctx);
    const entry = await this.entries.findOne(ctx, {
      _id: entryId, $or: [{ organiserMembershipId: me }, { 'attendees.membershipId': me }],
    } as FilterQuery<CalendarEventDocument>);
    if (!entry) throw new NotFoundException(ENTRY);
    return this.answerAs(ctx, entry, (await this.days.office(ctx)).timezone);
  }

  /**
   * **The reader's today, counted** (UI V1, 2026-10-30, UI-104 point 7): no route of its own — Home's endpoint calls it
   * (UI-100), so *Jadwal hari ini* counts what the Agenda draws for today. The office's today (invariant §9).
   *
   * - `meetings`: the reader's own entries on today that are not trips and not declined, and the events they joined that
   *   touch today. A trip is a line at the top of the day, not a meeting.
   * - `tasks`: today's open *Tugas* — the moment one is ticked it is gone from here, as from the Agenda.
   * - `upcoming`: today's timed things not yet ended, soonest first, for *Aksi hari ini* after its tasks.
   */
  async today(ctx: RequestContext): Promise<CalendarTodayView> {
    const me = requireMembership(ctx);
    const office = await this.days.office(ctx);
    const timezone = office.timezone;
    const start = startOfOfficeDay(timezone, office.today);
    const endExclusive = startOfOfficeDay(timezone, addDays(office.today, 1));
    const [rows, taskItems, joined] = await Promise.all([
      this.entries.overlapping(ctx, onCalendarOf(me), start, endExclusive),
      this.auto.tasksOf(ctx, me, office.today, office.today),
      this.auto.joinedEventsOf(ctx, me, start, endExclusive, timezone),
    ]);
    const timed = rows.filter((entry) => entry.type !== CALENDAR_ALL_DAY_TYPE);
    const now = this.clock.now();
    const upcoming: CalendarTodayItem[] = [
      ...timed.filter((entry) => entry.endsAt > now).map((entry) => entryItem(entry, timezone)),
      ...joined.filter((event) => new Date(event.endsAt) > now).map(eventItem),
    ].sort(soonestFirst);
    return { today: office.today, meetings: timed.length + joined.length, tasks: taskItems.length, taskItems, upcoming };
  }

  /**
   * **The reader's next timed things after today** (UI V1, UI-100 *Aksi hari ini*: *fill the rest with my next agenda
   * items — timed events, soonest first, from now on; today first, then the next days*). `today().upcoming` is today's.
   * This is the days after: the reader's calendar entries and **the events they joined** (UI-104 #1), soonest first, at
   * most `limit`. A trip is left out, as `today()` leaves it out: it is a line, never a meeting. There is no horizon:
   * the next one is the next one, however far off. Home reads it (T16); no route of its own.
   */
  async nextAfterToday(ctx: RequestContext, limit: number): Promise<(CalendarTodayItem & { date: LocalDate })[]> {
    if (limit <= 0) return [];
    const me = requireMembership(ctx);
    const office = await this.days.office(ctx);
    const timezone = office.timezone;
    const tomorrow = startOfOfficeDay(timezone, addDays(office.today, 1));
    const [rows, joined] = await Promise.all([
      this.entries.find(
        ctx,
        { $and: [onCalendarOf(me), { startsAt: { $gte: tomorrow } }, { type: { $ne: CALENDAR_ALL_DAY_TYPE } }] } as FilterQuery<CalendarEventDocument>,
        { sort: { startsAt: 1, _id: 1 }, limit },
      ),
      // Every joined event still to start: the reader's RSVPs are few, so no horizon is needed to keep the read small.
      this.auto.joinedEventsOf(ctx, me, tomorrow, NO_HORIZON, timezone),
    ]);
    const items = [
      ...rows.map((entry) => ({ ...entryItem(entry, timezone), date: officeClockOf(timezone, entry.startsAt).date })),
      ...joined.filter((event) => new Date(event.startsAt) >= tomorrow).map((event) => ({ ...eventItem(event), date: event.date })),
    ].sort(soonestFirst);
    return items.slice(0, limit);
  }

  /**
   * **`GET /calendar/settings`** (P13.1-T8, ADR-0110): the reader's own, and only theirs — the route
   * names nobody, so there is nobody else's to ask for. Never audited: a self-read.
   */
  async settings(ctx: RequestContext): Promise<CalendarSettings> {
    return { hideDetails: (await this.ownMembership(ctx)).calendarHideDetails === true };
  }

  // ------------------------------------------------------------------ writes

  /**
   * **`PUT /calendar/settings`** (P13.1-T8, ADR-0110): *Hide my personal activities*, written on the
   * reader's own membership. The route names nobody, so it reaches nobody else; a read-only support
   * session meets the guard's 403, as every calendar write does. The whole setting is sent, and sending
   * what is stored already answers it as it stands, writing and recording nothing.
   *
   * **A change leaves one `auditLog` row**, `calendar_settings.updated` on `memberships`: the member's id,
   * and the setting before and after — a yes or a no, nothing anybody typed. In a support session the row
   * names both people (§3.13), as every calendar write's does.
   */
  async saveSettings(ctx: RequestContext, input: CalendarSettings): Promise<CalendarSettings> {
    const mine = await this.ownMembership(ctx);
    const before = mine.calendarHideDetails === true;
    if (before === input.hideDetails) return { hideDetails: before };
    /*
     * **Conditional on what was read**, so only the save that turns the stored value over writes, and only
     * it is audited. Two saves from two devices can both read the same *before*: the second finds nothing
     * left to change and answers what is stored now, rather than a value it did not write — or a second row
     * recording the same change (the exit review's N1). A membership gone since the read answers 404 there.
     */
    const changed = await this.memberships.updateMany(
      ctx,
      { _id: mine._id, calendarHideDetails: before ? true : { $ne: true } },
      { $set: { calendarHideDetails: input.hideDetails } },
    );
    if (changed === 0) return this.settings(ctx);
    await this.audit.record(ctx, {
      action: CALENDAR_SETTINGS_AUDIT_ACTION,
      targetCollection: 'memberships',
      targetId: String(mine._id),
      targetMembershipId: String(mine._id),
      before: { hideDetails: before },
      after: { hideDetails: input.hideDetails },
    });
    return { hideDetails: input.hideDetails };
  }

  /**
   * **`POST /calendar/entries`** (P12-T2, P12-T4): the reader becomes its organiser, at `version: 1`.
   * Each invitee is recorded `pending` and told (`CALENDAR_INVITATION`) unless the entry has already
   * ended.
   */
  async create(ctx: RequestContext, input: CalendarEntryInput): Promise<CalendarEntryView> {
    const me = requireMembership(ctx);
    const office = await this.days.office(ctx);
    const fields = fieldsOf(input, input, office.timezone);
    const invitees = inviteesOf(input.inviteeIds ?? [], { reader: me });
    await this.requireInvitable(ctx, office, invitees);

    const now = this.clock.now();
    const created = await this.entries.create(ctx, {
      organiserMembershipId: me,
      ...fields,
      attendees: invitees.map((membershipId) => attendee(membershipId, now, false)),
      version: 1,
    } as Partial<CalendarEventDocument>);
    await this.record(ctx, 'calendar_entry.created', created);

    if (created.endsAt > now) {
      await this.notices.invited(ctx, String(created._id), officeDateOf(created, office.timezone), invitees);
    }
    return this.answerAs(ctx, created, office.timezone);
  }

  /**
   * **`PATCH /calendar/entries/:entryId`** (P12-T2 AC-8, P12-T4): by its organiser alone (D-write),
   * pinned to the `version` they read.
   *
   * - **Any field it sends replaces the stored one.** A change between Travel and a timed type sends the
   *   other's fields; within a kind, a time or a date sent alone is merged with the stored ones.
   * - **`inviteeIds`, when sent, is the whole invitation list**: an added member is invited, a dropped
   *   one leaves at once, and a kept one keeps their answer — the write is targeted, never the array
   *   written back (`CalendarEventRepository.editIfAt`). A block's member is never in it.
   * - **Who must be invitable depends on when the entry ends, as edited** (ADR-0094). **One that ends in
   *   the future** — however it got there — has every attendee checked: kept and added invitees, and the
   *   member a block is placed on. So moving a past entry into the future cannot carry a member who has
   *   since left onto a future entry, which leaving would have taken them off (D-leave; N1, the exit
   *   permission review). **One that ends in the past** has only an added member checked: a kept one is
   *   kept as they are, so a past entry keeps a member who has since left and its organiser saves it with
   *   the list they read — the leaver still on it, by name — while adding somebody who left is the 404 it
   *   always was (M1).
   * - **Notices**: an invitation to each member added; a `moved` change to each attendee who has not
   *   declined when the date or time of an entry that had not ended — before or after — changes.
   */
  async update(ctx: RequestContext, entryId: string, input: CalendarEntryEdit): Promise<CalendarEntryView> {
    const me = requireMembership(ctx);
    const entry = await this.organised(ctx, entryId, me);
    const office = await this.days.office(ctx);
    const timezone = office.timezone;

    const type = input.type ?? entry.type;
    const fields = fieldsOf({ ...input, type }, mergedTiming(entry, input, type, timezone), timezone, entry);
    const placed = entry.attendees.find((a) => a.placed)?.membershipId ?? null;
    const current = entry.attendees.filter((a) => !a.placed).map((a) => a.membershipId);
    const wanted = input.inviteeIds === undefined
      ? current
      : inviteesOf(input.inviteeIds, { reader: me, placed });
    const added = wanted.filter((id) => !current.includes(id));
    const now = this.clock.now();
    // Ending in the future, as edited, everybody on it is checked as they are now — the placed member
    // included — so a past entry moved forward cannot carry a leaver onto it (N1). Ending in the past, only
    // a member being added is: a kept one stays whatever they are now, so a past entry keeps a member who
    // has since left (D-leave) and its organiser can still edit it (M1).
    const checked = fields.endsAt > now ? [...(placed ? [placed] : []), ...wanted] : added;
    await this.requireInvitable(ctx, office, checked);
    if (input.version !== entry.version) throw new VersionConflictException(input.version, entry.version);

    const removed = current.filter((id) => !wanted.includes(id));
    const updated = await this.entries.editIfAt(
      ctx, entryId, { organiserMembershipId: me, version: input.version }, fields,
      { removed, added: added.map((id) => attendee(id, now, false)) }, now,
    );
    if (!updated) throw await this.whyNot(ctx, entryId, me, input.version);
    await this.record(ctx, 'calendar_entry.updated', updated);

    const id = String(updated._id);
    const date = officeDateOf(updated, timezone);
    const moved = entry.startsAt.getTime() !== updated.startsAt.getTime() || entry.endsAt.getTime() !== updated.endsAt.getTime();
    if (moved && (entry.endsAt > now || updated.endsAt > now)) {
      const told = updated.attendees
        .filter((a) => a.answer !== 'declined' && !added.includes(a.membershipId))
        .map((a) => a.membershipId);
      await this.notices.changed(ctx, id, date, 'moved', told);
    }
    if (updated.endsAt > now) await this.notices.invited(ctx, id, date, added);
    return this.answerAs(ctx, updated, timezone);
  }

  /**
   * **`DELETE /calendar/entries/:entryId?version=`** (P12-T2 AC-9): by its organiser alone, pinned.
   * `deletedAt` is set and the entry leaves every calendar it was on (invariant §6). Each attendee who
   * has not declined is told (`cancelled`) unless it had already ended.
   */
  async remove(ctx: RequestContext, entryId: string, version: number): Promise<CalendarDeleted> {
    const me = requireMembership(ctx);
    const entry = await this.organised(ctx, entryId, me);
    if (version !== entry.version) throw new VersionConflictException(version, entry.version);

    const now = this.clock.now();
    const deleted = await this.entries.deleteIfAt(ctx, entryId, { organiserMembershipId: me, version }, now);
    if (!deleted) throw await this.whyNot(ctx, entryId, me, version);
    await this.record(ctx, 'calendar_entry.deleted', deleted);

    if (entry.endsAt > now) {
      const { timezone } = await this.days.office(ctx);
      await this.notices.changed(ctx, String(entry._id), officeDateOf(entry, timezone), 'cancelled', toldOf(entry));
    }
    return { entryId: String(deleted._id), deletedAt: (deleted.deletedAt as Date).toISOString() };
  }

  /**
   * **`POST /calendar/entries/:entryId/answer`** (P12-T4 AC-5, ADR-0097): an invitee, for themselves —
   * their own answer and nothing else, no version, so it never conflicts with an edit. Not on it — its
   * organiser included — deleted or nobody's: 404. **The member a block was placed on** is on it, and
   * is refused: 409 `CALENDAR_BLOCK_NOT_ANSWERABLE` (ADR-0098).
   */
  async answer(ctx: RequestContext, entryId: string, answer: Exclude<CalendarAnswer, 'pending'>): Promise<CalendarEntryView> {
    const me = requireMembership(ctx);
    const entry = await this.entries.findOne(ctx, {
      _id: entryId, 'attendees.membershipId': me,
    } as FilterQuery<CalendarEventDocument>);
    if (!entry) throw new NotFoundException(ENTRY);
    if (entry.attendees.some((a) => a.membershipId === me && a.placed)) {
      throw new DomainException(
        ErrorCode.CALENDAR_BLOCK_NOT_ANSWERABLE,
        CALENDAR_REFUSALS.CALENDAR_BLOCK_NOT_ANSWERABLE.placedByLeader,
        HttpStatus.CONFLICT,
        { entryId },
      );
    }
    const updated = await this.entries.answer(ctx, entryId, me, answer, this.clock.now());
    if (!updated) throw new NotFoundException(ENTRY);
    await this.record(ctx, 'calendar_entry.answered', updated);
    await this.notices.answered(ctx, entryId, me);
    return this.answerAs(ctx, updated, (await this.days.office(ctx)).timezone);
  }

  /**
   * **`POST /calendar/blocks`** (P12-T5 AC-6, ADR-0098): *Block time* — the leader's own entry, with the
   * member a fixed attendee recorded as placed, on both calendars. `COACH(reader, member)` when the
   * request is made, 404 outside it: a peer AAB's agent, another office's member, a member who left, the
   * reader, nobody's id. Others may be invited beside the member, never the member or the reader. No
   * conflict check, as the prototype has none.
   *
   * **The member is told, exactly once** (`CALENDAR_BLOCK_PLACED`, exit criterion 3) — **always**, a
   * block on a slot that has already ended included: blocking time on somebody's calendar is news to them
   * whenever it is. Each other invitee is invited unless it has ended, as `create` does, and the leader is
   * told nothing. A refused block has written nothing and told nobody.
   */
  async block(ctx: RequestContext, input: CalendarBlockInput): Promise<CalendarEntryView> {
    const me = requireMembership(ctx);
    const office = await this.days.office(ctx);
    const fields = fieldsOf(input, input, office.timezone);
    const invitees = inviteesOf(input.inviteeIds ?? [], { reader: me, placed: input.membershipId });
    const member = await this.coach.coachee(ctx, me, input.membershipId);
    if (!member) throw new NotFoundException('Membership');
    await this.requireInvitable(ctx, office, invitees);

    const now = this.clock.now();
    const created = await this.entries.create(ctx, {
      organiserMembershipId: me,
      ...fields,
      attendees: [
        attendee(input.membershipId, now, true),
        ...invitees.map((membershipId) => attendee(membershipId, now, false)),
      ],
      version: 1,
    } as Partial<CalendarEventDocument>);
    await this.record(ctx, 'calendar_entry.block_placed', created);

    const id = String(created._id);
    const date = officeDateOf(created, office.timezone);
    await this.notices.placed(ctx, id, date, input.membershipId);
    if (created.endsAt > now) await this.notices.invited(ctx, id, date, invitees);
    return this.answerAs(ctx, created, office.timezone);
  }

  // ------------------------------------------------------------------ helpers

  /**
   * **A write that landed, recorded** (B1): its entry and the version it is at, and the member a block is
   * placed on as `targetMembershipId` — the leader's write on somebody else's calendar — else nobody. Ids
   * and the version only: no title, no notes, no name. `AuditService.record` adds the actor — both people
   * in a support session — and catches its own failure, so the write it describes is never undone by it;
   * the same seam leads and goals record through.
   */
  private async record(ctx: RequestContext, action: CalendarAuditAction, entry: CalendarEventDocument): Promise<void> {
    await this.audit.record(ctx, {
      action,
      targetCollection: 'calendarEvents',
      targetId: String(entry._id),
      targetMembershipId: entry.attendees.find((a) => a.placed)?.membershipId ?? null,
      after: { version: entry.version },
    });
  }

  /** An entry the reader organises, or the 404 everybody else gets — an attendee and an ancestor included. */
  private async organised(ctx: RequestContext, entryId: string, me: string): Promise<CalendarEventDocument> {
    const entry = await this.entries.findOne(ctx, {
      _id: entryId, organiserMembershipId: me,
    } as FilterQuery<CalendarEventDocument>);
    if (!entry) throw new NotFoundException(ENTRY);
    return entry;
  }

  /**
   * The reader's own membership, read through the office's scope: a context whose membership is not this
   * office's finds nothing and is 404, so the settings never reach across offices.
   */
  private async ownMembership(ctx: RequestContext): Promise<MembershipDocument> {
    const mine = await this.memberships.findById(ctx, requireMembership(ctx));
    if (!mine) throw new NotFoundException('Membership');
    return mine;
  }

  /**
   * **Who among these hides their entries' details** (ADR-0110): one scoped read of the memberships with
   * *Hide my personal activities* on. An id that is nobody's finds nothing.
   */
  private async hidingDetails(ctx: RequestContext, ids: readonly string[]): Promise<Set<string>> {
    const asked = [...new Set(ids)].filter((id) => isValidObjectId(id));
    const found = await this.memberships.find(ctx, { _id: { $in: asked }, calendarHideDetails: true });
    return new Set(found.map((m) => String(m._id)));
  }

  /** A pinned write matched nothing: the entry is gone (404), or it moved on (409). */
  private async whyNot(ctx: RequestContext, entryId: string, me: string, version: number): Promise<DomainException> {
    const now = await this.entries.findOne(ctx, {
      _id: entryId, organiserMembershipId: me,
    } as FilterQuery<CalendarEventDocument>);
    return now ? new VersionConflictException(version, now.version) : new NotFoundException(ENTRY);
  }

  /** One entry as the reader stands to it: organiser, invitee or placed. */
  private async answerAs(ctx: RequestContext, entry: CalendarEventDocument, timezone: string): Promise<CalendarEntryView> {
    const me = ctx.membershipId as string;
    const [coaches, names] = await Promise.all([
      entry.type === 'coaching' ? this.coachedBy(ctx, me) : Promise.resolve(new Set<string>()),
      this.names.byMembershipId(ctx, namedIn([entry])),
    ]);
    return entryView(entry, { membershipId: me, coaches, names, timezone }, standingOf(entry, me)!);
  }

  /**
   * Everybody the reader coaches now — **when their role holds the downline read**. An Agent coaches
   * nobody on the calendar, as in coaching, whatever the tree says: no chip of theirs opens a session.
   */
  private async coachedBy(ctx: RequestContext, me: string): Promise<Set<string>> {
    if (scopeFor(ctx, 'calendar_entry:read') !== 'own-downline') return new Set();
    return new Set((await this.coach.coacheesOf(ctx, me)).map((c) => c.membershipId));
  }

  /** The company's ladder labels, by code. */
  private async rungLabels(ctx: RequestContext, office: Office): Promise<Map<string, string>> {
    const ladder = office.companyId ? await this.orgLevels.list(ctx, office.companyId) : [];
    return new Map(ladder.map((level) => [level.code, level.label]));
  }

  /**
   * **Each invitee an active field member of the office** (ADR-0094): a membership of this office,
   * `active`, on a rung of the company's ladder. Every id that is not — another office's, a member who
   * left or is pending, an Owner or Admin on no rung, nobody's — is named in `details.inviteeIds`, with
   * the one answer for all of them, so the refusal confirms nobody's existence.
   */
  private async requireInvitable(ctx: RequestContext, office: Office, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const codes = [...(await this.rungLabels(ctx, office)).keys()];
    const found = await this.memberships.find(ctx, {
      _id: { $in: ids.filter((id) => isValidObjectId(id)) }, status: 'active', orgLevelCode: { $in: codes },
    });
    const invitable = new Set(found.map((m) => String(m._id)));
    const missing = ids.filter((id) => !invitable.has(id));
    if (missing.length) throw new NotFoundException('Membership', { inviteeIds: missing });
  }
}

/** The caller's own membership, or the refusal that says what to do about it. */
function requireMembership(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}

/**
 * **A timed entry as *Aksi hari ini* lists it** (UI-100, UI-104 point 7): its times on the office's wall clock, an end at
 * the next midnight `00:00` as `officeTimingOf` answers it. Never a trip: `today` and `nextAfterToday` leave trips out.
 */
function entryItem(entry: CalendarEventDocument, timezone: string): CalendarTodayItem {
  return {
    kind: 'entry', id: String(entry._id), title: entry.title, type: entry.type,
    start: officeClockOf(timezone, entry.startsAt).time, end: officeClockOf(timezone, entry.endsAt).time,
    startsAt: entry.startsAt.toISOString(),
  };
}

/** **A joined event as *Aksi hari ini* lists it** (UI-104 point 1): its times, and its type's label as the office typed it. */
function eventItem(event: JoinedEvent): CalendarTodayItem {
  return {
    kind: 'event', id: event.eventId, title: event.title, type: event.type.label,
    start: event.start, end: event.end, startsAt: event.startsAt,
  };
}

/** Soonest first, and by id on a tie, so two reads never shuffle: `today`'s and `nextAfterToday`'s order. */
function soonestFirst(a: CalendarTodayItem, b: CalendarTodayItem): number {
  return a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);
}

/** A member's calendar: every entry they organise, and every one they attend but have not declined. */
/** The far end of a read with no horizon: the latest instant a `Date` holds. */
const NO_HORIZON = new Date(8_640_000_000_000_000);

function onCalendarOf(membershipId: string): FilterQuery<CalendarEventDocument> {
  return {
    $or: [
      { organiserMembershipId: membershipId },
      { attendees: { $elemMatch: { membershipId, answer: { $ne: 'declined' } } } },
    ],
  } as FilterQuery<CalendarEventDocument>;
}

/** An attendee as added now: an invitee `pending`, or the placed member with no answer. */
function attendee(membershipId: string, now: Date, placed: boolean): CalendarAttendee {
  return { membershipId, placed, answer: placed ? null : 'pending', answeredAt: null, addedAt: now };
}

/** Everybody on an entry who is told it changed: every attendee who has not declined. */
function toldOf(entry: CalendarEventDocument): string[] {
  return entry.attendees.filter((a) => a.answer !== 'declined').map((a) => a.membershipId);
}

/**
 * **The stored fields of an entry**, or 400 `VALIDATION_FAILED` naming every rule broken: the timing
 * (`timingOf`), and the title and notes trimmed. On an edit, a title or notes not sent keep the stored
 * ones.
 */
function fieldsOf(
  input: Pick<CalendarEntryInput, 'type' | 'title' | 'notes'>,
  timing: TimingInput,
  timezone: string,
  stored?: CalendarEventDocument,
): CalendarEntryFields {
  const checked = timingOf(input.type, timing, timezone);
  if ('violations' in checked) refuseWith(checked.violations);
  const text = (sent: string | null | undefined, kept: string | undefined) =>
    (sent === undefined ? kept ?? '' : (sent ?? '').trim());
  return {
    type: input.type,
    title: text(input.title, stored?.title),
    notes: text(input.notes, stored?.notes),
    ...checked.timing,
  };
}

/**
 * **An edit's timing**: within a kind — timed to timed, an all-day trip to an all-day trip, a trip with times to a
 * trip with times (UI V1, UI-104 point 8) — the stored office timing with any field sent laid over it; across kinds,
 * only what was sent, since the new kind's fields cannot be inferred. A field of the other kind that was sent is kept,
 * so `timingOf` refuses it. A trip's `allDay` not sent keeps the stored one; a type changed to Travel starts all-day.
 */
function mergedTiming(
  entry: CalendarEventDocument, input: TimingInput, type: CalendarEntryType, timezone: string,
): TimingInput {
  const travel = type === CALENDAR_ALL_DAY_TYPE;
  const wasTravel = entry.type === CALENDAR_ALL_DAY_TYPE;
  const allDay = travel && (input.allDay ?? (wasTravel ? isAllDayTrip(entry) : true)) !== false;
  const kindOf = (isTravel: boolean, isAllDay: boolean) => (!isTravel ? 'timed' : isAllDay ? 'trip' : 'timed_trip');
  const sameKind = kindOf(travel, allDay) === kindOf(wasTravel, isAllDayTrip(entry));
  const stored = officeTimingOf(entry, timezone);
  const merged: TimingInput = !sameKind ? {}
    : !travel ? { date: stored.date, start: stored.start, end: stored.end }
      : allDay ? { startsOn: stored.startsOn, endsOn: stored.endsOn }
        : { startsOn: stored.startsOn, start: stored.start, endsOn: stored.endsOn, end: stored.end };
  for (const field of TIMING_FIELDS) {
    if (input[field] !== undefined) merged[field] = input[field];
  }
  // A timed type sent `allDay: true` is passed on, so `timingOf` refuses it rather than this ignoring it.
  merged.allDay = travel ? allDay : input.allDay;
  return merged;
}

/**
 * **An invitation list's own rules** (400): never the reader, and never the member a block is placed on —
 * that member is placed, not invited, and no list names them. Distinct and at most 50 the DTO has said.
 */
function inviteesOf(ids: readonly string[], not: { reader: string; placed?: string | null }): string[] {
  const violations: FieldSentence[] = [];
  if (ids.includes(not.reader)) violations.push(CALENDAR_REFUSALS.VALIDATION_FAILED.inviteeSelf);
  if (not.placed && ids.includes(not.placed)) {
    violations.push(CALENDAR_REFUSALS.VALIDATION_FAILED.inviteePlaced);
  }
  if (violations.length) refuseWith(violations);
  return [...ids];
}

