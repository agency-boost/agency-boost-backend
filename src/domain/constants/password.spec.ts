import { PASSWORD, TEMPORARY_PASSWORD } from './index';

/**
 * A password's bounds (the product owner, 2026-11-01), pinned so a change fails here before it reaches a form.
 * Documented once in `docs/00-product/metrics-and-definitions.md` §B.30; the frontend's `PASSWORD_MIN_LENGTH` is read
 * against this file by `frontend/src/lib/password.spec.ts`.
 */
describe('the password bounds', () => {
  it('pins a password at 8 to 200 characters', () => {
    expect(PASSWORD).toEqual({ MIN_LENGTH: 8, MAX_LENGTH: 200 });
  });
});

/** ADR-0288 §1 (P19.30-T1 AC-1): the temporary password the *Akun & password* PDF prints, pinned with §B.30. */
describe('the temporary password', () => {
  it('P19.30-T1 AC-1 is ten characters, within a password’s bounds', () => {
    expect(TEMPORARY_PASSWORD.LENGTH).toBe(10);
    expect(TEMPORARY_PASSWORD.LENGTH).toBeGreaterThanOrEqual(PASSWORD.MIN_LENGTH);
    expect(TEMPORARY_PASSWORD.LENGTH).toBeLessThanOrEqual(PASSWORD.MAX_LENGTH);
  });

  it('P19.30-T1 AC-1 draws from 57 characters with no look-alike: neither 0 O nor 1 l I', () => {
    const alphabet = TEMPORARY_PASSWORD.ALPHABET;
    expect(alphabet).toBe('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789');
    expect(alphabet).toHaveLength(57);
    expect(new Set(alphabet).size).toBe(alphabet.length);
    for (const lookAlike of ['0', 'O', '1', 'l', 'I']) expect(alphabet).not.toContain(lookAlike);
    // Letters and digits only: nothing a phone keyboard hides behind a second page, and no space at either end.
    expect(alphabet).toMatch(/^[A-Za-z2-9]+$/);
  });

  it('P19.30-T1 AC-2 sets nothing in its PDF smaller than 9 pt', () => {
    expect(TEMPORARY_PASSWORD.PDF_MIN_TEXT_PT).toBe(9);
  });
});
