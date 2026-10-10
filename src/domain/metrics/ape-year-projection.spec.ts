import { apeYearProjection } from './ape-year-projection';

const M = 1_000_000 * 100;

describe('APE_YEAR_PROJECTION (D-figures)', () => {
  it('P18-T1 AC-7 the year to date as of the latest month held, over that month’s number, run to twelve', () => {
    expect(apeYearProjection(900, 9)).toBe(1200);
    expect(apeYearProjection(1000, 3)).toBe(4000);
    expect(apeYearProjection(100, 7)).toBe(171);
  });

  it('P18-T1 AC-7 a month with no file is still covered: September held, August missing, the year to date is nine months’', () => {
    // January to July and September held, August not: the September file's year to date includes August's
    // production, so the pace is over nine months — never over the eight files held.
    const ytdThroughSeptember = 1_080 * M;
    expect(apeYearProjection(ytdThroughSeptember, 9)).toBe(1_440 * M);
    expect(apeYearProjection(ytdThroughSeptember, 9)).not.toBe(Math.round((ytdThroughSeptember / 8) * 12));
  });

  it('P18-T1 AC-7 null until a month of the year is held', () => {
    expect(apeYearProjection(null, 9)).toBeNull();
    expect(apeYearProjection(500, 0)).toBeNull();
  });
});
