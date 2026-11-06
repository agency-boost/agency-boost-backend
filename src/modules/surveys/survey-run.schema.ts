import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { SURVEY_ROLE_CLASSES, type SurveyRoleClass } from '@/domain/constants';
import type { LabelPair, NpsQuestion, QualItem, QualQuestionType } from '@/modules/config/analytics-config';

export type SurveyRunDocument = HydratedDocument<SurveyRun>;
export type SurveyKind = 'nps' | 'qual';

/** One qualitative question as a run asks it: its items resolved (`qualItemsOf`), never read from the template again. */
export interface SnapshotQualQuestion {
  kode: string;
  text: LabelPair;
  type: QualQuestionType;
  items: QualItem[];
}

export interface SnapshotQualBlock {
  kode: string;
  title: LabelPair;
  audience: 'all' | 'leader';
  questions: SnapshotQualQuestion[];
}

/**
 * **What a run asks, and the cut-offs it scores by, fixed when it opens** (R6, AT-8; ADR-0216 §2). A version published
 * while the run is open never reaches it.
 *
 * - `notice`: which privacy line the form carries (C-R8, B-R4) — `anonymous` (*"Anonim. KPM hanya melihat ringkasan…"*)
 *   or `per_person` (*"Jawaban Anda (kecuali Dukungan leader) dapat dilihat leader Anda untuk coaching."*). The words
 *   are the app's catalogue's; which one is the server's, fixed here, so a response's `noticeShown` says what the
 *   form it answered carried.
 * - `cutoffs`: NPS's `promoterMin` and `passiveMin`; a qualitative run's `qualIssueMaxRating`, `supportPromMin` and
 *   `supportPasMin`, and the age and tenure bands its responses are banded by.
 */
export interface SurveySnapshot {
  templateId: string | null;
  configVersion: number;
  questions: NpsQuestion[];
  openQuestion: { kode: 'OPEN'; text: LabelPair } | null;
  blocks: SnapshotQualBlock[];
  cutoffs: {
    promoterMin?: number;
    passiveMin?: number;
    qualIssueMaxRating?: number;
    supportPromMin?: number;
    supportPasMin?: number;
    ageBandUpper: [number, number];
    tenureBands: [number, number, number];
  };
  /** `null`: a run that is neither anonymous nor shown per person, whose form carries no privacy line. */
  notice: 'anonymous' | 'per_person' | null;
}

/**
 * **A survey run: one NPS or qualitative survey of one KPM, with its dates** (P19.5-T4; ADR-0216 §2, `erd.md`
 * *surveyRuns*).
 *
 * The Owner or an Admin starts it within the template's cadence; **until it opens** its settings can change or it can
 * be cancelled (a soft delete); **from 00:00 on `opensOn` in the KPM's calendar**, at the first read after it, it takes
 * its `snapshot` and its invitations (`surveyParticipation`), and nothing about it changes again. It is open to the
 * end of `closesOn`. One live run per kind and period per KPM (`periodKey`).
 */
@Schema({ ...baseSchemaOptions, collection: 'surveyRuns' })
export class SurveyRun {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, enum: ['nps', 'qual'], required: true })
  kind!: SurveyKind;

  /** `YYYY-Qn` or `YYYY-Hn` for NPS, by the template's cadence; `YYYY-06` or `YYYY-12` for a qualitative run. */
  @Prop({ type: String, required: true })
  periodKey!: string;

  /** `YYYY-MM-DD`, the KPM's calendar (invariant §9). */
  @Prop({ type: String, required: true })
  opensOn!: string;

  @Prop({ type: String, required: true })
  closesOn!: string;

  @Prop({ type: [String], enum: [...SURVEY_ROLE_CLASSES], required: true })
  invitedRoleClasses!: SurveyRoleClass[];

  @Prop({ type: Boolean, required: true })
  anonymous!: boolean;

  /** A qualitative run's *Tampilkan jawaban per orang*; always `false` for NPS and while `anonymous` (B-R2). */
  @Prop({ type: Boolean, default: false })
  perPerson!: boolean;

  /** *Ingatkan di tengah*. *Ingatkan 1 hari sebelum berakhir* is always on and is not stored (C-R10). */
  @Prop({ type: Boolean, default: true })
  remindHalfway!: boolean;

  /** `null` until it opens. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  snapshot!: SurveySnapshot | null;

  /** When the snapshot and the invitations were written. */
  @Prop({ type: Date, default: null })
  openedAt!: Date | null;

  /** How many were invited at opening. */
  @Prop({ type: Number, default: 0 })
  invitedCount!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const SurveyRunSchema = SchemaFactory.createForClass(SurveyRun);

/** One live run per kind and period: the second is `SURVEY_RUN_CONFLICT` (`period_taken`). */
SurveyRunSchema.index(
  { kpmId: 1, kind: 1, periodKey: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The runs open on a day, and the list newest first. */
SurveyRunSchema.index({ kpmId: 1, opensOn: -1, closesOn: 1 });
