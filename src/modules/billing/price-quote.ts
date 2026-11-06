import {
  BILLING_PRICE_TIERS, SUBSCRIPTION_PLAN_MONTHS, type BillingTier, type SubscriptionPlan,
} from '@/domain/constants';

/**
 * **The quote's arithmetic, on the server** (ADR-0211 §5; ADR-0111 §4, amended): what `POST /admin/tenants/:kpmId/quote`
 * sends a KPM's Owner is priced here, from the tier table and the calculator's inputs — never from a figure the browser
 * sent. The browser keeps its own copy, `priceQuote` in `frontend/src/lib/billing.ts`, for live feedback as the inputs
 * are typed; **both are pinned to one fixture**, `price-quote.fixture.json` beside this file, which the frontend's spec
 * reads from this tree, so the two cannot drift (invariant §7).
 *
 * The rules are `functional/billing.md`, *The pricing function*, exactly:
 *
 * - **the tier** is the first whose bounds hold the count, the last open-ended (`:432-434`);
 * - **the base rate** is the tier's six-month or annual rate, by the plan (`:494`);
 * - **a percent discount** from 0 to 100, the rate after it **rounded half up to the whole rupiah**, in integers — 7%
 *   off Rp 356.250 is Rp 331.313, never 331.312; **an amount** in whole rupiah from Rp 0 to the base rate, exact;
 * - **every total is that rate × the count (× 6 or 12), exactly**, so a printed rate × count is the printed total.
 *
 * Integer IDR minor units throughout (invariant §9). Inputs the browser would refuse — a percent above 100, an amount
 * above the rate, a fraction of a rupiah, a count below 1 — are refused here by `QuoteInputError`, never priced.
 */

/** The manual override, normalised: a percent as decimal digits (`'10.5'`), or an amount in sen. */
export type ManualDiscount =
  | { type: 'percent'; percent: string }
  | { type: 'flat'; amountMinor: number };

export interface QuoteInput {
  /** The leaders priced: a whole number from 1. */
  leaders: number;
  plan: SubscriptionPlan;
  discount: ManualDiscount | null;
}

/** Every figure the quote prints, in integer IDR minor units. */
export interface QuotePricing {
  leaders: number;
  tier: BillingTier;
  plan: SubscriptionPlan;
  months: 6 | 12;
  standardMinor: number;
  /** *Offering price / leader / mo*: the six-month rate, on either plan. */
  offerMinor: number;
  /** The plan's rate, before the manual discount. */
  baseMinor: number;
  /** The six-month rate less the annual, on an annual plan; 0 on six months. */
  annualDiscountMinor: number;
  /** What the manual discount took off, per leader. */
  manualDiscountMinor: number;
  finalMinor: number;
  monthlyTotalMinor: number;
  periodTotalMinor: number;
}

/** An input the quote cannot be priced from: which, so the refusal can name it. */
export class QuoteInputError extends Error {
  constructor(readonly field: 'leaders' | 'discount.percent' | 'discount.amountMinor') {
    super(`The quote cannot be priced: ${field} is out of bounds.`);
  }
}

const SEN_PER_RUPIAH = 100;
/** A percent as typed once normalised: digits, and at most one `.` with digits after it. */
const PERCENT = /^\d{1,3}(?:\.\d{1,4})?$/;

/** The first tier whose bounds hold the count, else the first (`findTier`, `:432-434`). */
export function tierFor(count: number, tiers: readonly BillingTier[] = BILLING_PRICE_TIERS): BillingTier {
  return tiers.find((t) => count >= t.minLeaders && (t.maxLeaders === null || count <= t.maxLeaders)) ?? tiers[0];
}

/** The rate after a percent, half up to the whole rupiah, in integers (`afterPercent` in the browser's copy). */
function afterPercent(rateMinor: number, percent: string): number {
  const [whole, fraction = ''] = percent.split('.');
  const scale = BigInt(10) ** BigInt(fraction.length);
  const units = BigInt(`${whole}${fraction}`);
  const hundred = BigInt(100) * scale;
  if (units > hundred) throw new QuoteInputError('discount.percent');
  const rate = BigInt(rateMinor / SEN_PER_RUPIAH);
  const two = BigInt(2);
  const major = (rate * (hundred - units) * two + hundred) / (two * hundred);
  return Number(major) * SEN_PER_RUPIAH;
}

/** **The one pricing function on the server** (ADR-0211 §5). Pure; the tier table is the domain constant's. */
export function priceQuote(input: QuoteInput, tiers: readonly BillingTier[] = BILLING_PRICE_TIERS): QuotePricing {
  const { leaders, plan, discount } = input;
  if (!Number.isSafeInteger(leaders) || leaders < 1) throw new QuoteInputError('leaders');
  const tier = tierFor(leaders, tiers);
  const months = SUBSCRIPTION_PLAN_MONTHS[plan];
  const baseMinor = plan === 'annual' ? tier.annualMinor : tier.sixMonthMinor;

  let finalMinor = baseMinor;
  if (discount?.type === 'percent') {
    if (!PERCENT.test(discount.percent)) throw new QuoteInputError('discount.percent');
    finalMinor = afterPercent(baseMinor, discount.percent);
  } else if (discount?.type === 'flat') {
    const { amountMinor } = discount;
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor % SEN_PER_RUPIAH !== 0 || amountMinor > baseMinor) {
      throw new QuoteInputError('discount.amountMinor');
    }
    finalMinor = baseMinor - amountMinor;
  }

  const monthlyTotalMinor = finalMinor * leaders;
  return {
    leaders,
    tier,
    plan,
    months,
    standardMinor: tier.standardMinor,
    offerMinor: tier.sixMonthMinor,
    baseMinor,
    annualDiscountMinor: plan === 'annual' ? tier.sixMonthMinor - tier.annualMinor : 0,
    manualDiscountMinor: baseMinor - finalMinor,
    finalMinor,
    monthlyTotalMinor,
    periodTotalMinor: monthlyTotalMinor * months,
  };
}
