import { InvalidRequestException } from '@/common/errors/domain.exception';
import type { Sentence } from '@/common/i18n/sentence';
import { plainText, plainTextLines } from '@/common/validation/plain-text';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import {
  PDF_DETAIL_BLOCKS, PROPOSAL, PROPOSAL_DEFAULT_INSURED, PROPOSAL_FIELD_KEY_PATTERN, PROPOSAL_FIELD_TYPES,
  PROPOSAL_RESERVED_KEYS, PROPOSAL_TEXT_MAX, PRODUCT_CURRENCIES, PROPOSAL_TYPE_LABEL_BY_CATEGORY, defaultInsuredFor,
  PROPOSAL_CALC_TYPES, PROPOSAL_CATALOGUE, PROPOSAL_NEED_TAGS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_PAY_TERM_KEY_PATTERN,
  PROPOSAL_PERIODIC_FREQUENCIES, needTagFor,
  type PdfDetailBlockKind, type ProductCurrency, type ProposalCalcType, type ProposalDefaultInsured,
  type ProposalFieldType, type ProposalNeedTag, type ProposalPayFrequency,
} from '@/domain/constants';
import { checkFormula } from './proposal-formula';
import { PROPOSAL_FIELDS_REFUSALS } from './proposal-fields.messages';

/**
 * **What a product carries for the proposal** (P19.7-T1 AC-2, AC-3; ADR-0225 §1, §2, §5): the shapes, the rules a save
 * checks, the defaults read where nothing was set, and the office's two overrides — the FAQ and each plan's highlights —
 * read for agents as the approved script is (ADR-0037).
 *
 * Pure, so the rules are pinned without a database (`proposal-fields.spec.ts`), and the same functions serve the
 * Super Admin's `PATCH`, the Prudential import and the demo seed.
 */

/** One choice of a `chips` field, or the one sentence of a `fixed` one (ADR-0225 §1). */
export interface ProposalOption {
  label: string;
  /** On the `paymentYears` field: the whole years of the term, or `null` where it is no number of years. */
  years: number | null;
  /** On the `currency` field: the currency the option sells in. `null` on every other field. */
  currency: ProductCurrency | null;
}

/** One field of a product's proposal panel, between *Tertanggung* and the premium (ADR-0225 §1). */
export interface ProposalField {
  key: string;
  label: string;
  /** The label a *Syariah* proposal reads (*Uang pertanggungan* → *Santunan asuransi*), or `null` for the same. */
  labelSyariah: string | null;
  type: ProposalFieldType;
  options: ProposalOption[];
  /** A `chips` field's preselected option, by label; a `fixed` field's one; `null` on a `money` or `derived` field. */
  default: string | null;
  /** A `money` field's quick amounts, IDR minor units, smallest first. */
  quickAmounts: number[];
  /** A `money` field's least sum, IDR minor units (*min 100 jt*), or `null`. */
  minMinor: number | null;
  showOnPdf: boolean;
  /** One of the two to four figures page 1 prints under the product. */
  showOnSummary: boolean;
  /** The field whose option's `years` makes *Total dibayar selama N tahun* (at most one per product). */
  paymentYears: boolean;
  /** The field whose options name the plans, *Lihat semua plan*'s cards (at most one). */
  plan: boolean;
  /** The field whose option decides the item's currency (at most one). */
  currency: boolean;
  /** **The Prudential draft's *[cek]*** (OD-273): *Perlu dicek* for the Super Admin, nothing for an agent. */
  draft: boolean;
}

/** One of a plan card's three or four numbers. */
export interface PlanHighlight { label: string; value: string }

/** One plan card (*Lihat semua plan*), named as an option of the `plan` field. In order, cheapest first. */
export interface PlanOption {
  name: string;
  highlights: PlanHighlight[];
  /** *Paling banyak dipilih* — at most one. */
  popular: boolean;
}

/** One question of *Tanya-jawab*: for the agent, never printed. */
export interface FaqEntry { question: string; answer: string }

/** One row of a page-2 detail block: a formula over the product's money keys, or a text. */
export interface PdfDetailRow {
  label: string;
  note: string | null;
  formula: string | null;
  text: string | null;
}

/** One of page 2's detail blocks, with the illustration it was read from (the Super Admin's only). */
export interface PdfDetailBlock {
  block: PdfDetailBlockKind;
  rows: PdfDetailRow[];
  source: { file: string; page: number; date: string };
  /** *tidak dijamin*, on `nilai_tunai` only. */
  notGuaranteed: boolean;
}

/**
 * **One pay term of a product** (P19.14-T2; ADR-0255 §2; the 11 Nov spec's `payTerms[]`): *5 th*, *s/d usia 60*,
 * *Sekali bayar*, or a sentence (*"Diperbarui tiap tahun s/d usia 99"*). **`maxEntryAge` is the oldest age at the next
 * birthday it is offered at**: an insured older than it sees it crossed out.
 */
export interface PayTerm {
  key: string;
  label: string;
  /** The whole years of paying — *Total dibayar selama N tahun* reads them — or `null`. */
  years: number | null;
  /** Paying until this age (*s/d usia 60*), or `null`. */
  toAge: number | null;
  /** *Sekali bayar*: the item's *Cara bayar* is `single` while it is chosen. */
  single: boolean;
  /** The oldest age at the next birthday the term is offered at, or `null` for no limit. */
  maxEntryAge: number | null;
  /** The term a new item starts on (the Prudential list's bold one); at most one, else the first the insured may take. */
  default: boolean;
}

