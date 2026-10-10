import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type EventRsvpDocument = HydratedDocument<EventRsvp>;

/** An RSVP as it stands: going, or cancelled. `null` on a row made by a claim or a confirmation alone. */
export const EVENT_RSVP_STATUSES = ['going', 'cancelled'] as const;
export type EventRsvpStatus = (typeof EVENT_RSVP_STATUSES)[number];

/**
 * **One member's standing with one event** (P18.5-T5; OD-31, D-status): the RSVP, the claim and the confirmation.
 *
 * One row per (event, membership), **keyed by the membership `_id`** (invariant §2) — a member who leaves and rejoins
 * is a new membership and starts fresh, and the first one's rows stay the office's. Three writers, each owning its
 * fields and writing them with a targeted `$set`, never the whole document:
 *
 * - **the member**: `rsvpStatus`, `rsvpAt`, `cancelledAt` (until the event ends), and `claimedAt` — *"I actually
 *   attended this event"*, from the end. **A claim is never attendance**;
 * - **a confirmer** — the Owner or an Admin, never for their own row: `confirmedAttended` (`true` attended, `false`
 *   marked absent, `null` not yet), `confirmedByMembershipId`, `confirmedAt`.
 *
 * Replaces the ERD's `attendedAt` / `attendanceSource` (`self | checkin | admin_confirmed`): the source is derivable
 * from which fields are set, and `checkin` is dropped — nothing in either prototype writes it.
 */
@Schema({ ...baseSchemaOptions, collection: 'eventRsvps' })
export class EventRsvp {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  eventId!: string;

  /** The membership `_id` — never a userId, never a name. */
  @Prop({ type: String, required: true })
  membershipId!: string;

  @Prop({ type: String, enum: EVENT_RSVP_STATUSES, default: null })
  rsvpStatus!: EventRsvpStatus | null;

  @Prop({ type: Date, default: null })
  rsvpAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  /** The member said they came. Unlocks feedback; never makes `attended`. */
  @Prop({ type: Date, default: null })
  claimedAt!: Date | null;

  /** A confirmer's mark: `true` attended, `false` marked absent, `null` not marked. */
  @Prop({ type: Boolean, default: null })
  confirmedAttended!: boolean | null;

  @Prop({ type: String, default: null })
  confirmedByMembershipId!: string | null;

  @Prop({ type: Date, default: null })
  confirmedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const EventRsvpSchema = SchemaFactory.createForClass(EventRsvp);
/** One live row per member and event; the roll call's read. */
EventRsvpSchema.index(
  { kpmId: 1, eventId: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The reader's own rows, for their list. */
EventRsvpSchema.index({ kpmId: 1, membershipId: 1, eventId: 1 });
