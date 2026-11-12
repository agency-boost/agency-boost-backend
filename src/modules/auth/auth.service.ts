import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, type Gender, type WorkStatus } from '@/domain/constants';
import { birthDateProblem, joinMonthProblem } from '@/modules/users/personal-data';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Reader } from '@/common/i18n/reader';
import { joinSentences } from '@/common/i18n/sentence';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { INSURERS_ONLY } from '@/modules/tenants/template-library';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AuthToken, AuthTokenDocument } from './auth-token.schema';
import { PasswordService } from './password.service';
import { TokenSigner } from './token-signer';
import { AUTH_REFUSALS } from './auth.messages';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface Meta {
  ip?: string | null;
  userAgent?: string | null;
}

/** One place this account is signed in — a token family, not a token. */
export interface SessionView {
  sessionId: string;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: string | null;
  startedAt: string | null;
  expiresAt: string;
  /** The session the caller is reading this from. Revoking it signs them out here. */
  current: boolean;
}

/** What registration takes (`RegisterDto`), the insurer and the code already settled. */
export interface RegistrationInput {
  email: string;
  password: string;
  fullName: string;
  companyId: string;
  agentCode: string;
  dateOfBirth: string;
  companyJoinMonth: string;
  workStatus: WorkStatus;
  gender: Gender;
}

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
/**
 * How long a single-use emailed link lasts: verifying an address, an email change's link (ADR-0181) and a linked login's
 * (ADR-0199 §2, which reuses it rather than restating it).
 */
export const VERIFICATION_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 30;

/**
 * **An email address as the account stores it** — lower-cased and trimmed, as registration has always written it and
 * `users.email` holds it (`lowercase`, `trim`). One function, so the email change (UI-111, ADR-0181) compares and
 * stores the new address exactly as registration would have.
 */
export function normalisedEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

