import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type ActivityTypeDocument = HydratedDocument<ActivityType>;

/**
 * One thing an agent can log, owned by one office (P4-T1).
 *
 * **The `code` is the identity and the `displayOrder` is not.** The prototype keys
 * everything off the integers 1–12 — the `data-item` attribute, the ratio formulas, the
 * goal-cascade chips — and those integers are the order the Owner can drag. An office that
 * reorders its list would, in the prototype's model, silently rebind every ratio. Invariant
 * §4 exists because of exactly this, and `categoryCode` here is a code for the same reason.
 *
 * **Archived, never deleted** (invariant §3). Every activity log ever written references a
 * type; a type that vanished would orphan them, and they still have to render.
 */
@Schema({ ...configSchemaOptions, collection: 'activityTypes' })
export class ActivityType {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** `SELL_SUBMISSION`. The thing the goal cascade and the ratios bind to. */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  /** Which category it sits under — by code, so reordering categories moves nothing. */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  categoryCode!: string;

  /** Bahasa Indonesia, verbatim from the Owner prototype. Free to change. */
  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /**
   * ***Nama singkat*** (P19.8-T4, ADR-0229 §5; MOB UI-180): the one line the Unit Dashboard's activity table shows, with
   * `label` in full on tap — a second field, so the office's own name is never reworded. `null` for none: the table
   * shows `label` on up to two lines. At most `ACTIVITY_TEXT.SHORT_LABEL_MAX` characters. Seeded by code for the twelve,
   * copied with the template, written once into an existing office by migration `0060`.
   */
  @Prop({ type: String, default: null, trim: true })
  shortLabel!: string | null;

  /** The prototype's second line — *"networking, canvassing, posting social media, dll"*. */
  @Prop({ type: String, default: null, trim: true })
  description!: string | null;

  @Prop({ type: Number, required: true })
  displayOrder!: number;

  /** The domain's version (invariant §3). See `configSchemaOptions`. */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const ActivityTypeSchema = SchemaFactory.createForClass(ActivityType);

/** One code per office, archived rows included — see the category schema for why. */
ActivityTypeSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The capture screen's read: an office's types, in the order the Owner arranged them. */
ActivityTypeSchema.index({ kpmId: 1, displayOrder: 1 });

/** The settings screen groups by category. */
ActivityTypeSchema.index({ kpmId: 1, categoryCode: 1, displayOrder: 1 });
