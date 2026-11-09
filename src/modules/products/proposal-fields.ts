import { InvalidRequestException } from '@/common/errors/domain.exception';
import type { Sentence } from '@/common/i18n/sentence';
import { plainText, plainTextLines } from '@/common/validation/plain-text';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import {
  PDF_DETAIL_BLOCKS, PROPOSAL, PROPOSAL_DEFAULT_INSURED, PROPOSAL_FIELD_KEY_PATTERN, PROPOSAL_FIELD_TYPES,
  PROPOSAL_RESERVED_KEYS, PROPOSAL_TEXT_MAX, PRODUCT_CURRENCIES, PROPOSAL_TYPE_LABEL_BY_CATEGORY, defaultInsuredFor,
  type PdfDetailBlockKind, type ProductCurrency, type ProposalDefaultInsured, type ProposalFieldType,
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
  /** A `chips` field's preselected option, by label; a `fixed` field's one; `null` on a `money` field. */
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

/** Everything the proposal reads from a product, as stored. */
export interface ProposalSettings {
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

/** The keys a product's write may carry for the proposal (ADR-0225 §1). */
export const PROPOSAL_SETTING_KEYS = [
  'proposalFields', 'planOptions', 'faq', 'pdfDetail', 'syariahName', 'defaultInsured', 'proposalTypeLabel',
] as const satisfies readonly (keyof ProposalSettings)[];

/** What a save checks the proposal fields against: the product as it will be once written. */
export interface ProductFacts {
  channel: string;
  category: string;
  currencies: readonly string[];
  /** The office calendar's today, `YYYY-MM-DD`: a block's source is dated no later. */
  today: string;
}

/** Nothing set: a product with no proposal fields is still offered, with *Tertanggung* and the premium (§1). */
export const EMPTY_PROPOSAL_SETTINGS: ProposalSettings = {
  proposalFields: [], planOptions: [], faq: [], pdfDetail: [], syariahName: null, defaultInsured: null,
  proposalTypeLabel: null,
};

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
  onType('plan', ['chips']);
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
    if (type === 'fixed') {
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

/** Page 2's blocks: each once, its rows bounded, its formulas naming only this product's money keys (§2, §4). */
function readDetail(value: unknown, fields: readonly ProposalField[], facts: ProductFacts): PdfDetailBlock[] {
  const moneyKeys = fields.filter((f) => f.type === 'money').map((f) => f.key);
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
  const pdfDetail = readDetail(pick('pdfDetail'), proposalFields, facts);
  const syariahName = optionalText(pick('syariahName'), 'syariahName', PROPOSAL_TEXT_MAX.SYARIAH_NAME);
  // One product for both versions only (§3): a syariah product is offered under Syariah by its own name.
  if (syariahName !== null && facts.channel !== 'conventional') refuse(SAY.syariahNameOnSyariah, 'syariahName');
  const insured = pick('defaultInsured');
  const defaultInsured = insured === null || insured === undefined
    ? null : oneOf(insured, 'defaultInsured', PROPOSAL_DEFAULT_INSURED);
  const proposalTypeLabel = optionalText(pick('proposalTypeLabel'), 'proposalTypeLabel', PROPOSAL_TEXT_MAX.TYPE_LABEL);
  return { proposalFields, planOptions, faq, pdfDetail, syariahName, defaultInsured, proposalTypeLabel };
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
