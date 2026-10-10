import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { localDayOf } from '@/common/time/local-day';
import type { EventAttendanceStatus, EventAudienceScope, EventIssuer, EventPhase } from '@/domain/constants';
import { eventAttendanceRate, eventAttendanceStatus } from '@/domain/metrics/event-attendance';
import { eventNps, npsBucket, type NpsBucket, type NpsReading } from '@/domain/metrics/event-nps';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { EventAudienceReader, type OfficeAudience } from './event-audience';
import type { EventDocument } from './event.schema';
import type { EventRsvpDocument, EventRsvpStatus } from './event-rsvp.schema';
import { EventFeedbackRepository, EventRepository, EventRsvpRepository } from './event.repository';
import { eventPhase, hasEnded } from './event-phase';

/** An event as a reading names it. */
export interface EventFacts {
  id: string;
  code: string;
  title: string;
  typeCode: string;
  startsAt: Date;
  endsAt: Date;
  /** The calendar day it starts on, in the office's zone. */
  startsOn: string;
  phase: EventPhase;
  ended: boolean;
  audience: { issuer: EventIssuer; scope: EventAudienceScope };
  status: 'active' | 'archived';
}

/** One member of the audience, and where they stand with the event. */
export interface AttendanceRow {
  membershipId: string;
  /** The rung they stand on now, `''` for a row older than the field. */
  orgLevelCode: string;
  /** The member's `eventRsvps` row, `null` while they have none. */
  rowId: string | null;
  rsvp: EventRsvpStatus | null;
  claimed: boolean;
  /** A confirmer's mark: `true` attended, `false` marked absent, `null` not marked. */
  confirmed: boolean | null;
  confirmedByMembershipId: string | null;
  confirmedAt: Date | null;
  status: EventAttendanceStatus;
  gaveFeedback: boolean;
}

export interface EventAttendance {
  event: EventFacts;
  /** The audience as at the start, in roster order. */
  rows: AttendanceRow[];
  /** `EVENT_ATTENDANCE_RATE`, `null` before the end and for an empty audience. */
  rate: number | null;
  counts: Record<EventAttendanceStatus, number> & { audience: number };
}

/** Whether an answer's author was confirmed, is awaiting it, or was marked absent. */
export type FeedbackAttendance = 'confirmed' | 'unconfirmed' | 'absent';

export interface FeedbackReadingRow {
  membershipId: string;
  score: number;
  bucket: NpsBucket;
  why: string;
  improve: string;
  submittedAt: Date;
  attendance: FeedbackAttendance;
  /** In the official NPS: the author was confirmed attended (OD-31). */
  counted: boolean;
}

export interface EventFeedbackReading {
  event: EventFacts;
  /** `EVENT_NPS` over the confirmed attendees' answers, with its parts. */
  reading: NpsReading;
  /** Every answer from the audience: confirmed, awaiting and absent. */
  responses: number;
  /** Answers whose author nobody has confirmed yet — *"· {k} awaiting attendance confirmation"*. */
  awaitingConfirmation: number;
  /** Score descending, then the order they came in. */
  rows: FeedbackReadingRow[];
}

/**
 * **The events module's readings** (P18.5-T5 AC-8, P18.5-T6 AC-5) — one computation of the audience as at the start,
 * `EVENT_ATTENDANCE_STATUS`, `EVENT_ATTENDANCE_RATE` and `EVENT_NPS`, read by the Owner's roll call and *Feedback
 * Summary* here and by Phase 18.6's compliance tree (a service port, no route). **No permission is checked here**:
 * the caller has decided who may read; every query goes through the tenant repositories, so nothing outside the
 * caller's office is reachable. `null` for an event this office does not hold.
 */
@Injectable()
export class EventReadings {
  constructor(
    private readonly events: EventRepository,
    private readonly rsvps: EventRsvpRepository,
    private readonly feedback: EventFeedbackRepository,
    private readonly audiences: EventAudienceReader,
    private readonly tenantDay: TenantDay,
    private readonly clock: Clock,
  ) {}

  /** The office's events starting in `[from, to)`, archived ones included, with their phase and day. */
  async eventsBetween(ctx: RequestContext, from: Date, to: Date): Promise<EventFacts[]> {
    const timezone = await this.tenantDay.timezoneOf(ctx);
    const rows = await this.events.find(ctx, { startsAt: { $gte: from, $lt: to } }, { sort: { startsAt: 1 } });
    return rows.map((row) => this.facts(row, timezone));
  }

