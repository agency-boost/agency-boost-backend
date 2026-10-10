import {
  addMonths, campaignPhase, dayRangeWords, durationWords, inclusiveEnd, isWholeMonths, lastLocalDay, monthRangeWords, monthsFrom,
  resolveWindow,
} from './campaign-window';

const JKT = 'Asia/Jakarta';
/** A Jakarta wall-clock time as the instant it is (UTC+7, no DST). */
const wib = (local: string) => new Date(`${local}+07:00`);

/**
 * **What a campaign is read over** (P18.5-T8 AC-2; D-windows): whole office months for a file metric, a calendar
 * year keyed by the year, the last twelve months held — every edge a Jakarta day, pinned at 23:59 and 00:01.
 */
describe('campaign windows (P18.5-T8 AC-2, D-windows)', () => {
  describe('month arithmetic', () => {
    it('P18.5-T8 AC-2 adds months across a year, both ways', () => {
      expect(addMonths('2026-11', 2)).toBe('2027-01');
      expect(addMonths('2026-01', -1)).toBe('2025-12');
      expect(addMonths('2026-09', -11)).toBe('2025-10');
      expect(monthsFrom('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
      expect(monthsFrom('2026-09', '2026-08')).toEqual([]);
    });

    it('P18.5-T8 AC-2 writes ranges as the dialog and the card do', () => {
      expect(monthRangeWords('2026-07', '2026-09')).toBe('Jul – Sep 2026');
      expect(monthRangeWords('2026-11', '2027-01')).toBe('Nov 2026 – Jan 2027');
      expect(monthRangeWords('2026-09', '2026-09')).toBe('Sep 2026');
      expect(dayRangeWords('2026-07-01', '2026-09-30')).toBe('Jul 1 – Sep 30, 2026');
      expect(dayRangeWords('2026-11-01', '2027-01-31')).toBe('Nov 1, 2026 – Jan 31, 2027');
    });
  });

  describe('the edges, in Jakarta (invariant §9)', () => {
    const startsAt = wib('2026-07-01T00:00:00');
    const endsAt = wib('2026-09-30T23:59:00');

    it('P18.5-T8 AC-2 is running at 23:59 on its last day and ended at 00:01 the day after', () => {
      expect(campaignPhase(startsAt, endsAt, wib('2026-09-30T23:59:00'))).toBe('running');
      expect(campaignPhase(startsAt, endsAt, wib('2026-10-01T00:01:00'))).toBe('ended');
    });

    it('P18.5-T8 review item 8 runs to its last second: 23:59:59.999 is running, midnight after it ended', () => {
      const last = wib('2026-09-30T23:59:59.999');
      expect(campaignPhase(startsAt, last, wib('2026-09-30T23:59:59.500'))).toBe('running');
      expect(campaignPhase(startsAt, last, wib('2026-10-01T00:00:00'))).toBe('ended');
      // An end typed to the minute, or as the next midnight, is stored as that last instant; any other end as given.
      expect(inclusiveEnd(wib('2026-09-30T23:59:00'), JKT)).toEqual(last);
      expect(inclusiveEnd(wib('2026-10-01T00:00:00'), JKT)).toEqual(last);
      expect(inclusiveEnd(wib('2026-09-30T18:00:00'), JKT)).toEqual(wib('2026-09-30T18:00:00'));
    });

    it('P18.5-T8 AC-2 is upcoming at 23:59 the night before and running at 00:01 on its first day', () => {
      expect(campaignPhase(startsAt, endsAt, wib('2026-06-30T23:59:00'))).toBe('upcoming');
      expect(campaignPhase(startsAt, endsAt, wib('2026-07-01T00:01:00'))).toBe('running');
    });

    it('P18.5-T8 AC-2 runs on, with no end, once begun: a structural campaign', () => {
      expect(campaignPhase(startsAt, null, wib('2030-01-01T00:00:00'))).toBe('running');
    });

    it('P18.5-T8 AC-2 reads the last day as Jakarta’s, whatever the UTC date — and midnight as the day before', () => {
      // 23:59 WIB on the 30th is 16:59 UTC on the 30th; 00:00 WIB on the 1st is 17:00 UTC on the 30th.
      expect(lastLocalDay(wib('2026-09-30T23:59:00'), JKT)).toBe('2026-09-30');
      expect(lastLocalDay(wib('2026-10-01T00:00:00'), JKT)).toBe('2026-09-30');
      expect(lastLocalDay(wib('2026-10-01T00:01:00'), JKT)).toBe('2026-10-01');
    });
  });

  describe('whole office months', () => {
    it('P18.5-T8 AC-2 accepts 00:00 on a 1st to 23:59, or midnight after, on a month’s last day', () => {
      expect(isWholeMonths(wib('2026-07-01T00:00:00'), wib('2026-09-30T23:59:00'), JKT)).toBe(true);
      expect(isWholeMonths(wib('2026-07-01T00:00:00'), wib('2026-09-30T23:59:59.999'), JKT)).toBe(true);
      expect(isWholeMonths(wib('2026-07-01T00:00:00'), wib('2026-10-01T00:00:00'), JKT)).toBe(true);
      // February's end, in a leap year and not.
      expect(isWholeMonths(wib('2028-02-01T00:00:00'), wib('2028-02-29T23:59:00'), JKT)).toBe(true);
      expect(isWholeMonths(wib('2027-02-01T00:00:00'), wib('2027-02-28T23:59:00'), JKT)).toBe(true);
    });

    it('P18.5-T8 AC-2 refuses mid-month, a start after midnight, an end before 23:59, and no end', () => {
      // *KPM New Hire Blitz*, Aug 15 – Sep 15 (`Overall.html:7941`).
      expect(isWholeMonths(wib('2026-08-15T00:00:00'), wib('2026-09-15T23:59:00'), JKT)).toBe(false);
      expect(isWholeMonths(wib('2026-07-01T00:01:00'), wib('2026-09-30T23:59:00'), JKT)).toBe(false);
      expect(isWholeMonths(wib('2026-07-01T00:00:00'), wib('2026-09-30T23:58:00'), JKT)).toBe(false);
      expect(isWholeMonths(wib('2026-07-01T00:00:00'), wib('2026-09-29T23:59:00'), JKT)).toBe(false);
      // 00:00 UTC on the 1st is 07:00 in Jakarta: a server-clock month is not the office's.
      expect(isWholeMonths(new Date('2026-07-01T00:00:00Z'), wib('2026-09-30T23:59:00'), JKT)).toBe(false);
      expect(isWholeMonths(wib('2026-07-01T00:00:00'), null, JKT)).toBe(false);
    });
  });

  describe('resolving a window as of the office’s day', () => {
    const office = (today: string, latestHeldMonth: string | null = null) => ({ today, timezone: JKT, latestHeldMonth });

    it('P18.5-T8 AC-2 reads a seasonal campaign’s own months, keyed by them, its days up to today', () => {
      const w = resolveWindow(
        { window: 'campaign_dates', startsAt: wib('2026-07-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00') },
        office('2026-08-20'),
      );
      expect(w).toEqual({
        key: '2026-07..2026-09', months: ['2026-07', '2026-08', '2026-09'],
        days: { from: '2026-07-01', to: '2026-08-20' }, lastDay: '2026-09-30', label: 'Jul – Sep 2026', finalisable: true,
      });
    });

    it('P18.5-T8 AC-2 keys a window of activity alone by its days, and reads no day before it begins', () => {
      const dates = { window: 'campaign_dates' as const, startsAt: wib('2026-08-15T00:00:00'), endsAt: wib('2026-09-15T23:59:00') };
      expect(resolveWindow(dates, office('2026-10-10'))).toMatchObject({
        key: '2026-08-15..2026-09-15', days: { from: '2026-08-15', to: '2026-09-15' }, label: 'Aug 15 – Sep 15, 2026',
      });
      expect(resolveWindow(dates, office('2026-08-14')).days).toBeNull();
    });

    it('P18.5-T8 AC-2 keys a calendar year by the year: January to December, the year to date', () => {
      const mdrt = { window: 'calendar_year' as const, startsAt: wib('2025-01-01T00:00:00'), endsAt: null };
      expect(resolveWindow(mdrt, office('2026-10-10'))).toEqual({
        key: '2026', months: monthsFrom('2026-01', '2026-12'), days: { from: '2026-01-01', to: '2026-10-10' },
        lastDay: '2026-12-31', label: 'Jan – Dec 2026', finalisable: true,
      });
      // The year before, as frozen in the January after.
      expect(resolveWindow(mdrt, office('2027-01-20'), '2026')).toMatchObject({
        key: '2026', lastDay: '2026-12-31', days: { from: '2026-01-01', to: '2026-12-31' },
      });
      // At 23:59 on 31 December it is still this year's; at 00:01 on 1 January, the next.
      expect(resolveWindow(mdrt, office('2026-12-31')).key).toBe('2026');
      expect(resolveWindow(mdrt, office('2027-01-01')).key).toBe('2027');
    });

    it('P18.5-T8 AC-2 reads the last twelve months held, never final; with nothing held, the twelve to last month', () => {
      const promotion = { window: 'rolling_12m' as const, startsAt: wib('2025-01-01T00:00:00'), endsAt: null };
      // P18.5-T8 review item 5: its days are its months' — October 2025 to the end of September — not to today.
      expect(resolveWindow(promotion, office('2026-10-10', '2026-09'))).toMatchObject({
        key: 'rolling', months: monthsFrom('2025-10', '2026-09'), label: 'Oct 2025 – Sep 2026', finalisable: false,
        days: { from: '2025-10-01', to: '2026-09-30' }, lastDay: '2026-09-30',
      });
      expect(resolveWindow(promotion, office('2026-10-10', '2026-07')).months[11]).toBe('2026-07');
      expect(resolveWindow(promotion, office('2026-10-10', null)).months).toEqual(monthsFrom('2025-10', '2026-09'));
      // A month held beyond today's is not the anchor.
      expect(resolveWindow(promotion, office('2026-10-10', '2026-12')).months[11]).toBe('2026-09');
    });
  });

  describe('the card’s duration', () => {
    it('P18.5-T7 AC-3 composes a seasonal campaign’s dates in Jakarta, and a structural window’s words verbatim', () => {
      expect(durationWords({ window: 'campaign_dates', startsAt: wib('2026-07-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00') }, JKT))
        .toBe('Jul 1 – Sep 30, 2026');
      expect(durationWords({ window: 'calendar_year', startsAt: wib('2026-01-01T00:00:00'), endsAt: null }, JKT))
        .toBe('Standing — evaluated per calendar year (Jan 1 – Dec 31)');
      expect(durationWords({ window: 'rolling_12m', startsAt: wib('2026-01-01T00:00:00'), endsAt: null }, JKT))
        .toBe('Rolling 12-month window');
      expect(durationWords({ window: 'campaign_dates', startsAt: wib('2026-07-01T00:00:00'), endsAt: null }, JKT)).toBe('From Jul 1');
    });
  });
});
