import { INFORMAL_GROUP, PROGRESS_TONE } from '@/domain/constants/advanced-analytics';
import { eventNpsForPeriod, oneOnOnesPerWeek, oneOnOneTarget, progressPct, progressTone, usagePct } from './subgroup';

describe('P19.22-T5 Informal group’s drivers and the events’ NPS (ADR-0275 §5; §A.15)', () => {
  it('P19.22-T5 AC-2 a figure against its target is a whole %; no figure or no target is —', () => {
    expect(progressPct(5, 8)).toBe(63);
    expect(progressPct(8, 8)).toBe(100);
    expect(progressPct(8.5, 16)).toBe(53);
    expect(progressPct(4, 0)).toBeNull();
    expect(progressPct(null, 8)).toBeNull();
    expect(progressPct(3, null)).toBeNull();
  });

  it('P19.22-T5 AC-2 green from 100 %, yellow from 67 %, red below (PROGRESS_TONE)', () => {
    expect(PROGRESS_TONE).toEqual({ GREEN_PCT: 100, YELLOW_PCT: 67 });
    expect(progressTone(100)).toBe('green');
    expect(progressTone(140)).toBe('green');
    expect(progressTone(99)).toBe('yellow');
    expect(progressTone(67)).toBe('yellow');
    expect(progressTone(66)).toBe('red');
    expect(progressTone(0)).toBe('red');
    expect(progressTone(null)).toBeNull();
  });

  it('P19.22-T5 AC-2 1-on-1 per minggu = sessions in 30 days ÷ 4,35; target = 2 × the Active Agent target', () => {
    expect(INFORMAL_GROUP.WEEKS_IN_WINDOW).toBe(4.35);
    expect(oneOnOnesPerWeek(37)).toBe(8.5);
    expect(oneOnOnesPerWeek(13)).toBe(3);
    expect(oneOnOnesPerWeek(0)).toBe(0);
    expect(oneOnOneTarget(8)).toBe(16);
    expect(oneOnOneTarget(0)).toBe(0);
    expect(oneOnOneTarget(null)).toBeNull();
  });

  it('P19.22-T5 AC-2 Pemakaian is the share who logged in the window; over nobody it is —', () => {
    expect(usagePct([true, true, false, true])).toBe(75);
    expect(usagePct([false])).toBe(0);
    expect(usagePct([])).toBeNull();
  });

  it('P19.5-T3 AC-3 OWN Case 7 event NPS is standard NPS with its average; no answer is null', () => {
    expect(eventNpsForPeriod([10, 9, 9, 8, 7, 6, 3])).toEqual({
      nps: 14, n: 7, promoters: 3, passives: 2, detractors: 2, average: 7.4,
    });
    expect(eventNpsForPeriod([])).toMatchObject({ nps: null, average: null, n: 0 });
  });
});
