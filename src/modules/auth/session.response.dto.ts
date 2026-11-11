import type { SessionView } from './auth.service';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LANGUAGES, type Language } from '@/domain/constants';
import { SessionBrandingDto } from '@/modules/branding/branding.response.dto';

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

/**
 * **What `POST /auth/register` answers** (P19.12-T2 AC-3; ADR-0245 §3): `signed_in` with the access token for an account
 * made here and now — the refresh cookie set beside it, as `/auth/login` sets it — or `verification_sent`, with no token
 * and no cookie, for an address that already had an account.
 */
export class RegisterAnswerDto {
  @ApiProperty({
    type: String, enum: ['signed_in', 'verification_sent'],
    description: '`signed_in`: the account was made and is signed in. `verification_sent`: the address already had an '
      + 'account; nothing was made, nobody is signed in, and nobody joined anything.',
  })
  status!: 'signed_in' | 'verification_sent';

  @ApiPropertyOptional({ type: String, description: 'With `signed_in` only.' })
  accessToken?: string;

  @ApiPropertyOptional({ type: Number, description: 'With `signed_in` only: seconds until the access token expires.' })
  expiresIn?: number;
}

/** What a support impersonation hands back: a token that acts as somebody else, and its deadline. */
export class ImpersonationSessionDto {
  @ApiProperty({ type: String })
  accessToken!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Time-boxed. The session cannot outlive this.' })
  expiresAt!: Date;

  @ApiProperty({ type: String, description: 'The session\'s id, named on its `impersonation.started` audit entry.' })
  sessionId!: string;

  @ApiProperty({
    type: Boolean, enum: [true],
    description: 'Always `true`: a session only looks (ADR-0206 §3). Every write in it is `403 IMPERSONATION_READ_ONLY`.',
  })
  readOnly!: true;
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
    enum: ['verification_sent', 'verified', 'accepted', 'reset', 'changed', 'ended', 'linked'],
  })
  status!: string;
}

/** `POST /auth/verify-email-change` (UI V1, UI-111; ADR-0181): the change applied, and the address it moved to. */
export class EmailChangedDto {
  @ApiProperty({ type: String, enum: ['changed'] })
  status!: string;

  @ApiProperty({ type: String, example: 'agus.baru@kpm0417.test' })
  email!: string;
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

  /* UI V1 (2026-10-30; UI-081, D-22): the WhatsApp number the person saved, or one an invite or their leader gave them. */
  @ApiProperty({
    type: String, nullable: true, example: '+6281211002200',
    description: 'Your WhatsApp number, or `null`. Saved as `+62…` since UI V1; one recorded before then reads as it was '
      + 'typed. Set with `PATCH /auth/me`.',
  })
  phone!: string | null;

  /* UI V1 (2026-10-30; UI-111): the photo *Profil saya* saved, as a link every avatar of theirs draws. */
  @ApiProperty({
    type: String, nullable: true,
    description: 'Your profile photo, as a signed link valid 12 hours (`AVATAR.URL_TTL_SECONDS`; the bucket is private), '
      + 'or `null` for none — the avatar then draws `initials`. Set with `PUT /auth/me/avatar`, cleared with `DELETE`.',
  })
  avatarUrl!: string | null;

  @ApiProperty({ type: String, description: 'Derived server-side, so every avatar agrees.' })
  initials!: string;

  @ApiProperty({ type: String, enum: ['super_admin', 'none'] })
  platformRole!: string;

  /* P19-T1 AC-4 (UI-163, ADR-0190 §4): an account signs in before its address is verified. */
  @ApiProperty({
    type: Boolean,
    description: 'Whether this account\'s address is verified. An account signs in before it is (ADR-0190); while '
      + 'this is `false` every shell offers *Kirim ulang*, which posts `/auth/resend-verification`.',
  })
  emailVerified!: boolean;

