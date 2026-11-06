import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BILLING_PRICE_TIERS, SUBSCRIPTION_PLAN_MONTHS, SUBSCRIPTION_PLANS } from '@/domain/constants';
import { priceQuote, QuoteInputError, tierFor, type QuoteInput } from './price-quote';

/** The one fixture both copies of the function read (`frontend/src/lib/billing.spec.ts` reads it from this tree). */
interface FixtureCase {
  case: string;
  input: QuoteInput;
  expected: {
    tierCode: string; baseMinor: number; finalMinor: number; monthlyTotalMinor: number; periodTotalMinor: number;
    annualDiscountMinor: number; manualDiscountMinor: number;
  };
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'price-quote.fixture.json'), 'utf8')) as { cases: FixtureCase[] };

describe('P19.4-T3 AC-10 the quote is priced on the server (ADR-0211 §5)', () => {
  it.each(FIXTURE.cases.map((c) => [c.case, c] as const))(
    'P19.4-T3 AC-10 prices the fixture’s case: %s', (_name, { input, expected }) => {
      const priced = priceQuote(input);
      expect({
        tierCode: priced.tier.code,
        baseMinor: priced.baseMinor,
        finalMinor: priced.finalMinor,
        monthlyTotalMinor: priced.monthlyTotalMinor,
        periodTotalMinor: priced.periodTotalMinor,
        annualDiscountMinor: priced.annualDiscountMinor,
        manualDiscountMinor: priced.manualDiscountMinor,
      }).toEqual(expected);
    },
  );

  it('P19.4-T3 AC-10 the fixture holds the flow doc’s §4.2 rows, the 13-leader Fix among them', () => {
    const named = FIXTURE.cases.map((c) => `${c.input.leaders}·${c.input.plan}`);
    expect(named).toEqual(expect.arrayContaining([
      '8·six_months', '8·annual', '15·six_months', '13·annual', '120·six_months',
    ]));
    const fix = FIXTURE.cases.find((c) => c.input.leaders === 13)!;
    // Rp 331.313 a leader, and every total that rate × 13 exactly — the prototype printed 4.307.063 and 51.684.750.
    expect(fix.expected.finalMinor).toBe(331_313_00);
    expect(fix.expected.monthlyTotalMinor).toBe(4_307_069_00);
    expect(fix.expected.periodTotalMinor).toBe(51_684_828_00);
  });

  it('P19.4-T3 AC-10 every total is the rate × the count × the months, exactly, in integer sen', () => {
    for (const leaders of [1, 7, 13, 44, 101, 250]) {
      for (const plan of SUBSCRIPTION_PLANS) {
        const p = priceQuote({ leaders, plan, discount: { type: 'percent', percent: '7' } });
        expect(p.monthlyTotalMinor).toBe(p.finalMinor * leaders);
        expect(p.periodTotalMinor).toBe(p.monthlyTotalMinor * SUBSCRIPTION_PLAN_MONTHS[plan]);
        expect(Number.isSafeInteger(p.periodTotalMinor)).toBe(true);
        expect(p.finalMinor % 100).toBe(0);
      }
    }
  });

  it('P19.4-T3 AC-10 the tier is the first whose bounds hold the count, the last open', () => {
    expect(tierFor(10).code).toBe('TIER_1_10');
    expect(tierFor(11).code).toBe('TIER_11_20');
    expect(tierFor(100).code).toBe('TIER_51_100');
    expect(tierFor(5000).code).toBe('TIER_101_PLUS');
    expect(tierFor(0).code).toBe(BILLING_PRICE_TIERS[0].code);
  });

  it('P19.4-T3 AC-10 refuses what the browser would refuse: a count below 1, a percent above 100, an amount above the rate', () => {
    const refused = (input: QuoteInput) => {
      try {
        priceQuote(input);
      } catch (err) {
        return (err as QuoteInputError).field;
      }
      return null;
    };
    expect(refused({ leaders: 0, plan: 'annual', discount: null })).toBe('leaders');
    expect(refused({ leaders: 2.5, plan: 'annual', discount: null })).toBe('leaders');
    expect(refused({ leaders: 8, plan: 'annual', discount: { type: 'percent', percent: '100.5' } })).toBe('discount.percent');
    expect(refused({ leaders: 8, plan: 'annual', discount: { type: 'percent', percent: '10,5' } })).toBe('discount.percent');
    expect(refused({ leaders: 8, plan: 'annual', discount: { type: 'percent', percent: '-1' } })).toBe('discount.percent');
    expect(refused({ leaders: 8, plan: 'six_months', discount: { type: 'flat', amountMinor: 40_000_100 } })).toBe('discount.amountMinor');
    expect(refused({ leaders: 8, plan: 'six_months', discount: { type: 'flat', amountMinor: 150 } })).toBe('discount.amountMinor');
    expect(refused({ leaders: 8, plan: 'six_months', discount: { type: 'flat', amountMinor: -100 } })).toBe('discount.amountMinor');
    expect(refused({ leaders: 8, plan: 'six_months', discount: { type: 'flat', amountMinor: 40_000_000 } })).toBeNull();
  });
});
