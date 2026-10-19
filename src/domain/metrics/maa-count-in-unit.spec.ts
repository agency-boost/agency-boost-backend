import { maaCountInUnit, monthly2ActiveCount } from './maa-count-in-unit';

describe('MAA_COUNT_IN_UNIT and MONTHLY2_AA (D-period, OD-22)', () => {
  it('P18-T2 AC-3 counts the Monthly Active Agents for the month; null while no file is held', () => {
    expect(maaCountInUnit([true, false, null, true], true)).toBe(2);
    expect(maaCountInUnit([true, true], false)).toBeNull();
  });

  it('P18-T2 AC-4 Monthly2: only active in each of the two months counts — not active, not reported or not yet a member in either is out', () => {
    // Active both · not active in one · not reported in one held month · not yet a member then (false) · active both.
    expect(monthly2ActiveCount([[true, true], [true, false], [null, true], [false, true], [true, true]], 2, 2)).toBe(2);
  });

  it('P18-T2 AC-4 null only until the office holds two months; nobody in scope is nought', () => {
    expect(monthly2ActiveCount([[true]], 1, 2)).toBeNull();
    expect(monthly2ActiveCount([], 2, 2)).toBe(0);
  });
});
