import { ACTIVATION_3M } from '@/domain/constants';
import {
  ACTIVATION_3M_LOCKS, ACTIVATION_3M_RESULTS, activation3MByJoinMonth, activation3MDay, activation3MDecided, activation3MLastDay,
  activation3MOf, activation3MShare, newHiresWindow, type Activation3MInput,
} from './activation-3m';

/**
 * `ACTIVATION_3M` and `ACTIVATION_3M_PCT` (ADR-0171 §2, P18.96-T6 AC-1, AC-2; `metrics-and-definitions.md`, *3M
 * activation*): the boundaries the definition names, every one an office date.
 */
const JOINED = '2026-07-01';
// Day 90 of a 1 July join is 28 September; day 91 is 29 September.
const DAY_90 = '2026-09-28';
const DAY_91 = '2026-09-29';
const hire = (over: Partial<Activation3MInput> = {}): Activation3MInput => ({
  joinDate: JOINED, firstSaleDate: null, leftOn: null, locked: null, ...over,
});

describe('3M activation (ADR-0171 §2)', () => {
  it('P18.96-T6 AC-1 pins the 90 days and the twelve months, and the three results', () => {
    expect(ACTIVATION_3M).toEqual({ DAYS: 90, WINDOW_MONTHS: 12 });
    expect([...ACTIVATION_3M_RESULTS]).toEqual(['in_progress', 'activated', 'not_activated']);
    expect([...ACTIVATION_3M_LOCKS]).toEqual(['activated', 'not_activated']);
  });

  it('P18.96-T6 AC-1 counts the join date as day 1 and day 90 as the join date plus 89, across a month and a leap day', () => {
    expect(activation3MLastDay(JOINED)).toBe(DAY_90);
    expect(activation3MDay(JOINED, JOINED)).toBe(1);
    expect(activation3MDay(JOINED, DAY_90)).toBe(90);
    expect(activation3MDay(JOINED, DAY_91)).toBe(91);
    // Never below 1, even for a day before the join (a correction moved it later).
    expect(activation3MDay(JOINED, '2026-06-30')).toBe(1);
    // 2028 is a leap year: from 1 January, day 60 is 29 February and day 90 is 30 March.
    expect(activation3MDay('2028-01-01', '2028-02-29')).toBe(60);
    expect(activation3MLastDay('2028-01-01')).toBe('2028-03-30');
  });

  it('P18.96-T6 AC-1 is in progress through day 90 — with a first sale or without one', () => {
    expect(activation3MOf(hire(), JOINED)).toBe('in_progress');
    expect(activation3MOf(hire(), DAY_90)).toBe('in_progress');
    expect(activation3MOf(hire({ firstSaleDate: '2026-07-20' }), DAY_90)).toBe('in_progress');
    expect(activation3MDecided(hire({ firstSaleDate: '2026-07-20' }), DAY_90)).toBeNull();
  });

  it('P18.96-T6 AC-1 a first sale on day 90 is activated; on day 91 it is not; none by then is not', () => {
    expect(activation3MOf(hire({ firstSaleDate: DAY_90 }), DAY_91)).toBe('activated');
    expect(activation3MOf(hire({ firstSaleDate: DAY_91 }), DAY_91)).toBe('not_activated');
    expect(activation3MOf(hire(), DAY_91)).toBe('not_activated');
    expect(activation3MOf(hire({ firstSaleDate: JOINED }), DAY_91)).toBe('activated');
  });

  it('P18.96-T6 AC-1 a first sale after day 90 never changes it: not activated, a month or a year on', () => {
    for (const today of [DAY_91, '2026-10-29', '2027-07-01']) {
      expect(activation3MOf(hire({ firstSaleDate: '2026-10-15' }), today)).toBe('not_activated');
    }
  });

  it('P18.96-T6 AC-1 leaving before a first sale is not activated at once, before day 90; after one, activated', () => {
    expect(activation3MOf(hire({ leftOn: '2026-08-10' }), '2026-08-10')).toBe('not_activated');
    // A first sale recorded later, dated after the day they left, does not count: they had left.
    expect(activation3MOf(hire({ leftOn: '2026-08-10', firstSaleDate: '2026-08-20' }), '2026-08-21')).toBe('not_activated');
    // Sold on the day they left, or before: activated, decided that day.
    expect(activation3MOf(hire({ leftOn: '2026-08-10', firstSaleDate: '2026-08-10' }), '2026-08-10')).toBe('activated');
    expect(activation3MDecided(hire({ leftOn: '2026-08-10', firstSaleDate: '2026-07-15' }), '2026-08-10')).toBe('activated');
    // Leaving after day 90 changes nothing: the 90 days decided it.
    expect(activation3MOf(hire({ leftOn: '2026-10-01', firstSaleDate: '2026-09-01' }), '2026-10-01')).toBe('activated');
    expect(activation3MOf(hire({ leftOn: '2026-10-01' }), '2026-10-01')).toBe('not_activated');
    // Read as of a day before the leaving, they had not left yet.
    expect(activation3MOf(hire({ leftOn: '2026-08-10' }), '2026-08-09')).toBe('in_progress');
  });

  it('P18.96-T6 AC-1 a kept lock is the answer whatever the records say since — a backdated sale, a corrected join date', () => {
    expect(activation3MOf(hire({ locked: 'not_activated', firstSaleDate: '2026-07-10' }), '2026-11-01')).toBe('not_activated');
    expect(activation3MOf(hire({ locked: 'activated', joinDate: '2026-10-01' }), '2026-10-02')).toBe('activated');
    expect(activation3MDecided(hire({ locked: 'activated' }), JOINED)).toBe('activated');
  });

  it('P18.96-T6 AC-1 is computed from office dates alone: no instant, so the server’s clock decides nothing', () => {
    // The caller turns `leftAt` and today into the office's days; the same days give the same answer.
    const input = hire({ firstSaleDate: DAY_90 });
    expect([activation3MOf(input, DAY_90), activation3MOf(input, DAY_91)]).toEqual(['in_progress', 'activated']);
  });
});