  /** The roll call's reading: the audience as at the start, each member's status, the rate. */
  async attendance(ctx: RequestContext, eventId: string): Promise<EventAttendance | null> {
    const loaded = await this.load(ctx, eventId);
    if (!loaded) return null;
    const { event, question, audience, rows, answered } = loaded;
    const people = audience.audienceOf(question);
    const rungOf = new Map(audience.people.map((p) => [p.membershipId, p.orgLevelCode]));
    const byMember = new Map(rows.map((row) => [row.membershipId, row]));
    const attendanceRows = people.map((membershipId): AttendanceRow => {
      const row = byMember.get(membershipId);
      const facts = this.rowFacts(row);
      return {
        membershipId,
        orgLevelCode: String(rungOf.get(membershipId)),
        rowId: row ? String(row._id) : null,
        ...facts,
        confirmedByMembershipId: row?.confirmedByMembershipId ?? null,
        confirmedAt: row?.confirmedAt ?? null,
        status: eventAttendanceStatus({ ended: event.ended, ...facts }),
        gaveFeedback: answered.has(membershipId),
      };
    });
    const counts = {
      audience: attendanceRows.length, attended: 0, registered: 0, unconfirmed: 0, no_show: 0, not_registered: 0,
    } as EventAttendance['counts'];
    for (const row of attendanceRows) counts[row.status] += 1;
    return {
      event,
      rows: attendanceRows,
      rate: eventAttendanceRate(attendanceRows.map((r) => r.status), event.ended),
      counts,
    };
  }

  /** The *Feedback Summary*'s reading: every answer from the audience, and the NPS over the confirmed ones. */
  async feedbackSummary(ctx: RequestContext, eventId: string): Promise<EventFeedbackReading | null> {
    const loaded = await this.load(ctx, eventId);
    if (!loaded) return null;
    const { event, question, audience, rows, answers } = loaded;
    const inAudience = new Set(audience.audienceOf(question));
    const byMember = new Map(rows.map((row) => [row.membershipId, row]));
    const readingRows = answers
      .filter((answer) => inAudience.has(answer.membershipId))
      .map((answer): FeedbackReadingRow => {
        const confirmed = byMember.get(answer.membershipId)?.confirmedAttended ?? null;
        const attendance: FeedbackAttendance = confirmed === true ? 'confirmed' : confirmed === false ? 'absent' : 'unconfirmed';
        return {
          membershipId: answer.membershipId,
          score: answer.score,
          bucket: npsBucket(answer.score),
          // The schema's defaults: an answer with no *Why* reads `''`.
          why: answer.why,
          improve: answer.improve,
          submittedAt: answer.submittedAt,
          attendance,
          counted: attendance === 'confirmed',
        };
      })
      .sort((a, b) => b.score - a.score || a.submittedAt.getTime() - b.submittedAt.getTime());
    return {
      event,
      reading: eventNps(readingRows.filter((r) => r.counted).map((r) => r.score)),
      responses: readingRows.length,
      awaitingConfirmation: readingRows.filter((r) => r.attendance === 'unconfirmed').length,
      rows: readingRows,
    };
  }

  // -------------------------------------------------------------------- shared with the services

  /** The facts of one stored event, its phase from the clock and its day in `timezone`. */
  facts(row: EventDocument, timezone: string): EventFacts {
    const now = this.clock.now();
    return {
      id: String(row._id),
      code: row.code,
      title: row.title,
      typeCode: row.typeCode,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      startsOn: localDayOf(row.startsAt, timezone),
      phase: eventPhase(row, now),
      ended: hasEnded(row, now),
      audience: { issuer: row.audience.issuer, scope: row.audience.scope },
      status: row.status,
    };
  }

  /** The audience question an event asks, for `OfficeAudience`. */
  questionOf(row: EventDocument): Parameters<OfficeAudience['audienceOf']>[0] {
    return {
      scope: row.audience.scope,
      inviteeMembershipIds: row.audience.inviteeMembershipIds,
      startsAt: row.startsAt,
      upcoming: this.clock.now().getTime() < row.startsAt.getTime(),
    };
  }

  /** What one member's row says, for `eventAttendanceStatus`. */
  rowFacts(row: EventRsvpDocument | undefined | null): Pick<AttendanceRow, 'rsvp' | 'claimed' | 'confirmed'> {
    return {
      rsvp: row?.rsvpStatus ?? null,
      claimed: Boolean(row?.claimedAt),
      confirmed: row?.confirmedAttended ?? null,
    };
  }

  private async load(ctx: RequestContext, eventId: string) {
    const row = await this.events.findById(ctx, eventId);
    if (!row) return null;
    const timezone = await this.tenantDay.timezoneOf(ctx);
    const event = this.facts(row, timezone);
    const question = this.questionOf(row);
    const [audience, rows, answers] = await Promise.all([
      this.audiences.read(ctx, [question]),
      this.rsvps.find(ctx, { eventId: event.id }),
      this.feedback.find(ctx, { eventId: event.id }),
    ]);
    return { event, question, audience, rows, answers, answered: new Set(answers.map((a) => a.membershipId)) };
  }
}
