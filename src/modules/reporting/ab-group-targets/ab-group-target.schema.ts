import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type AbGroupTargetDocument = HydratedDocument<AbGroupTarget>;

/** Who wrote a row: somebody's *Simpan*, or migration `0069` carrying a year's per-leader targets into months. */
export type AbGroupTargetSource = 'set' | 'migration-0069';

/**
 * **`abGroupTargets` — the monthly targets of one AB group** (P19.17-T4;
 * [ADR-0270](../../../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md)
 * §4; `DATA-DEFINITIONS.md`, *Targets*): *Target Active Agent per bulan* and *Target Rekrut per bulan*, one pair per
 * `(kpmId, abMembershipId, month)` — the AB's membership `_id` (invariant §2), the AB group being the AB with their AABs
 * and agents. Written from the target dialog (KPM Overview › *Performa vs target*, Advanced analytics › *Informal
 * group*) by the KPM's stewards, each write audited with its before and after.
 *
 * A month with no row reads the latest earlier month's (`effectiveTarget`, OD-386); none at all is *Belum ada target*.
 * An informal group's and the KPM's targets are the sums of their AB groups', never stored. The APE target is not here:
 * it is the AB group's Goal Setting ÷ 12.
 *
 * Supersedes `analyticsTargets` of kind `subgroup` (a leader's per year, ADR-0253 §4) — migration `0069` carried an AB's
 * into these rows — and, with the KPM Overview's rewrite, `kpmRecruitTargets` (one target for the office).
 */
@Schema({ ...baseSchemaOptions, collection: 'abGroupTargets' })
export class AbGroupTarget {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** The AB whose AB group it is: a membership, never a name. */
  @Prop({ type: String, required: true })
  abMembershipId!: string;

  /** `YYYY-MM`, the office's calendar month. */
  @Prop({ type: String, required: true })
  month!: string;

  @Prop({ type: Number, required: true, min: 0 })
  activeAgentTarget!: number;

  @Prop({ type: Number, required: true, min: 0 })
  rekrutTarget!: number;

  @Prop({ type: String, enum: ['set', 'migration-0069'], default: 'set' })
  source!: AbGroupTargetSource;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const AbGroupTargetSchema = SchemaFactory.createForClass(AbGroupTarget);

/** One pair of targets per AB group and month. `kpmId` leads (invariant §1). */
export const AB_GROUP_TARGET_INDEX = 'one_target_per_ab_group_and_month';
AbGroupTargetSchema.index(
  { kpmId: 1, abMembershipId: 1, month: 1 },
  { unique: true, name: AB_GROUP_TARGET_INDEX, partialFilterExpression: { deletedAt: null } },
);
/** A month's rows for the whole KPM, and every row up to it: what the read asks. */
AbGroupTargetSchema.index({ kpmId: 1, month: 1 });
