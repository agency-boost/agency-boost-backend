import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import {
  PROPOSAL_CHANNELS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_STATUSES,
  type ProposalChannel, type ProposalPayFrequency, type ProposalStatus,
} from '@/domain/constants';
import type { StoredItem } from './proposal-items';

export type ProposalDocument = HydratedDocument<Proposal>;

/** The client's copy, taken from the lead when step 1 is completed (ADR-0221 §1). */
export interface ProposalClientCopy {
  name: string;
  /** The age at the next birthday on the day it was taken: the premium was quoted for it. */
  age: number;
  gender: 'male' | 'female';
}

/**
 * **A proposal: the agent's own record of what was offered to one of their Sales leads** (P19.7-T2; ADR-0221 §1;
 * `erd.md`, *Tenant: the proposal*). One document, its items inside it, so an autosave is one write with one version and
 * the three steps and the PDF are one read.
 *
 * - **`kpmId` leads every index**, and every read and write goes through `ProposalRepository` (invariant §1).
 * - **Owned by one membership** (`ownerMembershipId`, invariant §2) and answered to nobody else: another member's — a
 *   leader's downline's included — is `404 PROPOSAL_NOT_FOUND`.
 * - **`items` are stored as plain objects** (`StoredItem`, checked by `proposal-items.ts`), as a product's proposal fields
 *   are: an item is never read without its proposal, and its shape is the snapshot's (ADR-0225 §6).
 * - **No share token, and no field a public route could read** (decision 3). **Soft delete** (invariant §6).
 * - `version` is the domain's number, pinned by every write (`expectedVersion`); `configSchemaOptions` keeps Mongoose's
 *   own counter out of it, as the lead's is.
 */
@Schema({ ...configSchemaOptions, collection: 'proposals' })
export class Proposal {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** The agent's membership `_id`: the proposal's owner, and the only reader. */
  @Prop({ type: String, required: true })
  ownerMembershipId!: string;

  /** One of the owner's Sales leads. Kept when the lead is deleted: the proposal stays under the client's name. */
  @Prop({ type: String, required: true })
  leadId!: string;

  @Prop({ type: Object, required: true })
  client!: ProposalClientCopy;

  @Prop({ type: String, enum: PROPOSAL_CHANNELS, default: 'conventional' })
  channel!: ProposalChannel;

  @Prop({ type: String, enum: PROPOSAL_PAY_FREQUENCIES, default: 'monthly' })
  payFrequency!: ProposalPayFrequency;

  /** *Tampilkan total premi*, off by default (Acc. 19's sibling; T3's switch). */
  @Prop({ type: Boolean, default: false })
  showTotal!: boolean;

  @Prop({ type: String, enum: PROPOSAL_STATUSES, default: 'draft' })
  status!: ProposalStatus;

  /** The last *Simpan PDF*. */
  @Prop({ type: Date, default: null })
  doneAt!: Date | null;

  /** The first *Simpan PDF*, written once: `PROPOSALS_MADE` counts it, and the lead's note is dated by it. */
  @Prop({ type: Date, default: null })
  firstDoneAt!: Date | null;

  /** The item names at the first *Simpan PDF*, in order, written once: the lead's *"Proposal dibuat · …"*. */
  @Prop({ type: [String], default: [] })
  firstDoneProducts!: string[];

  @Prop({ type: [Object], default: [] })
  items!: StoredItem[];

  /** The proposal this one was duplicated from, or `null`. */
  @Prop({ type: String, default: null })
  duplicatedFrom!: string | null;

  /** Monotonic, every write; a write pinned to an older one is `409 VERSION_CONFLICT`. Starts at 1. */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  deletedBy!: string | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ProposalSchema = SchemaFactory.createForClass(Proposal);

/** *Riwayat*: the owner's live proposals, newest change first (ADR-0221 §1). */
ProposalSchema.index({ kpmId: 1, ownerMembershipId: 1, deletedAt: 1, updatedAt: -1 });
/** The lead list's pill and the lead sheet's *Proposal* section. */
ProposalSchema.index({ kpmId: 1, leadId: 1, deletedAt: 1, updatedAt: -1 });
/** The leaders' counts, `PROPOSALS_MADE` (§A.16). */
ProposalSchema.index({ kpmId: 1, ownerMembershipId: 1, firstDoneAt: 1 });
