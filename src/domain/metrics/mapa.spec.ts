import { changeOf, changePct, changePoints, MAPA_ROW_KEYS, MAPA_ROWS, monthlyMean } from './mapa';

describe('P19.22-T3 MAPA driver’s comparisons (ADR-0275 §3; §A.21)', () => {
  it('P19.22-T3 AC-2 eight rows: APE alone, then M · A · P · A', () => {
    expect(MAPA_ROW_KEYS).toEqual([
      'ape', 'manpower', 'rekrut', 'active_agent', 'new_agent_3m', 'policies', 'policies_per_active_agent', 'average_case_size',
    ]);
    expect(MAPA_ROW_KEYS.map((k) => MAPA_ROWS[k].group)).toEqual([
      'ape', 'manpower', 'manpower', 'activation', 'activation', 'productivity', 'productivity', 'case_size',
    ]);
  });

  it('P19.22-T3 AC-2 APE’s YTD is the total; a count’s the mean of its months; a ratio’s its own figure', () => {
    expect(MAPA_ROWS.ape.ytd).toBe('total');
    expect(MAPA_ROWS.manpower.ytd).toBe('mean');
    expect(MAPA_ROWS.rekrut.ytd).toBe('mean');
    expect(MAPA_ROWS.policies.ytd).toBe('mean');
    expect(MAPA_ROWS.active_agent.ytd).toBe('metric');
    expect(MAPA_ROWS.new_agent_3m.ytd).toBe('metric');
    expect(MAPA_ROWS.policies_per_active_agent.ytd).toBe('metric');
    expect(MAPA_ROWS.average_case_size.ytd).toBe('metric');
  });

  it('P19.22-T3 AC-2 the average per month is over the months holding a figure, to a tenth', () => {
    expect(monthlyMean([1, 0, 2, null, 1])).toBe(1);
    expect(monthlyMean([1, 1, 2])).toBe(1.3);
    expect(monthlyMean([null, null])).toBeNull();
    expect(monthlyMean([])).toBeNull();
  });

  it('P19.22-T3 AC-3 the change is in % of the earlier figure; — over 0 or nothing', () => {
    expect(changePct(2195, 1630)).toBe(35);
    expect(changePct(30, 33)).toBe(-9);
    expect(changePct(0, 1)).toBe(-100);
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(null, 4)).toBeNull();
    expect(changePct(4, null)).toBeNull();
  });

  it('P19.22-T3 AC-3 a percentage row changes in points', () => {
    expect(changePoints(36, 30)).toBe(6);
    expect(changePoints(25, 29)).toBe(-4);
    expect(changePoints(null, 29)).toBeNull();
    expect(changeOf('percentage', 36, 30)).toEqual({ value: 6, kind: 'points' });
    expect(changeOf('count', 6, 5)).toEqual({ value: 20, kind: 'pct' });
  });
});
