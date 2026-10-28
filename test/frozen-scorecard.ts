const M = 1_000_000 * 100;

/**
 * **A scorecard frozen before 2026-10-28, exactly as the freeze wrote it then** (ADR-0129 §7): five columns, *FY* and
 * *YTD* named by their years, nine rows with *Producing agents* and *New AA*, *# of units* the AB agencies (5, equal to
 * *# of AB*), no *AS OF*. Meeting #12 of 0417 on staging, and the seed's #12 (P18.97-T1 AC-20).
 */
export function frozenBeforeTheSlide(): Record<string, unknown> {
  const year = (fy: unknown, ytd: unknown) => ({ fy, ytd, thisMonthLastYear: { kind: 'blocked' }, lastMonth: { kind: 'blocked' }, thisMonth: { kind: 'blocked' } });
  const every = (fy: unknown, ytd: unknown, a: unknown, b: unknown, c: unknown) => ({ fy, ytd, thisMonthLastYear: a, lastMonth: b, thisMonth: c });
  const f = (value: number, leavesOut: string[] = []) => ({ kind: 'figure', value, leavesOut });
  return {
    periods: { fy: '2025', ytd: '2026', thisMonthLastYear: '2025-09', lastMonth: '2026-08', thisMonth: '2026-09' },
    chips: { manpower: 26, agents: 17, units: 5, ab: 5, aab: 4 },
    rows: [
      { key: 'ape', unit: 'idr_minor', cells: every(f(1_800 * M, ['2025-01']), f(5_800 * M), f(150 * M), { kind: 'pending' }, f(640 * M)) },
      { key: 'manpower', unit: 'count', cells: every(f(22), f(26), f(21), f(25), f(26)) },
      { key: 'flc', unit: 'count', cells: every({ kind: 'pending' }, { kind: 'pending' }, { kind: 'pending' }, { kind: 'pending' }, { kind: 'pending' }) },
      { key: 'producing_agents', unit: 'count', cells: year(f(18), f(21)) },
      { key: 'new_aa', unit: 'count', cells: every(f(1.5), f(2), f(1), { kind: 'pending' }, f(3)) },
      { key: 'new_agent_3m', unit: 'percentage', cells: year(f(100), f(50)) },
      { key: 'avg_monthly_aa', unit: 'count', cells: every(f(14.4), f(17.25), f(12), { kind: 'pending' }, f(19)) },
      { key: 'case_submission', unit: 'count', cells: every(f(250), f(310, ['2026-08']), f(20), { kind: 'pending' }, f(36)) },
      { key: 'average_case_size', unit: 'idr_minor', cells: year(f(7.2 * M), f(18.7 * M)) },
    ],
  };
}
