/**
 * **Test accounts are never shown or counted** (`revisions/2026-11-19/DATA-DEFINITIONS.md`, *Who is counted*; ADR-0267
 * §1; `metrics-and-definitions.md`, *Who is counted*; glossary *Akun tes*).
 *
 * An account is a test account when **`users.testAccount` is `true`** — a stored flag on the global identity, never
 * worked out from an email or a name at read time. Every staging demo address ends in `.test`, the real demo logins
 * included, and a one-word name like *Hilmy* may be a real person in production, so neither the email nor the name can
 * be the rule (OD-370).
 *
 * The **name prefixes** below are what migration `0065` flags once, on the accounts written before the flag existed:
 * the two kinds of row the client named as test rows. Anything else is flagged by hand (the Super Admin, a later
 * phase). Nothing reads a name to decide whether a person counts.
 */
export const TEST_ACCOUNT = {
  /**
   * A full name that **starts with one of these words**, after trimming and collapsing spaces, any case: *FMT Budi*,
   * *fmt  budi*, *TES IMPOR 3*. A whole-word match — *FMTX* or *Tesimpor* is not one.
   */
  NAME_PREFIXES: ['FMT', 'TES IMPOR'] as readonly string[],
} as const;

/** `true` when a full name is one migration `0065` flags (`TEST_ACCOUNT.NAME_PREFIXES`). Never read at request time. */
export function isTestAccountName(fullName: string | null | undefined): boolean {
  if (typeof fullName !== 'string') return false;
  const name = fullName.trim().replace(/\s+/g, ' ').toUpperCase();
  return TEST_ACCOUNT.NAME_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix} `));
}

/**
 * **The one predicate**: an account, or a membership carrying its copy (`memberships.testAccount`), is a test account
 * when its flag is `true`. A row written before the flag reads as a real person until `0065` decides it.
 */
export function isTestAccount(row: { testAccount?: boolean | null } | null | undefined): boolean {
  return row?.testAccount === true;
}
