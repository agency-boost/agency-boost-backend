import { LEAD_AGE } from '@/domain/constants';
import { FixedClock } from '@/common/clock/clock.port';
import { ageToday, ageWrite, isLeadAge, wholeYearsBetween } from './lead-age';

/**
 * **P19.7-T1 AC-1 — the client's age at the next birthday** (ADR-0224 §2, §3; `metrics-and-definitions.md` §B.34,
 * *The client's age*): read as today's, moving up on each anniversary of the day it was written, on the KPM's calendar.
 */
describe('P19.7-T1 AC-1 the lead’s age (lead-age.ts)', () => {
  it('P19.7-T1 AC-1 pins the bounds: 1 to 100 (LEAD_AGE, §B.34)', () => {
    expect(LEAD_AGE).toEqual({ MIN: 1, MAX: 100 });
    expect([0, 1, 50, 100, 101, 1.5, -3].map(isLeadAge)).toEqual([false, true, true, true, false, false, false]);
  });

  it('P19.7-T1 AC-1 counts whole years on anniversaries, and none before the first', () => {
    expect(wholeYearsBetween('2026-11-05', '2026-11-05')).toBe(0);
    expect(wholeYearsBetween('2026-11-05', '2027-11-04')).toBe(0);
    expect(wholeYearsBetween('2026-11-05', '2027-11-05')).toBe(1);
    expect(wholeYearsBetween('2026-11-05', '2031-11-06')).toBe(5);
    // A day before the one recorded is no year at all, never a negative one.
    expect(wholeYearsBetween('2026-11-05', '2026-01-01')).toBe(0);
  });

  it('P19.7-T1 AC-1 moves up by one on the anniversary, not the day before', () => {
    expect(ageToday(36, '2026-11-05', '2027-11-04')).toBe(36);
    expect(ageToday(36, '2026-11-05', '2027-11-05')).toBe(37);
    expect(ageToday(36, '2026-11-05', '2036-11-05')).toBe(46);
    expect(ageToday(null, null, '2027-11-05')).toBeNull();
  });

  it('P19.7-T1 AC-1 moves across New Year only on the anniversary: 31 Dec → 1 Jan is no year, 30 Dec next year is', () => {
    expect(ageToday(40, '2026-12-30', '2026-12-31')).toBe(40);
    expect(ageToday(40, '2026-12-30', '2027-01-01')).toBe(40);
    expect(ageToday(40, '2026-12-30', '2027-12-29')).toBe(40);
    expect(ageToday(40, '2026-12-30', '2027-12-30')).toBe(41);
  });

  it('P19.7-T1 AC-1 reads the day in Jakarta: the anniversary turns at 00:00 WIB, which is 17:00 UTC the day before', () => {
    const clock = new FixedClock(new Date('2027-11-04T16:59:00Z')); // 23:59 WIB on 4 November
    expect(ageToday(36, '2026-11-05', clock.localDateFor('Asia/Jakarta', clock.now()))).toBe(36);
    clock.set(new Date('2027-11-04T17:00:00Z')); // 00:00 WIB on 5 November — still the 4th in UTC
    expect(clock.now().toISOString().slice(0, 10)).toBe('2027-11-04');
    expect(ageToday(36, '2026-11-05', clock.localDateFor('Asia/Jakarta', clock.now()))).toBe(37);
  });

  it('P19.7-T1 AC-1 gives a day recorded on 29 February its anniversary on 1 March in a year with none', () => {
    expect(ageToday(30, '2028-02-29', '2029-02-28')).toBe(30);
    expect(ageToday(30, '2028-02-29', '2029-03-01')).toBe(31);
    expect(ageToday(30, '2028-02-29', '2032-02-29')).toBe(34);
  });

  describe('P19.7-T1 AC-1 what a write sets', () => {
    const stored = { age: 36, ageRecordedOn: '2026-11-05' };

    it('P19.7-T1 AC-1 moves nothing when the age written is the one the lead reads today', () => {
      expect(ageWrite(stored, 37, '2027-12-01')).toBeNull();
      expect(ageWrite(stored, 36, '2026-12-01')).toBeNull();
    });

    it('P19.7-T1 AC-1 stores another age with today as its day', () => {
      expect(ageWrite(stored, 38, '2027-12-01')).toEqual({ age: 38, ageRecordedOn: '2027-12-01' });
      expect(ageWrite({ age: null, ageRecordedOn: null }, 52, '2026-11-05')).toEqual({ age: 52, ageRecordedOn: '2026-11-05' });
    });

    it('P19.7-T1 AC-1 clears both with null, and writes nothing when there was none', () => {
      expect(ageWrite(stored, null, '2027-01-01')).toEqual({ age: null, ageRecordedOn: null });
      expect(ageWrite({}, null, '2027-01-01')).toBeNull();
    });
  });
});
