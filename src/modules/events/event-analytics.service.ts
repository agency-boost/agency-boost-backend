import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { requireOfficeSteward } from '@/common/auth/office-steward';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException } from '@/common/errors/domain.exception';
import { endOfMonth, type LocalDate } from '@/common/time/local-day';
import { EVENT_KEHADIRAN } from '@/domain/constants';
import {
  feedbackFigure, isRecorded, kehadiranFigure, kehadiranMark, memberKehadiran,
  type FeedbackFigure, type KehadiranFigure, type KehadiranMark, type KehadiranTone,
} from '@/domain/metrics/event-kehadiran';
import { wholePercent } from '@/domain/metrics/rate';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { OfficeGroups, type InformalPartition } from '@/modules/reporting/office-groups';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { EventAudienceReader } from './event-audience';
import type { EventDocument, EventTypeDocument } from './event.schema';
import { EventFeedbackRepository, EventRepository, EventRsvpRepository, EventTypeRepository } from './event.repository';
import { NPS_CONSTANTS, type NpsConstants } from './event-guest.service';
import { EventReadings, type EventAttendance } from './event-readings';
import { EVENTS_REFUSALS } from './events.messages';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A person as every list on the tab draws them: photo, the orange AB / AAB label, the NAME. */
export interface EventPersonRef {
  membershipId: string;
  name: string;
  photoUrl: string | null;
  /** The membership's role: `ab`, `aab` or `agent`. */
  role: string;
}

/** The period the tab reads: the year to date, or one month. */
export interface EventPeriod {
  kind: 'ytd' | 'month';
  /** `YYYY-MM` when a month was asked for. */
  month: string | null;
  from: LocalDate;
  to: LocalDate;
}

/** An event as both parts name it. */
export interface EventRef {
  eventId: string;
  title: string;
  type: { code: string; label: string };
  /** The office day it starts on. */
  startsOn: LocalDate;
}

/** One past event of the period, newest first. `figure` is `null` until its roll call is taken (`recorded`). */
export interface PastEventRow extends EventRef {
  recorded: boolean;
  figure: KehadiranFigure | null;
}

/** One planned event (not ended), soonest first, and the answers to its invitation. */
export interface UpcomingEventRow extends EventRef {
  startsAt: string;
  /** Office days from today to its start: 0 today (and while it runs), 1 *Besok*, n *n hari lagi*. */
  daysUntil: number;
  running: boolean;
  /** *Akan ikut*: RSVP'd going. */
  going: string[];
  /** *Tidak ikut*: said they will not come, with the reason they gave. */
  declined: { membershipId: string; reason: string | null }[];
  /** *Belum jawab*: in its audience, no answer. */
  pending: string[];
}

/** One member over the period (*Per orang*), and the people the per-event lists name. */
export interface KehadiranPerson extends EventPersonRef {
  /** Their WhatsApp number; `null` without one, and for somebody who has left. */
  phone: string | null;
  /** Still a member: listed in *Per orang*. Somebody who has left is only named in a past event's lists. */
  current: boolean;
  /** One mark per `past` event, in its order: `1` hadir, `0` tidak hadir, `.` not expected, `?` not recorded. */
  marks: string;
  attended: number;
  expected: number;
  pct: number | null;
  tone: KehadiranTone | null;
  recentAttended: number;
  recentExpected: number;
  /** The newest event of the period they attended; `null` for none. */
  lastEventId: string | null;
  /** *Terakhir hadir* in red: more than three events they were expected at since. */
  stale: boolean;
  /** Under half: offered WhatsApp. */
  underHalf: boolean;
}

/** A group's or an AB group's attendance: over the whole period, over the recent events, and at each past event. */
export interface KehadiranGroupFigures {
  /** The navy card's tile: every recorded event of the period, whole numbers. */
  period: KehadiranFigure;
  /** *Rata-rata · n event terakhir*: the last `RECENT_EVENTS` recorded events, to one decimal. */
  recent: KehadiranFigure;
  /** One per `past` event, in its order; `null` for an event not recorded. */
  byEvent: (KehadiranFigure | null)[];
}

export interface KehadiranAbGroup extends KehadiranGroupFigures {
  ab: EventPersonRef;
  /** Its people now. */
  people: number;
}

export interface KehadiranGroupCard extends KehadiranGroupFigures {
  /** The group's id, or `none` for *Tanpa group*. */
  key: string;
  group: { groupId: string; name: string } | null;
  leaders: EventPersonRef[];
  people: number;
  abGroups: KehadiranAbGroup[];
}

