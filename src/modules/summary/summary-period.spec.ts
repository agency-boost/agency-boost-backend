import { DomainException } from '@/common/errors/domain.exception';
import { summaryPeriod, type OfficeCalendar } from './summary-period';

/** 14 October 2026 in the office; it opened in March 2025. */
const OFFICE: OfficeCalendar = { today: '2026-10-14', month: '2026-10', firstMonth: '2025-03' };

/** The refusal a call makes, as the API sends it. */
function refusal(run: () => unknown) {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainException);
    const e = err as DomainException;
    return { status: e.getStatus(), code: e.code, message: e.message, details: e.details };
  }
  throw new Error('not refused');
}

/** The Summary's period (P18.8-T11, ADR-0161 §4): a month or a year to look back on, whole. */
describe('the Summary’s period (P18.8-T11)', () => {
  it('P18.8-T11 AC-1 asks for nothing: this month and this year, each to today, both current', () => {
    expect(summaryPeriod(OFFICE)).toEqual({
      month: '2026-10', year: '2026',
      monthWindow: { from: '2026-10-01', to: '2026-10-14' },
      yearWindow: { from: '2026-01-01', to: '2026-10-14' },
      currentMonth: true, currentYear: true,
    });
  });

  it('P18.8-T11 AC-1 this month asked by name is the same as asking for nothing', () => {
    expect(summaryPeriod(OFFICE, { month: '2026-10' })).toEqual(summaryPeriod(OFFICE));
    expect(summaryPeriod(OFFICE, { year: '2026' })).toEqual(summaryPeriod(OFFICE));
  });

  it('P18.8-T11 AC-1 an earlier month this year is read whole, to its last day; its year still runs to today', () => {
    expect(summaryPeriod(OFFICE, { month: '2026-02' })).toEqual({
      month: '2026-02', year: '2026',
      monthWindow: { from: '2026-02-01', to: '2026-02-28' },
      yearWindow: { from: '2026-01-01', to: '2026-10-14' },
      currentMonth: false, currentYear: true,
    });
  });

  it('P18.8-T11 AC-1 a month of a year that has ended is that month whole and that year whole', () => {
    expect(summaryPeriod(OFFICE, { month: '2025-03' })).toEqual({
      month: '2025-03', year: '2025',
      monthWindow: { from: '2025-03-01', to: '2025-03-31' },
      yearWindow: { from: '2025-01-01', to: '2025-12-31' },
      currentMonth: false, currentYear: false,
    });
  });

  it('P18.8-T11 AC-1 a year that has ended is that year whole, and its December', () => {
    expect(summaryPeriod(OFFICE, { year: '2025' })).toEqual({
      month: '2025-12', year: '2025',
      monthWindow: { from: '2025-12-01', to: '2025-12-31' },
      yearWindow: { from: '2025-01-01', to: '2025-12-31' },
      currentMonth: false, currentYear: false,
    });
  });

  it('P18.8-T11 AC-1 a February in a leap year ends on the 29th', () => {
    const office = { today: '2028-05-02', month: '2028-05', firstMonth: '2027-01' };
    expect(summaryPeriod(office, { month: '2028-02' }).monthWindow).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it.each([
    [{ month: '2026-11' }, 'month', 'Nov 2026 has not begun yet: the latest month is Okt 2026.'],
    [{ month: '2027-01' }, 'month', 'Jan 2027 has not begun yet: the latest month is Okt 2026.'],
    [{ year: '2027' }, 'year', '2027 has not begun yet: the latest year is 2026.'],
  ])('P18.8-T11 AC-1 refuses the future, %j', (asked, field, message) => {
    expect(refusal(() => summaryPeriod(OFFICE, asked))).toEqual({
      status: 400, code: 'VALIDATION_FAILED', message,
      details: field === 'year' ? { field, earliest: '2025', latest: '2026' } : { field, earliest: '2025-03', latest: '2026-10' },
    });
  });

  it.each([
    [{ month: '2025-02' }, 'month', 'Feb 2025 is before the first month there is, Mar 2025.'],
    [{ month: '2024-12' }, 'month', 'Des 2024 is before the first month there is, Mar 2025.'],
    [{ year: '2024' }, 'year', '2024 is before the first year there is, 2025.'],
  ])('P18.8-T11 AC-1 refuses anything before the office’s first month, %j', (asked, field, message) => {
    const answer = refusal(() => summaryPeriod(OFFICE, asked));
    expect(answer).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', message, details: { field } });
  });

  it('P18.8-T11 AC-1 the office’s first year may be asked for whole, its months before it opened included', () => {
    // Nothing is held before the office opened, so the year from 1 January says the same as from March.
    expect(summaryPeriod(OFFICE, { year: '2025' }).yearWindow.from).toBe('2025-01-01');
  });

  it('P18.8-T11 AC-1 refuses a month and a year together: one period at a time', () => {
    expect(refusal(() => summaryPeriod(OFFICE, { month: '2026-02', year: '2026' }))).toMatchObject({
      status: 400, code: 'VALIDATION_FAILED', message: 'Ask for a month or a year, not both.', details: { field: 'year' },
    });
  });

  it('P18.8-T11 AC-1 an office opened this month has only this month to read', () => {
    const office = { today: '2026-10-14', month: '2026-10', firstMonth: '2026-10' };
    expect(summaryPeriod(office).month).toBe('2026-10');
    expect(refusal(() => summaryPeriod(office, { month: '2026-09' }))).toMatchObject({ details: { field: 'month', earliest: '2026-10' } });
  });

  it('P18.8-T11 AC-1 a first month after this one is taken as this one', () => {
    const office = { today: '2026-10-14', month: '2026-10', firstMonth: '2026-12' };
    expect(summaryPeriod(office, { month: '2026-10' }).currentMonth).toBe(true);
    expect(refusal(() => summaryPeriod(office, { year: '2025' }))).toMatchObject({ details: { earliest: '2026', latest: '2026' } });
  });
});
