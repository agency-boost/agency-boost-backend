import { HttpStatus } from '@nestjs/common';
import { DomainException, InvalidRequestException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  LEAD_AGE, LEAD_GENDERS, PROPOSAL, PROPOSAL_INSURED_RELATIONS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_PERIODIC_FREQUENCIES,
  type LeadGender, type ProductCurrency, type ProposalCalcType, type ProposalFixedField, type ProposalInsuredRelation,
  type ProposalNeedTag, type ProposalPayFrequency, type ProposalPeriodicFrequency,
} from '@/domain/constants';
import { LEAD_REFUSALS } from '@/modules/leads/leads.messages';
import type { PayTerm, PdfDetailBlock, PlanRule, ProposalField } from '@/modules/products/proposal-fields';
import {
  calcSettingsOf, frequenciesOf, insuredOf, isSyariahProduct, needTagOf, typeLabelOf,
} from '@/modules/products/proposal-fields';
import type { ItemCalc } from '@/modules/product-data/item-calculation';
import { PROPOSAL_REFUSALS } from './proposals.messages';

/**
 * **A proposal's items: what one is made of, and every rule that reads or writes one** (P19.7-T2; ADR-0221 §1, §3, §4;
 * ADR-0225 §6, §8; *since 2026-11-12, P19.14-T2:* ADR-0255 — *Cara bayar*, the insured's gender, the pay term, the
 * smoker and the sum assured per product; `metrics-and-definitions.md` §B.34). Pure, so each rule is a unit test
 * (`proposal-items.spec.ts`), and the service, the seed, the migration and the PDF read one definition.
 */

/** A field as an item keeps it: the catalogue's, less the Super Admin's *Perlu dicek* mark (no agent sees it). */
export type SnapshotField = Omit<ProposalField, 'draft'>;

/** A page-2 block as an item keeps it: the catalogue's, less its source (the Super Admin's alone). */
export type SnapshotBlock = Omit<PdfDetailBlock, 'source'>;

/** The limits 19.15's calculation reads, in minor units of the item's currency (ADR-0255 §4). */
export interface SnapshotLimits {
  upStep: number | null;
  upMin: number | null;
  upMax: number | null;
  premiumMin: number | null;
  premiumMax: number | null;
}

/**
 * **What an item copied from its product when it was added — never refreshed** (ADR-0225 §6, Acc. 8): an old proposal
 * prints as it was made, whatever the catalogue does next. *Extended 2026-11-12 (P19.14-T2; ADR-0255 §6):* the need it
 * ticks, whether it is syariah, its calculation type, its pay terms, *Cara bayar*, smoker rating, entry ages, plan rule
 * and limits — what the card and the PDF read of the product.
 */
export interface ItemSnapshot {
  /** The name the office's agents read: its display name where it replaced the company's. */
  name: string;
  /**
   * A conventional product's syariah name (ADR-0225 §3). **Read by nothing since P19.14** — there is no channel to read
   * it under (ADR-0255 §1) — and kept so an old snapshot stays whole; the migration put it into `name` where it showed.
   */
  syariahName: string | null;
  typeLabel: string;
  category: string;
  /** The PDF's need tile it ticks (ADR-0255 §5). */
  needTag: ProposalNeedTag;
  /** **A syariah product** (`channel: 'syariah'`): *Kontribusi*, *Santunan asuransi*, *Peserta*, `labelSyariah`. */
  isSyariah: boolean;
  /** Which amounts the card shows: `up_premium` the sum assured beside the premium (ADR-0255 §4). */
  calcType: ProposalCalcType;
  /** The currencies it sells in, for the item's currency rule (ADR-0225 §8). */
  currencies: ProductCurrency[];
  fields: SnapshotField[];
  planRule: PlanRule | null;
  payTerms: PayTerm[];
  /** *Cara bayar* offered, never empty (`frequenciesOf`). */
  frequencies: ProposalPayFrequency[];
  smokerRated: boolean;
  entryAge: { min: number; max: number } | null;
  limits: SnapshotLimits;
  /** Up to `PROPOSAL.BENEFITS_ON_PDF_MAX`, for page 2. */
  benefits: string[];
  pdfDetail: SnapshotBlock[];
}

