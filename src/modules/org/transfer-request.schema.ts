import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type TransferRequestDocument = HydratedDocument<TransferRequest>;

export const TRANSFER_REQUEST_STATUSES = ['pending', 'approved', 'declined', 'cancelled'] as const;
export type TransferRequestStatus = (typeof TRANSFER_REQUEST_STATUSES)[number];

/**
 * **What made a transfer request** (P19.12-T4; ADR-0247 §3): *+ Add agent* for an agent code held in another leader's
 * unit (`add_agent`, ADR-0170 §4), or a leader moving one of their direct reports to a leader **outside their own tree**
 * (`move`) — inside it they move them directly. A row written before the field existed reads `add_agent`.
 */
export const TRANSFER_REQUEST_KINDS = ['add_agent', 'move'] as const;
export type TransferRequestKind = (typeof TRANSFER_REQUEST_KINDS)[number];

/** The most a leader's note on a move request may hold. */
export const TRANSFER_NOTE_MAX = 300;

/**
 * **A request to move a member to another leader** (ADR-0170 §4, P18.8-T3 AC-3; `functional/org-hierarchy.md`,
 * *Adding an agent*): what *+ Add agent* makes for an agent code whose holder already reports to somebody else in the
 * office, and — since P19.12-T4 (ADR-0247 §3, amending ADR-0170 §4's *no leader moves a member directly*) — what a
 * leader makes to move one of their direct reports to a leader outside their own tree (`kind: 'move'`); inside it they
 * move them directly. The office's Owner and Admins decide it: approving moves the member
 * through `HierarchyService.reparent`, which closes their edge and opens one under the new leader (invariant §5);
 * declining changes nothing.
 *
 * Every party is a membership id (invariant §2). One pending per member — two would let both be approved.
 */
@Schema({ ...baseSchemaOptions, collection: 'transferRequests' })
export class TransferRequest {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** Who would move. */
  @Prop({ type: String, required: true })
  membershipId!: string;

  /** Their leader when it was asked. Approving moves them from whoever leads them then. */
  @Prop({ type: String, default: null })
  fromLeaderId!: string | null;

  /** The leader they would move under: the unit *+ Add agent* was used for. */
  @Prop({ type: String, required: true })
  toLeaderId!: string;

  /** Who asked: the leader, or the Owner or an Admin adding to somebody's unit. */
  @Prop({ type: String, required: true })
  requestedByMembershipId!: string;

  /**
   * **The name whoever asked typed in *+ Add agent*** (the P18.8 exit review, M3), trimmed — which may not be the
   * account's. It is all whoever asked is shown of the person: the agent code finds somebody in another leader's unit,
   * and answering with their own name and leader would let anybody typing codes learn a peer's unit. The office's
   * deciders see both, to spot a code typed for the wrong person. `null` on a request made before it was kept.
   */
  @Prop({ type: String, default: null })
  requestedName!: string | null;

  /** What made it (ADR-0247 §3). Defaulted, so a row written before the field reads `add_agent` with no migration. */
  @Prop({ type: String, enum: TRANSFER_REQUEST_KINDS, default: 'add_agent' })
  kind!: TransferRequestKind;

  /** Why the leader asked for a move, as typed, at most 300 characters; `null` when they said nothing. */
  @Prop({ type: String, default: null, maxlength: TRANSFER_NOTE_MAX })
  note!: string | null;

  @Prop({ type: String, enum: TRANSFER_REQUEST_STATUSES, default: 'pending' })
  status!: TransferRequestStatus;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  @Prop({ type: String, default: null })
  decidedByMembershipId!: string | null;

  /** Why it was declined, sent to whoever asked. */
  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const TransferRequestSchema = SchemaFactory.createForClass(TransferRequest);

/** The office's queue, oldest first, and a requester's own. */
TransferRequestSchema.index({ kpmId: 1, status: 1, createdAt: 1 });
TransferRequestSchema.index({ kpmId: 1, requestedByMembershipId: 1, status: 1 });
/** One open request per member. */
TransferRequestSchema.index(
  { kpmId: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
