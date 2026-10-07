import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { SeedRecord, TemplateKind } from '@/modules/config/company-template.schema';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import {
  ACTIVATION, DEFAULT_CURRENCY, DEFAULT_TENANT_TIMEZONE, PERFORMANCE, PRODUCTION, ACTIVITY, TIME,
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
  /** How many days past month end an activity day stays freely editable (ADR-0042). */
  activityBackdateGraceDays!: number;
  /** How many days past month end a month of production stays open to writes (ADR-0050). */
  productionLockGraceDays!: number;
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
  activityBackdateGraceDays: ACTIVITY.BACKDATE_GRACE_DAYS,
  productionLockGraceDays: PRODUCTION.LOCK_GRACE_DAYS,
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

  /**
   * Which company template this office's configuration was copied from (ADR-0018, P4-T1).
   *
   * `null` on both means the platform defaults were used, because the company had
   * published nothing yet — the normal state of the first office of a new insurer. Kept so
   * that *"six of eight KPMs haven't reviewed the new default activation checklist"*, which
   * the Superadmin prototype puts on its front page, is answerable at all.
   *
   * It is a record of provenance, not a link: copy-on-provision means publishing a new
   * version never reaches back into an office that has already diverged.
   */
  /**
   * The month the office's financial year starts, 1–12 (P4-T5).
   *
   * Stored and displayed now; **read by nobody until Phase 18**. Writing it here costs
   * nothing and means the first period computation does not have to go back and ask every
   * office to set it. January by default, which is what every office in v1 uses.
   */
  @Prop({ type: Number, default: 1, min: 1, max: 12 })
  fiscalYearStartMonth!: number;

  /**
   * The published template of **each kind** this office was built from (P5-T12).
   *
   * It was one pair, `seededFromTemplateId` / `seededFromVersion`, written from the
   * **activity taxonomy's** seed alone — while template versions count separately per
   * company *and kind*. So the Lead statuses and Ratio benchmarks tabs of the Company
   * template compared every office against the wrong template's version, and would have
   * done the same for every Phase 5 tab.
   *
   * Keyed by kind. An entry with `version: null` is an office built from the platform
   * defaults; a missing entry is an office created before that kind was recorded. The two
   * are counted apart, because only one of them is known to be behind.
   */
  @Prop({ type: Object, default: {} })
  seededFrom!: Partial<Record<TemplateKind, SeedRecord>>;

  /**
   * **What the office was started from** (ADR-0115 §4, P13.2-T6): one of its company's named
   * templates, the AgencyBoost defaults, or *Empty* — chosen as *Start from* when it was created, or
   * the company's default when a KPM request was approved. The template's name is kept beside its id,
   * so the record still reads after a rename.
   *
   * **`null` on an office created before 13.2**, and never backfilled: those were built from their
   * company's newest published kinds or the platform fallback, which is neither a template nor a
   * choice. A record of provenance, never a link — a later edit of the template reaches no office.
   */
  @Prop({ type: Object, default: null })
  startedFrom!: KpmStartedFrom | null;

  @Prop({ type: String, enum: ['active', 'suspended', 'archived'], default: 'active', index: true })
  status!: 'active' | 'suspended' | 'archived';

  @Prop({ type: Date, default: null })
  suspendedAt!: Date | null;

  @Prop({ type: String, default: null })
  suspendedReason!: string | null;

  /**
   * The office's subscription (ADR-0112, P13.2-T3). **`null` is no subscription**, and an office
   * with none works exactly as it did before 13.2: no end, no limit. Every office created before it
   * has none, and nothing backfills one.
   *
   * On the office rather than in a collection of its own because `ContextResolver` reads the office
   * row on every member's request already, and the end is checked there: one more condition on a row
   * in hand, not a second read. Written by the Super Admin alone (`kpm:update_subscription`), every
   * change audited with its before and after.
   */
  @Prop({ type: Object, default: null })
  subscription!: KpmSubscription | null;

  /**
   * A short lease that serialises the writes that could add a leader to this office (ADR-0113 §2,
   * P13.2-T4 AC-6). **Machinery, never data**: read and written only by `leader-limit.ts`, never
   * served, and `null` whenever nobody holds it.
   *
   * Two promotions at one below the limit each counted the leaders, each found room, and each wrote —
   * the count is a read of many rows and there are no transactions (ADR-0002). Whoever holds this
   * counts and writes; the other waits for it. A holder that dies mid-write is released when `until`
   * passes, so a crash never locks an office's leaders for longer than the lease.
   */
  @Prop({ type: Object, default: null })
  leaderLimitLock!: { token: string; until: Date } | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

/**
 * The five fields of an office's subscription (ADR-0112 §1).
 *
 * Dates are **office dates** — `YYYY-MM-DD` in `kpms.timezone`, never instants — so *the end date is
 * the last day the office can be used* means the same day in Jakarta whatever clock the server runs
 * on (invariant §9). Both or neither; the end on or after the start.
 */
export interface KpmSubscription {
  startDate: string | null;
  endDate: string | null;
  /** Integer IDR minor units, whole rupiah. **Informational**: nothing is charged from it. */
  pricePerLeaderMinor: number | null;
  currency: 'IDR';
  /** *Leaders used* may not pass it (ADR-0113). `null` is no limit. */
  maxLeaders: number | null;
  /** On, and the office stays open after its end date: *Ended — kept active*. Off by default. */
  keepActiveAfterEnd: boolean;
}

/** The source an office was started from (ADR-0115 §4). */
export interface KpmStartedFrom {
  source: 'template' | 'defaults' | 'empty';
  /** The named template's id when the source was one; otherwise `null`. */
  templateId: string | null;
  /** Its name at the time, for a record that still reads after a rename. */
  templateName: string | null;
}

export const KpmSchema = SchemaFactory.createForClass(Kpm);
/** A code is unique per company, not globally — two insurers may both have an 0417. */
KpmSchema.index({ companyId: 1, code: 1 }, { unique: true });
KpmSchema.index({ status: 1, createdAt: -1 });
