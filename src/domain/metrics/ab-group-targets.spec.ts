import {
  addMonths, effectiveTarget, isMonth, monthlyApeTarget, rekrutYtdTarget, spreadOverYear, sumTargets, targetMonthOpen,
  type StoredAbGroupTarget,
} from './ab-group-targets';

const row = (month: string, activeAgentTarget: number, rekrutTarget: number): StoredAbGroupTarget => (
  { month, activeAgentTarget, rekrutTarget }
);

/** ADR-0270 §4–§6 — the monthly targets per AB group, their sums, and the APE target from Goal Setting. */
describe('AB group targets (P19.17-T4)', () => {
  const rows = [row('2026-11', 8, 4), row('2026-03', 6, 3), row('2025-12', 5, 2)];

  describe('effectiveTarget', () => {
    it('P19.17-T4 AC-3 reads the row saved for the month', () => {
      expect(effectiveTarget(rows, '2026-11')).toEqual({ activeAgentTarget: 8, rekrutTarget: 4, source: 'set', fromMonth: '2026-11' });
    });

    it('OD-386 carries the latest earlier month forward until it is changed, across a year end too', () => {
      expect(effectiveTarget(rows, '2026-10')).toEqual({ activeAgentTarget: 6, rekrutTarget: 3, source: 'carried', fromMonth: '2026-03' });
      expect(effectiveTarget(rows, '2027-02')).toMatchObject({ activeAgentTarget: 8, source: 'carried', fromMonth: '2026-11' });
      expect(effectiveTarget(rows, '2026-01')).toMatchObject({ activeAgentTarget: 5, source: 'carried', fromMonth: '2025-12' });
    });

    it('OD-386 reads no target before the first row, and with none at all — never a template default', () => {
      const none = { activeAgentTarget: null, rekrutTarget: null, source: 'none', fromMonth: null };
      expect(effectiveTarget(rows, '2025-11')).toEqual(none);
      expect(effectiveTarget([], '2026-11')).toEqual(none);
    });
  });

  it('P19.17-T4 AC-3 sums AB groups into an informal group or the KPM, counting those with none', () => {
    expect(sumTargets([effectiveTarget(rows, '2026-11'), effectiveTarget(rows, '2026-05'), effectiveTarget([], '2026-11')]))
      .toEqual({ activeAgentTarget: 14, rekrutTarget: 7, unset: 1 });
    expect(sumTargets([])).toEqual({ activeAgentTarget: 0, rekrutTarget: 0, unset: 0 });
  });

  it('P19.17-T4 AC-3 adds a year’s Rekrut targets from January to the month', () => {
    // January and February carry December 2025's 2; March to October 3; November 4.
    expect(rekrutYtdTarget(rows, '2026-11')).toBe(2 + 2 + 3 * 8 + 4);
    expect(rekrutYtdTarget([], '2026-11')).toBe(0);
  });

  it('P19.17-T4 AC-3 divides the members’ annual Goal Setting by 12, to the whole sen, a negative counting nothing', () => {
    expect(monthlyApeTarget([500_000_000_00, 100_000_000_00])).toBe(5_000_000_000);
    expect(monthlyApeTarget([7])).toBe(1);
    expect(monthlyApeTarget([-5, 12])).toBe(1);
    expect(monthlyApeTarget([])).toBe(0);
  });

  it('OD-387 spreads a year’s target over twelve whole months that add up to it', () => {
    expect(spreadOverYear(6)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    expect(spreadOverYear(24)).toEqual(Array(12).fill(2));
    expect(spreadOverYear(13).reduce((a, b) => a + b, 0)).toBe(13);
    expect(spreadOverYear(0)).toEqual(Array(12).fill(0));
    expect(spreadOverYear(-3)).toEqual(Array(12).fill(0));
    expect(spreadOverYear(6.9).reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('reads and moves months', () => {
    expect(isMonth('2026-11')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('P19.17-T4 AC-3 opens a month from January 2024 to a year after the office’s month', () => {
    expect(targetMonthOpen('2024-01', '2026-11')).toBe(true);
    expect(targetMonthOpen('2023-12', '2026-11')).toBe(false);
    expect(targetMonthOpen('2027-11', '2026-11')).toBe(true);
    expect(targetMonthOpen('2027-12', '2026-11')).toBe(false);
    expect(targetMonthOpen('nope', '2026-11')).toBe(false);
  });
});
