import { english, englishAll, indonesianAll } from '../../../test/i18n';
import { PASSWORD } from '@/domain/constants';
import { PasswordService } from './password.service';

/**
 * A credential-handling module at 20% branch coverage (P4-T12).
 *
 * Every branch here is a decision about whether somebody gets in. The one that mattered
 * most was untested: `verify` swallowing a malformed stored hash and answering *"wrong
 * password"* rather than throwing — which is what stops a corrupted row from telling an
 * attacker that this account is different from every other one.
 */
describe('PasswordService', () => {
  const passwords = new PasswordService();

  describe('hashing and verifying', () => {
    it('round-trips a password', async () => {
      const hash = await passwords.hash('a long enough password');
      await expect(passwords.verify(hash, 'a long enough password')).resolves.toBe(true);
    });

    it('refuses the wrong password', async () => {
      const hash = await passwords.hash('a long enough password');
      await expect(passwords.verify(hash, 'a different password')).resolves.toBe(false);
    });

    it('produces a different hash every time, so two people with one password differ', async () => {
      // Argon2 salts per call. Equal hashes would mean a leaked table could be grouped by
      // password, which is most of the value of stealing one.
      const [a, b] = await Promise.all([
        passwords.hash('the same password'),
        passwords.hash('the same password'),
      ]);
      expect(a).not.toBe(b);
      await expect(passwords.verify(a, 'the same password')).resolves.toBe(true);
      await expect(passwords.verify(b, 'the same password')).resolves.toBe(true);
    });

    it('reads a malformed stored hash as a wrong password, never as an error', async () => {
      /*
       * The branch this suite was written for. A corrupted or truncated row must be
       * indistinguishable from a bad password: an error that escaped here would tell
       * somebody probing that *this* account is different, which is the one thing a login
       * must never say.
       */
      await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
      await expect(passwords.verify('', 'anything')).resolves.toBe(false);
      await expect(passwords.verify('$argon2id$v=19$truncated', 'anything')).resolves.toBe(false);
    });

    it('uses argon2id at OWASP’s interactive floor', () => {
      // Pinned because lowering these is invisible in every test that only checks a
      // round trip, and a cheaper hash is a slower attack made fast.
      const options = (passwords as unknown as {
        options: { memoryCost: number; timeCost: number; parallelism: number; type: number };
      }).options;
      expect(options.memoryCost).toBe(19456);
      expect(options.timeCost).toBe(2);
      expect(options.parallelism).toBe(1);
    });
  });

  describe('validation', () => {
    it('accepts a password that is only long', () => {
      // No composition rule: they reliably produce worse passwords than length does.
      expect(passwords.validate('correct horse battery staple')).toEqual([]);
    });

    it('names every problem at once, rather than one round trip each', () => {
      const problems = passwords.validate(' short ');
      expect(problems).toHaveLength(2);
      expect(english(problems[0])).toMatch(/at least 8 characters/);
      expect(english(problems[1])).toMatch(/begin or end with a space/);
    });

    it('P18.98-T5 AC-3 names each problem in Indonesian too', () => {
      expect(indonesianAll(passwords.validate(' short '))).toEqual([
        'Kata sandi minimal 8 karakter.',
        'Kata sandi tidak boleh diawali atau diakhiri spasi.',
      ]);
      expect(indonesianAll(passwords.validate('x'.repeat(201)))).toEqual(['Kata sandi paling banyak 200 karakter.']);
    });

    it('refuses one under the floor, and accepts one exactly on it', () => {
      // The floor is `PASSWORD.MIN_LENGTH`, 8 since the product owner's 2026-11-01 (metrics §B.30).
      expect(PASSWORD.MIN_LENGTH).toBe(8);
      expect(passwords.validate('1234567')).toHaveLength(1);
      expect(passwords.validate('12345678')).toEqual([]);
    });

    it('refuses one over the ceiling, and accepts one exactly on it', () => {
      // The ceiling is about the hash function's cost, not about the password: an
      // unbounded input is a way to make every login expensive.
      expect(PASSWORD.MAX_LENGTH).toBe(200);
      expect(passwords.validate('x'.repeat(200))).toEqual([]);
      expect(englishAll(passwords.validate('x'.repeat(201))))
        .toEqual(['Password must be 200 characters or fewer.']);
    });

    it('refuses a leading or trailing space, either end', () => {
      // Both are invisible in a password box and survive a copy-paste, so somebody who
      // sets one cannot sign in and cannot see why.
      expect(passwords.validate(' leading space here')).toHaveLength(1);
      expect(passwords.validate('trailing space here ')).toHaveLength(1);
      expect(passwords.validate('inner spaces are fine')).toEqual([]);
    });
  });

  describe('tokens', () => {
    it('is long enough and different every time', () => {
      const seen = new Set(Array.from({ length: 100 }, () => passwords.generateToken()));
      expect(seen.size).toBe(100);
      expect(passwords.generateToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    });

    it('hashes a token deterministically, because the row is looked up by it', () => {
      expect(passwords.hashToken('abc')).toBe(passwords.hashToken('abc'));
      expect(passwords.hashToken('abc')).not.toBe(passwords.hashToken('abd'));
      expect(passwords.hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('compares equal tokens as equal', () => {
      expect(passwords.tokensMatch('a'.repeat(32), 'a'.repeat(32))).toBe(true);
    });

    it('compares different tokens of the same length as different', () => {
      expect(passwords.tokensMatch('a'.repeat(32), 'b'.repeat(32))).toBe(false);
    });

    it('answers false for different lengths rather than throwing', () => {
      /*
       * `timingSafeEqual` throws on a length mismatch, and a throw here would be a
       * 500 where a `false` belongs — and the length is not a secret anyway: it is
       * observable from the token a caller supplied.
       */
      expect(passwords.tokensMatch('short', 'a'.repeat(32))).toBe(false);
      expect(passwords.tokensMatch('', 'x')).toBe(false);
    });

    it('handles a multi-byte token without a length surprise', () => {
      // `Buffer.from` counts bytes, not characters. Two strings of equal character length
      // can differ in bytes, and comparing them would have thrown.
      expect(passwords.tokensMatch('é', 'ee')).toBe(false);
    });
  });
});
