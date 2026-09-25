import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf } from '@/common/time/local-day';
import { GOAL_DEFAULTS, TIME } from '@/domain/constants';

/**
 * The five-step cascade (P8-T2).
 *
 * **Back-solving an annual figure into this week's**, which is the whole purpose of the screen it
 * feeds: the agency measures APE, which an agent cannot do anything about directly, and this turns
 * it into the three numbers they can.
 *
 * Pure, and separate from the service, so every formula is exercised without a database — the shape
 * ADR-0030 asks for. **Every constant comes from `GOAL_DEFAULTS` and `TIME`** (invariant §7); not
 * one number below is written twice.
 *
 * The formulas are `Overall.html:5788-5832`, verbatim, with the three corrections the spec
 * registers: decimals survive (I-108), passing the target is explained rather than printed as zero
 * (I-107, ADR-0047), and an assumption that cannot produce a plan is refused by name rather than
 * silently coerced.
 */

/** What the agent typed. Money in IDR sen, rates as percentages — `30` is thirty per cent. */
export interface CascadeInputs {
  mode: 'direct' | 'from_savings';
  annualApeTargetMinor: number;
  savingsTargetMinor: number;
  commissionRatePct: number;
  monthsLeft: number;
  apeAchievedMinor: number;
  caseSizeMinor: number;
  leadsToApptPct: number;
  closingRatePct: number;
}

/** What the five steps produce. Weekly figures are the screen's `≈ n/week` sub-lines. */
export interface CascadeResult {
  /** Resolved from whichever entry mode was used — the two produce one number. */
  annualApeTargetMinor: number;
  apeAchievedMinor: number;
  /** `max(0, target − achieved)`. Never negative, which is what makes `targetMet` possible. */
  remainingApeMinor: number;
  monthlyApeTargetMinor: number;
  policiesPerMonth: number;
  policiesPerWeek: number;
  appointmentsPerMonth: number;
  appointmentsPerWeek: number;
  leadsPerMonth: number;
  leadsPerWeek: number;
  /**
   * The annual target has been reached, so every figure above is zero (ADR-0047).
   *
   * **A flag rather than a silence.** The arithmetic is right — a plan that has been met needs
   * nothing more — but *contact 0 leads* read as this week's plan is an instruction to stop
   * working, printed to the best producer in the office. The screen reads this and says so.
   */
  targetMet: boolean;
}

/**
 * The annual target, from whichever mode produced it (`Overall.html:5780-5791`).
 *
 * **`from_savings` divides by the commission rate**, because an agent thinks in take-home pay and
 * the agency measures APE. The prototype returns 0 for a rate of zero; here that is a refusal —
 * a plan built from a division by nothing is not a plan, and answering 0 hides the reason.
 */
export function annualTargetOf(inputs: CascadeInputs): number {
  if (inputs.mode === 'direct') return inputs.annualApeTargetMinor;

  const rate = inputs.commissionRatePct / 100;
  if (rate <= 0) {
    throw invalid(
      'A savings target needs a commission rate above zero to become an APE target.',
      { commissionRatePct: inputs.commissionRatePct },
    );
  }
  // Rounded to whole sen: money is an integer in this product, and a division rarely lands on one.
  return Math.round(inputs.savingsTargetMinor / rate);
}

/**
 * How much of the period is left to work, in months (`Overall.html:5745-5752`).
 *
 * **Derived in the office's timezone** (invariant §9). The prototype builds `new Date()` and
 * compares it to 31 December in the *browser's* zone, so an agent in Jakarta at 06:00 on 1 January
 * and the server behind them disagree about which year it is — and `monthsLeft` is the cascade's
 * divisor, so every number below it moves.
 *
 * `+1` includes today, which the prototype's comment says and its code does.
 */
