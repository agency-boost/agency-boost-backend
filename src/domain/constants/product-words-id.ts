import { SEED_REPLY_BY_NEED as SEED_REPLY_EN, type ProductNeed, type SeedProduct, type SeedProductWords } from './product-catalog';
import { SEED_PRODUCTS_ID_A, SEED_REPLY_BY_NEED_ID as REPLIES_ID } from './product-words-id-a';
import { SEED_PRODUCTS_ID_B } from './product-words-id-b';

/**
 * **The platform's seed products in Bahasa Indonesia** (UI V1, UI-107; Phase 18.11 T13): every product of
 * `SEED_PRODUCTS`, by code, field for field — its catalogue line, benefits, what makes it stand out, its best-fit
 * customer and its sales script — and the eight needs' replies (`SEED_REPLY_BY_NEED`).
 *
 * **Words the platform wrote, not a company's** (ADR-0179 §5 holds): `modules/products/product-words.ts` serves one of
 * these to a reader in Indonesian only where the company's row — or the office's approved override — still holds the
 * seed's English **byte for byte**. A word a company or an office typed is shown as typed, in either language; the
 * English reader reads what was always there. Product names, *Konvensional* and *Syariah*, sums and numbers stay;
 * the insurance terms agents say in English (*as-billed*, *No Claim Bonus*, *Limit Booster*, *unit link*) stay.
 *
 * Split in two files only because two people translated them at once. **For the product owner's review before release**
 * (the report's UI-107): every pair is listed in `docs/05-delivery/phases/phase-18.11-translations-for-review.md`.
 */
export const SEED_PRODUCTS_ID: Readonly<Record<string, SeedProductWords>> = { ...SEED_PRODUCTS_ID_A, ...SEED_PRODUCTS_ID_B };

/** What the customer is told when they push back, by need: `SEED_REPLY_BY_NEED` in Bahasa Indonesia. */
export const SEED_REPLY_BY_NEED_ID: Readonly<Record<ProductNeed, string>> = REPLIES_ID;

/**
 * **A seed product with its words in Bahasa Indonesia** (P19.26-T4 AC-4; ADR-0284 §5; UI-216 (21 Nov); OD-440): the
 * product as `SEED_PRODUCTS` holds it, its catalogue line, benefits, what makes it stand out, its best-fit customer and its
 * sales script replaced by `SEED_PRODUCTS_ID`'s — and the reply to its objection by `SEED_REPLY_BY_NEED_ID`'s, the need
 * whose English it is. **What a company's catalogue is written with**: the demo seed and a new company's starting
 * catalogue (`ProductService`), so the Super Admin's *Produk & proposal* reads Indonesian. A product with no Indonesian is
 * returned as it is. Staging and production keep what they hold until the operator corrects it (OD-440).
 */
export function seedProductInIndonesian<P extends SeedProduct>(product: P): P {
  const id = SEED_PRODUCTS_ID[product.code];
  if (!id) return product;
  const plan = product.defaultAttackPlan;
  const need = (Object.keys(REPLIES_ID) as ProductNeed[]).find((n) => SEED_REPLY_EN[n] === plan.objectionYouSay);
  return {
    ...product,
    tagline: id.tagline,
    benefits: [...id.benefits],
    differentiator: id.differentiator,
    bestFor: id.bestFor,
    defaultAttackPlan: {
      ...plan,
      ...id.defaultAttackPlan,
      benefits: [...id.defaultAttackPlan.benefits],
      objectionYouSay: need ? REPLIES_ID[need] : plan.objectionYouSay,
    },
  };
}
