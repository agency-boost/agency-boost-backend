import { DEFAULT_LANGUAGE, DEFAULT_TENANT_TIMEZONE, LANGUAGES, MINOR_UNITS_PER_MAJOR } from '@/domain/constants';
import {
  formatDate, formatDateRange, formatDateTime, formatDateWithWeekday, formatDayMonth, formatInstantDate, formatMonth,
  formatMonthName, formatMonthRange, formatNumber, formatPercent, formatRupiah, formatRupiahCompact, formatTime,
} from './format';

const JAKARTA = 'Asia/Jakarta';
/** Whole rupiah as the minor units every sum arrives in. */
const rp = (rupiah: number) => rupiah * MINOR_UNITS_PER_MAJOR;

/**
 * **One way of writing a date, a sum and a percentage** (ADR-0167 §1, OD-196; P18.7-T1 AC-4; ADR-0174, P18.9-T3).
 * Every rule and every threshold is pinned here, and the same cases are pinned in `frontend/src/lib/format.spec.ts`:
 * a sentence the API composes sits beside a label the screen composes, and the two must read the same.
 */
describe('the shared formatters (ADR-0167 §1, P18.7-T1 AC-4)', () => {
  describe('office calendar days and months', () => {
    it('writes a day the Indonesian way, the day unpadded', () => {
      expect(formatDate('2026-10-26')).toBe('26 Okt 2026');
      expect(formatDate('2026-10-07')).toBe('7 Okt 2026');
      expect(formatDate('2026-01-01')).toBe('1 Jan 2026');
    });

    it('names all twelve months by their Indonesian abbreviations', () => {
      const months = Array.from({ length: 12 }, (_, i) => formatMonthName(`2026-${String(i + 1).padStart(2, '0')}`));
      expect(months).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']);
    });

    it('puts the weekday first, in full, for every day of a week', () => {
      expect(formatDateWithWeekday('2026-10-26')).toBe('Senin, 26 Okt 2026');
      const week = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']
        .map((day) => formatDateWithWeekday(day).split(',')[0]);
      expect(week).toEqual(['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']);
    });

    it('writes a month, a month alone and a day without its year', () => {
      expect(formatMonth('2026-10')).toBe('Okt 2026');
      expect(formatMonthName('2026-08')).toBe('Agu');
      expect(formatDayMonth('2026-10-26')).toBe('26 Okt');
    });

    it('builds a day from its numbers, never as an instant: the 1st stays the 1st', () => {
      // `new Date('2026-10-01')` is midnight UTC, the 30th anywhere west of Greenwich. Nothing here reads a zone.
      expect(formatDate('2026-10-01')).toBe('1 Okt 2026');
      expect(formatDateWithWeekday('2026-10-01')).toBe('Kamis, 1 Okt 2026');
    });

    it('keeps a year below 100 as written, rather than reading it as 19xx', () => {
      expect(formatDate('0099-03-01')).toBe('1 Mar 0099');
      expect(formatDateWithWeekday('2000-01-01')).toBe('Sabtu, 1 Jan 2000');
    });

    it('returns what is not a day or a month as given, so a sentence that echoes it stays true', () => {
      expect(formatDate('2026-02-30')).toBe('2026-02-30');
      expect(formatDate('26/10/2026')).toBe('26/10/2026');
      expect(formatDateWithWeekday('nope')).toBe('nope');
      expect(formatDayMonth('2026-13-01')).toBe('2026-13-01');
      expect(formatMonth('2026-13')).toBe('2026-13');
      expect(formatMonth('Oct 2026')).toBe('Oct 2026');
      expect(formatMonthName('2026-00')).toBe('2026-00');
      expect(formatMonthRange('2026-07', 'later')).toBe('Jul 2026 – later');
      expect(formatDateRange('2026-09-28', 'later')).toBe('28 Sep 2026 – later');
    });
  });

  describe('ranges, an en dash with a space either side', () => {
    it('writes the year once in one year, and each year across two', () => {
      expect(formatDateRange('2026-09-28', '2026-10-04')).toBe('28 Sep – 4 Okt 2026');
      expect(formatDateRange('2026-12-28', '2027-01-03')).toBe('28 Des 2026 – 3 Jan 2027');
      expect(formatDateRange('2026-10-01', '2026-10-07')).toBe('1 Okt – 7 Okt 2026');
    });

    it('writes a range of one day as that day', () => {
      expect(formatDateRange('2026-10-04', '2026-10-04')).toBe('4 Okt 2026');
    });

    it('writes month ranges the same way, and one month as that month', () => {
      expect(formatMonthRange('2026-07', '2026-09')).toBe('Jul – Sep 2026');
      expect(formatMonthRange('2026-11', '2027-01')).toBe('Nov 2026 – Jan 2027');
      expect(formatMonthRange('2026-09', '2026-09')).toBe('Sep 2026');
    });
  });

  describe('instants, on the office’s clock (invariant §9)', () => {
    const instant = new Date('2026-09-30T18:05:00Z');

    it('places an instant in the tenant’s timezone, never the server’s: 18:05 UTC on the 30th is 01:05 on the 1st', () => {
      expect(formatDateTime(instant, JAKARTA)).toBe('1 Okt 2026, 01.05');
      expect(formatInstantDate(instant, JAKARTA)).toBe('1 Okt 2026');
      expect(formatTime(instant, JAKARTA)).toBe('01.05');
      // The same instant in UTC, to show the zone is the argument's and nothing else's.
      expect(formatDateTime(instant, 'UTC')).toBe('30 Sep 2026, 18.05');
    });

    it('reads v1’s one office zone from the constant it is registered as (ADR-0016)', () => {
      expect(formatDateTime(instant, DEFAULT_TENANT_TIMEZONE)).toBe('1 Okt 2026, 01.05');
    });

    it('writes a time in 24 hours, both parts two digits, a dot between', () => {
      expect(formatTime(new Date('2026-10-26T06:05:00Z'), JAKARTA)).toBe('13.05');
      expect(formatTime(new Date('2026-10-25T17:00:00Z'), JAKARTA)).toBe('00.00');
      expect(formatTime(new Date('2026-10-26T16:59:00Z'), JAKARTA)).toBe('23.59');
      expect(formatDateTime(new Date('2026-10-26T06:05:00Z'), JAKARTA)).toBe('26 Okt 2026, 13.05');
    });

    it('takes an ISO instant as a string too', () => {
      expect(formatDateTime('2026-09-30T18:05:00.000Z', JAKARTA)).toBe('1 Okt 2026, 01.05');
    });

    it('writes nothing for an instant or a zone that is not one', () => {
      expect(formatDateTime(new Date(Number.NaN), JAKARTA)).toBe('');
      expect(formatInstantDate('not a time', JAKARTA)).toBe('');
      expect(formatTime(instant, 'Not/AZone')).toBe('');
    });
  });

  describe('rupiah in full', () => {
    it('groups whole rupiah with a dot every three digits', () => {
      expect(formatRupiah(rp(500_000_000))).toBe('Rp 500.000.000');
      expect(formatRupiah(rp(1_000))).toBe('Rp 1.000');
      expect(formatRupiah(rp(999))).toBe('Rp 999');
      expect(formatRupiah(0)).toBe('Rp 0');
    });

    it('rounds sen half up to whole rupiah', () => {
      expect(formatRupiah(149)).toBe('Rp 1');
      expect(formatRupiah(150)).toBe('Rp 2');
      expect(formatRupiah(49)).toBe('Rp 0');
    });

    it('writes a negative with an ASCII hyphen before Rp, and a sum that rounds to nothing without one', () => {
      expect(formatRupiah(rp(-500_000))).toBe('-Rp 500.000');
      expect(formatRupiah(-49)).toBe('Rp 0');
    });

    it('holds a sum near the safe-integer edge exactly', () => {
      expect(formatRupiah(9_007_199_254_740_900)).toBe('Rp 90.071.992.547.409');
    });

    it('writes nothing for a sum that is not a number', () => {
      expect(formatRupiah(Number.NaN)).toBe('');
      expect(formatRupiah(Number.POSITIVE_INFINITY)).toBe('');
    });
  });

  describe('rupiah compact', () => {
    it.each([
      [999_949_999_999, 'Rp 999,9 M'],
      [1_000_000_000_000, 'Rp 1.000 M'],
      [2_345_600_000_000, 'Rp 2.345,6 M'],
      [5_672_500_000, 'Rp 5,7 M'],
      [150_000_000, 'Rp 150 jt'],
    ])('P18.9-T3 AC-3 Rp %d is %s — miliar past a thousand of them, no triliun', (rupiah, compact) => {
      expect(formatRupiahCompact(rp(rupiah))).toBe(compact);
    });

    it.each([
      [0, 'Rp 0'],
      [999, 'Rp 999'],
      [1_000, 'Rp 1 rb'],
      [750_000, 'Rp 750 rb'],
      [999_999, 'Rp 1 jt'],
      [999_950, 'Rp 1 jt'],
      [1_000_000, 'Rp 1 jt'],
      [500_000_000, 'Rp 500 jt'],
      [357_500_000, 'Rp 357,5 jt'],
      [712_666_667, 'Rp 712,7 jt'],
      [999_950_000, 'Rp 1 M'],
      [1_000_000_000, 'Rp 1 M'],
      [1_200_000_000, 'Rp 1,2 M'],
      [2_400_000_000, 'Rp 2,4 M'],
      [1_500_000_000_000, 'Rp 1.500 M'],
    ])('Rp %d is %s', (rupiah, compact) => {
      expect(formatRupiahCompact(rp(rupiah))).toBe(compact);
    });

    it('rounds the shown tenth half up in integers — 1.150 is Rp 1,2 rb, where a float’s 1,15 rounds down', () => {
      expect(formatRupiahCompact(rp(1_150))).toBe('Rp 1,2 rb');
      expect(formatRupiahCompact(rp(1_149))).toBe('Rp 1,1 rb');
      expect(formatRupiahCompact(rp(1_050))).toBe('Rp 1,1 rb');
      expect(formatRupiahCompact(rp(1_049))).toBe('Rp 1 rb');
    });

    it('drops a trailing ,0', () => {
      expect(formatRupiahCompact(rp(2_000_000))).toBe('Rp 2 jt');
      expect(formatRupiahCompact(rp(2_040_000))).toBe('Rp 2 jt');
    });

    it('moves up a unit only where the rounding reaches a thousand of it', () => {
      expect(formatRupiahCompact(rp(999_949))).toBe('Rp 999,9 rb');
      expect(formatRupiahCompact(rp(999_949_999))).toBe('Rp 999,9 jt');
    });

    it('writes a negative with the hyphen before Rp, in every unit', () => {
      expect(formatRupiahCompact(rp(-750_000))).toBe('-Rp 750 rb');
      expect(formatRupiahCompact(rp(-1_200_000_000))).toBe('-Rp 1,2 M');
      expect(formatRupiahCompact(rp(-999))).toBe('-Rp 999');
    });

    it('rounds sen to whole rupiah before choosing a unit', () => {
      expect(formatRupiahCompact(rp(999) + 50)).toBe('Rp 1 rb');
      expect(formatRupiahCompact(rp(999) + 49)).toBe('Rp 999');
    });

    it('lossless: the full sum where the compact one would round, the compact where it is exact', () => {
      expect(formatRupiahCompact(rp(1_150), { lossless: true })).toBe('Rp 1.150');
      expect(formatRupiahCompact(rp(1_250_000_000), { lossless: true })).toBe('Rp 1.250.000.000');
      expect(formatRupiahCompact(rp(999_950_000), { lossless: true })).toBe('Rp 999.950.000');
      expect(formatRupiahCompact(rp(-712_666_667), { lossless: true })).toBe('-Rp 712.666.667');
      expect(formatRupiahCompact(rp(200_000_000), { lossless: true })).toBe('Rp 200 jt');
      expect(formatRupiahCompact(rp(2_400_000_000), { lossless: true })).toBe('Rp 2,4 M');
      expect(formatRupiahCompact(rp(357_500_000), { lossless: true })).toBe('Rp 357,5 jt');
      expect(formatRupiahCompact(rp(999), { lossless: true })).toBe('Rp 999');
    });

    it('writes nothing for a sum that is not a number', () => {
      expect(formatRupiahCompact(Number.NaN)).toBe('');
    });
  });

  describe('numbers and percentages', () => {
    it('groups thousands with a dot and writes a decimal after a comma', () => {
      expect(formatNumber(1_250)).toBe('1.250');
      expect(formatNumber(2.13)).toBe('2,13');
      expect(formatNumber(1_234_567.5)).toBe('1.234.567,5');
      expect(formatNumber(0)).toBe('0');
      expect(formatNumber(-1_250)).toBe('-1.250');
    });

    it('rounds half up, away from zero, to the places asked for, and always shows them', () => {
      expect(formatNumber(2.125, 2)).toBe('2,13');
      expect(formatNumber(1.005, 2)).toBe('1,01');
      expect(formatNumber(1.4, 1)).toBe('1,4');
      expect(formatNumber(1, 1)).toBe('1,0');
      expect(formatNumber(9.96, 1)).toBe('10,0');
      expect(formatNumber(1_249.5, 0)).toBe('1.250');
      expect(formatNumber(-2.125, 2)).toBe('-2,13');
      expect(formatNumber(-0.04, 1)).toBe('0,0');
    });

    it('writes a number JavaScript prints in exponent form in plain digits', () => {
      expect(formatNumber(1e-7)).toBe('0,0000001');
      expect(formatNumber(1e21)).toBe('1.000.000.000.000.000.000.000');
      expect(formatNumber(1.5e-7, 7)).toBe('0,0000002');
    });

    it.each([
      [0, '0%'],
      [0.04, '0%'],
      [0.05, '0%'],
      [0.4, '0%'],
      [0.5, '1%'],
      [15, '15%'],
      [57.4, '57%'],
      [57.5, '58%'],
      [96.4, '96%'],
      [99.4, '99%'],
      [99.5, '100%'],
      [100, '100%'],
      [1_250, '1.250%'],
    ])('P18.9-T3 AC-1 writes %d%% whole, rounded half up, with no ,0: %s', (pct, text) => {
      expect(formatPercent(pct)).toBe(text);
    });

    it('P18.9-T3 AC-1 writes a negative change whole, half up away from zero, and one that rounds to nothing unsigned', () => {
      expect(formatPercent(-12)).toBe('-12%');
      expect(formatPercent(-12.5)).toBe('-13%');
      expect(formatPercent(-3.45)).toBe('-3%');
      expect(formatPercent(-0.4)).toBe('0%');
    });

    it('P18.9-T3 AC-1 rounds on the digits as written, so a tie is never lost to binary arithmetic', () => {
      // 57.5 and 12.5 are ties: half up, in decimal digits — never the 57 a float's 57.4999… would give.
      expect(formatPercent(57.5)).toBe('58%');
      expect(formatPercent(12.25)).toBe('12%');
      expect(formatPercent(50.45)).toBe('50%');
    });

    it('P18.9-T3 AC-2 lossless: a threshold keeps every decimal it was set with, and none it was not', () => {
      expect(formatPercent(75.55, { lossless: true })).toBe('75,55%');
      expect(formatPercent(75.5, { lossless: true })).toBe('75,5%');
      expect(formatPercent(75, { lossless: true })).toBe('75%');
      expect(formatPercent(7.25, { lossless: true })).toBe('7,25%');
      expect(formatPercent(0, { lossless: true })).toBe('0%');
      // Without it, the same figure is a share: whole.
      expect(formatPercent(75.55)).toBe('76%');
    });

    it('writes nothing for a number that is not one', () => {
      expect(formatNumber(Number.NaN)).toBe('');
      expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('');
    });
  });
});

