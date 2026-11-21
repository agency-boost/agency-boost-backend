import {
  BILLING, BILLING_ANNUAL_DISCOUNT_PCT, BILLING_INCOME_PER_POLICY_MINOR, BILLING_PRICE_TIERS, SUBSCRIPTION,
  SUBSCRIPTION_PLAN_MONTHS, type BillingTier, type SubscriptionPlan,
} from '@/domain/constants';

/**
 * **The calculator's arithmetic, on the server** (ADR-0279 §2; `functional/billing.md`, *The calculator*): what *Konfirmasi
 * paket* stores and *Buat PDF* prints is priced here, from the price list and the calculator's inputs — never from a
 * figure the browser sent. The browser keeps its own copy, `priceOffer` in `frontend/src/lib/billing.ts`, for live
 * feedback; **both are pinned to one fixture**, `price-offer.fixture.json` beside this file, which the frontend's spec
 * reads from this tree, so the two cannot drift (invariant §7).
 *
 * The rules, exactly (§9 of the client's spec of 20 November 2026):
 *
 * - **the tier** is the first whose bounds hold *Jumlah leader*, the last open-ended — it gives *Harga standar* and the
 *   offer price the field starts from; 101+ has neither (*Harga khusus*);
 * - **the price** is typed per leader per month, or **as the total** (*isi total*): the total is then the period's total
 *   before the bulk discount, and the price per leader is derived from it;
 * - **the period's gross** is leaders × price × months; **Tahunan** takes 5% off it, rounded half up to the rupiah; the
 *   **bulk discount**, a whole percent or an amount in rupiah, comes off what is left; that is **the total**;
 * - ***Harga normal*** is leaders × *Harga standar* × months, and *Hemat* is *Harga normal* less the total;
 * - **per bulan** = total ÷ months; **per leader / hari** = total ÷ months ÷ 30 ÷ leaders, and **per agent / hari** the
 *   same over agents (agents are never billed), each rounded half up to the nearest Rp 100;
 * - ***Balik modal*** = total ÷ the income one policy brings (`BILLING_INCOME_PER_POLICY_MINOR`), per period and per
 *   month, in tenths of a policy rounded half up.
 *
 * Whole rupiah throughout, worked in integers — a price in sen times ten thousand leaders would pass the largest safe
 * integer, a price in rupiah does not. An input the browser would refuse is refused here by {@link OfferInputError}.
 */

/** How the price is typed: per leader per month, or as the period's total before the bulk discount. */
export type OfferPrice = { mode: 'per_leader'; rateMinor: number } | { mode: 'total'; totalMinor: number };

/** *Diskon bulk order*: a whole percent, or an amount in sen (whole rupiah). */
export type BulkDiscount = { type: 'percent'; percent: number } | { type: 'amount'; amountMinor: number };

export interface OfferInput {
  leaders: number;
  /** *Jumlah agent (Opsional)*: only the per-agent figure reads it. `null` or 0 is none. */
  agents: number | null;
  plan: SubscriptionPlan;
  price: OfferPrice;
  bulk: BulkDiscount | null;
}

/** Every figure the calculator, the PDF and a confirmed package carry, in integer IDR minor units. */
export interface OfferPricing {
  leaders: number;
  agents: number | null;
  plan: SubscriptionPlan;
  months: 6 | 12;
  tier: BillingTier;
  /** The price per leader per month, before the annual discount — typed, or derived from the total. */
  rateMinor: number;
  /** Whether the price was typed as the total. */
  priceMode: OfferPrice['mode'];
  /** *Harga normal*: leaders × *Harga standar* × months; `null` on *Harga khusus*. */
  normalMinor: number | null;
  /** Leaders × price × months. */
  grossMinor: number;
  /** *Diskon harga → Rp x*: *Harga normal* less the gross, when the price is below the standard; else 0. */
  priceDiscountMinor: number;
  /** *Hemat tahunan 5%*; 0 on six months. */
  annualDiscountMinor: number;
  /** *Diskon bulk order*. */
  bulkDiscountMinor: number;
  /** **Total**. */
  totalMinor: number;
  /** *Hemat Rp x (n%) dari harga standar*: *Harga normal* less the total; 0 when there is no saving. */
  savingMinor: number;
  /** The saving as a whole percent of *Harga normal*, rounded half up; 0 when there is none. */
  savingPct: number;
  perMonthMinor: number;
  perLeaderPerDayMinor: number;
  /** `null` without agents. */
  perAgentPerDayMinor: number | null;
  /** *Balik modal*: the income one policy brings, and the policies per period and per month in tenths. */
  breakEven: { incomePerPolicyMinor: number; policiesPerPeriodTenths: number; policiesPerMonthTenths: number };
}

/** The input that cannot be priced, so the refusal can name it. */
export type OfferField =
  | 'leaders' | 'agents' | 'price.rateMinor' | 'price.totalMinor' | 'bulk.percent' | 'bulk.amountMinor';

