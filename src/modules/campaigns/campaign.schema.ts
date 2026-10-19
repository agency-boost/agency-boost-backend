import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import {
  CAMPAIGN_KINDS, CAMPAIGN_POSTER_COLORS, CAMPAIGN_SUBTYPES, CAMPAIGN_WINDOWS, CRITERIA_MODES, DEFAULT_CAMPAIGN_POSTER,
  QUALIFICATION_RULE_KINDS, QUALIFICATION_RULE_SCOPES, REQUIREMENT_COMPARATORS,
  type CampaignKind, type CampaignPosterColor, type CampaignSubtype, type CampaignWindow, type CriteriaMode,
  type QualificationRuleKind, type QualificationRuleScope, type RequirementComparator,
} from '@/domain/constants';

export type CampaignDocument = HydratedDocument<Campaign>;

/** A frozen window's record on its campaign: part of the row, no `_id` of its own. */
const FROZEN_WINDOW = new MongooseSchema({
  key: { type: String, required: true },
  at: { type: Date, required: true },
}, { _id: false });
export type QualificationRuleDocument = HydratedDocument<QualificationRule>;

/**
 * One thing a campaign asks for (P5-T7 AC-1).
 *
 * **A metric, a comparator and a number** — never the prototype's display string *"Net APE ≥ Rp 600
 * juta"*, which nothing can evaluate and nothing can refuse, so a campaign could promise a reward
 * against a figure the product never produces.
 */
@Schema({ _id: false })
export class Requirement {
  /** A key from the metric registry. Anything else is refused at write time, by name. */
  @Prop({ type: String, required: true })
  metricKey!: string;

  @Prop({ type: String, required: true, enum: REQUIREMENT_COMPARATORS })
  comparator!: RequirementComparator;

  /** **Integer IDR minor units** where the unit is money — never a float (invariant §9). */
  @Prop({ type: Number, required: true })
  value!: number;

  /** Copied from the registry at write time, so a reader never has to look it up to render. */
  @Prop({ type: String, required: true })
  unit!: string;
}

export const RequirementSchema = SchemaFactory.createForClass(Requirement);

/**
 * A campaign an office runs (P5-T7, ADR-0034).
 *
 * `scope` is always `kpm` here. A **company** campaign is a live record at company level, written
 * only by Super Admin, which an office may hide and never edit — the other half of ADR-0034, and
 * not built (see the spec).
 */
@Schema({ ...configSchemaOptions, collection: 'campaigns' })
export class Campaign {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, default: '', trim: true })
  description!: string;

  /** UTC instants. *Running* / *Upcoming* / *Ended* is derived on read, never stored (AC-3). */
  @Prop({ type: Date, required: true })
  startsAt!: Date;

  /**
   * The last instant it runs. **`null` for a structural campaign with no end** — a promotion path or an ongoing
   * incentive, drawn *Ongoing* (P18.5-T7, D-fields); a seasonal campaign always has one (`campaign-input.ts`).
   */
  @Prop({ type: Date, default: null })
  endsAt!: Date | null;

  /**
   * *Seasonal* or *Structural* (P18.5-T7, D-fields; `Overall.html:3667-3670`). Every campaign written before the
   * field is seasonal (migration `0027-campaign-kinds`).
   */
  @Prop({ type: String, enum: CAMPAIGN_KINDS, required: true, default: 'seasonal' })
  kind!: CampaignKind;

  /** A structural campaign's section — *Promotion Criteria* or *Production Clubs*; `null` for a seasonal one. */
  @Prop({ type: String, enum: [...CAMPAIGN_SUBTYPES, null], default: null })
  subtype!: CampaignSubtype | null;

  /** What its requirements are read over (D-windows): its dates, the calendar year, or the last twelve months held. */
  @Prop({ type: String, enum: CAMPAIGN_WINDOWS, required: true, default: 'campaign_dates' })
  window!: CampaignWindow;

  /**
   * Which rungs may chase it, **by code** (ADR-0035's shape, as a carrier rule's): empty means everybody. A promotion
   * path to AB is the AAB's; an agent sees it with the chase disabled.
   */
  @Prop({ type: [String], default: [] })
  appliesToOrgLevelCodes!: string[];

  /** The card's poster: one emoji and a token colour — never the prototype's raw hex (D-fields, row 44). */
  @Prop(raw({
    emoji: { type: String, required: true, default: DEFAULT_CAMPAIGN_POSTER.emoji },
    color: { type: String, enum: CAMPAIGN_POSTER_COLORS, required: true, default: DEFAULT_CAMPAIGN_POSTER.color },
  }))
  poster!: { emoji: string; color: CampaignPosterColor };

  /** The card's one line under the title (`Overall.html:8040-8074`). Plain text, rendered as text. */
  @Prop({ type: String, default: '', trim: true })
  blurb!: string;

  /**
   * **The windows whose standings have been frozen** (P18.5-T8 AC-5; the review, item 1): a window's key and when,
   * pushed once — atomically, so of two first reads at once one freezes — **even when nobody chased it**, so a chase
   * made later never enters a window already decided. Written only by the evaluation (`markFrozen`), never by the
   * Owner's form; not part of the campaign's `version`.
   */
  @Prop({ type: [FROZEN_WINDOW], default: [] })
  frozenWindows!: { key: string; at: Date }[];

  @Prop({ type: [RequirementSchema], default: [] })
  requirements!: Requirement[];

  /** What qualifying wins. Text: a reward is a promise, not a number this product computes. */
  @Prop({ type: String, default: '', trim: true })
  reward!: string;

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

