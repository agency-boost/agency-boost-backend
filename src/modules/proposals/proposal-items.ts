import { HttpStatus } from '@nestjs/common';
import { DomainException, InvalidRequestException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  LEAD_AGE, PROPOSAL, PROPOSAL_INSURED_RELATIONS,
  type ProductCurrency, type ProposalChannel, type ProposalInsuredRelation, type ProposalPayFrequency,
} from '@/domain/constants';
import { LEAD_REFUSALS } from '@/modules/leads/leads.messages';
import type { PdfDetailBlock, ProposalField } from '@/modules/products/proposal-fields';
import { insuredOf, typeLabelOf } from '@/modules/products/proposal-fields';
import { PROPOSAL_REFUSALS } from './proposals.messages';

/**
 * **A proposal's items: what one is made of, and every rule that reads or writes one** (P19.7-T2; ADR-0221 §1, §3, §4;
 * ADR-0225 §6, §8; `metrics-and-definitions.md` §B.34). Pure, so each rule is a unit test (`proposal-items.spec.ts`), and
 * the service, the seed and the PDF (T3) read one definition.
 */

/** A field as an item keeps it: the catalogue's, less the Super Admin's *Perlu dicek* mark (no agent sees it). */
export type SnapshotField = Omit<ProposalField, 'draft'>;

/** A page-2 block as an item keeps it: the catalogue's, less its source (the Super Admin's alone). */
export type SnapshotBlock = Omit<PdfDetailBlock, 'source'>;

/**
 * **What an item copied from its product when it was added — never refreshed** (ADR-0225 §6, Acc. 8, T2 AC-15): an old
 * proposal prints as it was made, whatever the catalogue does next. The labels are here, in both channels' words.
 */
export interface ItemSnapshot {
  /** The name the office's agents read: its display name where it replaced the company's. */
  name: string;
  syariahName: string | null;
  typeLabel: string;
  category: string;
  /** The currencies it sells in, for the item's currency rule (ADR-0225 §8). */
  currencies: ProductCurrency[];
  fields: SnapshotField[];
  /** Up to `PROPOSAL.BENEFITS_ON_PDF_MAX`, for page 2. */
  benefits: string[];
  pdfDetail: SnapshotBlock[];
}

export interface ItemInsured {
  relation: ProposalInsuredRelation;
  /** `null` for *Klien*; required of the others by *Simpan PDF*, and `null` while it is typed. */
  name: string | null;
  age: number | null;
}

/** One item, as `proposals.items[]` stores it. */
export interface StoredItem {
  itemId: string;
  productId: string;
  productCode: string;
  productVersion: number;
  snapshot: ItemSnapshot;
  insured: ItemInsured;
  /** A `chips` field's option label; a `money` field's minor units of the item's currency. A `fixed` field: nothing. */
  fieldValues: Record<string, string | number>;
  /** Per the proposal's *Cara bayar*, in the item's currency. */
  premium: { amountMinor: number | null; currency: ProductCurrency };
  /** Always `null`: the compare mode is *Later*, and the field is here so it needs no migration (AC-15). */
  choice: null;
}

/** What a new item reads of its product. */
export interface ProductForItem {
  _id: unknown;
  code: string;
  version: number;
  category: string;
  currencies?: readonly string[] | null;
  benefits?: readonly string[] | null;
  proposalFields?: readonly ProposalField[] | null;
  pdfDetail?: readonly PdfDetailBlock[] | null;
  syariahName?: string | null;
  defaultInsured?: 'client' | 'child' | null;
  proposalTypeLabel?: string | null;
}

// ------------------------------------------------------------------------------------------------ making one

/** **The snapshot**, from the product as the office reads it (`displayName` its own where it replaced the company's). */
export function snapshotOf(product: ProductForItem, displayName: string): ItemSnapshot {
  return {
    name: displayName,
    syariahName: product.syariahName ?? null,
    typeLabel: typeLabelOf(product),
    category: product.category,
    currencies: [...(product.currencies?.length ? product.currencies : ['IDR'])] as ProductCurrency[],
    fields: (product.proposalFields ?? []).map(({ draft: _draft, ...field }) => ({
      ...field,
      options: field.options.map((option) => ({ ...option })),
      quickAmounts: [...field.quickAmounts],
    })),
    benefits: (product.benefits ?? []).slice(0, PROPOSAL.BENEFITS_ON_PDF_MAX),
    pdfDetail: (product.pdfDetail ?? []).map(({ source: _source, ...block }) => ({
      ...block, rows: block.rows.map((row) => ({ ...row })),
    })),
  };
}

