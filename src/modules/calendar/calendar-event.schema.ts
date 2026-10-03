import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { CALENDAR_ENTRY_TYPES, type CalendarEntryType } from '@/domain/constants';

export type CalendarEventDocument = HydratedDocument<CalendarEvent>;

/** An invitee's answer. A placed member has none: a block is a placement, not a request (ADR-0098). */
export const CALENDAR_ANSWERS = ['pending', 'accepted', 'declined'] as const;
export type CalendarAnswer = (typeof CALENDAR_ANSWERS)[number];

/**
 * **One member on an entry** (`erd.md`, *`calendarEvents`*): an invitee, whose `answer` is theirs to
 * give, or the member a block was placed on, `placed: true` with no answer at all.
 *
 * By membership, never a user id or a name (invariant §2). An attendee is an active field member of
 * the entry's office when added (ADR-0094): no guest, no client, no free-text name.
 */
@Schema({ _id: false })
export class CalendarAttendee {
  @Prop({ type: String, required: true })
  membershipId!: string;

  /** The member a *Block time* entry was placed on (ADR-0098). At most one per entry, never its organiser. */
  @Prop({ type: Boolean, default: false })
  placed!: boolean;

  /** `null` on a placed member; otherwise `pending` until the invitee answers. */
  // A null passes the enum: Mongoose runs no validator on a null that is not required.
  @Prop({ type: String, enum: CALENDAR_ANSWERS, default: 'pending' })
  answer!: CalendarAnswer | null;

  /** Set by the invitee's own answer, and by nothing else. */
  @Prop({ type: Date, default: null })
  answeredAt!: Date | null;

  @Prop({ type: Date, required: true })
  addedAt!: Date;
}

export const CalendarAttendeeSchema = SchemaFactory.createForClass(CalendarAttendee);

/**
 * **One calendar entry** (P12-T1 AC-4; `erd.md`, *`calendarEvents`*; `functional/calendar.md`).
 *
 * **One record per entry, however many people are on it** — the prototype keeps a copy per person, and
 * its copies disagree (contradiction 11). Its organiser is the only member who edits or deletes it
 * (D-write); each attendee reads it through a per-entry grant; the organiser's ancestors read it through
 * `COACH` in a compared pane (ADR-0093).
 *
 * **Times are instants, days are the office's** (invariant §9): `startsAt` and `endsAt` are UTC instants
 * converted from the office's wall-clock through `kpms.timezone`; a timed entry ends no later than
 * midnight at the end of its date. Travel also keeps its two office dates, `startsOn` and `endsOn`, and
 * its instants are the office's midnights around them, so one range query reads every type.
 *
 * **No correction shape** (ADR-0042): nothing relies on an entry, so an edit replaces it and `version`
 * is a concurrency pin, not a history. An answer moves no `version`. A deleted entry keeps its row.
 *
 * **It stores no coaching session**, and no session stores it (ADR-0099): a *1:1 coaching* entry counts
 * for nothing.
 *
 * Personal data under UU 27/2022 — a client's name and address can be typed into it, and every ancestor
 * of its organiser reads it (ADR-0093). P19-T1's erasure and export cascade reaches it.
 */
@Schema({ ...configSchemaOptions, collection: 'calendarEvents' })
export class CalendarEvent {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** Whose entry it is: the member who made it, or the leader who placed a block. */
  @Prop({ type: String, required: true })
  organiserMembershipId!: string;

  @Prop({ type: String, enum: CALENDAR_ENTRY_TYPES, required: true })
  type!: CalendarEntryType;

  /** Trimmed; `''` when none, drawn *"(untitled event)"*. */
  @Prop({ type: String, default: '' })
  title!: string;

  /** *Notes / location*; `''` when none. Free text, no address prompt (ADR-0093). */
  @Prop({ type: String, default: '' })
  notes!: string;

  @Prop({ type: Date, required: true })
  startsAt!: Date;

  /** Exclusive: an entry ending at 10:30 holds 10:00 to 10:29. Always after `startsAt`. */
  @Prop({ type: Date, required: true })
  endsAt!: Date;

  /** Travel's *Departure date*, `YYYY-MM-DD` in the office; `null` on every other type. */
  @Prop({ type: String, default: null })
  startsOn!: string | null;

  /** Travel's *Return date*, inclusive; `null` on every other type. */
  @Prop({ type: String, default: null })
  endsOn!: string | null;

  @Prop({ type: [CalendarAttendeeSchema], default: [] })
  attendees!: CalendarAttendee[];

  /** 1 at create, one more on each edit. An answer does not move it. */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CalendarEventSchema = SchemaFactory.createForClass(CalendarEvent);

/** The entries a member organises, in a range. `kpmId` leads (invariant §1). */
CalendarEventSchema.index({ kpmId: 1, organiserMembershipId: 1, startsAt: 1 });
/** The entries a member is on, in a range. */
CalendarEventSchema.index({ kpmId: 1, 'attendees.membershipId': 1, startsAt: 1 });