export const CampaignSchema = SchemaFactory.createForClass(Campaign);
CampaignSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
CampaignSchema.index({ kpmId: 1, startsAt: 1 });

/** A group of criteria, and whether all of them or any one is enough. */
@Schema({ _id: false })
export class CriteriaGroup {
  @Prop({ type: String, required: true, enum: CRITERIA_MODES })
  mode!: CriteriaMode;

  @Prop({ type: [RequirementSchema], default: [] })
  criteria!: Requirement[];
}

export const CriteriaGroupSchema = SchemaFactory.createForClass(CriteriaGroup);

/**
 * A carrier rule — MOC, a production club tier, a promotion path (ADR-0026, ADR-0035).
 *
 * **Company-partitioned and read-only to every tenant role.** These are the insurer's recognition
 * and contract rules; a branch manager cannot delete Chairman's Club any more than they can retag
 * their office to another company. Seeded per company and edited by a platform operator until a
 * task claims the console ADR-0035 removed from the route registry.
 */
@Schema({ ...configSchemaOptions, collection: 'qualificationRules' })
export class QualificationRule {
  @Prop({ type: String, required: true, index: true })
  companyId!: string;

  @Prop({ type: String, required: true, enum: QUALIFICATION_RULE_SCOPES, default: 'company' })
  scope!: QualificationRuleScope;

  @Prop({ type: String, required: true, enum: QUALIFICATION_RULE_KINDS })
  kind!: QualificationRuleKind;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  /**
   * Which rungs it applies to, **by code** (ADR-0035). Empty means everybody.
   *
   * Never the role enum P4-T9 retired: a company adding a rung between AAB and AB would have
   * members standing on something no rule mentions.
   */
  @Prop({ type: [String], default: [] })
  appliesToOrgLevelCodes!: string[];

  @Prop({ type: [CriteriaGroupSchema], default: [] })
  criteriaGroups!: CriteriaGroup[];

  /** Whether the groups are ANDed or ORed. The carrier's MOC is an *"or"* of two groups. */
  @Prop({ type: String, required: true, enum: CRITERIA_MODES, default: 'all' })
  groupMode!: CriteriaMode;

  @Prop({ type: String, default: '', trim: true })
  reward!: string;

  @Prop({ type: Number, required: true, default: 1 })
  rank!: number;

  /**
   * Metric keys this rule needs that the registry does not define yet.
   *
   * Recorded rather than hidden: a rule whose inputs do not exist can never pass, and a screen
   * that showed it as an ordinary rule would be telling somebody they had failed something the
   * product cannot measure. The prototype's answer was to fabricate the inputs.
   */
  @Prop({ type: [String], default: [] })
  waitingOnMetrics!: string[];

  @Prop({ type: Date, default: null })
  effectiveFrom!: Date | null;

  @Prop({ type: Date, default: null })
  effectiveTo!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const QualificationRuleSchema = SchemaFactory.createForClass(QualificationRule);
QualificationRuleSchema.index(
  { companyId: 1, kind: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
QualificationRuleSchema.index({ companyId: 1, kind: 1, rank: 1 });
