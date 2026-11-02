import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type LeaderLimitRequestDocument = HydratedDocument<LeaderLimitRequest>;

/** What the office asked AgencyBoost to let it do past its leader limit (ADR-0157 §1). */
export type LeaderLimitAction = 'promote' | 'activate';
export const LEADER_LIMIT_ACTIONS: readonly LeaderLimitAction[] = ['promote', 'activate'];

export type LeaderLimitRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled';
export const LEADER_LIMIT_REQUEST_STATUSES: readonly LeaderLimitRequestStatus[] = [
  'pending', 'approved', 'declined', 'cancelled',
];

/**
 * **A leader past the office's limit, waiting for AgencyBoost** (ADR-0157 §2).
 *
 * The write the leader limit refused — a role change onto a leader rung, or approving a pending member who
 * stands on one — kept as a request the Super Admin decides. Approved, the server carries it out **past the
 * limit**, after checking it still applies; declined, nothing about the member changes. The quota does not
 * move, so an office with approved requests reads above it (`13 / 10`).
 *
 * **Tenant-scoped**, unlike `kpmRequests`: the office exists and the subject is one of its members, so the row
 * carries `kpmId`, leading every index, and is read through `LeaderLimitRequestRepository`. The Super Admin, in
 * no office, reads the queue and one request through that repository's two named unscoped methods
 * (`multi-tenancy-and-scoping.md`).
 *
 * People are memberships, never names (invariant §2): the subject, who asked, and — for an activation —
 * whose unit they join.
 */
@Schema({ ...baseSchemaOptions, collection: 'leaderLimitRequests' })
export class LeaderLimitRequest {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** The member who would become a leader. */
  @Prop({ type: String, required: true })
  subjectMembershipId!: string;

  @Prop({ type: String, enum: LEADER_LIMIT_ACTIONS, required: true })
  action!: LeaderLimitAction;

  /**
   * The rung the subject stood on when the request was made. Approval re-checks it: a member moved since
   * is not the member the office asked about, and the request is closed as no longer applying.
   */
  @Prop({ type: String, required: true })
  fromOrgLevelCode!: string;

  /** `promote` only: the rung the office asked for, by code (invariant §4). */
  @Prop({ type: String, default: null })
  toOrgLevelCode!: string | null;

  /** `promote` only: the reason the office gave, kept for the role change log when it is carried out. */
  @Prop({ type: String, default: null, trim: true, maxlength: 300 })
  reason!: string | null;

  /**
   * `activate` only: the join request being approved, or `null` when the act is a tag — the requester
   * picking an untagged member up into their own unit.
   */
  @Prop({ type: String, default: null })
  joinRequestId!: string | null;

  /** `activate` only: whose unit the member joins — the leader their request names, or the tagger. */
  @Prop({ type: String, default: null })
  leaderMembershipId!: string | null;

  /** Who asked: the Owner, an Admin, or the AB or AAB whose act it was. */
  @Prop({ type: String, required: true })
  requestedByMembershipId!: string;

  @Prop({ type: String, enum: LEADER_LIMIT_REQUEST_STATUSES, default: 'pending' })
  status!: LeaderLimitRequestStatus;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  /** The Super Admin who decided, or the member who cancelled. A user id: the Super Admin has no membership. */
  @Prop({ type: String, default: null })
  decidedByUserId!: string | null;

  /** Why it was declined — the Super Admin's words, or that it no longer applied. */
  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  declineReason!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const LeaderLimitRequestSchema = SchemaFactory.createForClass(LeaderLimitRequest);

/** The office's requests, newest first — the person page, the Pending tab. */
LeaderLimitRequestSchema.index({ kpmId: 1, status: 1, createdAt: -1 });

/**
 * **One open request per subject** (AC-1). Two pending asks about one member would be two approvals of one
 * act. Scoped to `pending` so a declined or cancelled request does not block asking again.
 */
LeaderLimitRequestSchema.index(
  { kpmId: 1, subjectMembershipId: 1 },
  {
    name: 'one_open_request_per_subject',
    unique: true,
    partialFilterExpression: { status: 'pending', deletedAt: null },
  },
);
