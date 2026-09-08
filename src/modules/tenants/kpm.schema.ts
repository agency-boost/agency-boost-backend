import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import {
  ACTIVATION, DEFAULT_CURRENCY, DEFAULT_TENANT_TIMEZONE, PERFORMANCE, ACTIVITY, TIME,
} from '@/domain/constants';

export type KpmDocument = HydratedDocument<Kpm>;

/**
 * Per-office knobs the prototypes hardcode. Seeded from the platform defaults at
 * provisioning; the office owns them thereafter.
 */
export class KpmSettings {
  activationWindowDays!: number;
  ratioWindowDays!: number;
  complianceWindowDays!: number;
  coachingOverdueDays!: number;
  onTrackPaceThreshold!: number;
  activityDailyMaxCount!: number;
  weeksPerMonth!: number;
  avgDaysPerMonth!: number;
}

export const DEFAULT_KPM_SETTINGS: KpmSettings = {
  activationWindowDays: ACTIVATION.WINDOW_DAYS,
  ratioWindowDays: PERFORMANCE.RATIO_WINDOW_DAYS,
  complianceWindowDays: PERFORMANCE.COMPLIANCE_WINDOW_DAYS,
  coachingOverdueDays: PERFORMANCE.COACHING_OVERDUE_DAYS,
  onTrackPaceThreshold: PERFORMANCE.ON_TRACK_PACE_THRESHOLD,
  activityDailyMaxCount: ACTIVITY.COUNT_MAX,
  weeksPerMonth: TIME.WEEKS_PER_MONTH,
  avgDaysPerMonth: TIME.AVG_DAYS_PER_MONTH,
};

/**
 * The tenant. Its `_id` is the `kpmId` every scoped document carries.
 *
 * Created only by a Super Admin (ADR-0005) — there is no self-service path, because a
 * KPM is a commercial relationship with a principal insurer, not a signup.
 */
@Schema({ ...baseSchemaOptions, collection: 'kpms' })
export class Kpm {
  @Prop({ type: String, required: true, index: true })
  companyId!: string;

  /** Unique within its company. `0417` in the prototypes; prefixes agent codes. */
  @Prop({ type: String, required: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  branchName!: string;

  @Prop({ type: String, default: null })
  address!: string | null;

  @Prop({ type: String, default: null })
  contactPhone!: string | null;

  /** Read-only to the Owner; Super Admin assigns and transfers. */
  @Prop({ type: String, default: null, index: true })
  ownerUserId!: string | null;

  /** Canonical for every day boundary in this office. Never the server's zone. */
  @Prop({ type: String, default: DEFAULT_TENANT_TIMEZONE })
  timezone!: string;

  @Prop({ type: String, default: 'id-ID' })
  locale!: string;

  @Prop({ type: String, default: DEFAULT_CURRENCY })
  currency!: string;

  @Prop({ type: Object, default: () => ({ ...DEFAULT_KPM_SETTINGS }) })
  settings!: KpmSettings;

  /**
   * Join order within the office. Allocated atomically, immutable once assigned.
   *
   * This was `nextAgentCodeSeq` and it minted the agent code. It does not any more
   * (ADR-0017) — the code belongs to the person, issued by their insurer. What the
   * sequence still does is order the directory: the roster cursor is a `$gt` on it and
   * seven services sort by it, none of which cares who issued a code. Renamed so it
   * stops naming something it no longer produces.
   */
  @Prop({ type: Object, default: () => ({ nextMemberSeq: 1 }) })
  counters!: { nextMemberSeq: number };

  @Prop({ type: String, enum: ['active', 'suspended', 'archived'], default: 'active', index: true })
  status!: 'active' | 'suspended' | 'archived';

  @Prop({ type: Date, default: null })
  suspendedAt!: Date | null;

  @Prop({ type: String, default: null })
  suspendedReason!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const KpmSchema = SchemaFactory.createForClass(Kpm);
/** A code is unique per company, not globally — two insurers may both have an 0417. */
KpmSchema.index({ companyId: 1, code: 1 }, { unique: true });
KpmSchema.index({ status: 1, createdAt: -1 });
