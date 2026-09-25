import { checkGoal, GOAL_BOUNDS } from './goal-input';

/**
 * What a goal's fields may hold (P8-T1).
 *
 * Pure, so every rule is exercised without a database (ADR-0030). **The cascade is not here** —
 * whether the numbers make sense together is P8-T2's; this is the older question of whether each
 * one is a number at all, and in the unit this product stores it in.
 */
describe('a goal’s fields', () => {
  const ok = {
    period: '2026',
    mode: 'direct',
    annualApeTargetMinor: 500_000_000_00,
    savingsTargetMinor: 50_000_000_00,
    commissionRatePct: 10,
    monthsLeft: 3.2,
    apeAchievedMinor: 0,
    caseSizeMinor: 18_000_000_00,
    leadsToApptPct: 30,
    closingRatePct: 30,
  };

  it('takes a complete plan unchanged', () => {
    expect(checkGoal(ok)).toEqual(ok);
  });

  describe('the period is a year, not a code', () => {
    it('takes four digits', () => {
      expect(checkGoal({ ...ok, period: '2027' }).period).toBe('2027');
    });

    it.each(['26', '2026-Q1', 'FY2026', '', 'twenty-six'])('refuses %p', (period) => {
      expect(() => checkGoal({ ...ok, period })).toThrow(/calendar year/);
    });

    it('refuses a missing one, because it is half the uniqueness key', () => {
      const { period, ...rest } = ok;
      expect(period).toBe('2026');
      expect(() => checkGoal(rest)).toThrow(/period is required/);
    });
  });

  describe('money is whole sen', () => {
    it.each([
      'annualApeTargetMinor', 'savingsTargetMinor', 'apeAchievedMinor', 'caseSizeMinor',
    ])('refuses a fraction of a sen on %s', (field) => {
      // A fraction here is not a rounding question: somebody handed major units to a field that
      // stores minor ones, and no amount of rounding makes that the number they meant.
      expect(() => checkGoal({ ...ok, [field]: 1_000.5 })).toThrow(/whole number/);
    });

    it('refuses a negative target', () => {
      expect(() => checkGoal({ ...ok, annualApeTargetMinor: -1 })).toThrow(/must be a number/);
    });

    it('stays below the point integers stop being exact', () => {
      // Past MAX_SAFE_INTEGER a figure silently loses its last digits. The bound is a test rather
      // than only a comment because the first version of it was set *above* the limit it names.
      expect(GOAL_BOUNDS.money.max).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(() => checkGoal({ ...ok, annualApeTargetMinor: GOAL_BOUNDS.money.max + 1 }))
        .toThrow(/must be a number/);
    });
  });

  describe('percentages take decimals, which the prototype cannot (I-108)', () => {
    it.each(['commissionRatePct', 'leadsToApptPct', 'closingRatePct'])('takes 12.5 on %s', (field) => {
      /*
       * `parseNum` strips every non-digit, so `12.5` becomes `125`: a commission rate of twelve and
       * a half per cent read as a hundred and twenty-five, and a plan built on a tenfold error.
       * That is a defect rather than a simplification, and this is the regression test for it.
       */
      expect(checkGoal({ ...ok, [field]: 12.5 })[field as 'commissionRatePct']).toBe(12.5);
    });

    it.each([-1, 101])('refuses %p, which is not a percentage', (value) => {
      expect(() => checkGoal({ ...ok, closingRatePct: value })).toThrow(/from 0 to 100/);
    });
  });

  describe('months left', () => {
    it('takes a decimal, because 4.3 months is a real answer', () => {
      expect(checkGoal({ ...ok, monthsLeft: 4.3 }).monthsLeft).toBe(4.3);
    });

    it('refuses zero, which would divide the cascade by nothing', () => {
      expect(() => checkGoal({ ...ok, monthsLeft: 0 })).toThrow(/from 0.1 to 120/);
    });
  });

  describe('mode', () => {
    it('takes the two the screen offers', () => {
      expect(checkGoal({ ...ok, mode: 'from_savings' }).mode).toBe('from_savings');
    });

    it('refuses anything else', () => {
      expect(() => checkGoal({ ...ok, mode: 'guess' })).toThrow(/must be one of/);
    });
  });

  describe('a partial patch', () => {
    it('requires nothing, and keeps what it was given', () => {
      expect(checkGoal({ apeAchievedMinor: 12_000_000_00 }, { partial: true }))
        .toEqual({ apeAchievedMinor: 12_000_000_00 });
    });

    it('still refuses a bad value', () => {
      expect(() => checkGoal({ closingRatePct: 400 }, { partial: true })).toThrow(/from 0 to 100/);
    });
  });

  it('refuses a field nobody defined, rather than dropping it', () => {
    expect(() => checkGoal({ ...ok, snapshot: { policiesPerMonth: 6 } }))
      .toThrow(/snapshot/);
  });

  it('gathers every violation, so a form with three mistakes hears about three', () => {
    try {
      checkGoal({ ...ok, period: 'x', closingRatePct: 400, monthsLeft: 0 });
      throw new Error('should have refused');
    } catch (err) {
      expect((err as { details: { violations: string[] } }).details.violations).toHaveLength(3);
    }
  });
});
