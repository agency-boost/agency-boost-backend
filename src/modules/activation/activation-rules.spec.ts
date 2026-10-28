import { FixedClock } from '@/common/clock/clock.port';
import { addDays } from '@/common/time/local-day';
import {
  activationDay, activationEndsOn, activationState, activityWeeksCompletedOn, firstCaseClosed, isOverdue,
  nthOneOnOne, officeMondayOf, progressOf,
} from './activation-rules';

const J = 'Asia/Jakarta';
const clock = new FixedClock(new Date('2026-10-03T03:00:00Z'));

/** The checklist shape the arithmetic reads: aspects of items, by code. */
const ASPECTS = [
  { code: 'A', label: '1. A', items: [{ code: 'A1' }, { code: 'A2' }] },
  { code: 'B', label: '2. B', items: [{ code: 'B1' }, { code: 'FIRST_CASE_CLOSED' }, { code: 'B3' }] },
  { code: 'C', label: '3. C', items: [{ code: 'C1' }] },
];

describe('the activation’s arithmetic (Phase 13)', () => {
  describe('the day (ACTIVATION_DAY_INDEX, P13-T1 AC-4)', () => {
    it('P13-T1 AC-4 the start date is day 1, and each office day after it one more', () => {
      expect(activationDay(clock, J, '2026-10-03', '2026-10-03')).toBe(1);
      expect(activationDay(clock, J, '2026-08-06', '2026-10-03')).toBe(59);
      expect(activationDay(clock, J, '2026-07-05', '2026-10-03')).toBe(91);
    });

    it('P13-T1 AC-4 is never below 1, for a start date the office’s today has not reached', () => {
      expect(activationDay(clock, J, '2026-10-05', '2026-10-03')).toBe(1);
    });

    it('P13-T1 AC-4 counts whole calendar days across a DST change in a zone that has one', () => {
      // New York springs forward on 8 March 2026: a day of 23 hours is still one day.
      expect(activationDay(clock, 'America/New_York', '2026-03-07', '2026-03-09')).toBe(3);
    });
  });

  describe('the end (OD-120, P13-T1 AC-5)', () => {
    it('P13-T1 AC-5 is six calendar months after the start date', () => {
      expect(activationEndsOn(J, '2026-08-06')).toBe('2027-02-06');
      expect(activationEndsOn(J, '2026-01-01')).toBe('2026-07-01');
    });

    it('P13-T1 AC-5 a month-end start ends on the last day of the shorter month: 31 August → end of February', () => {
      expect(activationEndsOn(J, '2026-08-31')).toBe('2027-02-28');
      expect(activationEndsOn(J, '2027-08-31')).toBe('2028-02-29');
      expect(activationEndsOn('America/New_York', '2026-08-31')).toBe('2027-02-28');
    });

    it('P13-T1 AC-5 open until graduated or until the office’s today reaches the end; graduation wins', () => {
      expect(activationState(null, '2027-02-05', '2027-02-06')).toBe('open');
      expect(activationState(null, '2027-02-06', '2027-02-06')).toBe('expired');
      expect(activationState(null, '2027-03-01', '2027-02-06')).toBe('expired');
      expect(activationState(new Date(), '2027-03-01', '2027-02-06')).toBe('graduated');
      expect(activationState(new Date(), '2026-09-01', '2027-02-06')).toBe('graduated');
    });
  });

  describe('overdue (P13-T1 AC-4)', () => {
    it('P13-T1 AC-4 is a day past the window below 100%, and only while open', () => {
      expect(isOverdue(91, 90, 99, 'open')).toBe(true);
      expect(isOverdue(90, 90, 10, 'open')).toBe(false);
      expect(isOverdue(120, 90, 100, 'open')).toBe(false);
      expect(isOverdue(120, 90, 50, 'graduated')).toBe(false);
      expect(isOverdue(190, 90, 50, 'expired')).toBe(false);
      // The office's window, not the literal 90.
      expect(isOverdue(91, 120, 50, 'open')).toBe(false);
    });
  });

  describe('progress (ACTIVATION_COMPLETION_PCT, P13-T2 AC-5)', () => {
    it('P13-T2 AC-5 is round(done / total × 100) over the pinned items, by code', () => {
      const progress = progressOf(ASPECTS, new Set(['A1', 'B1', 'NOT_IN_THE_VERSION']));
      expect([progress.done, progress.total, progress.pct]).toEqual([2, 6, 33]);
      expect(progressOf(ASPECTS, new Set(['A1', 'A2', 'B1', 'B3'])).pct).toBe(67);
    });

    it('P13-T2 AC-5 an aspect is Done when every item is, Not started when none is, In progress between', () => {
      const progress = progressOf(ASPECTS, new Set(['A1', 'A2', 'B1']));
      expect(progress.aspects.map((a) => [a.code, a.status, a.done, a.total])).toEqual([
        ['A', 'done', 2, 2], ['B', 'in_progress', 1, 3], ['C', 'not_started', 0, 1],
      ]);
      expect(progress.aspects[0].items.map((i) => [i.item.code, i.done])).toEqual([['A1', true], ['A2', true]]);
    });

    it('P13-T2 AC-5 a version with no items reads 0%, never a division by zero', () => {
      expect(progressOf([], new Set()).pct).toBe(0);
    });

    it('P13-T5 AC-2 Active Agent is FIRST_CASE_CLOSED done, by code and never by position', () => {
      expect(firstCaseClosed(progressOf(ASPECTS, new Set(['FIRST_CASE_CLOSED'])))).toBe(true);
      expect(firstCaseClosed(progressOf(ASPECTS, new Set(['B1', 'B3'])))).toBe(false);
    });
  });

  describe('four consecutive office weeks (feature:activity, P13-T3 AC-4)', () => {
    const mondayOf = officeMondayOf(clock, J);
    const days = (...dates: string[]) => dates.map((date) => ({ date, id: date }));

    it('P13-T3 AC-4 the office week runs Monday to Sunday, through Clock.weekBounds', () => {
      expect(mondayOf('2026-09-28')).toBe('2026-09-28');
      expect(mondayOf('2026-10-04')).toBe('2026-09-28');
      expect(mondayOf('2026-10-05')).toBe('2026-10-05');
      expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    });

    it('P13-T3 AC-4 four consecutive weeks complete it, on the first day logged in the fourth', () => {
      const four = days('2026-09-07', '2026-09-16', '2026-09-20', '2026-09-27', '2026-10-01', '2026-10-02');
      expect(activityWeeksCompletedOn(four, mondayOf)).toEqual({ date: '2026-10-01', id: '2026-10-01' });
    });

    it('P13-T3 AC-4 three do not', () => {
      expect(activityWeeksCompletedOn(days('2026-09-14', '2026-09-21', '2026-09-28'), mondayOf)).toBeNull();
    });

    it('P13-T3 AC-4 three weeks, a gap, then four: the run restarts after the gap', () => {
      const weeks = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
      expect(activityWeeksCompletedOn(days(...weeks), mondayOf)?.date).toBe('2026-09-21');
      expect(activityWeeksCompletedOn(days(...weeks.slice(0, 6)), mondayOf)).toBeNull();
    });

    it('P13-T3 AC-4 a Sunday is the end of its own week, not the start of the next', () => {
      // Sundays 13, 20, 27 Sep and 4 Oct are the last days of four consecutive weeks.
      expect(activityWeeksCompletedOn(days('2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'), mondayOf)?.date)
        .toBe('2026-10-04');
      // Sunday 6 Sep and Monday 7 Sep are two weeks, not one.
      expect(activityWeeksCompletedOn(days('2026-09-06', '2026-09-07', '2026-09-14', '2026-09-21'), mondayOf)?.date)
        .toBe('2026-09-21');
    });

    it('P13-T3 AC-4 any four consecutive weeks: the days arrive in any order', () => {
      const start = '2026-06-01';
      const run = [0, 7, 14, 21].map((n) => addDays(start, n)).reverse();
      expect(activityWeeksCompletedOn(days(...run), mondayOf)?.date).toBe('2026-06-22');
    });

    it('P13-T3 AC-4 a week across a year end is one week', () => {
      expect(activityWeeksCompletedOn(days('2026-12-14', '2026-12-21', '2026-12-31', '2027-01-03', '2027-01-04'), mondayOf)?.date)
        .toBe('2027-01-04');
    });
  });
});