/**
 * **A new item** (ADR-0221 §3; Acc. 7, 12): its snapshot, **every `chips` field preselected** — its default, else its
 * only option — and *Tertanggung* the product's own: *Anak* for an education product, *Klien* for the rest.
 */
export function newItem(itemId: string, product: ProductForItem, displayName: string): StoredItem {
  const snapshot = snapshotOf(product, displayName);
  const fieldValues: Record<string, string | number> = {};
  for (const field of snapshot.fields) {
    if (field.type !== 'chips') continue;
    const preselected = field.options.find((o) => o.label === field.default) ?? (field.options.length === 1 ? field.options[0] : undefined);
    if (preselected) fieldValues[field.key] = preselected.label;
  }
  const relation = insuredOf(product);
  return {
    itemId,
    productId: String(product._id),
    productCode: product.code,
    productVersion: product.version,
    snapshot,
    insured: { relation, name: null, age: null },
    fieldValues,
    premium: { amountMinor: null, currency: currencyOf(snapshot, fieldValues) },
    choice: null,
  };
}

// ------------------------------------------------------------------------------------------------ reading one

/**
 * **The item's currency** (ADR-0225 §8): USD when the product sells only in USD; otherwise IDR, unless the product sells
 * both and has a `currency` field — then the chosen option's currency decides.
 */
export function currencyOf(snapshot: Pick<ItemSnapshot, 'currencies' | 'fields'>, fieldValues: Record<string, string | number>): ProductCurrency {
  if (snapshot.currencies.length === 1 && snapshot.currencies[0] === 'USD') return 'USD';
  const field = snapshot.fields.find((f) => f.currency);
  if (!field || snapshot.currencies.length < 2) return 'IDR';
  const chosen = field.options.find((o) => o.label === fieldValues[field.key]);
  return chosen?.currency ?? 'IDR';
}

/** **The name the proposal shows** (ADR-0221 §9): the syariah name on a *Syariah* proposal, where the product has one. */
export function itemName(snapshot: Pick<ItemSnapshot, 'name' | 'syariahName'>, channel: ProposalChannel): string {
  return channel === 'syariah' && snapshot.syariahName ? snapshot.syariahName : snapshot.name;
}

/** The `plan` field's value, where the product has one. */
export function planOf(item: Pick<StoredItem, 'snapshot' | 'fieldValues'>): string | null {
  const field = item.snapshot.fields.find((f) => f.plan);
  if (!field) return null;
  const value = field.type === 'fixed' ? field.options[0]?.label : item.fieldValues[field.key];
  return typeof value === 'string' ? value : null;
}

/** The whole years of the term (*Masa bayar*, or PRUCerah's *Masa tunggu*), or `null` where it is no number of years. */
export function paymentYearsOf(item: Pick<StoredItem, 'snapshot' | 'fieldValues'>): number | null {
  const field = item.snapshot.fields.find((f) => f.paymentYears);
  if (!field) return null;
  const option = field.type === 'fixed'
    ? field.options[0]
    : field.options.find((o) => o.label === item.fieldValues[field.key]);
  return option?.years ?? null;
}

/**
 * ***Total dibayar selama N tahun*** (§B.34): the premium × the payments a year of *Cara bayar* × the years of the
 * `paymentYears` field, in integer minor units. `null` without a premium, or where the term is no whole number of years.
 */
export function totalPaidOf(
  item: Pick<StoredItem, 'snapshot' | 'fieldValues' | 'premium'>, payFrequency: ProposalPayFrequency,
): { amountMinor: number; years: number } | null {
  const years = paymentYearsOf(item);
  const premium = item.premium.amountMinor;
  if (years === null || premium === null) return null;
  return { amountMinor: premium * PROPOSAL.PAYMENTS_PER_YEAR[payFrequency] * years, years };
}

