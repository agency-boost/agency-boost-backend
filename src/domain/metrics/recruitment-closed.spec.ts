import { recruitmentLastMonth } from './recruitment-closed';

describe('RECRUITMENT_CLOSED_LAST_MONTH — Recruitment last month (P19.3-T1, D2)', () => {
  it('P19.3-T1 AC-3 is the office file’s RECRUITMENT for the previous month, summed', () => {
    expect(recruitmentLastMonth({ recruitmentMonthly: 7 })).toBe(7);
    // A file that reports nobody recruited reports nought, which is a figure.
    expect(recruitmentLastMonth({ recruitmentMonthly: 0 })).toBe(0);
  });

  it('P19.3-T1 AC-3 a month not uploaded — or uploaded with no recruitment figure — reads –, never 0', () => {
    expect(recruitmentLastMonth(undefined)).toBeNull();
    expect(recruitmentLastMonth({ recruitmentMonthly: null })).toBeNull();
  });
});
