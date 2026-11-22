import type { ProductCurrency, ProposalCalcType, ProposalNeedTag, ProposalRefusalReason } from '@/domain/constants';
import type { OfficeShelfEntry } from '@/modules/products/kpm-product.service';
import {
  calcSettingsOf, effectiveProposalWordsOf, frequenciesOf, insuredOf, isSyariahProduct, needTagOf, typeLabelOf,
  type PayTerm, type PlanRule,
} from '@/modules/products/proposal-fields';
import type { SnapshotField } from './proposal-items';

/**
 * **What a proposal may offer, and why it refuses the rest** (P19.7-T2; ADR-0225 §3, §7; Acc. 17, 21; OD-273's riders;
 * *since 2026-11-12, P19.14-T2:* ADR-0255 §1, §8). Pure over the office's shelf (`KpmProductService.shelfOf`, the one
 * read of it), so each rule is a unit test (`proposal-offer.spec.ts`) and the catalogue and the item routes cannot
 * disagree.
 *
 * A product is offered when it is **on the KPM's shelf** (kept on, ADR-0033), **a base** and **on sale** (`active` —
 * not closed to new business, not withdrawn, not deleted). **There is no channel any more** (ADR-0255 §1): a syariah
 * product is a product of its own, offered by its own name beside the conventional ones. **A client outside its entry
 * ages** (`entryAge`, where the catalogue sets one) may not have it added: the catalogue still lists it, greyed with its
 * range (`outOfAge`), and the write is refused `age`.
 */

/** One product step 2 may add, as `GET /proposals/catalog` answers it (ADR-0225 §7; ADR-0255 §8). */
export interface CatalogProductView {
  productId: string;
  code: string;
  /** The office's display name. */
  name: string;
  category: string;
  typeLabel: string;
  needTag: ProposalNeedTag;
  /** *Kontribusi*, *Santunan asuransi*, *Peserta* on its card (ADR-0255 §1). */
  isSyariah: boolean;
  calcType: ProposalCalcType;
  defaultInsured: 'client' | 'child';
  /** ADR-0225 §8: fixed by the product, or decided by its `currency` field. */
  currency: { fixed: ProductCurrency } | { byField: string };
  fields: SnapshotField[];
  payTerms: PayTerm[];
  frequencies: string[];
  smokerRated: boolean;
  planRule: PlanRule | null;
  /** The ages at the next birthday a client may enter at, or `null` for no limit. */
  entryAge: { min: number; max: number } | null;
  /** **The client's age is outside `entryAge`**: drawn greyed, *"Usia {n} di luar batas ({min}–{max})"*, never added. */
  outOfAge: boolean;
  plans: { name: string; highlights: { label: string; value: string }[]; popular: boolean }[];
  faq: { question: string; answer: string }[];
  /** *"Bisa ditambah: …"* — never a card, never an item. */
  riders: { code: string; name: string }[];
}

type Entry = Pick<OfficeShelfEntry, 'product' | 'view' | 'approved'>;

/** **Whether an age is outside a product's entry ages** (P19.14-T2 AC-2): no limit, or no age yet, is never outside. */
export function outsideEntryAge(product: { entryAge?: { min: number; max: number } | null }, age: number | null): boolean {
  const range = product.entryAge ?? null;
  return range !== null && age !== null && (age < range.min || age > range.max);
}

/**
 * **Why this product may not be added**, or `null` when it may (the order is the most telling first). The age is the
 * client's (`client.age`), held to the product's `entryAge`.
 */
export function refusalOf(entry: Entry, age: number | null): ProposalRefusalReason | null {
  const reason = shelfRefusalOf(entry);
  if (reason !== null) return reason;
  if (outsideEntryAge(entry.product, age)) return 'age';
  return null;
}

/** Why a product is not on offer at all, whatever the client's age. */
function shelfRefusalOf(entry: Entry): ProposalRefusalReason | null {
  const { product, view } = entry;
  if (product.kind === 'rider') return 'rider';
  if (product.lifecycle === 'withdrawn' || product.deletedAt) return 'withdrawn';
  if (product.lifecycle === 'closed_to_new_business') return 'closed';
  if (!view.active.value || !view.sellable) return 'not_on_shelf';
  return null;
}

/**
 * **The catalogue**: every product on offer, in the company's order, each with its words, its calculation fields, its
 * riders and whether the client's age is outside its entry ages — **listed, greyed, never hidden** (P19.14-T2 AC-2).
 */
export function catalogOf(entries: readonly Entry[], age: number | null): CatalogProductView[] {
  const riders = entries.filter(({ product }) => product.kind === 'rider' && product.lifecycle === 'active');
  return entries
    .filter((entry) => shelfRefusalOf(entry) === null)
    .map((entry) => {
      const { product, approved, view } = entry;
      const id = String(product._id);
      const words = effectiveProposalWordsOf(product, approved);
      const calc = calcSettingsOf(product as unknown as Record<string, unknown>);
      const currencies = product.currencies?.length ? product.currencies : ['IDR'];
      const currencyField = (product.proposalFields ?? []).find((f) => f.currency);
      return {
        productId: id,
        code: product.code,
        name: view.displayName.value,
        category: product.category,
        typeLabel: typeLabelOf(product),
        needTag: needTagOf(product),
        isSyariah: isSyariahProduct(product),
        calcType: calc.calcType,
        defaultInsured: insuredOf(product),
        currency: currencies.length > 1 && currencyField
          ? { byField: currencyField.key }
          : { fixed: (currencies.length === 1 && currencies[0] === 'USD' ? 'USD' : 'IDR') as ProductCurrency },
        fields: (product.proposalFields ?? []).map(({ draft: _draft, ...field }) => field),
        payTerms: calc.payTerms,
        frequencies: frequenciesOf(product),
        smokerRated: calc.smokerRated,
        planRule: calc.planRule,
        entryAge: calc.entryAge,
        outOfAge: outsideEntryAge(calc, age),
        plans: words.plans,
        faq: words.faq,
        riders: riders
          .filter((rider) => (rider.product.attachesTo ?? []).includes(id))
          .map((rider) => ({ code: rider.product.code, name: rider.view.displayName.value })),
      };
    });
}