/** What `POST /auth/verify-email-change` answers: the address the account now signs in with. */
export interface EmailChanged {
  email: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly passwords: PasswordService,
    private readonly signer: TokenSigner,
    private readonly clock: Clock,
    private readonly notifications: NotificationService,
    /*
     * The email change's audit row (UI-111, ADR-0181). Optional and last, so a harness that builds this service for
     * something else needs no audit log; the application module always provides one.
     */
    @Optional() @Inject(AuditService) private readonly audit: AuditService | null = null,
  ) {}

  // ---------------------------------------------------------------- registration

  /**
   * `reader` is the request's (P18.10-T5 AC-5): the verification email is written in it for a person who has saved no
   * language — a new account never has.
   */
  async register(input: RegistrationInput, reader?: Reader): Promise<UserDocument> {
    return (await this.registerAccount(input, reader)).user;
  }

  /**
   * **`register`, saying whether it made the account** (P18.8-T3 AC-4). Registration on an invite's link joins the
   * office only for an account made here and now: an address that already exists makes nothing and must not join
   * anybody to anything. Since P19.12-T2 (ADR-0245 §3) the route also signs in only an account made here and now.
   */
  async registerAccount(input: RegistrationInput, reader?: Reader): Promise<{ user: UserDocument; created: boolean }> {
    const problems = this.passwords.validate(input.password);
    if (problems.length) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        joinSentences(problems),
        HttpStatus.BAD_REQUEST,
        { field: 'password', problems },
      );
    }

    // Before anything is looked up, so the answer is the same whether or not the address exists.
    this.refusePersonalData(input);

    const email = normalisedEmail(input.email);
    const existing = await this.users.findOne({ email }).exec();
    if (existing) {
      // Nothing is made, and nobody is told: the attempt is logged, and **no email is sent** to the account's owner (an
      // earlier comment and the docs said one was; none ever was — ADR-0245 §4). The route answers `verification_sent`
      // with no session, so an account made by this form is the only one it signs in (ADR-0245 §3).
      this.logger.warn({ email }, 'registration attempted for an existing address');
      return { user: existing, created: false };
    }

    // The insurer has to exist before we can hold somebody's code against it. **The Template library is not
    // one** (ADR-0164 §3): nobody works for it, so it is "not here" to somebody registering, as it is not listed.
    const company = await this.companies
      .findOne({ _id: input.companyId, deletedAt: null, ...INSURERS_ONLY })
      .exec()
      // A malformed id is "not here", not a 500 — this arrives from a public form.
      .catch(() => null);
    if (!company) throw new NotFoundException('Company');

    const agentCode = input.agentCode.trim().toUpperCase();

    /*
     * **This one says so, where the email above deliberately does not.**
     *
     * A taken address is answered without a session and nothing more (ADR-0245 §3, §4). A taken agent code has no such
     * escape: the person is holding a card with that number on it, they cannot proceed
     * until somebody sorts it out, and staying quiet would send them away waiting for a
     * verification email that is never coming. The leak — that this code is in use at
     * this insurer — is smaller than stranding the person who owns it.
     */
    const clash = await this.users
      .findOne({ companyId: input.companyId, agentCode, deletedAt: null })
      .exec();
    if (clash) {
      throw new DomainException(
        ErrorCode.AGENT_CODE_TAKEN,
        AUTH_REFUSALS.AGENT_CODE_TAKEN.registered({ agentCode, company: company.name }),
        HttpStatus.CONFLICT,
        { field: 'agentCode', agentCode },
      );
    }

    const user = await this.users.create({
      email,
      passwordHash: await this.passwords.hash(input.password),
      fullName: input.fullName.trim(),
      companyId: input.companyId,
      agentCode,
      // ADR-0158: theirs, on the account. How they work waits here for the office that takes them on.
      dateOfBirth: input.dateOfBirth,
      companyJoinMonth: input.companyJoinMonth,
      gender: input.gender,
      registeredWorkStatus: input.workStatus,
      status: 'invited',
      platformRole: 'none',
    });

    await this.issueVerification(user, reader);
    return { user, created: true };
  }

  /**
   * **A birth date in the past and at least 18 years ago, a join month not in the future** (ADR-0158 §2,
   * P18.5-T4 AC-4), each refused `400 VALIDATION_FAILED` with the field named — registration's, and
   * `PATCH /auth/me`'s for whichever of the two it carries.
   *
   * Measured against **today in `Asia/Jakarta`**, the one office timezone v1 has (ADR-0016): a person
   * registering belongs to no office yet, so there is no `kpms.timezone` to read, and the clock is the
   * injected one, never the server's (invariant §9).
   */
  refusePersonalData(input: { dateOfBirth?: string; companyJoinMonth?: string }): void {
    const today = localDayOf(this.clock.now(), DEFAULT_TENANT_TIMEZONE);
    const checks = [
      ['dateOfBirth', input.dateOfBirth === undefined ? null : birthDateProblem(input.dateOfBirth, today)],
      ['companyJoinMonth', input.companyJoinMonth === undefined ? null : joinMonthProblem(input.companyJoinMonth, today)],
    ] as const;
    for (const [field, problem] of checks) {
      if (problem) {
        throw new DomainException(ErrorCode.VALIDATION_FAILED, problem, HttpStatus.BAD_REQUEST, { field });
      }
    }
  }

  // ------------------------------------------------------------------------ login

  async login(email: string, password: string, meta: Meta = {}): Promise<TokenPair> {
    const user = await this.users
      .findOne({ email: email.toLowerCase().trim(), deletedAt: null })
      .select('+passwordHash')
      .exec();

    // One error for "no such account" and "wrong password", and the hash is verified
    // even when the user is absent, so the response time does not reveal which it was.
    const hash = user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await this.passwords.verify(hash, password);

    if (!user || !ok) {
      throw new DomainException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        AUTH_REFUSALS.AUTH_INVALID_CREDENTIALS.wrongCredentials,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (user.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
        AUTH_REFUSALS.AUTH_ACCOUNT_DEACTIVATED.contactOwner,
        HttpStatus.FORBIDDEN,
      );
    }
    /*
     * **An address not yet verified signs in** (P19-T1 AC-4; UI-163, ADR-0190 §4). It was refused here,
     * `403 AUTH_EMAIL_NOT_VERIFIED` — a dead end whenever the mail was slow, filtered or spent by a scanner. Every shell
     * now says *"Verifikasi email Anda · Kirim ulang"* until it is (`emailVerified` on `/auth/me`), and what must be sure
     * of the address checks it itself (`verified-address.ts`).
     */

    user.lastLoginAt = this.clock.now();
    await user.save();

    return this.issuePair(String(user._id), randomUUID(), meta);
  }

  // ---------------------------------------------------------------------- refresh

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that has already been rotated is the standard signal that a
   * refresh token was stolen: the legitimate client and the attacker both hold a
   * descendant of the same family. We cannot tell which is which, so the whole family
   * is revoked and both must sign in again.
   *
   * **Every refusal here is one answer, `401 AUTH_SESSION_ENDED`** (ADR-0168 §1): a token was presented, so this
   * browser had a session, and it has ended — whether the token is unknown or malformed, spent, revoked or
   * expired. Which of those it was stays here, in the log and the family's `revokedReason`; the answer says only
   * *ended*. A refresh with no token at all never reaches this (`AuthController.refreshTokenFrom`).
   */
  async refresh(rawToken: string, meta: Meta = {}): Promise<TokenPair> {
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'refresh' })
      .exec();

    if (!record) throw sessionEnded();

    if (record.usedAt || record.revokedAt) {
      await this.revokeFamily(record.familyId, 'refresh token reuse detected');
      this.logger.error(
        { userId: record.userId, familyId: record.familyId },
        'refresh token reuse — family revoked',
      );
      throw sessionEnded();
    }

    if (record.expiresAt.getTime() <= this.clock.now().getTime()) throw sessionEnded();

    record.usedAt = this.clock.now();
    await record.save();

    return this.issuePair(record.userId, record.familyId ?? randomUUID(), meta);
  }

  // ---------------------------------------------------------------------- logout

  async logout(rawToken: string): Promise<void> {
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'refresh' })
      .exec();
    if (record) await this.revokeFamily(record.familyId, 'signed out');
  }

  async logoutAll(userId: string, reason = 'signed out everywhere'): Promise<void> {
    await this.tokens
      .updateMany(
        { userId, kind: 'refresh', revokedAt: null },
        { $set: { revokedAt: this.clock.now(), revokedReason: reason } },
      )
      .exec();
  }

  // ------------------------------------------------------------------- sessions

  /**
   * Where this account is signed in (P4-T13).
   *
   * **One row per `familyId`, not per token.** A refresh rotates on every use, so a
   * session that has been alive a fortnight has a few hundred rows behind it. A person
   * reading this wants to know *where they are signed in* — one phone, one laptop — and a
   * list of three hundred entries answers a question nobody asked.
   *
   * `current` marks the family the caller is holding, so nobody revokes the seat they are
   * sitting in by accident and then wonders why they were signed out.
   */
  async sessions(userId: string, currentFamilyId: string | null): Promise<SessionView[]> {
    const rows = await this.tokens
      .find({ userId, kind: 'refresh', revokedAt: null })
      .sort({ createdAt: -1 })
      .exec();

    const byFamily = new Map<string, SessionView>();
    for (const row of rows) {
      const familyId = row.familyId ?? String(row._id);
      const created = row.get('createdAt') as Date | undefined;
      const existing = byFamily.get(familyId);
      if (existing) {
        // Rows come newest first, so the first one seen is the latest use and anything
        // after it is older — which makes the last one the moment the session began.
        existing.startedAt = created?.toISOString() ?? existing.startedAt;
        continue;
      }
      byFamily.set(familyId, {
        sessionId: familyId,
        userAgent: row.userAgent,
        ip: row.ip,
        lastUsedAt: created?.toISOString() ?? null,
        startedAt: created?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        current: familyId === currentFamilyId,
      });
    }
    return [...byFamily.values()];
  }

  /**
   * Revoke one session.
   *
   * By family, so every rotation of that session dies with it — revoking the newest token
   * alone would leave an attacker holding an older one that still rotates.
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const { modifiedCount } = await this.tokens
      .updateMany(
        // `userId` in the filter, not checked afterwards: a family id is guessable enough
        // that reading one and then comparing would be a window, however small.
        { userId, kind: 'refresh', familyId: sessionId, revokedAt: null },
        { $set: { revokedAt: this.clock.now(), revokedReason: 'signed out from another device' } },
      )
      .exec();
    if (modifiedCount === 0) throw new NotFoundException('Session');
  }

  /** Which session a refresh token belongs to, for marking the current one. */
  async familyOf(rawToken: string): Promise<string | null> {
    const row = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'refresh' })
      .exec();
    return row?.familyId ?? null;
  }

  // ------------------------------------------------------------ email verification

  /**
   * A second verification email (P4-T13).
   *
   * `agent/01-getting-started.md` has told readers to "sign in and request another" since
   * Phase 2, against a route that did not exist. It does now — and it matters more since
   * `P4-T14`, because the first one is finally being sent.
   *
   * **Resolves silently for an address that is already verified or absent.** Anything else
   * is an account-enumeration oracle, the same reason `forgot-password` answers `202`
   * either way.
   */
  async resendVerification(email: string, reader?: Reader): Promise<void> {
    const user = await this.users
      .findOne({ email: email.toLowerCase().trim(), deletedAt: null })
      .exec();
    if (!user || user.emailVerifiedAt) return;

    // `issueVerification` sends it. It was sent a second time here, so every resend delivered two (P18.10-T5).
    await this.issueVerification(user, reader);
  }

  /**
   * A fresh verification link, emailed. **In the language of the request that asked for it** where the person has
   * saved none (P18.10-T5 AC-5): `reader` is that request's, and their saved `users.locale` wins over it.
   */
  async issueVerification(user: UserDocument, reader?: Reader): Promise<string> {
    const raw = this.passwords.generateToken();
    await this.tokens.create({
      userId: String(user._id),
      kind: 'email_verification',
      tokenHash: this.passwords.hashToken(raw),
      expiresAt: new Date(this.clock.now().getTime() + VERIFICATION_TTL_HOURS * 3_600_000),
    });

    await this.notifications.send({
      userId: String(user._id),
      templateId: NotificationTemplate.EMAIL_VERIFICATION,
      payload: { token: raw, fullName: user.fullName },
      reader,
    });
    return raw;
  }

  /**
   * **Verify the address — the press of *Verifikasi email saya*, never the page's load** (P19-T1 AC-1, AC-2; UI-163,
   * ADR-0190 §1–§2).
   *
   * The page sent its token the moment it loaded, and the token is single-use, so a mail scanner that opened the link
   * first — or the person's second open — spent it, and the first real open read *"Tautan itu sudah tidak berlaku"*. The
   * page now sends it only when its button is pressed, and **an address already verified answers success** whatever
   * state its link is in: pressed again, opened from an older mail, or after a reset verified it. A link that names
   * nobody, or one expired before the address was verified, is still `400 AUTH_TOKEN_INVALID`.
   */
  async verifyEmail(rawToken: string): Promise<void> {
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'email_verification' })
      .exec();
    if (!record) throw linkInvalid();
    const user = await this.users.findOne({ _id: record.userId, deletedAt: null }).exec();
    if (!user) throw linkInvalid();
    if (user.emailVerifiedAt) return;
    if (!this.usable(record)) throw linkInvalid();

    // The address before the link. Pressed twice at once, a press that finds the link spent then finds the address
    // verified, which is its success; spending first left a window where it found neither.
    await this.markVerified(record.userId);
    try {
      await this.consumeSingleUse(rawToken, 'email_verification');
    } catch (err) {
      // The other press spent it a moment earlier, after verifying the same address.
      if (await this.addressVerified(record.userId)) return;
      throw err;
    }
  }

  /** Whether the account's address is verified now, read again. */
  private async addressVerified(userId: string): Promise<boolean> {
    const user = await this.users.findOne({ _id: userId, deletedAt: null }).select('emailVerifiedAt').lean().exec();
    return Boolean(user?.emailVerifiedAt);
  }

  /**
   * **The address proven** — by its verification link, or by a password reset (P19-T1 AC-3): `emailVerifiedAt` set where
   * it was not, and an account still `invited` made `active`. Never a `deactivated` one, which the unconditional write
   * this replaced would have brought back. *Public since 2026-11-05 (P19.2-T1 AC-8):* a linked login's confirm proves the
   * other login's mailbox the same way (ADR-0199 §2).
   */
  async markVerified(userId: string): Promise<void> {
    await this.users
      .updateOne({ _id: userId, deletedAt: null, emailVerifiedAt: null }, { $set: { emailVerifiedAt: this.clock.now() } })
      .exec();
    await this.users.updateOne({ _id: userId, deletedAt: null, status: 'invited' }, { $set: { status: 'active' } }).exec();
  }

  /**
   * **"Kata sandi Anda diubah"** (P19-T1 AC-5; UI-163, ADR-0190 §5): after a reset and after a change, to the address the
   * account has, in their language — else the request's. Sent whatever they chose for notification email (AC-6). **It
   * never fails the change**: the password is already new, and a refusal here would say otherwise; a failure is logged.
   */
  private async tellPasswordChanged(userId: string, reader?: Reader): Promise<void> {
    try {
      const user = await this.users.findOne({ _id: userId, deletedAt: null }).exec();
      if (!user) return;
      await this.notifications.send({
        userId,
        templateId: NotificationTemplate.PASSWORD_CHANGED,
        payload: { fullName: user.fullName },
        reader,
      });
    } catch (err) {
      this.logger.error({ err, userId }, 'could not send the password-changed mail');
    }
  }

  // ------------------------------------------------------------- password reset

  /**
   * Always resolves, whether or not the address exists. Anything else tells an
   * attacker which addresses have accounts.
   */
  async forgotPassword(email: string, reader?: Reader): Promise<void> {
    const user = await this.users
      .findOne({ email: email.toLowerCase().trim(), deletedAt: null })
      .exec();
    if (!user) return;

    const raw = this.passwords.generateToken();
    await this.tokens.create({
      userId: String(user._id),
      kind: 'password_reset',
      tokenHash: this.passwords.hashToken(raw),
      expiresAt: new Date(this.clock.now().getTime() + RESET_TTL_MINUTES * 60_000),
    });

    // In the language of the page that asked, for a person who has saved none (P18.10-T5 AC-5).
    await this.notifications.send({
      userId: String(user._id),
      templateId: NotificationTemplate.PASSWORD_RESET,
      payload: { token: raw, fullName: user.fullName },
      reader,
    });
  }

  /**
   * A new password from a reset link. **It marks the address verified** (P19-T1 AC-3; ADR-0190 §3): the link was opened
   * from that mailbox, which is all a verification link proves. Every session ends, a pending email change is
   * cancelled, and *"Kata sandi Anda diubah"* is sent (AC-5) — in the account's language, else the page's (`reader`).
   */
  async resetPassword(rawToken: string, newPassword: string, reader?: Reader): Promise<void> {
    const problems = this.passwords.validate(newPassword);
    if (problems.length) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        joinSentences(problems),
        HttpStatus.BAD_REQUEST,
        { field: 'password', problems },
      );
    }

    const record = await this.consumeSingleUse(rawToken, 'password_reset');
    await this.users
      .updateOne(
        { _id: record.userId },
        {
          $set: {
            passwordHash: await this.passwords.hash(newPassword),
            // A reset lifts the roster-import gate too (P3.2-T4). It proves control of
            // the mailbox and produces a password nobody else has seen, which is the
            // whole of what the gate is waiting for — and somebody who never received
            // their generated password would otherwise be locked out with no way back.
            mustChangePassword: false,
          },
        },
      )
      .exec();

    await this.markVerified(record.userId);

    // A reset is what you do when you believe the password was compromised, so every
    // existing session dies with it — and any email change asked for with it (ADR-0181 §4).
    await this.logoutAll(record.userId, 'password reset');
    await this.cancelEmailChange(record.userId, 'password reset');
    // And a link this login started and nobody confirmed yet (ADR-0199 §2): its notice says *change your password*.
    await this.cancelPendingLink(record.userId, 'password reset');
    await this.tellPasswordChanged(record.userId, reader);
  }

  /** From *Profil saya* or *Choose your own password*: the current one again, then every other session ends (AC-5's mail). */
  async changePassword(userId: string, current: string, next: string, reader?: Reader): Promise<void> {
    const user = await this.users.findOne({ _id: userId }).select('+passwordHash').exec();
    if (!user || !(await this.passwords.verify(user.passwordHash, current))) {
      throw new DomainException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        AUTH_REFUSALS.AUTH_INVALID_CREDENTIALS.wrongCurrentPassword,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const problems = this.passwords.validate(next);
    if (problems.length) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        joinSentences(problems),
        HttpStatus.BAD_REQUEST,
        { field: 'password', problems },
      );
    }

    if (next === current) {
      // A generated password replaced by itself is not a replacement, and the guard would
      // let them through on the credential the admin still has a copy of.
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        AUTH_REFUSALS.VALIDATION_FAILED.samePassword,
        HttpStatus.BAD_REQUEST,
        { field: 'password' },
      );
    }

    user.passwordHash = await this.passwords.hash(next);
    // The one thing that lifts the roster-import gate (P3.2-T4). Nothing else clears it.
    user.mustChangePassword = false;
    await user.save();
    await this.logoutAll(userId, 'password changed');
    // What the old address's notice tells somebody to do when the change was not theirs (ADR-0181 §4).
    await this.cancelEmailChange(userId, 'password changed');
    // The same for a link this login started (ADR-0199 §2): the notice to its address says *change your password now*.
    await this.cancelPendingLink(userId, 'password changed');
    await this.tellPasswordChanged(userId, reader);
  }

  // ---------------------------------------------------------------- email change

  /**
   * **Ask to move the account to another address** (UI V1, UI-111; ADR-0181): `POST /auth/me/email`.
   *
   * The password is checked again — a signed-in browser left open is not enough to take the account's login — and
   * refused as `change-password` refuses it. The address is normalised as registration does; the one the account has
   * is `400`, one another account has (a soft-deleted one too: `users.email` is unique over every row) is
   * `409 AUTH_EMAIL_TAKEN`. **Nothing on the account changes here.** The pending change is one `email_change` row in
   * `authTokens` — the new address, the token's hash, its expiry (`VERIFICATION_TTL_HOURS`, the verification link's
   * lifetime) — and a newer request revokes the one before it. The link goes to the new address; a notice with no
   * link goes to the one the account has now.
   */
  async requestEmailChange(userId: string, newEmailRaw: string, currentPassword: string, reader?: Reader): Promise<void> {
    const user = await this.users.findOne({ _id: userId, deletedAt: null }).select('+passwordHash').exec();
    if (!user || !(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new DomainException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        AUTH_REFUSALS.AUTH_INVALID_CREDENTIALS.wrongCurrentPassword,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const newEmail = normalisedEmail(newEmailRaw);
    if (newEmail === user.email) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        AUTH_REFUSALS.VALIDATION_FAILED.sameEmail,
        HttpStatus.BAD_REQUEST,
        { field: 'newEmail' },
      );
    }
    if (await this.addressTaken(newEmail, userId)) {
      throw new DomainException(
        ErrorCode.AUTH_EMAIL_TAKEN,
        AUTH_REFUSALS.AUTH_EMAIL_TAKEN.belongsToAnother,
        HttpStatus.CONFLICT,
        { field: 'newEmail' },
      );
    }

    // One pending change per person: the one before this stops working.
    await this.cancelEmailChange(userId, 'replaced by a newer email change');
    const raw = this.passwords.generateToken();
    await this.tokens.create({
      userId,
      kind: 'email_change',
      tokenHash: this.passwords.hashToken(raw),
      newEmail,
      expiresAt: new Date(this.clock.now().getTime() + VERIFICATION_TTL_HOURS * 3_600_000),
    });

    // The link, to the address being proved; the notice, to the address the account has now — no link in it.
    await this.notifications.send({
      userId,
      templateId: NotificationTemplate.EMAIL_CHANGE_VERIFICATION,
      payload: { token: raw, fullName: user.fullName },
      toAddress: newEmail,
      reader,
    });
    await this.notifications.send({
      userId,
      templateId: NotificationTemplate.EMAIL_CHANGE_REQUESTED,
      payload: { fullName: user.fullName, newEmail },
      reader,
    });

    // The request is recorded as well as the change (the Phase 18.11 exit review, L10): an account asked to move to an
    // address it never reached is a trail somebody may need — a stolen password trying to take the account away. As
    // `user.email_changed`: the platform's scope, written as the person, with the address as it is and as asked.
    await this.audit?.record(new RequestContext(userId, user.platformRole, null), {
      action: 'user.email_change_requested',
      targetCollection: 'users',
      targetId: userId,
      before: { email: user.email },
      after: { email: newEmail },
    });
  }

  /**
   * **Open the link: the account moves to the new address** (UI-111, ADR-0181): `POST /auth/verify-email-change`.
   *
   * The token is single-use and expires as a verification link does; unknown, spent, replaced or expired is
   * `400 AUTH_TOKEN_INVALID`, as `verify-email` answers. It is spent before the address is checked, so a link whose
   * address was taken since it was sent is `409 AUTH_EMAIL_TAKEN` once and invalid after. The swap marks the address
   * verified — the link proved the mailbox — and is audited `user.email_changed` with before and after. **Sessions
   * stay signed in**: the person proved both the password and the new mailbox.
   *
   * *Since 2026-11-04 (P19-T1 AC-4, ADR-0190 §4):* an account whose address was never verified may sign in, and so may
   * ask for a change — the way out of an address mistyped at registration, whose mail never arrives. The account still
   * moves only when the new address's own link is opened, which marks it verified: a change needs a proven address.
   */
  async confirmEmailChange(rawToken: string): Promise<EmailChanged> {
    const record = await this.consumeSingleUse(rawToken, 'email_change');
    const user = await this.users.findOne({ _id: record.userId, deletedAt: null }).exec();
    const newEmail = record.newEmail;
    if (!user || !newEmail) throw linkInvalid();

    const taken = () => new DomainException(
      ErrorCode.AUTH_EMAIL_TAKEN,
      AUTH_REFUSALS.AUTH_EMAIL_TAKEN.takenSinceRequest,
      HttpStatus.CONFLICT,
      { field: 'newEmail' },
    );
    if (await this.addressTaken(newEmail, record.userId)) throw taken();

    const before = user.email;
    try {
      await this.users
        .updateOne({ _id: record.userId }, { $set: { email: newEmail, emailVerifiedAt: this.clock.now() } })
        .exec();
    } catch (err) {
      // Taken in the moment between the check and the write: the unique index is the last word.
      if ((err as { code?: number } | null)?.code === 11000) throw taken();
      throw err;
    }

    // The account is global (invariant 2), so the row is the platform's scope, `kpmId: null`, written as the person:
    // they proved the password and the mailbox. Account changes carry the address, as `kpm.owner_assigned` does.
    await this.audit?.record(new RequestContext(record.userId, user.platformRole, null), {
      action: 'user.email_changed',
      targetCollection: 'users',
      targetId: record.userId,
      before: { email: before },
      after: { email: newEmail },
    });
    return { email: newEmail };
  }

  /** Whether an address is another account's — any row, a soft-deleted one too: `users.email` is unique over all. */
  private async addressTaken(email: string, userId: string): Promise<boolean> {
    return (await this.users.exists({ email, _id: { $ne: userId } }).exec()) !== null;
  }

  /** The person's pending email change, if any, stops working. */
  private async cancelEmailChange(userId: string, reason: string): Promise<void> {
    await this.tokens
      .updateMany(
        { userId, kind: 'email_change', usedAt: null, revokedAt: null },
        { $set: { revokedAt: this.clock.now(), revokedReason: reason } },
      )
      .exec();
  }

  /**
   * **A link this login started, not yet confirmed, stops working** (UI-169 item 5; ADR-0199 §2): a newer start replaces
   * it, and a password change or reset cancels it — what the notice to the starting address tells somebody to do.
   */
  async cancelPendingLink(userId: string, reason: string): Promise<void> {
    await this.tokens
      .updateMany(
        { userId, kind: 'account_link', usedAt: null, revokedAt: null },
        { $set: { revokedAt: this.clock.now(), revokedReason: reason } },
      )
      .exec();
  }

  // ------------------------------------------------------------ linked logins' sessions

  /**
   * **This login's own live session, from a refresh token the browser presented** (ADR-0199 §2, §4): the row, when the
   * token is a refresh token of `userId` that is neither spent, revoked nor expired — or `null`. **It changes nothing**:
   * a link's confirm reads whether the browser holds the starting login's session, and a switch whether the cookie it
   * parks is the active login's own, and neither may rotate a token the browser still holds.
   */
  async liveSessionOf(rawToken: string | null | undefined, userId: string): Promise<AuthTokenDocument | null> {
    if (!rawToken) return null;
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'refresh' })
      .exec();
    if (!record || record.userId !== userId || record.usedAt || record.revokedAt) return null;
    return record.expiresAt.getTime() > this.clock.now().getTime() ? record : null;
  }

  /**
   * **Rotate the other login's parked session, if it is one** (ADR-0199 §4): `refresh`, for a token that belongs to
   * `userId`, answering `null` where `refresh` would refuse. A token of another login is left alone and answers `null`;
   * a spent one still revokes its family, as every reuse does.
   */
  async refreshOwnedBy(rawToken: string | null | undefined, userId: string, meta: Meta = {}): Promise<TokenPair | null> {
    if (!rawToken) return null;
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'refresh' })
      .exec();
    if (!record || record.userId !== userId) return null;
    try {
      return await this.refresh(rawToken, meta);
    } catch (err) {
      if (err instanceof DomainException && err.code === ErrorCode.AUTH_SESSION_ENDED) return null;
      throw err;
    }
  }

  /**
   * **A new session for a login whose password was just given** (ADR-0199 §2, §4): a linked login's confirm, and a
   * switch that had to ask. A sign-in in every respect but the form — `lastLoginAt`, a new token family.
   */
  async signInProven(userId: string, meta: Meta = {}): Promise<TokenPair> {
    await this.users.updateOne({ _id: userId }, { $set: { lastLoginAt: this.clock.now() } }).exec();
    return this.issuePair(userId, randomUUID(), meta);
  }

  // ------------------------------------------------------------------- internals

  private async issuePair(userId: string, familyId: string, meta: Meta): Promise<TokenPair> {
    const raw = this.passwords.generateToken();
    await this.tokens.create({
      userId,
      kind: 'refresh',
      tokenHash: this.passwords.hashToken(raw),
      familyId,
      expiresAt: new Date(this.clock.now().getTime() + REFRESH_TTL_DAYS * 86_400_000),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });

    // The access token carries the subject and session only. Roles are resolved per
    // request, so revoking an admin grant takes effect immediately rather than at the
    // next refresh.
    const accessToken = this.signer.sign({ sub: userId, sid: familyId }, ACCESS_TTL_SECONDS);

    return { accessToken, refreshToken: raw, expiresIn: ACCESS_TTL_SECONDS };
  }

  private async revokeFamily(familyId: string | null, reason: string): Promise<void> {
    if (!familyId) return;
    await this.tokens
      .updateMany(
        { familyId, revokedAt: null },
        { $set: { revokedAt: this.clock.now(), revokedReason: reason } },
      )
      .exec();
  }

  private async consumeSingleUse(
    rawToken: string,
    kind: 'email_verification' | 'password_reset' | 'email_change',
  ): Promise<AuthTokenDocument> {
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind })
      .exec();

    // The email change's link is refused as the verification link is (ADR-0181): the same code and sentence.
    const invalid = kind === 'password_reset'
      ? new DomainException(
        ErrorCode.AUTH_RESET_TOKEN_INVALID,
        AUTH_REFUSALS.AUTH_RESET_TOKEN_INVALID.linkInvalid,
        HttpStatus.BAD_REQUEST,
      )
      : linkInvalid();

    if (!record || !this.usable(record)) throw invalid;

    record.usedAt = this.clock.now();
    await record.save();
    return record;
  }

  /** A single-use link not yet spent, revoked or expired. */
  private usable(record: AuthTokenDocument): boolean {
    return !record.usedAt && !record.revokedAt && record.expiresAt.getTime() > this.clock.now().getTime();
  }
}

/** A verification link — the address's, or an email change's — that does not work: `verify-email`'s answer. */
function linkInvalid(): DomainException {
  return new DomainException(
    ErrorCode.AUTH_TOKEN_INVALID,
    AUTH_REFUSALS.AUTH_TOKEN_INVALID.linkInvalid,
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * A presented refresh token that no longer works, whatever the reason (ADR-0168 §1): one code and one sentence, so
 * the answer discloses that the session ended and not whether it expired, was revoked or was reused.
 */
function sessionEnded(): DomainException {
  return new DomainException(
    ErrorCode.AUTH_SESSION_ENDED,
    AUTH_REFUSALS.AUTH_SESSION_ENDED.ended,
    HttpStatus.UNAUTHORIZED,
  );
}
