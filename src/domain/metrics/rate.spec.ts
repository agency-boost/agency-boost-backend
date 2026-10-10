import { rateOver } from './rate';

/**
 * **A share of a group, rounded half up exactly** (P18.5 exit review, training review 2). The prototype's
 * `Math.round(count / of * 100)` rounds a binary approximation: 23/40 is 57.5%, and the float reads 57.4999… → 57.
 */
describe('rateOver', () => {
  it.each([
    [23, 40, 58], [29, 200, 15], [57, 200, 29], [113, 200, 57],
    [1, 3, 33], [2, 3, 67], [1, 8, 13], [0, 5, 0], [5, 5, 100], [1, 200, 1], [199, 200, 100],
  ])('P18.5 exit review %i / %i is %i%%, half up', (count, of, pct) => {
    expect(rateOver(count, of)).toEqual({ count, of, pct });
  });

  it('is null over nobody, never 0% and never a division by zero', () => {
    expect(rateOver(0, 0)).toEqual({ count: 0, of: 0, pct: null });
  });
});
