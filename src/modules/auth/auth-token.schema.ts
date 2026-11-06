import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type AuthTokenDocument = HydratedDocument<AuthToken>;

export type AuthTokenKind =
  | 'refresh'
  | 'email_verification'
  | 'password_reset'
  | 'impersonation'
  | 'email_change'
  | 'account_link';

/**
 * Credentials live apart from identity, so rotating one never touches the other.
 *
 * Refresh tokens rotate on every use and carry a `familyId`. Presenting a token that
 * has already been rotated is the standard signal of theft: the whole family is
 * revoked rather than just that token.
 */
@Schema({ ...baseSchemaOptions, collection: 'authTokens' })
export class AuthToken {
  @Prop({ type: String, required: true, index: true })
  userId!: string;

  /**
   * `impersonation` is the odd one: the access token it names is a stateless JWT, so this
   * row is not the credential — it is the **switch that can turn the credential off**.
   * Without it `end()` had nothing to revoke and a support session stayed valid for its
   * whole TTL after the operator pressed stop.
   */
  @Prop({
    type: String,
    required: true,
    enum: ['refresh', 'email_verification', 'password_reset', 'impersonation', 'email_change', 'account_link'],
  })
  kind!: AuthTokenKind;

  /**
   * **The login an `account_link` token would link to** (UI-169 item 5; ADR-0199 §2), and `null` on every other kind.
   * The pending link is this row: `userId` the login that started it (A), `linkUserId` the other (B), the token's hash and
   * its expiry (`VERIFICATION_TTL_HOURS`). One live row per starting login — a newer start revokes the one before it, and
   * so does a password change or reset of A. Nothing is linked until B's link is pressed and B's password given.
   */
  @Prop({ type: String, default: null })
  linkUserId!: string | null;

  /**
   * **The address an `email_change` token moves the account to** (UI V1, UI-111; ADR-0181), and `null` on every
   * other kind. The pending change is this row: the new address, the token's hash and its expiry, one live row per
   * person — a newer request revokes the one before it. `users.email` is not touched until the link is opened.
   */
  @Prop({ type: String, default: null })
  newEmail!: string | null;

  /** SHA-256 of the token. The raw value exists only in the response that issued it. */
  @Prop({ type: String, required: true, unique: true, index: true })
  tokenHash!: string;

  /** Shared by every token descended from one login. Null for single-use tokens. */
  @Prop({ type: String, default: null, index: true })
  familyId!: string | null;

  @Prop({ type: Date, required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  usedAt!: Date | null;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({ type: String, default: null })
  revokedReason!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  @Prop({ type: String, default: null })
  ip!: string | null;
}

export const AuthTokenSchema = SchemaFactory.createForClass(AuthToken);
AuthTokenSchema.index({ userId: 1, kind: 1, revokedAt: 1 });
AuthTokenSchema.index({ familyId: 1, revokedAt: 1 });