describe('nthOneOnOne — Weekly 1-on-1 check-in (P18.96-T4 AC-2)', () => {
  const s = (date: string, sessionId: string) => ({ date, sessionId });

  it('P18.96-T4 AC-2 is the fourth 1:1 since the start, oldest first, and null before it', () => {
    const three = [s('2026-08-10', 'b'), s('2026-08-03', 'a'), s('2026-08-17', 'c')];
    expect(nthOneOnOne(three, '2026-08-01', 4)).toBeNull();
    expect(nthOneOnOne([...three, s('2026-08-24', 'd')], '2026-08-01', 4)).toEqual(s('2026-08-24', 'd'));
  });

  it('P18.96-T4 AC-2 counts none before the start, and two on one day as two, by id', () => {
    const sessions = [s('2026-07-31', 'x'), s('2026-08-03', 'a'), s('2026-08-03', 'b'), s('2026-08-04', 'c'), s('2026-08-05', 'd')];
    expect(nthOneOnOne(sessions, '2026-08-01', 4)).toEqual(s('2026-08-05', 'd'));
    expect(nthOneOnOne(sessions, '2026-08-01', 2)).toEqual(s('2026-08-03', 'b'));
    // On the start date itself, it counts.
    expect(nthOneOnOne([s('2026-08-01', 'z')], '2026-08-01', 1)).toEqual(s('2026-08-01', 'z'));
  });
});
