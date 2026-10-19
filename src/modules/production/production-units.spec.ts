import { MINOR_UNITS_PER_RP_MILLION, MONTH_PATTERN, minorToRpMillions, rpMillionsToMinor } from './production-units';

/**
 * P9-T1 AC-3: money is integer minor units, and a figure typed as *Rp M* is not what is stored.
 */
describe('the carrier’s unit meets the product’s', () => {
  it('pins a million rupiah at a hundred million sen', () => {
    expect(MINOR_UNITS_PER_RP_MILLION).toBe(100_000_000);
  });

  it('turns 1.5 in the file into 150,000,000 sen — never stores 1.5', () => {
    expect(rpMillionsToMinor(1.5)).toBe(150_000_000);
    expect(rpMillionsToMinor(500)).toBe(50_000_000_000);
    expect(Number.isInteger(rpMillionsToMinor(0.123456))).toBe(true);
  });

  it('rounds, because a decimal in a spreadsheet is what somebody typed and not a binary fraction', () => {
    // 0.1 + 0.2 territory: without the round this is 30000000.000000004.
    expect(rpMillionsToMinor(0.1 + 0.2)).toBe(30_000_000);
  });

  it('comes back to the file’s unit exactly', () => {
    expect(minorToRpMillions(rpMillionsToMinor(18))).toBe(18);
  });

  it('accepts a month and refuses everything that is not one', () => {
    for (const ok of ['2026-01', '2026-09', '2026-12']) expect(MONTH_PATTERN.test(ok)).toBe(true);
    for (const bad of ['2026', '2026-13', '2026-00', '2026-9', '09-2026', 'now', '2026-09-01']) {
      expect(MONTH_PATTERN.test(bad)).toBe(false);
    }
  });
});
