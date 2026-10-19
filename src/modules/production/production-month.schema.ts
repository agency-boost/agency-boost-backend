import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type ProductionMonthDocument = HydratedDocument<ProductionMonth>;

/** A hand on the lock: `locked` before the schedule would, or `open` after it has (ADR-0050). */
export const LOCK_OVERRIDES = ['locked', 'open'] as const;
export type LockOverride = (typeof LOCK_OVERRIDES)[number];

/**
 * One office's month of production, as a thing that can change (P9-T4).
 *
 * **Two facts no other row holds.** Whether somebody has locked the month by hand or reopened it —
 * the schedule itself is arithmetic on `kpms.settings.productionLockGraceDays` and needs no row —
 * and the month's **revision**, which every write to its figures advances.
 *
 * **The revision is the month's mutex.** Commit, revert, lock and reopen each claim it by advancing it
 * from the value they read, in one atomic write; a writer that read an older value is refused
 * `VERSION_CONFLICT` and writes nothing. It is also what a preview carries: a file previewed against
 * revision 4 cannot be committed against revision 5, whose figures it never saw.
 *
 * No row until the month is first written; a month with none is revision 0 and follows its schedule.
 */
@Schema({ ...baseSchemaOptions, collection: 'productionMonths' })
export class ProductionMonth {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** `YYYY-MM`, the office's calendar month. */
  @Prop({ type: String, required: true })
  month!: string;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  revision!: number;

  /** `null` follows the schedule. */
  @Prop({ type: String, enum: [...LOCK_OVERRIDES, null], default: null })
  lockOverride!: LockOverride | null;

  @Prop({ type: Date, default: null })
  lockChangedAt!: Date | null;

  /** The membership that locked or reopened it. */
  @Prop({ type: String, default: null })
  lockChangedBy!: string | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const ProductionMonthSchema = SchemaFactory.createForClass(ProductionMonth);

/** One row per office per month — what makes a racing first claim a duplicate rather than a second row. */
ProductionMonthSchema.index(
  { kpmId: 1, month: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
