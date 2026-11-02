import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type ImpersonationSessionDocument = HydratedDocument<ImpersonationSession>;

/** Why a session is started (ADR-0162 §1): to look, or to set an office up as its Owner or Admin would. */
export const IMPERSONATION_PURPOSES = ['support', 'setup'] as const;
export type ImpersonationPurpose = (typeof IMPERSONATION_PURPOSES)[number];

/**
 * One support session: who ran it, as whom, in which office, and what they could do
 * (P4-T10).
 *
 * **Not a row in `authTokens`, and not two rows.** The session was a credential there, and
 * the things §3.13 asks for — read-only by default, a second Super Admin's approval to
 * write, an Owner-readable log — are properties of the *session*, not of a token.
 * Splitting them across two collections would give the same session two places to be
 * described from, and one of them would eventually be stale.
 *
 * It is the **liveness switch** too: `AuthGuard` looks it up for any `imp:` token, which
 * is what makes ending a session bite against a stateless JWT.
 *
 * **`kpmId` is the office the session acts inside**, recorded so an Owner can read their
 * own tenant's sessions. It is nullable only for a target who is in no office — somebody
 * registered and not yet joined, whose support case is about exactly that.
 */
@Schema({ ...baseSchemaOptions, collection: 'impersonationSessions' })
export class ImpersonationSession {
  /** The Super Admin actually acting. */
  @Prop({ type: String, required: true, index: true })
  realActorUserId!: string;

  /** Whose screens they are seeing. */
  @Prop({ type: String, required: true, index: true })
  effectiveUserId!: string;

  @Prop({ type: String, default: null, index: true })
  kpmId!: string | null;

  /** Hash of the minted access token. The guard's lookup key. */
  @Prop({ type: String, required: true, unique: true, index: true })
  tokenHash!: string;

  /**
   * **True unless a second Super Admin said otherwise.** A support session that can write
   * is a support session that can break an office, and the operator who wants to write is
   * not the one who gets to decide they may.
   */
  @Prop({ type: Boolean, required: true, default: true })
  readOnly!: boolean;

  /**
   * **Why the session was started** (ADR-0162 §1): `support` to look, `setup` to configure an office as its
   * Owner or Admin would. Chosen at the start and never changed.
   */
  @Prop({ type: String, enum: [...IMPERSONATION_PURPOSES], required: true, default: 'support' })
  purpose!: ImpersonationPurpose;

  /**
   * **What a read-only session may write all the same** (ADR-0162 §2): `SETUP_SESSION_WRITE_SCOPE` for a setup
   * session, empty for a support one. Stored rather than derived from `purpose`, so a session already running
   * keeps the scope it was started with and the row says exactly what was extended.
   */
  @Prop({ type: [String], default: [] })
  writeScope!: string[];

  /** The second Super Admin who approved writing. Never the one who started the session. */
  @Prop({ type: String, default: null })
  elevatedByUserId!: string | null;

  @Prop({ type: Date, default: null })
  elevatedAt!: Date | null;

  /** Typed by the operator at the start, and again at elevation. Shown in the Owner's log. */
  @Prop({ type: String, required: true })
  reason!: string;

  @Prop({ type: String, default: null })
  elevationReason!: string | null;

  @Prop({ type: Date, required: true })
  startedAt!: Date;

  @Prop({ type: Date, required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  endedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const ImpersonationSessionSchema = SchemaFactory.createForClass(ImpersonationSession);

/** The Owner's log: this office's sessions, newest first. */
ImpersonationSessionSchema.index({ kpmId: 1, startedAt: -1 });

/** Ending every session an operator has open. */
ImpersonationSessionSchema.index({ effectiveUserId: 1, endedAt: 1 });