describe('the year /new-hires lists (ADR-0173 §1)', () => {
  it('P18.96-T6 AC-3 runs from the day after the same date twelve months back to today', () => {
    expect(newHiresWindow('2026-10-27')).toEqual({ from: '2025-10-28', to: '2026-10-27' });
    expect(newHiresWindow('2026-03-01')).toEqual({ from: '2025-03-02', to: '2026-03-01' });
    // A month-end clamps: 29 February 2028 counts back to 28 February 2027.
    expect(newHiresWindow('2028-02-29')).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });
});

describe('ACTIVATION_3M_PCT (ADR-0171 §2)', () => {
  it('P18.96-T6 AC-2 is activated ÷ (activated + not activated), whole, those in progress in neither part', () => {
    expect(activation3MShare(['activated', 'not_activated', 'not_activated', 'in_progress'])).toEqual({
      activated: 1, notActivated: 2, inProgress: 1, pct: 33,
    });
    expect(activation3MShare(['activated', 'not_activated'])).toMatchObject({ pct: 50 });
    // Half up, in integers: 2 of 3 is 67.
    expect(activation3MShare(['activated', 'activated', 'not_activated']).pct).toBe(67);
  });

  it('P18.96-T6 AC-2 is no figure while nobody is decided — never 0%', () => {
    expect(activation3MShare([])).toEqual({ activated: 0, notActivated: 0, inProgress: 0, pct: null });
    expect(activation3MShare(['in_progress', 'in_progress']).pct).toBeNull();
    expect(activation3MShare(['not_activated']).pct).toBe(0);
  });

  it('P18.96-T6 AC-2 by join month: each month’s new hires, newest first, an empty month not listed', () => {
    const byMonth = activation3MByJoinMonth([
      { joinDate: '2026-07-22', result: 'activated' },
      { joinDate: '2026-07-31', result: 'not_activated' },
      { joinDate: '2026-09-01', result: 'in_progress' },
      { joinDate: '2026-06-30', result: 'activated' },
    ]);
    expect(byMonth.map((m) => [m.month, m.share.pct])).toEqual([['2026-09', null], ['2026-07', 50], ['2026-06', 100]]);
  });
});