/** ***Total premi*** (§B.34): the items' premiums summed **per currency**, never across — IDR first. */
export function totalsOf(items: readonly Pick<StoredItem, 'premium'>[]): { currency: ProductCurrency; amountMinor: number }[] {
  const sums = new Map<ProductCurrency, number>();
  for (const { premium } of items) {
    if (premium.amountMinor === null) continue;
    sums.set(premium.currency, (sums.get(premium.currency) ?? 0) + premium.amountMinor);
  }
  return (['IDR', 'USD'] as const).filter((c) => sums.has(c)).map((currency) => ({ currency, amountMinor: sums.get(currency)! }));
}

/**
 * **What *Simpan PDF* still needs of an item** (ADR-0221 §4): a premium above zero; a name and an age for anyone but
 * *Klien*; a value for every `chips` field. Empty when it is complete.
 */
export function missingOf(item: StoredItem): string[] {
  const missing: string[] = [];
  if (item.premium.amountMinor === null || item.premium.amountMinor <= 0) missing.push('premium');
  if (item.insured.relation !== 'client') {
    if (!item.insured.name) missing.push('insured.name');
    if (item.insured.age === null) missing.push('insured.age');
  }
  for (const field of item.snapshot.fields) {
    if (field.type === 'chips' && typeof item.fieldValues[field.key] !== 'string') missing.push(field.key);
  }
  return missing;
}

// ------------------------------------------------------------------------------------------------ writing one

/** What `PATCH /proposals/:id/items/:itemId` may carry, after the pipe has checked its shape. */
export interface ItemPatch {
  insured?: { relation: ProposalInsuredRelation; name?: string | null; age?: number | null };
  fieldValues?: Record<string, unknown>;
  premium?: { amountMinor: number | null };
}

const SAY = PROPOSAL_REFUSALS.VALIDATION_FAILED;

const isWholeAmount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/**
 * **An item with a patch applied, each part checked against the item's own snapshot** (ADR-0221 §3; ADR-0225 §8):
 *
 * - `fieldValues` merges. A `chips` field takes one of its options' labels, never `null`; a `money` field a whole amount
 *   from 0 (at least `minMinor` on an IDR item), or `null` to clear it; a `fixed` field or a key the product does not
 *   have, nothing — each `400 VALIDATION_FAILED` naming the field.
 * - **A change of the `currency` field empties the item's money values and its premium**: a sum in rupiah is not one in
 *   dollars.
 * - `insured`: *Klien* clears the name and the age; anyone else keeps what they had unless sent, and takes a name of 1 to
 *   `PROPOSAL.INSURED_NAME_MAX` characters and an age of 1 to 100 (`422 LEAD_AGE_OUT_OF_RANGE`), either `null` while it
 *   is typed.
 * - `premium.amountMinor`: a whole amount from 0 to `PROPOSAL.PREMIUM_MAX_MINOR`, or `null`.
 */
