import { CALENDAR } from '@/domain/constants';
import { englishAll, indonesianAll } from '../../../test/i18n';
import {
  mondayOf, officeClockOf, officeDateOf, officeTimingOf, periodOf, startOfOfficeDay, timingOf, weekdayOf,
} from './calendar-time';

const JAKARTA = 'Asia/Jakarta';

/**
 * **Exit criterion 1, at the level of the arithmetic** (P12-T2 AC-3, P12-T3 AC-5; the phase file's *Exit
 * criteria*): the office's Monday-to-Sunday week, its padded month, and a wall-clock time as an instant.
 *
 * These run in Jest's own process. **The same answers with the process's clock in UTC, Jakarta and New
 * York** is `calendar-time.zones.spec.ts`'s, which runs them in a child process per zone — Jest's sandbox
 * copies `process.env`, so setting `TZ` here would move nothing and prove nothing.
 */
describe('the calendar’s clock, in the office’s zone', () => {
  describe('weeks run Monday to Sunday (metrics-and-definitions.md; Calendar_Section.html:457)', () => {
    it('P12-T2 AC-3 numbers the days Monday 0 to Sunday 6', () => {
      expect(['2026-09-28', '2026-09-29', '2026-10-03', '2026-10-04'].map(weekdayOf)).toEqual([0, 1, 5, 6]);
    });

    it('P12-T2 AC-3 a Sunday belongs to the week that began the Monday before', () => {
      expect(mondayOf('2026-10-04')).toBe('2026-09-28');
      expect(mondayOf('2026-09-28')).toBe('2026-09-28');
      expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    });

    it('P12-T2 AC-3 a week across a month end is read whole: its days, and the dates ‹ and › ask for', () => {
      expect(periodOf('week', '2026-10-01')).toEqual({
        view: 'week', from: '2026-09-28', to: '2026-10-04', month: null,
        days: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
          .map((date) => ({ date, inPeriod: true })),
        previous: '2026-09-21', next: '2026-10-05',
      });
    });

    it('P12-T2 AC-3 a week across a year end is read whole', () => {
      const week = periodOf('week', '2027-01-01');
      expect([week.from, week.to, week.previous, week.next]).toEqual(['2026-12-28', '2027-01-03', '2026-12-21', '2027-01-04']);
      expect(week.days.map((d) => d.date)).toContain('2026-12-31');
    });
  });

  describe('a month is padded to whole weeks (P12-T3 AC-1, AC-5)', () => {
    it('P12-T3 AC-5 a February: its own days in period, the padding not', () => {
      const feb = periodOf('month', '2026-02-14');
      expect([feb.from, feb.to, feb.month]).toEqual(['2026-01-26', '2026-03-01', '2026-02']);
      expect(feb.days).toHaveLength(35);
      expect(feb.days.filter((d) => d.inPeriod)).toHaveLength(28);
      expect(feb.days[0]).toEqual({ date: '2026-01-26', inPeriod: false });
      expect(feb.days.at(-1)).toEqual({ date: '2026-03-01', inPeriod: false });
      expect([feb.previous, feb.next]).toEqual(['2026-01-01', '2026-03-01']);
    });

    it('P12-T3 AC-5 a month that starts on a Monday has no leading padding', () => {
      const june = periodOf('month', '2026-06-30');
      expect(june.from).toBe('2026-06-01');
      expect(june.days[0]).toEqual({ date: '2026-06-01', inPeriod: true });
      expect(june.to).toBe('2026-07-05');
    });

    it('P12-T3 AC-5 a month that needs six rows', () => {
      const august = periodOf('month', '2026-08-01');
      expect([august.from, august.to]).toEqual(['2026-07-27', '2026-09-06']);
      expect(august.days).toHaveLength(42);
    });

    it('P12-T3 AC-1 ‹ and › step a month across a year end', () => {
      const december = periodOf('month', '2026-12-25');
      expect([december.previous, december.next]).toEqual(['2026-11-01', '2027-01-01']);
      expect(periodOf('month', '2027-01-10').previous).toBe('2026-12-01');
    });
  });

  describe('a wall-clock time is the office’s, stored as an instant (P12-T2 AC-3)', () => {
    it('P12-T2 AC-3 an entry at 00:30 WIB on a Monday is that Monday’s, though in UTC it is the Sunday before', () => {
      const result = timingOf('meeting', { date: '2026-09-28', start: '00:30', end: '01:00' }, JAKARTA);
      expect(result).toEqual({
        timing: {
          allDay: false, startsAt: new Date('2026-09-27T17:30:00Z'), endsAt: new Date('2026-09-27T18:00:00Z'), startsOn: null, endsOn: null,
        },
      });
      // Inside the office's week of the 28th, which begins at its own midnight.
      const startsAt = (result as { timing: { startsAt: Date } }).timing.startsAt;
      expect(startsAt >= startOfOfficeDay(JAKARTA, '2026-09-28')).toBe(true);
      expect(officeClockOf(JAKARTA, startsAt)).toEqual({ date: '2026-09-28', time: '00:30', minute: 30 });
    });

    it('P12-T2 AC-3 23:59 and 00:01 in Jakarta fall either side of the office’s midnight', () => {
      expect(officeClockOf(JAKARTA, new Date('2026-09-27T16:59:00Z'))).toEqual({ date: '2026-09-27', time: '23:59', minute: 1439 });
      expect(officeClockOf(JAKARTA, new Date('2026-09-27T17:01:00Z'))).toEqual({ date: '2026-09-28', time: '00:01', minute: 1 });
      expect(startOfOfficeDay(JAKARTA, '2026-09-28')).toEqual(new Date('2026-09-27T17:00:00Z'));
    });

    it('P12-T2 AC-5 an end of 00:00 is midnight at the end of the date, never 24:00, and reads back as 00:00', () => {
      const result = timingOf('task', { date: '2026-09-28', start: '23:30', end: '00:00' }, JAKARTA);
      expect(result).toEqual({
        timing: {
          allDay: false, startsAt: new Date('2026-09-28T16:30:00Z'), endsAt: new Date('2026-09-28T17:00:00Z'), startsOn: null, endsOn: null,
        },
      });
      const stored = { type: 'task' as const, ...(result as { timing: { startsAt: Date; endsAt: Date } }).timing, startsOn: null, endsOn: null };
      expect(officeTimingOf(stored, JAKARTA)).toEqual({
        allDay: false, date: '2026-09-28', start: '23:30', end: '00:00', startsOn: null, endsOn: null,
      });
      // A whole day, start and end both 00:00, is allowed: it ends at the next midnight.
      expect('timing' in timingOf('meeting', { date: '2026-09-28', start: '00:00', end: '00:00' }, JAKARTA)).toBe(true);
    });

    it('P12-T2 AC-7 Travel is two office dates, its instants the office’s midnights around them, inclusive', () => {
      const result = timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-10-02' }, JAKARTA);
      expect(result).toEqual({
        timing: {
          allDay: true, startsAt: new Date('2026-09-30T17:00:00Z'), endsAt: new Date('2026-10-02T17:00:00Z'),
          startsOn: '2026-10-01', endsOn: '2026-10-02',
        },
      });
      const stored = { type: 'travel' as const, ...(result as { timing: { startsAt: Date; endsAt: Date; startsOn: string; endsOn: string } }).timing };
      expect(officeTimingOf(stored, JAKARTA)).toEqual({
        allDay: true, date: null, start: null, end: null, startsOn: '2026-10-01', endsOn: '2026-10-02',
      });
      expect(officeDateOf(stored, JAKARTA)).toBe('2026-10-01');
    });

    it('a notice names a timed entry by its office date, not its UTC one', () => {
      expect(officeDateOf({ type: 'meeting', startsAt: new Date('2026-09-27T17:30:00Z'), startsOn: null }, JAKARTA)).toBe('2026-09-28');
    });
  });
});

