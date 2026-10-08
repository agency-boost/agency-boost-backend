import { ATTACK_PLAN, type ProductLifecycle } from '@/domain/constants';

/** What the scorer reads of a product: nothing an office writes, and nothing a reader is shown. */
export interface ScoredProduct {
  readonly code: string;
  readonly sortOrder: number;
  readonly lifecycle: ProductLifecycle;
  readonly needs: readonly string[];
  readonly ageBands: readonly number[];
  readonly budgetBands: readonly number[];
}

/** The customer brief: the three questions the plan asks (`Overall.html:3795-3836`, OD-134). */
export interface Brief {
  readonly need: string;
  readonly age: number;
  readonly budget: number;
}

/** Which of the brief's bands the product is outside, in the fit note's order (`Overall.html:9669-9675`). */
export type FitIssue = 'age' | 'budget';

export interface Fit {
  /** *Good fit* only when both bands match (`fullFit = ageFits && budgetFits`, `Overall.html:9643-9645`). */
  readonly verdict: 'good_fit' | 'check_fit';
  readonly outside: readonly FitIssue[];
}

export interface Match<P extends ScoredProduct> {
  readonly product: P;
  readonly score: number;
}

export interface Plan<P extends ScoredProduct> {
  /** The product shown: the top match, or the one the reader switched to. `null` when nothing serves the need. */
  readonly shown: P | null;
  readonly fit: Fit | null;
  /** The brief's other matches in score order, the shown one left out — at most `ALTERNATIVES_SHOWN`. */
  readonly alternatives: readonly P[];
  /** How many more match beyond the chips: *"{n} more also match."* (`Overall.html:9699`). */
  readonly moreCount: number;
}

/** The fit of one product against a brief: the pill and the note (`Overall.html:9660-9675`). */
export function fitOf(product: ScoredProduct, brief: Brief): Fit {
  const outside: FitIssue[] = [];
  if (!product.ageBands.includes(brief.age)) outside.push('age');
  if (!product.budgetBands.includes(brief.budget)) outside.push('budget');
  return { verdict: outside.length === 0 ? 'good_fit' : 'check_fit', outside };
}

/**
 * Every candidate for the brief, best first (D-scoring; `findMatches`, `Overall.html:9599-9611`).
 *
 * **Candidates** are the products on the shelf it is given — the office's, kept on (D-shelf) — whose
 * lifecycle is *active* and whose needs include the brief's (`:9602`): a run-off product is never
 * recommended, as drawn. **Score** is `AGE_WEIGHT` for an eligible age band plus `BUDGET_WEIGHT` for an
 * eligible budget band. **No minimum**: a candidate that matches neither band is still one, *Check fit*.
 * **Order** is highest first, ties in the company's `sortOrder`.
 */
export function matchesFor<P extends ScoredProduct>(shelf: readonly P[], brief: Brief): Match<P>[] {
  return shelf
    .filter((p) => p.lifecycle === 'active' && p.needs.includes(brief.need))
    .map((product) => ({
      product,
      score: (product.ageBands.includes(brief.age) ? ATTACK_PLAN.AGE_WEIGHT : 0)
        + (product.budgetBands.includes(brief.budget) ? ATTACK_PLAN.BUDGET_WEIGHT : 0),
    }))
    .sort((a, b) => b.score - a.score || a.product.sortOrder - b.product.sortOrder);
}

/**
 * **The plan for a brief**: what is shown, its fit, and the alternatives (D-scoring, D-alternatives).
 *
 * With `chosen`, the reader switched to that alternative: it is shown, **re-fitted against the brief**,
 * and the alternatives are the brief's other matches in score order — the top one back among them. The
 * list is the same every time, where the prototype's shrank on each switch until it was empty and lost
 * its *more* line after the first (`:9706-9719`, `:9833-9851`; F-16, a Fix inside its footprint).
 *
 * `undefined` when `chosen` names no candidate for this brief: there is nothing to switch to, and the
 * caller answers that as not found.
 */
export function planFor<P extends ScoredProduct>(
  shelf: readonly P[], brief: Brief, chosen?: string,
): Plan<P> | undefined {
  const matches = matchesFor(shelf, brief);
  const shown = chosen === undefined
    ? matches[0]?.product ?? null
    : matches.find((m) => m.product.code === chosen)?.product;
  if (shown === undefined) return undefined;
  if (shown === null) return { shown: null, fit: null, alternatives: [], moreCount: 0 };

  const others = matches.filter((m) => m.product !== shown).map((m) => m.product);
  return {
    shown,
    fit: fitOf(shown, brief),
    alternatives: others.slice(0, ATTACK_PLAN.ALTERNATIVES_SHOWN),
    moreCount: Math.max(0, others.length - ATTACK_PLAN.ALTERNATIVES_SHOWN),
  };
}
