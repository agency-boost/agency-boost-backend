import { PRODUCT_DATA } from '@/domain/constants';
import {
  benefitOfPremium, calculate, ceilTo, floorTo, offeredFrequencies, premiumOfPlan, premiumOfUp, rowMatches, rowsFor,
  toMicros, unitOf, upOfPremium, withinTolerance, type EngineRequest, type EngineRow, type EngineTable,
} from './premium-engine';
import type { FrequencyFactors, RateRules } from './rate-table.schema';

/** Rp → minor units. */
const rp = (rupiah: number) => rupiah * 100;
const JT = 1_000_000;

const NO_RULES: RateRules = {
  upStep: null, upMin: null, upMax: null, premiumMin: null, premiumMax: null, entryAgeMin: null, entryAgeMax: null, payTermMaxAge: {},
};
const FACTORS: FrequencyFactors = { monthly: 0.09, quarterly: 0.27, semiannual: 0.52, annual: null };

const row = (over: Partial<EngineRow> = {}): EngineRow => ({
  age: 35, gender: 'male', smoker: false, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille',
  rate: 12.35, bandMin: null, bandMax: null, ...over,
});

/** A small PCB88-like table: age 35, both genders, a smoker rate, 10 years and single. */
const ROWS: EngineRow[] = [
  row(),
  row({ gender: 'female', rate: 10.5 }),
  row({ smoker: true, rate: 15.2 }),
  row({ payTerm: 'single', rate: 98.4 }),
];

const table = (over: Partial<EngineTable> = {}): EngineTable => ({
  rows: ROWS, rules: { ...NO_RULES, upStep: rp(JT) }, frequencies: FACTORS, ageRated: true, ...over,
});

const req = (over: Partial<EngineRequest> = {}): EngineRequest => ({
  calcType: 'up_premium',
  profile: { age: 35, gender: 'male', smoker: false, plan: null, payTerm: 'y10', currency: 'IDR' },
  payFrequency: 'monthly', singlePayTerm: false, fixed: 'up', up: rp(500 * JT), premium: null, goal: null, ...over,
});

