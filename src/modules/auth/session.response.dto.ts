import type { SessionView } from './auth.service';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The shapes `AuthController` builds itself rather than handing back from a service, and
 * the small acknowledgements several routes answer with.
 *
 * These have no interface to `implements`, because the handler composes them inline. They
 * are the one group where the document and the code could drift without the compiler
 * noticing — so each says, in its own doc comment, which handler owns it.
 */

/**
 * `POST /auth/login` and `POST /auth/refresh`.
 *
 * **Not `TokenPair`**, which is the service's internal type and carries `refreshToken`.
 * That never crosses the wire — it is set as an httpOnly cookie — and a generated schema
 * saying otherwise would tell an integrator to read a secret out of a body that does not
 * contain one. The handler returns exactly these two fields; this documents exactly those.
 */
export class AccessTokenDto {
  @ApiProperty({ type: String })
  accessToken!: string;

  @ApiProperty({ type: Number, description: 'Seconds until the access token expires.' })
  expiresIn!: number;
}

/** What a support impersonation hands back: a token that acts as somebody else, and its deadline. */
export class ImpersonationSessionDto {
  @ApiProperty({ type: String })
  accessToken!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Time-boxed. The session cannot outlive this.' })
  expiresAt!: Date;
}

/**
 * The one-word acknowledgements: `verification_sent`, `verified`, `accepted`, `reset`,
 * `changed`, `ended`. A body rather than a bare 204 because the client shows a different
 * sentence for each, and `accepted` in particular does **not** mean an email was sent —
 * `POST /auth/forgot-password` answers the same way whether or not the address exists.
 */
export class StatusAckDto {
  @ApiProperty({
    type: String,
    enum: ['verification_sent', 'verified', 'accepted', 'reset', 'changed', 'ended'],
  })
  status!: string;
}

/** The identity half of `GET /auth/me`. */
export class MeUserDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  preferredName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pronoun!: string | null;

  @ApiProperty({ type: String, description: 'Derived server-side, so every avatar agrees.' })
  initials!: string;

  @ApiProperty({ type: String, enum: ['super_admin', 'none'] })
  platformRole!: string;
}

/** The participation half. Null for somebody who has signed in but joined no office yet. */
export class MeMembershipDto {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  kpmId!: string;

  @ApiProperty({
    type: String,
    example: 'AB',
    description:
      'The rung of the company\'s ladder this person stands on. What a role badge '
      + 'is drawn from, and what a hierarchy permission is compared against.',
  })
  orgLevelCode!: string;

  @ApiProperty({
    type: String,
    enum: ['ab', 'aab', 'agent'],
    description:
      'The v1 enum. Read by the services that sort and group; no longer an authorisation '
      + 'input.',
  })
  hierarchyRole!: string;

  @ApiProperty({ type: Boolean })
  isKpmOwner!: boolean;

  @ApiProperty({ type: Boolean })
  isKpmAdmin!: boolean;

  @ApiProperty({ type: String, enum: ['active', 'pending', 'removed'] })
  status!: string;

  @ApiProperty({ type: Number, description: 'What makes somebody a leader (OD-23) — the rung does not.' })
  directCount!: number;
}

/** The reader's own activation, as the *New agent* section needs it. */
export class MeActivationDto {
  @ApiProperty({ type: Boolean, description: 'False once it is complete, or its six months are over.' })
  open!: boolean;

  @ApiProperty({ type: Boolean, description: 'Every item done: the amber check beside the menu item.' })
  complete!: boolean;
}

/**
 * `GET /auth/me` and `PATCH /auth/me`.
 *
 * **Permissions are resolved per request, not carried in the token.** A revoked grant
 * therefore disappears on the next call rather than at the next refresh, which is why the
 * client reads this rather than decoding the JWT.
 */
export class MeDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({ type: () => MeMembershipDto, nullable: true })
  membership!: MeMembershipDto | null;

  @ApiProperty({ type: Boolean })
  isImpersonating!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'A support session that may look and not touch (§3.13). False outside a session, '
      + 'and false inside one a second Super Admin has approved to write.',
  })
  impersonationReadOnly!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'The real Super Admin, when this is a support session.' })
  impersonatedBy!: string | null;

  @ApiProperty({
    type: Boolean,
    description: 'They are on a password somebody else generated. Every route but this one, '
      + 'change-password and logout answers 403 until it is replaced.',
  })
  mustChangePassword!: boolean;

  @ApiProperty({ type: String, isArray: true, description: 'Resolved from the database on every request.' })
  permissions!: string[];

  @ApiProperty({
    type: () => MeActivationDto, nullable: true,
    description: 'Your 90-day activation, for the *New agent* section: `null` when you have none.',
  })
  activation!: MeActivationDto | null;

  @ApiProperty({
    type: Boolean,
    description: 'You coach somebody whose activation is open: the *New hires* menu item.',
  })
  newHires!: boolean;
}

/** `GET /api/health/ready`. Read by a load balancer, not by a person. */
export class ReadinessDto {
  @ApiProperty({ type: String, enum: ['ok', 'degraded'] })
  status!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  checks!: Record<string, string>;
}

/** `POST /join/redeem` — which office the code let them into, and who now leads them. */
export class RedeemedInviteDto {
  @ApiProperty({ type: String })
  kpmId!: string;

  @ApiProperty({ type: String })
  leaderName!: string;
}

/** `GET /join/kpm-request` — the reader's own open ask, or nothing. */
export class MyKpmRequestDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  request!: unknown;
}


/**
 * One place this account is signed in (P4-T13).
 *
 * A **session**, not a token: a refresh rotates on every use, so a fortnight-old session
 * has a few hundred rows behind it and a person wants to know about their phone and their
 * laptop.
 */
export class SessionDto implements SessionView {
  @ApiProperty({ type: String, description: 'The token family. Revoking it ends the session.' })
  sessionId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Mozilla/5.0 (Linux; Android 13)' })
  userAgent!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When it last refreshed.' })
  lastUsedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When signing in created it.' })
  startedAt!: string | null;

  @ApiProperty({ type: String })
  expiresAt!: string;

  @ApiProperty({
    type: Boolean,
    description: 'The session this request came from. Revoking it signs the caller out here.',
  })
  current!: boolean;
}
