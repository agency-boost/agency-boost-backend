import { ATTACK_PLAN_MESSAGES } from './attack-plan.messages';
import type { ProductCategory, ProductChannel, ProductNeed } from './product-catalog';

/**
 * **The Sales Attack Plan's scorer** (D-scoring; `functional/sales-tools.md`, *The scorer*).
 *
 * The prototype ranks the office's shelf for a three-question brief in the browser
 * (`Overall.html:9599-9611`, `findMatches`): a product scores **1** when the brief's age band is one it
 * is eligible for, and **2** when the budget band is — budget weighs twice — highest first, with no
 * minimum, so a product matching neither band is still recommended, *Check fit*. Here the rule runs
 * once, on the server (`attack-plan.scorer.ts`), and its numbers live in one place (invariant §7).
 *
 * Ties keep the company's `sortOrder` (F-14's one order), which is the prototype's declaration order
 * for every category but *Investment*, where the prototype's two copies disagree.
 *
 * Each value is pinned by `attack-plan.spec.ts` and documented once in `metrics-and-definitions.md`.
 */
export const ATTACK_PLAN = {
  /** `if(p.age.includes(age)) score += 1;` — `Overall.html:9605`. */
  AGE_WEIGHT: 1,
  /** `if(p.budget.includes(budget)) score += 2;` — `Overall.html:9606`. */
  BUDGET_WEIGHT: 2,
  /**
   * How many of the brief's other matches are drawn as chips: `altList.slice(0,4)` (`Overall.html:9698`).
   * The rest are counted in *"{n} more also match."* (`:9699`).
   */
  ALTERNATIVES_SHOWN: 4,
} as const;

/**
 * The eight needs as the brief's chips name them (`Overall.html:3803-3810`, `NEED_LABELS` `:9527-9531`).
 * The result's tag prints the shown product's own need with its channel (`:9682`).
 */
export const PRODUCT_NEED_LABELS: Readonly<Record<ProductNeed, string>> = {
  'life-protection': 'Life protection',
  health: 'Health',
  ci: 'Critical illness',
  accident: 'Accident-only',
  education: 'Education',
  investment: 'Investment',
  retirement: 'Retirement income',
  legacy: 'Legacy / inheritance',
};

/** The catalog's five categories, in its tab order (`Overall.html:10116-10122`, *All products* first at `:10133`). */
export const PRODUCT_CATEGORY_LABELS: Readonly<Record<ProductCategory, string>> = {
  life: 'Life',
  health: 'Health',
  ci: 'Critical illness',
  education: 'Education',
  investment: 'Investment-linked',
};

/** `CHANNEL_LABELS` (`Overall.html:9534`, `:10123`). */
export const PRODUCT_CHANNEL_LABELS: Readonly<Record<ProductChannel, string>> = {
  conventional: 'Conventional',
  syariah: 'Syariah',
};

/**
 * The drawer's *Details* note for a product in run-off, verbatim (`Overall.html:10240`). The plan's own
 * run-off note and the *Attack Plan* tab's are the screens' (`:9676`, `:10290`): each says something
 * different, where it is.
 *
 * **A sentence in both languages since P18.10-T5** (AC-4), held in `attack-plan.messages.ts` and written for the
 * request's reader where the drawer's answer is built (`ProductCatalogService`).
 */
export const PRODUCT_RUN_OFF_NOTE = ATTACK_PLAN_MESSAGES.runOffNote;
