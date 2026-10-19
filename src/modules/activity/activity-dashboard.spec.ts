import { bucketIndex, bucketsFor, dashboardRange } from './activity-dashboard';

const TODAY = '2026-09-28';

/** The Activity Dashboard's range and columns (P10-T1). */
describe('the Activity Dashboard’s range and columns (P10-T1)', () => {
  describe('AC-1 — the three ranges', () => {
    it('defaults to the last 7 days, ending today', () => {
      expect(dashboardRange({}, TODAY)).toEqual({ range: 'ROLLING_7D', from: '2026-09-22', to: TODAY, days: 7 });
    });

    it('takes the last 30 days as thirty dates ending today — fixed, not an office’s setting', () => {
      expect(dashboardRange({ range: 'ROLLING_30D' }, TODAY)).toEqual({
        range: 'ROLLING_30D', from: '2026-08-30', to: TODAY, days: 30,
      });
    });

    it('takes a custom range as given, across a month end', () => {
      expect(dashboardRange({ range: 'CUSTOM', from: '2026-08-25', to: '2026-09-03' }, TODAY)).toEqual({
        range: 'CUSTOM', from: '2026-08-25', to: '2026-09-03', days: 10,
      });
    });

    it('takes a one-day custom range, and one ending today', () => {
      expect(dashboardRange({ range: 'CUSTOM', from: TODAY, to: TODAY }, TODAY).days).toBe(1);
    });

    it('refuses dates sent with a preset, rather than answering a different question', () => {
      expect(() => dashboardRange({ range: 'ROLLING_7D', from: '2020-01-01', to: '2020-01-02' }, TODAY))
        .toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', details: { field: 'range' } }));
      expect(() => dashboardRange({ from: '2026-09-01' }, TODAY)).toThrow(/for a CUSTOM range/);
    });
  });

  describe('AC-3 — a custom range that cannot be shown is refused, never trimmed', () => {
    const refused = (input: Record<string, string>) => {
      try {
        dashboardRange({ range: 'CUSTOM', ...input }, TODAY);
      } catch (err) {
        return err as { code: string; status: number; details: Record<string, unknown>; message: string };
      }
      throw new Error('expected a refusal');
    };

    it('refuses a range that ends after today', () => {
      const err = refused({ from: '2026-09-20', to: '2026-09-29' });
      expect(err).toMatchObject({ code: 'VALIDATION_FAILED', status: 400, details: { field: 'to', today: TODAY } });
      expect(err.message).toMatch(/ends after today/);
    });

    it('refuses a range that starts after it ends', () => {
      expect(refused({ from: '2026-09-10', to: '2026-09-01' })).toMatchObject({ details: { field: 'from' } });
    });

    it('refuses a range longer than a year, and takes exactly a year', () => {
      expect(refused({ from: '2025-09-27', to: TODAY })).toMatchObject({ details: { days: 367, max: 366 } });
      expect(dashboardRange({ range: 'CUSTOM', from: '2025-09-28', to: TODAY }, TODAY).days).toBe(366);
    });

    it('refuses a range reaching back centuries at once — counted, not listed day by day', () => {
      // Typing a year into a date field sends 0002, 0020, 0202 on the way to 2026.
      const started = performance.now();
      expect(refused({ from: '0100-01-01', to: TODAY })).toMatchObject({ details: { days: 703_728, max: 366 } });
      expect(performance.now() - started).toBeLessThan(20);
    });

    it('refuses a missing or malformed date by name', () => {
      expect(refused({ to: TODAY })).toMatchObject({ details: { field: 'from' } });
      expect(refused({ from: TODAY })).toMatchObject({ details: { field: 'to' } });
      expect(refused({ from: '2026-02-31', to: TODAY })).toMatchObject({ details: { field: 'from' } });
    });

    it('refuses a range it does not know', () => {
      try {
        dashboardRange({ range: 'LAST_QUARTER' }, TODAY);
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'range' } });
      }
    });
  });

  describe('AC-2 — the columns', () => {
    it('seven days: a column a day, most recent first', () => {
      const buckets = bucketsFor(dashboardRange({}, TODAY));
      expect(buckets).toHaveLength(7);
      expect(buckets[0]).toEqual({ from: TODAY, to: TODAY, days: 1, kind: 'day' });
      expect(buckets[6]).toMatchObject({ from: '2026-09-22', kind: 'day' });
    });

    it('thirty days: four 7-day blocks back from today, Week 1 the most recent, then the last 2 days', () => {
      const buckets = bucketsFor(dashboardRange({ range: 'ROLLING_30D' }, TODAY));
      expect(buckets.map((b) => [b.from, b.to, b.kind])).toEqual([
        ['2026-09-22', '2026-09-28', 'week'],
        ['2026-09-15', '2026-09-21', 'week'],
        ['2026-09-08', '2026-09-14', 'week'],
        ['2026-09-01', '2026-09-07', 'week'],
        ['2026-08-30', '2026-08-31', 'remainder'],
      ]);
      expect(buckets[4].days).toBe(2);
    });

    it('custom up to 31 days: a column a day — a whole month fits', () => {
      const buckets = bucketsFor(dashboardRange({ range: 'CUSTOM', from: '2026-08-01', to: '2026-08-31' }, TODAY));
      expect(buckets).toHaveLength(31);
      expect(buckets.every((b) => b.kind === 'day')).toBe(true);
      expect(buckets[0].from).toBe('2026-08-31');
    });

    it('custom above 31 days: blocks back from the end, and no remainder when it divides', () => {
      const buckets = bucketsFor(dashboardRange({ range: 'CUSTOM', from: '2026-07-07', to: '2026-09-07' }, TODAY));
      // 63 days — nine whole weeks.
      expect(buckets).toHaveLength(9);
      expect(buckets.every((b) => b.kind === 'week')).toBe(true);
      expect(buckets[8]).toMatchObject({ from: '2026-07-07', to: '2026-07-13' });
    });

    it('a year: fifty-two weeks and the two days left over, every day in exactly one column', () => {
      const range = dashboardRange({ range: 'CUSTOM', from: '2025-09-28', to: TODAY }, TODAY);
      const buckets = bucketsFor(range);
      expect(buckets).toHaveLength(53);
      expect(buckets[52]).toMatchObject({ kind: 'remainder', days: 2, from: '2025-09-28' });
      expect(buckets.reduce((sum, b) => sum + b.days, 0)).toBe(366);
    });

    it('places a day in its column, and nothing outside the range', () => {
      const buckets = bucketsFor(dashboardRange({ range: 'ROLLING_30D' }, TODAY));
      expect(bucketIndex(buckets, TODAY)).toBe(0);
      expect(bucketIndex(buckets, '2026-09-21')).toBe(1);
      expect(bucketIndex(buckets, '2026-08-30')).toBe(4);
      expect(bucketIndex(buckets, '2026-08-29')).toBe(-1);
    });
  });
});
