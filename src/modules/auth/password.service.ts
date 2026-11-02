import { Injectable } from '@nestjs/common';
import type { Sentence } from '@/common/i18n/sentence';
import { PASSWORD } from '@/domain/constants';
import { AUTH_REFUSALS } from './auth.messages';
import * as argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id, with parameters chosen for an interactive login rather than defaults.
 *
 * Length and nothing else — `PASSWORD.MIN_LENGTH` to `PASSWORD.MAX_LENGTH` characters
 * (`domain/constants/password.ts`, metrics §B.30): composition rules ("one symbol, one
 * digit") reliably produce worse passwords than length does, and push people to reuse.
 */
@Injectable()
export class PasswordService {
  // `raw: false` is explicit so the string overload is selected: argon2.hash returns a
  // Buffer when raw is true, and an encoded string otherwise.
  private readonly options = {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB — OWASP's interactive-login floor
    timeCost: 2,
    parallelism: 1,
    raw: false as const,
  } satisfies argon2.HashOptions & { raw: false };

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed stored hash must read as "wrong password", never as an error that
      // distinguishes this account from any other.
      return false;
    }
  }

  /**
   * Validation returns every failure at once. Telling someone their password is too
   * short, then that it ends in a space, is two round trips for one decision.
   */
  validate(plain: string): Sentence<'VALIDATION_FAILED'>[] {
    const problems: Sentence<'VALIDATION_FAILED'>[] = [];
    if (plain.length < PASSWORD.MIN_LENGTH) {
      problems.push(AUTH_REFUSALS.VALIDATION_FAILED.passwordTooShort({ min: PASSWORD.MIN_LENGTH }));
    }
    if (plain.length > PASSWORD.MAX_LENGTH) {
      problems.push(AUTH_REFUSALS.VALIDATION_FAILED.passwordTooLong({ max: PASSWORD.MAX_LENGTH }));
    }
    if (/^\s|\s$/.test(plain)) {
      problems.push(AUTH_REFUSALS.VALIDATION_FAILED.passwordSpaces);
    }
    return problems;
  }

  /** A high-entropy token for refresh, verification and reset flows. */
  generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Tokens are stored hashed, so a database read cannot impersonate anyone. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Constant-time compare, for anywhere a hash is checked outside the database. */
  tokensMatch(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}
