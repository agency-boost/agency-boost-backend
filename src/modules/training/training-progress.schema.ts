import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { TRAINING_STATUSES, type TrainingStatus } from '@/domain/constants';

export type TrainingProgressDocument = HydratedDocument<TrainingProgress>;

/** The first open of one content item (D-opened): which item, and when. Kept so the *Opened* ✓ survives a reload. */
export interface TrainingOpened {
  /** The content item's stable id — `officeContent`'s or `companyContent`'s, whichever the member opened. */
  itemId: string;
  at: Date;
}

/**
 * **One member's progress on one training module** (P18.2-T1, ERD `trainingProgress`): the status they set,
 * when they started and finished, and which of its items they have opened.
 *
 * - **Keyed by the membership and the module's code** (invariants §2, §4): never a `userId`, never a position or
 *   an id. A module's category is its skill's, resolved on read, never stored here (ADR-0029). A re-join is a
 *   new membership and starts at nothing done; the old rows stay with the old membership (ADR-0022).
 * - **Written on the first change** — a status set, or an item opened. A module nobody touched has no row and
 *   reads *Not started*.
 * - **`status` is the member's own word** (OD-149): the three-way toggle, set rather than toggled. *Done* back
 *   to *Not started* is allowed.
 * - **`startedAt`** is set the first time the status leaves `not_started`, and kept. **`completedAt`** is set on
 *   each move to `done` and cleared on leaving it — the date 18.3's tree prints, and the instant an activation
 *   item bound to the module records (ADR-0031).
 * - **`opened`** holds the first open of each item (D-opened). Opening is not audited: this is its record.
 *
 * Personal data: P20-T1's erasure cascade and export reach it. Soft delete only (invariant §6); no route
 * deletes a row.
 */
@Schema({ ...configSchemaOptions, collection: 'trainingProgress' })
export class TrainingProgress {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** → `memberships._id`, the learner. */
  @Prop({ type: String, required: true })
  membershipId!: string;

  /** → `trainingModules.code`, never its id or its place (invariant §4). */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  moduleCode!: string;

  @Prop({ type: String, enum: TRAINING_STATUSES, required: true, default: 'not_started' })
  status!: TrainingStatus;

  @Prop({ type: Date, default: null })
  startedAt!: Date | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  /**
   * The first open of each item, in the order they were opened. Declared inline rather than as a schema of
   * its own: a pair of fields with no `_id`, read only with the row that holds it.
   */
  @Prop({
    type: [{ _id: false, itemId: { type: String, required: true }, at: { type: Date, required: true } }],
    default: [],
  })
  opened!: TrainingOpened[];

  /** The domain's counter, bumped on every write. */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const TrainingProgressSchema = SchemaFactory.createForClass(TrainingProgress);

/**
 * **One live row per member and module**, by the database rather than a read-then-write: two first opens of
 * one module at once must not make two rows. `kpmId` leads (invariant §1).
 */
TrainingProgressSchema.index(
  { kpmId: 1, membershipId: 1, moduleCode: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The bounded reads of many members' rows of one module — the activation evaluator's, and 18.3's tree's. */
TrainingProgressSchema.index({ kpmId: 1, moduleCode: 1, status: 1 });
