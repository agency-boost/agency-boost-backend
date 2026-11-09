import { TIME } from '@/domain/constants';
import {
  daysLogged, eventNpsForPeriod, oneOnOnesPerWeek, powerUserCount, targetAttainment, weeklyActivityTarget,
} from './subgroup';

describe('P19.5-T3 Sub-group improvements and the events’ NPS (ADR-0215 §4, §7; §A.15)', () => {
  const window = ['2026-11-06', '2026-11-05', '2026-11-04'];

  it('P19.5-T3 AC-10 power users log on at least the template’s days of its window', () => {
    const saved = new Map([['a', new Set(window)], ['b', new Set(['2026-11-06'])], ['c', new Set<string>()]]);
    expect(daysLogged(saved.get('a'), window)).toBe(3);
    expect(daysLogged(undefined, window)).toBe(0);
    expect(powerUserCount(['a', 'b', 'c'], saved, window, 2)).toBe(1);
  });

  it('P19.5-T3 AC-10 one-on-ones a week divide 30 days’ sessions by the one weeks-per-month constant, 4.33', () => {
    expect(TIME.WEEKS_PER_MONTH).toBe(4.33);
    expect(oneOnOnesPerWeek(13)).toBe(3);
    expect(oneOnOnesPerWeek(0)).toBe(0);
  });

  it('P19.5-T3 AC-10 the weekly activity target is the multiplier times the AA target', () => {
    expect(weeklyActivityTarget(2, 3)).toBe(6);
  });

  it('P19.5-T3 AC-10 a target met to subgroupOkPct is green; a target of 0 is —', () => {
    expect(targetAttainment(3, 3, 80)).toEqual({ pct: 100, ok: true });
    expect(targetAttainment(2, 3, 80)).toEqual({ pct: 67, ok: false });
    expect(targetAttainment(5, 0, 80)).toEqual({ pct: null, ok: null });
    expect(targetAttainment(null, 3, 80)).toEqual({ pct: null, ok: null });
  });

  it('P19.5-T3 AC-3 OWN Case 7 event NPS is standard NPS with its average; no answer is null', () => {
    expect(eventNpsForPeriod([10, 9, 9, 8, 7, 6, 3])).toEqual({
      nps: 14, n: 7, promoters: 3, passives: 2, detractors: 2, average: 7.4,
    });
    expect(eventNpsForPeriod([])).toMatchObject({ nps: null, average: null, n: 0 });
  });
});
