import { FixedClock } from './clock.port';

const JAKARTA = 'Asia/Jakarta';

describe('Clock', () => {
  describe('localDateFor — the prototype defect this exists to prevent', () => {
    it('returns the tenant-local day, not the UTC day, before 07:00 in Jakarta', () => {
      // 2026-09-04T22:30Z is 2026-09-05T05:30 in Jakarta (UTC+7).
      const clock = new FixedClock(new Date('2026-09-04T22:30:00Z'));
      expect(clock.localDateFor(JAKARTA)).toBe('2026-09-05');
      // What the prototype does — and why it is wrong for seven hours a day.
      expect(clock.now().toISOString().split('T')[0]).toBe('2026-09-04');
    });

    it('is stable regardless of the server timezone', () => {
      const clock = new FixedClock(new Date('2026-09-04T22:30:00Z'));
      const original = process.env.TZ;
      try {
        for (const tz of ['UTC', 'America/New_York', 'Asia/Jakarta', 'Pacific/Kiritimati']) {
          process.env.TZ = tz;
          expect(clock.localDateFor(JAKARTA)).toBe('2026-09-05');
        }
      } finally {
        process.env.TZ = original;
      }
    });
  });

  describe('day bounds', () => {
    it('starts a Jakarta day at 17:00 UTC the previous day', () => {
      const clock = new FixedClock(new Date('2026-09-04T00:00:00Z'));
      expect(clock.startOfLocalDay(JAKARTA, '2026-09-05').toISOString()).toBe(
        '2026-09-04T17:00:00.000Z',
      );
    });
    it('ends the day exclusively at the next day start', () => {
      const clock = new FixedClock(new Date('2026-09-04T00:00:00Z'));
      expect(clock.endOfLocalDay(JAKARTA, '2026-09-05')).toEqual(
        clock.startOfLocalDay(JAKARTA, '2026-09-06'),
      );
    });
  });

  describe('monthBounds — "this month" is a calendar month (OD-11)', () => {
    it('spans exactly the calendar month in the tenant zone', () => {
      const clock = new FixedClock(new Date('2026-09-15T00:00:00Z'));
      const { start, endExclusive } = clock.monthBounds(JAKARTA, '2026-09');
      expect(start.toISOString()).toBe('2026-08-31T17:00:00.000Z');
      expect(endExclusive.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    });
    it('is not a rolling 30-day window', () => {
      const clock = new FixedClock(new Date('2026-02-15T00:00:00Z'));
      const { start, endExclusive } = clock.monthBounds(JAKARTA, '2026-02');
      const days = (endExclusive.getTime() - start.getTime()) / 86_400_000;
      expect(days).toBe(28);
    });
  });

  describe('weekBounds', () => {
    it('starts the week on Monday in the tenant zone', () => {
      // 2026-09-04 is a Friday.
      const clock = new FixedClock(new Date('2026-09-04T05:00:00Z'));
      const { start, endExclusive } = clock.weekBounds(JAKARTA);
      expect(clock.localDateFor(JAKARTA, start)).toBe('2026-08-31'); // Monday
      expect((endExclusive.getTime() - start.getTime()) / 86_400_000).toBe(7);
    });
  });

  describe('daysBetween', () => {
    it('counts whole tenant-local days, inclusive of neither end', () => {
      const clock = new FixedClock(new Date('2026-09-04T00:00:00Z'));
      expect(clock.daysBetween(JAKARTA, '2026-09-01', '2026-09-04')).toBe(3);
      expect(clock.daysBetween(JAKARTA, '2026-09-04', '2026-09-04')).toBe(0);
    });
    it('is negative when the range runs backwards', () => {
      const clock = new FixedClock(new Date('2026-09-04T00:00:00Z'));
      expect(clock.daysBetween(JAKARTA, '2026-09-04', '2026-09-01')).toBe(-3);
    });
  });
});
