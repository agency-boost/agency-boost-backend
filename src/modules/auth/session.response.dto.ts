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

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
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

  @ApiProperty({ type: String, nullable: true, description: 'The real Super Admin, when this is a support session.' })
  impersonatedBy!: string | null;

  @ApiProperty({ type: String, isArray: true, description: 'Resolved from the database on every request.' })
  permissions!: string[];
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
