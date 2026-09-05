import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type JoinRequestDocument = HydratedDocument<JoinRequest>;

export type JoinRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled';

/**
 * "I would like {leader} to be my leader."
 *
 * Separate from the membership because the two answer different questions. The
 * membership says *which office you are attached to* — registered the moment you pick
 * one, `pending` until somebody approves you. This says *who you asked to lead you*,
 * and it is the row the approval inbox reads.
 *
 * Keeping them apart is what lets an agent register an office, be refused by one
 * leader, and ask another without re-registering.
 */
@Schema({ ...baseSchemaOptions, collection: 'joinRequests' })
export class JoinRequest {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** The asker's membership — pending until this is approved. */
  @Prop({ type: String, required: true, index: true })
  membershipId!: string;

  /** Who they asked. */
  @Prop({ type: String, required: true, index: true })
  leaderMembershipId!: string;

  /**
   * Where an approver sent them instead — one of their own AABs (P3-T5). Null while it
   * sits with the person originally asked.
   */
  @Prop({ type: String, default: null })
  routedToMembershipId!: string | null;

  @Prop({
    type: String,
    enum: ['pending', 'approved', 'declined', 'cancelled'],
    default: 'pending',
    index: true,
  })
  status!: JoinRequestStatus;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  @Prop({ type: String, default: null })
  decidedByMembershipId!: string | null;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const JoinRequestSchema = SchemaFactory.createForClass(JoinRequest);

/** The approver's inbox: everything waiting on me, newest first. */
JoinRequestSchema.index({ kpmId: 1, leaderMembershipId: 1, status: 1, createdAt: -1 });

/**
 * One outstanding ask at a time.
 *
 * Without this, a rapid double submit creates two rows and an approver sees the same
 * person twice — approving one and declining the other leaves the membership in a state
 * neither decision describes.
 */
JoinRequestSchema.index(
  { kpmId: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
