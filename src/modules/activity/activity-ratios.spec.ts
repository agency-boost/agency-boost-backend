import { RATIO_BENCHMARKS } from '@/domain/constants';
import { appliesTo, computeRatio } from './activity-ratios';

const sums = (entries: Record<string, number>) => new Map(Object.entries(entries));
const SSR = {
  comparison: 'gte' as const, benchmark: RATIO_BENCHMARKS.SELLING_SUCCESS_RATE,
  numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'],
};
const BALANCE = {
  comparison: 'band' as const, benchmark: RATIO_BENCHMARKS.BALANCE_BAND_PP,
  numerator: ['SELL_PRESENTATION', 'SELL_FOLLOWUP', 'SELL_SUBMISSION'],
  denominator: ['RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP', 'RECRUIT_AGENT_CODE'],
};

/** The ratio engine's arithmetic (P10-T2). */
describe('computing one ratio (P10-T2)', () => {
  describe('AC-2 — a zero denominator is not enough data, never zero', () => {
    it('answers null and neutral for a rate with nothing under it', () => {
      expect(computeRatio(SSR, sums({ SELL_SUBMISSION: 4 }))).toEqual({
        value: null, share: null, numeratorCount: 4, denominatorCount: 0, status: 'neutral',
      });
    });

    it('answers null and neutral for a balance with nothing on either side', () => {
      expect(computeRatio(BALANCE, sums({})).status).toBe('neutral');
      expect(computeRatio(BALANCE, sums({})).value).toBeNull();
    });

    it('answers a real zero when the denominator is there and the numerator is not', () => {
      expect(computeRatio(SSR, sums({ SELL_PRESENTATION: 5 }))).toMatchObject({ value: 0, status: 'alert' });
    });
  });

  describe('AC-3 — a rate is judged against its benchmark, at or above', () => {
    it('sums every code on each side', () => {
      expect(computeRatio(SSR, sums({ SELL_SUBMISSION: 3, SELL_PRESENTATION: 12, SELL_FOLLOWUP: 8 })))
        .toMatchObject({ value: 0.15, numeratorCount: 3, denominatorCount: 20 });
    });

    it('reads exactly the benchmark as on track, and anything under it as below', () => {
      // 30%, the client's benchmark since ADR-0160 §2: 6 ÷ 20 is exactly it.
      expect(computeRatio(SSR, sums({ SELL_SUBMISSION: 6, SELL_PRESENTATION: 20 })).status).toBe('success');
      expect(computeRatio(SSR, sums({ SELL_SUBMISSION: 5, SELL_PRESENTATION: 20 })).status).toBe('alert');
    });

    it('takes the benchmark it is given — an office’s own, not the platform’s', () => {
      expect(computeRatio({ ...SSR, benchmark: 0.1 }, sums({ SELL_SUBMISSION: 2, SELL_PRESENTATION: 20 })).status)
        .toBe('success');
    });

    it('lets a ratio run past 1, as meeting per approach does', () => {
      const MPA = { comparison: 'gte' as const, benchmark: 1.5, numerator: ['SELL_PRESENTATION'], denominator: ['LEADS_CONTACTED'] };
      expect(computeRatio(MPA, sums({ SELL_PRESENTATION: 9, LEADS_CONTACTED: 4 }))).toMatchObject({ value: 2.25, status: 'success' });
    });
  });

  describe('AC-4 — the balance is two sides, and a lean in points', () => {
    it('reads an even split as zero points, on track', () => {
      expect(computeRatio(BALANCE, sums({ SELL_PRESENTATION: 5, RECRUIT_PRESENTATION: 5 })))
        .toMatchObject({ value: 0, share: 50, status: 'success' });
    });

    it('leans toward selling as positive and toward recruitment as negative', () => {
      expect(computeRatio(BALANCE, sums({ SELL_PRESENTATION: 9, RECRUIT_PRESENTATION: 1 })))
        .toMatchObject({ value: 80, share: 90, status: 'alert' });
      expect(computeRatio(BALANCE, sums({ SELL_PRESENTATION: 1, RECRUIT_FOLLOWUP: 3 })))
        .toMatchObject({ value: -50, share: 25, status: 'alert' });
    });

    it('holds the band’s edge exactly: thirteen to seven is 30 points, on track', () => {
      expect(computeRatio(BALANCE, sums({ SELL_SUBMISSION: 13, RECRUIT_AGENT_CODE: 7 })))
        .toMatchObject({ value: 30, status: 'success' });
      expect(computeRatio(BALANCE, sums({ SELL_SUBMISSION: 14, RECRUIT_AGENT_CODE: 6 })).status).toBe('alert');
    });

    it('reads all selling and no recruitment as a full lean, not as missing data', () => {
      expect(computeRatio(BALANCE, sums({ SELL_PRESENTATION: 6 }))).toMatchObject({ value: 100, share: 100 });
    });

    it('P13.1-T6 AC-1: gives two selling and three recruiting a 40% share, which the card writes 40% · 60%', () => {
      // The share is what the screen reads now; the lean is the same split, and still what is judged.
      expect(computeRatio(BALANCE, sums({ SELL_PRESENTATION: 2, RECRUIT_PRESENTATION: 3 })))
        .toEqual({ value: -20, share: 40, numeratorCount: 2, denominatorCount: 3, status: 'success' });
    });

    it('P13.1-T6 AC-2: judges the share band the card states — 35% to 65% for ±30 points, edges included', () => {
      expect(computeRatio(BALANCE, sums({ SELL_PRESENTATION: 7, RECRUIT_PRESENTATION: 13 })))
        .toMatchObject({ share: 35, status: 'success' });
      expect(computeRatio(BALANCE, sums({ SELL_PRESENTATION: 34, RECRUIT_PRESENTATION: 66 })))
        .toMatchObject({ share: 34, status: 'alert' });
    });
  });

  describe('P10-T3 AC-1 — which rungs a ratio is a question about', () => {
    it('applies to every rung when it names none, and only to the named ones otherwise', () => {
      expect(appliesTo([], 'AGENT')).toBe(true);
      expect(appliesTo(undefined, 'AGENT')).toBe(true);
      expect(appliesTo(['AB', 'AAB'], 'AGENT')).toBe(false);
      expect(appliesTo(['AB', 'AAB'], 'AAB')).toBe(true);
    });
  });
});
