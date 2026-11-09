import { rateOver, wholePercent } from './rate';

/**
 * **A share of a group, rounded half up exactly** (P18.2 exit review, training review 2). The prototype's
 * `Math.round(count / of * 100)` rounds a binary approximation: 23/40 is 57.5%, and the float reads 57.4999… → 57.
 */
describe('rateOver', () => {
  it.each([
    [23, 40, 58], [29, 200, 15], [57, 200, 29], [113, 200, 57],
    [1, 3, 33], [2, 3, 67], [1, 8, 13], [0, 5, 0], [5, 5, 100], [1, 200, 1], [199, 200, 100],
  ])('P18.2 exit review %i / %i is %i%%, half up', (count, of, pct) => {
    expect(rateOver(count, of)).toEqual({ count, of, pct });
  });

  it('is null over nobody, never 0% and never a division by zero', () => {
    expect(rateOver(0, 0)).toEqual({ count: 0, of: 0, pct: null });
  });
});

/**
 * **P18.9-T3 — every whole percentage of whole numbers, one rounding** (parity F-253; the client's UI-018, *"correctly
 * rounded"*). The attainments of two sums share `rateOver`'s integer rule, so an exact half is never read down.
 */
describe('wholePercent', () => {
  it('P18.9-T3 F-253 rounds an exact half up where the float does not: 23 of 40 is 58, which Math.round makes 57', () => {
    expect(Math.round((23 / 40) * 100)).toBe(57);
    expect(wholePercent(23, 40)).toBe(58);
    // The same half as sen: Rp 23 jt of Rp 40 jt.
    expect(wholePercent(23_000_000_00, 40_000_000_00)).toBe(58);
  });

  it.each([
    [27, 28, 96], [4, 28, 14], [9, 28, 32], [1, 11, 9], [2, 9, 22], [1, 8, 13], [1, 3, 33], [0, 7, 0], [7, 7, 100],
  ])('P18.9-T3 F-253 %i of %i is %i%% — UI-018’s figures, whole and half up', (part, of, pct) => {
    expect(wholePercent(part, of)).toBe(pct);
  });

  it('P18.9-T3 F-253 passes 100 for an attainment past its target, uncapped: the caller keeps its own cap', () => {
    expect(wholePercent(3_600, 1_700)).toBe(212);
    expect(wholePercent(10_005, 1_000)).toBe(1_001);
  });

  it('P18.9-T3 F-253 rounds a negative half toward +∞, as Math.round does: −57.5 is −57', () => {
    expect(wholePercent(-23, 40)).toBe(-57);
    expect(wholePercent(-24, 40)).toBe(-60);
  });

  it('P18.9-T3 F-253 keeps the rule exact past 2⁵³: hundreds of miliar in sen, in BigInt', () => {
    // Rp 2,3 triliun of Rp 4 triliun in sen: 200 × part is past Number.MAX_SAFE_INTEGER.
    const part = 230_000_000_000_000;
    const of = 400_000_000_000_000;
    expect(Number.isSafeInteger(200 * part)).toBe(false);
    expect(wholePercent(part, of)).toBe(58);
    expect(wholePercent(part + 1_000_000_000_000, of)).toBe(58);
    expect(wholePercent(-part, of)).toBe(-57);
    // −57,75%: a negative quotient with a remainder floors one lower than BigInt's truncation.
    expect(wholePercent(-(part + 1_000_000_000_000), of)).toBe(-58);
    expect(wholePercent(of, of)).toBe(100);
  });
});
