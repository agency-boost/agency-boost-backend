import { MINOR_UNITS_PER_MAJOR, DEFAULT_CURRENCY } from '@/domain/constants';

/**
 * Money is an integer count of minor units (IDR sen) plus an explicit currency.
 * Never a float: 0.1 + 0.2 !== 0.3, and APE figures drive what people are paid.
 *
 * Field names end in `Minor` so a float assignment is visible in review.
 * See .claude/rules/domain-invariants.md §9.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export class MoneyError extends Error {}

export function money(amountMinor: number, currency: string = DEFAULT_CURRENCY): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new MoneyError(
      `Money must be an integer count of minor units, received ${amountMinor}. ` +
        `Multiply by ${MINOR_UNITS_PER_MAJOR} before constructing.`,
    );
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`Money amount ${amountMinor} exceeds the safe integer range.`);
  }
  return Object.freeze({ amountMinor, currency });
}

/** Convenience for seed data and tests: `fromMajor(18_000_000)` → Rp 18.000.000. */
export function fromMajor(amountMajor: number, currency: string = DEFAULT_CURRENCY): Money {
  return money(Math.round(amountMajor * MINOR_UNITS_PER_MAJOR), currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Cannot combine ${a.currency} with ${b.currency}.`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(values: readonly Money[], currency: string = DEFAULT_CURRENCY): Money {
  return values.reduce((acc, v) => add(acc, v), money(0, currency));
}

/**
 * Multiply by a rate, rounding half away from zero. The rounding rule is explicit
 * because it changes a target: the goal cascade divides an annual figure by months
 * remaining, and a banker's-rounding surprise there is a wrong number on a screen
 * somebody is measured against.
 */
export function multiply(value: Money, factor: number): Money {
  const raw = value.amountMinor * factor;
  const rounded = raw < 0 ? -Math.round(-raw) : Math.round(raw);
  return money(rounded, value.currency);
}

/** Divide, rounding half away from zero. Throws rather than returning Infinity. */
export function divide(value: Money, divisor: number): Money {
  if (divisor === 0) {
    throw new MoneyError('Cannot divide money by zero.');
  }
  return multiply(value, 1 / divisor);
}

/** Never negative. Mirrors the prototype's `Math.max(0, target - achieved)` gap rule. */
export function clampToZero(value: Money): Money {
  return value.amountMinor < 0 ? money(0, value.currency) : value;
}

export function isZero(value: Money): boolean {
  return value.amountMinor === 0;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amountMinor - b.amountMinor;
}

/**
 * Ratio of two amounts, as a plain number. Returns null when the denominator is zero —
 * "not enough data" is a distinct third state from zero, and never renders as a failure
 * (Overall.html:5275).
 */
export function ratio(numerator: Money, denominator: Money): number | null {
  assertSameCurrency(numerator, denominator);
  if (denominator.amountMinor === 0) return null;
  return numerator.amountMinor / denominator.amountMinor;
}

/** Major units, for display only. Formatting belongs to the client. */
export function toMajor(value: Money): number {
  return value.amountMinor / MINOR_UNITS_PER_MAJOR;
}
