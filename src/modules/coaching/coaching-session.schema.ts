import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type CoachingSessionDocument = HydratedDocument<CoachingSession>;

/**
 * `draft` until its first finalize; `finalized` after it; `reopened` while a correction is open
 * (ADR-0079). A reopened session is not the pair's open draft (ADR-0081).
 */
export type CoachingSessionStatus = 'draft' | 'finalized' | 'reopened';
export const COACHING_SESSION_STATUSES: readonly CoachingSessionStatus[] = ['draft', 'finalized', 'reopened'];

/** The finalized session a draft carried *last week* from, fixed at *Start* (ADR-0081). */
@Schema({ _id: false })
export class CoachingLastWeek {
  @Prop({ type: String, required: true })
  sessionId!: string;

  /** The version of it that was carried: a session under correction carries its latest finalized one. */
  @Prop({ type: Number, required: true })
  version!: number;

  /** Its `date`, `YYYY-MM-DD` in the office's zone. */
  @Prop({ type: String, required: true })
  date!: string;
}

export const CoachingLastWeekSchema = SchemaFactory.createForClass(CoachingLastWeek);

/**
 * A copy of one of last week's action items, ticked **here**. The session it came from is frozen and
 * never changes (P11-T5 AC-2): `done` is written on the session that reviews the item.
 */
@Schema({ _id: false })
export class CoachingLastWeekItem {
  @Prop({ type: String, required: true })
  itemId!: string;

  @Prop({ type: String, default: '' })
  text!: string;

  @Prop({ type: String, default: null })
  dueDate!: string | null;

  /** The lead a *Leads · {name}* item came from, or `null` for a typed one. */
  @Prop({ type: String, default: null })
  leadId!: string | null;

  /** Copied, so the item keeps the words it showed that day. Nothing joins on it. */
  @Prop({ type: String, default: null })
  leadName!: string | null;

  @Prop({ type: Boolean, default: false })
  done!: boolean;
}

export const CoachingLastWeekItemSchema = SchemaFactory.createForClass(CoachingLastWeekItem);

/** One of *Other action items*: typed by the coach, or carried undated from last week (ADR-0081). */
@Schema({ _id: false })
export class CoachingActionItem {
  @Prop({ type: String, required: true })
  itemId!: string;

  /** Blank is allowed while the draft is edited; finalize refuses it. */
  @Prop({ type: String, default: '' })
  text!: string;

  @Prop({ type: String, default: null })
  dueDate!: string | null;

  @Prop({ type: String, default: null })
  carriedFromItemId!: string | null;
}

export const CoachingActionItemSchema = SchemaFactory.createForClass(CoachingActionItem);

/** A coaching tip, as written, or carried from last week as written. */
@Schema({ _id: false })
export class CoachingTip {
  @Prop({ type: String, required: true })
  tipId!: string;

  @Prop({ type: String, default: '' })
  text!: string;

  @Prop({ type: String, default: null })
  carriedFromTipId!: string | null;
}

export const CoachingTipSchema = SchemaFactory.createForClass(CoachingTip);

/**
 * One of *From leads (automatic)* (`Overall.html:11041-11059`), **taken at every finalize** from the
 * coachee's leads as they stand. Empty while the session is open, when every read derives the list.
 */
@Schema({ _id: false })
export class CoachingLeadAction {
  @Prop({ type: String, required: true })
  leadId!: string;

  @Prop({ type: String, required: true })
  leadName!: string;

  @Prop({ type: String, required: true })
  dueDate!: string;

  /** The lead's next action note, or *"Follow up with {name}"*. */
  @Prop({ type: String, required: true })
  text!: string;
}

export const CoachingLeadActionSchema = SchemaFactory.createForClass(CoachingLeadAction);

/**
 * **A finalized state a reopen replaced, kept whole** (ADR-0042's correction shape, ADR-0079): what was
 * agreed, who finalized it and when, and who reopened it, when and why. `date`, `frozenAt` and `snapshot`
 * are not here because a correction never moves them.
 */
