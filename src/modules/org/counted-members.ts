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

/**
 * ***Anggota* — the counted member** (P19.26-T1 AC-1; ADR-0284 §1; UI-204 (21 Nov); `metrics-and-definitions.md`,
 * *Anggota (counted member)*). **One definition for every count of members on the console**: the Dashboard's *Anggota*
 * tile and *Pemakaian AgencyBoost*, the KPM list's tile and each card's *n anggota*, a KPM page's tile, *Anggota*'s
 * footer and its *Aktif n*, and *Perusahaan*'s *n anggota*.
 *
 * A membership is counted when it is:
 * - **Aktif** — `status: 'active'`. That alone leaves out *Menunggu* (`pending`: an invitation not yet taken up, or a
 *   person nobody has placed) and *Keluar* (`removed`, a leaver included — *Mark left* removes the membership);
 * - **not a test account** (ADR-0267 §1, `NOT_A_TEST_ACCOUNT`);
 * - **not erased** (`deletedAt: null`, invariant §6);
 * - **in a KPM that is counted** (`isCountedOffice`): live and not archived. A suspended KPM's members are counted — they
 *   are still its members, and its card names them — and so are those of a KPM whose subscription ended.
 *
 * Decided on the membership alone, so a count is one clause on the read a service already makes and the `(kpmId, status)`
 * index still leads. *Diundang* — the account has not signed in yet — is a different question (`invitation-state.ts`):
 * an imported member whose membership is active is counted (ADR-0248 §4).
 *
 * *Menunggu* and *Keluar* are separate named counts (`MENUNGGU`, `KELUAR`), shown only where they are labelled.
 */
export const COUNTED_MEMBER = { status: 'active', deletedAt: null, ...NOT_A_TEST_ACCOUNT } as const;

/** *Menunggu*: a pending membership, test accounts never. Counted apart, and shown only under its own label. */
export const MENUNGGU = { status: 'pending', deletedAt: null, ...NOT_A_TEST_ACCOUNT } as const;

/** *Keluar*: a removed membership — a leaver included — test accounts never. Counted apart, under its own label. */
export const KELUAR = { status: 'removed', deletedAt: null, ...NOT_A_TEST_ACCOUNT } as const;

/**
 * `filter` narrowed to counted members (`COUNTED_MEMBER`). `filter`'s own `status`, `deletedAt` or `testAccount` is
 * replaced: a count of members is always this one.
 */
export function countedMembers<F extends Record<string, unknown>>(filter: F = {} as F): Omit<F, keyof typeof COUNTED_MEMBER> & typeof COUNTED_MEMBER {
  return { ...filter, ...COUNTED_MEMBER };
}

/** What `isCountedMember` reads of a membership: any row a service already holds. */
export interface CountableMembership {
  status: string;
  testAccount?: boolean | null;
  deletedAt?: Date | string | null;
}

/** **The same rule as a predicate**, for a row already read: `true` when `COUNTED_MEMBER` would match it. */
export function isCountedMember(m: CountableMembership): boolean {
  return m.status === 'active' && m.testAccount !== true && (m.deletedAt === null || m.deletedAt === undefined);
}

/** What `isCountedOffice` reads of a KPM. */
export interface CountableOffice {
  status: string;
  deletedAt?: Date | string | null;
}

/**
 * **A KPM whose members are counted**: live, and not archived (ADR-0284 §1). An archived KPM is out of every count of KPMs
 * (*KPM*'s tile counts the others), so its members are out of every count of members too.
 */
export function isCountedOffice(kpm: CountableOffice): boolean {
  return kpm.status !== 'archived' && (kpm.deletedAt === null || kpm.deletedAt === undefined);
}
