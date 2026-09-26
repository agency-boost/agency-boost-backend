import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type PolicyDocument = HydratedDocument<Policy>;

/**
 * Where a policy came from — which of the three writers put it here.
 *
 * `imported` is the carrier's file; `derived_from_lead` is a won lead posting the policy it became
 * (not yet wired — `metrics-and-definitions.md` registers it as a known gap); `manual` is a person
 * typing one in. The same three-way split `monthlyAgentData` carries per cell as `provenance`, at
 * the grain of one contract rather than one month.
 */
export const POLICY_SOURCES = ['imported', 'derived_from_lead', 'manual'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

/** Submitted to the carrier, issued by it, or lapsed after issue — the states persistency counts. */
export const POLICY_STATUSES = ['submitted', 'issued', 'lapsed'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/**
 * One contract: the per-policy production line item beneath the monthly aggregate (P9-T1).
 *
 * **Why a row per policy when the carrier reports per month.** Without it there is no provenance
 * beneath the aggregate — a month's APE is a figure with nothing under it — APE can never be derived
 * from a won lead, and case size cannot be computed from anything real. The monthly row is what the
 * carrier sends; this is what it is made of, when that is known.
 *
 * **Money is integer minor units** (invariant §9). The file the carrier sends is denominated in
 * *Rp M*; nothing at that unit is ever stored.
 *
 * **Keyed on the membership, never the user or the name** (invariant §2). A person who leaves and
 * rejoins is a new membership; the policies they wrote stay with the office that holds them.
 */
@Schema({ ...baseSchemaOptions, collection: 'policies' })
export class Policy {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, index: true })
  membershipId!: string;

  /** The lead this policy closed, when it came from one. */
  @Prop({ type: String, default: null })
  leadId!: string | null;

  /** The company's product, when the file names one. */
  @Prop({ type: String, default: null })
  productId!: string | null;

  /** The carrier's own number. Unique within the office where present; a file may omit it. */
  @Prop({ type: String, default: null })
  policyNumber!: string | null;

  @Prop({ type: Number, required: true, default: 0 })
  apeMinor!: number;

  @Prop({ type: Number, required: true, default: 0 })
  fypMinor!: number;

  @Prop({ type: Date, default: null })
  submittedAt!: Date | null;

  @Prop({ type: Date, default: null })
  issuedAt!: Date | null;

  @Prop({ type: String, enum: POLICY_STATUSES, required: true, default: 'submitted' })
  status!: PolicyStatus;

  @Prop({ type: String, enum: POLICY_SOURCES, required: true })
  source!: PolicySource;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const PolicySchema = SchemaFactory.createForClass(Policy);

/** One agent's policies for a period, newest issue first — what case size is computed from. */
PolicySchema.index({ kpmId: 1, membershipId: 1, issuedAt: -1, deletedAt: 1 });
/** A carrier number is issued once. Partial, because a file may not carry one. */
PolicySchema.index(
  { kpmId: 1, policyNumber: 1 },
  { unique: true, partialFilterExpression: { policyNumber: { $type: 'string' }, deletedAt: null } },
);
