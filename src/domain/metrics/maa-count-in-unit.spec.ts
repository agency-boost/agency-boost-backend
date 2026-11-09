import { maaCountInUnit, monthly2AverageCount } from './maa-count-in-unit';

describe('MAA_COUNT_IN_UNIT and MONTHLY2_AA (D-period, OD-22; Q6 since P19.3-T1)', () => {
  it('P18-T2 AC-3 counts the Monthly Active Agents for the month; null while no file is held', () => {
    expect(maaCountInUnit([true, false, null, true], true)).toBe(2);
    expect(maaCountInUnit([true, true], false)).toBeNull();
  });

  it('P19.3-T1 AC-14 Monthly2 AA is the mean over the year’s months held of the members active that month (Q6)', () => {
    // Three months held. Month 1: two active; month 2: three; month 3: one. Mean 2, exact.
    const members = [
      [true, true, false],
      [true, true, true],
      [false, true, false],
      [null, false, false], // not reported in a held month: not active in it
    ];
    expect(monthly2AverageCount(members, 3)).toBe(2);
  });

  it('P19.3-T1 AC-14 exact, never rounded before the threshold: 7 over 3 months is 2.333…', () => {
    expect(monthly2AverageCount([[true, true, true], [true, true, false], [true, true, false]], 3)).toBeCloseTo(7 / 3, 10);
    // A member not yet a member in a month is passed `false` for it: they count from their month only.
    expect(monthly2AverageCount([[false, false, true]], 3)).toBeCloseTo(1 / 3, 10);
  });

  it('P19.3-T1 AC-14 where the two-month reading and the average part: active in only one of the last two still counts half', () => {
    // ADR-0134's "each of the last two months" counted nobody here; the average counts the months each was active.
    expect(monthly2AverageCount([[true, false], [false, true]], 2)).toBe(1);
  });

  it('P19.3-T1 AC-14 null only when no month of the year is held; nobody in scope is nought', () => {
    expect(monthly2AverageCount([[true]], 0)).toBeNull();
    expect(monthly2AverageCount([], 2)).toBe(0);
  });
});