describe('the rules an entry’s timing keeps (P12-T2 AC-5)', () => {
  /** Each rule broken, as the API's English writes it (P18.98-T5: each is a sentence in both languages). */
  const refused = (result: ReturnType<typeof timingOf>) => englishAll('violations' in result ? result.violations : []);
  /** The same, in Indonesian. */
  const refusedInIndonesian = (result: ReturnType<typeof timingOf>) => indonesianAll('violations' in result ? result.violations : []);

  it('P12-T2 AC-5 an end at or before its start is refused, naming the field', () => {
    expect(refused(timingOf('meeting', { date: '2026-09-28', start: '10:00', end: '10:00' }, JAKARTA)))
      .toEqual(['end must be after start on the same date.']);
    expect(refused(timingOf('meeting', { date: '2026-09-28', start: '10:00', end: '09:30' }, JAKARTA)))
      .toEqual(['end must be after start on the same date.']);
  });

  it('P12-T2 AC-5 a timed entry needs its date and both times; Travel needs both dates', () => {
    expect(refused(timingOf('client', {}, JAKARTA))).toEqual(['date is required.', 'start is required.', 'end is required.']);
    expect(refused(timingOf('travel', { startsOn: '2026-10-01', endsOn: null }, JAKARTA))).toEqual(['endsOn is required.']);
  });

  it('P12-T2 AC-5 the other kind’s fields are refused rather than ignored', () => {
    expect(refused(timingOf('meeting', {
      date: '2026-09-28', start: '09:00', end: '10:00', startsOn: '2026-09-28',
    }, JAKARTA))).toEqual(['startsOn is not part of a timed entry.']);
    expect(refused(timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-10-02', start: '09:00' }, JAKARTA)))
      .toEqual(['start is not part of a travel entry.']);
    // `null` is absent, so a form that clears the other kind's fields is not refused.
    expect('timing' in timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-10-01', date: null }, JAKARTA)).toBe(true);
  });

  it('P12-T2 AC-5 a date that is no day, and a time that is no time, are refused', () => {
    expect(refused(timingOf('task', { date: '2026-02-30', start: '24:00', end: '9:00' }, JAKARTA))).toEqual([
      'date must be a day, written YYYY-MM-DD.', 'start must be a time, written HH:mm.', 'end must be a time, written HH:mm.',
    ]);
    expect(refused(timingOf('travel', { startsOn: '2026-02-30', endsOn: '2026-13-01' }, JAKARTA))).toEqual([
      'startsOn must be a day, written YYYY-MM-DD.', 'endsOn must be a day, written YYYY-MM-DD.',
    ]);
  });

  it('UI-104 a trip with times needs a time on each date: one that is no time is refused, naming its field', () => {
    expect(refused(timingOf('travel', {
      allDay: false, startsOn: '2026-10-01', start: '7:30', endsOn: '2026-10-02', end: '24:00',
    }, JAKARTA))).toEqual(['start must be a time, written HH:mm.', 'end must be a time, written HH:mm.']);
    expect(refusedInIndonesian(timingOf('travel', {
      allDay: false, startsOn: '2026-10-01', start: '07:30', endsOn: '2026-10-02', end: '18:0',
    }, JAKARTA))).toEqual(['end harus berupa jam, dengan format HH:mm.']);
    // With both times well formed it is a trip with times, its instants the office's wall clock on each date.
    expect(timingOf('travel', { allDay: false, startsOn: '2026-10-01', start: '07:30', endsOn: '2026-10-02', end: '18:00' }, JAKARTA))
      .toEqual({
        timing: {
          allDay: false, startsAt: new Date('2026-10-01T00:30:00Z'), endsAt: new Date('2026-10-02T11:00:00Z'),
          startsOn: '2026-10-01', endsOn: '2026-10-02',
        },
      });
  });

  it('P12-T2 AC-5 a return before the departure is refused; the same day is a one-day trip', () => {
    expect(refused(timingOf('travel', { startsOn: '2026-10-02', endsOn: '2026-10-01' }, JAKARTA)))
      .toEqual(['endsOn must be on or after startsOn.']);
    expect('timing' in timingOf('travel', { startsOn: '2026-10-02', endsOn: '2026-10-02' }, JAKARTA)).toBe(true);
  });

  it(`P12-T2 AC-5 a trip of ${CALENDAR.TRAVEL_DAYS_MAX} days inclusive is allowed, and one day more is refused`, () => {
    expect('timing' in timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-10-31' }, JAKARTA)).toBe(true);
    expect(refused(timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-11-01' }, JAKARTA)))
      .toEqual(['endsOn must be at most 31 days from startsOn, inclusive.']);
  });

  it('P18.98-T5 AC-3 says every rule in Indonesian, each field named as the API names it', () => {
    expect(refusedInIndonesian(timingOf('client', {}, JAKARTA)))
      .toEqual(['date wajib diisi.', 'start wajib diisi.', 'end wajib diisi.']);
    expect(refusedInIndonesian(timingOf('meeting', {
      date: '2026-09-28', start: '09:00', end: '10:00', startsOn: '2026-09-28',
    }, JAKARTA))).toEqual(['startsOn bukan bagian dari entri dengan jam mulai dan selesai.']);
    expect(refusedInIndonesian(timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-10-02', start: '09:00' }, JAKARTA)))
      .toEqual(['start bukan bagian dari entri perjalanan.']);
    expect(refusedInIndonesian(timingOf('task', { date: '2026-02-30', start: '24:00', end: '9:00' }, JAKARTA))).toEqual([
      'date harus berupa tanggal, dengan format YYYY-MM-DD.', 'start harus berupa jam, dengan format HH:mm.',
      'end harus berupa jam, dengan format HH:mm.',
    ]);
    expect(refusedInIndonesian(timingOf('meeting', { date: '2026-09-28', start: '10:00', end: '09:30' }, JAKARTA)))
      .toEqual(['end harus setelah start pada tanggal yang sama.']);
    expect(refusedInIndonesian(timingOf('travel', { startsOn: '2026-10-02', endsOn: '2026-10-01' }, JAKARTA)))
      .toEqual(['endsOn harus sama dengan atau setelah startsOn.']);
    expect(refusedInIndonesian(timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-11-01' }, JAKARTA)))
      .toEqual(['endsOn paling lambat 31 hari dari startsOn, termasuk kedua tanggalnya.']);
  });

  it('sets a wall clock in a zone with a daylight-saving day as that wall clock, not as minutes after midnight', () => {
    // 8 March 2026 is New York's spring-forward day: 10:00 there is 14:00 UTC, not 15:00.
    const result = timingOf('meeting', { date: '2026-03-08', start: '10:00', end: '11:00' }, 'America/New_York');
    expect((result as { timing: { startsAt: Date } }).timing.startsAt).toEqual(new Date('2026-03-08T14:00:00Z'));
  });
});
