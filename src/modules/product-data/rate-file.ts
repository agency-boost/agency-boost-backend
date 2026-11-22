import {
  PRODUCT_DATA, RATE_COLUMN_ROLES, SPREADSHEET,
  type ProductCurrency, type ProposalCalcType, type ProposalPayFrequency, type RateBasis, type RateColumnRole,
} from '@/domain/constants';
import type { EngineRow } from './premium-engine';
import type { FrequencyFactors, RateGap, RateRules } from './rate-table.schema';

/**
 * **A premium table's file, read** (P19.15-T1 AC-1, AC-4; ADR-0258 §3; the P1b spec's *Tabel premi*): the columns
 * suggested, the cells read under the columns a person confirmed, the *Ketentuan* sheet's rules, the gaps, and the
 * product's own template. Pure — the service hands it the file's text cells and the product's facts — so each rule is a
 * unit test (`rate-file.spec.ts`).
 *
 * **Exactly as written.** A cell is read or refused, never guessed: a rate is the number in the cell, a plan one of the
 * product's plans, a pay term one of its pay terms. Nothing is filled in for a combination the file lacks — that is a
 * gap, listed in plain words, and agents see *"Kombinasi ini tidak ada di tabel tarif"* for it.
 */

/** The product, as its table is read against it. */
export interface TableFacts {
  calcType: ProposalCalcType;
  currencies: ProductCurrency[];
  smokerRated: boolean;
  /** The plan field's options (chosen or derived), where the product has one. */
  plans: string[];
  payTerms: { key: string; label: string; years: number | null; toAge: number | null; single: boolean; maxEntryAge: number | null }[];
  entryAge: { min: number; max: number } | null;
}

/** The file's cells as a draft keeps them. `firstRow` is the sheet's number of the first data row. */
export interface RawTable {
  header: string[];
  rows: string[][];
  firstRow: number;
  ketentuan: string[][] | null;
}

/** A cell that cannot be read under the columns chosen, by the row the sheet shows and the column's name. */
export interface RowProblem {
  row: number;
  column: string;
  value: string;
  reason: 'number' | 'age' | 'gender' | 'smoker' | 'plan' | 'payTerm' | 'currency' | 'frequency' | 'duplicate' | 'band' | 'range';
}

// ------------------------------------------------------------------------------------------------ the template's words

/** **The template's column names** (Indonesian, the screen's): each reads back as its own role. */
export const TEMPLATE_COLUMNS: Record<Exclude<RateColumnRole, 'ignore'>, string> = {
  age: 'Usia', gender: 'Jenis kelamin', smoker: 'Merokok', plan: 'Plan', payTerm: 'Masa bayar', currency: 'Mata uang',
  frequency: 'Cara bayar', rate: 'Tarif per 1.000 UP', premium: 'Premi tahunan', bandMin: 'UP dari', bandMax: 'UP sampai',
};

/** Every name a column is recognised by, normalised (`norm`), the template's first. */
const SYNONYMS: Record<Exclude<RateColumnRole, 'ignore'>, string[]> = {
  age: ['usia', 'umur', 'age', 'usia masuk', 'anb'],
  gender: ['jenis kelamin', 'kelamin', 'gender', 'jk', 'sex'],
  smoker: ['merokok', 'perokok', 'smoker', 'rokok'],
  plan: ['plan', 'paket', 'kelas'],
  payTerm: ['masa bayar', 'masa pembayaran', 'masa pembayaran premi', 'pay term', 'term', 'mpp'],
  currency: ['mata uang', 'currency', 'valuta'],
  frequency: ['cara bayar', 'frekuensi', 'frequency', 'cara pembayaran'],
  rate: ['tarif per 1000 up', 'tarif', 'rate', 'tarif per mil', 'per mille', 'rate per mille', 'tarif premi'],
  premium: ['premi tahunan', 'premi', 'premium', 'annual premium', 'kontribusi tahunan', 'kontribusi'],
  bandMin: ['up dari', 'up min', 'up minimum', 'band min'],
  bandMax: ['up sampai', 'up maks', 'up maksimum', 'band max'],
};

