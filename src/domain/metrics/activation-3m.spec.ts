import { addDays as addDaysTo } from '@/common/time/local-day';
import { ACTIVATION_3M } from '@/domain/constants';
import {
  ACTIVATION_3M_LOCKS, ACTIVATION_3M_RESULTS, NEW_HIRE_STATUSES, activation3MByJoinMonth, activation3MDay, activation3MDecided,
  activation3MFirstSaleDay, activation3MLastDay, activation3MOf, activation3MShare, newHireStatusOf, newHiresWindow,
  type Activation3MInput, type Activation3MOutcome,
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
  joinDate: JOINED, firstSaleDate: null, locked: null, ...over,
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

  it('UI-023 a first sale on or before day 90 is activated at once; none, in progress through day 90', () => {
    expect(activation3MOf(hire(), JOINED)).toBe('in_progress');
    expect(activation3MOf(hire(), DAY_90)).toBe('in_progress');
    // Rule A (D-24): the sale decides it the day it is recorded — not day 91.
    expect(activation3MOf(hire({ firstSaleDate: '2026-07-20' }), '2026-07-20')).toBe('activated');
    expect(activation3MOf(hire({ firstSaleDate: '2026-07-20' }), DAY_90)).toBe('activated');
    // Nothing is kept inside the 90 days, so a wrong file put right can still take its sale back (M4).
    expect(activation3MDecided(hire({ firstSaleDate: '2026-07-20' }), DAY_90)).toBeNull();
  });

  it('P18.96-T6 AC-1 a first sale on day 90 is activated; on day 91 it is not; none by then is not', () => {
    expect(activation3MOf(hire({ firstSaleDate: DAY_90 }), DAY_91)).toBe('activated');
    expect(activation3MOf(hire({ firstSaleDate: DAY_91 }), DAY_91)).toBe('not_activated');
    expect(activation3MOf(hire(), DAY_91)).toBe('not_activated');
    expect(activation3MOf(hire({ firstSaleDate: JOINED }), DAY_91)).toBe('activated');
    expect(activation3MDecided(hire({ firstSaleDate: DAY_90 }), DAY_91)).toBe('activated');
    expect(activation3MDecided(hire(), DAY_91)).toBe('not_activated');
  });

  it('UI-023 a first sale after day 90 keeps the result not activated and reads activated late, amber', () => {
    for (const today of [DAY_91, '2026-10-29', '2027-07-01']) {
      const result = activation3MOf(hire({ firstSaleDate: '2026-10-15' }), today);
      expect(result).toBe('not_activated');
      expect(newHireStatusOf(result, '2026-10-15')).toBe('activated_late');
    }
  });

  it('UI-023 the status: activated by day 90, activated late after it, not yet without a first sale', () => {
    expect([...NEW_HIRE_STATUSES]).toEqual(['activated', 'activated_late', 'not_yet']);
    expect(newHireStatusOf('activated', '2026-07-20')).toBe('activated');
    expect(newHireStatusOf('in_progress', null)).toBe('not_yet');
    expect(newHireStatusOf('not_activated', null)).toBe('not_yet');
    // A sale recorded after *not activated* was kept — a backdated closing, a late file: amber, outside the share.
    expect(newHireStatusOf('not_activated', '2026-07-10')).toBe('activated_late');
  });

  it('UI-023 the first sale’s day: Wahyu, joined 3 August, sold on 1 September — day 30; Lukman day 96', () => {
    expect(activation3MFirstSaleDay('2026-08-03', '2026-09-01')).toBe(30);
    expect(activation3MFirstSaleDay(JOINED, addDaysTo(JOINED, 95))).toBe(96);
    expect(activation3MFirstSaleDay(JOINED, null)).toBeNull();
  });

  it('UI-023 leaving decides nothing: a hire marked left reads from their sale and join date only (no Keluar)', () => {
    // The input has no leaving at all: Tari, who left on day 35 with no sale, is in progress through day 90.
    expect(Object.keys(hire())).toEqual(['joinDate', 'firstSaleDate', 'locked']);
    expect(activation3MOf(hire(), '2026-08-10')).toBe('in_progress');
    expect(activation3MOf(hire(), DAY_91)).toBe('not_activated');
  });

  it('P18.96-T6 AC-1 a kept lock is the answer whatever the records say since — a backdated sale, a corrected join date', () => {
    expect(activation3MOf(hire({ locked: 'not_activated', firstSaleDate: '2026-07-10' }), '2026-11-01')).toBe('not_activated');
    // A lock is the answer inside the 90 days too, and an *activated* one stays even without a sale on record.
    expect(activation3MOf(hire({ locked: 'not_activated', firstSaleDate: '2026-07-10' }), '2026-07-11')).toBe('not_activated');
    expect(activation3MOf(hire({ locked: 'activated', joinDate: '2026-10-01' }), '2026-10-02')).toBe('activated');
    expect(activation3MDecided(hire({ locked: 'activated' }), JOINED)).toBe('activated');
  });

  it('P18.96-T6 AC-1 is computed from office dates alone: no instant, so the server’s clock decides nothing', () => {
    // The caller turns today into the office's day; the same days give the same answer.
    const input = hire({ firstSaleDate: DAY_90 });
    expect([activation3MOf(input, '2026-09-27'), activation3MOf(input, DAY_90), activation3MOf(input, DAY_91)])
      .toEqual(['in_progress', 'activated', 'activated']);
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

/** A hire as the share reads them. */
const o = (result: Activation3MOutcome['result'], firstSaleDate: string | null = null): Activation3MOutcome =>
  ({ result, firstSaleDate });
const sold = o('activated', '2026-08-01');
const late = o('not_activated', '2026-10-15');
const missed = o('not_activated');
const running = o('in_progress');

describe('ACTIVATION_3M_PCT (ADR-0171 §2, rule A of UI V1)', () => {
  it('UI-023 is activated by day 90 ÷ (that + past day 90 with no sale), whole; in progress and late in neither part', () => {
    expect(activation3MShare([sold, missed, missed, running, late])).toEqual({
      activated: 1, notActivated: 2, late: 1, inProgress: 1, pct: 33,
    });
    expect(activation3MShare([sold, missed])).toMatchObject({ pct: 50 });
    // Half up, in integers: 2 of 3 is 67.
    expect(activation3MShare([sold, sold, missed]).pct).toBe(67);
  });

  it('UI-023 Arief’s group: Wahyu and Novi activated, Tari in her 90 days — 2 of 2, 100%, not 2 of 3', () => {
    expect(activation3MShare([sold, sold, running])).toEqual({ activated: 2, notActivated: 0, late: 0, inProgress: 1, pct: 100 });
  });

  it('UI-023 Lukman, sold on day 96, is in neither the numerator nor the denominator', () => {
    const withoutHim = activation3MShare([sold, sold, sold, missed]);
    const withHim = activation3MShare([sold, sold, sold, missed, late]);
    expect(withHim.pct).toBe(withoutHim.pct);
    expect(withHim).toMatchObject({ activated: 3, notActivated: 1, late: 1, pct: 75 });
    // Agus's tree on the report's data: seven activated by day 90, Lukman late, two inside their 90 days — 100%.
    expect(activation3MShare([...Array(7).fill(sold), late, running, running])).toMatchObject({ pct: 100, late: 1, inProgress: 2 });
  });

  it('P18.96-T6 AC-2 is no figure while nobody is decided — never 0%', () => {
    expect(activation3MShare([])).toEqual({ activated: 0, notActivated: 0, late: 0, inProgress: 0, pct: null });
    expect(activation3MShare([running, running]).pct).toBeNull();
    expect(activation3MShare([late]).pct).toBeNull();
    expect(activation3MShare([missed]).pct).toBe(0);
  });

  it('P18.96-T6 AC-2 by join month: each month’s new hires, newest first, an empty month not listed', () => {
    const byMonth = activation3MByJoinMonth([
      { joinDate: '2026-07-22', ...sold },
      { joinDate: '2026-07-31', ...missed },
      { joinDate: '2026-09-01', ...running },
      { joinDate: '2026-06-30', ...sold },
    ]);
    expect(byMonth.map((m) => [m.month, m.share.pct])).toEqual([['2026-09', null], ['2026-07', 50], ['2026-06', 100]]);
  });
});
