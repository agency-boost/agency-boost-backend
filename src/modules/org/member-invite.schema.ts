import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type MemberInviteDocument = HydratedDocument<MemberInvite>;

/**
 * Where an invite stands. **`expired`** is written when it is next read past its `expiresAt`, so a pending row past
 * it never blocks a new invite for the same code; *Resend* makes either `pending` again.
 */
export const MEMBER_INVITE_STATUSES = ['pending', 'accepted', 'cancelled', 'expired'] as const;
export type MemberInviteStatus = (typeof MEMBER_INVITE_STATUSES)[number];

/**
 * **A leader's invite to somebody not in the office yet** (ADR-0170 §2, P18.8-T3 AC-2; `functional/org-hierarchy.md`,
 * *Adding an agent*): what *+ Add agent* makes when no account holds the agent code, or one does and has no membership
 * in this office.
 *
 * - **Tenant-scoped**, keyed to the leader's membership — the unit the person joins — and to the inviter's, who may
 *   be the Owner or an Admin placing them in somebody else's unit.
 * - **Only the token's SHA-256 is kept.** The token is in the answer that makes the link, and *Resend*'s, and nowhere
 *   else — so a link once shared cannot be shown again, and *Resend* makes a new one. It is `{kpmId}.{secret}`, so
 *   opening it reads this office's rows and no other.
 * - **It counts in nothing** until it is accepted: no membership exists, so no roster, count or metric sees it. A
 *   cancelled one leaves nothing behind but this row, the record of who invited whom.
 * - `companyId` is the office's insurer, which issued the code: the code is unique across the company's accounts and
 *   pending invites, and the company spans offices.
 */
@Schema({ ...baseSchemaOptions, collection: 'memberInvites' })
export class MemberInvite {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  companyId!: string;

  /** The leader they join under — the unit — as a membership id (invariant §2). */
  @Prop({ type: String, required: true })
  leaderMembershipId!: string;

  /** Who made it: the leader, or the Owner or an Admin placing them in somebody's unit. */
  @Prop({ type: String, required: true })
  invitedByMembershipId!: string;

  /** Digits only, as the insurer issued it (`AGENT_CODE_PATTERN`). */
  @Prop({ type: String, required: true })
  agentCode!: string;

  /** The name the leader typed. The account's own name wins once they accept. */
  @Prop({ type: String, required: true, trim: true })
  fullName!: string;

  /** Their WhatsApp number as typed; the share link reads it. */
  @Prop({ type: String, required: true, trim: true })
  phone!: string;

  /** An office date: the join date the membership is given when they accept (ADR-0169). */
  @Prop({ type: String, required: true })
  joinDate!: string;

  /** The hex SHA-256 of the token. The token itself is never stored. */
  @Prop({ type: String, required: true })
  tokenHash!: string;

  @Prop({ type: String, enum: MEMBER_INVITE_STATUSES, default: 'pending' })
  status!: MemberInviteStatus;

  /** 14 days after it was made or last resent (`INVITES.EXPIRY_DAYS`). It opens strictly before it. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  /**
   * An account held the code when it was made or last resent: the link opens the signed-in page (`/join?invite=`),
   * where they accept with one button, rather than registration.
   */
  @Prop({ type: Boolean, default: false })
  existingAccount!: boolean;

  @Prop({ type: Date, default: null })
  resentAt!: Date | null;

  @Prop({ type: String, default: null })
  acceptedMembershipId!: string | null;

  /**
   * **The recruitment lead the form was opened from** (P19.1-T6 AC-7): *Tambahkan ke unit ›* on the *Potensi* tab. When
   * the invite is accepted the lead is linked to the membership it made (`RecruitLeadLinks.link`). `null` otherwise.
   */
  @Prop({ type: String, default: null })
  recruitLeadId!: string | null;

  @Prop({ type: Date, default: null })
  acceptedAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  @Prop({ type: String, default: null })
  cancelledByMembershipId!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership ids, never a user id or a name (invariant §2). */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const MemberInviteSchema = SchemaFactory.createForClass(MemberInvite);

/** Opening a link: one per token in an office. */
MemberInviteSchema.index({ kpmId: 1, tokenHash: 1 }, { unique: true });
/** *Waiting to join* on `/new-hires`: a leader's invites, newest first. */
MemberInviteSchema.index({ kpmId: 1, leaderMembershipId: 1, status: 1, createdAt: -1 });
/** One invite waiting per agent code in an office — the database's half of the company-wide check. */
MemberInviteSchema.index(
  { kpmId: 1, agentCode: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
