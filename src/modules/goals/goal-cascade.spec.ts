import type { DomainException } from '@/common/errors/domain.exception';
import type { Sentence } from '@/common/i18n/sentence';
import { GOAL_DEFAULTS, RATIO_BENCHMARKS, SEED_RATIO_DEFINITIONS, TIME } from '@/domain/constants';
import { english, indonesian, indonesianAll } from '../../../test/i18n';
import {
  annualTargetOf, cascadeCounts, clampMonths, computeCascade, defaultMonthsLeft, defaultRates, policiesPerWeekOf,
  weeklyOf, type CascadeInputs,
} from './goal-cascade';

const JAKARTA = 'Asia/Jakarta';

/**
 * The five-step cascade (P8-T2).
 *
 * **Half the phase's exit criterion lives in this file**: *every default and formula is pinned by a
 * test citing the prototype line it came from*. Every number below carries its citation, so a value
 * that drifts fails here rather than in somebody's plan.
 */
describe('the goal cascade', () => {
  /** The prototype's own defaults, as the registry holds them (`Overall.html:2872-2996`). */
  const defaults: CascadeInputs = {
    mode: 'direct',
    annualApeTargetMinor: GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR,
    savingsTargetMinor: GOAL_DEFAULTS.ANNUAL_SAVINGS_TARGET_MINOR,
    commissionRatePct: GOAL_DEFAULTS.COMMISSION_RATE_PCT,
    monthsLeft: 5,
    apeAchievedMinor: 0,
    caseSizeMinor: GOAL_DEFAULTS.CASE_SIZE_MINOR,
    leadsToApptPct: GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT,
    closingRatePct: GOAL_DEFAULTS.CLOSING_RATE_PCT,
  };

  describe('AC-2 — the defaults are the registry’s, and the registry is the prototype’s', () => {
    it('holds the four numbers the screen opens with', () => {
      // `Overall.html:2872` / `:2884` / `:2893` / `:2954` — the default inputs, and `:5919`,
      // `:5935`, `:5940` where the calculator reads them back.
      expect(GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR).toBe(500_000_000_00);
      expect(GOAL_DEFAULTS.ANNUAL_SAVINGS_TARGET_MINOR).toBe(50_000_000_00);
      expect(GOAL_DEFAULTS.COMMISSION_RATE_PCT).toBe(10);
      expect(GOAL_DEFAULTS.CASE_SIZE_MINOR).toBe(18_000_000_00);
    });

    it('holds the two conversion rates', () => {
      // `Overall.html:2987` and `:2996`.
      expect(GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT).toBe(30);
      expect(GOAL_DEFAULTS.CLOSING_RATE_PCT).toBe(30);
    });

    it('holds the two time conversions', () => {
      // `Overall.html:5751` (30.44 days) and `:5818` (4.33 weeks).
      expect(TIME.AVG_DAYS_PER_MONTH).toBe(30.44);
      expect(TIME.WEEKS_PER_MONTH).toBe(4.33);
    });

    it('reproduces the prototype’s own default check', () => {
      // `goal-settings.md` §4: 50,000,000 / 0.10 = 500,000,000, matching the static result tile.
      const derived = annualTargetOf({ ...defaults, mode: 'from_savings' });

      expect(derived).toBe(GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR);
    });
  });

  describe('AC-1 — the five steps (`Overall.html:5798-5822`)', () => {
    it('computes the numbers the flow doc works out by hand', () => {
      /*
       * `goal-settings.md` §5: with the defaults over five months,
       *   ape          = 500,000,000 / 5  = 100,000,000
       *   policies     = ceil(100M / 18M) =   6
       *   appointments = ceil(6 / 0.30)   =  20
       *   leads        = ceil(20 / 0.30)  =  67
       *
       * The shipped markup reads **80 / 24**, which the calculator never produces. Those are stale
       * hand-written mock values, and this is the test that says which of the two is the product.
       */
      const out = computeCascade(defaults);

      expect(out.monthlyApeTargetMinor).toBe(100_000_000_00);
      expect(out.policiesPerMonth).toBe(6);
      expect(out.appointmentsPerMonth).toBe(20);
      expect(out.leadsPerMonth).toBe(67);
    });

    it('subtracts what has been produced before dividing', () => {
      // `:5798` — `remaining = max(0, annualTarget − achieved)`, then `remaining / monthsLeft`.
      const out = computeCascade({ ...defaults, apeAchievedMinor: 250_000_000_00 });

      expect(out.remainingApeMinor).toBe(250_000_000_00);
      expect(out.monthlyApeTargetMinor).toBe(50_000_000_00);
    });

    it('divides the appointments’ and leads’ weekly sub-lines by 4.33 and ceils, like every other step', () => {
      // `:5827`, `:5831`. Counts to do, so whole and rounded up (ADR-0160 §5).
      expect(weeklyOf(20)).toBe(5);
      expect(weeklyOf(67)).toBe(16);
    });

    it('P18.8-T10 AC-2 writes policies per week to one decimal: six a month is 1.4, not ≈ 2', () => {
      // ADR-0160 §5: the monthly policies ÷ 4.33, to a tenth — the same 4.33 as every weekly figure.
      expect(policiesPerWeekOf(6)).toBe(1.4);
      expect(policiesPerWeekOf(7)).toBe(1.6);
      expect(policiesPerWeekOf(20)).toBe(4.6);
      // A whole figure comes back whole: the screen drops nothing, because there is no `.0` to drop.
      expect(policiesPerWeekOf(0)).toBe(0);
      expect(String(policiesPerWeekOf(13))).toBe('3');
      expect(policiesPerWeekOf(6)).toBe(Math.round((6 / TIME.WEEKS_PER_MONTH) * 10) / 10);
    });

    it('P18.8-T10 AC-2 gives step 3 and step 5 the one policies-per-week figure, the other two whole', () => {
      const out = computeCascade(defaults);

      expect(out.policiesPerWeek).toBe(1.4);
      expect(out.appointmentsPerWeek).toBe(5);
      expect(out.leadsPerWeek).toBe(16);
    });

    it('lets the ceils compound, which over-states slightly and is the safe direction', () => {
      // `ceil(ceil(ape / caseSize) / closingPct)`, then ceil again. 6 policies at 30% is 20
      // appointments, not 19.99 — and a target that rounds down is a target that is missed.
      const out = computeCascade({ ...defaults, caseSizeMinor: 17_000_000_00 });

      expect(out.policiesPerMonth).toBe(6);
      expect(out.appointmentsPerMonth).toBe(20);
    });
  });

  describe('the two entry modes (`Overall.html:5780-5791`)', () => {
    it('takes the annual target as typed, in direct mode', () => {
      expect(annualTargetOf({ ...defaults, annualApeTargetMinor: 300_000_000_00 }))
        .toBe(300_000_000_00);
    });

    it('divides the savings target by the commission rate, in from-savings mode', () => {
      // An agent thinks in take-home pay; the agency measures APE.
      expect(annualTargetOf({
        ...defaults, mode: 'from_savings',
        savingsTargetMinor: 30_000_000_00, commissionRatePct: 10,
      })).toBe(300_000_000_00);
    });

    it('refuses a rate of zero rather than answering nothing', () => {
      // The prototype returns 0, which produces a plan of zero leads and hides the reason.
      expect(() => annualTargetOf({ ...defaults, mode: 'from_savings', commissionRatePct: 0 }))
        .toThrow(/commission rate above zero/);
    });

    it('rounds to whole sen, because money is an integer here', () => {
      const out = annualTargetOf({
        ...defaults, mode: 'from_savings',
        savingsTargetMinor: 10_000_000_00, commissionRatePct: 3,
      });

      expect(Number.isInteger(out)).toBe(true);
    });
  });

  describe('AC-4 — decimals survive, which the prototype’s parser cannot (I-108)', () => {
    it('reads 12.5 as twelve and a half per cent', () => {
      // `parseNum` strips every non-digit, so `12.5` becomes `125`. A plan built on a tenfold
      // error, with nothing on the screen to say so.
      const half = annualTargetOf({
        ...defaults, mode: 'from_savings',
        savingsTargetMinor: 50_000_000_00, commissionRatePct: 12.5,
      });

      expect(half).toBe(400_000_000_00);
    });

    it('reads a decimal case size', () => {
      const out = computeCascade({ ...defaults, caseSizeMinor: 18_500_000_50 });

      expect(out.policiesPerMonth).toBe(6);
    });

    it('reads a decimal conversion rate', () => {
      const out = computeCascade({ ...defaults, closingRatePct: 32.5 });

      // ceil(6 / 0.325) = 19, where 30% gives 20.
      expect(out.appointmentsPerMonth).toBe(19);
    });
  });

  describe('AC-5 — months left is the office’s, and overridable', () => {
    it('counts days to 31 December and divides by 30.44 (`Overall.html:5745-5752`)', () => {
      // 2026-10-01 in Jakarta: 91 days to the 31st, +1 for today, ÷ 30.44 = 3.02 → 3.0.
      const months = defaultMonthsLeft('2026', new Date('2026-10-01T02:00:00Z'), JAKARTA);

      expect(months).toBe(3);
    });

    it('is the office’s day, not the server’s (invariant §9)', () => {
      /*
       * 2026-12-31T17:30Z is already 1 January in Jakarta and still 31 December in New York. The
       * prototype builds `new Date()` in the browser's zone, so an agent and the server behind
       * them disagree about which year it is — and this is the cascade's divisor.
       */
      const jakarta = defaultMonthsLeft('2026', new Date('2026-12-31T17:30:00Z'), JAKARTA);
      const newYork = defaultMonthsLeft('2026', new Date('2026-12-31T17:30:00Z'), 'America/New_York');

      expect(jakarta).toBe(GOAL_DEFAULTS.MONTHS_LEFT_MIN);
      expect(newYork).toBe(0.1);
      // Same instant, different day — and on 31 December that is the difference between a month
      // of runway and none.
      expect(jakarta).toBe(newYork);
    });

    it('keeps one decimal, because 4.3 months is a real answer (`:5752`)', () => {
      expect(clampMonths(4.34)).toBe(4.3);
      expect(clampMonths(4.35)).toBe(4.4);
    });

    it('floors at 0.1 so the cascade never divides by ~0 (`:5752`, `:5796`)', () => {
      expect(clampMonths(0)).toBe(GOAL_DEFAULTS.MONTHS_LEFT_MIN);
      expect(clampMonths(-3)).toBe(0.1);
    });

    it('takes an override, because an agent starting in November knows something the calendar does not', () => {
      const out = computeCascade({ ...defaults, monthsLeft: 2 });

      expect(out.monthlyApeTargetMinor).toBe(250_000_000_00);
    });
  });

  describe('AC-6 — passing the annual target (ADR-0047)', () => {
    it('clamps every figure to zero, and says the target has been met', () => {
      const out = computeCascade({ ...defaults, apeAchievedMinor: 600_000_000_00 });

      expect(out.targetMet).toBe(true);
      expect(out.remainingApeMinor).toBe(0);
      expect(out.monthlyApeTargetMinor).toBe(0);
      expect(out.leadsPerMonth).toBe(0);
    });

    it('is not met while there is real work left, and still asks for it', () => {
      const out = computeCascade({
        ...defaults, apeAchievedMinor: GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR - 1_000_000_00,
      });

      expect(out.targetMet).toBe(false);
      expect(out.leadsPerMonth).toBeGreaterThan(0);
    });

    it('asks for nothing when what is left rounds away, and does not call that met', () => {
      /*
       * One sen short of the target: `targetMet` is false, because it is — and every figure is
       * zero, because a sen buys no policies. The flag says what it says; the screen's own
       * condition for replacing the cascade is *there is nothing to do*, which is wider.
       *
       * Reachable only under about two sen, so this documents the edge rather than guarding a
       * plausible one.
       */
      const out = computeCascade({
        ...defaults, apeAchievedMinor: GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR - 1,
      });

      expect(out.targetMet).toBe(false);
      expect(out.remainingApeMinor).toBe(1);
      expect(out.leadsPerMonth).toBe(0);
    });

    it('is met exactly on the target, not only past it', () => {
      const out = computeCascade({
        ...defaults, apeAchievedMinor: GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR,
      });

      expect(out.targetMet).toBe(true);
    });
  });

  describe('AC-7 — an assumption that cannot make a plan', () => {
    it('refuses a case size of zero rather than coercing it to one rupiah', () => {
      /*
       * `parseNum(caseSize) || 1` — a blank case size becomes **one rupiah**, which produces a
       * target of a hundred million policies and no hint that anything is wrong.
       */
      expect(() => computeCascade({ ...defaults, caseSizeMinor: 0 }))
        .toThrow(/case size must be above zero/);
    });

    it('names the code a client can branch on', () => {
      try {
        computeCascade({ ...defaults, caseSizeMinor: 0 });
        throw new Error('should have refused');
      } catch (err) {
        expect((err as { code: string }).code).toBe('GOAL_INVALID_ASSUMPTION');
        expect((err as { status: number }).status).toBe(422);
      }
    });

    it.each([0, -1, 101])('refuses a conversion rate of %p', (value) => {
      expect(() => computeCascade({ ...defaults, closingRatePct: value }))
        .toThrow(/above 0 and at most 100/);
    });

    it('gathers every unusable assumption, so a form with three hears about three', () => {
      try {
        computeCascade({ ...defaults, caseSizeMinor: 0, closingRatePct: 0, leadsToApptPct: 200 });
        throw new Error('should have refused');
      } catch (err) {
        expect((err as { details: { violations: string[] } }).details.violations).toHaveLength(3);
      }
    });

    it('P18.98-T5 AC-2 says each in both languages, one after another, Goal Settings’ labels kept English', () => {
      try {
        computeCascade({ ...defaults, caseSizeMinor: 0, closingRatePct: 0 });
        throw new Error('should have refused');
      } catch (err) {
        const refusal = err as DomainException;
        expect(english(refusal.sentence)).toBe(
          'Average case size must be above zero: it is what a policy is worth. Closing rate must be above 0 and at most 100 per cent.',
        );
        expect(indonesian(refusal.sentence)).toBe(
          'Average case size harus di atas nol: itulah nilai satu polis. Closing rate harus di atas 0 dan paling tinggi 100 persen.',
        );
        expect(indonesianAll(refusal.givenDetails!.violations as Sentence[])).toEqual([
          'Average case size harus di atas nol: itulah nilai satu polis.',
          'Closing rate harus di atas 0 dan paling tinggi 100 persen.',
        ]);
      }
      try {
        annualTargetOf({ ...defaults, mode: 'from_savings', commissionRatePct: 0 });
        throw new Error('should have refused');
      } catch (err) {
        expect(indonesian((err as DomainException).sentence))
          .toBe('Target tabungan memerlukan commission rate di atas nol untuk menjadi target APE.');
      }
    });
  });

  describe('cascadeCounts — steps 3 to 5, one definition for every reader (P10-T5)', () => {
    it('is the plan’s own three counts, run on its monthly figure', () => {
      const plan = computeCascade(defaults);
      expect(cascadeCounts(plan.monthlyApeTargetMinor, defaults)).toEqual({
        policies: plan.policiesPerMonth, appointments: plan.appointmentsPerMonth, leads: plan.leadsPerMonth,
      });
    });

    it('runs on any APE figure — a year’s target is ceiled once, not twelve times', () => {
      const rates = { caseSizeMinor: 18_000_000_00, closingRatePct: 30, leadsToApptPct: 30 };
      expect(cascadeCounts(500_000_000_00, rates)).toEqual({ policies: 28, appointments: 94, leads: 314 });
      expect(cascadeCounts(0, rates)).toEqual({ policies: 0, appointments: 0, leads: 0 });
    });
  });

  describe('P18.8-T10 AC-1 — the two percentages open on the office’s benchmarks (ADR-0160 §3)', () => {
    /** The office's two ratios as the seed gives them. */
    const seeded = SEED_RATIO_DEFINITIONS.filter((r) => ['SELLING_SUCCESS_RATE', 'MEETING_PER_APPROACH'].includes(r.code));

    it('reads Closing rate from Selling success rate and Appointment to Sales meeting from Set appointment to meeting', () => {
      // 30% and 50% with the seeded benchmarks, written as percentages.
      expect(defaultRates(seeded)).toEqual({
        closingRatePct: RATIO_BENCHMARKS.SELLING_SUCCESS_RATE * 100,
        leadsToApptPct: RATIO_BENCHMARKS.MEETING_PER_APPROACH * 100,
      });
      expect(defaultRates(seeded)).toEqual({ closingRatePct: 30, leadsToApptPct: 50 });
    });

    it('reads an office’s own benchmark, to one decimal', () => {
      expect(defaultRates([
        { code: 'SELLING_SUCCESS_RATE', benchmark: 0.155, comparison: 'gte' },
        { code: 'MEETING_PER_APPROACH', benchmark: 0.4, comparison: 'gte' },
      ])).toEqual({ closingRatePct: 15.5, leadsToApptPct: 40 });
    });

    it('falls back to GOAL_DEFAULTS for an office without the ratio', () => {
      expect(defaultRates([])).toEqual({
        closingRatePct: GOAL_DEFAULTS.CLOSING_RATE_PCT, leadsToApptPct: GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT,
      });
      expect(defaultRates([{ code: 'SELLING_SUCCESS_RATE', benchmark: 0.2, comparison: 'gte' }]))
        .toEqual({ closingRatePct: 20, leadsToApptPct: GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT });
    });

    it('falls back for a benchmark that is no percentage a plan can use', () => {
      // An Owner's 1.50 meetings per appointment is 150%, which the cascade refuses; a balance is in points.
      expect(defaultRates([
        { code: 'MEETING_PER_APPROACH', benchmark: 1.5, comparison: 'gte' },
        { code: 'SELLING_SUCCESS_RATE', benchmark: 30, comparison: 'band' },
      ])).toEqual({ closingRatePct: GOAL_DEFAULTS.CLOSING_RATE_PCT, leadsToApptPct: GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT });
      expect(defaultRates([{ code: 'SELLING_SUCCESS_RATE', benchmark: 0, comparison: 'gte' }]).closingRatePct)
        .toBe(GOAL_DEFAULTS.CLOSING_RATE_PCT);
      // Exactly 100% is a plan.
      expect(defaultRates([{ code: 'MEETING_PER_APPROACH', benchmark: 1, comparison: 'gte' }]).leadsToApptPct).toBe(100);
    });

    it('opens a plan the cascade can run', () => {
      const out = computeCascade({ ...defaults, ...defaultRates(seeded) });
      // 6 policies at 30% is 20 sales meetings; 20 at 50% is 40 appointments to set.
      expect(out).toMatchObject({ policiesPerMonth: 6, appointmentsPerMonth: 20, leadsPerMonth: 40 });
    });
  });
});
