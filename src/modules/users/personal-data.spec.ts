import { birthDateProblem, isYearMonth, joinMonthProblem, latestAdultBirthDate } from './personal-data';

/** ADR-0158 §2, P18.8-T4 AC-4: a birth date in the past and at least 18 years ago; a join month not in the future. */
describe('what a person records (ADR-0158)', () => {
  const TODAY = '2026-10-26';

  describe('a date of birth', () => {
    it('takes somebody who turns 18 today, and nobody a day younger', () => {
      expect(birthDateProblem('2008-10-26', TODAY)).toBeNull();
      expect(birthDateProblem('1990-03-15', TODAY)).toBeNull();
      expect(birthDateProblem('2008-10-27', TODAY)).toBe('A date of birth must be at least 18 years ago.');
    });

    it('refuses today and any day after it, as not in the past', () => {
      expect(birthDateProblem(TODAY, TODAY)).toBe('A date of birth must be in the past.');
      expect(birthDateProblem('2030-01-01', TODAY)).toBe('A date of birth must be in the past.');
    });

    it('refuses what is not a real day, naming the shape', () => {
      for (const bad of ['1990-02-30', '15/03/1990', '1990-3-15', '', 'yesterday']) {
        expect(birthDateProblem(bad, TODAY)).toContain('is not a date of birth. Write it YYYY-MM-DD');
      }
    });

    it('moves 29 February to the 28th in a year that has none', () => {
      expect(latestAdultBirthDate('2028-02-29')).toBe('2010-02-28');
      expect(latestAdultBirthDate('2026-02-28')).toBe('2008-02-28');
      // Born on the 29th of a leap year: not yet 18 on the 28th of a year without one.
      expect(birthDateProblem('2008-02-29', '2026-02-28')).toBe('A date of birth must be at least 18 years ago.');
      expect(birthDateProblem('2008-02-29', '2026-03-01')).toBeNull();
    });
  });

  describe('a company join month', () => {
    it('takes this month and any before it', () => {
      expect(joinMonthProblem('2026-10', TODAY)).toBeNull();
      expect(joinMonthProblem('2019-01', TODAY)).toBeNull();
    });

    it('refuses a month still to come', () => {
      expect(joinMonthProblem('2026-11', TODAY)).toBe('The company join month cannot be in the future.');
    });

    it('refuses what is not a month, naming the shape', () => {
      for (const bad of ['2026-13', '2026-00', '07/2021', '2021-7', '2021-07-01', '']) {
        expect(isYearMonth(bad)).toBe(false);
        expect(joinMonthProblem(bad, TODAY)).toContain('is not a month. Write the company join month YYYY-MM');
      }
      expect(isYearMonth(202107)).toBe(false);
    });
  });
});
