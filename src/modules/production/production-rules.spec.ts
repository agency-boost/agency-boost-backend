import { ADDITIVE_METRICS, breaksYtd, COUNT_METRICS, refusalFor } from './production-rules';

/**
 * P9-T5 AC-5 — the one definition of what a figure may be, pinned here once. The import
 * (`production-preview.spec.ts`) and correction (`production-correction.tenancy.spec.ts`) each prove
 * they ask it, rather than proving the rules again.
 */
describe('what a production figure may be (AC-5)', () => {
  it('holds persistency to 0–100, fractions allowed', () => {
    expect(refusalFor('persistency', 0)).toBeNull();
    expect(refusalFor('persistency', 92.5)).toBeNull();
    expect(refusalFor('persistency', 100)).toBeNull();
    expect(refusalFor('persistency', 100.01)).toBe('is above 100 — persistency is a percentage.');
  });

  it('refuses a negative figure, every metric', () => {
    for (const m of ['ape', 'persistency', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount'] as const) {
      expect(refusalFor(m, -1)).toBe('is negative.');
    }
  });

  it('holds money to whole sen an integer can carry', () => {
    expect(refusalFor('ape', 150_000_000)).toBeNull();
    expect(refusalFor('fyp', 0)).toBeNull();
    expect(refusalFor('ape', 1.5)).toBe('is a fraction of a sen.');
    expect(refusalFor('ape', 2 ** 53)).toBe('is larger than any figure this product can hold.');
  });

  it('holds the three counts to whole numbers', () => {
    expect(COUNT_METRICS).toEqual(['recruitment', 'newActiveAgents', 'policyCount']);
    expect(refusalFor('policyCount', 3)).toBeNull();
    expect(refusalFor('policyCount', 2.5)).toBe('is not a whole number — it counts policies.');
    expect(refusalFor('recruitment', 0.5)).toBe('is not a whole number — it counts people.');
  });

  it('refuses what is not a number at all', () => {
    expect(refusalFor('ape', Number.NaN)).toBe('is not a number.');
    expect(refusalFor('recruitment', Number.POSITIVE_INFINITY)).toBe('is not a number.');
  });

  it('keeps the year to date at least the month, for the additive five and not persistency', () => {
    expect(ADDITIVE_METRICS).toEqual(['ape', 'recruitment', 'newActiveAgents', 'fyp', 'policyCount']);
    expect(breaksYtd('ape', 5, 4)).toBe(true);
    expect(breaksYtd('ape', 5, 5)).toBe(false);
    expect(breaksYtd('ape', 5, null)).toBe(false);
    expect(breaksYtd('ape', null, 1)).toBe(false);
    expect(breaksYtd('persistency', 95, 80)).toBe(false);
  });
});
