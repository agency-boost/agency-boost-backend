import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { NPS } from '@/domain/constants';

export type EventFeedbackDocument = HydratedDocument<EventFeedback>;

/**
 * **One member's answer about one event** (P18.5-T6): a score from 0 to 10, *Why?* and *How can we improve?*.
 *
 * **Single-submit** (`Overall.html:8758-8763`): one row per (event, membership), never edited or withdrawn.
 * **`improve` is stored** — the prototype draws the field and never reads it, while the Owner's card reads it
 * (`KPM_Owner.html:3768`). Read with the respondent's name by the Owner and the Admins (OD-151); never by a leader.
 *
 * **PDP** (UU 27/2022): the two texts are free text and may name people. The audit log records ids and the score,
 * never the words; the collection is on P19-T1's erasure and export cascade.
 */
@Schema({ ...baseSchemaOptions, collection: 'eventFeedback' })
export class EventFeedback {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  eventId!: string;

  /** The membership `_id` (invariant §2). */
  @Prop({ type: String, required: true })
  membershipId!: string;

  /** `NPS.SCALE_MIN`–`NPS.SCALE_MAX`, a whole number. */
  @Prop({ type: Number, required: true, min: NPS.SCALE_MIN, max: NPS.SCALE_MAX })
  score!: number;

  @Prop({ type: String, default: '' })
  why!: string;

  @Prop({ type: String, default: '' })
  improve!: string;

  @Prop({ type: Date, required: true })
  submittedAt!: Date;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const EventFeedbackSchema = SchemaFactory.createForClass(EventFeedback);
/** One answer per member and event, and the second submit's refusal. */
EventFeedbackSchema.index(
  { kpmId: 1, eventId: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The Owner's card, by score. */
EventFeedbackSchema.index({ kpmId: 1, eventId: 1, score: -1 });
