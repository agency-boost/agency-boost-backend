import type { ProductNeed, SeedProductWords } from './product-catalog';
import { SEED_PRODUCTS_ID_A, SEED_REPLY_BY_NEED_ID as REPLIES_ID } from './product-words-id-a';
import { SEED_PRODUCTS_ID_B } from './product-words-id-b';

/**
 * **The platform's seed products in Bahasa Indonesia** (UI V1, UI-107; Phase 18.99 T13): every product of
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
 * (the report's UI-107): every pair is listed in `docs/05-delivery/phases/phase-18.99-translations-for-review.md`.
 */
export const SEED_PRODUCTS_ID: Readonly<Record<string, SeedProductWords>> = { ...SEED_PRODUCTS_ID_A, ...SEED_PRODUCTS_ID_B };

/** What the customer is told when they push back, by need: `SEED_REPLY_BY_NEED` in Bahasa Indonesia. */
export const SEED_REPLY_BY_NEED_ID: Readonly<Record<ProductNeed, string>> = REPLIES_ID;