/** One rule of a derived plan: *when these chips read these options, the plan is this*. */
export interface PlanRuleEntry {
  when: Record<string, string>;
  value: string;
}

/** **How a derived field is worked out** (ADR-0255 §3): the rules, first match wins; none matching leaves it empty. */
export interface PlanRule {
  /** The product's `derived` field. */
  field: string;
  rules: PlanRuleEntry[];
}

/**
 * **The catalogue's calculation fields** (P19.14-T2 AC-5; ADR-0255 §4, §5; the 11 Nov spec's *Products (catalog)*):
 * what decides the amounts an agent's card shows, the pay terms and *Cara bayar* it offers, and — once 19.15 loads a
 * table — the premium. Every one has a default that changes nothing for a product nobody filled.
 */
export interface ProposalCalcSettings {
  /** `manual` by default; every product is typed by the agent until `rateTableId` is set (19.15). */
  calcType: ProposalCalcType;
  /** The ages at the next birthday a client may enter at; `null` for no limit. */
  entryAge: { min: number; max: number } | null;
  /** `[]` for none: the card shows no *Masa bayar* row, and a `paymentYears` field (ADR-0225 §1) still counts. */
  payTerms: PayTerm[];
  /** *Cara bayar* offered, in `PROPOSAL_PAY_FREQUENCIES`' order; `[]` reads the four periodic ones. */
  frequencies: ProposalPayFrequency[];
  /** *Merokok?* is asked only where the premium differs for smokers. */
  smokerRated: boolean;
  planRule: PlanRule | null;
  /** The sum assured is rounded down to a multiple of this, minor units; `null` for none (19.15). */
  upStep: number | null;
  upMin: number | null;
  upMax: number | null;
  premiumMin: number | null;
  premiumMax: number | null;
  /** The active premium table's version (19.15); `null` — every product today — is `manual`. */
  rateTableId: string | null;
  /** The need tile it ticks; `null` reads {@link needTagFor}'s. */
  needTag: ProposalNeedTag | null;
}

/** Everything the proposal reads from a product, as stored. */
export interface ProposalSettings extends ProposalCalcSettings {
  proposalFields: ProposalField[];
  planOptions: PlanOption[];
  faq: FaqEntry[];
  pdfDetail: PdfDetailBlock[];
  syariahName: string | null;
  /** `null` reads {@link defaultInsuredFor}'s: *Anak* for an education product, else *Klien*. */
  defaultInsured: ProposalDefaultInsured | null;
  /** `null` reads the category's (`PROPOSAL_TYPE_LABEL_BY_CATEGORY`). */
  proposalTypeLabel: string | null;
}

/** The calculation keys (ADR-0255 §5), in the order the editor shows them. */
export const PROPOSAL_CALC_KEYS = [
  'calcType', 'entryAge', 'payTerms', 'frequencies', 'smokerRated', 'planRule', 'upStep', 'upMin', 'upMax',
  'premiumMin', 'premiumMax', 'rateTableId', 'needTag',
] as const satisfies readonly (keyof ProposalCalcSettings)[];

/** The keys a product's write may carry for the proposal (ADR-0225 §1; ADR-0255 §5). */
export const PROPOSAL_SETTING_KEYS = [
  'proposalFields', 'planOptions', 'faq', 'pdfDetail', 'syariahName', 'defaultInsured', 'proposalTypeLabel',
  ...PROPOSAL_CALC_KEYS,
] as const satisfies readonly (keyof ProposalSettings)[];

/** What a save checks the proposal fields against: the product as it will be once written. */
export interface ProductFacts {
  channel: string;
  category: string;
  currencies: readonly string[];
  /** The office calendar's today, `YYYY-MM-DD`: a block's source is dated no later. */
  today: string;
}

/** Nothing calculated: `manual`, no limits, no pay terms, the four periodic *Cara bayar* (ADR-0255 §5). */
export const EMPTY_CALC_SETTINGS: ProposalCalcSettings = {
  calcType: 'manual', entryAge: null, payTerms: [], frequencies: [], smokerRated: false, planRule: null,
  upStep: null, upMin: null, upMax: null, premiumMin: null, premiumMax: null, rateTableId: null, needTag: null,
};

/** Nothing set: a product with no proposal fields is still offered, with *Tertanggung* and the premium (§1). */
export const EMPTY_PROPOSAL_SETTINGS: ProposalSettings = {
  proposalFields: [], planOptions: [], faq: [], pdfDetail: [], syariahName: null, defaultInsured: null,
  proposalTypeLabel: null, ...EMPTY_CALC_SETTINGS,
};