/** A name as compared: lower case, `.` and `_` dropped, anything else not a letter or digit a space. */
export function norm(text: string): string {
  return text.toLowerCase().replace(/[._]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * **The columns suggested** (*Cocokkan kolom*): each header named as one of `SYNONYMS` exactly, else containing one, each
 * role given once — the first column that claims it — and the rest `ignore`. A person confirms or changes each.
 */
export function suggestMapping(header: readonly string[]): Record<string, RateColumnRole> {
  const out: Record<string, RateColumnRole> = {};
  const taken = new Set<RateColumnRole>();
  const roles = Object.keys(SYNONYMS) as (keyof typeof SYNONYMS)[];
  const claim = (name: string, exact: boolean): RateColumnRole | null => {
    const n = norm(name);
    for (const role of roles) {
      if (taken.has(role)) continue;
      if (SYNONYMS[role].some((s) => (exact ? n === s : n.includes(s)))) return role;
    }
    return null;
  };
  for (const name of header) out[name] = 'ignore';
  for (const exact of [true, false]) {
    for (const name of header) {
      if (out[name] !== 'ignore' || name.trim() === '') continue;
      const role = claim(name, exact);
      if (role) { out[name] = role; taken.add(role); }
    }
  }
  return out;
}

/** **How the rows state their price**, from the columns: a premium column is `per_plan`; a band, `per_band`. */
export function basisOf(map: Record<string, RateColumnRole>): RateBasis | null {
  const roles = new Set(Object.values(map));
  if (roles.has('premium')) return 'per_plan';
  if (!roles.has('rate')) return null;
  return roles.has('bandMin') || roles.has('bandMax') ? 'per_band' : 'per_mille';
}

/** What is wrong with a mapping as a whole, or `null`: a column the file lacks, a role twice, no price, half a band. */
export function mappingFault(
  header: readonly string[], map: Record<string, string>,
): { kind: 'columnUnknown'; column: string } | { kind: 'roleTwice'; role: string } | { kind: 'rateColumn' } | { kind: 'bandColumns' } | { kind: 'role'; column: string } | null {
  const seen = new Set<string>();
  for (const [column, role] of Object.entries(map)) {
    if (!header.includes(column)) return { kind: 'columnUnknown', column };
    if (!(RATE_COLUMN_ROLES as readonly string[]).includes(role)) return { kind: 'role', column };
    if (role === 'ignore') continue;
    if (seen.has(role)) return { kind: 'roleTwice', role };
    seen.add(role);
  }
  if (seen.has('rate') === seen.has('premium')) return { kind: 'rateColumn' };
  if (seen.has('bandMin') !== seen.has('bandMax') || ((seen.has('bandMin') || seen.has('bandMax')) && seen.has('premium'))) {
    return { kind: 'bandColumns' };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ reading the file

/** **The data sheet and *Ketentuan* of a workbook**: the sheet called `Data`, else the first that is not *Ketentuan*. */
export function rawFromSheets(sheets: readonly { sheet: string; rows: string[][] }[]): RawTable | null {
  const isKetentuan = (name: string) => norm(name) === norm(PRODUCT_DATA.KETENTUAN_SHEET);
  const data = sheets.find((s) => norm(s.sheet) === norm(SPREADSHEET.DATA_SHEET))
    ?? sheets.find((s) => !isKetentuan(s.sheet) && s.rows.some((r) => r.some((c) => c.trim() !== '')));
  if (!data) return null;
  const raw = rawFromRows(data.rows);
  if (!raw) return null;
  const ketentuan = sheets.find((s) => isKetentuan(s.sheet));
  return { ...raw, ketentuan: ketentuan ? ketentuan.rows.filter((r) => r.some((c) => c.trim() !== '')) : null };
}

/** **A sheet's rows, or a CSV's records**: the first non-empty row is the header, every later non-empty row data. */
export function rawFromRows(rows: readonly (readonly string[])[], numbers?: readonly number[]): RawTable | null {
  const at = rows.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (at < 0) return null;
  const header = rows[at].map((c) => c.trim());
  const firstRow = numbers?.[at + 1] ?? at + 2;
  const body: string[][] = [];
  for (let i = at + 1; i < rows.length; i += 1) body.push([...rows[i]]);
  // Trailing empty rows are not data.
  while (body.length > 0 && !body[body.length - 1].some((c) => c.trim() !== '')) body.pop();
  return { header, rows: body, firstRow, ketentuan: null };
}

/**
 * **A number as typed in Indonesia or elsewhere**: `12,35` and `12.35` are both twelve and a bit; `4.500.000` and
 * `4,500,000` four and a half million. With both marks, the last is the decimal one; with one mark, written once and
 * followed by exactly three digits, an amount reads it as thousands and a rate as decimals. `Rp`, spaces and the
 * suffixes *rb*, *jt* and *M* (*miliar*) are read. `null` for an empty cell; `NaN` for one that is no number.
 */
export function parseNumber(text: string, amount: boolean): number | null {
  const t = text.trim().replace(/^(rp|idr|usd|us\$|\$)\.?\s*/i, '').replace(/\s+/g, '');
  if (t === '' || t === '-') return null;
  const m = /^([0-9][0-9.,]*)(rb|ribu|jt|juta|m|miliar)?$/i.exec(t);
  if (!m) return Number.NaN;
  let digits = m[1];
  const dots = (digits.match(/\./g) ?? []).length;
  const commas = (digits.match(/,/g) ?? []).length;
  if (dots > 0 && commas > 0) {
    const decimal = digits.lastIndexOf('.') > digits.lastIndexOf(',') ? '.' : ',';
    digits = digits.split(decimal === '.' ? ',' : '.').join('').replace(',', '.');
  } else if (dots + commas > 0) {
    const mark = dots > 0 ? '.' : ',';
    const count = dots + commas;
    const thousands = count > 1 || (amount && m[2] === undefined && new RegExp(`\\${mark}\\d{3}$`).test(digits));
    digits = thousands ? digits.split(mark).join('') : digits.replace(mark, '.');
  }
  const value = Number(digits);
  const scale = { rb: 1e3, ribu: 1e3, jt: 1e6, juta: 1e6, m: 1e9, miliar: 1e9 }[(m[2] ?? '').toLowerCase() as 'rb'] ?? 1;
  return value * scale;
}

/** An amount in whole units of a currency (*Rp4.500.000*, *$120,50*) as minor units; `null`, or `NaN` when unreadable. */
export function amountMinorOf(text: string): number | null {
  const n = parseNumber(text, true);
  if (n === null) return null;
  if (!Number.isFinite(n) || n < 0) return Number.NaN;
  return Math.round(n * 100);
}

const GENDERS: Record<string, 'male' | 'female' | null> = {
  l: 'male', lk: 'male', 'laki laki': 'male', lakilaki: 'male', laki: 'male', pria: 'male', male: 'male', m: 'male',
  p: 'female', pr: 'female', perempuan: 'female', wanita: 'female', female: 'female', f: 'female', w: 'female',
  '': null, semua: null, all: null, 'l p': null,
};
const SMOKER: Record<string, boolean | null> = {
  ya: true, y: true, perokok: true, merokok: true, smoker: true, yes: true, '1': true, true: true,
  tidak: false, t: false, n: false, no: false, 'bukan perokok': false, 'tidak merokok': false, 'non smoker': false,
  nonsmoker: false, '0': false, false: false, '': null, semua: null, all: null,
};
const FREQUENCIES: Record<string, ProposalPayFrequency | null> = {
  '': null, tahunan: null, tahun: null, annual: null, yearly: null,
  bulanan: 'monthly', bulan: 'monthly', monthly: 'monthly',
  kuartalan: 'quarterly', triwulan: 'quarterly', triwulanan: 'quarterly', quarterly: 'quarterly',
  semesteran: 'semiannual', semester: 'semiannual', 'enam bulanan': 'semiannual', semiannual: 'semiannual', 'half yearly': 'semiannual',
  sekali: 'single', sekaligus: 'single', 'sekali bayar': 'single', single: 'single',
};

/** **A pay term named in a cell**: its key, its label, its years (*10*, *10 tahun*), *s/d usia 60*, or *Sekali bayar*. */
export function payTermOf(text: string, terms: TableFacts['payTerms']): string | null | undefined {
  const n = norm(text);
  if (n === '' || n === 'semua' || n === 'all') return null;
  const byName = terms.find((t) => norm(t.key) === n || norm(t.label) === n);
  if (byName) return byName.key;
  const years = /^(\d+)( ?(tahun|th|thn|tahunan|years?|y))?$/.exec(n);
  if (years) return terms.find((t) => t.years === Number(years[1]))?.key;
  const toAge = /(?:s d|sd|sampai|hingga|to) ?(?:usia|umur|age)? ?(\d+)$/.exec(n);
  if (toAge) return terms.find((t) => t.toAge === Number(toAge[1]))?.key;
  if (['sekali', 'sekaligus', 'sekali bayar', 'single', 'single premium'].includes(n)) return terms.find((t) => t.single)?.key;
  return undefined;
}

/** The ages a cell names: one (*45*), or a range (*61–65*, *61 s/d 65*); `null` for *any*; `undefined` when unreadable. */
export function agesOf(text: string): number[] | null | undefined {
  const t = text.trim();
  if (t === '' || norm(t) === 'semua') return null;
  const one = /^\d{1,3}$/.exec(t);
  if (one) return Number(t) <= 120 ? [Number(t)] : undefined;
  const range = /^(\d{1,3})\s*(?:-|–|—|s\/d|sd|sampai)\s*(\d{1,3})$/i.exec(t);
  if (!range) return undefined;
  const [from, to] = [Number(range[1]), Number(range[2])];
  if (from > to || to > 120) return undefined;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const CURRENCIES: Record<string, ProductCurrency> = {
  idr: 'IDR', rp: 'IDR', rupiah: 'IDR', usd: 'USD', us: 'USD', dolar: 'USD', dollar: 'USD',
};

/**
 * **The rows of a draft, under its confirmed columns** (*Cocokkan kolom*, then the rows): every cell read as
 * `TableFacts` allow, or a problem with its row and column. A range of ages becomes one row per age, the same price.
 * Two rows naming the same price twice is a problem: the file would say two things.
 */
export function rowsFromRaw(
  raw: RawTable, map: Record<string, RateColumnRole>, facts: TableFacts,
): { rows: EngineRow[]; problems: RowProblem[]; problemCount: number } {
  const basis = basisOf(map);
  const col = (role: RateColumnRole) => {
    const name = Object.keys(map).find((c) => map[c] === role);
    return name === undefined ? null : { name, at: raw.header.indexOf(name) };
  };
  const cols = Object.fromEntries((RATE_COLUMN_ROLES as readonly RateColumnRole[]).map((r) => [r, col(r)])) as
    Record<RateColumnRole, { name: string; at: number } | null>;
  const rows: EngineRow[] = [];
  const problems: RowProblem[] = [];
  let problemCount = 0;
  const seen = new Set<string>();
  const problem = (p: RowProblem) => {
    problemCount += 1;
    if (problems.length < PRODUCT_DATA.PROBLEMS_MAX) problems.push(p);
  };

  raw.rows.forEach((cells, i) => {
    if (!cells.some((c) => c.trim() !== '')) return;
    const rowNumber = raw.firstRow + i;
    const cell = (role: RateColumnRole) => (cols[role] ? (cells[cols[role]!.at] ?? '').trim() : '');
    const fault = (role: RateColumnRole, reason: RowProblem['reason']) => {
      problem({ row: rowNumber, column: cols[role]?.name ?? role, value: cell(role), reason });
      return true;
    };
    let bad = false;

    const ages = cols.age ? agesOf(cell('age')) : null;
    if (ages === undefined) bad = fault('age', 'age');
    const genderKey = norm(cell('gender'));
    const gender = genderKey in GENDERS ? GENDERS[genderKey] : undefined;
    if (gender === undefined) bad = fault('gender', 'gender');
    const smokerKey = norm(cell('smoker'));
    const smoker = smokerKey in SMOKER ? SMOKER[smokerKey] : undefined;
    if (smoker === undefined) bad = fault('smoker', 'smoker');
    const planText = cell('plan');
    const plan = planText === '' || norm(planText) === 'semua'
      ? null : facts.plans.find((p) => norm(p) === norm(planText));
    if (plan === undefined) bad = fault('plan', 'plan');
    const payTerm = payTermOf(cell('payTerm'), facts.payTerms);
    if (payTerm === undefined) bad = fault('payTerm', 'payTerm');
    const currencyText = norm(cell('currency').replace('$', ' usd '));
    const currency = currencyText === '' ? facts.currencies[0] : CURRENCIES[currencyText.split(' ')[0]];
    if (currency === undefined || !facts.currencies.includes(currency)) bad = fault('currency', 'currency');
    const frequencyKey = norm(cell('frequency'));
    const frequency = frequencyKey in FREQUENCIES ? FREQUENCIES[frequencyKey] : undefined;
    if (frequency === undefined) bad = fault('frequency', 'frequency');

    let rate = Number.NaN;
    if (basis === 'per_plan') {
      const minor = amountMinorOf(cell('premium'));
      if (minor === null || Number.isNaN(minor) || minor <= 0) bad = fault('premium', 'number');
      else rate = minor;
    } else {
      const value = parseNumber(cell('rate'), false);
      if (value === null || !Number.isFinite(value) || value < 0 || value > PRODUCT_DATA.RATE_MAX) bad = fault('rate', 'number');
      else rate = Math.round(value * 10 ** PRODUCT_DATA.RATE_DECIMALS) / 10 ** PRODUCT_DATA.RATE_DECIMALS;
    }
    let bandMin: number | null = null;
    let bandMax: number | null = null;
    if (basis === 'per_band') {
      bandMin = amountMinorOf(cell('bandMin'));
      bandMax = amountMinorOf(cell('bandMax'));
      if (bandMin === null || Number.isNaN(bandMin)) bad = fault('bandMin', 'number');
      else if (bandMax === null || Number.isNaN(bandMax)) bad = fault('bandMax', 'number');
      else if (bandMin > bandMax) bad = fault('bandMax', 'band');
    }
    if (bad || basis === null) return;

    for (const age of ages ?? [null]) {
      const row: EngineRow = {
        age, gender: gender ?? null, smoker: smoker ?? null, plan: plan ?? null, payTerm: payTerm ?? null,
        currency: currency!, frequency: frequency ?? null, basis, rate, bandMin, bandMax,
      };
      const key = JSON.stringify([row.age, row.gender, row.smoker, row.plan, row.payTerm, row.currency, row.frequency, row.bandMin, row.bandMax]);
      if (seen.has(key)) {
        fault('age', 'duplicate');
        return;
      }
      seen.add(key);
      rows.push(row);
    }
  });
  if (rows.length > PRODUCT_DATA.ROWS_MAX) problem({ row: raw.firstRow + raw.rows.length - 1, column: '', value: String(rows.length), reason: 'range' });
  return { rows, problems, problemCount };
}

// ------------------------------------------------------------------------------------------------ *Ketentuan*

/** **The *Ketentuan* sheet's labels** (the template's), each with the rule it fills. */
export const KETENTUAN_LABELS = {
  upStep: 'UP kelipatan',
  upMin: 'UP minimum',
  upMax: 'UP maksimum',
  premiumMin: 'Premi minimum per tahun',
  premiumMax: 'Premi maksimum per tahun',
  monthly: 'Faktor bulanan',
  quarterly: 'Faktor kuartalan',
  semiannual: 'Faktor semesteran',
  annual: 'Faktor tahunan',
  entryAgeMin: 'Usia masuk minimum',
  entryAgeMax: 'Usia masuk maksimum',
  payTermMaxAge: 'Usia masuk maks.',
} as const;

/**
 * **The rules a *Ketentuan* sheet states** — two columns, *Ketentuan* and *Nilai*, one row per rule. An empty value is
 * *no limit*; a label the template does not have, or a value that is no number, is answered as a problem (row and
 * label), never read. *"Usia masuk maks. {Masa bayar}"* names one pay term by its label or key.
 */
export function rulesFromKetentuan(
  cells: readonly (readonly string[])[], facts: TableFacts,
): { rules: Partial<RateRules>; frequencies: Partial<FrequencyFactors>; problems: { row: number; label: string; value: string }[] } {
  const rules: Partial<RateRules> = {};
  const frequencies: Partial<FrequencyFactors> = {};
  const problems: { row: number; label: string; value: string }[] = [];
  const payTermMaxAge: Record<string, number> = {};
  cells.forEach((row, i) => {
    const label = (row[0] ?? '').trim();
    const value = (row[1] ?? '').trim();
    const n = norm(label);
    if (n === '' || n === norm('Ketentuan')) return;
    const say = () => problems.push({ row: i + 1, label, value });
    const amountKey = (['upStep', 'upMin', 'upMax', 'premiumMin', 'premiumMax'] as const).find((k) => norm(KETENTUAN_LABELS[k]) === n);
    if (amountKey) {
      const minor = amountMinorOf(value);
      if (Number.isNaN(minor) || (amountKey === 'upStep' && minor === 0)) return say();
      rules[amountKey] = minor;
      return;
    }
    const factorKey = (['monthly', 'quarterly', 'semiannual', 'annual'] as const).find((k) => norm(KETENTUAN_LABELS[k]) === n);
    if (factorKey) {
      const factor = parseNumber(value, false);
      if (factor !== null && !(Number.isFinite(factor) && factor > 0 && factor <= PRODUCT_DATA.FACTOR_MAX)) return say();
      frequencies[factorKey] = factor;
      return;
    }
    const ageKey = (['entryAgeMin', 'entryAgeMax'] as const).find((k) => norm(KETENTUAN_LABELS[k]) === n);
    const termPrefix = norm(KETENTUAN_LABELS.payTermMaxAge);
    if (ageKey || n.startsWith(termPrefix)) {
      const age = value === '' ? null : /^\d{1,3}$/.test(value) && Number(value) <= 120 ? Number(value) : Number.NaN;
      if (Number.isNaN(age)) return say();
      if (ageKey) {
        rules[ageKey] = age;
        return;
      }
      // An empty row is no limit, whichever term it names.
      if (age === null) return;
      const term = payTermOf(label.slice(label.toLowerCase().indexOf('maks.') + 5).trim(), facts.payTerms);
      if (!term) return say();
      payTermMaxAge[term] = age;
      return;
    }
    say();
  });
  if (Object.keys(payTermMaxAge).length > 0) rules.payTermMaxAge = payTermMaxAge;
  return { rules, frequencies, problems };
}

/** **The *Ketentuan* sheet the template carries**, filled with the rules it would replace. */
export function ketentuanRows(facts: TableFacts, rules: RateRules, frequencies: FrequencyFactors): string[][] {
  const amount = (minor: number | null) => (minor === null ? '' : String(minor / 100));
  const factor = (f: number | null) => (f === null ? '' : String(f));
  return [
    ['Ketentuan', 'Nilai'],
    [KETENTUAN_LABELS.upStep, amount(rules.upStep)],
    [KETENTUAN_LABELS.upMin, amount(rules.upMin)],
    [KETENTUAN_LABELS.upMax, amount(rules.upMax)],
    [KETENTUAN_LABELS.premiumMin, amount(rules.premiumMin)],
    [KETENTUAN_LABELS.premiumMax, amount(rules.premiumMax)],
    [KETENTUAN_LABELS.monthly, factor(frequencies.monthly)],
    [KETENTUAN_LABELS.quarterly, factor(frequencies.quarterly)],
    [KETENTUAN_LABELS.semiannual, factor(frequencies.semiannual)],
    [KETENTUAN_LABELS.annual, factor(frequencies.annual)],
    [KETENTUAN_LABELS.entryAgeMin, rules.entryAgeMin === null ? '' : String(rules.entryAgeMin)],
    [KETENTUAN_LABELS.entryAgeMax, rules.entryAgeMax === null ? '' : String(rules.entryAgeMax)],
    ...facts.payTerms.filter((t) => !t.single || facts.payTerms.length > 1).map((t) => [
      `${KETENTUAN_LABELS.payTermMaxAge} ${t.label}`,
      rules.payTermMaxAge[t.key] === undefined ? '' : String(rules.payTermMaxAge[t.key]),
    ]),
  ];
}

/** **The template's data columns** for a product: the attributes it prices by, then its rate or its premium. */
export function templateHeader(facts: TableFacts): string[] {
  return [
    TEMPLATE_COLUMNS.age,
    TEMPLATE_COLUMNS.gender,
    ...(facts.smokerRated ? [TEMPLATE_COLUMNS.smoker] : []),
    ...(facts.plans.length > 0 ? [TEMPLATE_COLUMNS.plan] : []),
    ...(facts.payTerms.length > 0 ? [TEMPLATE_COLUMNS.payTerm] : []),
    ...(facts.currencies.length > 1 ? [TEMPLATE_COLUMNS.currency] : []),
    facts.calcType === 'plan_priced' ? TEMPLATE_COLUMNS.premium : TEMPLATE_COLUMNS.rate,
  ];
}

// ------------------------------------------------------------------------------------------------ *Cek kelengkapan*

/** Consecutive ages as ranges: `[61, 62, 63, 70]` → `[[61, 63], [70, 70]]`. */
export function rangesOf(ages: readonly number[]): [number, number][] {
  const sorted = [...new Set(ages)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const age of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === age - 1) last[1] = age;
    else out.push([age, age]);
  }
  return out;
}

/**
 * **Every gap, in plain words' terms** (*Cek kelengkapan*; P19.15-T1 AC-1): what the product says changes the price,
 * against what the table holds — a currency, a smoker rate where *Merokok berpengaruh*, a gender, a plan, a pay term, a
 * plan with a pay term, an age everywhere, an age for one combination. The ages expected are the version's entry ages
 * (else the product's, else the table's own span), each pay term's up to its maximum entry age. **Never blocking**.
 */
export function gapsOf(rows: readonly EngineRow[], facts: TableFacts, rules: RateRules): { gaps: RateGap[]; count: number } {
  const gaps: RateGap[] = [];
  if (rows.length === 0) return { gaps, count: 0 };
  const has = (pred: (r: EngineRow) => boolean) => rows.some(pred);

  for (const currency of facts.currencies) if (!has((r) => r.currency === currency)) gaps.push({ kind: 'currency', currency });
  if (facts.smokerRated && !has((r) => r.smoker === true)) gaps.push({ kind: 'smoker' });
  const genderRated = has((r) => r.gender !== null);
  const genders: ('male' | 'female' | null)[] = genderRated ? ['male', 'female'] : [null];
  for (const g of genders) if (g !== null && !has((r) => r.gender === g || r.gender === null)) gaps.push({ kind: 'gender', gender: g });
  const planRated = facts.plans.length > 0 && (facts.calcType === 'plan_priced' || has((r) => r.plan !== null));
  const plans: (string | null)[] = planRated ? facts.plans : [null];
  for (const plan of plans) if (plan !== null && !has((r) => r.plan === plan || r.plan === null)) gaps.push({ kind: 'plan', plan });
  const terms = facts.payTerms.length > 0 ? facts.payTerms : [null];
  for (const t of terms) {
    if (t !== null && !has((r) => r.payTerm === t.key || r.payTerm === null)) gaps.push({ kind: 'payTerm', payTerm: t.key, payTermLabel: t.label });
  }
  const missingPlans = new Set(gaps.filter((g) => g.kind === 'plan').map((g) => g.plan));
  const missingTerms = new Set(gaps.filter((g) => g.kind === 'payTerm').map((g) => g.payTerm));
  for (const plan of plans) {
    for (const t of terms) {
      if (plan === null || t === null || missingPlans.has(plan) || missingTerms.has(t.key)) continue;
      if (!has((r) => (r.plan === plan || r.plan === null) && (r.payTerm === t.key || r.payTerm === null))) {
        gaps.push({ kind: 'combination', plan, payTerm: t.key, payTermLabel: t.label });
      }
    }
  }

  const ageRated = has((r) => r.age !== null);
  if (ageRated) {
    const present = rows.filter((r) => r.age !== null).map((r) => r.age as number);
    const min = rules.entryAgeMin ?? facts.entryAge?.min ?? Math.min(...present);
    const max = rules.entryAgeMax ?? facts.entryAge?.max ?? Math.max(...present);
    // A row for any age covers every age; else an age no row names is missing everywhere.
    const everywhere = new Set(present);
    const anyAge = has((r) => r.age === null);
    const missingEverywhere: number[] = [];
    for (let age = min; age <= max; age += 1) if (!anyAge && !everywhere.has(age)) missingEverywhere.push(age);
    for (const [from, to] of rangesOf(missingEverywhere)) gaps.push({ kind: 'ages', from, to });
    const reported = new Set(missingEverywhere);
    const smokers: (boolean | null)[] = facts.smokerRated ? [false, true] : [null];
    for (const plan of plans) {
      if (missingPlans.has(plan)) continue;
      for (const t of terms) {
        if (t !== null && missingTerms.has(t.key)) continue;
        const termMax = t === null ? null : rules.payTermMaxAge[t.key] ?? t.maxEntryAge;
        const top = termMax === null ? max : Math.min(max, termMax);
        for (const gender of genders) {
          for (const smoker of smokers) {
            const combo = rows.filter((r) => (r.plan === plan || r.plan === null || plan === null)
              && (t === null || r.payTerm === t.key || r.payTerm === null)
              && (gender === null || r.gender === gender || r.gender === null)
              && (smoker === null || r.smoker === smoker || r.smoker === null));
            if (combo.length === 0) continue;
            if (combo.some((r) => r.age === null)) continue;
            const ages = new Set(combo.map((r) => r.age as number));
            const missing: number[] = [];
            for (let age = min; age <= top; age += 1) if (!ages.has(age) && !reported.has(age)) missing.push(age);
            for (const [from, to] of rangesOf(missing)) {
              gaps.push({ kind: 'ages', from, to, plan, payTerm: t?.key ?? null, payTermLabel: t?.label ?? null, gender, smoker });
            }
          }
        }
      }
    }
  }
  return { gaps: gaps.slice(0, PRODUCT_DATA.GAPS_MAX), count: gaps.length };
}

/**
 * **What a product's table is made against** (P1b §1's *product changed in the catalog after its table was uploaded*):
 * the calculation type, the plans, the pay terms' keys, the smoker rating and the currencies, as one string. A change to
 * a label or a limit does not move it — the rows still mean what they meant.
 */
export function fingerprintOf(facts: TableFacts): string {
  return JSON.stringify([facts.calcType, [...facts.plans].sort(), facts.payTerms.map((t) => t.key).sort(), facts.smokerRated, [...facts.currencies].sort()]);
}
