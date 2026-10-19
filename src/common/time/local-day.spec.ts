import {
  calendarMonth, daysBetween, editableUntil, endOfMonth, isFutureDay, isLocalDate,
  isWithinCorrectionWindow, localDayOf, rollingWindow,
} from './local-day';

const JAKARTA = 'Asia/Jakarta';

/**
 * Calendar days in a tenant's timezone (P6-T1, invariant §9).
 *
 * The first block is the one that matters: it is the prototype's defect, written as a test that
 * fails if anybody reintroduces `toISOString()`.
 */
describe('local days', () => {
  describe('the day an instant falls on', () => {
    it('is the office\'s day, not UTC\'s — the 07:00 defect', () => {
      /*
       * 2026-03-10T22:30Z is 05:30 on the 11th in Jakarta. The prototype's
       * `toISOString().split('T')[0]` answers `2026-03-10`: an agent logging their evening
       * before 07:00 local files it against yesterday, and every metric over it is off by a day
       * for that person.
       */
      const evening = new Date('2026-03-10T22:30:00Z');

      expect(localDayOf(evening, JAKARTA)).toBe('2026-03-11');
      expect(evening.toISOString().slice(0, 10)).toBe('2026-03-10');
    });

    it('holds at both edges of the office\'s day', () => {
      // 17:00Z is midnight in Jakarta: the first instant of the 11th.
      expect(localDayOf(new Date('2026-03-10T17:00:00Z'), JAKARTA)).toBe('2026-03-11');
      // One second earlier is still the 10th.
      expect(localDayOf(new Date('2026-03-10T16:59:59Z'), JAKARTA)).toBe('2026-03-10');
    });

    it('answers a different day for two offices at the same instant', () => {
      // v1 is single-timezone (ADR-0016), but the column is real and every computation reads it —
      // removing the indirection is what reintroduces the defect this whole file guards.
      const instant = new Date('2026-03-10T22:30:00Z');

      expect(localDayOf(instant, JAKARTA)).toBe('2026-03-11');
      expect(localDayOf(instant, 'America/New_York')).toBe('2026-03-10');
      expect(localDayOf(instant, 'UTC')).toBe('2026-03-10');
    });
  });

  describe('what is a local date at all', () => {
    it('accepts the stored shape and rejects everything else', () => {
      expect(isLocalDate('2026-03-11')).toBe(true);
      expect(isLocalDate('2026-3-11')).toBe(false);
      expect(isLocalDate('11-03-2026')).toBe(false);
      expect(isLocalDate('2026-03-11T00:00:00Z')).toBe(false);
      expect(isLocalDate(20260311)).toBe(false);
      expect(isLocalDate(null)).toBe(false);
    });

    it('rejects a date that matches the pattern and is not a day', () => {
      // The regex alone accepts these; only round-tripping catches them.
      expect(isLocalDate('2026-02-31')).toBe(false);
      expect(isLocalDate('2026-13-01')).toBe(false);
      expect(isLocalDate('2025-02-29')).toBe(false);
      // …and a real leap day still passes.
      expect(isLocalDate('2024-02-29')).toBe(true);
    });
  });

  describe('the correction window (ADR-0042)', () => {
    it('runs to the end of the day\'s own month plus the grace days', () => {
      // The window belongs to the month, not the day: the 3rd and the 31st close together,
      // because that is what an office's month-end close is.
      expect(editableUntil('2026-03-03', 7)).toBe('2026-04-07');
      expect(editableUntil('2026-03-31', 7)).toBe('2026-04-07');
    });

    it('crosses a year end and a leap February without special-casing', () => {
      expect(editableUntil('2026-12-15', 7)).toBe('2027-01-07');
      expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
      expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    });

    it('keeps a March day open through 7 April and closes it on the 8th', () => {
      expect(isWithinCorrectionWindow('2026-03-11', '2026-03-11', 7)).toBe(true);
      expect(isWithinCorrectionWindow('2026-03-11', '2026-04-07', 7)).toBe(true);
      expect(isWithinCorrectionWindow('2026-03-11', '2026-04-08', 7)).toBe(false);
    });

    it('takes the grace window from the office, so a zero-day office closes at month end', () => {
      expect(isWithinCorrectionWindow('2026-03-11', '2026-03-31', 0)).toBe(true);
      expect(isWithinCorrectionWindow('2026-03-11', '2026-04-01', 0)).toBe(false);
    });
  });

  describe('a day that has not happened', () => {
    it('is refused, and today is not', () => {
      expect(isFutureDay('2026-03-12', '2026-03-11')).toBe(true);
      expect(isFutureDay('2026-03-11', '2026-03-11')).toBe(false);
      expect(isFutureDay('2026-03-10', '2026-03-11')).toBe(false);
    });
  });

  describe('the windows a metric is computed over', () => {
    it('makes ROLLING_7D the seven days ending today, inclusive', () => {
      const window = rollingWindow('2026-03-11', 7);

      expect(window).toEqual({ from: '2026-03-05', to: '2026-03-11' });
      expect(daysBetween(window.from, window.to)).toHaveLength(7);
    });

    it('makes a calendar month the calendar month, not a rolling thirty days', () => {
      // The prototype's Personal Summary treats "this month" as a rolling 30 days and its
      // "this year" as 365. ADR-0022 settled that a rolling window is never labelled this month.
      expect(calendarMonth('2026-03-11')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
      expect(calendarMonth('2026-02-11')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    });

    it('enumerates a range inclusively, across a month boundary', () => {
      expect(daysBetween('2026-02-27', '2026-03-02'))
        .toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    });
  });
});