/** *Tertanggung* (ADR-0255 §2): anyone but *Klien* has a name, an age and a gender of their own. */
export interface ItemInsured {
  relation: ProposalInsuredRelation;
  /** `null` for *Klien* — the client's are the proposal's — and while it is typed. */
  name: string | null;
  age: number | null;
  gender: LeadGender | null;
}

/** An amount in an item's currency. */
export interface ItemMoney {
  amountMinor: number;
  currency: ProductCurrency;
}

/** One item, as `proposals.items[]` stores it (`erd.md`, *Tenant: the proposal*). */
export interface StoredItem {
  itemId: string;
  productId: string;
  productCode: string;
  productVersion: number;
  snapshot: ItemSnapshot;
  insured: ItemInsured;
  /** *Merokok?*: `false` by default on a smoker-rated product, `null` on any other. */
  smoker: boolean | null;
  /** A `chips` field's option label; a `money` field's minor units of the item's currency; a `derived` field's value. */
  fieldValues: Record<string, string | number>;
  /** **The chosen pay term's `key`** in `snapshot.payTerms`, or `null` where the product has none (ADR-0255 §2). */
  payTerm: string | null;
  /** *Cara bayar*: one of `snapshot.frequencies`, or `single` while a single pay term is chosen. */
  payFrequency: ProposalPayFrequency;
  /** The sum assured (*Uang pertanggungan* / *Santunan asuransi*), on an `up_premium` product; `null` until typed. */
  up: ItemMoney | null;
  /** Per *Cara bayar*, in the item's currency; `null` until typed. */
  premium: ItemMoney | null;
  /** The amount typed last, which a calculation keeps (P19.15-T1, ADR-0258 §5); `none` on a `manual` product. */
  fixedField: ProposalFixedField;
  /**
   * **The premium table version the amounts came from** (P19.15-T1 AC-6; ADR-0258 §5), and its *Berlaku mulai*: kept by
   * a saved proposal, so it prints the same numbers and *"tabel tarif berlaku {date}"* again; `null` — typed.
   */
  rateTableVersionId: string | null;
  rateTableEffectiveFrom: string | null;
  /** The card's one-line note, a code the screen words (`CALC_NOTES`): `up_rounded`, `rates_updated`, `table_off`. */
  calcNote: string | null;
  /**
   * **What the card shows of its calculation** (P19.15-T1 AC-5; `item-calculation.ts`): the state, the version's date,
   * the *Cara bayar* it prices, a limit and its chip. `null` — absent on an item stored before 19.15 — on a `manual` one.
   */
  calc?: ItemCalc | null;
  /** Always `null`: the compare mode is *Later*, and the field is here so it needs no migration. */
  choice: null;
}

/** What a new item reads of its product. */
export interface ProductForItem {
  _id: unknown;
  code: string;
  version: number;
  channel: string;
  category: string;
  primaryNeeds?: readonly string[] | null;
  currencies?: readonly string[] | null;
  benefits?: readonly string[] | null;
  proposalFields?: readonly ProposalField[] | null;
  pdfDetail?: readonly PdfDetailBlock[] | null;
  syariahName?: string | null;
  defaultInsured?: 'client' | 'child' | null;
  proposalTypeLabel?: string | null;
  calcType?: string | null;
  entryAge?: { min: number; max: number } | null;
  payTerms?: readonly PayTerm[] | null;
  frequencies?: readonly string[] | null;
  smokerRated?: boolean | null;
  planRule?: PlanRule | null;
  needTag?: string | null;
  upStep?: number | null;
  upMin?: number | null;
  upMax?: number | null;
  premiumMin?: number | null;
  premiumMax?: number | null;
}

// ------------------------------------------------------------------------------------------------ making one