/** **A product's calculation fields as stored, each absent one its default** — a product nobody filled reads `manual`. */
export function calcSettingsOf(product: Partial<Record<keyof ProposalCalcSettings, unknown>>): ProposalCalcSettings {
  const out = { ...EMPTY_CALC_SETTINGS } as Record<string, unknown>;
  for (const key of PROPOSAL_CALC_KEYS) {
    const value = product[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return JSON.parse(JSON.stringify(out)) as ProposalCalcSettings;
}

/** ***Cara bayar* a product offers** (ADR-0255 §2): its own, else the four periodic ones. */
export function frequenciesOf(product: { frequencies?: readonly string[] | null }): ProposalPayFrequency[] {
  const own = (product.frequencies ?? []).filter((f): f is ProposalPayFrequency =>
    (PROPOSAL_PAY_FREQUENCIES as readonly string[]).includes(f));
  return own.length > 0 ? own : [...PROPOSAL_PERIODIC_FREQUENCIES];
}

/** **The need tile a product ticks** (ADR-0255 §5): its own, else its first need's or its category's. */
export function needTagOf(product: { needTag?: string | null; category: string; primaryNeeds?: readonly string[] | null }): ProposalNeedTag {
  return (PROPOSAL_NEED_TAGS as readonly string[]).includes(product.needTag ?? '')
    ? product.needTag as ProposalNeedTag
    : needTagFor(product.category, product.primaryNeeds ?? []);
}

/**
 * **A syariah product** (ADR-0255 §1): `channel: 'syariah'` — no flag of its own, so the two can never disagree. It reads
 * *Kontribusi*, *Santunan asuransi* and *Peserta*.
 */
export const isSyariahProduct = (product: { channel: string }): boolean => product.channel === 'syariah';

/** The PDF's type label a product prints: its own, else its category's (ADR-0225 §1). */
export function typeLabelOf(product: { proposalTypeLabel?: string | null; category: string }): string {
  return product.proposalTypeLabel
    || PROPOSAL_TYPE_LABEL_BY_CATEGORY[product.category as keyof typeof PROPOSAL_TYPE_LABEL_BY_CATEGORY]
    || product.category.toUpperCase();
}

/** Who a product insures: its own, else *Anak* for education and *Klien* for the rest (ADR-0225 §1). */
export function insuredOf(product: { defaultInsured?: ProposalDefaultInsured | null; category: string }): ProposalDefaultInsured {
  return product.defaultInsured ?? defaultInsuredFor(product.category);
}

// ------------------------------------------------------------------------------------------- reading a body

const SAY = PROPOSAL_FIELDS_REFUSALS.VALIDATION_FAILED;
const COMMON = VALIDATION_REFUSALS.VALIDATION_FAILED;

/** The refusal: `400 VALIDATION_FAILED`, the sentence, and `details.field` naming the path (ADR-0225 §2). */
function refuse(sentence: Sentence<'VALIDATION_FAILED'>, field: string): never {
  throw new InvalidRequestException(sentence, { field });
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(SAY.notAnObject({ field: path }), path);
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!keys.includes(key) && o[key] !== undefined) refuse(COMMON.unknownField({ key: `${path}.${key}` }), `${path}.${key}`);
  }
  return o;
}

function list(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) refuse(SAY.notAList({ field: path }), path);
  const items = value as unknown[];
  if (items.length > max || items.length < min) {
    refuse(min > 0 ? SAY.listBetween({ field: path, min, max }) : SAY.listAtMost({ field: path, max }), path);
  }
  return items;
}

/** Required text, markup out (P19-T6's validator), one line — or its lines kept — and 1 to `max` characters. */
function text(value: unknown, path: string, max: number, lines = false): string {
  if (value === undefined || value === null) refuse(COMMON.required({ field: path }), path);
  if (typeof value !== 'string') refuse(COMMON.notText({ field: path }), path);
  const clean = lines ? plainTextLines(value) : plainText(value);
  if (clean.length < 1 || clean.length > max) refuse(COMMON.textBetween({ field: path, min: 1, max }), path);
  return clean;
}

/** Optional text: absent, `null` or blank is `null`. */
function optionalText(value: unknown, path: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') refuse(COMMON.notText({ field: path }), path);
  const clean = plainText(value);
  if (clean.length > max) refuse(COMMON.textAtMost({ field: path, max }), path);
  return clean === '' ? null : clean;
}

function flag(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') refuse(SAY.notBoolean({ field: path }), path);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (!(values as readonly unknown[]).includes(value)) refuse(COMMON.oneOf({ field: path, values }), path);
  return value as T;
}

const FIELD_KEYS = [
  'key', 'label', 'labelSyariah', 'type', 'options', 'default', 'quickAmounts', 'minMinor',
  'showOnPdf', 'showOnSummary', 'paymentYears', 'plan', 'currency', 'draft',
] as const;

function readOption(raw: unknown, path: string, onCurrencyField: boolean): ProposalOption {
  const o = record(raw, path, ['label', 'years', 'currency']);
  const years = o.years === undefined || o.years === null ? null : o.years;
  if (years !== null && (typeof years !== 'number' || !Number.isInteger(years) || years < 1 || years > PROPOSAL.PAYMENT_YEARS_MAX)) {
    refuse(SAY.yearsShape({ field: `${path}.years`, max: PROPOSAL.PAYMENT_YEARS_MAX }), `${path}.years`);
  }
  const currency = o.currency === undefined || o.currency === null
    ? null : oneOf(o.currency, `${path}.currency`, PRODUCT_CURRENCIES);
  return {
    label: text(o.label, `${path}.label`, PROPOSAL_TEXT_MAX.OPTION_LABEL),
    years: years as number | null,
    // Only the currency field's options carry one (§8); on any other field it is not kept.
    currency: onCurrencyField ? currency : null,
  };
}

