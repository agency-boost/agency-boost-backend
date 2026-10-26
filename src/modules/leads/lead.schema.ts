import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type LeadDocument = HydratedDocument<Lead>;

export const LEAD_TYPES = ['sales', 'recruitment'] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export const LEAD_OUTCOMES = ['won', 'lost'] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

/**
 * Why this person's details may be held (UU 27/2022) — **as recorded until 2026-10-07.**
 *
 * Three grounds, because three are what an agent in the field actually has. `consent` is the
 * ordinary one; `contract` covers somebody already mid-application; `legitimate_interest` covers a
 * referral the agent has not yet spoken to.
 *
 * **No route writes or returns one any more** (ADR-0108 §1): the product owner set the PDP question
 * aside and the client removed the field. The enum stays because the column does — rows written
 * before that day keep what they hold, and a schema that no longer knew the values would refuse to
 * save a row carrying one.
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

/**
 * *I will close this one this month.* The agent's own promise, and the month they made it for.
 *
 * **One entry per month, and only the current month's is ever touched.** A promise about September
 * stops being editable when September ends, because by then it is a thing that was said rather than
 * a thing being decided — which is what makes it answerable afterwards. Un-ticking the box inside
 * the month removes that month's entry: correcting today's promise is not rewriting history.
 */
@Schema({ _id: false })
export class LeadCommitment {
  /** `YYYY-MM` in the **office's** timezone, never the server's or the browser's (invariant §9). */
  @Prop({ type: String, required: true })
  month!: string;

  @Prop({ type: Date, required: true })
  at!: Date;

  /** Who promised. A leader may commit a downline's lead (ADR-0044), and this is how that shows. */
  @Prop({ type: String, required: true })
  byMembershipId!: string;
}
export const LeadCommitmentSchema = SchemaFactory.createForClass(LeadCommitment);

/** Whatever contact detail the agent has. Both optional, and since 2026-10-07 nothing asked beside them. */
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
 * party who never met AgencyBoost and cannot see what is written about them. The soft delete and the
 * admin read that returns counts rather than rows follow from that one difference, as the lawful basis
 * did until ADR-0108 set it aside.
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
   * Why the contact details may be held, and when that was recorded. **Kept, unwritten, since
   * 2026-10-07** (ADR-0108 §1): the API neither takes nor returns either, and nothing clears them,
   * so a value written while the rule stood is still here — a deploy is not an erasure. A new lead
   * gets the defaults.
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

  /**
   * Every month this lead was promised for, oldest first (P7-T5).
   *
   * **There is no stored `thisMonth`, and that is the rollover.** It was a boolean, and a boolean
   * has to be *cleared* by something — which the prototype does in `localStorage`, per agent, so a
   * commitment silently persists for anybody who does not open the app (`leads-management.md` §4).
   * A job on the server would fix that and introduce its own failure: a sweep that does not run
   * leaves every office wrong, and nothing on any screen says so.
   *
   * Holding the **month** instead makes the flag derived — *is there an entry for the office's
   * current month?* — so it is right on the first of the month for an agent who has not opened the
   * app since March, with nothing having run. The same reasoning as the attention flags: a stored
   * flag is one that is wrong at midnight.
   *
   * And it is the archive. *Did they do what they said in September* is a question about a promise
   * that was made, so the promise is written down when it is made rather than swept into a second
   * collection later.
   */
  @Prop({ type: [LeadCommitmentSchema], default: [] })
  commitments!: LeadCommitment[];

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
   * **Where the lead sits in its owner's list**, smallest first (P18.8-T7, ADR-0161 §1).
   *
   * The owner's, and nobody else's: `GET /leads` without `sort` reads it, and `PATCH /leads/order` is
   * the only route that writes it, with the caller's own open leads in the order they dragged them. A new
   * lead takes one less than the owner's first, so it goes to the top. Migration 0031 filled it from the
   * date registered, newest first, so nobody's list moved on the day it arrived.
   *
   * **Presentation, so no write here bumps `version` or names an editor.** A leader's pinned edit in a
   * 1-on-1 does not conflict with the agent tidying their list, and the ✎ still names the leader. `null`
   * is a lead nothing has placed yet — a row written before 0031 ran — and sorts first, as a new one does.
   */
  @Prop({ type: Number, default: null })
  position!: number | null;

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
 * first, which is the prototype's default sort — and since P18.8-T7 the `dateRegistered` sort and the
 * closed cards, the default being the owner's own order (the last index below).
 */
LeadSchema.index({ kpmId: 1, ownerMembershipId: 1, deletedAt: 1, dateRegistered: -1 });

/** The office-wide rollups P7-T6 computes: open leads of one type, and the late-stage ones. */
LeadSchema.index({ kpmId: 1, type: 1, outcome: 1, statusCode: 1, deletedAt: 1 });

/** Triage: what is overdue, across the office or one member's list. */
LeadSchema.index({ kpmId: 1, ownerMembershipId: 1, nextActionDate: 1, deletedAt: 1 });

/**
 * The owner's own order (P18.8-T7): `GET /leads` without `sort`, and the first place a new lead takes,
 * which is one less than the owner's smallest.
 */
LeadSchema.index({ kpmId: 1, ownerMembershipId: 1, position: 1 });
