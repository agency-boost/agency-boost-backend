import { PRODUCTION } from './production';

describe('PRODUCTION (P19.21-T1; ADR-0274 §3)', () => {
  it('P19.21-T1 AC-1 pins the required history at January 2024, the same month for every KPM', () => {
    expect(PRODUCTION.HISTORY_FROM).toBe('2024-01');
  });

  it('P19.21-T1 AC-8 keeps a month open until the 7th of the next month', () => {
    expect(PRODUCTION.LOCK_GRACE_DAYS).toBe(7);
  });
});
