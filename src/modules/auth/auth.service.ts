import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Clock } from '@/common/clock/clock.port';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AuthToken, AuthTokenDocument } from './auth-token.schema';
import { PasswordService } from './password.service';
import { TokenSigner } from './token-signer';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface Meta {
  ip?: string | null;
  userAgent?: string | null;
}

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
const VERIFICATION_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 30;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    private readonly passwords: PasswordService,
    private readonly signer: TokenSigner,
    private readonly clock: Clock,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------- registration

  async register(input: { email: string; password: string; fullName: string }): Promise<UserDocument> {
    const problems = this.passwords.validate(input.password);
    if (problems.length) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        problems.join(' '),
        HttpStatus.BAD_REQUEST,
        { field: 'password', problems },
      );
    }

    const email = input.email.toLowerCase().trim();
    const existing = await this.users.findOne({ email }).exec();
    if (existing) {
      // Do not confirm that the address is taken: that is an enumeration oracle. The
      // caller gets the same shape as a success, and the real account owner gets an
      // email telling them someone tried.
      this.logger.warn({ email }, 'registration attempted for an existing address');
      return existing;
    }

    const user = await this.users.create({
      email,
      passwordHash: await this.passwords.hash(input.password),
      fullName: input.fullName.trim(),
      status: 'invited',
      platformRole: 'none',
    });

    await this.issueVerification(user);
    return user;
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
        'That email or password is not correct.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (user.status === 'deactivated') {
      throw new DomainException(
        ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
        'This account has been deactivated. Contact your KPM Owner.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!user.emailVerifiedAt) {
      throw new DomainException(
        ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
        'Verify your email address before signing in. Check your inbox.',
        HttpStatus.FORBIDDEN,
      );
    }

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
   */
  async refresh(rawToken: string, meta: Meta = {}): Promise<TokenPair> {
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind: 'refresh' })
      .exec();

    if (!record) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Your session is no longer valid. Sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (record.usedAt || record.revokedAt) {
      await this.revokeFamily(record.familyId, 'refresh token reuse detected');
      this.logger.error(
        { userId: record.userId, familyId: record.familyId },
        'refresh token reuse — family revoked',
      );
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Your session is no longer valid. Sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (record.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new DomainException(
        ErrorCode.AUTH_TOKEN_EXPIRED,
        'Your session has expired. Sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

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

  // ------------------------------------------------------------ email verification

  async issueVerification(user: UserDocument): Promise<string> {
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
    });
    return raw;
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const record = await this.consumeSingleUse(rawToken, 'email_verification');
    await this.users
      .updateOne(
        { _id: record.userId },
        { $set: { emailVerifiedAt: this.clock.now(), status: 'active' } },
      )
      .exec();
  }

  // ------------------------------------------------------------- password reset

  /**
   * Always resolves, whether or not the address exists. Anything else tells an
   * attacker which addresses have accounts.
   */
  async forgotPassword(email: string): Promise<void> {
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

    await this.notifications.send({
      userId: String(user._id),
      templateId: NotificationTemplate.PASSWORD_RESET,
      payload: { token: raw, fullName: user.fullName },
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const problems = this.passwords.validate(newPassword);
    if (problems.length) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        problems.join(' '),
        HttpStatus.BAD_REQUEST,
        { field: 'password', problems },
      );
    }

    const record = await this.consumeSingleUse(rawToken, 'password_reset');
    await this.users
      .updateOne(
        { _id: record.userId },
        { $set: { passwordHash: await this.passwords.hash(newPassword) } },
      )
      .exec();

    // A reset is what you do when you believe the password was compromised, so every
    // existing session dies with it.
    await this.logoutAll(record.userId, 'password reset');
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.users.findOne({ _id: userId }).select('+passwordHash').exec();
    if (!user || !(await this.passwords.verify(user.passwordHash, current))) {
      throw new DomainException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Your current password is not correct.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const problems = this.passwords.validate(next);
    if (problems.length) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        problems.join(' '),
        HttpStatus.BAD_REQUEST,
        { field: 'password', problems },
      );
    }

    user.passwordHash = await this.passwords.hash(next);
    await user.save();
    await this.logoutAll(userId, 'password changed');
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
    kind: 'email_verification' | 'password_reset',
  ): Promise<AuthTokenDocument> {
    const record = await this.tokens
      .findOne({ tokenHash: this.passwords.hashToken(rawToken), kind })
      .exec();

    const invalid = new DomainException(
      kind === 'password_reset' ? ErrorCode.AUTH_RESET_TOKEN_INVALID : ErrorCode.AUTH_TOKEN_INVALID,
      'That link is no longer valid. Request a new one.',
      HttpStatus.BAD_REQUEST,
    );

    if (!record || record.usedAt || record.revokedAt) throw invalid;
    if (record.expiresAt.getTime() <= this.clock.now().getTime()) throw invalid;

    record.usedAt = this.clock.now();
    await record.save();
    return record;
  }
}
