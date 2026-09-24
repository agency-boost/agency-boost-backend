import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type LeadDocument = HydratedDocument<Lead>;

export const LEAD_TYPES = ['sales', 'recruitment'] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export const LEAD_OUTCOMES = ['won', 'lost'] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

/**
 * Why this person's details may be held (UU 27/2022).
 *
 * Three grounds, because three are what an agent in the field actually has. `consent` is the
 * ordinary one; `contract` covers somebody already mid-application; `legitimate_interest` covers a
 * referral the agent has not yet spoken to. A free-text field would record a sentence nobody can
 * report on, which is the opposite of what the regulation asks for.
 */
export const LAWFUL_BASES = ['consent', 'contract', 'legitimate_interest'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

/** One move along a ladder, kept. Append-only — see `transitions` below. */
@Schema({ _id: false })
export class LeadTransition {
  /** `null` on the first move: the lead had no status before it. */
  @Prop({ type: String, default: null })
  fromStatusCode!: string | null;

  @Prop({ type: String, required: true })
  toStatusCode!: string;

  @Prop({ type: Date, required: true })
  at!: Date;

  /**
   * **Who moved it, which is not always whose lead it is.** A leader may write a downline's lead
   * (ADR-0044); a proxy edit is recognisable by this differing from `ownerMembershipId`, and so
   * needs no flag of its own.
   */
  @Prop({ type: String, required: true })
  byMembershipId!: string;
}
export const LeadTransitionSchema = SchemaFactory.createForClass(LeadTransition);

/** Whatever contact detail the agent has. Both optional; neither free of a lawful basis. */
@Schema({ _id: false })
export class LeadContact {
  @Prop({ type: String, default: null, trim: true })
  phone!: string | null;

  @Prop({ type: String, default: null, trim: true, lowercase: true })
  email!: string | null;
}
export const LeadContactSchema = SchemaFactory.createForClass(LeadContact);

/**
 * One person an agent is working (P7-T1).
 *
 * **The first record in this product about somebody who is not a user of it.** An activity log is
 * an agent's account of their own day; this is a name, a phone number and a note about a third
 * party who never met AgencyBoost and cannot see what is written about them. The lawful basis, the
 * soft delete and the admin read that returns counts rather than rows all follow from that one
 * difference.
 *
 * **`configSchemaOptions`, not `baseSchemaOptions`** — the same choice `activityLogs` made, and for
 * the same reason. `version` here is the domain's number: what a write pins so that two people in
 * one 1-on-1 cannot overwrite each other (P7-T7). `baseSchemaOptions` spends that name on
 * Mongoose's own counter, which moves when Mongoose decides to.
 */
@Schema({ ...configSchemaOptions, collection: 'leads' })
export class Lead {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /**
   * The agent whose lead it is, and the thing a leader's edit is measured against.
   *
   * The **membership** `_id` — never a `userId`, never a name (invariant §2). A person who leaves
   * and rejoins gets a new membership, and the leads they worked stay with the office that owns
   * them rather than following the person.
   */
  @Prop({ type: String, required: true, index: true })
  ownerMembershipId!: string;

  /**
   * `null` is a real state, not a missing value: the prototype lets a lead be saved before the
   * agent picks a ladder and renders it as *Unassigned* (`Overall.html:6160`).
   */
  @Prop({ type: String, enum: LEAD_TYPES, default: null })
  type!: LeadType | null;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: LeadContactSchema, default: () => ({ phone: null, email: null }) })
  contact!: LeadContact;

  /**
   * Why the contact details may be held. **Required before either is stored**, and not before the
   * lead is: an agent jotting down a name from a Thursday BOP has collected nothing the regulation
   * governs; the moment they add the phone number they have.
   */
  @Prop({ type: String, enum: LAWFUL_BASES, default: null })
  lawfulBasis!: LawfulBasis | null;

  @Prop({ type: Date, default: null })
  consentAt!: Date | null;

  /** What the lead holds. Renaming a status moves neither this nor the id beside it. */
  @Prop({ type: String, default: null, uppercase: true, trim: true })
  statusCode!: string | null;

  /** The convenience beside the code, as `activityTypeId` sits beside `activityTypeCode`. */
  @Prop({ type: String, default: null })
  statusId!: string | null;

  /** The agent's own commitment for the month. Cleared by the rollover, not by remembering (P7-T5). */
  @Prop({ type: Boolean, required: true, default: false })
  thisMonth!: boolean;

  @Prop({ type: String, default: null, trim: true })
  remarks!: string | null;

  /** `YYYY-MM-DD` in the **tenant's** timezone, like every other day boundary (invariant §9). */
  @Prop({ type: String, default: null })
  nextActionDate!: string | null;

  @Prop({ type: String, default: null, trim: true })
  nextActionNote!: string | null;

  /**
   * **One vocabulary.** The agent screen writes `success`/`fail` and the coaching screen writes
   * `won`/`lost` for the same field; `won`/`lost` wins because it is what the Owner's settings
   * screen and every downstream metric already say.
   */
  @Prop({ type: String, enum: LEAD_OUTCOMES, default: null })
  outcome!: LeadOutcome | null;

  @Prop({ type: Date, default: null })
  outcomeAt!: Date | null;

  @Prop({ type: Date, default: null })
  dateRegistered!: Date | null;

  @Prop({ type: String, default: null, trim: true })
  source!: string | null;

  /**
   * The domain's version, bumped on every write and pinned by the next one (P7-T7).
   *
   * Starts at 1 rather than 0: a client that read a lead and sends `version: 0` back should be
   * telling the truth about what it saw, and 0 is the value an uninitialised field has.
   */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  /**
   * Every move along the ladder, oldest first. **Append-only**: the lead's current status is the
   * last row's destination, and this is what makes a jump legible and a leader's edit attributable
   * (ADR-0044, ADR-0045).
   */
  @Prop({ type: [LeadTransitionSchema], default: [] })
  transitions!: LeadTransition[];

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership id of the actor, never a userId and never a name. */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const LeadSchema = SchemaFactory.createForClass(Lead);

/**
 * Every index leads with `kpmId` (invariant §1).
 *
 * The agent's own screen is the read this collection exists for: one member's live leads, newest
 * first, which is the prototype's default sort.
 */
LeadSchema.index({ kpmId: 1, ownerMembershipId: 1, deletedAt: 1, dateRegistered: -1 });

/** The office-wide rollups P7-T6 computes: open leads of one type, and the late-stage ones. */
LeadSchema.index({ kpmId: 1, type: 1, outcome: 1, statusCode: 1, deletedAt: 1 });

/** Triage: what is overdue, across the office or one member's list. */
LeadSchema.index({ kpmId: 1, ownerMembershipId: 1, nextActionDate: 1, deletedAt: 1 });
