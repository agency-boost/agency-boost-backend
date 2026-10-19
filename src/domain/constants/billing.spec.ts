import { BILLING_ANNUAL_DISCOUNT_PCT, BILLING_CURRENCY, BILLING_PRICE_TIERS, MINOR_UNITS_PER_MAJOR } from './index';

/**
 * **The quote tool's price table, pinned** (P13.2-T2 AC-1; ADR-0111 §3).
 *
 * Every figure is the prototype's, `AgencyBoost_Billing_Subscription.html:420-426`, in whole rupiah
 * there and in IDR sen here. A price change is a release, and it starts by failing this.
 */
const rp = (major: number) => major * MINOR_UNITS_PER_MAJOR;

/** The monthly bill for `count` leaders at a period's rate: one rate per leader, chosen by the count's tier. */
function monthly(count: number, rate: 'sixMonthMinor' | 'annualMinor'): number {
  const tier = BILLING_PRICE_TIERS.find((t) => count >= t.minLeaders && (t.maxLeaders === null || count <= t.maxLeaders));
  if (!tier) throw new Error(`no tier for ${count}`);
  return tier[rate] * count;
}

describe('the price table (Billing_Subscription.html:420-426)', () => {
  it('AC-1 pins every figure to the prototype, in IDR minor units, by stable code', () => {
    expect(BILLING_CURRENCY).toBe('IDR');
    expect(BILLING_PRICE_TIERS).toEqual([
      { code: 'TIER_1_10', minLeaders: 1, maxLeaders: 10, standardMinor: rp(500_000), sixMonthMinor: rp(400_000), annualMinor: rp(380_000), customPricing: false },
      { code: 'TIER_11_20', minLeaders: 11, maxLeaders: 20, standardMinor: rp(475_000), sixMonthMinor: rp(375_000), annualMinor: rp(356_250), customPricing: false },
      { code: 'TIER_21_50', minLeaders: 21, maxLeaders: 50, standardMinor: rp(450_000), sixMonthMinor: rp(350_000), annualMinor: rp(332_500), customPricing: false },
      { code: 'TIER_51_100', minLeaders: 51, maxLeaders: 100, standardMinor: rp(425_000), sixMonthMinor: rp(300_000), annualMinor: rp(285_000), customPricing: false },
      // `hidden: true` (`:425`): *Custom pricing* publicly, its real rates for the Super Admin's quoting.
      { code: 'TIER_101_PLUS', minLeaders: 101, maxLeaders: null, standardMinor: rp(375_000), sixMonthMinor: rp(250_000), annualMinor: rp(237_500), customPricing: true },
    ]);
  });

  it('AC-1 holds every figure in whole rupiah and integer sen, never a float', () => {
    for (const t of BILLING_PRICE_TIERS) {
      for (const minor of [t.standardMinor, t.sixMonthMinor, t.annualMinor]) {
        expect([t.code, Number.isInteger(minor), minor % MINOR_UNITS_PER_MAJOR]).toEqual([t.code, true, 0]);
      }
    }
  });

  it('AC-1 covers every count from 1 up, with no gap and no overlap, the last tier open', () => {
    expect(BILLING_PRICE_TIERS[0].minLeaders).toBe(1);
    BILLING_PRICE_TIERS.slice(1).forEach((t, i) => {
      expect([t.code, t.minLeaders]).toEqual([t.code, (BILLING_PRICE_TIERS[i].maxLeaders ?? NaN) + 1]);
    });
    expect(BILLING_PRICE_TIERS.at(-1)?.maxLeaders).toBeNull();
    // Only the open tier is custom: the four public cards each draw a rate.
    expect(BILLING_PRICE_TIERS.map((t) => t.customPricing)).toEqual([false, false, false, false, true]);
  });

  it('AC-1 the annual rate is 95% of the six-month rate on every row — the label’s “extra 5%” (`:524`)', () => {
    expect(BILLING_ANNUAL_DISCOUNT_PCT).toBe(5);
    for (const t of BILLING_PRICE_TIERS) {
      // Integer arithmetic: ×95/100 exactly, no rounding anywhere.
      expect([t.code, t.annualMinor * 100]).toEqual([t.code, t.sixMonthMinor * (100 - BILLING_ANNUAL_DISCOUNT_PCT)]);
    }
  });

  it('AC-1 a standard rate is above both of its tier’s rates, and the six-month above the annual', () => {
    for (const t of BILLING_PRICE_TIERS) {
      expect([t.code, t.standardMinor > t.sixMonthMinor, t.sixMonthMinor > t.annualMinor]).toEqual([t.code, true, true]);
    }
  });

  /*
   * ADR-0066 §1, standing under ADR-0111: the tiers price as drawn. A larger office may pay less a month
   * than a smaller one, and the client confirmed it on 2026-09-30. Pinned as expected behaviour, so a
   * "fix" to the table is a decision somebody has to take rather than a refactor that slips through.
   */
  describe.each([['six-month', 'sixMonthMinor'], ['annual', 'annualMinor']] as const)('the inversions, at the %s rate', (_name, rate) => {
    it('AC-1 20 leaders cost more a month than 21', () => {
      expect(monthly(20, rate)).toBeGreaterThan(monthly(21, rate));
    });

    it('AC-1 every count from 44 to 50 costs more a month than 51, and 43 does not', () => {
      for (let count = 44; count <= 50; count += 1) {
        expect([count, monthly(count, rate) > monthly(51, rate)]).toEqual([count, true]);
      }
      expect(monthly(43, rate)).toBeLessThanOrEqual(monthly(51, rate));
    });

    it('AC-1 every count from 85 to 100 costs more a month than 101, and 84 does not', () => {
      for (let count = 85; count <= 100; count += 1) {
        expect([count, monthly(count, rate) > monthly(101, rate)]).toEqual([count, true]);
      }
      expect(monthly(84, rate)).toBeLessThanOrEqual(monthly(101, rate));
    });
  });
});
