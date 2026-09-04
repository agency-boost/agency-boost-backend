import {
  add, clampToZero, compare, divide, fromMajor, isZero, money, MoneyError,
  multiply, ratio, subtract, sum, toMajor,
} from './money';

describe('Money', () => {
  describe('construction', () => {
    it('rejects a float — the defect this type exists to prevent', () => {
      expect(() => money(1.5)).toThrow(MoneyError);
      expect(() => money(0.1 + 0.2)).toThrow(MoneyError);
    });
    it('rejects amounts beyond the safe integer range', () => {
      expect(() => money(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
    });
    it('defaults to IDR and is immutable', () => {
      const m = money(100);
      expect(m.currency).toBe('IDR');
      expect(Object.isFrozen(m)).toBe(true);
    });
    it('converts from major units', () => {
      expect(fromMajor(18_000_000).amountMinor).toBe(1_800_000_000);
      expect(toMajor(fromMajor(18_000_000))).toBe(18_000_000);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts exactly, with no float drift', () => {
      const a = fromMajor(0.1);
      const b = fromMajor(0.2);
      expect(toMajor(add(a, b))).toBe(0.3);
    });
    it('refuses to mix currencies', () => {
      expect(() => add(money(1, 'IDR'), money(1, 'USD'))).toThrow(MoneyError);
      expect(() => compare(money(1, 'IDR'), money(1, 'USD'))).toThrow(MoneyError);
    });
    it('sums an empty list to zero', () => {
      expect(isZero(sum([]))).toBe(true);
    });
    it('rounds half away from zero, in both directions', () => {
      expect(multiply(money(5), 0.5).amountMinor).toBe(3);
      expect(multiply(money(-5), 0.5).amountMinor).toBe(-3);
    });
    it('divides, rounding half away from zero', () => {
      expect(divide(money(100), 3).amountMinor).toBe(33);
      expect(divide(money(-100), 3).amountMinor).toBe(-33);
      expect(divide(fromMajor(120), 12).amountMinor).toBe(fromMajor(10).amountMinor);
    });
    it('throws rather than returning Infinity on divide by zero', () => {
      expect(() => divide(money(100), 0)).toThrow(MoneyError);
    });
    it('compares amounts of the same currency', () => {
      expect(compare(money(100), money(50))).toBeGreaterThan(0);
      expect(compare(money(50), money(100))).toBeLessThan(0);
      expect(compare(money(50), money(50))).toBe(0);
      expect([money(300), money(100), money(200)].sort(compare).map((m) => m.amountMinor))
        .toEqual([100, 200, 300]);
    });
  });

  describe('domain rules', () => {
    it('clamps a negative gap to zero, as the prototype does', () => {
      const overAchieved = subtract(fromMajor(100), fromMajor(150));
      expect(overAchieved.amountMinor).toBeLessThan(0);
      expect(isZero(clampToZero(overAchieved))).toBe(true);
    });
    it('returns null — not zero — when a ratio denominator is zero', () => {
      expect(ratio(fromMajor(10), money(0))).toBeNull();
      expect(ratio(money(0), fromMajor(10))).toBe(0);
    });
  });
});
