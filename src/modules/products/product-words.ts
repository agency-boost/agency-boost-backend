import type { Reader } from '@/common/i18n/reader';
import {
  PRODUCT_NEEDS, SEED_PRODUCTS, SEED_REPLY_BY_NEED, type SeedProduct, type SeedProductWords,
} from '@/domain/constants/product-catalog';
import { SEED_PRODUCTS_ID, SEED_REPLY_BY_NEED_ID } from '@/domain/constants/product-words-id';

/** A product's words as served: the text, or its Indonesian where the text is still the platform's. */
export type ProductWords = (text: string) => string;

const asTyped: ProductWords = (text) => text;

/**
 * The pairs of one seed product: each English field beside its Indonesian, list items by position — and the eight
 * replies, which any product's `objectionYouSay` may hold.
 */
function pairsOf(seed: SeedProduct, id: SeedProductWords): [string, string][] {
  const plan = seed.defaultAttackPlan;
  const lists = (en: readonly string[], idList: readonly string[]) => en.map((text, i) => [text, idList[i]] as [string, string]);
  return [
    [seed.tagline, id.tagline],
    ...lists(seed.benefits, id.benefits),
    [seed.differentiator, id.differentiator],
    [seed.bestFor, id.bestFor],
    [plan.goodFit, id.defaultAttackPlan.goodFit],
    [plan.opening, id.defaultAttackPlan.opening],
    ...lists(plan.benefits, id.defaultAttackPlan.benefits),
    [plan.fullScript, id.defaultAttackPlan.fullScript],
    [plan.objectionTheySay, id.defaultAttackPlan.objectionTheySay],
    [plan.nextAction, id.defaultAttackPlan.nextAction],
    ...PRODUCT_NEEDS.map((need) => [SEED_REPLY_BY_NEED[need], SEED_REPLY_BY_NEED_ID[need]] as [string, string]),
  ];
}

/** Built once, on the first Indonesian read: by product code, each seed English to its Indonesian. */
let byCode: ReadonlyMap<string, ReadonlyMap<string, string>> | null = null;

function indonesianByCode(): ReadonlyMap<string, ReadonlyMap<string, string>> {
  byCode ??= new Map(SEED_PRODUCTS.map((seed) => {
    const id = SEED_PRODUCTS_ID[seed.code];
    // An empty English is a field the seed leaves blank, and stays blank: never a key.
    const pairs = id ? pairsOf(seed, id).filter(([en, text]) => en !== '' && text !== undefined) : [];
    return [seed.code, new Map(pairs)];
  }));
  return byCode;
}

/**
 * **A product's words for its reader** (UI V1, UI-107; Phase 18.11 T13): for a reader in Indonesian, a field still
 * holding the platform's seed English **byte for byte** is served in the seed's Indonesian (`SEED_PRODUCTS_ID`); any
 * other text — a company's own wording, an office's approved override, a product the platform never seeded — is shown
 * as typed (ADR-0179 §5). An English reader reads every field as stored. Keyed by the product's code, so a sentence two
 * products share reads as each product's own translation gives it.
 */
export function productWordsFor(code: string, reader: Reader): ProductWords {
  if (reader.language !== 'id') return asTyped;
  const words = indonesianByCode().get(code);
  return words ? (text) => words.get(text) ?? text : asTyped;
}
