import {
  BILLING, BILLING_ANNUAL_DISCOUNT_PCT, BILLING_BREAK_EVEN, BILLING_CURRENCY, BILLING_INCOME_PER_POLICY_MINOR,
  BILLING_LAPSE_SUSPENSION_REASON, BILLING_PRICE_TIERS, MINOR_UNITS_PER_MAJOR, SUBSCRIPTION_PLAN_MONTHS, SUBSCRIPTION_PLANS,
} from './index';

/**
 * **The price list and the subscription's numbers, pinned** (P19.23-T5 AC-2, AC-3, AC-5; ADR-0279 §1–§5).
 *
 * Every figure is the client's, `SPEC-SUPERADMIN-2026-11-20.md` §9, in whole rupiah there and in IDR sen here. A price
 * change is a release, and it starts by failing this.
 */
const rp = (major: number) => major * MINOR_UNITS_PER_MAJOR;

/** The month's bill for `count` leaders at their tier's offer price. */
function monthly(count: number): number {
  const tier = BILLING_PRICE_TIERS.find((t) => count >= t.minLeaders && (t.maxLeaders === null || count <= t.maxLeaders));
  if (!tier?.offerMinor) throw new Error(`no public price for ${count}`);
  return tier.offerMinor * count;
}

describe('Paket & harga (P19.23-T5 AC-3)', () => {
  it('P19.23-T5 AC-3 pins the five tiers of §9: standard and offer per leader per month, 101+ Harga khusus', () => {
    expect(BILLING_CURRENCY).toBe('IDR');
    expect(BILLING_PRICE_TIERS).toEqual([
      { code: 'TIER_1_10', minLeaders: 1, maxLeaders: 10, standardMinor: rp(500_000), offerMinor: rp(400_000), customPricing: false },
      { code: 'TIER_11_20', minLeaders: 11, maxLeaders: 20, standardMinor: rp(475_000), offerMinor: rp(375_000), customPricing: false },
      { code: 'TIER_21_50', minLeaders: 21, maxLeaders: 50, standardMinor: rp(450_000), offerMinor: rp(350_000), customPricing: false },
      { code: 'TIER_51_100', minLeaders: 51, maxLeaders: 100, standardMinor: rp(425_000), offerMinor: rp(300_000), customPricing: false },
      // *Harga khusus — diatur per KPM*: no hidden rate is held any more (ADR-0279 §1).
      { code: 'TIER_101_PLUS', minLeaders: 101, maxLeaders: null, standardMinor: null, offerMinor: null, customPricing: true },
    ]);
  });

  it('P19.23-T5 AC-3 the saving each card prints: 20%, 21%, 22%, 29%', () => {
    const save = BILLING_PRICE_TIERS.filter((t) => t.standardMinor && t.offerMinor)
      .map((t) => Math.round((1 - t.offerMinor! / t.standardMinor!) * 100));
    expect(save).toEqual([20, 21, 22, 29]);
  });

  it('P19.23-T5 AC-3 covers every count from 1 up, with no gap and no overlap, the last tier open', () => {
    expect(BILLING_PRICE_TIERS[0].minLeaders).toBe(1);
    BILLING_PRICE_TIERS.slice(1).forEach((t, i) => {
      expect([t.code, t.minLeaders]).toEqual([t.code, (BILLING_PRICE_TIERS[i].maxLeaders ?? NaN) + 1]);
    });
    expect(BILLING_PRICE_TIERS.at(-1)?.maxLeaders).toBeNull();
    expect(BILLING_PRICE_TIERS.map((t) => t.customPricing)).toEqual([false, false, false, false, true]);
  });

  it('P19.23-T5 AC-3 holds every price in whole rupiah and integer sen', () => {
    for (const t of BILLING_PRICE_TIERS) {
      for (const minor of [t.standardMinor, t.offerMinor].filter((m): m is number => m !== null)) {
        expect([t.code, Number.isInteger(minor), minor % MINOR_UNITS_PER_MAJOR]).toEqual([t.code, true, 0]);
      }
    }
  });

  it('P19.23-T5 AC-3 the annual discount is 5% (Tahunan · HEMAT 5%)', () => {
    expect(BILLING_ANNUAL_DISCOUNT_PCT).toBe(5);
  });

  /* ADR-0066 §1: the tiers price as drawn — a larger office may pay less a month than a smaller one. */
  it('P19.23-T5 AC-3 the inversions stand: 20 leaders cost more a month than 21, 44 to 50 more than 51', () => {
    expect(monthly(20)).toBeGreaterThan(monthly(21));
    for (let count = 44; count <= 50; count += 1) expect([count, monthly(count) > monthly(51)]).toEqual([count, true]);
    expect(monthly(43)).toBeLessThanOrEqual(monthly(51));
  });
});

describe('the subscription’s clock and the derived figures (P19.23-T5)', () => {
  it('P19.23-T5 AC-3 a new KPM has a 30-day trial', () => {
    expect(BILLING.TRIAL_DAYS).toBe(30);
  });

  it('P19.23-T5 AC-5 a period that ends without renewal is suspended after 7 days', () => {
    expect(BILLING.GRACE_DAYS).toBe(7);
    expect(BILLING_LAPSE_SUSPENSION_REASON).toBe('Langganan tidak diperpanjang');
  });

  it('P19.23-T5 AC-4 Berakhir ≤ 30 hari reads 30 days ahead', () => {
    expect(BILLING.ENDING_SOON_DAYS).toBe(30);
  });

  it('P19.23-T5 AC-2 the per-day figures divide by 30 days a month and round to Rp 100', () => {
    expect(BILLING.DAYS_PER_MONTH).toBe(30);
    expect(BILLING.PER_DAY_ROUNDING_MINOR).toBe(rp(100));
  });

  it('P19.23-T5 AC-2 bounds the bulk percent, the note, the KPM name and the counts', () => {
    expect([BILLING.BULK_PERCENT_MAX, BILLING.NOTE_MAX, BILLING.KPM_NAME_MAX, BILLING.COUNT_MAX]).toEqual([100, 500, 120, 10_000]);
  });

  it('P19.23-T5 AC-2 Balik modal: APE Rp 20.000.000 × (komisi 20% + overriding 10% + bonus 10%) = Rp 8.000.000', () => {
    expect(BILLING_BREAK_EVEN).toEqual({ POLICY_APE_MINOR: rp(20_000_000), COMMISSION_PCT: 20, OVERRIDING_PCT: 10, BONUS_PCT: 10 });
    expect(BILLING_INCOME_PER_POLICY_MINOR).toBe(rp(8_000_000));
  });

  it('P19.4-T3 AC-10 a plan is six months or annual, and runs 6 or 12 months', () => {
    expect(SUBSCRIPTION_PLANS).toEqual(['six_months', 'annual']);
    expect(SUBSCRIPTION_PLAN_MONTHS).toEqual({ six_months: 6, annual: 12 });
  });
});