/** One field, read and held to its own rules (§2); the rules across fields are {@link readFields}'. */
function readField(raw: unknown, path: string, facts: ProductFacts): ProposalField {
  const o = record(raw, path, FIELD_KEYS);
  const key = o.key;
  if (typeof key !== 'string' || !PROPOSAL_FIELD_KEY_PATTERN.test(key)) refuse(SAY.keyShape({ field: `${path}.key` }), `${path}.key`);
  if ((PROPOSAL_RESERVED_KEYS as readonly string[]).includes(key)) {
    refuse(SAY.keyReserved({ field: `${path}.key`, key }), `${path}.key`);
  }
  const type = oneOf(o.type, `${path}.type`, PROPOSAL_FIELD_TYPES);
  const flags = {
    showOnPdf: flag(o.showOnPdf, `${path}.showOnPdf`, true),
    showOnSummary: flag(o.showOnSummary, `${path}.showOnSummary`, false),
    paymentYears: flag(o.paymentYears, `${path}.paymentYears`, false),
    plan: flag(o.plan, `${path}.plan`, false),
    currency: flag(o.currency, `${path}.currency`, false),
    draft: flag(o.draft, `${path}.draft`, false),
  };
  const onType = (name: 'paymentYears' | 'plan' | 'currency', types: readonly ProposalFieldType[]) => {
    if (flags[name] && !types.includes(type)) {
      refuse(SAY.flagOnType({ field: `${path}.${name}`, flag: name, types: types.join(' / ') }), `${path}.${name}`);
    }
  };
  onType('paymentYears', ['chips', 'fixed']);
  onType('plan', ['chips', 'derived']);
  onType('currency', ['chips']);

  const options = list(o.options, `${path}.options`, PROPOSAL.CHIP_OPTIONS_MAX)
    .map((option, i) => readOption(option, `${path}.options[${i}]`, flags.currency));
  const quickAmounts = list(o.quickAmounts, `${path}.quickAmounts`, PROPOSAL.QUICK_AMOUNTS_MAX);
  const minMinor = o.minMinor === undefined || o.minMinor === null ? null : o.minMinor;
  let fallback: string | null = null;

  if (type === 'money') {
    if (options.length > 0) refuse(SAY.notForType({ field: `${path}.options`, type }), `${path}.options`);
    if (o.default !== undefined && o.default !== null) refuse(SAY.notForType({ field: `${path}.default`, type }), `${path}.default`);
    if (quickAmounts.some((a, i) => typeof a !== 'number' || !Number.isInteger(a) || a <= 0
      || (i > 0 && a <= (quickAmounts[i - 1] as number)))) {
      refuse(SAY.amountsAscending({ field: `${path}.quickAmounts` }), `${path}.quickAmounts`);
    }
    if (minMinor !== null && (typeof minMinor !== 'number' || !Number.isInteger(minMinor) || minMinor < 0)) {
      refuse(SAY.wholeAmount({ field: `${path}.minMinor` }), `${path}.minMinor`);
    }
  } else {
    if (quickAmounts.length > 0) refuse(SAY.notForType({ field: `${path}.quickAmounts`, type }), `${path}.quickAmounts`);
    if (minMinor !== null) refuse(SAY.notForType({ field: `${path}.minMinor`, type }), `${path}.minMinor`);
    const labels = options.map((option) => option.label);
    const twice = labels.find((label, i) => labels.indexOf(label) !== i);
    if (twice !== undefined) refuse(SAY.labelsTwice({ field: `${path}.options`, label: twice }), `${path}.options`);
    if (type === 'derived') {
      // ADR-0255 §3: the values the plan rule may give, nothing preselected — the rule fills it.
      if (options.length < 1) {
        refuse(SAY.listBetween({ field: `${path}.options`, min: 1, max: PROPOSAL.CHIP_OPTIONS_MAX }), `${path}.options`);
      }
      if (o.default !== undefined && o.default !== null) refuse(SAY.notForType({ field: `${path}.default`, type }), `${path}.default`);
    } else if (type === 'fixed') {
      if (options.length !== 1) refuse(SAY.fixedOneOption({ field: `${path}.options` }), `${path}.options`);
      if (o.default !== undefined && o.default !== null && o.default !== labels[0]) {
        refuse(SAY.defaultNotAnOption({ field: `${path}.default` }), `${path}.default`);
      }
      fallback = labels[0];
    } else {
      if (options.length < 1) {
        refuse(SAY.listBetween({ field: `${path}.options`, min: 1, max: PROPOSAL.CHIP_OPTIONS_MAX }), `${path}.options`);
      }
      // Every chips field is preselected (Acc. 7): a default is required, and it is one of the options.
      if (typeof o.default !== 'string' || !labels.includes(plainText(o.default))) {
        refuse(SAY.defaultNotAnOption({ field: `${path}.default` }), `${path}.default`);
      }
      fallback = plainText(o.default);
    }
    if (flags.currency) {
      const sold = options.findIndex((option) => option.currency === null || !facts.currencies.includes(option.currency));
      if (sold >= 0) {
        const at = `${path}.options[${sold}].currency`;
        refuse(SAY.currencyNotSold({ field: at, currencies: facts.currencies.join(' + ') }), at);
      }
    }
  }

  return {
    key,
    label: text(o.label, `${path}.label`, PROPOSAL_TEXT_MAX.FIELD_LABEL),
    labelSyariah: optionalText(o.labelSyariah, `${path}.labelSyariah`, PROPOSAL_TEXT_MAX.FIELD_LABEL),
    type,
    options,
    default: fallback,
    quickAmounts: quickAmounts as number[],
    minMinor: minMinor as number | null,
    ...flags,
  };
}

