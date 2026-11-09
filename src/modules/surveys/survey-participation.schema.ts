import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { SURVEY_ROLE_CLASSES, type SurveyRoleClass } from '@/domain/constants';

export type SurveyParticipationDocument = HydratedDocument<SurveyParticipation>;

/** The popup's three moments (ADR-0216 §6). */
export type ReminderMoment = 'opened' | 'halfway' | 'last_day';

/**
 * **Who was invited to a run, and how far they got — never what an anonymous run's member answered** (P19.5-T4;
 * ADR-0216 §3, `erd.md` *surveyParticipation*).
 *
 * One row per invitee, written when the run opens. `draftAnswers` holds the answers saved one by one (C-R6) **until
 * *Kirim***: then they are copied into `surveyResponses` and this field is set to `null`, so for an anonymous run the
 * link between the person and their answers is gone while this row still says that they answered. The reminder's
 * state is here too (`reminder`): the popup at most once a KPM day, on every device (C-R3, C-R4).
 *
 * **PDP**: on P20-T1's erasure and export cascade.
 */
@Schema({ ...baseSchemaOptions, collection: 'surveyParticipation' })
export class SurveyParticipation {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  runId!: string;

  /** The membership `_id` (invariant §2). */
  @Prop({ type: String, required: true })
  membershipId!: string;

  /** The class the invitation was written for, which decides the qualitative blocks asked (ADR-0216 §4). */
  @Prop({ type: String, enum: [...SURVEY_ROLE_CLASSES], required: true })
  roleClass!: SurveyRoleClass;

  /** A leader with a leader below them when the run opened: *Coaching leader downline* (Q10, Q11) is asked. */
  @Prop({ type: Boolean, default: false })
  asksDownline!: boolean;

  @Prop({ type: Number, default: 0 })
  answeredCount!: number;

  @Prop({ type: Number, required: true })
  totalCount!: number;

  @Prop({ type: String, default: null })
  lastQuestionKode!: string | null;

  /** `{ [questionKode]: value }` until sent; `null` once sent (or before the first answer). */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  draftAnswers!: Record<string, unknown> | null;

  @Prop({ type: Date, default: null })
  submittedAt!: Date | null;

  /** `lastPopupOn`: the KPM day a popup was last shown; `momentsShown`: which of the three have been. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: () => ({ lastPopupOn: null, momentsShown: [] }) })
  reminder!: { lastPopupOn: string | null; momentsShown: ReminderMoment[] };

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const SurveyParticipationSchema = SchemaFactory.createForClass(SurveyParticipation);

/** One invitation per member per run. */
SurveyParticipationSchema.index({ kpmId: 1, runId: 1, membershipId: 1 }, { unique: true });
/** A member's runs: `/surveys`, the reminder. */
SurveyParticipationSchema.index({ kpmId: 1, membershipId: 1 });