export class OfferInputError extends Error {
  constructor(readonly field: OfferField) {
    super(`The offer cannot be priced: ${field} is out of bounds.`);
  }
}

const SEN = 100;

/** `a ÷ b`, rounded half up, for non-negative integers. */
const halfUp = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

/** The first tier whose bounds hold the count, else the first. */
export function tierFor(count: number, tiers: readonly BillingTier[] = BILLING_PRICE_TIERS): BillingTier {
  return tiers.find((t) => count >= t.minLeaders && (t.maxLeaders === null || count <= t.maxLeaders)) ?? tiers[0];
}

/** Whole rupiah from sen, or the input's refusal: not an integer, negative, or a fraction of a rupiah. */
function wholeRupiah(minor: number, field: OfferField): number {
  if (!Number.isSafeInteger(minor) || minor < 0 || minor % SEN !== 0) throw new OfferInputError(field);
  return minor / SEN;
}

/** A count from `min` to the bound, or the input's refusal. */
function count(value: number, min: number, field: OfferField): number {
  if (!Number.isSafeInteger(value) || value < min || value > BILLING.COUNT_MAX) throw new OfferInputError(field);
  return value;
}

/** **The one pricing function on the server** (ADR-0279 §2). Pure; the tier table is the domain constant's. */
export function priceOffer(input: OfferInput, tiers: readonly BillingTier[] = BILLING_PRICE_TIERS): OfferPricing {
  const leaders = count(input.leaders, 1, 'leaders');
  const agents = input.agents === null || input.agents === 0 ? null : count(input.agents, 1, 'agents');
  const months = SUBSCRIPTION_PLAN_MONTHS[input.plan];
  const annualPct = input.plan === 'annual' ? BILLING_ANNUAL_DISCOUNT_PCT : 0;
  const tier = tierFor(leaders, tiers);
  const rateMax = SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR / SEN;

  // Everything below in whole rupiah.
  let rate: number;
  let gross: number;
  let annual: number;
  let afterAnnual: number;
  if (input.price.mode === 'per_leader') {
    rate = wholeRupiah(input.price.rateMinor, 'price.rateMinor');
    if (rate > rateMax) throw new OfferInputError('price.rateMinor');
    gross = leaders * rate * months;
    annual = halfUp(gross * annualPct, 100);
    afterAnnual = gross - annual;
  } else {
    afterAnnual = wholeRupiah(input.price.totalMinor, 'price.totalMinor');
    if (afterAnnual > rateMax * leaders * months) throw new OfferInputError('price.totalMinor');
    gross = halfUp(afterAnnual * 100, 100 - annualPct);
    annual = gross - afterAnnual;
    rate = halfUp(gross, leaders * months);
  }

  let bulk = 0;
  if (input.bulk?.type === 'percent') {
    const { percent } = input.bulk;
    if (!Number.isSafeInteger(percent) || percent < 0 || percent > BILLING.BULK_PERCENT_MAX) {
      throw new OfferInputError('bulk.percent');
    }
    bulk = halfUp(afterAnnual * percent, 100);
  } else if (input.bulk?.type === 'amount') {
    bulk = wholeRupiah(input.bulk.amountMinor, 'bulk.amountMinor');
    if (bulk > afterAnnual) throw new OfferInputError('bulk.amountMinor');
  }
  const total = afterAnnual - bulk;

  const standard = tier.standardMinor === null ? null : tier.standardMinor / SEN;
  const normal = standard === null ? null : leaders * standard * months;
  const priceDiscount = normal !== null && normal > gross ? normal - gross : 0;
  const saving = normal !== null && normal > total ? normal - total : 0;
  const perDay = (heads: number) => halfUp(total, months * BILLING.DAYS_PER_MONTH * heads * (BILLING.PER_DAY_ROUNDING_MINOR / SEN))
    * BILLING.PER_DAY_ROUNDING_MINOR;
  const income = BILLING_INCOME_PER_POLICY_MINOR / SEN;

  return {
    leaders,
    agents,
    plan: input.plan,
    months,
    tier,
    rateMinor: rate * SEN,
    priceMode: input.price.mode,
    normalMinor: normal === null ? null : normal * SEN,
    grossMinor: gross * SEN,
    priceDiscountMinor: priceDiscount * SEN,
    annualDiscountMinor: annual * SEN,
    bulkDiscountMinor: bulk * SEN,
    totalMinor: total * SEN,
    savingMinor: saving * SEN,
    savingPct: normal ? halfUp(saving * 100, normal) : 0,
    perMonthMinor: halfUp(total, months) * SEN,
    perLeaderPerDayMinor: perDay(leaders),
    perAgentPerDayMinor: agents === null ? null : perDay(agents),
    breakEven: {
      incomePerPolicyMinor: BILLING_INCOME_PER_POLICY_MINOR,
      policiesPerPeriodTenths: halfUp(total * 10, income),
      policiesPerMonthTenths: halfUp(total * 10, income * months),
    },
  };
}
