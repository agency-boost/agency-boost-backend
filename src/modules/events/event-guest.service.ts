import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { Fields, refuseWith } from '@/common/validation/fields';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import {
  EVENT_FEEDBACK_TEXT_MAX, NPS, type EventAudienceScope, type EventIssuer, type EventPhase,
} from '@/domain/constants';
import { isNpsScore } from '@/domain/metrics/event-nps';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { EventAudienceReader } from './event-audience';
import type { EventDocument, EventTypeDocument } from './event.schema';
import type { EventFeedbackDocument } from './event-feedback.schema';
import type { EventRsvpDocument } from './event-rsvp.schema';
import {
  EventFeedbackRepository, EventRepository, EventRsvpRepository, EventTypeRepository,
} from './event.repository';
import { hasEnded, localTimeOf } from './event-phase';
import { EventReadings } from './event-readings';
import { EVENTS_REFUSALS } from './events.messages';

/** The NPS scale as the screens read it (invariant §7: served, never re-declared). */
export interface NpsConstants {
  scaleMin: number;
  scaleMax: number;
  promoterMin: number;
  detractorMax: number;
}

export const NPS_CONSTANTS: NpsConstants = {
  scaleMin: NPS.SCALE_MIN, scaleMax: NPS.SCALE_MAX, promoterMin: NPS.PROMOTER_MIN, detractorMax: NPS.DETRACTOR_MAX,
};

export interface MyEventFeedback {
  score: number;
  why: string;
  improve: string;
  submittedAt: string;
}

/** One event as a member of its audience reads it — never the invitee list, never a confirmation. */
export interface GuestEvent {
  id: string;
  code: string;
  title: string;
  blurb: string;
  description: string;
  type: { code: string; label: string; emoji: string | null; color: string | null };
  audience: { issuer: EventIssuer; scope: EventAudienceScope };
  startsAt: string;
  endsAt: string;
  startsOn: string;
  startTime: string;
  location: string;
  locationUrl: string | null;
  phase: EventPhase;
  ended: boolean;
  me: {
    rsvp: 'going' | 'cancelled' | null;
    claimed: boolean;
    feedback: MyEventFeedback | null;
  };
}

export interface GuestEventList {
  events: GuestEvent[];
  companyName: string;
  timezone: string;
  limits: { feedbackTextMax: number; nps: NpsConstants };
  can: { rsvp: boolean; cancelRsvp: boolean; claim: boolean; feedback: boolean };
}

/**
 * **The agent's *KPM Events*** (P18.5-T5, P18.5-T6; `Overall.html:3423-3448`, `:8425-8771`): the reader's events,
 * their RSVP and its cancellation, the claim, and the answer.
 *
 * **Whose events.** Active events whose audience holds the reader **as at the event's start** (`EventAudienceReader`,
 * ADR-0039): the prototype shows *Leaders only* and *Select …* events to everybody, with *Join event* (`:8462-8483`).
 * Outside the audience, another office's event and an archived one are all `404`, the answer an event that is not
 * there gives.
 *
 * **What a member writes is their own row** (`eventRsvps`, `eventFeedback`, keyed by the membership `_id`), with a
 * targeted `$set`, audited. **A claim is never attendance** (OD-31): only the roll call makes `attended`, and the
 * member never reads whether anybody confirmed them.
 */