/** **The snapshot**, from the product as the office reads it (`displayName` its own where it replaced the company's). */
export function snapshotOf(product: ProductForItem, displayName: string): ItemSnapshot {
  const calc = calcSettingsOf(product as unknown as Record<string, unknown>);
  return {
    name: displayName,
    syariahName: product.syariahName ?? null,
    typeLabel: typeLabelOf(product),
    category: product.category,
    needTag: needTagOf(product),
    isSyariah: isSyariahProduct(product),
    calcType: calc.calcType,
    currencies: [...(product.currencies?.length ? product.currencies : ['IDR'])] as ProductCurrency[],
    fields: (product.proposalFields ?? []).map(({ draft: _draft, ...field }) => ({
      ...field,
      options: field.options.map((option) => ({ ...option })),
      quickAmounts: [...field.quickAmounts],
    })),
    planRule: calc.planRule,
    payTerms: calc.payTerms,
    frequencies: frequenciesOf(product),
    smokerRated: calc.smokerRated,
    entryAge: calc.entryAge,
    limits: {
      upStep: calc.upStep, upMin: calc.upMin, upMax: calc.upMax, premiumMin: calc.premiumMin, premiumMax: calc.premiumMax,
    },
    benefits: (product.benefits ?? []).slice(0, PROPOSAL.BENEFITS_ON_PDF_MAX),
    pdfDetail: (product.pdfDetail ?? []).map(({ source: _source, ...block }) => ({
      ...block, rows: block.rows.map((row) => ({ ...row })),
    })),
  };
}

/** ***Cara bayar* a new item starts on** (ADR-0255 §2): *Bulanan* where the product offers it, else its first. */
export function defaultFrequencyOf(snapshot: Pick<ItemSnapshot, 'frequencies'>): ProposalPayFrequency {
  const periodic = snapshot.frequencies.filter((f) => f !== 'single');
  if (periodic.includes('monthly')) return 'monthly';
  return periodic[0] ?? snapshot.frequencies[0] ?? 'monthly';
}

/**
 * **A new item** (ADR-0221 §3; ADR-0255 §2; P19.14-T2 AC-3): its snapshot; **every `chips` field preselected** — its
 * default, else its only option — and the `derived` one worked out; *Tertanggung* the product's own (*Anak* for an
 * education product); *Merokok?* *Tidak* where the product asks it; the default pay term, else the longest the insured's
 * age allows; *Cara bayar* *Bulanan* where offered. `clientAge` is the proposal client's, the age a client-insured item
 * is held to.
 */