/** The fields, each by its own rules, then the rules across them (§2). */
function readFields(value: unknown, facts: ProductFacts): ProposalField[] {
  const fields = list(value, 'proposalFields', PROPOSAL.FIELDS_MAX)
    .map((raw, i) => readField(raw, `proposalFields[${i}]`, facts));
  const keys = fields.map((f) => f.key);
  const twice = keys.findIndex((key, i) => keys.indexOf(key) !== i);
  if (twice >= 0) refuse(SAY.keyTwice({ field: `proposalFields[${twice}].key`, key: keys[twice] }), `proposalFields[${twice}].key`);
  let onSummary = 0;
  fields.forEach((f, i) => {
    if (f.showOnSummary && ++onSummary > PROPOSAL.SUMMARY_FIELDS_MAX) {
      refuse(SAY.tooManyOnSummary({ field: `proposalFields[${i}].showOnSummary`, max: PROPOSAL.SUMMARY_FIELDS_MAX }),
        `proposalFields[${i}].showOnSummary`);
    }
  });
  for (const name of ['paymentYears', 'plan', 'currency'] as const) {
    const marked = fields.map((f, i) => (f[name] ? i : -1)).filter((i) => i >= 0);
    if (marked.length > 1) refuse(SAY.onlyOneFlag({ field: `proposalFields[${marked[1]}].${name}`, flag: name }), `proposalFields[${marked[1]}].${name}`);
  }
  const derived = fields.map((f, i) => (f.type === 'derived' ? i : -1)).filter((i) => i >= 0);
  if (derived.length > 1) refuse(SAY.derivedNeedsRule({ field: `proposalFields[${derived[1]}].type` }), `proposalFields[${derived[1]}].type`);
  return fields;
}

function readHighlights(value: unknown, path: string): PlanHighlight[] {
  return list(value, path, PROPOSAL.PLAN_HIGHLIGHTS_MAX, 1).map((raw, i) => {
    const h = record(raw, `${path}[${i}]`, ['label', 'value']);
    return {
      label: text(h.label, `${path}[${i}].label`, PROPOSAL_TEXT_MAX.HIGHLIGHT_LABEL),
      value: text(h.value, `${path}[${i}].value`, PROPOSAL_TEXT_MAX.HIGHLIGHT_VALUE),
    };
  });
}

/** The plan cards, each naming an option of the `plan` field once (§2). */
function readPlans(value: unknown, fields: readonly ProposalField[]): PlanOption[] {
  const plans = list(value, 'planOptions', PROPOSAL.PLAN_OPTIONS_MAX).map((raw, i) => {
    const p = record(raw, `planOptions[${i}]`, ['name', 'highlights', 'popular']);
    return {
      name: text(p.name, `planOptions[${i}].name`, PROPOSAL_TEXT_MAX.PLAN_NAME),
      highlights: readHighlights(p.highlights, `planOptions[${i}].highlights`),
      popular: flag(p.popular, `planOptions[${i}].popular`, false),
    };
  });
  if (plans.length === 0) return plans;
  const planField = fields.find((f) => f.plan);
  if (!planField) refuse(SAY.planNeedsField({ field: 'planOptions' }), 'planOptions');
  const names = planField.options.map((option) => option.label);
  plans.forEach((plan, i) => {
    if (!names.includes(plan.name)) refuse(SAY.planNotAnOption({ field: `planOptions[${i}].name`, name: plan.name }), `planOptions[${i}].name`);
    if (plans.findIndex((p) => p.name === plan.name) !== i) refuse(SAY.planTwice({ field: `planOptions[${i}].name`, name: plan.name }), `planOptions[${i}].name`);
  });
  const popular = plans.map((p, i) => (p.popular ? i : -1)).filter((i) => i >= 0);
  if (popular.length > 1) refuse(SAY.onePopular({ field: `planOptions[${popular[1]}].popular` }), `planOptions[${popular[1]}].popular`);
  return plans;
}

