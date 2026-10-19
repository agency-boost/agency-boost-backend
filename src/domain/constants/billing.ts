/**
 * **The quote tool's price table** (ADR-0111 §3; `functional/billing.md`; `metrics-and-definitions.md`).
 *
 * The prototype's `tiers` constant, `AgencyBoost_Billing_Subscription.html:420-426`, in **integer IDR
 * minor units** (sen, invariant §9): per tier a stable code, the leader-count bounds (the last open), the
 * standard rate struck through on the card, the six-month and the annual rate per leader per month, and
 * whether the tier shows publicly as *Custom pricing* (`hidden: true`, `:425`).
 *
 * **Held once, here** (invariant §7). `GET /admin/billing/prices` serves it to the Super Admin alone and
 * nothing else reads it: the 101+ tier's real rates are meant for AgencyBoost's own quoting (`:500`), so
 * they never become a frontend constant every visitor could download (ADR-0111, option 3).
 *
 * **The inversions are the table, not a defect** (ADR-0066 §1, standing under ADR-0111): 20 leaders cost
 * more a month than 21, 44 to 50 more than 51, and 85 to 100 more than 101, at both rates. The client
 * confirmed them on 2026-09-30, and `billing.spec.ts` pins them as expected behaviour.
 *
 * A price change is a release (ADR-0111, *Consequences*): there is no price book to edit.
 */

/** The currency every figure below is in. Not an office's `currency`: these are AgencyBoost's prices. */
export const BILLING_CURRENCY = 'IDR' as const;

/**
 * **The annual rate's discount off the six-month rate, in percent** — the *"extra 5% off 6-month rate"*
 * the label hard-codes (`:524`). Every tier's `annualMinor` is exactly `100 − 5` percent of its
 * `sixMonthMinor`, and a test holds the two to each other, so the label and the rate charged cannot
 * disagree.
 */
export const BILLING_ANNUAL_DISCOUNT_PCT = 5;

/** One tier of the table. Rates are per leader per month. */
export interface BillingTier {
  /** The identity. Stable: a quote, a manual chapter or a test names a tier by it, never by position. */
  readonly code: string;
  /** The smallest leader count the tier prices, inclusive. */
  readonly minLeaders: number;
  /** The largest, inclusive; `null` for the open last tier (`max: Infinity`, `:425`). */
  readonly maxLeaders: number | null;
  /** The standard rate, struck through (`standard`). */
  readonly standardMinor: number;
  /** The six-month rate, which every card shows whichever period is chosen (`sixMo`, `:456`). */
  readonly sixMonthMinor: number;
  /** The annual rate (`annual`). */
  readonly annualMinor: number;
  /** Shown publicly as *Custom pricing* (`hidden`): its card draws no rate. */
  readonly customPricing: boolean;
}

/** Rupiah to sen, for the table below only: the prototype writes whole rupiah. */
const rupiah = (major: number) => major * 100;

/** `Billing_Subscription.html:420-426`, in order, smallest count first. */
export const BILLING_PRICE_TIERS: readonly BillingTier[] = [
  {
    code: 'TIER_1_10', minLeaders: 1, maxLeaders: 10,
    standardMinor: rupiah(500_000), sixMonthMinor: rupiah(400_000), annualMinor: rupiah(380_000),
    customPricing: false,
  },
  {
    code: 'TIER_11_20', minLeaders: 11, maxLeaders: 20,
    standardMinor: rupiah(475_000), sixMonthMinor: rupiah(375_000), annualMinor: rupiah(356_250),
    customPricing: false,
  },
  {
    code: 'TIER_21_50', minLeaders: 21, maxLeaders: 50,
    standardMinor: rupiah(450_000), sixMonthMinor: rupiah(350_000), annualMinor: rupiah(332_500),
    customPricing: false,
  },
  {
    code: 'TIER_51_100', minLeaders: 51, maxLeaders: 100,
    standardMinor: rupiah(425_000), sixMonthMinor: rupiah(300_000), annualMinor: rupiah(285_000),
    customPricing: false,
  },
  {
    code: 'TIER_101_PLUS', minLeaders: 101, maxLeaders: null,
    standardMinor: rupiah(375_000), sixMonthMinor: rupiah(250_000), annualMinor: rupiah(237_500),
    customPricing: true,
  },
];