describe('P19.15-T1 the premium engine (ADR-0258 §4, §5)', () => {
  describe('P19.15-T1 AC-5 exact money: integer micros and one rounding, half up, to Rp1', () => {
    it('reads a decimal as micros, exactly', () => {
      expect(toMicros(12.35)).toBe(12_350_000n);
      expect(toMicros(0.0875)).toBe(87_500n);
    });

    it('rounds to the currency’s unit: Rp1 is 100 sen, a cent is 1', () => {
      expect(unitOf('IDR')).toBe(PRODUCT_DATA.ROUNDING_UNIT_MINOR.IDR);
      expect(unitOf('USD')).toBe(1);
    });

    it('rounds an amount down and up to a step', () => {
      expect(floorTo(rp(539_811_066), rp(JT))).toBe(rp(539 * JT));
      expect(ceilTo(rp(99_500_000), rp(JT))).toBe(rp(100 * JT));
      expect(ceilTo(rp(100 * JT), rp(JT))).toBe(rp(100 * JT));
    });

    it('UP → premium: UP × rate ÷ 1.000 × factor, half up', () => {
      // Rp500 jt × 12,35 ‰ = Rp6.175.000 a year; × 0,09 = Rp555.750 a month.
      expect(premiumOfUp(rp(500 * JT), toMicros(12.35), toMicros(1), 100)).toBe(rp(6_175_000));
      expect(premiumOfUp(rp(500 * JT), toMicros(12.35), toMicros(0.09), 100)).toBe(rp(555_750));
      // Rp539 jt × 12,35 ‰ × 0,09 = Rp599.098,50 → Rp599.099 (half up).
      expect(premiumOfUp(rp(539 * JT), toMicros(12.35), toMicros(0.09), 100)).toBe(rp(599_099));
    });

    it('premium → UP, rounded down to a minor unit; no UP from a zero rate', () => {
      expect(upOfPremium(rp(6_175_000), toMicros(12.35), toMicros(1))).toBe(rp(500 * JT));
      expect(upOfPremium(rp(1), 0n, toMicros(1))).toBeNull();
    });

    it('a plan’s premium: the annual premium × the factor', () => {
      expect(premiumOfPlan(rp(4_800_000), toMicros(0.09), 100)).toBe(rp(432_000));
    });

    it('premium → benefit: the annual premium × rate ÷ 1.000, rounded down; none from a zero factor', () => {
      // Rp500.000 a month ÷ 0,09 = Rp5.555.555,55 a year; × 20.000 ‰ = Rp111.111.111.
      expect(benefitOfPremium(rp(500_000), toMicros(20_000 / 1000 * 1000), toMicros(0.09), 100)).toBe(rp(111_111_111));
      expect(benefitOfPremium(rp(1), toMicros(1), 0n, 100)).toBeNull();
    });
  });

  describe('P19.15-T1 AC-5 a row for the profile, never a neighbour’s', () => {
    const p = req().profile;
    it('matches every attribute, `null` in a row for any; a smoker not asked reads Tidak', () => {
      expect(rowMatches(row(), p)).toBe(true);
      expect(rowMatches(row({ age: 36 }), p)).toBe(false);
      expect(rowMatches(row({ age: null }), p)).toBe(true);
      expect(rowMatches(row({ gender: 'female' }), p)).toBe(false);
      expect(rowMatches(row({ smoker: true }), p)).toBe(false);
      expect(rowMatches(row({ smoker: false }), { ...p, smoker: null })).toBe(true);
      expect(rowMatches(row({ plan: 'MAX' }), p)).toBe(false);
      expect(rowMatches(row({ payTerm: 'y15' }), p)).toBe(false);
      expect(rowMatches(row({ currency: 'USD' }), p)).toBe(false);
    });

    it('a Cara bayar from rows of its own, else from annual rows and its factor, never an assumed 12×', () => {
      const direct = [row({ frequency: 'monthly', rate: 1.1 }), row()];
      expect(rowsFor(direct, 'monthly', FACTORS, false)).toEqual({ rows: [direct[0]], factor: 1_000_000n });
      expect(rowsFor([row()], 'monthly', FACTORS, false)).toEqual({ rows: [row()], factor: 90_000n });
      expect(rowsFor([row()], 'annual', FACTORS, false)).toEqual({ rows: [row()], factor: 1_000_000n });
      expect(rowsFor([row()], 'annual', { ...FACTORS, annual: 1 }, false)).toEqual({ rows: [row()], factor: 1_000_000n });
      expect(rowsFor([row()], 'monthly', { ...FACTORS, monthly: null }, false)).toBe('no_frequency');
      expect(rowsFor([], 'monthly', FACTORS, false)).toBe('missing_combination');
      expect(rowsFor([row({ frequency: 'quarterly' })], 'monthly', FACTORS, false)).toBe('no_frequency');
      expect(rowsFor([row()], 'single', FACTORS, true)).toEqual({ rows: [row()], factor: 1_000_000n });
      expect(rowsFor([row()], 'single', FACTORS, false)).toBe('no_frequency');
      expect(rowsFor([row()], 'monthly', FACTORS, true)).toBe('no_frequency');
    });

    it('of two rows that price the profile, the one that names it more exactly', () => {
      const rows = [row({ age: null, gender: null, rate: 99 }), row()];
      expect(calculate(table({ rows }), req({ payFrequency: 'annual' })).premium).toBe(rp(6_175_000));
    });

    it('offers only the Cara bayar the table prices', () => {
      expect(offeredFrequencies([row()], FACTORS, false)).toEqual(['monthly', 'quarterly', 'semiannual', 'annual']);
      expect(offeredFrequencies([row()], { ...FACTORS, quarterly: null, semiannual: null }, false)).toEqual(['monthly', 'annual']);
      expect(offeredFrequencies([row({ frequency: 'monthly' })], FACTORS, false)).toEqual(['monthly']);
      expect(offeredFrequencies([row()], FACTORS, true)).toEqual(['single']);
      expect(offeredFrequencies([], FACTORS, false)).toEqual([]);
    });
  });

  describe('P19.15-T1 AC-5 up_premium: both ways', () => {
    it('typing the UP gives the premium, the fixed field kept', () => {
      const r = calculate(table(), req());
      expect(r).toMatchObject({ state: 'ok', up: rp(500 * JT), premium: rp(555_750), fixed: 'up', note: null, annualPremium: rp(6_175_000) });
      expect(r.frequencies).toEqual(['monthly', 'quarterly', 'semiannual', 'annual']);
    });

    it('typing the premium gives the UP rounded down to the step, and the premium again from it — with the note', () => {
      const r = calculate(table(), req({ fixed: 'premium', up: null, premium: rp(600_000) }));
      expect(r).toMatchObject({ state: 'ok', fixed: 'premium', up: rp(539 * JT), premium: rp(599_099), note: 'up_rounded', stepMinor: rp(JT) });
    });

    it('no note when the premium lands on the step exactly', () => {
      const r = calculate(table(), req({ fixed: 'premium', up: null, premium: rp(555_750) }));
      expect(r).toMatchObject({ up: rp(500 * JT), premium: rp(555_750), note: null, stepMinor: null });
    });

    it('without a UP step the UP is rounded to Rp1', () => {
      const r = calculate(table({ rules: NO_RULES }), req({ fixed: 'premium', up: null, premium: rp(600_000) }));
      expect(r.up! % 100).toBe(0);
      expect(r.up).toBe(rp(539_811_066));
    });

    it('nothing typed: needs an amount, and the other amount is emptied', () => {
      expect(calculate(table(), req({ fixed: 'up', up: null, premium: rp(1) }))).toMatchObject({ state: 'needs_amount', premium: null });
      expect(calculate(table(), req({ fixed: 'none', up: null, premium: null }))).toMatchObject({ state: 'needs_amount' });
    });

    it('a change of Cara bayar keeps the UP and works the premium out again (ADR-0258 §5)', () => {
      const r = calculate(table(), req({ fixed: 'premium', up: rp(500 * JT), premium: null, payFrequency: 'annual', frequencyChanged: true }));
      expect(r).toMatchObject({ fixed: 'up', premium: rp(6_175_000) });
      // A premium cleared by hand is not the same: nothing to calculate from.
      expect(calculate(table(), req({ fixed: 'premium', up: rp(500 * JT), premium: null }))).toMatchObject({ state: 'needs_amount', up: null });
    });

    it('the smoker rate, the female rate, the single premium', () => {
      expect(calculate(table(), req({ profile: { ...req().profile, smoker: true }, payFrequency: 'annual' })).premium).toBe(rp(7_600_000));
      expect(calculate(table(), req({ profile: { ...req().profile, gender: 'female' }, payFrequency: 'annual' })).premium).toBe(rp(5_250_000));
      const single = calculate(table(), req({ profile: { ...req().profile, payTerm: 'single' }, payFrequency: 'single', singlePayTerm: true }));
      expect(single).toMatchObject({ premium: rp(49_200_000), frequencies: ['single'] });
    });

    it('USD stays USD: a cent is the unit', () => {
      const usd = [row({ currency: 'USD', rate: 12.35 })];
      const r = calculate(table({ rows: usd, rules: NO_RULES }), req({ profile: { ...req().profile, currency: 'USD' }, up: 100_000_00, payFrequency: 'monthly' }));
      // $100.000 × 12,35 ‰ × 0,09 = $111,15.
      expect(r.premium).toBe(111_15);
    });
  });

  describe('P19.15-T1 AC-5 a per_band table finds the band the UP falls in', () => {
    const bands = [
      row({ basis: 'per_band', bandMin: rp(100 * JT), bandMax: rp(499 * JT), rate: 13 }),
      row({ basis: 'per_band', bandMin: rp(500 * JT), bandMax: rp(5_000 * JT), rate: 12 }),
    ];
    it('UP → premium at its band’s rate', () => {
      expect(calculate(table({ rows: bands }), req({ payFrequency: 'annual' })).premium).toBe(rp(6 * JT));
      expect(calculate(table({ rows: bands }), req({ up: rp(200 * JT), payFrequency: 'annual' })).premium).toBe(rp(2_600_000));
    });
    it('premium → UP: the band whose own rate gives a UP inside it', () => {
      expect(calculate(table({ rows: bands }), req({ fixed: 'premium', up: null, premium: rp(6 * JT), payFrequency: 'annual' })))
        .toMatchObject({ up: rp(500 * JT), premium: rp(6 * JT) });
    });
    it('a UP outside every band is a combination the table lacks', () => {
      expect(calculate(table({ rows: bands }), req({ up: rp(50 * JT) }))).toMatchObject({ state: 'missing_combination', premium: null });
      expect(calculate(table({ rows: bands }), req({ fixed: 'premium', up: null, premium: rp(1) }))).toMatchObject({ state: 'missing_combination', up: null });
    });
    it('a zero rate gives no UP', () => {
      expect(calculate(table({ rows: [row({ rate: 0 })] }), req({ fixed: 'premium', up: null, premium: rp(100) }))).toMatchObject({ state: 'missing_combination' });
    });
  });

  describe('P19.15-T1 AC-5 stale numbers never print: the calculated field is emptied, with why', () => {
    it('a combination missing from the table', () => {
      const r = calculate(table(), req({ profile: { ...req().profile, payTerm: 'y15' } }));
      expect(r).toMatchObject({ state: 'missing_combination', up: rp(500 * JT), premium: null });
    });
    it('a Cara bayar the table does not price', () => {
      const r = calculate(table({ frequencies: { ...FACTORS, monthly: null } }), req());
      expect(r).toMatchObject({ state: 'no_frequency', premium: null });
      expect(r.frequencies).toEqual(['quarterly', 'semiannual', 'annual']);
    });
    it('an age or a gender the table prices by and the card lacks', () => {
      expect(calculate(table(), req({ profile: { ...req().profile, age: null } }))).toMatchObject({ state: 'needs_input', missing: 'age' });
      expect(calculate(table({ ageRated: false, rows: [row({ age: null, gender: null })] }), req({ profile: { ...req().profile, age: null } })).state).toBe('ok');
      expect(calculate(table(), req({ profile: { ...req().profile, gender: null } }))).toMatchObject({ state: 'needs_input', missing: 'gender' });
    });
    it('an age outside the version’s entry ages, or past the pay term’s maximum', () => {
      const rules = { ...NO_RULES, entryAgeMin: 18, entryAgeMax: 60, payTermMaxAge: { y10: 30 } };
      expect(calculate(table({ rules }), req())).toMatchObject({ state: 'age_outside', ageBounds: { min: 18, max: 30 }, premium: null });
      expect(calculate(table({ rules: { ...rules, payTermMaxAge: {} } }), req({ profile: { ...req().profile, age: 17 } })))
        .toMatchObject({ state: 'age_outside', ageBounds: { min: 18, max: 60 } });
      expect(calculate(table({ rules: { ...NO_RULES, entryAgeMax: 30 } }), req({ fixed: 'premium', premium: rp(1), up: rp(1) })))
        .toMatchObject({ state: 'age_outside', premium: rp(1), up: null });
      expect(calculate(table({ rules: { ...NO_RULES, payTermMaxAge: { y15: 30 } } }), req()).state).toBe('ok');
    });
  });

  describe('P19.15-T1 AC-5 limits: one message and the nearest allowed value; nothing changed silently', () => {
    const rules = { ...NO_RULES, upStep: rp(JT), upMin: rp(100 * JT), upMax: rp(2_000 * JT), premiumMin: rp(1_500_000), premiumMax: rp(20 * JT) };
    it('below the least UP: the chip is the least UP on the step; the amounts stay', () => {
      const r = calculate(table({ rules }), req({ up: rp(50 * JT) }));
      expect(r).toMatchObject({ state: 'ok', up: rp(50 * JT), limit: { kind: 'up_min', limitMinor: rp(100 * JT), chip: { field: 'up', amountMinor: rp(100 * JT) } } });
    });
    it('above the most UP: the most on the step', () => {
      const r = calculate(table({ rules: { ...rules, upMax: rp(1_999_500_000) } }), req({ up: rp(3_000 * JT) }));
      expect(r.limit).toEqual({ kind: 'up_max', limitMinor: rp(1_999_500_000), chip: { field: 'up', amountMinor: rp(1_999 * JT) } });
    });
    it('a premium below the least per year: the least UP that reaches it', () => {
      const r = calculate(table({ rules: { ...rules, upMin: null } }), req({ up: rp(100 * JT) }));
      // Rp100 jt is Rp1.235.000 a year; Rp1,5 jt needs Rp121.457.490 → Rp122 jt on the step.
      expect(r.limit).toEqual({ kind: 'premium_min', limitMinor: rp(1_500_000), chip: { field: 'up', amountMinor: rp(122 * JT) } });
    });
    it('a premium above the most per year: the most UP that stays under it', () => {
      const r = calculate(table({ rules: { ...rules, upMax: null } }), req({ up: rp(1_800 * JT) }));
      expect(r.limit).toEqual({ kind: 'premium_max', limitMinor: rp(20 * JT), chip: { field: 'up', amountMinor: rp(1_619 * JT) } });
    });
    it('a premium limit is not read where the table states no annual premium', () => {
      const monthlyOnly = [row({ frequency: 'monthly', rate: 1 })];
      expect(calculate(table({ rows: monthlyOnly, rules: { ...rules, upMin: null } }), req({ up: rp(10 * JT) })).limit).toBeNull();
    });
    it('within every limit: none', () => {
      expect(calculate(table({ rules }), req()).limit).toBeNull();
    });
  });

  describe('P19.15-T1 AC-5 goal, premium_benefit, plan_priced, manual', () => {
    it('goal: the goal gives the premium; nothing without it; missing without a rate', () => {
      expect(calculate(table(), req({ calcType: 'goal', fixed: 'goal', goal: rp(200 * JT), up: null, payFrequency: 'annual' })))
        .toMatchObject({ state: 'ok', fixed: 'goal', premium: rp(2_470_000) });
      expect(calculate(table(), req({ calcType: 'goal', goal: null }))).toMatchObject({ state: 'needs_amount', premium: null });
      expect(calculate(table({ rows: [row({ basis: 'per_plan', rate: rp(1) })] }), req({ calcType: 'goal', goal: rp(1) })).state).toBe('missing_combination');
    });
    it('goal limits: the goal that reaches the nearest allowed premium', () => {
      const min = calculate(table({ rules: { ...NO_RULES, premiumMin: rp(3 * JT) } }), req({ calcType: 'goal', goal: rp(200 * JT) }));
      expect(min.limit).toMatchObject({ kind: 'premium_min', chip: { field: 'goal' } });
      expect(premiumOfUp(min.limit!.chip!.amountMinor, toMicros(12.35), 1_000_000n, 100)).toBeGreaterThanOrEqual(rp(3 * JT));
      const max = calculate(table({ rules: { ...NO_RULES, premiumMax: rp(2 * JT) } }), req({ calcType: 'goal', goal: rp(200 * JT) }));
      expect(max.limit).toMatchObject({ kind: 'premium_max', chip: { field: 'goal' } });
      expect(premiumOfUp(max.limit!.chip!.amountMinor, toMicros(12.35), 1_000_000n, 100)).toBeLessThanOrEqual(rp(2 * JT));
      expect(calculate(table({ rows: [row({ frequency: 'monthly' })] }), req({ calcType: 'goal', goal: rp(1) })).limit).toBeNull();
      expect(calculate(table(), req({ calcType: 'goal', goal: rp(200 * JT) })).limit).toBeNull();
    });
    it('premium_benefit: the premium gives the benefit, answered as up', () => {
      const benefit = [row({ rate: 20_000 })];
      const r = calculate(table({ rows: benefit }), req({ calcType: 'premium_benefit', fixed: 'premium', premium: rp(500_000), up: null }));
      expect(r).toMatchObject({ state: 'ok', fixed: 'premium', premium: rp(500_000), up: rp(111_111_111) });
      expect(calculate(table({ rows: benefit }), req({ calcType: 'premium_benefit', premium: null }))).toMatchObject({ state: 'needs_amount', up: null });
      expect(calculate(table({ rows: [row({ basis: 'per_plan' })] }), req({ calcType: 'premium_benefit', premium: rp(1) })).state).toBe('missing_combination');
    });
    it('premium_benefit limits: the premium of this Cara bayar that reaches the least, or stays under the most', () => {
      const min = calculate(table({ rules: { ...NO_RULES, premiumMin: rp(12 * JT) } }), req({ calcType: 'premium_benefit', premium: rp(500_000) }));
      expect(min.limit).toEqual({ kind: 'premium_min', limitMinor: rp(12 * JT), chip: { field: 'premium', amountMinor: rp(1_080_000) } });
      const max = calculate(table({ rules: { ...NO_RULES, premiumMax: rp(1 * JT) } }), req({ calcType: 'premium_benefit', premium: rp(500_000) }));
      expect(max.limit).toEqual({ kind: 'premium_max', limitMinor: rp(JT), chip: { field: 'premium', amountMinor: rp(90_000) } });
      expect(calculate(table(), req({ calcType: 'premium_benefit', premium: rp(500_000) })).limit).toBeNull();
    });
    it('plan_priced: the plan’s premium × the factor; a limit has no chip', () => {
      const plans = [row({ basis: 'per_plan', plan: 'Silver', rate: rp(4_800_000) })];
      const p = { ...req().profile, plan: 'Silver' };
      expect(calculate(table({ rows: plans }), req({ calcType: 'plan_priced', profile: p, fixed: 'none' })))
        .toMatchObject({ state: 'ok', fixed: 'none', premium: rp(432_000), annualPremium: rp(4_800_000) });
      expect(calculate(table({ rows: plans }), req({ calcType: 'plan_priced', profile: { ...p, plan: 'Gold' } }))).toMatchObject({ state: 'missing_combination', premium: null });
      expect(calculate(table({ rows: [row()] }), req({ calcType: 'plan_priced', profile: p })).state).toBe('missing_combination');
      const limited = calculate(table({ rows: plans, rules: { ...NO_RULES, premiumMin: rp(5 * JT) } }), req({ calcType: 'plan_priced', profile: p }));
      expect(limited.limit).toEqual({ kind: 'premium_min', limitMinor: rp(5 * JT), chip: null });
      expect(calculate(table({ rows: [row({ basis: 'per_plan', plan: 'Silver', rate: rp(1), frequency: 'monthly' })] }), req({ calcType: 'plan_priced', profile: p }))).toMatchObject({ annualPremium: null, limit: null });
    });
    it('manual: nothing calculated', () => {
      expect(calculate(table(), req({ calcType: 'manual', premium: rp(5), up: null }))).toMatchObject({ state: 'ok', premium: rp(5), up: null });
    });
  });

  describe('P19.15-T1 AC-2 within Rp1', () => {
    it('matches within one rounding unit, never without a result', () => {
      expect(withinTolerance(rp(599_099), rp(599_098), 'IDR')).toBe(true);
      expect(withinTolerance(rp(599_100), rp(599_098), 'IDR')).toBe(false);
      expect(withinTolerance(111_16, 111_15, 'USD')).toBe(true);
      expect(withinTolerance(null, 0, 'IDR')).toBe(false);
    });
  });
});
