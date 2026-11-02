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