/** **An FAQ** — the company's or an office's (§2, §5): a question one line, an answer with its line breaks kept. */
export function readFaq(value: unknown, path = 'faq'): FaqEntry[] {
  return list(value, path, PROPOSAL.FAQ_MAX).map((raw, i) => {
    const q = record(raw, `${path}[${i}]`, ['question', 'answer']);
    return {
      question: text(q.question, `${path}[${i}].question`, PROPOSAL_TEXT_MAX.FAQ_QUESTION),
      answer: text(q.answer, `${path}[${i}].answer`, PROPOSAL_TEXT_MAX.FAQ_ANSWER, true),
    };
  });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * **The names a `pdfDetail` formula may use** (ADR-0225 §4; P19.15-T2, ADR-0259 §8): the product's own `money` fields,
 * and `up` on an `up_premium` product — the item's sum assured, which is no field since ADR-0255 §4 and which the PDF
 * already reads as `up` (`proposal-pdf.model.ts`, `moneyValuesOf`).
 */
export function formulaNamesOf(fields: readonly Pick<ProposalField, 'key' | 'type'>[], calcType: ProposalCalcType): string[] {
  const keys = fields.filter((f) => f.type === 'money').map((f) => f.key);
  return calcType === 'up_premium' && !keys.includes('up') ? [...keys, 'up'] : keys;
}

/** Page 2's blocks: each once, its rows bounded, its formulas naming only this product's money keys (§2, §4). */
function readDetail(value: unknown, fields: readonly ProposalField[], facts: ProductFacts, calcType: ProposalCalcType): PdfDetailBlock[] {
  const moneyKeys = formulaNamesOf(fields, calcType);
  const blocks = list(value, 'pdfDetail', PDF_DETAIL_BLOCKS.length).map((raw, i) => {
    const path = `pdfDetail[${i}]`;
    const b = record(raw, path, ['block', 'rows', 'source', 'notGuaranteed']);
    const block = oneOf(b.block, `${path}.block`, PDF_DETAIL_BLOCKS);
    const max = block === 'pengecualian' ? PROPOSAL.EXCLUSIONS_MAX : PROPOSAL.PDF_DETAIL_ROWS_MAX;
    const rows = list(b.rows, `${path}.rows`, max, 1).map((rawRow, j) => {
      const at = `${path}.rows[${j}]`;
      const r = record(rawRow, at, ['label', 'note', 'formula', 'text']);
      const formula = optionalText(r.formula, `${at}.formula`, PROPOSAL.FORMULA_MAX_LENGTH);
      const shown = optionalText(r.text, `${at}.text`, PROPOSAL_TEXT_MAX.DETAIL_LABEL);
      if ((formula === null) === (shown === null)) refuse(SAY.formulaOrText({ field: at }), at);
      if (formula !== null) {
        const problem = checkFormula(formula, moneyKeys);
        if (problem?.kind === 'grammar') refuse(SAY.formulaGrammar({ field: `${at}.formula`, at: problem.at }), `${at}.formula`);
        if (problem?.kind === 'name') refuse(SAY.formulaName({ name: problem.name }), `${at}.formula`);
      }
      return {
        label: text(r.label, `${at}.label`, PROPOSAL_TEXT_MAX.DETAIL_LABEL),
        note: optionalText(r.note, `${at}.note`, PROPOSAL_TEXT_MAX.DETAIL_NOTE),
        formula,
        text: shown,
      };
    });
    const s = record(b.source, `${path}.source`, ['file', 'page', 'date']);
    if (typeof s.page !== 'number' || !Number.isInteger(s.page) || s.page < 1) refuse(SAY.pageShape({ field: `${path}.source.page` }), `${path}.source.page`);
    if (typeof s.date !== 'string' || !ISO_DAY.test(s.date) || s.date > facts.today) {
      refuse(SAY.pastDay({ field: `${path}.source.date` }), `${path}.source.date`);
    }
    const notGuaranteed = flag(b.notGuaranteed, `${path}.notGuaranteed`, false);
    if (notGuaranteed && block !== 'nilai_tunai') refuse(SAY.notGuaranteedOnCashValue({ field: `${path}.notGuaranteed` }), `${path}.notGuaranteed`);
    return {
      block,
      rows,
      source: { file: text(s.file, `${path}.source.file`, PROPOSAL_TEXT_MAX.SOURCE_FILE), page: s.page, date: s.date },
      notGuaranteed,
    };
  });
  const kinds = blocks.map((b) => b.block);
  const twice = kinds.findIndex((kind, i) => kinds.indexOf(kind) !== i);
  if (twice >= 0) refuse(SAY.blockTwice({ field: `pdfDetail[${twice}].block`, block: kinds[twice] }), `pdfDetail[${twice}].block`);
  return blocks;
}

// ------------------------------------------------------------------------- the calculation fields (ADR-0255)

/** An age at the next birthday, 1 to `PROPOSAL_CATALOGUE.AGE_MAX`, or `null`. */
function age(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > PROPOSAL_CATALOGUE.AGE_MAX) {
    refuse(SAY.ageShape({ field: path, max: PROPOSAL_CATALOGUE.AGE_MAX }), path);
  }
  return value;
}

/** A whole sum in minor units, zero or more (or above zero), or `null`. */
function amount(value: unknown, path: string, positive = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (positive ? 1 : 0) || value > PROPOSAL.MONEY_MAX_MINOR) {
    refuse(positive ? SAY.positiveAmount({ field: path }) : SAY.wholeAmount({ field: path }), path);
  }
  return value;
}

function readEntryAge(value: unknown): { min: number; max: number } | null {
  if (value === undefined || value === null) return null;
  const o = record(value, 'entryAge', ['min', 'max']);
  const min = age(o.min, 'entryAge.min');
  const max = age(o.max, 'entryAge.max');
  if (min === null) refuse(COMMON.required({ field: 'entryAge.min' }), 'entryAge.min');
  if (max === null) refuse(COMMON.required({ field: 'entryAge.max' }), 'entryAge.max');
  if (min > max) refuse(SAY.entryAgeOrder({ field: 'entryAge' }), 'entryAge');
  return { min, max };
}