export function applyItemPatch(item: StoredItem, patch: ItemPatch): StoredItem {
  const next: StoredItem = {
    ...item,
    insured: { ...item.insured },
    fieldValues: { ...item.fieldValues },
    premium: { ...item.premium },
  };

  if (patch.fieldValues !== undefined) {
    const before = currencyOf(item.snapshot, item.fieldValues);
    for (const [key, value] of Object.entries(patch.fieldValues)) {
      const field = item.snapshot.fields.find((f) => f.key === key);
      const at = `fieldValues.${key}`;
      if (!field) throw new InvalidRequestException(SAY.unknownField({ key }), { field: at });
      if (field.type === 'fixed') throw new InvalidRequestException(SAY.fixedField({ key }), { field: at });
      if (field.type === 'chips') {
        if (typeof value !== 'string' || !field.options.some((o) => o.label === value)) {
          throw new InvalidRequestException(SAY.chipsValue({ key }), { field: at });
        }
        next.fieldValues[key] = value;
        continue;
      }
      // money
      if (value === null) {
        delete next.fieldValues[key];
        continue;
      }
      if (!isWholeAmount(value, PROPOSAL.MONEY_MAX_MINOR)) {
        throw new InvalidRequestException(SAY.moneyValue({ key, max: PROPOSAL.MONEY_MAX_MINOR }), { field: at });
      }
      next.fieldValues[key] = value;
    }
    const after = currencyOf(item.snapshot, next.fieldValues);
    if (after !== before) {
      for (const field of item.snapshot.fields) if (field.type === 'money') delete next.fieldValues[field.key];
      next.premium = { amountMinor: null, currency: after };
    }
    // The least sum is in rupiah (ADR-0225 §2): it holds an IDR item only, once its currency is settled.
    if (after === 'IDR') {
      for (const [key] of Object.entries(patch.fieldValues)) {
        const field = item.snapshot.fields.find((f) => f.key === key)!;
        const value = next.fieldValues[key];
        if (field.type === 'money' && field.minMinor !== null && typeof value === 'number' && value < field.minMinor) {
          throw new InvalidRequestException(SAY.belowMinimum({ key, min: field.minMinor }), { field: `fieldValues.${key}` });
        }
      }
    }
  }

  if (patch.insured !== undefined) {
    const { relation } = patch.insured;
    if (!(PROPOSAL_INSURED_RELATIONS as readonly string[]).includes(relation)) {
      throw new InvalidRequestException(SAY.chipsValue({ key: 'insured.relation' }), { field: 'insured.relation' });
    }
    if (relation === 'client') {
      if ((patch.insured.name ?? null) !== null || (patch.insured.age ?? null) !== null) {
        throw new InvalidRequestException(SAY.clientTakesNoName, { field: 'insured' });
      }
      next.insured = { relation, name: null, age: null };
    } else {
      const kept = item.insured.relation === 'client' ? { name: null, age: null } : item.insured;
      const name = patch.insured.name === undefined ? kept.name : patch.insured.name;
      const age = patch.insured.age === undefined ? kept.age : patch.insured.age;
      next.insured = { relation, name: checkedName(name), age: checkedAge(age) };
    }
  }

  if (patch.premium !== undefined) {
    const amount = patch.premium.amountMinor;
    if (amount !== null && !isWholeAmount(amount, PROPOSAL.PREMIUM_MAX_MINOR)) {
      throw new InvalidRequestException(SAY.premiumValue({ max: PROPOSAL.PREMIUM_MAX_MINOR }), { field: 'premium.amountMinor' });
    }
    next.premium = { ...next.premium, amountMinor: amount };
  }
  return next;
}

function checkedName(name: unknown): string | null {
  if (name === null) return null;
  const text = typeof name === 'string' ? name.trim() : null;
  if (text === null || text.length === 0 || text.length > PROPOSAL.INSURED_NAME_MAX) {
    throw new InvalidRequestException(SAY.insuredName({ max: PROPOSAL.INSURED_NAME_MAX }), { field: 'insured.name' });
  }
  return text;
}

/** An insured's age: the lead's bounds and the lead's refusal (ADR-0224 §7). */
function checkedAge(age: unknown): number | null {
  if (age === null) return null;
  if (typeof age !== 'number' || !Number.isInteger(age)) {
    throw new InvalidRequestException(SAY.insuredAgeShape, { field: 'insured.age' });
  }
  if (age < LEAD_AGE.MIN || age > LEAD_AGE.MAX) {
    throw new DomainException(
      ErrorCode.LEAD_AGE_OUT_OF_RANGE,
      LEAD_REFUSALS.LEAD_AGE_OUT_OF_RANGE.between({ min: LEAD_AGE.MIN, max: LEAD_AGE.MAX }),
      HttpStatus.UNPROCESSABLE_ENTITY,
      { min: LEAD_AGE.MIN, max: LEAD_AGE.MAX, field: 'insured.age' },
    );
  }
  return age;
}

/** **A change of *Cara bayar* empties every premium** (ADR-0221 §3): a monthly figure is not an annual one. */
export function withPremiumsEmptied(items: readonly StoredItem[]): StoredItem[] {
  return items.map((item) => ({ ...item, premium: { ...item.premium, amountMinor: null } }));
}
