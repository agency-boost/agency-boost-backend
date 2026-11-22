/**
 * **Who is counted: never a test account** (P19.17-T1 AC-1; ADR-0267 §1; `revisions/2026-11-19/DATA-DEFINITIONS.md`,
 * *Who is counted*).
 *
 * The clause every read of a KPM's members adds to its membership filter, so a test account is never listed, counted,
 * summed or ranked: `memberships.testAccount` is the copy of `users.testAccount` (`isTestAccount`) that the membership
 * carries for exactly this — one clause on the read a service already makes, no second read of `users`, and the
 * `(kpmId, …)` index it already walks still leads. A row written before the flag holds none, which `$ne: true` reads as a
 * real person.
 *
 * **Lists and counts only, never access.** Reaching one member by id (`CoachResolver.coachee`, a link) is unchanged: the
 * flag is about figures, not about who may open what.
 */
export const NOT_A_TEST_ACCOUNT = { testAccount: { $ne: true } } as const;

/** `filter` with test accounts left out. `filter`'s own `testAccount`, if it names one, is replaced. */
export function withoutTestAccounts<F extends Record<string, unknown>>(filter: F): F & typeof NOT_A_TEST_ACCOUNT {
  return { ...filter, ...NOT_A_TEST_ACCOUNT };
}