/** **`GET /kpm/advanced-analytics/events/attendance`** — *Kehadiran*. */
export interface KehadiranView {
  period: EventPeriod;
  currentMonth: string;
  /** The office's members now, test accounts never counted — *"· 30 anggota"*. */
  members: number;
  /** How many of the period's past events have a roll call — the *n event* every average is over. */
  recordedEvents: number;
  /** How many events *Rata-rata · n event terakhir* is over. */
  recentEvents: number;
  /** Every recorded event of the period: *"rata-rata 18 dari 30 anggota hadir per event"*. */
  summary: KehadiranFigure;
  past: PastEventRow[];
  upcoming: UpcomingEventRow[];
  groups: KehadiranGroupCard[];
  people: KehadiranPerson[];
  /** May the reader take the roll call (`event_attendance:confirm`, never in a read-only session)? */
  canRecord: boolean;
}

/** An attendee's own words, tagged by their rung, never named. */
export interface FeedbackQuote {
  role: 'leader' | 'agent';
  text: string;
}

export interface FeedbackEventRow extends EventRef, FeedbackFigure {
  recorded: boolean;
  /** *Kenapa memberi nilai ini*. */
  why: FeedbackQuote[];
  /** *Yang bisa diperbaiki*. */
  improve: FeedbackQuote[];
}

/** **`GET /kpm/advanced-analytics/events/feedback`** — *Feedback*. */
export interface EventFeedbackView {
  period: EventPeriod;
  currentMonth: string;
  /** How many past events the period holds. */
  events: number;
  /** Every counted answer of the period, pooled. */
  summary: FeedbackFigure & {
    /** The people hadir across the period's recorded events — *"121 dari 206 yang hadir memberi feedback"*. */
    hadir: number;
    /** `answers / hadir` as a whole percent; `null` with nobody hadir. */
    share: number | null;
  };
  /** Lowest NPS first; an event with none last; newest first among equals. */
  rows: FeedbackEventRow[];
  /** The NPS scale and its buckets' edges, for the legend (invariant §7: served, never re-declared). */
  constants: NpsConstants;
}

/** What one read of the period's past events holds. */
interface PastRead {
  office: { today: LocalDate; month: string; timezone: string };
  period: EventPeriod;
  past: EventDocument[];
  attendance: Map<string, EventAttendance>;
  types: Map<string, EventTypeDocument>;
}

/**
 * **Advanced analytics › *Event*** (P19.25-T1, T2; ADR-0281): *Kehadiran* — who came to the office's events, by event, by
 * informal group and by person, and who means to come to the next ones — and *Feedback* — what those who came thought,
 * with no survey to send.
 *
 * - **Who:** the KPM's stewards (`requireOfficeSteward`, ADR-0268 §1): the Super Admin inside the KPM, the Owner, an
 *   Admin, a core leader; any other member `404`, nobody in a KPM `TENANT_NO_MEMBERSHIP`.
 * - **Expected** is each event's audience as at its start (ADR-0039), test accounts never counted (ADR-0267 §1);
 *   **hadir** the roll call's (`EVENT_ATTENDANCE_STATUS = attended`, ADR-0138); an event nobody has taken the roll call
 *   of is *not recorded* and in no average (`EVENT_KEHADIRAN`).
 * - **Groups** are the informal groups as they stand today (`OfficeGroups.partition`, ADR-0270 §1): a member counts in
 *   their group now, and somebody who has left counts in the KPM's figures and in no group's.
 * - **Planned events** are the office's events that have not ended (a running one with them), and their answers the
 *   members' RSVPs: *Akan ikut*, *Tidak ikut* with its reason, *Belum jawab* (ADR-0281 §2).
 * - **Feedback** counts the answers of those who were hadir (`EVENT_NPS`, ADR-0138 §6); the words are tagged *Leader* or
 *   *Agent* and never name their author (ADR-0281 §5, amending ADR-0141).
 *
 * Every read through the tenant repositories (invariant §1); a fixed number of queries for any number of events.
 */
