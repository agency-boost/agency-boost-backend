import { invitationStateOf } from './invitation-state';

/**
 * **P19.12-T5 AC-4 (ADR-0248 §4; ADR-0212 §2): one rule for *Aktif*, *Diundang* and *Belum diundang*.** A first sign-in
 * decides it, whatever was sent; before one, an invitation sent says *Diundang* and none says *Belum diundang*.
 */
describe('P19.12-T5 invitationStateOf', () => {
  const SIGNED_IN = new Date('2026-11-10T02:00:00Z');
  const INVITED = new Date('2026-11-09T02:00:00Z');

  it('P19.12-T5 AC-4 an account that has signed in is signed_in, invited or not', () => {
    expect(invitationStateOf(SIGNED_IN, INVITED)).toBe('signed_in');
    expect(invitationStateOf(SIGNED_IN, null)).toBe('signed_in');
    expect(invitationStateOf(SIGNED_IN, undefined)).toBe('signed_in');
  });

  it('P19.12-T5 AC-4 an invitation sent and no sign-in yet is invited (Diundang)', () => {
    expect(invitationStateOf(null, INVITED)).toBe('invited');
    expect(invitationStateOf(undefined, INVITED)).toBe('invited');
  });

  it('P19.12-T5 AC-4 neither is not_invited (Belum diundang)', () => {
    expect(invitationStateOf(null, null)).toBe('not_invited');
    expect(invitationStateOf(undefined, undefined)).toBe('not_invited');
  });
});
