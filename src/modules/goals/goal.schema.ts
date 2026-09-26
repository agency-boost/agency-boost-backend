import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { CASCADE_ACTIVITY_CODES } from '@/domain/constants';

export type GoalDocument = HydratedDocument<Goal>;

/** How the annual target was arrived at. Both produce one number; they differ in what is typed. */
export const GOAL_MODES = ['direct', 'from_savings'] as const;
export type GoalMode = (typeof GOAL_MODES)[number];

/**
 * The three activity codes the cascade's columns count against.
 *
 * **Codes, never the prototype's `#3 / #4 / #6`.** Those are display order, and the Owner's settings
 * screen lets an office drag the list (invariant §4) — so an office that reordered it would silently
 * rebind every goal in it to three different activities. Stored on the goal rather than assumed, so
 * a goal saved today still says what it was measured against after the office edits its taxonomy.
 */
@Schema({ _id: false })
export class GoalCascadeMapping {
  // The defaults read from the constant rather than repeating it: three literals here and three in
  // `CASCADE_ACTIVITY_CODES` is two sources for one fact, which is what invariant §7 forbids.
  @Prop({ type: String, required: true, default: CASCADE_ACTIVITY_CODES.leadsCode })
  leadsCode!: string;

  @Prop({ type: String, required: true, default: CASCADE_ACTIVITY_CODES.appointmentsCode })
  appointmentsCode!: string;

  @Prop({ type: String, required: true, default: CASCADE_ACTIVITY_CODES.closingsCode })
  closingsCode!: string;
}
export const GoalCascadeMappingSchema = SchemaFactory.createForClass(GoalCascadeMapping);

/**
 * What the inputs produced, **at the moment they were agreed**.
 *
 * Stored *and* recomputed on every read, which is not a contradiction: they answer different
 * questions. The snapshot is *what did we agree to*; the recomputation is *what does that mean
 * today*. `monthsLeft` shrinks every day, so a plan saved in January and displayed in June would
 * otherwise claim a year that no longer has eleven months in it (client PRD §17).
 */
@Schema({ _id: false })
export class GoalSnapshot {
  @Prop({ type: Number, required: true, default: 0 })
  monthlyApeTargetMinor!: number;

  @Prop({ type: Number, required: true, default: 0 })
  policiesPerMonth!: number;

  @Prop({ type: Number, required: true, default: 0 })
  appointmentsPerMonth!: number;

  @Prop({ type: Number, required: true, default: 0 })
  leadsPerMonth!: number;
}
export const GoalSnapshotSchema = SchemaFactory.createForClass(GoalSnapshot);

/**
 * A whole prior state of the plan, kept when it is re-planned (P8-T6, ADR-0042).
 *
 * **The inputs in full, not a diff.** A diff is only meaningful against a base somebody still has,
 * and the point of this list is that a leader who coached against January's plan can read January's
 * plan without reconstructing it. What changed between two versions is then derived from two whole
 * states — the same reasoning `activityLogs.corrections` is built on.
 *
 * **No reason field, unlike a correction.** Correcting a frozen activity day is an assertion that
 * the record was wrong and needs one; re-planning a goal is an agent changing their mind about the
 * future, which needs nothing more than the new plan and who made it.
 */
@Schema({ _id: false })
export class GoalRevision {
  /** The version this state *was*. The current row carries the next one. */
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, enum: GOAL_MODES, required: true })
  mode!: GoalMode;

  @Prop({ type: Number, required: true })
  annualApeTargetMinor!: number;

  @Prop({ type: Number, required: true })
  savingsTargetMinor!: number;

  @Prop({ type: Number, required: true })
  commissionRatePct!: number;

  @Prop({ type: Number, default: null })
  monthsLeftOverride!: number | null;

  @Prop({ type: Number, required: true })
  apeAchievedMinor!: number;

  @Prop({ type: Number, required: true })
  caseSizeMinor!: number;

  @Prop({ type: Number, required: true })
  leadsToApptPct!: number;

  @Prop({ type: Number, required: true })
  closingRatePct!: number;

  /** What that plan was agreed to mean, frozen with it. */
  @Prop({ type: GoalSnapshotSchema, required: true })
  snapshot!: GoalSnapshot;

  @Prop({ type: Date, required: true })
  at!: Date;

  /** Who agreed it. A leader's re-plan carries their name here as on the row (ADR-0046). */
  @Prop({ type: String, required: true })
  byMembershipId!: string;
}
export const GoalRevisionSchema = SchemaFactory.createForClass(GoalRevision);

