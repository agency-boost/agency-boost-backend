import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type ActivationProgressDocument = HydratedDocument<ActivationProgress>;

/** Who or what completed an item: the hire's tick, a leader's, or the link's own write (OD-121). */
export const ACTIVATION_ITEM_SOURCES = ['hire', 'leader', 'link'] as const;
export type ActivationItemSource = (typeof ACTIVATION_ITEM_SOURCES)[number];

/** How a row came to exist: a placement through a leader (OD-119), or the Phase 13 backfill. */
export const ACTIVATION_ORIGINS = ['joined', 'backfill'] as const;
export type ActivationOrigin = (typeof ACTIVATION_ORIGINS)[number];

/** The collections a linked item completes from: a goal, a lead, or the day that made the fourth week. */
export const ACTIVATION_RECORD_COLLECTIONS = ['goals', 'leads', 'activityLogs'] as const;
export type ActivationRecordCollection = (typeof ACTIVATION_RECORD_COLLECTIONS)[number];

/**
 * One item's state, **keyed by its code in the pinned version** (invariant §4) — never by position, and
 * never by an id a later version could reuse.
 *
 * Sparse: an item nobody has touched has no row, and reads as not done. `note` and `date` are the
 * hire's own, and only the hire's read carries them (P13-T2 AC-4).
 */
@Schema({ _id: false })
export class ActivationItemState {
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: Boolean, required: true, default: false })
  done!: boolean;

  /** When it was done, as an instant. `null` while it is not. */
  @Prop({ type: Date, default: null })
  doneAt!: Date | null;

  @Prop({ type: String, enum: ACTIVATION_ITEM_SOURCES, default: null })
  source!: ActivationItemSource | null;

  /**
   * **The membership that ticked it** — or, for a link, the one that wrote the completing record: the
   * leader who saved the goal (ADR-0046), the leader who added the lead in a session (ADR-0076).
   */
  @Prop({ type: String, default: null })
  doneByMembershipId!: string | null;

  /**
   * For a link: **the record that completed it**, by collection and id. A link stays done when that
   * record is later replaced, deleted or corrected to zero (ADR-0031, sticky).
   */
  @Prop({ type: String, enum: ACTIVATION_RECORD_COLLECTIONS, default: null })
  recordCollection!: ActivationRecordCollection | null;

  @Prop({ type: String, default: null })
  recordId!: string | null;

  /** The hire's own note on a manual item. At most 500 characters; never in a leader's read. */
  @Prop({ type: String, default: null })
  note!: string | null;

  /** The hire's own date on a manual item, an office date `YYYY-MM-DD`. Never in a leader's read. */
  @Prop({ type: String, default: null })
  date!: string | null;
}

export const ActivationItemStateSchema = SchemaFactory.createForClass(ActivationItemState);

/** The leader's coaching note on a hire (OD-117): one per hire, replaced on each save. */
@Schema({ _id: false })
export class ActivationNote {
  @Prop({ type: String, required: true })
  text!: string;

  @Prop({ type: String, required: true })
  byMembershipId!: string;

  @Prop({ type: Date, required: true })
  at!: Date;
}

export const ActivationNoteSchema = SchemaFactory.createForClass(ActivationNote);

/**
 * **One hire's 90-day activation** (Phase 13): the checklist they work through, pinned; the day it
 * started; what is done, by whom; the leader's note to them; and how it ended.
 *
 * - **Pinned** to `(templateId, templateVersion)`, the office's published version when it was created
 *   (D-version). An Owner's later publish never moves a running activation: a published version is
 *   immutable, and this is the reason.
 * - **`startDate` is an office date**, never an instant (invariant §9): the day the person joined, in
 *   `kpms.timezone`, until a leader corrects it (OD-118).
 * - **The end is graduation or six calendar months**, whichever is first (OD-120). Graduation is stored —
 *   here and nowhere else: `memberships.activationGraduatedAt`, which nothing ever wrote, is gone, so the
 *   fact lives in one place. *Expired* is derived on every read from `startDate` and the office's today.
 * - **Keyed by membership** (invariant §2): a leader change keeps it with the hire; a re-join is a new
 *   membership and a fresh activation (ADR-0022).
 *
 * Personal data: P19-T1's erasure cascade reaches it. Soft delete only (invariant §6).
 */
@Schema({ ...configSchemaOptions, collection: 'activationProgress' })
export class ActivationProgress {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** → `memberships._id`, the hire. Never a `userId`, never a name. */
  @Prop({ type: String, required: true })
  membershipId!: string;

  /** → `activationTemplates._id`: the published version this activation works through. */
  @Prop({ type: String, required: true })
  templateId!: string;

  @Prop({ type: Number, required: true })
  templateVersion!: number;

  /** `YYYY-MM-DD` in the office's timezone. Day 1. */
  @Prop({ type: String, required: true })
  startDate!: string;

  /** A leader's correction of `startDate` (OD-118): when, and who. `null` while it is the join date. */
  @Prop({ type: Date, default: null })
  startCorrectedAt!: Date | null;

  @Prop({ type: String, default: null })
  startCorrectedByMembershipId!: string | null;

  @Prop({ type: String, enum: ACTIVATION_ORIGINS, required: true })
  origin!: ActivationOrigin;

  @Prop({ type: [ActivationItemStateSchema], default: [] })
  items!: ActivationItemState[];

  @Prop({ type: ActivationNoteSchema, default: null })
  note!: ActivationNote | null;

  /** The hire's own *Mark activation complete →* (OD-28). `null` while open or expired. */
  @Prop({ type: Date, default: null })
  graduatedAt!: Date | null;

  @Prop({ type: String, default: null })
  graduatedByMembershipId!: string | null;

  /** The domain's counter, bumped on every write. */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const ActivationProgressSchema = SchemaFactory.createForClass(ActivationProgress);

/**
 * **At most one open activation per membership**, enforced by the database rather than a read-then-write
 * two concurrent placements — or a placement and the read that heals a failed one — would race past.
 * A graduated activation is out of it; nothing creates a second for one membership anyway.
 */
ActivationProgressSchema.index(
  { kpmId: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { graduatedAt: null, deletedAt: null } },
);

/** The reads: a hire's own, whatever its state, and a roster's open ones for many hires at once. */
ActivationProgressSchema.index({ kpmId: 1, membershipId: 1, graduatedAt: 1 });
