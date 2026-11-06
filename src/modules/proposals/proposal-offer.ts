import {
  ageBandOf, type ProductCurrency, type ProposalChannel, type ProposalRefusalReason,
} from '@/domain/constants';
import type { OfficeShelfEntry } from '@/modules/products/kpm-product.service';
import { effectiveProposalWordsOf, insuredOf, typeLabelOf } from '@/modules/products/proposal-fields';
import type { SnapshotField } from './proposal-items';

/**
 * **What a proposal may offer, and why it refuses the rest** (P19.7-T2; ADR-0225 §3, §7; Acc. 17, 21; OD-273's riders;
 * T1's AC-5 and AC-6). Pure over the office's shelf (`KpmProductService.shelfOf`, the one read of it), so each rule is a
 * unit test (`proposal-offer.spec.ts`) and the catalogue and the item routes cannot disagree.
 *
 * A product is offered when it is **on the KPM's shelf** (kept on, ADR-0033), **a base**, **on sale** (`active` — not
 * closed to new business, not withdrawn, not deleted), **in the channel** (a *Syariah* proposal: a syariah product by its
 * name, or a conventional one with a `syariahName` by that; a *Konvensional* one: conventional products alone) and has the
 * **client's age in one of its age bands** (`ageBandOf`).
 */

/** One product step 2 may add, as `GET /proposals/catalog` answers it (ADR-0225 §7). */
export interface CatalogProductView {
  productId: string;
  code: string;
  /** The name this channel reads: the office's display name, or a conventional product's syariah name on *Syariah*. */
  name: string;
  category: string;
  typeLabel: string;
  defaultInsured: 'client' | 'child';
  /** ADR-0225 §8: fixed by the product, or decided by its `currency` field. */
  currency: { fixed: ProductCurrency } | { byField: string };
  fields: SnapshotField[];
  plans: { name: string; highlights: { label: string; value: string }[]; popular: boolean }[];
  faq: { question: string; answer: string }[];
  /** *"Bisa ditambah: …"* — never a card, never an item. */
  riders: { code: string; name: string }[];
}

type Entry = Pick<OfficeShelfEntry, 'product' | 'view' | 'approved'>;

/** **Why this product may not be added**, or `null` when it may (the order is the most telling first). */
export function refusalOf(entry: Entry, channel: ProposalChannel, age: number): ProposalRefusalReason | null {
  const { product, view } = entry;
  if (product.kind === 'rider') return 'rider';
  if (product.lifecycle === 'withdrawn' || product.deletedAt) return 'withdrawn';
  if (product.lifecycle === 'closed_to_new_business') return 'closed';
  if (!view.active.value || !view.sellable) return 'not_on_shelf';
  if (!inChannel(product, channel)) return 'channel';
  if (!(product.eligibleAgeBands ?? []).includes(ageBandOf(age))) return 'age';
  return null;
}

/** ADR-0225 §3: a *Konvensional* proposal offers conventional products; a *Syariah* one syariah products and syariah names. */
export function inChannel(product: { channel: string; syariahName?: string | null }, channel: ProposalChannel): boolean {
  if (channel === 'conventional') return product.channel === 'conventional';
  return product.channel === 'syariah' || Boolean(product.syariahName);
}

/** The name a channel reads (ADR-0221 §9): a conventional product's syariah name on *Syariah*, else the office's. */
export function offeredName(entry: Entry, channel: ProposalChannel): string {
  const { product, view } = entry;
  return channel === 'syariah' && product.channel === 'conventional' && product.syariahName
    ? product.syariahName
    : view.displayName.value;
}

/** **The catalogue**: the offered products, in the company's order, each with its words and its riders. */
export function catalogOf(
  entries: readonly Entry[], channel: ProposalChannel, age: number,
): CatalogProductView[] {
  const riders = entries.filter(({ product }) => product.kind === 'rider' && product.lifecycle === 'active');
  return entries
    .filter((entry) => refusalOf(entry, channel, age) === null)
    .map((entry) => {
      const { product, approved } = entry;
      const id = String(product._id);
      const words = effectiveProposalWordsOf(product, approved);
      const currencies = product.currencies?.length ? product.currencies : ['IDR'];
      const currencyField = (product.proposalFields ?? []).find((f) => f.currency);
      return {
        productId: id,
        code: product.code,
        name: offeredName(entry, channel),
        category: product.category,
        typeLabel: typeLabelOf(product),
        defaultInsured: insuredOf(product),
        currency: currencies.length > 1 && currencyField
          ? { byField: currencyField.key }
          : { fixed: (currencies.length === 1 && currencies[0] === 'USD' ? 'USD' : 'IDR') as ProductCurrency },
        fields: (product.proposalFields ?? []).map(({ draft: _draft, ...field }) => field),
        plans: words.plans,
        faq: words.faq,
        riders: riders
          .filter((rider) => (rider.product.attachesTo ?? []).includes(id))
          .map((rider) => ({ code: rider.product.code, name: rider.view.displayName.value })),
      };
    });
}
