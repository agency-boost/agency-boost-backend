import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type CampaignStandingDocument = HydratedDocument<CampaignStanding>;

/** One requirement as it stood when the standing was frozen. */
export interface FrozenRequirement {
  metricKey: string;
  comparator: string;
  target: number;
  current: number | null;
  met: boolean | null;
}

/**
 * **An override of a final standing** (P18.6-T2 AC-5; ADR-0144 §4, D-override): the Owner's or an Admin's correction
 * of a result the evaluator could not see, with its reason. The frozen `status` beside it is never rewritten, so
 * clearing the override restores it. `previousStatus` is what the standing read just before this override was set.
 */
export interface StandingOverride {
  status: 'qualified' | 'not_met';
  reason: string;
  byMembershipId: string;
  at: Date;
  previousStatus: 'qualified' | 'not_met' | 'unknown';
}

const STANDING_OVERRIDE = new MongooseSchema({
  status: { type: String, enum: ['qualified', 'not_met'], required: true },
  reason: { type: String, required: true },
  byMembershipId: { type: String, required: true },
  at: { type: Date, required: true },
  previousStatus: { type: String, enum: ['qualified', 'not_met', 'unknown'], required: true },
}, { _id: false });

const FROZEN_REQUIREMENT = new MongooseSchema({
  metricKey: { type: String, required: true },
  comparator: { type: String, required: true },
  target: { type: Number, required: true },
  current: { type: Number, default: null },
  met: { type: Boolean, default: null },
}, { _id: false });

/**
 * **A member's final result in one campaign's window** (P18.5-T8 AC-5; OD-153, OD-154).
 *
 * **Written once, when the result is final, and never again**: on the first read after the last month the
 * window reads has locked (ADR-0050) — for a window of activity alone, after its last day's backdating grace — and
 * frozen there. A reopen and a correction afterwards change nothing in it: a rewarded result cannot silently flip
 * (OD-154). The correction is the override (`override`, P18.6-T2), set and cleared with a reason beside the frozen
 * `status`, which it never rewrites. **A running standing is never stored**: it is computed on every read, through the production and
 * activity modules' own functions, so an import, a correction or a revert needs no trigger.
 *
 * **No rank**: nothing draws one (*Q3 APE Sprint*'s *"Top 10 unit-wide"* is prize text). `rolling_12m` is never
 * final, so it has no row. Keyed by the membership `_id`, the campaign's code and the window (`2026-07..2026-09`,
 * `2026`); a leaver's standing stays the office's (ADR-0136).
 */
@Schema({ ...baseSchemaOptions, collection: 'campaignStandings' })
export class CampaignStanding {
  @Prop({ type: String, required: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  campaignCode!: string;

  /** The campaign's `version` evaluated, so a later edit of the campaign is visible against the frozen result. */
  @Prop({ type: Number, required: true })
  campaignVersion!: number;

  /** `YYYY-MM..YYYY-MM` for the campaign's own months, `YYYY` for a calendar year, the day range for activity alone. */
  @Prop({ type: String, required: true })
  windowKey!: string;

  @Prop({ type: String, required: true })
  membershipId!: string;

  /** `CAMPAIGN_QUALIFICATION_STATUS` as it was final: `qualified`, `not_met` or `unknown`. */
  @Prop({ type: String, enum: ['qualified', 'not_met', 'unknown'], required: true })
  status!: 'qualified' | 'not_met' | 'unknown';

  /** Whether they were chasing it when it became final — only a chaser qualifies (OD-153). */
  @Prop({ type: Boolean, required: true })
  chasing!: boolean;

  /** Whether their rung was one it applies to. */
  @Prop({ type: Boolean, required: true })
  eligible!: boolean;

  /** Each requirement's target, current figure and verdict, as frozen. A part of this row: no `_id` of its own. */
  @Prop({ type: [FROZEN_REQUIREMENT], default: [] })
  requirements!: FrozenRequirement[];

  @Prop({ type: Date, required: true })
  finalisedAt!: Date;

  /**
   * **The override, or `null`** (P18.6-T2 AC-5, D-override) — additive: a row frozen before it existed reads the
   * default, so no migration. Written only by `CampaignStandingRepository.setOverride`; applied in one place,
   * `fromFrozen`, so every reader of a standing reads the overridden status.
   */
  @Prop({ type: STANDING_OVERRIDE, default: null })
  override!: StandingOverride | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;
}

export const CampaignStandingSchema = SchemaFactory.createForClass(CampaignStanding);
/** One final standing per member, campaign and window: a second first read meets the index and writes nothing. */
CampaignStandingSchema.index(
  { kpmId: 1, campaignCode: 1, windowKey: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** A member's standings — the leaver's cascade (P19-T1) and a member's own reads. */
CampaignStandingSchema.index({ kpmId: 1, membershipId: 1 });
