import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import type { RoleClass } from '@/domain/constants';

export type UserInvitationDocument = HydratedDocument<UserInvitation>;

/**
 * Where an invitation stands. **`expired` is never written**: a `pending` row past `expiresAt` reads as expired
 * (`userInvitationStateOf`), so *Kirim ulang* revives it with a new link and nothing has to sweep the collection.
 */
export const USER_INVITATION_STATUSES = ['pending', 'accepted', 'cancelled'] as const;
export type UserInvitationStatus = (typeof USER_INVITATION_STATUSES)[number];

/**
 * ***Tambah user*'s invitation** (P19.28-T1 AC-1, AC-4; ADR-0286 §2; the 21 November brief, F-1): a person added to a KPM
 * from the shared sheet — by the Super Admin in any KPM, by an Owner or a KPM Admin in their own — who has not opened
 * the link yet. *Diundang · <date>* in Anggota's *Menunggu*, with *Kirim ulang* and *Batalkan*.
 *
 * **Not yet a membership** (ADR-0286 §2): a membership needs the person's account and the agent code their insurer
 * issued (ADR-0017), and the sheet asks for neither — a name, a WhatsApp number and, if they have one, an email. So
 * the invitation carries the **placement** — the KPM, the rung, the leader, *Jadikan KPM Owner* — and the person's
 * membership is made, *Aktif* at once, when they open the link and accept it signed in (after signing up, for
 * somebody new). Until then it counts in nothing: no roster, count or metric reads this collection.
 *
 * - **Tenant-scoped**: `kpmId` leads every index, and the link's token is `{kpmId}.{secret}`, so opening it reads this
 *   KPM's rows and no other.
 * - **Only the token's SHA-256 is kept.** The link is in the answer that made it, or *Kirim ulang*'s, and nowhere else.
 * - **One waiting invitation per number per KPM** (the partial unique index): a second *Tambah* of the same number is
 *   `409 ORG_INVITE_PENDING`, not two links.
 * - **Cancelled, it stays**: the row is the record of who invited whom (`cancelledAt`, `cancelledByUserId`).
 * - **`userId`**: the account the number or email belonged to when the invitation was made, if one did — then only that
 *   account may accept it. `null` for somebody new: any account of the KPM's company with an agent code, and no
 *   active membership, accepts it.
 */
@Schema({ ...baseSchemaOptions, collection: 'userInvitations' })
export class UserInvitation {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** *Nama lengkap* as typed. The account's own name wins once they accept. */
  @Prop({ type: String, required: true, trim: true })
  fullName!: string;

  /** *Nomor WhatsApp*, stored `+62…` (`normalisePhone`): what WhatsApp opens to. */
  @Prop({ type: String, required: true, trim: true })
  phone!: string;

  /** *Email · opsional*, lower-cased, or `null`. */
  @Prop({ type: String, default: null, lowercase: true, trim: true })
  email!: string | null;

  /** The account the number or email named when it was made, or `null` for somebody new. */
  @Prop({ type: String, default: null })
  userId!: string | null;

  /** *Peran*: the rung's code on the KPM's company ladder (ADR-0006: a code, never a position). */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  orgLevelCode!: string;

  /** The rung's class (ADR-0156), kept so Anggota's tabs and the orange label need no ladder read. */
  @Prop({ type: String, enum: ['ab', 'aab', 'agent'], required: true })
  roleClass!: RoleClass;

  /** *Leader* → `memberships._id` (invariant §2); `null` for an AB. */
  @Prop({ type: String, default: null })
  leaderMembershipId!: string | null;

  /** *Jadikan KPM Owner*: accepting also makes them an owner of the KPM (19.27's `KpmOwnersService.add`). */
  @Prop({ type: Boolean, default: false })
  makeOwner!: boolean;

  /** The KPM was made with this invitation (*＋ KPM baru*): its first owner is whoever accepts. */
  @Prop({ type: Boolean, default: false })
  newKpm!: boolean;

  /** Who invited: the account — a Super Admin is in no membership. */
  @Prop({ type: String, required: true })
  invitedByUserId!: string;

  /** Who invited, as a member of this KPM (an Owner or an Admin); `null` for the Super Admin. */
  @Prop({ type: String, default: null })
  invitedByMembershipId!: string | null;

  /** The hex SHA-256 of the token. The token itself is never stored. */
  @Prop({ type: String, required: true })
  tokenHash!: string;

  @Prop({ type: String, enum: USER_INVITATION_STATUSES, default: 'pending' })
  status!: UserInvitationStatus;

  /** When it was sent, or last sent again: *Diundang · <date>* reads it. */
  @Prop({ type: Date, required: true })
  invitedAt!: Date;

  /** `INVITES.EXPIRY_DAYS` after `invitedAt`. The link opens strictly before it. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  resentAt!: Date | null;

  @Prop({ type: Date, default: null })
  acceptedAt!: Date | null;

  @Prop({ type: String, default: null })
  acceptedMembershipId!: string | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  @Prop({ type: String, default: null })
  cancelledByUserId!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership ids, as every tenant-scoped row writes them (`null` for the Super Admin). */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const UserInvitationSchema = SchemaFactory.createForClass(UserInvitation);

/** Opening a link: one per token in a KPM. */
UserInvitationSchema.index({ kpmId: 1, tokenHash: 1 }, { unique: true });
/** Anggota's *Menunggu* and a KPM's own list: the waiting ones, newest first. */
UserInvitationSchema.index({ kpmId: 1, status: 1, invitedAt: -1 });
/** One waiting invitation per number in a KPM — the database's half of the check `add` makes first. */
UserInvitationSchema.index(
  { kpmId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { status: 'pending', deletedAt: null } },
);

/** How an invitation reads now: `expired` is a pending one past its `expiresAt`, computed and never stored. */
export type UserInvitationState = 'pending' | 'expired' | 'accepted' | 'cancelled';

export function userInvitationStateOf(
  row: { status: UserInvitationStatus; expiresAt: Date },
  now: Date,
): UserInvitationState {
  if (row.status !== 'pending') return row.status;
  return row.expiresAt.getTime() > now.getTime() ? 'pending' : 'expired';
}
