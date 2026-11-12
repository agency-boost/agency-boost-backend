/**
 * **Whether a person has been invited, and whether they have signed in** — one definition for every read that says it
 * (ADR-0212 §2; ADR-0248 §4; the glossary's *Invitation state*):
 *
 * - `signed_in` — *Aktif*: the account has signed in at least once (`users.lastLoginAt`), whatever was sent before;
 * - `invited` — ***Diundang***: an invitation went (`memberships.invitedAt`) and the account has never signed in;
 * - `not_invited` — ***Belum diundang***: nothing was sent, and nobody has signed in.
 *
 * Its readers: a KPM's Owner and Admins on the Super Admin's KPM pages (`TenantService`, where `signed_in` is spelt
 * `active`), every row of the office's own Directory and one member's read (`DirectoryService`, `invitation`), and the
 * Super Admin's *All members* (`platform-reads.service.ts`). Computed on read,
 * from the two stamps, so nothing is stored that could disagree with them.
 *
 * A membership's `status` is a different question — whether they are in the office — and stays `active` for an
 * imported member who has not signed in yet (ADR-0248 §4).
 */
export type InvitationState = 'signed_in' | 'invited' | 'not_invited';

export function invitationStateOf(
  lastLoginAt: Date | null | undefined,
  invitedAt: Date | null | undefined,
): InvitationState {
  if (lastLoginAt) return 'signed_in';
  return invitedAt ? 'invited' : 'not_invited';
}