export function defaultMonthsLeft(period: string, now: Date, timezone: string): number {
  const today = localDayOf(now, timezone);
  const [year, month, day] = today.split('-').map(Number);
  const endOfPeriod = Date.UTC(Number(period), 11, 31);
  const daysLeft = Math.round((endOfPeriod - Date.UTC(year, month - 1, day)) / TIME.MS_PER_DAY) + 1;
  return clampMonths(daysLeft / TIME.AVG_DAYS_PER_MONTH);
}

/**
 * One decimal, floored at 0.1 (`Overall.html:5752`, `:5796`).
 *
 * The floor is what stops the cascade dividing by ~0 on 31 December. One decimal because 4.3 months
 * is a real answer and rounding it to 4 moves every figure below it.
 */
export function clampMonths(months: number): number {
  return Math.max(GOAL_DEFAULTS.MONTHS_LEFT_MIN, Math.round(months * 10) / 10);
}

/**
 * The five steps (`Overall.html:5798-5822`).
 *
 * **The ceils compound, deliberately.** `ceil(ceil(ape / caseSize) / closingPct)` and then ceil
 * again for leads, so the chain slightly over-states what is needed — which is the safe direction
 * for a target and the prototype's own behaviour.
 */
export function computeCascade(inputs: CascadeInputs): CascadeResult {
  requireUsableAssumptions(inputs);

  const annual = annualTargetOf(inputs);
  const monthsLeft = clampMonths(inputs.monthsLeft);
  const remaining = Math.max(0, annual - inputs.apeAchievedMinor);
  const monthly = Math.round(remaining / monthsLeft);

  const policies = Math.ceil(monthly / inputs.caseSizeMinor);
  // Percentages arrive as `30`; the cascade divides by `0.30`.
  const appointments = Math.ceil(policies / (inputs.closingRatePct / 100));
  const leads = Math.ceil(appointments / (inputs.leadsToApptPct / 100));

  return {
    annualApeTargetMinor: annual,
    apeAchievedMinor: inputs.apeAchievedMinor,
    remainingApeMinor: remaining,
    monthlyApeTargetMinor: monthly,
    policiesPerMonth: policies,
    policiesPerWeek: weeklyOf(policies),
    appointmentsPerMonth: appointments,
    appointmentsPerWeek: weeklyOf(appointments),
    leadsPerMonth: leads,
    leadsPerWeek: weeklyOf(leads),
    // `remaining` is clamped at zero, so this is exactly *the plan has been met*.
    targetMet: remaining === 0,
  };
}

/** `≈ n/week` (`Overall.html:5818`). Ceil, like every other step. */
export function weeklyOf(perMonth: number): number {
  return Math.ceil(perMonth / TIME.WEEKS_PER_MONTH);
}

/**
 * The assumptions that have to hold before there is any arithmetic to do (AC-7).
 *
 * **One definition, and it is here.** `goal-input.ts` checks that each field is a number in the
 * unit this product stores; whether the numbers can produce a plan is this module's, and it answers
 * with `GOAL_INVALID_ASSUMPTION` so a screen can point at the field rather than at the form.
 *
 * The prototype coerces instead — `parseNum(caseSize) || 1` turns a blank case size into **one
 * rupiah**, which produces a target of a hundred million policies and no hint that anything is
 * wrong.
 */
function requireUsableAssumptions(inputs: CascadeInputs): void {
  const violations: string[] = [];

  if (!(inputs.caseSizeMinor > 0)) {
    violations.push('Average case size must be above zero: it is what a policy is worth.');
  }
  for (const [field, label] of [
    ['leadsToApptPct', 'Leads that become an appointment'],
    ['closingRatePct', 'Appointments that become a closing'],
  ] as const) {
    const value = inputs[field];
    if (!(value > 0) || value > 100) {
      violations.push(`${label} must be above 0 and at most 100 per cent.`);
    }
  }

  if (violations.length > 0) {
    throw invalid(violations.join(' '), { violations });
  }
}

function invalid(message: string, details: Record<string, unknown>): DomainException {
  return new DomainException(
    ErrorCode.GOAL_INVALID_ASSUMPTION,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    details,
  );
}
