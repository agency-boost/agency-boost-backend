import {
  ATTACK_PLAN, PRODUCT_AGE_BANDS, PRODUCT_BUDGET_BANDS, PRODUCT_NEEDS, SEED_PRODUCTS,
} from '@/domain/constants';
import { prototypeRender, shelf0417 } from '../../../test/sales-tools';
import { fitOf, matchesFor, planFor, type Brief, type ScoredProduct } from './attack-plan.scorer';

/**
 * **The plan's one rule** (D-scoring, D-alternatives; P14-T8 AC-4, AC-5): candidates, score, order, verdict
 * and alternatives, as one function the service and these tests call.
 */

const product = (over: Partial<ScoredProduct> & { code: string }): ScoredProduct => ({
  sortOrder: 1, lifecycle: 'active', needs: ['health'], ageBands: [1, 2, 3, 4, 5], budgetBands: [1, 2, 3, 4, 5, 6, 7],
  ...over,
});

/**
 * **0417 BSD City's shelf**, as the seed leaves it (`functional/sales-tools.md`, *Seed*): the company's 31
 * in `sortOrder`, less what the office does not keep on — *PRUSmart Plan* turned off, *PSGB* never on
 * (run-off, not `activeByDefault`) — and with *PGB* kept on although it is in run-off. The prototype's
 * array over the same shelf is `shelf0417()`, which the port of `findMatches` reads.
 */
const PROTOTYPE_0417 = shelf0417();
const SHELF_0417: ScoredProduct[] = PROTOTYPE_0417.map((p) => {
  const seeded = SEED_PRODUCTS.find((s) => s.code === p.code)!;
  return {
    code: p.code, sortOrder: seeded.sortOrder, lifecycle: seeded.lifecycle, needs: p.needs,
    ageBands: p.age, budgetBands: p.budget,
  };
});

const BRIEFS: Brief[] = PRODUCT_NEEDS.flatMap((need) =>
  PRODUCT_AGE_BANDS.flatMap((age) => PRODUCT_BUDGET_BANDS.map((budget) => ({ need, age, budget }))));

