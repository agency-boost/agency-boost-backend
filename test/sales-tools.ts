import { SEED_PRODUCTS } from '@/domain/constants';

/**
 * **What the sales tools' specs share** (Phase 14): the prototype's own ranking, ported line for line, and
 * the shelf office 0417 keeps on in the demo seed — the two halves of exit criterion 3.
 */

/** A product as the prototype's `PRODUCTS` array holds what `findMatches` reads (`Overall.html:9285-9480`). */
export interface PrototypeProduct {
  readonly code: string;
  readonly needs: readonly string[];
  /** `legacy: true` in the prototype: any lifecycle but active. */
  readonly legacy: boolean;
  readonly age: readonly number[];
  readonly budget: readonly number[];
}

/**
 * **A port of `findMatches`** (`Overall.html:9599-9611`), over a `PRODUCTS` array in the company's
 * `sortOrder`. The sort is the prototype's, `b.score - a.score`, on an array already in shelf order, which
 * `Array.prototype.sort` keeps stable for ties — so ties fall in `sortOrder`, as D-scoring says.
 */
export function findMatches(
  PRODUCTS: readonly PrototypeProduct[], state: { need: string; age: string; budget: string },
): { p: PrototypeProduct; score: number }[] {
  const age = parseInt(state.age, 10);
  const budget = parseInt(state.budget, 10);
  const candidates = PRODUCTS.filter((p) => p.needs.includes(state.need) && !p.legacy).map((p) => {
    let score = 0;
    if (p.age.includes(age)) score += 1;
    if (p.budget.includes(budget)) score += 2;
    return { p, score };
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * What the prototype's **first render** of a brief shows (`renderResult`, `Overall.html:9630-9701`): the
 * top product, its pill, the first four alternatives and the *"{n} more"* count.
 */
export function prototypeRender(
  PRODUCTS: readonly PrototypeProduct[], brief: { need: string; age: number; budget: number },
): { top: string | null; verdict: 'good_fit' | 'check_fit' | null; alternatives: string[]; more: number } {
  const matches = findMatches(PRODUCTS, { need: brief.need, age: String(brief.age), budget: String(brief.budget) });
  if (matches.length === 0) return { top: null, verdict: null, alternatives: [], more: 0 };
  const top = matches[0].p;
  const fullFit = top.age.includes(brief.age) && top.budget.includes(brief.budget);
  const altList = matches.slice(1);
  return {
    top: top.code,
    verdict: fullFit ? 'good_fit' : 'check_fit',
    alternatives: altList.slice(0, 4).map((m) => m.p.code),
    more: altList.length > 4 ? altList.length - 4 : 0,
  };
}

/**
 * **Office 0417 BSD City's decisions that move its shelf**, as the demo seed writes them
 * (`functional/sales-tools.md`, *Seed*): *PRUSmart Plan* turned off, and *PRULink Generasi Baru (PGB)*
 * kept on although it is in run-off. Every other product follows the company's `activeByDefault`.
 */
export const OFFICE_0417 = {
  off: ['PRUSMART_PLAN'],
  on: ['PRULINK_GENERASI_BARU_PGB'],
} as const;

/** The seed's catalog as 0417 keeps it on, in `sortOrder`, as the prototype's array would hold it. */
export function shelf0417(): PrototypeProduct[] {
  return SEED_PRODUCTS
    .filter((p) => !(OFFICE_0417.off as readonly string[]).includes(p.code)
      && (p.activeByDefault || (OFFICE_0417.on as readonly string[]).includes(p.code)))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((p) => ({
      code: p.code, needs: p.primaryNeeds, legacy: p.lifecycle !== 'active',
      age: p.eligibleAgeBands, budget: p.eligibleBudgetBands,
    }));
}
