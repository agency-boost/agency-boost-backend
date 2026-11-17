import type { ProductCurrency, RateBasis } from '@/domain/constants';
import {
  exactAsWritten, minorUnitsOf, rateOf, readingsOf, scaledRate, scaledToRupiah, wholeOf, type Exact,
} from './intake-numbers';
import { columnFromChoice, isRealDay, openQuestions } from './intake-understanding';
import type { IntakeItem, IntakeQuestion, IntakeTableColumn } from './upload-intake.schema';

/**
 * **What a confirmed card applies, worked out by our code** (P19.15-T3 AC-3, AC-4; ADR-0259 §3, §4). Pure: the card,
 * its answers, the product's pay terms come in; the rows and the rules a flow of T1's is handed go out, with what was
 * left out and why. **Nothing is filled in**: a row whose age, gender or rate cannot be read exactly is skipped and said
 * so, and its combination stays missing — the agent's card then says *"Kombinasi ini tidak ada di tabel tarif"*.
 */

/** A premium row, in the shape D1's `RateTableService.createDraft` takes (ADR-0258's `rateRows`). */
export interface RateRowInput {
  age: number | null;
  gender: 'male' | 'female' | null;
  smoker: boolean | null;
  plan: string | null;
  payTerm: string | null;
  currency: ProductCurrency;
  frequency: null;
  basis: RateBasis;
  rate: number;
  bandMin: number | null;
  bandMax: number | null;
}

/** The answer to the first question about `about`, or `null`. */
export function answerTo(questions: readonly IntakeQuestion[], about: string): string | null {
  return questions.find((q) => q.about === about)?.answer ?? null;
}

/** **An answer typed into a *ketik angkanya* card**, read as a person writes it in Indonesia: `0,123`, `1.250.000`. */
export function typedNumber(text: string): Exact | null {
  const readings = readingsOf(text);
  return readings[0] ?? null;
}

const GENDER = (text: string): 'male' | 'female' | null => {
  const t = text.trim().toLowerCase();
  if (/^(l|lk|laki|laki-laki|pria|m|male|man)$/.test(t)) return 'male';
  if (/^(p|pr|perempuan|wanita|f|female|woman)$/.test(t)) return 'female';
  return null;
};
const SMOKER = (text: string): boolean | null => {
  const t = text.trim().toLowerCase();
  if (/^(y|ya|yes|perokok|smoker|merokok|s)$/.test(t)) return true;
  if (/^(t|tidak|no|n|bukan perokok|non smoker|non-smoker|ns)$/.test(t)) return false;
  return null;
};

/** A pay term as the table writes it (*10*, *10 tahun*, *s/d 60*) → the product's key, or `null`. */
function payTermOf(text: string, terms: readonly { key: string; label: string; years: number | null }[]): string | null {
  const t = text.trim().toLowerCase();
  const byLabel = terms.find((x) => x.label.toLowerCase() === t || x.key.toLowerCase() === t);
  if (byLabel) return byLabel.key;
  const n = /^(\d{1,2})(\s*(th|thn|tahun))?$/.exec(t);
  if (n) return terms.find((x) => x.years === Number(n[1]))?.key ?? null;
  return null;
}

/** The columns as a person settled them: the reading's, with each *column* answer laid over. */
export function settledColumns(item: Pick<IntakeItem, 'table' | 'questions'>): IntakeTableColumn[] {
  return (item.table?.columns ?? []).map((c) => {
    const answer = answerTo(item.questions, `column:${c.column}`);
    return answer ? columnFromChoice(c, answer) : c;
  });
}

/**
 * **A premium table's rows, read exactly from the cells as written** — a typed answer where a cell was not certain —
 * and the rows skipped with the reason. One row per rate column per table row: a table with *Rate L* and *Rate P* gives
 * two rows per age.
 */
