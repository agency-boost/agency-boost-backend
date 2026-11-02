import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail, IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min,
  MinLength, ValidateIf,
} from 'class-validator';
import {
  AGENT_CODE_PATTERN, GENDERS, LANGUAGES, PASSWORD, WORK_STATUSES, type Gender, type Language, type WorkStatus,
} from '@/domain/constants';
import { PHONE_FIELD_SHAPE, phoneFromBody } from '@/modules/users/phone-input';
import { preferredNameOf } from '@/modules/users/display-name';
import { field } from '@/common/validation/violations';
import { AUTH_REFUSALS } from './auth.messages';
import { IMPERSONATION_PURPOSES, type ImpersonationPurpose } from './impersonation-session.schema';

/**
 * The shapes of what a person records (ADR-0158), checked at the door. Whether a birth date is in the
 * past and 18 years ago, and a join month not in the future, needs today — that is the service's
 * (`personal-data.ts`), so both refusals are named in one sentence each.
 */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The DTOs' own sentences, in both languages (P18.98-T5 AC-3): `field` carries them to the pipe. */
const SAY = AUTH_REFUSALS.VALIDATION_FAILED;
const MONTH_SHAPE = /^\d{4}-\d{2}$/;

export class RegisterDto {
  @ApiProperty({ example: 'rina@kpm0417.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct horse battery', minLength: PASSWORD.MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD.MIN_LENGTH)
  password!: string;

  @ApiProperty({ example: 'Rina Wijaya' })
  @IsString()
  @MinLength(1)
  fullName!: string;

  @ApiProperty({
    description: 'From GET /companies. With `inviteToken`, the invite’s office’s insurer is used, whatever this says.',
    example: '65f1a0c2e4b0a1b2c3d4e5f6',
  })
  @ValidateIf((o: RegisterDto) => !o.inviteToken)
  @IsMongoId()
  companyId!: string;

  /**
   * The producer id the insurer issued them (ADR-0017).
   *
   * **Digits only, 3 to 32 of them, since ADR-0158 §4** — the client's rule, on every new
   * code. It was deliberately loose until then (`/^[A-Z0-9][A-Z0-9./-]*$/`, upper-cased),
   * and codes registered under it keep their letters; nothing re-checks one already held.
   * Trimmed on the way in, because it is read off a contract and typed by hand.
   */
  @ApiProperty({
    example: '88213', minLength: 3, maxLength: 32, pattern: AGENT_CODE_PATTERN.source,
    description: 'With `inviteToken`, the invite’s agent code is used, whatever this says.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o: RegisterDto) => !o.inviteToken)
  @IsString()
  @Matches(AGENT_CODE_PATTERN, { message: field(SAY.agentCodeShape) })
  agentCode!: string;

  /**
   * **Registering on a leader's invite** (ADR-0170 §3, P18.96-T3 AC-4): the token from `/register?invite=`. The
   * account takes the invite's insurer and agent code, and its membership in the office is made active under the
   * leader at once, with the invite's join date. A link that opens nothing is refused `404` before any account is made.
   */
  @ApiPropertyOptional({ description: 'The token from an invite link, `/register?invite=…`.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  inviteToken?: string;

  /*
   * What a person records (ADR-0158, P18.8-T4 AC-3), all four required at registration.
   */

  @ApiProperty({ example: '1990-03-15', description: '`YYYY-MM-DD`. In the past, and at least 18 years ago.' })
  @IsString()
  @Matches(DATE_SHAPE, { message: field(SAY.dateOfBirthShape) })
  dateOfBirth!: string;

  @ApiProperty({
    example: '2021-07',
    description: '`YYYY-MM`: the month they joined the insurer chosen in `companyId` (*Joined Prudential*). Not in the future.',
  })
  @IsString()
  @Matches(MONTH_SHAPE, { message: field(SAY.companyJoinMonthShape) })
  companyJoinMonth!: string;

  @ApiProperty({
    enum: WORK_STATUSES,
    description: 'Copied onto the membership they are given when an office takes them on (ADR-0158 §1).',
  })
  @IsIn(WORK_STATUSES, { message: field(SAY.workStatusShape) })
  workStatus!: WorkStatus;

  @ApiProperty({ enum: GENDERS })
  @IsIn(GENDERS, { message: field(SAY.genderShape) })
  gender!: Gender;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@kpm0417.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'demo password 0417' })
  @IsString()
  password!: string;
}

export class RefreshDto {
  @ApiPropertyOptional({
    description:
      'Only for non-browser clients. A browser sends the httpOnly cookie set at login ' +
      'and should omit this entirely.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class TokenDto {
  @ApiProperty({ description: 'Send as `Authorization: Bearer <token>`. Expires in 15 minutes.' })
  @IsString()
  token!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'owner@kpm0417.test' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'From the password-reset email.' })
  @IsString()
  token!: string;

  @ApiProperty({ minLength: PASSWORD.MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD.MIN_LENGTH)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: PASSWORD.MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD.MIN_LENGTH)
  newPassword!: string;
}

/**
 * **`POST /auth/me/email`** (UI V1, UI-111; ADR-0181): the address to move the account to, and the password again.
 * Trimmed at the door, so an address pasted with a space is not refused for it; the service lower-cases it as
 * registration does (`normalisedEmail`).
 */
export class ChangeEmailDto {
  @ApiProperty({ example: 'agus.baru@kpm0417.test' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;

  @ApiProperty({ description: 'The password the account signs in with now.' })
  @IsString()
  currentPassword!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Rina Wijaya' })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional({
    example: 'Rina',
    nullable: true,
    description: 'What colleagues call you. Empty, blank or `null` means none: it is stored as `null`, and your '
      + 'full name is shown wherever a name is.',
  })
  // A blank one is no name: `''` would print as nothing wherever the full name should have stood in.
  @Transform(({ value }) => (typeof value === 'string' ? preferredNameOf(value) : value))
  @IsOptional()
  @IsString()
  preferredName?: string | null;

  @ApiPropertyOptional({
    enum: ['she', 'he', 'they'],
    description: 'Yours to set. It appears in the coaching commitment sentence your leader reads.',
  })
  @IsOptional()
  @IsEnum(['she', 'he', 'they'])
  pronoun?: 'she' | 'he' | 'they';

  /*
   * **What a person records** (ADR-0158 §3, P18.8-T4 AC-6): yours to complete or correct, each on its
   * own. Not clearable — a `null` is refused, since each is required of everybody who arrives now.
   * **Refused in any support session**, read-only or elevated: these are the person's own word.
   */

  @ApiPropertyOptional({ example: '1990-03-15', description: '`YYYY-MM-DD`. In the past, and at least 18 years ago.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(DATE_SHAPE, { message: field(SAY.dateOfBirthShape) })
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: '2021-07', description: '`YYYY-MM`: the month you joined your insurer. Not in the future.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(MONTH_SHAPE, { message: field(SAY.companyJoinMonthShape) })
  companyJoinMonth?: string;

  @ApiPropertyOptional({
    enum: WORK_STATUSES,
    description: 'Written on your membership in your office; on your account until you have one.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(WORK_STATUSES, { message: field(SAY.workStatusShape) })
  workStatus?: WorkStatus;

  @ApiPropertyOptional({ enum: GENDERS })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(GENDERS, { message: field(SAY.genderShape) })
  gender?: Gender;

  /*
   * **The language you read AgencyBoost in** (ADR-0179 §2; P18.98-T2 AC-1): the *ID | EN* switch and *Language* on
   * *Your account* both send it, on its own. One of the two; **not clearable** — `null` is refused like any other value,
   * because a person who has chosen once has chosen, and the default only stands for somebody who never has.
   */
  @ApiPropertyOptional({
    enum: LANGUAGES,
    description: 'The language you read AgencyBoost in: `id`, Bahasa Indonesia, or `en`, English. Saved on your account, '
      + 'so it follows you to every device. Not clearable: anything else, `null` included, is `400 VALIDATION_FAILED`.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(LANGUAGES, { message: field(SAY.localeShape) })
  locale?: Language;

  /*
   * **Your WhatsApp number** (UI V1, 2026-10-30; UI-081, D-22): what *Isi nomor WhatsApp* and *Profil saya* save. Typed
   * as people type it and stored as `+62` and 9 to 13 digits (`normalisePhone`); empty, blank or `null` clears it.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0812-1100-2200',
    description: 'Your WhatsApp number. Spaces, dashes, dots and brackets go, and a leading `+62`, `62` or `0`; what is '
      + 'left must be 9 to 13 digits, stored as `+62…`, else `400 VALIDATION_FAILED` naming `phone`. Empty, blank or '
      + '`null` clears it.',
  })
  @Transform(({ value }) => phoneFromBody(value))
  @ValidateIf((_, value) => value !== undefined && value !== null)
  // No `@IsString()`: the shape refuses anything that is not text, and says one sentence rather than two.
  @Matches(PHONE_FIELD_SHAPE, { message: field(SAY.phoneShape) })
  phone?: string | null;
}

export class ImpersonateDto {
  @ApiProperty({ description: 'Recorded in the audit log. Required.', example: 'support ticket 42' })
  @IsString()
  @MinLength(3)
  reason!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 60, default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  durationMinutes?: number;

  @ApiPropertyOptional({
    enum: IMPERSONATION_PURPOSES,
    default: 'support',
    description:
      '`support` looks and changes nothing. `setup` may also change the office\'s settings, import people and '
      + 'upload its production file, and nothing else — for an active office\'s Owner or one of its Admins '
      + 'only, else `409 IMPERSONATION_SETUP_TARGET`.',
  })
  @IsOptional()
  @IsIn(IMPERSONATION_PURPOSES)
  purpose?: ImpersonationPurpose;
}


/**
 * Approving a support session to write (P4-T10, §3.13).
 *
 * The reason is typed **again** rather than carried over from the session's own: the
 * approver is a different person answering a different question — not "why look at this
 * office" but "why is looking not enough". The office's Owner reads both.
 */
export class ElevateImpersonationDto {
  @ApiProperty({
    example: 'Their activity types were saved with a duplicate code and cannot be fixed from the screen.',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