@Injectable()
export class EventAnalytics {
  constructor(
    private readonly events: EventRepository,
    private readonly types: EventTypeRepository,
    private readonly rsvps: EventRsvpRepository,
    private readonly feedback: EventFeedbackRepository,
    private readonly readings: EventReadings,
    private readonly audiences: EventAudienceReader,
    private readonly groups: OfficeGroups,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly tenantDay: TenantDay,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------------ Kehadiran

  async attendance(ctx: RequestContext, query: { month?: string }): Promise<KehadiranView> {
    requireOfficeSteward(ctx, 'Advanced analytics');
    const read = await this.readPast(ctx, query.month);
    const { office, period, past, attendance, types } = read;
    const now = this.clock.now();
    const [open, partition] = await Promise.all([
      this.events.find(ctx, { status: 'active', endsAt: { $gt: now } }, { sort: { startsAt: 1, _id: 1 } }),
      this.groups.partition(ctx),
    ]);

    // Each past event, newest first: its counted audience, who was hadir, whether its roll call was taken.
    const facts = past.map((event) => {
      const reading = attendance.get(String(event._id));
      const rows = reading?.rows ?? [];
      const recorded = isRecorded(rows.map((r) => r.status));
      const statusOf = new Map(rows.map((r) => [r.membershipId, r.status]));
      return { event, rows, recorded, statusOf };
    });
    const pastRows: PastEventRow[] = facts.map(({ event, rows, recorded }) => ({
      ...this.ref(event, types, office.timezone),
      recorded,
      figure: recorded
        ? kehadiranFigure([{ hadir: rows.filter((r) => r.status === 'attended').length, expected: rows.length }], 0)
        : null,
    }));
    const recordedFacts = facts.filter((f) => f.recorded);
    const summary = kehadiranFigure(
      recordedFacts.map((f) => ({ hadir: f.rows.filter((r) => r.status === 'attended').length, expected: f.rows.length })), 0,
    );

    // The people: every member now, then everybody who has left and was expected at one of the period's events.
    const current = [...partition.members.keys()];
    const inAudiences = new Set(facts.flatMap((f) => f.rows.map((r) => r.membershipId)));
    const leavers = [...inAudiences].filter((id) => !partition.members.has(id));
    const leaverRoles = leavers.length === 0
      ? new Map<string, string>()
      : new Map((await this.memberships.find(ctx, { _id: { $in: leavers } }, { projection: { role: 1 } }))
        .map((m) => [String(m._id), m.role]));
    const ids = [...current, ...leavers];
    const pictured = await this.names.pictured(ctx, ids, ids, { phones: true });
    const roleOf = (id: string) => partition.members.get(id)?.role ?? leaverRoles.get(id) ?? 'agent';
    const personRef = (id: string): EventPersonRef => ({
      membershipId: id, name: pictured.get(id)?.name ?? '', photoUrl: pictured.get(id)?.photoUrl ?? null, role: roleOf(id),
    });

    const marksOf = new Map<string, KehadiranMark[]>(ids.map((id) => [id, facts.map(({ recorded, statusOf }) => (
      kehadiranMark(statusOf.has(id), recorded, statusOf.get(id) ?? null)
    ))]));
    const people: KehadiranPerson[] = ids.map((id) => {
      const marks = marksOf.get(id)!;
      const standing = memberKehadiran(marks);
      return {
        ...personRef(id),
        phone: pictured.get(id)?.phone ?? null,
        current: partition.members.has(id),
        marks: marks.join(''),
        attended: standing.attended,
        expected: standing.expected,
        pct: standing.pct,
        tone: standing.tone,
        recentAttended: standing.recentAttended,
        recentExpected: standing.recentExpected,
        lastEventId: standing.lastIndex === null ? null : String(past[standing.lastIndex]._id),
        stale: standing.stale,
        underHalf: standing.underHalf,
      };
    });

    const groups = this.groupCards(partition, facts.map((f) => f.recorded), marksOf, personRef);
    const upcoming = await this.upcoming(ctx, open, types, office, now);

    return {
      period,
      currentMonth: office.month,
      members: partition.members.size,
      recordedEvents: recordedFacts.length,
      recentEvents: Math.min(EVENT_KEHADIRAN.RECENT_EVENTS, recordedFacts.length),
      summary,
      past: pastRows,
      upcoming,
      groups,
      people,
      // The roll call's own grant — which a read-only session does not hold by its verb.
      canRecord: can(ctx, 'event_attendance:confirm'),
    };
  }

  // ------------------------------------------------------------------------------------------------- Feedback

  async feedbackView(ctx: RequestContext, query: { month?: string }): Promise<EventFeedbackView> {
    requireOfficeSteward(ctx, 'Advanced analytics');
    const { office, period, past, attendance, types } = await this.readPast(ctx, query.month);
    const ids = past.map((e) => String(e._id));
    const answers = ids.length === 0
      ? []
      : await this.feedback.find(ctx, { eventId: { $in: ids } }, { sort: { submittedAt: 1, _id: 1 } });
    const authors = [...new Set(answers.map((a) => a.membershipId))];
    const roles = authors.length === 0
      ? new Map<string, string>()
      : new Map((await this.memberships.find(ctx, { _id: { $in: authors } }, { projection: { role: 1 } }))
        .map((m) => [String(m._id), m.role]));
    const tag = (id: string): 'leader' | 'agent' => (roles.get(id) === 'ab' || roles.get(id) === 'aab' ? 'leader' : 'agent');

    let hadirTotal = 0;
    const pooled: number[] = [];
    const rows: FeedbackEventRow[] = past.map((event) => {
      const id = String(event._id);
      const reading = attendance.get(id);
      const rowsOf = reading?.rows ?? [];
      const recorded = isRecorded(rowsOf.map((r) => r.status));
      const hadir = new Set(rowsOf.filter((r) => r.status === 'attended').map((r) => r.membershipId));
      if (recorded) hadirTotal += hadir.size;
      // Counted: an answer of somebody hadir — the roll call's, as the official NPS has counted since ADR-0138 §6.
      const counted = answers.filter((a) => a.eventId === id && hadir.has(a.membershipId));
      pooled.push(...counted.map((a) => a.score));
      const words = (field: 'why' | 'improve') => counted
        .filter((a) => (a[field] ?? '').trim() !== '')
        .map((a): FeedbackQuote => ({ role: tag(a.membershipId), text: a[field].trim() }));
      return {
        ...this.ref(event, types, office.timezone),
        recorded,
        ...feedbackFigure(counted.map((a) => a.score)),
        why: words('why'),
        improve: words('improve'),
      };
    });
    const order = new Map(past.map((e, i) => [String(e._id), i]));
    rows.sort((a, b) => {
      if (a.nps === null || b.nps === null) return a.nps === null ? (b.nps === null ? order.get(a.eventId)! - order.get(b.eventId)! : 1) : -1;
      return a.nps - b.nps || order.get(a.eventId)! - order.get(b.eventId)!;
    });
    const summary = feedbackFigure(pooled);
    return {
      period,
      currentMonth: office.month,
      events: past.length,
      summary: {
        ...summary,
        hadir: hadirTotal,
        share: hadirTotal === 0 ? null : wholePercent(summary.answers, hadirTotal),
      },
      rows,
      constants: NPS_CONSTANTS,
    };
  }

  // ------------------------------------------------------------------------------------------------- parts

  /** The period asked for, the office's day, the period's past events newest first, their attendance, the types. */
  private async readPast(ctx: RequestContext, month: string | undefined): Promise<PastRead> {
    const office = await this.tenantDay.office(ctx);
    const period = periodOf(month, office);
    const now = this.clock.now();
    const [past, types] = await Promise.all([
      this.events.find(ctx, {
        status: 'active',
        startsAt: {
          $gte: this.clock.startOfLocalDay(office.timezone, period.from),
          $lt: this.clock.endOfLocalDay(office.timezone, period.to),
        },
        endsAt: { $lte: now },
      }, { sort: { startsAt: -1, _id: -1 } }),
      this.types.find(ctx, {}),
    ]);
    const attendance = past.length === 0
      ? new Map<string, EventAttendance>()
      : await this.readings.attendanceOfMany(ctx, past.map((e) => String(e._id)));
    return { office, period, past, attendance, types: new Map(types.map((t) => [t.code, t])) };
  }

  /** The events not yet ended, and each one's answers from its audience now (test accounts not counted). */
  private async upcoming(
    ctx: RequestContext,
    open: EventDocument[],
    types: Map<string, EventTypeDocument>,
    office: { today: LocalDate; timezone: string },
    now: Date,
  ): Promise<UpcomingEventRow[]> {
    if (open.length === 0) return [];
    const questions = open.map((event) => this.readings.questionOf(event));
    const [audience, answers] = await Promise.all([
      this.audiences.read(ctx, questions),
      this.rsvps.find(ctx, { eventId: { $in: open.map((e) => String(e._id)) } }),
    ]);
    const answerOf = new Map(answers.map((a) => [`${a.eventId}:${a.membershipId}`, a]));
    return open.map((event, i) => {
      const id = String(event._id);
      const ref = this.ref(event, types, office.timezone);
      const going: string[] = [];
      const declined: UpcomingEventRow['declined'] = [];
      const pending: string[] = [];
      for (const membershipId of audience.countedAudienceOf(questions[i])) {
        const answer = answerOf.get(`${id}:${membershipId}`);
        if (answer?.rsvpStatus === 'going') going.push(membershipId);
        else if (answer?.rsvpStatus === 'cancelled') declined.push({ membershipId, reason: answer.declineReason ?? null });
        else pending.push(membershipId);
      }
      return {
        ...ref,
        startsAt: event.startsAt.toISOString(),
        daysUntil: Math.max(0, dayCount(office.today, ref.startsOn)),
        running: event.startsAt.getTime() <= now.getTime(),
        going,
        declined,
        pending,
      };
    });
  }

  /**
   * The informal groups' cards, A to Z, then *Tanpa group* when an AB has none: each group's and each of its AB groups'
   * attendance — the members now, by their marks.
   */
  private groupCards(
    partition: InformalPartition,
    recorded: readonly boolean[],
    marksOf: Map<string, KehadiranMark[]>,
    personRef: (id: string) => EventPersonRef,
  ): KehadiranGroupCard[] {
    const recentIndexes = recorded.map((r, i) => (r ? i : -1)).filter((i) => i >= 0).slice(0, EVENT_KEHADIRAN.RECENT_EVENTS);
    const figures = (memberIds: readonly string[]): KehadiranGroupFigures => {
      const at = (i: number) => {
        let hadir = 0;
        let expected = 0;
        for (const id of memberIds) {
          const mark = marksOf.get(id)?.[i];
          if (mark === '1') { hadir += 1; expected += 1; } else if (mark === '0') expected += 1;
        }
        return { hadir, expected };
      };
      const perEvent = recorded.map((r, i) => (r ? at(i) : null));
      return {
        period: kehadiranFigure(perEvent.filter((e): e is { hadir: number; expected: number } => e !== null), 0),
        recent: kehadiranFigure(recentIndexes.map((i) => perEvent[i]!), 1),
        byEvent: perEvent.map((e) => (e === null ? null : kehadiranFigure([e], 0))),
      };
    };
    const abGroups = (abIds: readonly string[]): KehadiranAbGroup[] => abIds.map((ab) => {
      const memberIds = partition.abGroups.get(ab)?.memberIds ?? [ab];
      return { ab: personRef(ab), people: memberIds.length, ...figures(memberIds) };
    });
    const cards: KehadiranGroupCard[] = partition.groups.map((g) => {
      const memberIds = this.groups.peopleOf(partition, g.abIds);
      return {
        key: g.groupId,
        group: { groupId: g.groupId, name: g.name },
        leaders: g.leaderIds.map(personRef),
        people: memberIds.length,
        abGroups: abGroups(g.abIds),
        ...figures(memberIds),
      };
    });
    if (partition.ungroupedAbIds.length > 0) {
      const memberIds = this.groups.peopleOf(partition, partition.ungroupedAbIds);
      cards.push({
        key: 'none', group: null, leaders: [], people: memberIds.length, abGroups: abGroups(partition.ungroupedAbIds), ...figures(memberIds),
      });
    }
    return cards;
  }

  private ref(event: EventDocument, types: Map<string, EventTypeDocument>, timezone: string): EventRef {
    const facts = this.readings.facts(event, timezone);
    return {
      eventId: facts.id,
      title: event.title,
      type: { code: event.typeCode, label: types.get(event.typeCode)?.label ?? event.typeCode },
      startsOn: facts.startsOn,
    };
  }
}

/** The period: the year to date by default, or a month no later than this one. */
export function periodOf(month: string | undefined, office: { today: LocalDate; month: string }): EventPeriod {
  if (month === undefined) return { kind: 'ytd', month: null, from: `${office.month.slice(0, 4)}-01-01`, to: office.today };
  if (!MONTH.test(month)) throw new InvalidRequestException(EVENTS_REFUSALS.VALIDATION_FAILED.monthShape, { field: 'month' });
  if (month > office.month) throw new InvalidRequestException(EVENTS_REFUSALS.VALIDATION_FAILED.monthLater, { field: 'month' });
  return {
    kind: 'month',
    month,
    from: `${month}-01`,
    to: month === office.month ? office.today : endOfMonth(`${month}-01`),
  };
}

/** Whole days from one office day to another (`YYYY-MM-DD`, read as UTC dates so no zone moves either). */
export function dayCount(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
