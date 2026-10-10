import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type LeaderMeetingShareLinkDocument = HydratedDocument<LeaderMeetingShareLink>;

/**
 * **A meeting's shared link** (OD-146, ADR-0131, D-share; `functional/leader-forum.md`, *The share links*): it
 * opens the meeting read-only for any signed-in member of the office until it expires or is revoked.
 *
 * **Only the token's SHA-256 is kept.** The raw token is in the answer that makes the link and nowhere else, as
 * `authTokens` holds its tokens — so a link once made cannot be shown again, and *Share* makes a fresh one each
 * time it is opened. A link is looked up by `(kpmId, tokenHash)` inside the reader's own office, so another
 * office's link is not found. Nothing is hard-deleted: an expired or revoked link is the record of who shared
 * what, and when.
 */
@Schema({ ...baseSchemaOptions, collection: 'leaderMeetingShareLinks' })
export class LeaderMeetingShareLink {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  meetingId!: string;

  /** The hex SHA-256 of the token: the token itself is never stored. */
  @Prop({ type: String, required: true })
  tokenHash!: string;

  /** `createdAt` + `LEADER_MEETING_SHARE_DAYS`: the link opens strictly before it. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  /** The membership that revoked it — *Stop sharing* revokes every live link to the meeting. */
  @Prop({ type: String, default: null })
  revokedBy!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership ids, never a user id or a name (invariant §2). */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const LeaderMeetingShareLinkSchema = SchemaFactory.createForClass(LeaderMeetingShareLink);

/** Opening a link: one per token in an office. */
LeaderMeetingShareLinkSchema.index({ kpmId: 1, tokenHash: 1 }, { unique: true });
/** *Stop sharing*: a meeting's live links. */
LeaderMeetingShareLinkSchema.index({ kpmId: 1, meetingId: 1 });
