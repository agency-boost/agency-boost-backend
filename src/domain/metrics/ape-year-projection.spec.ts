import { apeYearProjection, projectionMonth } from './ape-year-projection';

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

  it('P19.3-T1 AC-12 a month in progress never enters the projection: it runs from the latest ended month held (D8, Q4)', () => {
    // 3 Nov: November is uploaded mid-month, October and September held — the projection runs from October.
    expect(projectionMonth(['2026-09', '2026-10', '2026-11'], '2026-11')).toEqual({ month: '2026-10', number: 10 });
    // October missing: September's year to date covers nine months, as before.
    expect(projectionMonth(['2026-09', '2026-11'], '2026-11')).toEqual({ month: '2026-09', number: 9 });
    // Last year's months and later ones are no year to date of this one.
    expect(projectionMonth(['2025-12', '2026-12'], '2026-11')).toEqual({ month: null, number: 0 });
  });

  it('P19.3-T1 AC-12 only the current month held — January, or a first upload this month — projects nothing', () => {
    expect(projectionMonth(['2026-01'], '2026-01')).toEqual({ month: null, number: 0 });
    expect(apeYearProjection(10 * M, projectionMonth(['2026-01'], '2026-01').number)).toBeNull();
    // Never ×12 / (3/31): a 3 January upload of Rp 10 Jt is no Rp 1,24 M year.
    expect(apeYearProjection(10 * M, projectionMonth(['2026-01'], '2026-01').number)).not.toBe(Math.round(10 * M * 12 * 31 / 3));
  });

  it('P19.3-T1 AC-12 APE YTD ÷ the months elapsed × 12, the months whole (Q4): Oct’s year to date over 10', () => {
    const ytdThroughOctober = 1_000 * M;
    expect(apeYearProjection(ytdThroughOctober, projectionMonth(['2026-10', '2026-11'], '2026-11').number)).toBe(1_200 * M);
  });
});