export function rateRowsOf(
  item: Pick<IntakeItem, 'table' | 'questions'>,
  payTerms: readonly { key: string; label: string; years: number | null }[],
): { rows: RateRowInput[]; skipped: number; basis: RateBasis | null; currency: ProductCurrency | null } {
  const table = item.table;
  if (!table) return { rows: [], skipped: 0, basis: null, currency: null };
  const basis = (table.basis ?? answerTo(item.questions, 'basis')) as RateBasis | null;
  const currency = (table.currency ?? answerTo(item.questions, 'currency')) as ProductCurrency | null;
  if (!basis || !currency) return { rows: [], skipped: table.rows.length, basis, currency };
  const columns = settledColumns(item);
  const of = (meaning: IntakeTableColumn['meaning']) => columns.find((c) => c.meaning === meaning)?.column ?? null;
  const ageCol = of('age');
  const genderCol = of('gender');
  const smokerCol = of('smoker');
  const planCol = of('plan');
  const termCol = of('pay_term');
  const bandMinCol = of('band_min');
  const bandMaxCol = of('band_max');
  const rateCols = columns.filter((c) => c.meaning === 'rate');

  const rows: RateRowInput[] = [];
  let skipped = 0;
  table.rows.forEach((r, i) => {
    const cell = (col: string | null): { exact: Exact | null; text: string } | null => {
      if (!col) return null;
      const c = r.cells[col];
      if (!c) return null;
      const typed = answerTo(item.questions, `cell:${i}:${col}`);
      if (typed !== null) return { exact: typedNumber(typed), text: typed };
      if (!c.certain) return { exact: null, text: c.text };
      return { exact: exactAsWritten(c.text, c.value), text: c.text };
    };
    const ageCell = cell(ageCol);
    const age = ageCell ? (ageCell.exact ? wholeOf(ageCell.exact) : null) : null;
    if (ageCol && age === null) {
      skipped += rateCols.length || 1;
      return;
    }
    const gender = genderCol ? GENDER(r.cells[genderCol]?.text ?? '') : null;
    const smoker = smokerCol ? SMOKER(r.cells[smokerCol]?.text ?? '') : null;
    const plan = planCol ? r.cells[planCol]?.text.trim().slice(0, 60) || null : null;
    const payTerm = termCol ? payTermOf(r.cells[termCol]?.text ?? '', payTerms) : null;
    if ((genderCol && gender === null) || (smokerCol && smoker === null) || (termCol && payTerm === null)) {
      skipped += rateCols.length || 1;
      return;
    }
    const bandMinCell = cell(bandMinCol);
    const bandMaxCell = cell(bandMaxCol);
    const bandMin = bandMinCell?.exact ? minorUnitsOf(bandMinCell.exact) : null;
    const bandMax = bandMaxCell?.exact ? minorUnitsOf(bandMaxCell.exact) : null;
    for (const rc of rateCols) {
      const value = cell(rc.column);
      if (!value?.exact) {
        if (r.cells[rc.column]) skipped += 1;
        continue;
      }
      const rate = basis === 'per_plan' ? minorUnitsOf(value.exact) : rateOf(value.exact);
      if (rate === null || rate < 0) {
        skipped += 1;
        continue;
      }
      if (basis === 'per_band' && (bandMin === null || bandMax === null)) {
        skipped += 1;
        continue;
      }
      rows.push({
        age,
        gender: rc.gender ?? gender,
        smoker: rc.smoker ?? smoker,
        plan: rc.plan ?? plan,
        payTerm: rc.payTermKey ?? payTerm,
        currency,
        frequency: null,
        basis,
        rate,
        bandMin: basis === 'per_band' ? bandMin : null,
        bandMax: basis === 'per_band' ? bandMax : null,
      });
    }
  });
  return { rows, skipped, basis, currency };
}

/** The rule changes a card carries, settled: each value as read or typed, keyed as ADR-0258's rules name them. */
export interface SettledRules {
  upStep?: number; upMin?: number; upMax?: number; premiumMin?: number; premiumMax?: number;
  entryAgeMin?: number; entryAgeMax?: number;
  payTermMaxAge?: Record<string, number>;
  frequencies?: Partial<Record<'monthly' | 'quarterly' | 'semiannual', number>>;
}

/** The catalogue changes a card carries: a new name, smoker rating, payment frequencies, an option added or removed. */
export interface SettledFields {
  name?: string;
  smokerRated?: boolean;
  frequencies?: string[];
  optionsAdded?: { fieldKey: string; label: string }[];
  optionsRemoved?: { fieldKey: string; label: string }[];
}

/**
 * **A card's rules and catalogue changes, settled**: each diff row's value, a typed answer where it was not certain, a
 * chosen pay term, frequency or field where the reading could not name one. A row still unsettled is left out.
 */