function readPayTerms(value: unknown): PayTerm[] {
  const terms = list(value, 'payTerms', PROPOSAL_CATALOGUE.PAY_TERMS_MAX).map((raw, i) => {
    const path = `payTerms[${i}]`;
    const o = record(raw, path, ['key', 'label', 'years', 'toAge', 'single', 'maxEntryAge', 'default']);
    if (typeof o.key !== 'string' || !PROPOSAL_PAY_TERM_KEY_PATTERN.test(o.key)) refuse(SAY.keyShape({ field: `${path}.key` }), `${path}.key`);
    const years = o.years === undefined || o.years === null ? null : o.years;
    if (years !== null && (typeof years !== 'number' || !Number.isInteger(years) || years < 1 || years > PROPOSAL.PAYMENT_YEARS_MAX)) {
      refuse(SAY.yearsShape({ field: `${path}.years`, max: PROPOSAL.PAYMENT_YEARS_MAX }), `${path}.years`);
    }
    const toAge = age(o.toAge, `${path}.toAge`);
    const single = flag(o.single, `${path}.single`, false);
    if ([years !== null, toAge !== null, single].filter(Boolean).length > 1) refuse(SAY.payTermShape({ field: path }), path);
    return {
      key: o.key,
      label: text(o.label, `${path}.label`, PROPOSAL_CATALOGUE.PAY_TERM_LABEL_MAX),
      years: years as number | null,
      toAge,
      single,
      maxEntryAge: age(o.maxEntryAge, `${path}.maxEntryAge`),
      default: flag(o.default, `${path}.default`, false),
    };
  });
  const keys = terms.map((t) => t.key);
  const twice = keys.findIndex((key, i) => keys.indexOf(key) !== i);
  if (twice >= 0) refuse(SAY.payTermKeyTwice({ field: `payTerms[${twice}].key`, key: keys[twice] }), `payTerms[${twice}].key`);
  const defaults = terms.map((t, i) => (t.default ? i : -1)).filter((i) => i >= 0);
  if (defaults.length > 1) refuse(SAY.onlyOneFlag({ field: `payTerms[${defaults[1]}].default`, flag: 'default' }), `payTerms[${defaults[1]}].default`);
  return terms;
}

/** The *Cara bayar* offered, each once, stored in `PROPOSAL_PAY_FREQUENCIES`' order. */
function readFrequencies(value: unknown): ProposalPayFrequency[] {
  const given = list(value, 'frequencies', PROPOSAL_PAY_FREQUENCIES.length)
    .map((f, i) => oneOf(f, `frequencies[${i}]`, PROPOSAL_PAY_FREQUENCIES));
  const twice = given.findIndex((f, i) => given.indexOf(f) !== i);
  if (twice >= 0) refuse(SAY.frequencyTwice({ field: `frequencies[${twice}]`, frequency: given[twice] }), `frequencies[${twice}]`);
  return PROPOSAL_PAY_FREQUENCIES.filter((f) => given.includes(f));
}

/**
 * **The plan rule** (ADR-0255 §3): it names the product's one `derived` field, and each rule's conditions name its
 * `chips` fields and their options, its value an option of the derived field. A derived field without a rule, or a
 * rule without a derived field, is refused: the plan would read nothing.
 */
function readPlanRule(value: unknown, fields: readonly ProposalField[]): PlanRule | null {
  const derived = fields.findIndex((f) => f.type === 'derived');
  if (value === undefined || value === null) {
    if (derived >= 0) refuse(SAY.derivedNeedsRule({ field: `proposalFields[${derived}].type` }), `proposalFields[${derived}].type`);
    return null;
  }
  const o = record(value, 'planRule', ['field', 'rules']);
  const target = fields[derived];
  if (!target || o.field !== target.key) refuse(SAY.ruleField({ field: 'planRule.field' }), 'planRule.field');
  const chips = new Map(fields.filter((f) => f.type === 'chips').map((f) => [f.key, f.options.map((option) => option.label)]));
  const rules = list(o.rules, 'planRule.rules', PROPOSAL_CATALOGUE.PLAN_RULES_MAX, 1).map((raw, i) => {
    const path = `planRule.rules[${i}]`;
    const r = record(raw, path, ['when', 'value']);
    if (r.when === null || typeof r.when !== 'object' || Array.isArray(r.when)) refuse(SAY.notAnObject({ field: `${path}.when` }), `${path}.when`);
    const entries = Object.entries(r.when as Record<string, unknown>);
    if (entries.length < 1 || entries.length > PROPOSAL_CATALOGUE.PLAN_RULE_WHEN_MAX) {
      refuse(SAY.listBetween({ field: `${path}.when`, min: 1, max: PROPOSAL_CATALOGUE.PLAN_RULE_WHEN_MAX }), `${path}.when`);
    }
    const when: Record<string, string> = {};
    for (const [key, option] of entries) {
      if (typeof option !== 'string' || !chips.get(key)?.includes(option)) refuse(SAY.ruleWhen({ field: `${path}.when.${key}` }), `${path}.when.${key}`);
      when[key] = option;
    }
    if (typeof r.value !== 'string' || !target.options.some((option) => option.label === r.value)) {
      refuse(SAY.ruleValue({ field: `${path}.value` }), `${path}.value`);
    }
    return { when, value: r.value };
  });
  return { field: target.key, rules };
}

/** The limits, each a whole sum or `null`, and each minimum no larger than its maximum. */
function readLimits(pick: (key: keyof ProposalCalcSettings) => unknown) {
  const upStep = amount(pick('upStep'), 'upStep', true);
  const upMin = amount(pick('upMin'), 'upMin');
  const upMax = amount(pick('upMax'), 'upMax');
  const premiumMin = amount(pick('premiumMin'), 'premiumMin');
  const premiumMax = amount(pick('premiumMax'), 'premiumMax');
  if (upMin !== null && upMax !== null && upMin > upMax) refuse(SAY.limitOrder({ field: 'upMin' }), 'upMin');
  if (premiumMin !== null && premiumMax !== null && premiumMin > premiumMax) refuse(SAY.limitOrder({ field: 'premiumMin' }), 'premiumMin');
  return { upStep, upMin, upMax, premiumMin, premiumMax };
}