  /*
   * What a person records (ADR-0158, P18.5-T4): `null` for anybody who has not, which the screens read as
   * *Not recorded*. Theirs to set on `PATCH /auth/me`.
   */
  @ApiProperty({ type: String, nullable: true, example: '1990-03-15', description: '`YYYY-MM-DD`.' })
  dateOfBirth!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['male', 'female'] })
  gender!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2021-07', description: '`YYYY-MM`: the month they joined their insurer.' })
  companyJoinMonth!: string | null;

  @ApiProperty({
    type: String, nullable: true, enum: ['full_time', 'part_time'],
    description: 'Their membership\'s, in the office this session is in; until they have one, what they registered with.',
  })
  workStatus!: string | null;

  /*
   * The language they read AgencyBoost in (ADR-0179 §2, P18.10-T2): set with `PATCH /auth/me`. Never `null` here —
   * `users.locale` is, for somebody who has chosen nothing, and that reads Bahasa Indonesia.
   */
  @ApiProperty({
    type: String, enum: LANGUAGES, example: 'id',
    description: 'The language in force: the one this account chose, or `id`, Bahasa Indonesia, for one that has '
      + 'chosen none (`localeChosen` false). `id` or `en`; set with `PATCH /auth/me`.',
  })
  locale!: Language;

  @ApiProperty({
    type: Boolean,
    description: 'Whether this account has chosen a language. A browser follows `locale` only when it has: an account '
      + 'with none keeps the language the browser already reads in (the `ab_lang` cookie) and saves nothing.',
  })
  localeChosen!: boolean;
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

  @ApiProperty({
    type: Boolean,
    description:
      'A Core Leader now (ADR-0159 §4): tagged *Core Leader* **and** on a leader rung, read on every request. The '
      + 'field shell\'s *Core leader* menu and the profile line read it; the forum and KPM analytics refuse regardless.',
  })
  isCoreLeader!: boolean;

  @ApiProperty({
    type: String, isArray: true, example: ['Top Producers 2026'],
    description: 'The live groups this member is tagged with, A to Z — the profile line\'s (ADR-0159 §5). Empty for none.',
  })
  groups!: string[];

  @ApiProperty({
    type: () => MeOfficeDto, nullable: true,
    description: 'The office, as the profile line names it: *0417 · Cempaka Putih* (ADR-0159 §5).',
  })
  office!: MeOfficeDto | null;
}

/** The office on the profile line (ADR-0159 §5): its code and its branch. */
export class MeOfficeDto {
  @ApiProperty({ type: String, example: '0417' })
  code!: string;

  @ApiProperty({ type: String, example: 'Cempaka Putih' })
  branch!: string;
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
/** One view of a linked login (ADR-0198 §1, ADR-0199 §3), in the switcher's order. */
export class LinkedViewDto {
  @ApiProperty({
    type: String, enum: ['self', 'kpm_owner', 'kpm_admin', 'super_admin'],
    description: '*Akun saya*, the office entry as Owner or Admin, or *Superadmin*.',
  })
  kind!: string;

  @ApiProperty({
    type: String, nullable: true,
    description: 'The office as it typed its name — its branch, else its code — on the office entry; `null` otherwise.',
  })
  officeName!: string | null;
}

/** The caller's other login (ADR-0199 §3): its address, its name and its views. Nothing else of it is read. */
export class LinkedLoginDto {
  @ApiProperty({ type: String, description: 'The link, for `DELETE /auth/links/:linkId`.' })
  linkId!: string;

  @ApiProperty({ type: String, description: 'The other login, for `POST /auth/links/switch`.' })
  userId!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: () => LinkedViewDto, isArray: true })
  views!: LinkedViewDto[];
}

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
      'A support session, which only looks (§3.13; ADR-0206 §4): `true` in every session, `false` outside one. '
      + 'Every write a session sends is `403 IMPERSONATION_READ_ONLY`.',
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
    description: 'You coach a new hire who joined in the last twelve months: the *New hires* menu item.',
  })
  newHires!: boolean;

  @ApiProperty({
    type: () => LinkedLoginDto, nullable: true,
    description: 'Your other login, linked with *Tambah akun*, and its views for the account menu — `null` with no link, '
      + 'and always `null` in a support session.',
  })
  linkedLogin!: LinkedLoginDto | null;

  @ApiProperty({
    type: () => SessionBrandingDto, nullable: true,
    description: 'What the session’s KPM shows (ADR-0218 §8): its palette, logo size, images, mascot poses and a '
      + 'lesson’s colours — `null` with no KPM.',
  })
  branding!: SessionBrandingDto | null;
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