/**
 * **P18.10-T3: the same formatters in each language** (ADR-0174 §6, ADR-0179 §6; the approved glossary's §E, OD-237).
 * Every Indonesian case above is unchanged, and passes no language: a caller that passes none writes Indonesian until
 * P18.10-T5 passes the request's. Each shape below is pinned in English at every threshold the Indonesian ones are —
 * the thresholds unchanged — and the same cases are pinned in `frontend/src/lib/format.spec.ts`.
 */
describe('P18.10-T3 the shared formatters in each language', () => {
  describe('AC-1 a caller that passes no language writes Indonesian, the default', () => {
    it('P18.10-T3 AC-1 the default is the product’s, Indonesian, and an explicit id writes what no language writes', () => {
      expect(DEFAULT_LANGUAGE).toBe('id');
      expect(LANGUAGES).toEqual(['id', 'en']);
      const instant = new Date('2026-10-26T06:05:00Z');
      expect(formatDate('2026-10-26', 'id')).toBe(formatDate('2026-10-26'));
      expect(formatDateWithWeekday('2026-10-26', 'id')).toBe('Senin, 26 Okt 2026');
      expect(formatDayMonth('2026-10-26', 'id')).toBe('26 Okt');
      expect(formatMonth('2026-10', 'id')).toBe('Okt 2026');
      expect(formatMonthName('2026-08', 'id')).toBe('Agu');
      expect(formatDateRange('2026-09-28', '2026-10-04', 'id')).toBe('28 Sep – 4 Okt 2026');
      expect(formatMonthRange('2026-11', '2027-01', 'id')).toBe('Nov 2026 – Jan 2027');
      expect(formatDateTime(instant, JAKARTA, 'id')).toBe('26 Okt 2026, 13.05');
      expect(formatInstantDate(instant, JAKARTA, 'id')).toBe('26 Okt 2026');
      expect(formatTime(instant, JAKARTA, 'id')).toBe('13.05');
      expect(formatNumber(1_234.5, undefined, 'id')).toBe('1.234,5');
      expect(formatPercent(96.4, {}, 'id')).toBe('96%');
      expect(formatRupiah(rp(45_000_000), 'id')).toBe('Rp 45.000.000');
      expect(formatRupiahCompact(rp(5_800_000_000), {}, 'id')).toBe('Rp 5,8 M');
    });
  });

  describe('AC-1 English dates (§E)', () => {
    it('P18.10-T3 AC-1 writes a day 26 Oct 2026, the day unpadded, and every month by its English abbreviation', () => {
      expect(formatDate('2026-10-26', 'en')).toBe('26 Oct 2026');
      expect(formatDate('2026-10-07', 'en')).toBe('7 Oct 2026');
      const months = Array.from({ length: 12 }, (_, i) => formatMonthName(`2026-${String(i + 1).padStart(2, '0')}`, 'en'));
      expect(months).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    });

    it('P18.10-T3 AC-1 puts the English weekday first, in full: Monday, 26 Oct 2026', () => {
      expect(formatDateWithWeekday('2026-10-26', 'en')).toBe('Monday, 26 Oct 2026');
      const week = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']
        .map((day) => formatDateWithWeekday(day, 'en').split(',')[0]);
      expect(week).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
      expect(formatDateWithWeekday('2000-01-01', 'en')).toBe('Saturday, 1 Jan 2000');
    });

    it('P18.10-T3 AC-1 writes a month Oct 2026, a month alone Oct, and a day without its year 26 Oct', () => {
      expect(formatMonth('2026-10', 'en')).toBe('Oct 2026');
      expect(formatMonthName('2026-05', 'en')).toBe('May');
      expect(formatDayMonth('2026-12-26', 'en')).toBe('26 Dec');
    });

    it('P18.10-T3 AC-5 writes a week 28 Sep – 4 Oct 2026, and one across a year with both years', () => {
      expect(formatDateRange('2026-09-28', '2026-10-04', 'en')).toBe('28 Sep – 4 Oct 2026');
      expect(formatDateRange('2026-12-28', '2027-01-03', 'en')).toBe('28 Dec 2026 – 3 Jan 2027');
      expect(formatDateRange('2026-10-04', '2026-10-04', 'en')).toBe('4 Oct 2026');
      expect(formatMonthRange('2026-07', '2026-09', 'en')).toBe('Jul – Sep 2026');
      expect(formatMonthRange('2026-11', '2027-01', 'en')).toBe('Nov 2026 – Jan 2027');
      expect(formatMonthRange('2026-08', '2026-08', 'en')).toBe('Aug 2026');
    });

    it('P18.10-T3 AC-1 returns what is not a day or a month as given, in English too', () => {
      expect(formatDate('2026-02-30', 'en')).toBe('2026-02-30');
      expect(formatDateWithWeekday('nope', 'en')).toBe('nope');
      expect(formatDayMonth('2026-13-01', 'en')).toBe('2026-13-01');
      expect(formatMonthName('2026-00', 'en')).toBe('2026-00');
      expect(formatMonthRange('2026-07', 'later', 'en')).toBe('Jul 2026 – later');
      expect(formatDateRange('2026-09-28', 'later', 'en')).toBe('28 Sep 2026 – later');
    });

    it('P18.10-T3 AC-1 writes an instant 26 Oct 2026, 13:05 — 24-hour, a colon — on the office’s clock (invariant §9)', () => {
      const instant = new Date('2026-09-30T18:05:00Z');
      expect(formatDateTime(instant, JAKARTA, 'en')).toBe('1 Oct 2026, 01:05');
      expect(formatInstantDate(instant, JAKARTA, 'en')).toBe('1 Oct 2026');
      expect(formatTime(instant, JAKARTA, 'en')).toBe('01:05');
      expect(formatDateTime(instant, 'UTC', 'en')).toBe('30 Sep 2026, 18:05');
      expect(formatTime(new Date('2026-10-26T06:05:00Z'), JAKARTA, 'en')).toBe('13:05');
      expect(formatTime(new Date('2026-10-25T17:00:00Z'), JAKARTA, 'en')).toBe('00:00');
      expect(formatTime(new Date('2026-10-26T16:59:00Z'), JAKARTA, 'en')).toBe('23:59');
      expect(formatDateTime('2026-10-26T06:05:00.000Z', DEFAULT_TENANT_TIMEZONE, 'en')).toBe('26 Oct 2026, 13:05');
      expect(formatDateTime(new Date(Number.NaN), JAKARTA, 'en')).toBe('');
    });
  });

  describe('AC-1 English numbers and percentages (§E, UI-012)', () => {
    it('P18.10-T3 AC-1 groups thousands with a comma and writes a decimal after a point: 1,250 and 17.6', () => {
      expect(formatNumber(1_250, undefined, 'en')).toBe('1,250');
      expect(formatNumber(17.6, undefined, 'en')).toBe('17.6');
      expect(formatNumber(2.13, undefined, 'en')).toBe('2.13');
      expect(formatNumber(1_234_567.5, undefined, 'en')).toBe('1,234,567.5');
      expect(formatNumber(0, undefined, 'en')).toBe('0');
      expect(formatNumber(-1_250, undefined, 'en')).toBe('-1,250');
    });

    it('P18.10-T3 AC-1 rounds half up to the places asked for exactly as Indonesian does', () => {
      expect(formatNumber(2.125, 2, 'en')).toBe('2.13');
      expect(formatNumber(1.005, 2, 'en')).toBe('1.01');
      expect(formatNumber(1, 1, 'en')).toBe('1.0');
      expect(formatNumber(9.96, 1, 'en')).toBe('10.0');
      expect(formatNumber(1_249.5, 0, 'en')).toBe('1,250');
      expect(formatNumber(-2.125, 2, 'en')).toBe('-2.13');
      expect(formatNumber(-0.04, 1, 'en')).toBe('0.0');
      expect(formatNumber(1e-7, undefined, 'en')).toBe('0.0000001');
      expect(formatNumber(1e21, undefined, 'en')).toBe('1,000,000,000,000,000,000,000');
      expect(formatNumber(Number.NaN, undefined, 'en')).toBe('');
    });

    it.each([
      [0, '0%'],
      [0.04, '0%'],
      [0.5, '1%'],
      [15, '15%'],
      [57.4, '57%'],
      [57.5, '58%'],
      [96.4, '96%'],
      [99.5, '100%'],
      [100, '100%'],
      [-12.5, '-13%'],
      [-0.4, '0%'],
      [1_250, '1,250%'],
    ])('P18.10-T3 AC-1 writes %d%% whole in English, at the same thresholds: %s', (pct, text) => {
      expect(formatPercent(pct, {}, 'en')).toBe(text);
    });

    it('P18.10-T3 AC-1 lossless keeps a threshold’s places with a point: 75.55%, 7.25%, 75%', () => {
      expect(formatPercent(75.55, { lossless: true }, 'en')).toBe('75.55%');
      expect(formatPercent(75.5, { lossless: true }, 'en')).toBe('75.5%');
      expect(formatPercent(75, { lossless: true }, 'en')).toBe('75%');
      expect(formatPercent(7.25, { lossless: true }, 'en')).toBe('7.25%');
      expect(formatPercent(Number.POSITIVE_INFINITY, {}, 'en')).toBe('');
    });
  });

  describe('AC-1 English money (§E, UI-019)', () => {
    it('P18.10-T3 AC-1 writes a sum in full as IDR 45,000,000, a negative’s hyphen before IDR', () => {
      expect(formatRupiah(rp(45_000_000), 'en')).toBe('IDR 45,000,000');
      expect(formatRupiah(rp(500_000_000), 'en')).toBe('IDR 500,000,000');
      expect(formatRupiah(rp(999), 'en')).toBe('IDR 999');
      expect(formatRupiah(0, 'en')).toBe('IDR 0');
      expect(formatRupiah(rp(-500_000), 'en')).toBe('-IDR 500,000');
      expect(formatRupiah(-49, 'en')).toBe('IDR 0');
      expect(formatRupiah(9_007_199_254_740_900, 'en')).toBe('IDR 90,071,992,547,409');
      expect(formatRupiah(Number.NaN, 'en')).toBe('');
    });

    it.each([
      [0, 'Rp 0', 'IDR 0'],
      [999, 'Rp 999', 'IDR 999'],
      [1_000, 'Rp 1 rb', 'IDR 1K'],
      [750_000, 'Rp 750 rb', 'IDR 750K'],
      [999_949, 'Rp 999,9 rb', 'IDR 999.9K'],
      [999_950, 'Rp 1 jt', 'IDR 1M'],
      [999_999, 'Rp 1 jt', 'IDR 1M'],
      [1_000_000, 'Rp 1 jt', 'IDR 1M'],
      [150_000_000, 'Rp 150 jt', 'IDR 150M'],
      [357_500_000, 'Rp 357,5 jt', 'IDR 357.5M'],
      [712_666_667, 'Rp 712,7 jt', 'IDR 712.7M'],
      [999_949_999, 'Rp 999,9 jt', 'IDR 999.9M'],
      [999_950_000, 'Rp 1 M', 'IDR 1B'],
      [1_000_000_000, 'Rp 1 M', 'IDR 1B'],
      [1_200_000_000, 'Rp 1,2 M', 'IDR 1.2B'],
      [5_672_500_000, 'Rp 5,7 M', 'IDR 5.7B'],
      [5_800_000_000, 'Rp 5,8 M', 'IDR 5.8B'],
      [999_949_999_999, 'Rp 999,9 M', 'IDR 999.9B'],
      [1_000_000_000_000, 'Rp 1.000 M', 'IDR 1,000B'],
      [1_500_000_000_000, 'Rp 1.500 M', 'IDR 1,500B'],
      [2_345_600_000_000, 'Rp 2.345,6 M', 'IDR 2,345.6B'],
    ])('P18.10-T3 AC-1 Rp %d compact is %s in Indonesian and %s in English, at the same thresholds', (rupiah, id, en) => {
      expect(formatRupiahCompact(rp(rupiah), {}, 'id')).toBe(id);
      expect(formatRupiahCompact(rp(rupiah), {}, 'en')).toBe(en);
    });

    it('P18.10-T3 AC-2 rounds the shown tenth half up in integers in English too — 1,150 is IDR 1.2K', () => {
      expect(formatRupiahCompact(rp(1_150), {}, 'en')).toBe('IDR 1.2K');
      expect(formatRupiahCompact(rp(1_149), {}, 'en')).toBe('IDR 1.1K');
      expect(formatRupiahCompact(rp(2_040_000), {}, 'en')).toBe('IDR 2M');
      expect(formatRupiahCompact(rp(999) + 50, {}, 'en')).toBe('IDR 1K');
    });

    it('P18.10-T3 AC-1 writes a negative with the hyphen before IDR, in every unit', () => {
      expect(formatRupiahCompact(rp(-750_000), {}, 'en')).toBe('-IDR 750K');
      expect(formatRupiahCompact(rp(-1_200_000_000), {}, 'en')).toBe('-IDR 1.2B');
      expect(formatRupiahCompact(rp(-999), {}, 'en')).toBe('-IDR 999');
    });

    it('P18.10-T3 AC-1 lossless in English: the full sum where the compact one would round', () => {
      expect(formatRupiahCompact(rp(1_150), { lossless: true }, 'en')).toBe('IDR 1,150');
      expect(formatRupiahCompact(rp(1_250_000_000), { lossless: true }, 'en')).toBe('IDR 1,250,000,000');
      expect(formatRupiahCompact(rp(-712_666_667), { lossless: true }, 'en')).toBe('-IDR 712,666,667');
      expect(formatRupiahCompact(rp(200_000_000), { lossless: true }, 'en')).toBe('IDR 200M');
      expect(formatRupiahCompact(rp(2_400_000_000), { lossless: true }, 'en')).toBe('IDR 2.4B');
      expect(formatRupiahCompact(rp(999), { lossless: true }, 'en')).toBe('IDR 999');
      expect(formatRupiahCompact(Number.NaN, {}, 'en')).toBe('');
    });
  });

  /**
   * **AC-2, one rounding** (ADR-0174 §1): the language changes the characters, never the figure. Over a sweep of
   * figures at and around every threshold, the English text read back into Indonesian's marks and units is the
   * Indonesian text, character for character — so no figure is rounded once per language.
   */
  describe('AC-2 one rounding: the language changes the characters, never the figure', () => {
    /** English's marks and units back into Indonesian's. */
    const asIndonesian = (en: string) => en
      .replace(/[.,]/g, (mark) => (mark === '.' ? ',' : '.'))
      .replace(/^(-?)IDR /, '$1Rp ')
      .replace(/(\d)(B|M|K)$/, (_, digit: string, unit: string) => `${digit} ${{ B: 'M', M: 'jt', K: 'rb' }[unit]}`);
    const sweep = [
      0, 1, 49, 50, 149, 150, 999, 1_000, 1_049, 1_050, 1_149, 1_150, 99_950, 999_949, 999_950, 1_000_000, 1_049_999,
      1_050_000, 2_345_678, 357_500_000, 712_666_667, 999_949_999, 999_950_000, 2_450_000_000, 5_672_500_000,
      999_949_999_999, 1_000_000_000_000, 2_345_600_000_000,
    ];

    it.each(sweep)('P18.10-T3 AC-2 Rp %d reads the same figure in both languages, compact and in full', (rupiah) => {
      for (const minor of [rp(rupiah), -rp(rupiah), rp(rupiah) + 49, rp(rupiah) + 50]) {
        expect(asIndonesian(formatRupiahCompact(minor, {}, 'en'))).toBe(formatRupiahCompact(minor));
        expect(asIndonesian(formatRupiahCompact(minor, { lossless: true }, 'en'))).toBe(formatRupiahCompact(minor, { lossless: true }));
        expect(asIndonesian(formatRupiah(minor, 'en'))).toBe(formatRupiah(minor));
      }
    });

    it.each([0, 0.04, 0.05, 0.5, 12.25, 12.5, 50.45, 57.5, 75.55, 96.43, 99.5, 999.95, 1_250, -3.45, -12.5])(
      'P18.10-T3 AC-2 %d reads the same figure in both languages, as a number and as a percentage',
      (value) => {
        for (const decimals of [undefined, 0, 1, 2]) {
          expect(asIndonesian(formatNumber(value, decimals, 'en'))).toBe(formatNumber(value, decimals));
        }
        expect(asIndonesian(formatPercent(value, {}, 'en'))).toBe(formatPercent(value));
        expect(asIndonesian(formatPercent(value, { lossless: true }, 'en'))).toBe(formatPercent(value, { lossless: true }));
      },
    );
  });
});
