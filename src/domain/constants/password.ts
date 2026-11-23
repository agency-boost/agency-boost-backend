/**
 * **A password's bounds** (the product owner, 2026-11-01): what every form that makes one — `/register`, the reset
 * link, *Ubah kata sandi*, the first-sign-in screen — and `PasswordService.validate` apply.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` §B.30 and pinned by `password.spec.ts`. Read by
 * `PasswordService`, the DTOs' `@MinLength` and `@ApiProperty({ minLength })`, and the refusals' sentences; the
 * frontend mirrors the minimum for its inline error, in `src/lib/password.ts`, which a spec reads against this file.
 *
 * **Length and nothing else**: no composition rule (*"one symbol, one digit"*), which reliably produces worse passwords
 * and pushes people to reuse one. The ceiling is about the hash's cost, not the password: an unbounded input is a way
 * to make every sign-in expensive.
 */
export const PASSWORD = {
  /** The shortest password accepted, in characters. Was 10 until 2026-11-01. */
  MIN_LENGTH: 8,
  /** The longest, in characters. */
  MAX_LENGTH: 200,
} as const;

/**
 * **A temporary password** (ADR-0288 §1; P19.30-T1 AC-1; metrics §B.30): what the *Akun & password* PDF prints for each
 * account in a KPM not yet its person's own. Made fresh on every download by `PasswordService.generateTemporary`, from a
 * CSPRNG (`crypto.randomInt`), one character at a time from `ALPHABET`; only its hash is kept, with
 * `users.mustChangePassword: true`, so the person chooses their own at first sign-in.
 *
 * **No look-alikes** — neither `0 O` nor `1 l I` — because it is read off paper or a phone's screen and typed by hand.
 * 57 characters, so ten of them carry about 58 bits: far beyond guessing within the sign-in limiter, and it is gone once
 * the person chooses their own. Its length is within `PASSWORD`'s bounds, so the forms that check one accept it.
 */
export const TEMPORARY_PASSWORD = {
  /** Characters in each temporary password. */
  LENGTH: 10,
  /** Upper case without `I` and `O`, lower case without `l`, the digits 2 to 9. */
  ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789',
  /** The smallest text the PDF sets, in points (ADR-0288 §2; P19.30-T1 AC-2) — the KPM report's floor, 12 CSS px. */
  PDF_MIN_TEXT_PT: 9,
} as const;