export function newItem(itemId: string, product: ProductForItem, displayName: string, clientAge: number | null): StoredItem {
  const snapshot = snapshotOf(product, displayName);
  const fieldValues: Record<string, string | number> = {};
  for (const field of snapshot.fields) {
    if (field.type !== 'chips') continue;
    const preselected = field.options.find((o) => o.label === field.default) ?? (field.options.length === 1 ? field.options[0] : undefined);
    if (preselected) fieldValues[field.key] = preselected.label;
  }
  const relation = insuredOf(product);
  const item: StoredItem = {
    itemId,
    productId: String(product._id),
    productCode: product.code,
    productVersion: product.version,
    snapshot,
    insured: { relation, name: null, age: null, gender: null },
    smoker: snapshot.smokerRated ? false : null,
    fieldValues: withDerived(snapshot, fieldValues),
    payTerm: null,
    payFrequency: defaultFrequencyOf(snapshot),
    up: null,
    premium: null,
    fixedField: 'none',
    rateTableVersionId: null,
    rateTableEffectiveFrom: null,
    calcNote: null,
    calc: null,
    choice: null,
  };
  const age = insuredAgeOf(item, clientAge);
  const preferred = snapshot.payTerms.find((t) => t.default && payTermAllowed(t, age));
  return withPayTerm(item, preferred?.key ?? longestAllowed(snapshot.payTerms, age)?.key ?? null);
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

/** **The name the proposal shows** (ADR-0255 §1): the snapshot's — a syariah product is a product with its own name. */
export function itemName(snapshot: Pick<ItemSnapshot, 'name'>): string {
  return snapshot.name;
}

/** The `plan` field's value, where the product has one — chosen, fixed or derived. */
export function planOf(item: Pick<StoredItem, 'snapshot' | 'fieldValues'>): string | null {
  const field = item.snapshot.fields.find((f) => f.plan);
  if (!field) return null;
  const value = field.type === 'fixed' ? field.options[0]?.label : item.fieldValues[field.key];
  return typeof value === 'string' ? value : null;
}

/** **The age an item's pay terms and entry ages are held to** (ADR-0255 §2): the client's for *Klien*, else the insured's. */
export function insuredAgeOf(item: Pick<StoredItem, 'insured'>, clientAge: number | null): number | null {
  return item.insured.relation === 'client' ? clientAge : item.insured.age;
}

/** **A pay term the age allows** (P19.14-T2 AC-4): no limit, no age yet, or an age no older than its `maxEntryAge`. */
export function payTermAllowed(term: Pick<PayTerm, 'maxEntryAge'>, age: number | null): boolean {
  return term.maxEntryAge === null || age === null || age <= term.maxEntryAge;
}

/** How long a term is paid, for *the longest allowed*: its years, the years to its age, nothing for single. */
function termLength(term: PayTerm, age: number | null): number {
  if (term.single) return 0;
  if (term.years !== null) return term.years;
  if (term.toAge !== null) return term.toAge - (age ?? 0);
  return 0;
}

/** **The longest pay term the age allows**, the first of equals; `null` when none is (AC-4). */
export function longestAllowed(terms: readonly PayTerm[], age: number | null): PayTerm | null {
  let best: PayTerm | null = null;
  for (const term of terms) {
    if (!payTermAllowed(term, age)) continue;
    if (best === null || termLength(term, age) > termLength(best, age)) best = term;
  }
  return best;
}

/** The chosen pay term, or `null`. */
export function payTermOf(item: Pick<StoredItem, 'snapshot' | 'payTerm'>): PayTerm | null {
  return item.snapshot.payTerms.find((t) => t.key === item.payTerm) ?? null;
}

/**
 * The whole years of the term — the chosen pay term's, else (an item made before P19.14) the `paymentYears` field's —
 * or `null` where it is no number of years.
 */
export function paymentYearsOf(item: Pick<StoredItem, 'snapshot' | 'fieldValues' | 'payTerm'>): number | null {
  const term = payTermOf(item);
  if (term) return term.years;
  const field = item.snapshot.fields.find((f) => f.paymentYears);
  if (!field) return null;
  const option = field.type === 'fixed'
    ? field.options[0]
    : field.options.find((o) => o.label === item.fieldValues[field.key]);
  return option?.years ?? null;
}

/**
 * ***Total dibayar selama N tahun*** (§B.34): the premium × the payments a year of the item's *Cara bayar* × the years
 * of its term, in integer minor units. `null` without a premium, for *Sekali bayar*, or where the term is no whole number
 * of years.
 */
export function totalPaidOf(
  item: Pick<StoredItem, 'snapshot' | 'fieldValues' | 'premium' | 'payTerm' | 'payFrequency'>,
): { amountMinor: number; years: number } | null {
  const years = paymentYearsOf(item);
  if (years === null || item.premium === null || item.payFrequency === 'single') return null;
  const perYear = PROPOSAL.PAYMENTS_PER_YEAR[item.payFrequency as ProposalPeriodicFrequency];
  return { amountMinor: item.premium.amountMinor * perYear * years, years };
}

/** One line of ***Total premi*** (§B.34; P19.14-T3's *Ringkasan*): the premiums of one currency and one *Cara bayar*. */
export interface ProposalTotal {
  currency: ProductCurrency;
  payFrequency: ProposalPayFrequency;
  amountMinor: number;
  /** How many items it sums. */
  items: number;
}

/**
 * ***Total premi*** (§B.34; ADR-0255 §7): the items' premiums summed **per currency and per *Cara bayar***, never across
 * either — a monthly figure and an annual one are not one sum. IDR first, then *Bulanan → Sekali bayar*.
 */
export function totalsOf(items: readonly Pick<StoredItem, 'premium' | 'payFrequency'>[]): ProposalTotal[] {
  const sums = new Map<string, ProposalTotal>();
  for (const { premium, payFrequency } of items) {
    if (premium === null) continue;
    const key = `${premium.currency}:${payFrequency}`;
    const held = sums.get(key) ?? { currency: premium.currency, payFrequency, amountMinor: 0, items: 0 };
    held.amountMinor += premium.amountMinor;
    held.items += 1;
    sums.set(key, held);
  }
  const order = (t: ProposalTotal) => (t.currency === 'IDR' ? 0 : 10) + PROPOSAL_PAY_FREQUENCIES.indexOf(t.payFrequency);
  return [...sums.values()].sort((a, b) => order(a) - order(b));
}

/**
 * **What *Simpan PDF* still needs of an item** (ADR-0221 §4; ADR-0255 §2): a premium above zero; a name and an age for
 * anyone but *Klien*; a value for every `chips` and `derived` field; a pay term where the product has any. Empty when it
 * is complete. The insured's gender is asked, never required.
 */
export function missingOf(item: StoredItem): string[] {
  const missing: string[] = [];
  // P19.15-T1 AC-5 (ADR-0258 §5): a calculation that failed emptied its amount, and a premium typed beside it is not
  // the table's — *Simpan PDF* asks for it until the card calculates.
  const failed = item.calc?.mode === 'table' && item.calc.state !== 'ok';
  if (item.premium === null || item.premium.amountMinor <= 0 || failed) missing.push('premium');
  if (item.insured.relation !== 'client') {
    if (!item.insured.name) missing.push('insured.name');
    if (item.insured.age === null) missing.push('insured.age');
  }
  for (const field of item.snapshot.fields) {
    if ((field.type === 'chips' || field.type === 'derived') && typeof item.fieldValues[field.key] !== 'string') missing.push(field.key);
  }
  if (item.snapshot.payTerms.length > 0 && payTermOf(item) === null) missing.push('payTerm');
  return missing;
}

// ------------------------------------------------------------------------------------------------ writing one

/** What `PATCH /proposals/:id/items/:itemId` may carry, after the pipe has checked its shape. */
export interface ItemPatch {
  insured?: { relation: ProposalInsuredRelation; name?: string | null; age?: number | null; gender?: LeadGender | null };
  fieldValues?: Record<string, unknown>;
  smoker?: boolean;
  payTerm?: string;
  payFrequency?: ProposalPayFrequency;
  up?: { amountMinor: number | null };
  premium?: { amountMinor: number | null };
}

const SAY = PROPOSAL_REFUSALS.VALIDATION_FAILED;

const isWholeAmount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/** **The `derived` field worked out** (ADR-0255 §3): the first rule whose conditions all hold, else no value. */
export function withDerived(
  snapshot: Pick<ItemSnapshot, 'planRule' | 'fields'>, fieldValues: Record<string, string | number>,
): Record<string, string | number> {
  const rule = snapshot.planRule;
  if (!rule || !snapshot.fields.some((f) => f.key === rule.field && f.type === 'derived')) return fieldValues;
  const next = { ...fieldValues };
  const match = rule.rules.find((r) => Object.entries(r.when).every(([key, option]) => next[key] === option));
  if (match) next[rule.field] = match.value;
  else delete next[rule.field];
  return next;
}

/**
 * **An item on a pay term** (ADR-0255 §2): the term chosen, and *Cara bayar* following it — `single` while a single
 * term is chosen, back to the default when it no longer is. A change of *Cara bayar* empties the premium: a monthly
 * figure is not an annual one.
 */
function withPayTerm(item: StoredItem, key: string | null): StoredItem {
  const term = item.snapshot.payTerms.find((t) => t.key === key) ?? null;
  let payFrequency = item.payFrequency;
  if (term?.single) payFrequency = 'single';
  else if (payFrequency === 'single' && !item.snapshot.frequencies.includes('single')) payFrequency = defaultFrequencyOf(item.snapshot);
  return withFrequency({ ...item, payTerm: term?.key ?? null }, payFrequency);
}

function withFrequency(item: StoredItem, payFrequency: ProposalPayFrequency): StoredItem {
  if (payFrequency === item.payFrequency) return item;
  return { ...item, payFrequency, premium: null };
}

/**
 * **The pay term held to the insured's age** (P19.14-T2 AC-4): a term the age no longer allows moves to the longest it
 * does — `null` when it allows none, which *Simpan PDF* then asks for. A term still allowed is kept.
 */
export function settlePayTerm(item: StoredItem, clientAge: number | null): StoredItem {
  if (item.snapshot.payTerms.length === 0) return item.payTerm === null ? item : { ...item, payTerm: null };
  const age = insuredAgeOf(item, clientAge);
  const current = payTermOf(item);
  if (current && payTermAllowed(current, age)) return item;
  return withPayTerm(item, longestAllowed(item.snapshot.payTerms, age)?.key ?? null);
}

/**
 * **An item with a patch applied, each part checked against the item's own snapshot** (ADR-0221 §3; ADR-0225 §8;
 * ADR-0255 §2):
 *
 * - `fieldValues` merges. A `chips` field takes one of its options' labels, never `null`; a `money` field a whole amount
 *   from 0 (at least `minMinor` on an IDR item), or `null` to clear it; a `fixed` or `derived` field, or a key the product
 *   does not have, nothing — each `400 VALIDATION_FAILED` naming the field. The `derived` field is worked out again.
 * - **A change of the `currency` field empties the item's money values, its sum assured and its premium**.
 * - `insured`: *Klien* clears the name, the age and the gender; anyone else keeps what they had unless sent, and takes a
 *   name of 1 to `PROPOSAL.INSURED_NAME_MAX` characters, an age of 1 to 100 (`422 LEAD_AGE_OUT_OF_RANGE`) and a gender,
 *   each `null` while it is typed. The pay term is then held to the insured's age.
 * - `smoker` only on a smoker-rated product; `payTerm` one of the product's that the age allows; `payFrequency` one the
 *   product offers (`single` only with a single term). A change of *Cara bayar* empties the premium.
 * - `up` on an `up_premium` product, `premium` on any: a whole amount from 0 to `PROPOSAL.PREMIUM_MAX_MINOR`
 *   (`MONEY_MAX_MINOR` for the sum assured), or `null`.
 */
export function applyItemPatch(item: StoredItem, patch: ItemPatch, clientAge: number | null): StoredItem {
  let next: StoredItem = {
    ...item,
    insured: { ...item.insured },
    fieldValues: { ...item.fieldValues },
  };

  if (patch.fieldValues !== undefined) {
    const before = currencyOf(item.snapshot, item.fieldValues);
    for (const [key, value] of Object.entries(patch.fieldValues)) {
      const field = item.snapshot.fields.find((f) => f.key === key);
      const at = `fieldValues.${key}`;
      if (!field) throw new InvalidRequestException(SAY.unknownField({ key }), { field: at });
      if (field.type === 'fixed' || field.type === 'derived') throw new InvalidRequestException(SAY.fixedField({ key }), { field: at });
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
      next.up = null;
      next.premium = null;
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
    next.fieldValues = withDerived(item.snapshot, next.fieldValues);
  }

  if (patch.insured !== undefined) {
    const { relation } = patch.insured;
    if (!(PROPOSAL_INSURED_RELATIONS as readonly string[]).includes(relation)) {
      throw new InvalidRequestException(SAY.chipsValue({ key: 'insured.relation' }), { field: 'insured.relation' });
    }
    if (relation === 'client') {
      const { name = null, age = null, gender = null } = patch.insured;
      if (name !== null || age !== null || gender !== null) {
        throw new InvalidRequestException(SAY.clientTakesNoName, { field: 'insured' });
      }
      next.insured = { relation, name: null, age: null, gender: null };
    } else {
      const kept = item.insured.relation === 'client' ? { name: null, age: null, gender: null } : item.insured;
      const name = patch.insured.name === undefined ? kept.name : patch.insured.name;
      const age = patch.insured.age === undefined ? kept.age : patch.insured.age;
      const gender = patch.insured.gender === undefined ? kept.gender : patch.insured.gender;
      next.insured = { relation, name: checkedName(name), age: checkedAge(age, 'insured.age'), gender: checkedGender(gender) };
    }
    next = settlePayTerm(next, clientAge);
  }

  if (patch.smoker !== undefined) {
    if (!item.snapshot.smokerRated || typeof patch.smoker !== 'boolean') {
      throw new InvalidRequestException(SAY.smokerValue, { field: 'smoker' });
    }
    next.smoker = patch.smoker;
  }

  if (patch.payTerm !== undefined) {
    const term = item.snapshot.payTerms.find((t) => t.key === patch.payTerm);
    if (!term || !payTermAllowed(term, insuredAgeOf(next, clientAge))) {
      throw new InvalidRequestException(SAY.payTermValue, { field: 'payTerm' });
    }
    next = withPayTerm(next, term.key);
  }

  if (patch.payFrequency !== undefined) {
    const single = payTermOf(next)?.single ?? false;
    const offered = single ? ['single'] : next.snapshot.frequencies.filter((f) => f !== 'single' || !next.snapshot.payTerms.length);
    if (!offered.includes(patch.payFrequency)) {
      throw new InvalidRequestException(SAY.payFrequencyValue, { field: 'payFrequency' });
    }
    next = withFrequency(next, patch.payFrequency);
  }

  const currency = currencyOf(item.snapshot, next.fieldValues);
  if (patch.up !== undefined) {
    const amount = patch.up.amountMinor;
    if (item.snapshot.calcType !== 'up_premium' || (amount !== null && !isWholeAmount(amount, PROPOSAL.MONEY_MAX_MINOR))) {
      throw new InvalidRequestException(SAY.upValue({ max: PROPOSAL.MONEY_MAX_MINOR }), { field: 'up.amountMinor' });
    }
    next.up = amount === null ? null : { amountMinor: amount, currency };
  }

  if (patch.premium !== undefined) {
    const amount = patch.premium.amountMinor;
    if (amount !== null && !isWholeAmount(amount, PROPOSAL.PREMIUM_MAX_MINOR)) {
      throw new InvalidRequestException(SAY.premiumValue({ max: PROPOSAL.PREMIUM_MAX_MINOR }), { field: 'premium.amountMinor' });
    }
    next.premium = amount === null ? null : { amountMinor: amount, currency };
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

function checkedGender(gender: unknown): LeadGender | null {
  if (gender === null) return null;
  if (!(LEAD_GENDERS as readonly unknown[]).includes(gender)) {
    throw new InvalidRequestException(SAY.insuredGender, { field: 'insured.gender' });
  }
  return gender as LeadGender;
}

/**
 * **An age at the next birthday** — the client's or an insured's: `LEAD_AGE`'s bounds and its refusal, `422
 * LEAD_AGE_OUT_OF_RANGE` with `details: { min, max, field }` (ADR-0224 §7, kept by ADR-0254 §2).
 */
export function checkedAge(age: unknown, field: string): number | null {
  if (age === null) return null;
  if (typeof age !== 'number' || !Number.isInteger(age)) {
    throw new InvalidRequestException(SAY.insuredAgeShape, { field });
  }
  if (age < LEAD_AGE.MIN || age > LEAD_AGE.MAX) {
    throw new DomainException(
      ErrorCode.LEAD_AGE_OUT_OF_RANGE,
      LEAD_REFUSALS.LEAD_AGE_OUT_OF_RANGE.between({ min: LEAD_AGE.MIN, max: LEAD_AGE.MAX }),
      HttpStatus.UNPROCESSABLE_ENTITY,
      { min: LEAD_AGE.MIN, max: LEAD_AGE.MAX, field },
    );
  }
  return age;
}

/** Whether a frequency is one of the four periodic ones. */
export const isPeriodic = (f: ProposalPayFrequency): f is ProposalPeriodicFrequency =>
  (PROPOSAL_PERIODIC_FREQUENCIES as readonly string[]).includes(f);