@Schema({ _id: false })
export class CoachingSessionCorrection {
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: [CoachingLastWeekItemSchema], default: [] })
  lastWeekItems!: CoachingLastWeekItem[];

  @Prop({ type: [CoachingActionItemSchema], default: [] })
  actionItems!: CoachingActionItem[];

  @Prop({ type: [CoachingTipSchema], default: [] })
  tips!: CoachingTip[];

  @Prop({ type: [CoachingLeadActionSchema], default: [] })
  leadActions!: CoachingLeadAction[];

  @Prop({ type: Date, required: true })
  finalizedAt!: Date;

  @Prop({ type: String, required: true })
  finalizedByMembershipId!: string;

  /** When it was reopened. */
  @Prop({ type: Date, required: true })
  at!: Date;

  /** Who reopened it. */
  @Prop({ type: String, required: true })
  byMembershipId!: string;

  /** Required and audited (ADR-0079), and read by everybody who reads the session, the coachee included. */
  @Prop({ type: String, required: true, trim: true })
  reason!: string;
}

export const CoachingSessionCorrectionSchema = SchemaFactory.createForClass(CoachingSessionCorrection);

// ------------------------------------------------------------------ the snapshot (`erd.md`)

/** One period's goal figures as the Summary showed them, `null` wherever it had none — never a 0. */
export interface SnapshotPeriodFigures {
  targetMinor: number | null;
  actualMinor: number | null;
  attainmentPct: number | null;
  gapMinor: number | null;
  targetMet: boolean;
}

/** The goal the 1:1 looked at. A coachee with no goal has no targets and no goal version. */
export interface SnapshotGoal {
  period: string;
  month: string;
  currency: string;
  monthly: SnapshotPeriodFigures;
  yearly: SnapshotPeriodFigures;
  /** Where the APE produced came from, and as of which month. */
  source: { provenance: 'imported' | 'corrected' | 'self_reported'; month: string | null };
  savedAt: Date | null;
  savedByMembershipId: string | null;
  goalVersion: number | null;
}

/**
 * A balance ratio's two ends as the Ratios card named them that day — the section each side counts,
 * `GET /activity/ratios`' `sides` — so the record can say which way it leaned. A side is `null` when its
 * codes span sections.
 */
export interface SnapshotRatioSides {
  numerator: string | null;
  denominator: string | null;
}

/** One ratio as the 1:1 read it, its label copied beside its code. */
export interface SnapshotRatioRow {
  code: string;
  label: string;
  comparison: string;
  displayUnit: string;
  benchmark: number | null;
  value: number | null;
  share: number | null;
  status: string;
  /**
   * The balance's two ends, `null` for a rate. **Absent** from a snapshot taken before the field
   * existed: that record never held the names, and nothing fills them in after the fact.
   */
  sides?: SnapshotRatioSides | null;
}

/** The ratios on the coachee's rung over the 30 days, labels copied beside the codes. */
export interface SnapshotRatios {
  from: string;
  to: string;
  days: number;
  rows: SnapshotRatioRow[];
}

/** The last 7 days' activity against its pro-rated targets, with the section breakdown. */
export interface SnapshotActivity {
  from: string;
  to: string;
  targets: { key: string; code: string; logged: number; target: number | null }[];
  sections: { code: string; label: string; total: number; rows: { code: string; label: string; count: number }[] }[];
}

/**
 * **What the 1:1 was held over** (`erd.md`, `functional/coaching.md` *The snapshot*): taken once, at the
 * first finalize, and carried unchanged by every later version. Dated evidence and never a display
 * source for a live surface (P11-T5 AC-4). The three figure groups are stored as the shapes above,
 * filled by finalize's own builder (P11-T8); labels are copied because an office may rename a type or a
 * ratio later and the record keeps the words it showed that day. **No leader note is a field of it, at
 * any depth.**
 */
@Schema({ _id: false })
export class CoachingSnapshot {
  @Prop({ type: Date, required: true })
  takenAt!: Date;

  @Prop({ type: Object, default: null })
  goal!: SnapshotGoal | null;

  @Prop({ type: Object, default: null })
  ratios!: SnapshotRatios | null;

  @Prop({ type: Object, default: null })
  activity!: SnapshotActivity | null;
}

export const CoachingSnapshotSchema = SchemaFactory.createForClass(CoachingSnapshot);

