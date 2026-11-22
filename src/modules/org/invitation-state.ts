/**
 * **Whether a person has been invited, and whether their account is already theirs** — one definition for every read
 * that says it (ADR-0212 §2; ADR-0248 §4; the glossary's *Invitation state*):
 *
 * - `signed_in` — *Aktif*: **the account is the person's own** (`ownsAccount`): it has signed in at least once
 *   (`users.lastLoginAt`), or its address was proven (`users.emailVerifiedAt`) — whatever was sent before;
 * - `invited` — ***Diundang***: an invitation went (`memberships.invitedAt`) and the account is not theirs yet;
 * - `not_invited` — ***Belum diundang***: nothing was sent, and the account is not theirs yet.
 *
 * Its readers: a KPM's owners and Admins on the Super Admin's KPM pages (`TenantService`, where `signed_in` is spelt
 * `active`), *KPM Owner · n* (`KpmOwnersService`), every row of the office's own Directory and one member's read
 * (`DirectoryService`, `invitation`), and the Super Admin's *All members* (`platform-reads.service.ts`). Computed on
 * read, from the stamps, so nothing is stored that could disagree with them.
 *
 * A membership's `status` is a different question — whether they are in the office — and stays `active` for an
 * imported member who has not signed in yet (ADR-0248 §4).
 */
export type InvitationState = 'signed_in' | 'invited' | 'not_invited';

/** The two stamps on an account that say whose it is. Either may be absent on a row projected without it. */
export interface AccountStamps {
  lastLoginAt?: Date | null;
  emailVerifiedAt?: Date | null;
}

/**
 * **The account is already the person's own** (the 2026-11-22 walk; OD-475): it has signed in, or its address was
 * proven — which only a registration's verification link, a password reset, an invitation's set-a-password link or an
 * email change confirmed from a session write, each by somebody holding the account's password. An account somebody
 * else made — an import, an owner named by the Super Admin — carries neither until its person opens their link, so it
 * reads *Belum diundang* or *Diundang* until then. Such an account is never offered *Kirim undangan*, and the server
 * refuses one (`TENANT_OWNER_NOT_INVITABLE`, `signed_in`).
 */
export function ownsAccount(account: AccountStamps | null | undefined): boolean {
  return Boolean(account?.lastLoginAt) || Boolean(account?.emailVerifiedAt);
}

export function invitationStateOf(
  account: AccountStamps | null | undefined,
  invitedAt: Date | null | undefined,
): InvitationState {
  if (ownsAccount(account)) return 'signed_in';
  return invitedAt ? 'invited' : 'not_invited';
}
