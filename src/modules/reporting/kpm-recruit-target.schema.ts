import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type KpmRecruitTargetDocument = HydratedDocument<KpmRecruitTarget>;

/**
 * **An office's recruitment target for a month** (Phase 18, D-recruit): the Overview's *Target* tile
 * (`KPM_Owner.html:1060-1062`), which the prototype defaults to 15 and keeps nowhere (contradiction 8).
 *
 * One row per office and month, written by the Owner or an Admin (`kpm_overview:set_recruit_target`), each
 * change audited with before and after. **A month with none reads the latest earlier month's** — the target
 * carries forward until somebody changes it — and an office that never set one has none, so the pill is not
 * drawn rather than judged against the prototype's 15. Soft-deleted, never removed.
 */
@Schema({ ...baseSchemaOptions, collection: 'kpmRecruitTargets' })
export class KpmRecruitTarget {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** `YYYY-MM`, the office's calendar month. */
  @Prop({ type: String, required: true })
  month!: string;

  /** Recruits the office aims to close in the month: a whole number from 0. */
  @Prop({ type: Number, required: true, min: 0 })
  target!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership ids, never a user id or a name (invariant §2). */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const KpmRecruitTargetSchema = SchemaFactory.createForClass(KpmRecruitTarget);

/** One target per office and month among live rows; the carry-forward read walks it newest first. */
KpmRecruitTargetSchema.index(
  { kpmId: 1, month: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