export function settledChanges(item: Pick<IntakeItem, 'diff' | 'questions'>): { rules: SettledRules; fields: SettledFields } {
  const rules: SettledRules = {};
  const fields: SettledFields = {};
  item.diff.forEach((row, i) => {
    const typed = answerTo(item.questions, `diff:${row.key}`);
    let [key, sub] = row.key.split(':');
    if (sub === '?') {
      sub = answerTo(item.questions, `payterm:${i}`) ?? answerTo(item.questions, `frequency:${i}`) ?? answerTo(item.questions, `field:${i}`) ?? '?';
    }
    const number = (): number | null => {
      if (typed !== null) {
        const e = typedNumber(typed);
        if (!e) return null;
        if (['upStep', 'upMin', 'upMax', 'premiumMin', 'premiumMax'].includes(key)) return minorUnitsOf(e);
        if (key === 'frequencyFactor') return rateOf(e);
        return wholeOf(e);
      }
      return typeof row.value === 'number' ? row.value : null;
    };
    switch (key) {
      case 'upStep': case 'upMin': case 'upMax': case 'premiumMin': case 'premiumMax':
      case 'entryAgeMin': case 'entryAgeMax': {
        const n = number();
        if (n !== null) rules[key] = n;
        break;
      }
      case 'payTermMaxAge': {
        const n = number();
        if (n !== null && sub && sub !== '?') rules.payTermMaxAge = { ...rules.payTermMaxAge, [sub]: n };
        break;
      }
      case 'frequencyFactor': {
        const n = number();
        if (n !== null && (sub === 'monthly' || sub === 'quarterly' || sub === 'semiannual')) rules.frequencies = { ...rules.frequencies, [sub]: n };
        break;
      }
      case 'name': {
        const v = typed ?? (typeof row.value === 'string' ? row.value : null);
        if (v?.trim()) fields.name = v.trim().slice(0, 120);
        break;
      }
      case 'smokerRated': {
        const v = typed !== null ? SMOKER(typed) : typeof row.value === 'boolean' ? row.value : null;
        if (v !== null) fields.smokerRated = v;
        break;
      }
      case 'frequencies': {
        const v = typeof row.value === 'string' ? row.value : null;
        if (v) fields.frequencies = v.split(',');
        break;
      }
      case 'optionAdded': case 'optionRemoved': {
        const label = typed ?? (typeof row.value === 'string' ? row.value : null);
        if (label && sub && sub !== '?') {
          const list = key === 'optionAdded' ? (fields.optionsAdded ??= []) : (fields.optionsRemoved ??= []);
          list.push({ fieldKey: sub, label });
        }
        break;
      }
    }
  });
  return { rules, fields };
}

/** The day a card applies from: the file's, or the answer to *Mulai kapan?*. */
export function effectiveFromOf(item: Pick<IntakeItem, 'effectiveFrom' | 'questions'>): string | null {
  if (item.effectiveFrom) return item.effectiveFrom;
  const answer = answerTo(item.questions, 'effectiveFrom');
  return isRealDay(answer) ? answer : null;
}

/** **A percentage applied to the table in force**, by the stated rule, after it was approved — and only then. */
export function scaledRows(
  rows: readonly RateRowInput[], factor: { numerator: bigint; denominator: bigint },
): RateRowInput[] {
  const decimals = Math.max(0, ...rows.filter((r) => r.basis !== 'per_plan').map((r) => (String(r.rate).split('.')[1] ?? '').length));
  return rows.map((r) => {
    if (r.basis === 'per_plan') return { ...r, rate: scaledToRupiah(r.rate, factor) };
    const exact = readingsOf(String(r.rate).replace('.', ','))[0] ?? { units: BigInt(Math.round(r.rate)), scale: 0 };
    const scaled = scaledRate(exact, factor, decimals);
    return { ...r, rate: Number(scaled.units) / 10 ** scaled.scale };
  });
}

/** The factor stored on a card (`105/100`), back as big integers. */
export function storedFactor(text: string): { numerator: bigint; denominator: bigint } | null {
  const m = /^(\d+)\/(\d+)$/.exec(text);
  return m ? { numerator: BigInt(m[1]), denominator: BigInt(m[2]) } : null;
}

export { openQuestions };