@Injectable()
export class EventGuestService {
  constructor(
    private readonly events: EventRepository,
    private readonly types: EventTypeRepository,
    private readonly rsvps: EventRsvpRepository,
    private readonly feedback: EventFeedbackRepository,
    private readonly audiences: EventAudienceReader,
    private readonly readings: EventReadings,
    private readonly tenantDay: TenantDay,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** `GET /events`. */
  async list(ctx: RequestContext): Promise<GuestEventList> {
    const me = this.member(ctx);
    const office = await this.tenantDay.office(ctx);
    const rows = await this.events.find(ctx, { status: 'active' }, { sort: { startsAt: 1, _id: 1 } });
    const audience = await this.audiences.read(ctx, rows.map((row) => this.readings.questionOf(row)));
    const mine = rows.filter((row) => audience.holds(this.readings.questionOf(row), me));
    const ids = mine.map((row) => String(row._id));
    const [types, rsvps, answers, companyName] = await Promise.all([
      this.typesByCode(ctx),
      this.rsvps.find(ctx, { membershipId: me, eventId: { $in: ids } }),
      this.feedback.find(ctx, { membershipId: me, eventId: { $in: ids } }),
      this.companyName(office.companyId),
    ]);
    const rsvpOf = new Map(rsvps.map((row) => [row.eventId, row]));
    const answerOf = new Map(answers.map((row) => [row.eventId, row]));
    return {
      events: mine.map((row) => this.view(ctx, row, office.timezone, types, rsvpOf.get(String(row._id)), answerOf.get(String(row._id)))),
      companyName,
      timezone: office.timezone,
      limits: { feedbackTextMax: EVENT_FEEDBACK_TEXT_MAX, nps: NPS_CONSTANTS },
      can: {
        rsvp: can(ctx, 'event:rsvp'),
        cancelRsvp: can(ctx, 'event:cancel_rsvp'),
        claim: can(ctx, 'event_attendance:self_claim'),
        feedback: can(ctx, 'event_feedback:submit'),
      },
    };
  }

  /** `GET /events/:eventId`. */
  async read(ctx: RequestContext, eventId: string): Promise<GuestEvent> {
    const me = this.member(ctx);
    const event = await this.visible(ctx, eventId, me);
    return this.fresh(ctx, event, me);
  }

  /** `POST /events/:eventId/rsvp` — idempotent; refused from `endsAt`. */
  async rsvp(ctx: RequestContext, eventId: string): Promise<GuestEvent> {
    const me = this.member(ctx);
    const event = await this.visible(ctx, eventId, me);
    this.refuseOnceEnded(event);
    // Only a row not yet *going*: two taps at once change it once, and the second writes no audit row.
    const changed = await this.rsvps.writeWhen(
      ctx, String(event._id), me, { rsvpStatus: { $ne: 'going' } },
      { rsvpStatus: 'going', rsvpAt: this.clock.now(), cancelledAt: null }, true,
    );
    if (changed) {
      await this.record(ctx, 'event.rsvp', event, me, changed.id,
        { rsvpStatus: changed.before?.rsvpStatus ?? null }, { rsvpStatus: 'going' });
    }
    return this.fresh(ctx, event, me);
  }

  /** `POST /events/:eventId/rsvp/cancel` — idempotent; refused from `endsAt`. */
  async cancelRsvp(ctx: RequestContext, eventId: string): Promise<GuestEvent> {
    const me = this.member(ctx);
    const event = await this.visible(ctx, eventId, me);
    this.refuseOnceEnded(event);
    // Only a row still *going*; never a row made by cancelling nothing.
    const changed = await this.rsvps.writeWhen(
      ctx, String(event._id), me, { rsvpStatus: 'going' },
      { rsvpStatus: 'cancelled', cancelledAt: this.clock.now() }, false,
    );
    if (changed) {
      await this.record(ctx, 'event.rsvp_cancelled', event, me, changed.id, { rsvpStatus: 'going' }, { rsvpStatus: 'cancelled' });
    }
    return this.fresh(ctx, event, me);
  }

  /**
   * `POST /events/:eventId/attendance/claim` — *"I actually attended this event"* (`Overall.html:8732-8741`).
   *
   * **Writes the claim and nothing else** (OD-31; exit test 2): it unlocks the feedback form, and only a confirmer
   * makes `attended`. Idempotent; refused before `endsAt`.
   */
  async claim(ctx: RequestContext, eventId: string): Promise<GuestEvent> {
    const me = this.member(ctx);
    const event = await this.visible(ctx, eventId, me);
    this.refuseUntilEnded(event);
    const changed = await this.rsvps.writeWhen(
      ctx, String(event._id), me, { claimedAt: null }, { claimedAt: this.clock.now() }, true,
    );
    if (changed) await this.record(ctx, 'event.attendance_claimed', event, me, changed.id, { claimed: false }, { claimed: true });
    return this.fresh(ctx, event, me);
  }

  /**
   * `POST /events/:eventId/feedback` — the score, *Why?* and *How can we improve?*, once (`Overall.html:8654-8675`).
   *
   * From `endsAt`, for a member who RSVP'd, said they came or was confirmed. **`improve` is stored** (the Owner's card
   * reads it). The audit row carries the ids and the score, **never the words** (PDP).
   */
  async submitFeedback(ctx: RequestContext, eventId: string, body: unknown): Promise<GuestEvent> {
    const me = this.member(ctx);
    const event = await this.visible(ctx, eventId, me);
    const input = checkFeedback(body);
    this.refuseUntilEnded(event);
    const row = await this.rowOf(ctx, event, me);
    const eligible = row?.rsvpStatus === 'going' || Boolean(row?.claimedAt) || row?.confirmedAttended === true;
    if (!eligible) {
      throw new DomainException(
        ErrorCode.EVENT_NOT_ATTENDED,
        EVENTS_REFUSALS.EVENT_NOT_ATTENDED.feedbackFromAttendees,
        HttpStatus.CONFLICT,
      );
    }
    if (await this.feedback.exists(ctx, { eventId: String(event._id), membershipId: me })) throw alreadySubmitted();
    let saved: EventFeedbackDocument;
    try {
      saved = await this.feedback.create(ctx, {
        eventId: String(event._id), membershipId: me, ...input, submittedAt: this.clock.now(),
      });
    } catch (err) {
      // Two submits racing: the unique index refuses the second, which is the single-submit rule, not a fault.
      if ((err as { code?: number } | null)?.code === 11000) throw alreadySubmitted();
      throw err;
    }
    await this.audit.record(ctx, {
      action: 'event.feedback_submitted', targetCollection: 'eventFeedback', targetId: String(saved._id),
      targetMembershipId: me, before: null,
      after: { eventId: String(event._id), membershipId: me, score: input.score },
    });
    return this.fresh(ctx, event, me);
  }

  // -------------------------------------------------------------------- internals

  /** The caller's membership; a Super Admin outside a support session belongs to no office. */
  private member(ctx: RequestContext): string {
    if (!ctx.membershipId || !ctx.kpmId) throw new NoMembershipException();
    return ctx.membershipId;
  }

  /** The event, when it is active and its audience holds the reader as at its start; otherwise `404`. */
  private async visible(ctx: RequestContext, eventId: string, me: string): Promise<EventDocument> {
    const event = await this.events.findById(ctx, eventId);
    if (!event || event.status !== 'active') throw new NotFoundException('Event');
    const question = this.readings.questionOf(event);
    const audience = await this.audiences.read(ctx, [question]);
    if (!audience.holds(question, me)) throw new NotFoundException('Event');
    return event;
  }

  private refuseOnceEnded(event: EventDocument): void {
    if (hasEnded(event, this.clock.now())) {
      throw new DomainException(
        ErrorCode.EVENT_RSVP_CLOSED, EVENTS_REFUSALS.EVENT_RSVP_CLOSED.ended, HttpStatus.CONFLICT,
      );
    }
  }

  private refuseUntilEnded(event: EventDocument): void {
    if (!hasEnded(event, this.clock.now())) {
      throw new DomainException(
        ErrorCode.EVENT_NOT_ENDED, EVENTS_REFUSALS.EVENT_NOT_ENDED.notYet, HttpStatus.CONFLICT,
      );
    }
  }

  private rowOf(ctx: RequestContext, event: EventDocument, me: string): Promise<EventRsvpDocument | null> {
    return this.rsvps.findOne(ctx, { eventId: String(event._id), membershipId: me });
  }

  /** The event as the reader reads it now, after a write. */
  private async fresh(ctx: RequestContext, event: EventDocument, me: string): Promise<GuestEvent> {
    const id = String(event._id);
    const [timezone, types, row, answer] = await Promise.all([
      this.tenantDay.timezoneOf(ctx),
      this.typesByCode(ctx),
      this.rsvps.findOne(ctx, { eventId: id, membershipId: me }),
      this.feedback.findOne(ctx, { eventId: id, membershipId: me }),
    ]);
    return this.view(ctx, event, timezone, types, row, answer);
  }

  /** Archived types included: an event that already happened keeps rendering the type it was. */
  private async typesByCode(ctx: RequestContext): Promise<Map<string, EventTypeDocument>> {
    return new Map((await this.types.find(ctx, {})).map((type) => [type.code, type]));
  }

  private async companyName(companyId: string | null): Promise<string> {
    if (!companyId) return '';
    const company = await this.companies.findById(companyId).select('name').lean().exec();
    return (company as { name?: string } | null)?.name ?? '';
  }

  private view(
    ctx: RequestContext,
    row: EventDocument,
    timezone: string,
    types: Map<string, EventTypeDocument>,
    rsvp: EventRsvpDocument | null | undefined,
    answer: EventFeedbackDocument | null | undefined,
  ): GuestEvent {
    const facts = this.readings.facts(row, timezone);
    const type = types.get(row.typeCode);
    // The reader's own answer is theirs to read (`event_feedback:read`, `own`).
    const readsOwnAnswer = can(ctx, 'event_feedback:read');
    return {
      id: facts.id,
      code: row.code,
      title: row.title,
      blurb: row.blurb,
      description: row.description,
      type: { code: row.typeCode, label: type?.label ?? row.typeCode, emoji: type?.emoji ?? null, color: type?.color ?? null },
      audience: facts.audience,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      startsOn: facts.startsOn,
      startTime: localTimeOf(row.startsAt, timezone),
      location: row.location,
      locationUrl: row.locationUrl,
      phase: facts.phase,
      ended: facts.ended,
      me: {
        rsvp: rsvp?.rsvpStatus ?? null,
        claimed: Boolean(rsvp?.claimedAt),
        feedback: answer && readsOwnAnswer
          ? { score: answer.score, why: answer.why, improve: answer.improve, submittedAt: answer.submittedAt.toISOString() }
          : null,
      },
    };
  }

  private record(
    ctx: RequestContext, action: string, event: EventDocument, membershipId: string, rowId: string,
    before: Record<string, unknown>, after: Record<string, unknown>,
  ) {
    const eventId = String(event._id);
    return this.audit.record(ctx, {
      action, targetCollection: 'eventRsvps', targetId: rowId, targetMembershipId: membershipId,
      before: { eventId, ...before }, after: { eventId, ...after },
    });
  }
}

function alreadySubmitted(): DomainException {
  return new DomainException(
    ErrorCode.EVENT_FEEDBACK_ALREADY_SUBMITTED, EVENTS_REFUSALS.EVENT_FEEDBACK_ALREADY_SUBMITTED.already,
    HttpStatus.CONFLICT,
  );
}

/** The answer, read field by field: a score from 0 to 10, and two optional texts, trimmed, within the limit. */
export function checkFeedback(body: unknown): { score: number; why: string; improve: string } {
  const f = new Fields(body ?? {}, ['score', 'why', 'improve']);
  const why = f.text('why', { min: 0, max: EVENT_FEEDBACK_TEXT_MAX }, false);
  const improve = f.text('improve', { min: 0, max: EVENT_FEEDBACK_TEXT_MAX }, false);
  const violations = [...f.violations];
  const score = (body as Record<string, unknown> | null)?.score;
  if (score === undefined) violations.push(VALIDATION_REFUSALS.VALIDATION_FAILED.required({ field: 'score' }));
  else if (!isNpsScore(score)) {
    violations.push(EVENTS_REFUSALS.VALIDATION_FAILED.scoreWhole({ min: NPS.SCALE_MIN, max: NPS.SCALE_MAX }));
  }
  if (violations.length > 0) refuseWith(violations);
  return { score: score as number, why: why ?? '', improve: improve ?? '' };
}
