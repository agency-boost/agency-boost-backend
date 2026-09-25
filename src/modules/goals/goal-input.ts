import { Fields } from '@/common/validation/fields';
import { GOAL_MODES, type GoalMode } from './goal.schema';

/**
 * What a goal's fields may hold (P8-T1).
 *
 * Pure, and separate from the service, so the rules can be exercised without a database — the shape
 * `lead-input.ts` and `campaign-input.ts` take, and the reason ADR-0030 gives for it.
 *
 * **This is the record's shape, not the cascade's arithmetic.** Whether the numbers *make sense
 * together* — and the `GOAL_INVALID_ASSUMPTION` code that says they do not — is P8-T2's, with the
 * formula they feed. What is here is the smaller and older question: is this a number at all, is it
 * money in the unit this product stores money in, is this a period.
 */

/** A calendar year, `YYYY`. Annual in v1 (ADR-0049); the shape widens when a second one does. */
const PERIOD = /^\d{4}$/;

/**
 * **Rp 10 trillion**, as sen — `1e15`, comfortably below `Number.MAX_SAFE_INTEGER` (`≈9.007e15`).
 *
 * Not a business rule — nobody's annual target is this — but a floor under the arithmetic: past
 * `MAX_SAFE_INTEGER` an integer stops being exact in a double, and every monetary figure in this
 * product is a JavaScript number. A target that silently loses its last digits is worse than one
 * that is refused.
 *
 * **The first version of this line said exactly that and then set the ceiling to `1e16`** — above
 * the limit it was written to stay under. The test that names the limit is what caught it, which is
 * the argument for a bound having a test rather than only a comment.
 */
export const GOAL_BOUNDS = {
  money: { min: 0, max: 10_000_000_000_000_00 },

  /** The cascade's divisor. Floored well above zero so it cannot divide by ~0. */
  monthsLeft: { min: 0.1, max: 120 },
} as const;

export interface CheckedGoal {
  period?: string;
  mode?: GoalMode;
  annualApeTargetMinor?: number;
  savingsTargetMinor?: number;
  commissionRatePct?: number;
  monthsLeft?: number;
  apeAchievedMinor?: number;
  caseSizeMinor?: number;
  leadsToApptPct?: number;
  closingRatePct?: number;
}

/** The four fields that hold IDR sen. Named once, so a fifth cannot be added without a decision. */
const MONEY = [
  'annualApeTargetMinor', 'savingsTargetMinor', 'apeAchievedMinor', 'caseSizeMinor',
] as const;

/** The three that are percentages. `monthsLeft` is not one — it is a count of months. */
const PERCENT = ['commissionRatePct', 'leadsToApptPct', 'closingRatePct'] as const;

export function checkGoal(body: unknown, opts: { partial?: boolean } = {}): CheckedGoal {
  const required = !opts.partial;
  const f = new Fields(body, [
    'period', 'mode', ...MONEY, ...PERCENT, 'monthsLeft',
  ]);

  const out: CheckedGoal = {};

  /*
   * Read raw rather than through `Fields.code`: a semantic code must start with a letter, and a
   * period is `2026`. It is a **year**, not a code — the two look alike and are not the same kind
   * of thing, which is the distinction ADR-0049 turns on.
   */
  const period = raw(body, 'period');
  if (period === undefined) {
    if (required) f.violations.push('period is required.');
  } else if (typeof period !== 'string' || !PERIOD.test(period)) {
    f.violations.push('period must be a calendar year, written YYYY.');
  } else {
    out.period = period;
  }

  const mode = f.oneOf('mode', GOAL_MODES, required);
  if (mode !== undefined) out.mode = mode;

  /*
   * **Whole sen, and that is the check.** `Fields.number` refuses a non-number and anything out of
   * range; what it cannot know is that these four are *minor units*, where a fraction is not a
   * rounding question but a unit error — somebody handed major units to a field that stores sen.
   */
  for (const field of MONEY) {
    const value = f.number(field, GOAL_BOUNDS.money, required);
    if (value === undefined) continue;
    if (!Number.isInteger(value)) {
      f.violations.push(`${field} is IDR sen and must be a whole number.`);
      continue;
    }
    out[field] = value;
  }

  /*
   * **Shape only: is this a percentage-shaped number.** Whether it is a *usable* one — above zero
   * and at most a hundred — is `goal-cascade.ts`'s, which refuses it with
   * `GOAL_INVALID_ASSUMPTION` so a screen can point at the field rather than at the form. One
   * semantic rule, in the module that needs it (invariant §8).
   *
   * **Decimals survive here, deliberately** (I-108). The prototype's `parseNum` strips every
   * non-digit, so `12.5` becomes `125`: a commission rate of twelve and a half per cent read as a
   * hundred and twenty-five, and a plan built on a tenfold error.
   */
  for (const field of PERCENT) {
    const value = raw(body, field);
    if (value === undefined) {
      if (required) f.violations.push(`${field} is required.`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      f.violations.push(`${field} must be a percentage, written as a number like 30 or 12.5.`);
      continue;
    }
    out[field] = value;
  }

  const months = f.number('monthsLeft', GOAL_BOUNDS.monthsLeft, required);
  if (months !== undefined) out.monthsLeft = months;

  return f.done(out);
}

/** `Fields` collects its own; this reaches the raw value for the cases it does not cover. */
function raw(body: unknown, key: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}