/**
 * **A 1:1 between a coach and a coachee** (P11-T5; `erd.md` *`coachingSessions`*;
 * `functional/coaching.md` *The session*).
 *
 * A record with its own id: the coach, the coachee and the date are its attributes, and two 1:1s on one
 * day are two records (ADR-0081). Both people are **membership** ids (invariant §2) — the coachee's named
 * for its role, as a lead's owner is, because the record names two members and the field says which.
 *
 * **ADR-0042's correction shape**: a domain `version` (*Start* is 1, every write one more), `frozenAt` —
 * the first finalize, the reliance moment — and `corrections[]`, each a whole prior finalized state.
 * `configSchemaOptions` hands Mongoose's own counter back to `__v`, so the domain `version` is ours.
 *
 * **`date` is what the coaching metrics count** — the office's day of the first finalize, `null` until
 * then, and moved by nothing after (ADR-0079): `DAYS_SINCE_LAST_COACHING`, `COACHED_7D` / `COACHED_30D`
 * and the roster's *Last 1:1* read the newest `date` among the coachee's sessions finalized at least
 * once, so a draft never counts and a reopened session keeps counting from its day.
 *
 * Nothing here is a leader note, and the record has no field for one (ADR-0073). Soft-deleted only.
 */
@Schema({ ...configSchemaOptions, collection: 'coachingSessions' })
export class CoachingSession {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** The leader who leads it, and the only member who edits or finalizes it (ADR-0081). */
  @Prop({ type: String, required: true })
  coachMembershipId!: string;

  @Prop({ type: String, required: true })
  coacheeMembershipId!: string;

  @Prop({ type: String, enum: [...COACHING_SESSION_STATUSES], required: true, default: 'draft' })
  status!: CoachingSessionStatus;

  /** `YYYY-MM-DD` in the office's zone: the day of the **first** finalize. `null` until then. */
  @Prop({ type: String, default: null })
  date!: string | null;

  @Prop({ type: CoachingLastWeekSchema, default: null })
  lastWeek!: CoachingLastWeek | null;

  @Prop({ type: [CoachingLastWeekItemSchema], default: [] })
  lastWeekItems!: CoachingLastWeekItem[];

  @Prop({ type: [CoachingActionItemSchema], default: [] })
  actionItems!: CoachingActionItem[];

  @Prop({ type: [CoachingTipSchema], default: [] })
  tips!: CoachingTip[];

  @Prop({ type: [CoachingLeadActionSchema], default: [] })
  leadActions!: CoachingLeadAction[];

  @Prop({ type: CoachingSnapshotSchema, default: null })
  snapshot!: CoachingSnapshot | null;

  /** The latest finalize. */
  @Prop({ type: Date, default: null })
  finalizedAt!: Date | null;

  @Prop({ type: String, default: null })
  finalizedByMembershipId!: string | null;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  /** The first finalize: null while the session is a draft that was never finalized. */
  @Prop({ type: Date, default: null })
  frozenAt!: Date | null;

  @Prop({ type: [CoachingSessionCorrectionSchema], default: [] })
  corrections!: CoachingSessionCorrection[];

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CoachingSessionSchema = SchemaFactory.createForClass(CoachingSession);

/**
 * **A coachee's history and their latest 1:1** — what *last week*, the roster and the coaching metrics
 * read: newest `date` first, then `frozenAt`. `kpmId` leads (invariant §1).
 */
CoachingSessionSchema.index({ kpmId: 1, coacheeMembershipId: 1, date: -1, frozenAt: -1 });

/**
 * **The sessions a coach led, newest first** (P11-T10): `/coaching/me`'s list of what a former coach led
 * with somebody they no longer coach (ADR-0088), and the reviewing sessions its counts read. `kpmId`
 * leads (invariant §1).
 */
CoachingSessionSchema.index({ kpmId: 1, coachMembershipId: 1, date: -1, frozenAt: -1 });

/**
 * **At most one open draft per coach and coachee** (ADR-0081), held by the database rather than a
 * read-then-write: two racing *Start*s write one draft, and the second resumes it. Partial, so a
 * finalized or reopened session — and a soft-deleted draft — does not count. An AAB and the AB above
 * them may each have one open with the same agent.
 */
CoachingSessionSchema.index(
  { kpmId: 1, coachMembershipId: 1, coacheeMembershipId: 1 },
  { unique: true, partialFilterExpression: { status: 'draft', deletedAt: null } },
);
