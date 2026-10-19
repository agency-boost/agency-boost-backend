import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type ActivityLogDocument = HydratedDocument<ActivityLog>;

/** One activity type's count on one day. The **code** is what a reader binds to. */
@Schema({ _id: false })
export class ActivityLogEntry {
  @Prop({ type: String, required: true })
  activityTypeId!: string;

  /**
   * Denormalised on purpose: it is what keeps a historical row readable after its type is
   * archived (invariant §3), and it is what every formula binds to rather than a position
   * (invariant §4). The prototype hardcodes ids 1–12 and cannot be configured per office.
   */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  activityTypeCode!: string;

  @Prop({ type: Number, required: true })
  count!: number;
}

export const ActivityLogEntrySchema = SchemaFactory.createForClass(ActivityLogEntry);

/**
 * A whole prior state of the day, kept when a frozen day is corrected (ADR-0042).
 *
 * The entries are stored **in full rather than as a diff**: a diff is only meaningful against a
 * base somebody still has, and the point of this list is that a leader who coached against
 * Tuesday's numbers can read Tuesday's numbers without reconstructing them.
 */
@Schema({ _id: false })
export class ActivityLogCorrection {
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: [ActivityLogEntrySchema], default: [] })
  entries!: ActivityLogEntry[];

  @Prop({ type: Number, required: true })
  totalCount!: number;

  @Prop({ type: Date, required: true })
  at!: Date;

  @Prop({ type: String, required: true })
  byMembershipId!: string;

  @Prop({ type: String, required: true, trim: true })
  reason!: string;
}

export const ActivityLogCorrectionSchema = SchemaFactory.createForClass(ActivityLogCorrection);

/**
 * What one person did on one day (P6-T1).
 *
 * **`localDate` is a calendar day in the office's timezone, stored as a string.** Not a `Date`:
 * an instant would have to be re-resolved on every read, and that is exactly the defect being
 * closed — the prototype generates every key with `toISOString()`, so for a Jakarta agent any
 * local time before 07:00 files against yesterday (`activity-management.md` §4, invariant §9).
 *
 * **An all-zero row is a real row.** It says *nothing happened*; no row says *nothing was said*.
 * Compliance reads existence, not `totalCount` (ADR-0042, resolving OD-30).
 */
@Schema({ ...configSchemaOptions, collection: 'activityLogs' })
export class ActivityLog {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** The membership, never the user (invariant §2): a person who rejoins gets a new one. */
  @Prop({ type: String, required: true, index: true })
  membershipId!: string;

  /** `YYYY-MM-DD` in the office's timezone. */
  @Prop({ type: String, required: true })
  localDate!: string;

  @Prop({ type: [ActivityLogEntrySchema], default: [] })
  entries!: ActivityLogEntry[];

  /** Denormalised so a compliance or summary read never has to sum the array. */
  @Prop({ type: Number, required: true, default: 0 })
  totalCount!: number;

  /**
   * Always `self` today: no role may log on another person's behalf
   * (`roles-and-permissions.md` §3.5). The field exists because that section requires visible
   * attribution *if* proxy logging is ever added, and adding it later is a migration over every
   * row ever written.
   */
  @Prop({ type: String, enum: ['self', 'proxy'], default: 'self' })
  source!: 'self' | 'proxy';

  @Prop({ type: String, required: true })
  enteredByMembershipId!: string;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  /** Null while the day is still freely editable; set when its correction window closes. */
  @Prop({ type: Date, default: null })
  frozenAt!: Date | null;

  @Prop({ type: [ActivityLogCorrectionSchema], default: [] })
  corrections!: ActivityLogCorrection[];

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const ActivityLogSchema = SchemaFactory.createForClass(ActivityLog);

/** One row per person per day. The upsert target, and the thing that makes a save idempotent. */
ActivityLogSchema.index(
  { kpmId: 1, membershipId: 1, localDate: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The compliance and summary reads: one office, a range of days, optionally one person. */
ActivityLogSchema.index({ kpmId: 1, localDate: 1, membershipId: 1 });