/**
 * One agent's agreed plan for one period (P8-T1).
 *
 * **`configSchemaOptions`, because this collection owns the word `version`.** It is the goal's own
 * number — bumped on every save, and what re-planning increments (ADR-0042) — so Mongoose's
 * optimistic-concurrency key goes back to `__v`. `activityLogs` and `leads` set the same precedent
 * for the same reason.
 *
 * **Every monetary field ends in `Minor` and holds IDR sen** (invariant §9). The prototype's own
 * `formatRupiah` takes major units, so one mixed-unit field is a hundredfold error that nobody
 * notices until somebody's annual target is wrong by two orders of magnitude. The suffix is the
 * cheapest guard there is.
 */
@Schema({ ...configSchemaOptions, collection: 'goals' })
export class Goal {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /**
   * Whose goal it is — the **membership**, never the user (invariant §2).
   *
   * A person who leaves and rejoins gets a new membership, and the plan they agreed to stays with
   * the office that agreed it rather than following them to the next one.
   */
  @Prop({ type: String, required: true, index: true })
  membershipId!: string;

  /**
   * `'2026'`. Annual in v1 (ADR-0049), and a **field rather than a constant**.
   *
   * It is part of the uniqueness key below, so a second period shape is a value rather than a
   * migration — the same move `kpms.timezone` makes for a product that runs in one zone.
   */
  @Prop({ type: String, required: true })
  period!: string;

  @Prop({ type: String, enum: GOAL_MODES, required: true, default: 'direct' })
  mode!: GoalMode;

  // ------------------------------------------------------------------ inputs

  @Prop({ type: Number, required: true, default: 0 })
  annualApeTargetMinor!: number;

  /** Only meaningful in `from_savings` mode, and kept either way so switching back is lossless. */
  @Prop({ type: Number, required: true, default: 0 })
  savingsTargetMinor!: number;

  @Prop({ type: Number, required: true, default: 0 })
  commissionRatePct!: number;

  /**
   * The cascade's divisor — **only when the agent chose it** (P8-T5).
   *
   * `null` means *use the office's calendar*, and that is the ordinary case. The number in force is
   * then derived on **every read**, which is the whole of client PRD §17: a plan saved in January
   * with 11.9 months left, stored and served back, still claimed 11.9 months in October and a
   * monthly target a fifth of the truth. The agent was told they were comfortably on track while
   * they were far behind.
   *
   * An override is kept because somebody starting in November knows something the calendar does
   * not. A decimal on purpose: 4.3 months is a real answer, and rounding it to 4 moves every number
   * below it.
   */
  @Prop({ type: Number, default: null })
  monthsLeftOverride!: number | null;

  /** Typed by the agent until Phase 9 imports production. */
  @Prop({ type: Number, required: true, default: 0 })
  apeAchievedMinor!: number;

  @Prop({ type: Number, required: true, default: 0 })
  caseSizeMinor!: number;

  @Prop({ type: Number, required: true, default: 0 })
  leadsToApptPct!: number;

  @Prop({ type: Number, required: true, default: 0 })
  closingRatePct!: number;

  // --------------------------------------------------------------- derived

  @Prop({ type: GoalSnapshotSchema, required: true, default: () => ({}) })
  snapshot!: GoalSnapshot;

  @Prop({ type: GoalCascadeMappingSchema, required: true, default: () => ({}) })
  cascadeMapping!: GoalCascadeMapping;

  // ----------------------------------------------------------------- saving

  @Prop({ type: Date, default: null })
  savedAt!: Date | null;

  /**
   * Who saved it, which is not always whose goal it is.
   *
   * A leader sets a downline's goal directly (ADR-0046); this differing from `membershipId` is the
   * whole signal, and the agent's own screen names them. Two columns, so no flag is needed — the
   * same shape `updatedBy` takes on a lead.
   */
  @Prop({ type: String, default: null })
  savedByMembershipId!: string | null;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  /**
   * Every plan this one replaced, oldest first (P8-T6).
   *
   * Append-only. Re-planning is a **new version** and the prior one stays readable (ADR-0042) —
   * a target somebody coached against does not stop having existed because it was revised.
   */
  @Prop({ type: [GoalRevisionSchema], default: [] })
  revisions!: GoalRevision[];

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const GoalSchema = SchemaFactory.createForClass(Goal);

/**
 * **One goal per `(membership, period)`, enforced by the database** (AC-6).
 *
 * Not by a read-then-write: two saves racing — the agent on a phone and their leader on a laptop in
 * the same 1-on-1 — would both read *no goal yet* and both insert. Partial on `deletedAt: null`, so
 * a deleted goal releases the pair the way every other unique index in this product does.
 */
GoalSchema.index(
  { kpmId: 1, membershipId: 1, period: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The leader's read: everybody below them, for one period. `kpmId` leads (invariant §1). */
GoalSchema.index({ kpmId: 1, period: 1, deletedAt: 1 });