describe('the Sales Attack Plan’s scorer (D-scoring)', () => {
  describe('exit criterion 3: the prototype’s rule, for every brief', () => {
    it('has all 280 briefs — 8 needs × 5 age bands × 7 budget bands — and the shelf 0417 keeps on', () => {
      expect(BRIEFS).toHaveLength(280);
      expect(SHELF_0417).toHaveLength(29);
      expect(SHELF_0417.map((p) => p.code)).not.toContain('PRUSMART_PLAN');
    });

    it.each(BRIEFS.map((b) => [`${b.need} · age ${b.age} · budget ${b.budget}`, b] as const))(
      'P14-T8 AC-4 %s: the top product, its verdict and its alternatives in order equal findMatches in sortOrder',
      (_label, brief) => {
        const plan = planFor(SHELF_0417, brief)!;
        expect({
          top: plan.shown?.code ?? null,
          verdict: plan.fit?.verdict ?? null,
          alternatives: plan.alternatives.map((p) => p.code),
          more: plan.moreCount,
        }).toEqual(prototypeRender(PROTOTYPE_0417, brief));
      },
    );
  });

  describe('candidates (D-shelf, `:9602`)', () => {
    it('P14-T8 AC-4 takes only products whose needs include the brief’s', () => {
      const shelf = [product({ code: 'A', needs: ['health'] }), product({ code: 'B', needs: ['ci'], sortOrder: 2 })];
      expect(matchesFor(shelf, { need: 'ci', age: 1, budget: 1 }).map((m) => m.product.code)).toEqual(['B']);
    });

    it('P14-T8 AC-4 never recommends a run-off or a withdrawn product, whatever it scores', () => {
      const shelf = [
        product({ code: 'RUNOFF', lifecycle: 'closed_to_new_business', sortOrder: 1 }),
        product({ code: 'GONE', lifecycle: 'withdrawn', sortOrder: 2 }),
        product({ code: 'LIVE', ageBands: [], budgetBands: [], sortOrder: 3 }),
      ];
      expect(planFor(shelf, { need: 'health', age: 2, budget: 2 })!.shown!.code).toBe('LIVE');
    });

    it('P14-T8 AC-4 recommends nothing — and says so — when no active product serves the need', () => {
      const plan = planFor([product({ code: 'A', needs: ['health'] })], { need: 'legacy', age: 2, budget: 2 });
      expect(plan).toEqual({ shown: null, fit: null, alternatives: [], moreCount: 0 });
    });

    it('answers an empty shelf — an office of a blank company — as nothing, not as a failure', () => {
      expect(planFor([], { need: 'health', age: 2, budget: 2 })).toEqual({ shown: null, fit: null, alternatives: [], moreCount: 0 });
    });
  });

  describe('score and order', () => {
    it('weighs budget twice age, from the registered constants', () => {
      const shelf = [
        product({ code: 'AGE', ageBands: [2], budgetBands: [], sortOrder: 1 }),
        product({ code: 'BUDGET', ageBands: [], budgetBands: [2], sortOrder: 2 }),
        product({ code: 'BOTH', ageBands: [2], budgetBands: [2], sortOrder: 3 }),
        product({ code: 'NEITHER', ageBands: [], budgetBands: [], sortOrder: 0 }),
      ];
      expect(matchesFor(shelf, { need: 'health', age: 2, budget: 2 }).map((m) => [m.product.code, m.score])).toEqual([
        ['BOTH', ATTACK_PLAN.AGE_WEIGHT + ATTACK_PLAN.BUDGET_WEIGHT],
        ['BUDGET', ATTACK_PLAN.BUDGET_WEIGHT],
        ['AGE', ATTACK_PLAN.AGE_WEIGHT],
        ['NEITHER', 0],
      ]);
    });

    it('breaks a tie by the company’s sortOrder, not by the order the shelf arrived in', () => {
      const shelf = [product({ code: 'LATER', sortOrder: 9 }), product({ code: 'EARLIER', sortOrder: 2 })];
      expect(matchesFor(shelf, { need: 'health', age: 1, budget: 1 }).map((m) => m.product.code)).toEqual(['EARLIER', 'LATER']);
    });

    it('has no minimum: a product matching neither band is still recommended, Check fit (`:9643-9645`)', () => {
      const plan = planFor([product({ code: 'A', ageBands: [5], budgetBands: [7] })], { need: 'health', age: 1, budget: 1 })!;
      expect(plan.shown!.code).toBe('A');
      expect(plan.fit).toEqual({ verdict: 'check_fit', outside: ['age', 'budget'] });
    });
  });

  describe('the verdict and the note (`:9660-9675`)', () => {
    const p = product({ code: 'A', ageBands: [2], budgetBands: [3] });
    it.each([
      [{ need: 'health', age: 2, budget: 3 }, { verdict: 'good_fit', outside: [] }],
      [{ need: 'health', age: 1, budget: 3 }, { verdict: 'check_fit', outside: ['age'] }],
      [{ need: 'health', age: 2, budget: 1 }, { verdict: 'check_fit', outside: ['budget'] }],
      [{ need: 'health', age: 1, budget: 1 }, { verdict: 'check_fit', outside: ['age', 'budget'] }],
    ])('%o is %o', (brief, fit) => {
      expect(fitOf(p, brief)).toEqual(fit);
    });
  });

  describe('alternatives (D-alternatives; F-16)', () => {
    /** *Health* in 0417: eight matches, so four chips and *"3 more also match"* (P14-T8 AC-14). */
    const health: Brief = { need: 'health', age: 2, budget: 2 };

    it('P14-T8 AC-14 Health shows four chips and three more, ties in the company’s order', () => {
      const plan = planFor(SHELF_0417, health)!;
      expect(plan.shown!.code).toBe('PRUSEHAT');
      expect(plan.alternatives.map((p) => p.code)).toEqual([
        'PRUWELL_MEDICAL', 'PRUSEHAT_SYARIAH', 'PRUWELL_MEDICAL_SYARIAH', 'PRUWELL_HEALTH',
      ]);
      expect(plan.moreCount).toBe(3);
    });

    it('P14-T8 AC-5 a switch re-fits the chosen product against the brief, and puts the top one back first', () => {
      const plan = planFor(SHELF_0417, health, 'PRUWELL_HEALTH')!;
      expect(plan.shown!.code).toBe('PRUWELL_HEALTH');
      expect(plan.fit).toEqual({ verdict: 'check_fit', outside: ['budget'] });
      expect(plan.alternatives.map((p) => p.code)).toEqual([
        'PRUSEHAT', 'PRUWELL_MEDICAL', 'PRUSEHAT_SYARIAH', 'PRUWELL_MEDICAL_SYARIAH',
      ]);
      expect(plan.moreCount).toBe(3);
    });

    it('P14-T8 AC-5 six switches in a row: the list is the brief’s other matches every time, never shrinking', () => {
      const all = planFor(SHELF_0417, health)!;
      const every = [all.shown!, ...all.alternatives].map((p) => p.code);
      let shown = all.shown!.code;
      for (let i = 0; i < 6; i += 1) {
        const plan = planFor(SHELF_0417, health, shown)!;
        // The others, in score order, without the one shown: the same eight less one, every time.
        const others = matchesFor(SHELF_0417, health).map((m) => m.product.code).filter((c) => c !== shown);
        expect(plan.alternatives.map((p) => p.code)).toEqual(others.slice(0, 4));
        expect(plan.moreCount).toBe(3);
        expect(plan.alternatives.map((p) => p.code)).not.toContain(shown);
        shown = plan.alternatives[i % plan.alternatives.length].code;
        expect(every).toContain(shown);
      }
    });

    it('P14-T8 AC-5 refuses a switch to something that is no candidate for the brief', () => {
      expect(planFor(SHELF_0417, health, 'PRUMAPAN')).toBeUndefined();
      expect(planFor(SHELF_0417, health, 'PRULINK_GENERASI_BARU_PGB')).toBeUndefined();
      expect(planFor(SHELF_0417, health, 'NOPE')).toBeUndefined();
    });
  });

  describe('the walk’s briefs (P14-T8 AC-14), over the seed constant', () => {
    it('Retirement income, 25–34, Rp500K–Rp2M: PRUMapan, Good fit, PRUAnugerah the one alternative', () => {
      const plan = planFor(SHELF_0417, { need: 'retirement', age: 2, budget: 2 })!;
      expect([plan.shown!.code, plan.fit!.verdict, plan.alternatives.map((p) => p.code), plan.moreCount])
        .toEqual(['PRUMAPAN', 'good_fit', ['PRUANUGERAH'], 0]);
    });

    it('Retirement income, 65+, > Rp20M: PRUAnugerah, Check fit, outside the age band', () => {
      const plan = planFor(SHELF_0417, { need: 'retirement', age: 5, budget: 6 })!;
      expect([plan.shown!.code, plan.fit]).toEqual(['PRUANUGERAH', { verdict: 'check_fit', outside: ['age'] }]);
    });

    it('Life protection: the turned-off PRUSmart Plan is not offered', () => {
      const plan = planFor(SHELF_0417, { need: 'life-protection', age: 3, budget: 4 })!;
      expect([plan.shown!, ...plan.alternatives].map((p) => p.code)).not.toContain('PRUSMART_PLAN');
      expect(plan.shown!.code).toBe('PRUFUTURE');
    });
  });
});
