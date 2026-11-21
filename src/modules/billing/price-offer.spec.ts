import { BILLING_PRICE_TIERS } from '@/domain/constants';
import fixture from './price-offer.fixture.json';
import { OfferInputError, priceOffer, tierFor, type OfferInput } from './price-offer';

/**
 * **The calculator's arithmetic** (P19.23-T5 AC-2; ADR-0279 §2). Every figure in the shared fixture, which the frontend's
 * copy of the function is held to as well, so the two cannot price one input differently.
 */
const rp = (major: number) => major * 100;

describe('priceOffer — the shared fixture (P19.23-T5)', () => {
  it.each(fixture.cases.map((c) => [c.case, c] as const))('P19.23-T5 AC-2 %s', (_name, c) => {
    const { tier, leaders, agents, plan, ...figures } = priceOffer(c.input as OfferInput);
    expect({ tierCode: tier.code, ...figures }).toEqual(c.expected);
    expect([leaders, agents, plan]).toEqual([c.input.leaders, c.input.agents, c.input.plan]);
  });

  it.each(fixture.refusals.map((r) => [r.case, r] as const))('P19.23-T5 AC-2 refuses %s, naming the field', (_name, r) => {
    expect(() => priceOffer(r.input as OfferInput)).toThrow(OfferInputError);
    try {
      priceOffer(r.input as OfferInput);
    } catch (err) {
      expect((err as OfferInputError).field).toBe(r.field);
    }
  });
});

describe('priceOffer — the rules, one at a time (P19.23-T5 AC-2)', () => {
  const base: OfferInput = {
    leaders: 22, agents: null, plan: 'annual', price: { mode: 'per_leader', rateMinor: rp(350_000) }, bulk: null,
  };

  it('P19.23-T5 AC-2 the breakdown sums exactly: Harga normal − Diskon harga − Hemat tahunan − bulk = Total', () => {
    for (const c of fixture.cases) {
      const p = priceOffer(c.input as OfferInput);
      if (p.normalMinor !== null && p.normalMinor >= p.grossMinor) {
        expect(p.normalMinor - p.priceDiscountMinor - p.annualDiscountMinor - p.bulkDiscountMinor).toBe(p.totalMinor);
      }
      expect(p.grossMinor - p.annualDiscountMinor - p.bulkDiscountMinor).toBe(p.totalMinor);
    }
  });

  it('P19.23-T5 AC-2 Tahunan takes 5% off the gross; 6 bulan takes nothing', () => {
    expect(priceOffer(base).annualDiscountMinor).toBe(rp(4_620_000));
    expect(priceOffer({ ...base, plan: 'six_months' }).annualDiscountMinor).toBe(0);
  });

  it('P19.23-T5 AC-2 the bulk discount comes off after the annual discount', () => {
    const p = priceOffer({ ...base, bulk: { type: 'percent', percent: 10 } });
    expect(p.bulkDiscountMinor).toBe(rp(8_778_000));
    expect(p.totalMinor).toBe(rp(79_002_000));
  });

  it('P19.23-T5 AC-2 agents are never billed: the total is the same with or without them', () => {
    expect(priceOffer({ ...base, agents: 80 }).totalMinor).toBe(priceOffer(base).totalMinor);
    expect(priceOffer({ ...base, agents: 0 }).perAgentPerDayMinor).toBeNull();
  });

  it('P19.23-T5 AC-2 per leader / hari = total ÷ months ÷ 30 ÷ leaders, to the nearest Rp 100', () => {
    // 87.780.000 ÷ 12 ÷ 30 ÷ 22 = 11.081,8 → Rp 11.100.
    expect(priceOffer(base).perLeaderPerDayMinor).toBe(rp(11_100));
  });

  it('P19.23-T5 AC-2 Balik modal reads Rp 8.000.000 a policy: APE 20 juta × (20% + 10% + 10%)', () => {
    const p = priceOffer(base);
    expect(p.breakEven.incomePerPolicyMinor).toBe(rp(8_000_000));
    // 87.780.000 ÷ 8.000.000 = 10,97 → 11,0 a year; ÷ 12 = 0,91 → 0,9 a month.
    expect(p.breakEven).toMatchObject({ policiesPerPeriodTenths: 110, policiesPerMonthTenths: 9 });
  });

  it('P19.23-T5 AC-3 101+ is Harga khusus: no Harga normal, no saving', () => {
    const p = priceOffer({ ...base, leaders: 101, price: { mode: 'per_leader', rateMinor: rp(250_000) } });
    expect(p.tier.code).toBe('TIER_101_PLUS');
    expect([p.normalMinor, p.savingMinor, p.savingPct, p.priceDiscountMinor]).toEqual([null, 0, 0, 0]);
  });

  it('P19.23-T5 AC-2 the tier is the first whose bounds hold the count', () => {
    expect([1, 10, 11, 20, 21, 50, 51, 100, 101, 5000].map((n) => tierFor(n).code)).toEqual([
      'TIER_1_10', 'TIER_1_10', 'TIER_11_20', 'TIER_11_20', 'TIER_21_50', 'TIER_21_50',
      'TIER_51_100', 'TIER_51_100', 'TIER_101_PLUS', 'TIER_101_PLUS',
    ]);
    expect(tierFor(0, BILLING_PRICE_TIERS).code).toBe('TIER_1_10');
  });

  it('P19.23-T5 AC-2 refuses a total above the price ceiling × leaders × months', () => {
    expect(() => priceOffer({ ...base, leaders: 1, plan: 'six_months', price: { mode: 'total', totalMinor: rp(600_000_100) } }))
      .toThrow(OfferInputError);
  });
});
