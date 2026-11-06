import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { SURVEY_ROLE_CLASSES, type SurveyRoleClass } from '@/domain/constants';

export type SurveyResponseDocument = HydratedDocument<SurveyResponse>;

/** One answer of a sent form, by the question's kode (invariant §4). */
export interface SurveyAnswer {
  questionKode: string;
  value: unknown;
}

/**
 * **One sent form** (P19.5-T4; ADR-0216 §3, `erd.md` *surveyResponses*).
 *
 * **An anonymous run's row holds no person** — no `membershipId`, no `submittedAt`, no `createdBy` — and **nothing that
 * dates it**: the schema keeps no timestamps, and its `_id` is twelve random bytes rather than an ObjectId, whose first
 * four are the second it was made and would line up with `surveyParticipation.submittedAt`. Q11's downline leaders are
 * kept without their membership ids on such a row: a leader's own people would name them. Its `roleClass`,
 * `tenureBand` and `ageBand` are read from the member list when it is sent, banded by the run's snapshot; a breakdown
 * cell under `SURVEY.MIN_GROUP` respondents is never shown.
 *
 * A run that is not anonymous stores `membershipId` and `submittedAt`, and for a qualitative run `noticeShown`, set by
 * the server only when the form it served carried B-R4's notice. **PDP**: a row with a `membershipId` is on P20-T1's
 * erasure and export cascade; an anonymous row is no one's.
 */
@Schema({ timestamps: false, versionKey: false, collection: 'surveyResponses' })
export class SurveyResponse {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  runId!: string;

  @Prop({ type: String, default: null })
  membershipId!: string | null;

  @Prop({ type: Date, default: null })
  submittedAt!: Date | null;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  answers!: SurveyAnswer[];

  @Prop({ type: String, enum: [...SURVEY_ROLE_CLASSES], required: true })
  roleClass!: SurveyRoleClass;

  /** `0` to `3` against the snapshot's `tenureBands`, or `null` with no join date (*Belum diisi*). */
  @Prop({ type: Number, default: null })
  tenureBand!: number | null;

  /** `0` (*Gen Z*) to `2` (*Gen X*) against the snapshot's `ageBandUpper`, or `null` with no birth date. */
  @Prop({ type: Number, default: null })
  ageBand!: number | null;

  @Prop({ type: Boolean, default: false })
  noticeShown!: boolean;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Always `null` on an anonymous row; the respondent's membership otherwise. */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const SurveyResponseSchema = SchemaFactory.createForClass(SurveyResponse);

/** A run's responses. */
SurveyResponseSchema.index({ kpmId: 1, runId: 1 });
/** A person's answer to a run, where it has one: the coaching tab's read. */
SurveyResponseSchema.index(
  { kpmId: 1, membershipId: 1, runId: 1 },
  { unique: true, partialFilterExpression: { membershipId: { $type: 'string' } } },
);
