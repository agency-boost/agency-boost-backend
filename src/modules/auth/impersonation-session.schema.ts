import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type ImpersonationSessionDocument = HydratedDocument<ImpersonationSession>;

/**
 * Why a session was started. **A row may still read `setup`** (ADR-0162 §1, superseded): rows are history and keep
 * what they were started with. Since P19.4-T2 (ADR-0206 §3) a session is started `support` only, and a start that asks
 * for `setup` is `400 VALIDATION_FAILED`.
 */
export const IMPERSONATION_PURPOSES = ['support', 'setup'] as const;
export type ImpersonationPurpose = (typeof IMPERSONATION_PURPOSES)[number];

/**
 * **Why a session was ended by something other than its operator** (P19.4-T2; ADR-0206 §5). `view_as_only`: migration
 * `0055-view-as-only` ended it at the deploy, being a setup session or one elevated to write. `null` for a session its
 * operator ended, or one that ran out.
 */
export const IMPERSONATION_END_REASONS = ['view_as_only'] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASONS)[number];

/**
 * One support session: who ran it, as whom, in which office, and what they could do
 * (P4-T10). Since P19.4-T2 (ADR-0206) every session only looks.
 *
 * **Not a row in `authTokens`, and not two rows.** The session was a credential there, and
 * the things §3.13 asks for — read-only, an Owner-readable log — are properties of the
 * *session*, not of a token.
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
   * **Always `true` for a row written since P19.4-T2** (ADR-0206 §3): a session only looks. A row from before may read
   * `false` — elevated to write by a second Super Admin (P4-T10, retired) — and is no session any more: `liveSession`
   * answers `null` for it, and migration `0055-view-as-only` ended any still open at the deploy.
   */
  @Prop({ type: Boolean, required: true, default: true })
  readOnly!: boolean;

  /**
   * **Why the session was started**: `support`, written on every row since P19.4-T2. A row from before may read `setup`
   * (ADR-0162 §1, superseded), kept as history and treated as ended by `liveSession`.
   */
  @Prop({ type: String, enum: [...IMPERSONATION_PURPOSES], required: true, default: 'support' })
  purpose!: ImpersonationPurpose;

  /**
   * **What a setup session could write besides reading** (ADR-0162 §2, superseded): `[]` on every row written since
   * P19.4-T2. A setup row keeps the scope it was started with, as history; nothing reads it to grant anything.
   */
  @Prop({ type: [String], default: [] })
  writeScope!: string[];

  /** The second Super Admin who approved writing (P4-T10, retired by P19.4-T2). `null` on every new row. */
  @Prop({ type: String, default: null })
  elevatedByUserId!: string | null;

  @Prop({ type: Date, default: null })
  elevatedAt!: Date | null;

  /** Typed by the operator at the start. Shown in the Owner's log. */
  @Prop({ type: String, required: true })
  reason!: string;

  /** Typed at an elevation (retired by P19.4-T2). `null` on every new row. */
  @Prop({ type: String, default: null })
  elevationReason!: string | null;

  @Prop({ type: Date, required: true })
  startedAt!: Date;

  @Prop({ type: Date, required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  endedAt!: Date | null;

  /** Why it was ended, when its operator did not end it (P19.4-T2): `view_as_only` from the migration, else `null`. */
  @Prop({ type: String, enum: [...IMPERSONATION_END_REASONS], default: null })
  endReason!: ImpersonationEndReason | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const ImpersonationSessionSchema = SchemaFactory.createForClass(ImpersonationSession);

/** The Owner's log: this office's sessions, newest first. */
ImpersonationSessionSchema.index({ kpmId: 1, startedAt: -1 });

/** Ending every session an operator has open. */
ImpersonationSessionSchema.index({ effectiveUserId: 1, endedAt: 1 });
