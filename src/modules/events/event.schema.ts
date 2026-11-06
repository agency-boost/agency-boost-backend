import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import {
  EVENT_AUDIENCE_SCOPES, EVENT_ISSUERS, type EventAudienceScope, type EventIssuer,
} from '@/domain/constants';

export type EventTypeDocument = HydratedDocument<EventType>;
export type EventDocument = HydratedDocument<Event>;

/**
 * A kind of event this office runs (P5-T6).
 *
 * A taxonomy row like every other: a stable code, a version, and archived rather than deleted —
 * an event that already happened has to keep rendering the type it was.
 */
@Schema({ ...configSchemaOptions, collection: 'eventTypes' })
export class EventType {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  @Prop({ type: String, default: null, trim: true })
  description!: string | null;

  /** The prototype's poster is an emoji on a hex background; there is no image anywhere. */
  @Prop({ type: String, default: null, trim: true })
  emoji!: string | null;

  @Prop({ type: String, default: null, trim: true })
  color!: string | null;

  @Prop({ type: Number, required: true })
  displayOrder!: number;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const EventTypeSchema = SchemaFactory.createForClass(EventType);
EventTypeSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
EventTypeSchema.index({ kpmId: 1, displayOrder: 1 });

/**
 * Who is invited (P5-T6 AC-4).
 *
 * Three fields where the prototype has one free-text string. *"KPM | Leaders only"* is an issuer,
 * a scope and — for a *select* — an invitee list that the prototype never had anywhere to put.
 */
@Schema({ _id: false })
export class EventAudience {
  @Prop({ type: String, required: true, enum: EVENT_ISSUERS })
  issuer!: EventIssuer;

  @Prop({ type: String, required: true, enum: EVENT_AUDIENCE_SCOPES })
  scope!: EventAudienceScope;

  /**
   * Membership ids, for a *select* scope only.
   *
   * **Membership ids, not user ids** (invariant §2): a person who leaves and rejoins is a new
   * membership, and an invitation belongs to the participation rather than to the person.
   */
  @Prop({ type: [String], default: [] })
  inviteeMembershipIds!: string[];
}

export const EventAudienceSchema = SchemaFactory.createForClass(EventAudience);

/**
 * One event (P5-T6, ADR-0034).
 *
 * **Nothing per-person is stored here** (AC-6). The prototype keeps `joined`, `feedbackSubmitted`,
 * `myScore` and `myWhy` on the shared event object, so with two users the second overwrites the
 * first's RSVP and reads the first's feedback as their own. RSVP, attendance and feedback are
 * their own per-member records in Phase 18.2 (P18.2-T5, P18.2-T6; were P14-T3, P14-T4).
 *
 * **`startsAt` and `endsAt` are UTC instants, and nothing stores whether an event is past**
 * (AC-3). The prototype hardcodes a status beside a date it is never checked against.
 */
@Schema({ ...configSchemaOptions, collection: 'events' })
export class Event {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  typeCode!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  /** The one-line summary the card shows. */
  @Prop({ type: String, default: '', trim: true })
  blurb!: string;

  @Prop({ type: String, default: '', trim: true })
  description!: string;

  @Prop({ type: Date, required: true })
  startsAt!: Date;

  /** Required: the prototype has no end time, so *"is it running now?"* had no answer. */
  @Prop({ type: Date, required: true })
  endsAt!: Date;

  @Prop({ type: String, default: '', trim: true })
  location!: string;

  @Prop({ type: String, default: null, trim: true })
  locationUrl!: string | null;

  @Prop({ type: EventAudienceSchema, required: true })
  audience!: EventAudience;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const EventSchema = SchemaFactory.createForClass(Event);
EventSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The read order: an office's events by when they start. */
EventSchema.index({ kpmId: 1, startsAt: 1 });
