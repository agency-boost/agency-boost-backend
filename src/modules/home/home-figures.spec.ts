import { byReport, daysWithCounts, reported, splitOf } from './home-figures';

describe('Home’s pure rules (UI-100, UI-101)', () => {
  it('UI-100 a split’s figure is its two scopes summed: Unit 1/4 · AAB 3/8 is 4 of 12', () => {
    expect(splitOf({ count: 1, of: 4 }, { count: 3, of: 8 })).toEqual({
      count: 4, of: 12, unit: { count: 1, of: 4 }, aab: { count: 3, of: 8 },
    });
    expect(splitOf({ count: 0, of: 1 }, { count: 0, of: 0 })).toEqual({
      count: 0, of: 1, unit: { count: 0, of: 1 }, aab: { count: 0, of: 0 },
    });
  });

  it('UI-101 reported is what the pill draws: above zero only — no day and a saved day of nothing are Belum lapor', () => {
    expect(reported(5)).toBe(true);
    expect(reported(0)).toBe(false);
    expect(reported(null)).toBe(false);
  });

  it('UI-101 sorts empty both days, then empty today, then the rest — each group in the roster’s order', () => {
    const rows = [
      { name: 'INDAH', yesterday: 5, today: 2 },
      { name: 'SITI', yesterday: 3, today: null },
      { name: 'LUKMAN', yesterday: null, today: null },
      { name: 'BUDI', yesterday: null, today: 4 },
      { name: 'HERMAN', yesterday: 0, today: 0 },
      { name: 'RINA', yesterday: 1, today: 0 },
    ];
    expect(byReport(rows).map((r) => r.name)).toEqual(['LUKMAN', 'HERMAN', 'SITI', 'RINA', 'INDAH', 'BUDI']);
    // Pure: the list given is not reordered.
    expect(rows[0].name).toBe('INDAH');
  });

  it('UI-100 the chart’s days carry 0 where nothing was saved, oldest first', () => {
    const days = ['2026-10-24', '2026-10-25', '2026-10-26'];
    expect(daysWithCounts(days, new Map([['2026-10-25', 6]]))).toEqual([
      { date: '2026-10-24', count: 0 }, { date: '2026-10-25', count: 6 }, { date: '2026-10-26', count: 0 },
    ]);
    expect(daysWithCounts(days, undefined).map((d) => d.count)).toEqual([0, 0, 0]);
  });
});
