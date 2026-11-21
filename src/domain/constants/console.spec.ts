import { CONSOLE, KPM_ACTION_ISSUES, KPM_ISSUES } from './console';

describe('CONSOLE — the Super Admin console’s numbers (ADR-0277; metrics §B.43)', () => {
  it('P19.23-T1 AC-4 the colour scale is green from 80%, yellow from 50%, red below', () => {
    expect(CONSOLE.SCALE).toEqual({ GREEN_FROM_PCT: 80, YELLOW_FROM_PCT: 50 });
  });

  it('P19.23-T2 AC-4 a KPM’s page lists its first five members', () => {
    expect(CONSOLE.LANDING_MEMBERS).toBe(5);
  });

  it('P19.23-T2 AC-1 names a KPM’s issues in the order its card shows the first, and four of them need action', () => {
    expect(KPM_ISSUES).toEqual([
      'suspended', 'archived', 'subscription_ended', 'owner_not_invited', 'no_members', 'data_missing',
    ]);
    expect(KPM_ACTION_ISSUES).toEqual(['subscription_ended', 'owner_not_invited', 'no_members', 'data_missing']);
  });
});