/**
 * **A product's proposal settings as a save checks them** (ADR-0225 §2): the stored settings with the write's laid over
 * them, every rule held across the whole — a plan card names an option of the plan field the same write may have
 * changed, a formula a money key it may have removed, a currency option a currency the product still sells — and
 * the first broken one refused, `400 VALIDATION_FAILED`, `details.field` its path. Answers the normalised settings
 * of the whole, from which a write takes the keys it sent.
 */
export function checkProposalSettings(
  input: Partial<Record<keyof ProposalSettings, unknown>>,
  stored: Partial<ProposalSettings>,
  facts: ProductFacts,
): ProposalSettings {
  const pick = <K extends keyof ProposalSettings>(key: K): unknown =>
    (input[key] !== undefined ? input[key] : stored[key] ?? EMPTY_PROPOSAL_SETTINGS[key]);

  const proposalFields = readFields(pick('proposalFields'), facts);
  const planOptions = readPlans(pick('planOptions'), proposalFields);
  const faq = readFaq(pick('faq'));
  // P19.15-T2 (ADR-0259 §8): the calculation type first, so an `up_premium` product's formulas may name its `up`.
  const calcType = oneOf(pick('calcType') ?? 'manual', 'calcType', PROPOSAL_CALC_TYPES);
  const pdfDetail = readDetail(pick('pdfDetail'), proposalFields, facts, calcType);
  const syariahName = optionalText(pick('syariahName'), 'syariahName', PROPOSAL_TEXT_MAX.SYARIAH_NAME);
  // One product for both versions only (§3): a syariah product is offered under Syariah by its own name.
  if (syariahName !== null && facts.channel !== 'conventional') refuse(SAY.syariahNameOnSyariah, 'syariahName');
  const insured = pick('defaultInsured');
  const defaultInsured = insured === null || insured === undefined
    ? null : oneOf(insured, 'defaultInsured', PROPOSAL_DEFAULT_INSURED);
  const proposalTypeLabel = optionalText(pick('proposalTypeLabel'), 'proposalTypeLabel', PROPOSAL_TEXT_MAX.TYPE_LABEL);

  // P19.14-T2 (ADR-0255 §5): the calculation fields, each its default where nothing was stored.
  const tag = pick('needTag');
  return {
    proposalFields, planOptions, faq, pdfDetail, syariahName, defaultInsured, proposalTypeLabel,
    calcType,
    entryAge: readEntryAge(pick('entryAge')),
    payTerms: readPayTerms(pick('payTerms')),
    frequencies: readFrequencies(pick('frequencies')),
    smokerRated: flag(pick('smokerRated'), 'smokerRated', false),
    planRule: readPlanRule(pick('planRule'), proposalFields),
    ...readLimits(pick),
    rateTableId: optionalText(pick('rateTableId'), 'rateTableId', 64),
    needTag: tag === null || tag === undefined ? null : oneOf(tag, 'needTag', PROPOSAL_NEED_TAGS),
  };
}

// --------------------------------------------------------------------------- an office's FAQ and highlights

/**
 * **An office's plan highlights** (ADR-0225 §5): `{ [planName]: highlights[] }`, each name one of the company's plans,
 * each list one to four highlights. A name the company does not have is refused on write (and ignored on read, below).
 */
export function readOfficePlanHighlights(value: unknown, planNames: readonly string[]): Record<string, PlanHighlight[]> {
  const path = 'planHighlights';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(SAY.notAnObject({ field: path }), path);
  const out: Record<string, PlanHighlight[]> = {};
  for (const [name, highlights] of Object.entries(value as Record<string, unknown>)) {
    if (highlights === undefined) continue;
    if (!planNames.includes(name)) refuse(SAY.planNotOnProduct({ field: path, name }), `${path}.${name}`);
    out[name] = readHighlights(highlights, `${path}.${name}`);
  }
  return out;
}

/** What an agent reads of a product's FAQ and plans for one office (ADR-0225 §5). */
export interface EffectiveProposalWords {
  faq: FaqEntry[];
  plans: PlanOption[];
  /** `kpm` once the office has an approved FAQ or highlights of its own. */
  source: 'kpm' | 'company';
}

/**
 * **The rule every agent read of the FAQ and the plans applies** (ADR-0225 §5; ADR-0037): the office's **approved**
 * FAQ, else the company's; each plan's approved highlights, else the company's. A plan name the company no longer has
 * is ignored. It takes `approvedOverrides` and nothing else, so no draft reaches an agent.
 */
export function effectiveProposalWordsOf(
  product: { planOptions?: readonly PlanOption[] | null; faq?: readonly FaqEntry[] | null },
  approvedOverrides: Record<string, unknown> | null | undefined,
): EffectiveProposalWords {
  const approved = approvedOverrides ?? {};
  const has = (field: string) => Object.prototype.hasOwnProperty.call(approved, field);
  const own = (has('planHighlights') ? approved.planHighlights : {}) as Record<string, PlanHighlight[]>;
  return {
    faq: (has('faq') ? approved.faq as FaqEntry[] : product.faq ?? []).map(({ question, answer }) => ({ question, answer })),
    plans: (product.planOptions ?? []).map((plan) => ({
      name: plan.name,
      popular: plan.popular,
      highlights: (Object.prototype.hasOwnProperty.call(own, plan.name) ? own[plan.name] : plan.highlights)
        .map(({ label, value }) => ({ label, value })),
    })),
    source: has('faq') || has('planHighlights') ? 'kpm' : 'company',
  };
}
