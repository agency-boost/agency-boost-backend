import { invitationStateOf, ownsAccount } from './invitation-state';

/**
 * **P19.12-T5 AC-4 (ADR-0248 §4; ADR-0212 §2): one rule for *Aktif*, *Diundang* and *Belum diundang*.** An account that
 * is already the person's own decides it, whatever was sent; before that, an invitation sent says *Diundang* and none
 * says *Belum diundang*. *Since 2026-11-22 (OD-475):* "their own" is a sign-in **or a proven address**.
 */
describe('P19.12-T5 invitationStateOf', () => {
  const SIGNED_IN = new Date('2026-11-10T02:00:00Z');
  const VERIFIED = new Date('2026-11-08T02:00:00Z');
  const INVITED = new Date('2026-11-09T02:00:00Z');

  it('P19.12-T5 AC-4 an account that has signed in is signed_in, invited or not', () => {
    expect(invitationStateOf({ lastLoginAt: SIGNED_IN }, INVITED)).toBe('signed_in');
    expect(invitationStateOf({ lastLoginAt: SIGNED_IN }, null)).toBe('signed_in');
    expect(invitationStateOf({ lastLoginAt: SIGNED_IN, emailVerifiedAt: null }, undefined)).toBe('signed_in');
  });

  it('OD-475 an account whose address was proven is its person’s own: signed_in, never Belum diundang', () => {
    // Fajar Nugroho of the 2026-11-22 walk: registered and verified, never signed in since, placed as a new KPM's owner.
    expect(invitationStateOf({ lastLoginAt: null, emailVerifiedAt: VERIFIED }, null)).toBe('signed_in');
    expect(invitationStateOf({ emailVerifiedAt: VERIFIED }, INVITED)).toBe('signed_in');
    expect(ownsAccount({ emailVerifiedAt: VERIFIED })).toBe(true);
  });

  it('P19.12-T5 AC-4 an invitation sent and the account not theirs yet is invited (Diundang)', () => {
    expect(invitationStateOf({ lastLoginAt: null, emailVerifiedAt: null }, INVITED)).toBe('invited');
    expect(invitationStateOf(undefined, INVITED)).toBe('invited');
  });

  it('P19.12-T5 AC-4 neither is not_invited (Belum diundang) — an account somebody else made, or none', () => {
    expect(invitationStateOf({ lastLoginAt: null, emailVerifiedAt: null }, null)).toBe('not_invited');
    expect(invitationStateOf(null, null)).toBe('not_invited');
    expect(invitationStateOf(undefined, undefined)).toBe('not_invited');
    expect(ownsAccount(null)).toBe(false);
    expect(ownsAccount({})).toBe(false);
  });
});
