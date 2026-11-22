import { formatDate, formatRupiahCompact } from '@/common/format/format';
import { INTAKE, type IntakeItemKind } from '@/domain/constants';
import type { CatalogueEntry, CompanyEntry } from './ai/reader.port';
import type { ReadColumn, ReadFigure, ReadItem, ReadSource } from './ai/reading-schema';
import { cellAt, type GridSheet } from './intake-files';
import { exactAsWritten, minorUnitsOf, rateOf, wholeOf, factorOf, factorText, plainText } from './intake-numbers';
import type {
  IntakeChoice, IntakeDiffRow, IntakeItem, IntakeQuestion, IntakeSource, IntakeTable, IntakeTableColumn,
} from './upload-intake.schema';

/**
 * **What the reading understood, made into cards by our own code** (P19.15-T3 AC-2, AC-3; ADR-0259 §3, §4).
 *
 * The model reports; this file decides. Every question card is raised **here, from the reading's own flags** — a match
 * that is not `clear`, a value not `certain`, a column whose meaning is `unclear`, a number that is no exact reading of
 * its text — so a reading that forgot to ask still asks. Every number on a card is taken by `intake-numbers.ts` from the
 * text as written; a table's cells from a workbook or a CSV are read from the grid itself, never from the model.
 *
 * Pure: the catalogue, the current values and the grid come in; the card goes out.
 */

/** What a card's old values are read from: the product as the catalogue holds it, and the rules in force. */
export interface ProductNow {
  id: string;
  companyId: string;
  name: string;
  lifecycle: string;
  smokerRated: boolean;
  frequencies: string[];
  payTerms: { key: string; label: string; years: number | null }[];
  /** `chips` fields with their options' labels: what an option added or removed is checked against. */
  chipFields: { key: string; label: string; options: string[] }[];
  /** The rules a card compares with: the version in force today, else the catalogue's. Minor units; ages whole. */
  rules: {
    upStep: number | null; upMin: number | null; upMax: number | null; premiumMin: number | null; premiumMax: number | null;
    entryAgeMin: number | null; entryAgeMax: number | null; payTermMaxAge: Record<string, number>;
    frequencyFactor: Record<string, number | null>;
  };
  /** The table in force today, for *"Berlaku 1 Apr 2026"* and a percentage's rule; `null` for none. */
  table: { effectiveFrom: string; basis: string | null; rateDecimals: number } | null;
}

export interface UnderstandingContext {
  /** The upload's company, or `null` on *Perusahaan*'s upload. */
  companyId: string | null;
  companies: readonly CompanyEntry[];
  catalogue: readonly CatalogueEntry[];
  products: ReadonlyMap<string, ProductNow>;
  file: { index: number; name: string; grid: readonly GridSheet[] | null };
  today: string;
  /** Question ids: deterministic in a test, a ULID in the service. */
  newId: () => string;
}

/** A card before it is stored. */
export type ItemDraft = Pick<
  IntakeItem,
  'companyId' | 'productId' | 'productAsWritten' | 'kind' | 'summary' | 'effectiveFrom' | 'effectiveTo' | 'source' | 'diff'
  | 'table' | 'percent' | 'newProductName' | 'questions' | 'confidence' | 'status'
>;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day that exists: `2026-02-30` does not. */
export function isRealDay(text: string | null | undefined): text is string {
  const m = text ? DAY.exec(text) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const sourceOf = (file: UnderstandingContext['file'], s: ReadSource): IntakeSource => ({
  file: file.index,
  fileName: file.name,
  page: s.page !== null && s.page >= 1 ? s.page : null,
  sheet: s.sheet?.slice(0, 120) ?? null,
  cell: s.cell?.slice(0, 40) ?? null,
  quote: s.quote?.slice(0, 200) ?? null,
});

const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Catalogue products whose name, code or syariah name the text names, closest first: a product question's choices. */
export function likelyProducts(asWritten: string, catalogue: readonly CatalogueEntry[], companyId: string | null): CatalogueEntry[] {
  const wanted = squash(asWritten);
  const pool = catalogue.filter((p) => companyId === null || p.companyId === companyId);
  if (!wanted) return pool.slice(0, 8);
  const scored = pool.map((p) => {
    const names = [p.name, p.code, p.syariahName ?? ''].map(squash).filter(Boolean);
    const score = names.some((n) => n === wanted) ? 3
      : names.some((n) => n.includes(wanted) || wanted.includes(n)) ? 2
        : names.some((n) => n.slice(0, 5) === wanted.slice(0, 5)) ? 1 : 0;
    return { p, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.p);
  return (hits.length ? hits : pool).slice(0, 8);
}

/** Whether a name the file writes is close to any product of the catalogue: else it is one the catalogue does not have. */
export function namesAProduct(asWritten: string, catalogue: readonly CatalogueEntry[], companyId: string | null): boolean {
  const wanted = squash(asWritten);
  if (!wanted) return false;
  return catalogue.filter((p) => companyId === null || p.companyId === companyId).some((p) => [p.name, p.code, p.syariahName ?? '']
    .map(squash).filter(Boolean).some((n) => n === wanted || n.includes(wanted) || wanted.includes(n) || n.slice(0, 5) === wanted.slice(0, 5)));
}

/** The kinds that need a product, a date from when, and which need the date of an illustration. */
const NEEDS_DATE: readonly IntakeItemKind[] = ['premium_table', 'product_rules', 'percent_change'];

const money = (minor: number | null) => (minor === null ? null : formatRupiahCompact(minor, { lossless: true }, 'id'));
const years = (n: number | null) => (n === null ? null : `${n} tahun`);

const RULE_LABEL: Readonly<Record<string, string>> = {
  upStep: 'Kelipatan UP', upMin: 'UP minimum', upMax: 'UP maksimum', premiumMin: 'Premi minimum',
  premiumMax: 'Premi maksimum', entryAgeMin: 'Usia masuk minimum', entryAgeMax: 'Usia masuk maksimum',
};
const FREQUENCY_LABEL: Readonly<Record<string, string>> = {
  monthly: 'bulanan', quarterly: 'kuartalan', semiannual: 'semesteran',
};

/** The column choices a person picks a meaning from; the value is what the table reader understands. */
export const COLUMN_CHOICES: readonly IntakeChoice[] = [
  { value: 'rate:male', label: 'Tarif laki-laki' },
  { value: 'rate:female', label: 'Tarif perempuan' },
  { value: 'rate', label: 'Tarif (semua)' },
  { value: 'age', label: 'Usia' },
  { value: 'gender', label: 'Jenis kelamin' },
  { value: 'smoker', label: 'Merokok' },
  { value: 'plan', label: 'Plan' },
  { value: 'pay_term', label: 'Masa bayar' },
  { value: 'ignore', label: 'Abaikan kolom ini' },
];

const COLUMN_LETTER = /^[A-Z]{1,3}$/;

/** Builds one card. */
class Card {
  readonly questions: IntakeQuestion[] = [];
  readonly diff: IntakeDiffRow[] = [];
  uncertain = false;

  constructor(private readonly ctx: UnderstandingContext) {}

  ask(q: Omit<IntakeQuestion, 'id' | 'answer' | 'answeredBy' | 'answeredAt' | 'when'> & { when?: IntakeQuestion['when'] }): IntakeQuestion {
    const question: IntakeQuestion = {
      id: this.ctx.newId(), when: q.when ?? null, answer: null, answeredBy: null, answeredAt: null, ...q,
      text: q.text.slice(0, 240), choices: q.choices.slice(0, 12),
    };
    this.questions.push(question);
    this.uncertain = true;
    return question;
  }
}

/** **A figure as the file writes it**, if it is an exact reading: else `null`, and the caller asks. */
function figure(f: ReadFigure): ReturnType<typeof exactAsWritten> {
  return f.certain ? exactAsWritten(f.asWritten, f.value) : null;
}

/** The rules a card may change, their old value, their new one, and the question when the new one is not certain. */
function ruleRows(card: Card, item: ReadItem, product: ProductNow | null, ctx: UnderstandingContext): void {
  for (const change of item.changes) {
    const src = sourceOf(ctx.file, change.source);
    const exact = figure(change.value);
    let key: string = change.key;
    let label = change.label || RULE_LABEL[change.key] || change.key;
    let old: string | null = null;
    let value: number | string | boolean | null = null;
    let shown: string | null = null;
    const r = product?.rules;
    switch (change.key) {
      case 'upStep': case 'upMin': case 'upMax': case 'premiumMin': case 'premiumMax': {
        label = RULE_LABEL[change.key];
        old = money(r ? r[change.key] : null);
        value = exact ? minorUnitsOf(exact) : null;
        shown = money(value as number | null);
        break;
      }
      case 'entryAgeMin': case 'entryAgeMax': {
        label = RULE_LABEL[change.key];
        old = years(r ? r[change.key] : null);
        value = exact ? wholeOf(exact) : null;
        shown = years(value as number | null);
        break;
      }
      case 'payTermMaxAge': {
        const term = product?.payTerms.find((t) => t.key === change.payTermKey);
        if (!term) {
          card.ask({
            kind: 'choice', about: `payterm:${card.diff.length}`,
            text: `Masa bayar mana yang dimaksud "${change.label}"?`,
            choices: (product?.payTerms ?? []).map((t) => ({ value: t.key, label: t.label })),
          });
        }
        key = `payTermMaxAge:${term?.key ?? '?'}`;
        label = `Usia masuk maksimum, bayar ${term?.label ?? change.label}`;
        old = years(term ? r?.payTermMaxAge[term.key] ?? null : null);
        value = exact ? wholeOf(exact) : null;
        shown = years(value as number | null);
        break;
      }
      case 'frequencyFactor': {
        const f = change.frequency;
        key = `frequencyFactor:${f ?? '?'}`;
        label = `Faktor ${f ? FREQUENCY_LABEL[f] : 'cara bayar'}`;
        const before = f ? r?.frequencyFactor[f] ?? null : null;
        old = before === null || before === undefined ? null : String(before).replace('.', ',');
        value = exact ? rateOf(exact) : null;
        shown = exact ? plainText(exact).replace('.', ',') : null;
        if (!f) {
          card.ask({
            kind: 'choice', about: `frequency:${card.diff.length}`, text: `Faktor "${change.label}" untuk cara bayar apa?`,
            choices: [{ value: 'monthly', label: 'Bulanan' }, { value: 'quarterly', label: 'Kuartalan' }, { value: 'semiannual', label: 'Semesteran' }],
          });
        }
        break;
      }
      case 'name': {
        old = product?.name ?? null;
        value = change.value.asWritten.trim().slice(0, 120) || null;
        shown = value as string | null;
        label = 'Nama produk';
        break;
      }
      case 'smokerRated': {
        old = product ? (product.smokerRated ? 'Ya' : 'Tidak') : null;
        const yes = /^(ya|yes|y|true|berpengaruh)$/i.test(change.value.asWritten.trim());
        const no = /^(tidak|no|n|false|tidak berpengaruh)$/i.test(change.value.asWritten.trim());
        value = yes ? true : no ? false : null;
        shown = value === null ? null : value ? 'Ya' : 'Tidak';
        label = 'Merokok berpengaruh?';
        break;
      }
      case 'frequencies': {
        const words = change.value.asWritten.toLowerCase();
        const found = [
          ['monthly', /bulan/], ['quarterly', /kuartal|triwulan|3 bulan/], ['semiannual', /semester|6 bulan/],
          ['annual', /tahun/], ['single', /sekaligus|tunggal|sekali bayar/],
        ].filter(([, re]) => (re as RegExp).test(words)).map(([k]) => k as string);
        old = product?.frequencies.join(', ') ?? null;
        value = found.length ? found.join(',') : null;
        shown = found.length ? found.join(', ') : null;
        label = 'Cara bayar';
        break;
      }
      case 'optionAdded': case 'optionRemoved': {
        const field = product?.chipFields.find((f) => f.key === change.fieldKey);
        key = `${change.key}:${field?.key ?? '?'}`;
        label = `${field?.label ?? change.label}: pilihan ${change.key === 'optionAdded' ? 'baru' : 'dihapus'}`;
        old = field ? field.options.join(', ') : null;
        value = change.value.asWritten.trim().slice(0, 80) || null;
        shown = value as string | null;
        if (!field) {
          card.ask({
            kind: 'choice', about: `field:${card.diff.length}`, text: `Isian mana yang dimaksud "${change.label}"?`,
            choices: (product?.chipFields ?? []).map((f) => ({ value: f.key, label: f.label })),
          });
        }
        break;
      }
    }
    const numeric = ['upStep', 'upMin', 'upMax', 'premiumMin', 'premiumMax', 'entryAgeMin', 'entryAgeMax', 'payTermMaxAge', 'frequencyFactor'].includes(change.key);
    const certain = value !== null;
    card.diff.push({ key, label, old, new: shown, value, certain, source: src });
    if (!certain) {
      card.ask({
        kind: numeric ? 'type_number' : 'text',
        about: `diff:${key}`,
        text: numeric
          ? `Angka "${label}" tidak terbaca jelas${change.value.asWritten ? ` (tertulis "${change.value.asWritten.slice(0, 40)}")` : ''}. Ketik angkanya.`
          : `"${label}" tidak terbaca jelas. Ketik isinya.`,
        choices: [],
      });
    }
  }
}

/** A table's meaning from a column choice's value: `rate:male` → a rate column for men. */
export function columnFromChoice(base: IntakeTableColumn, choice: string): IntakeTableColumn {
  const [meaning, gender] = choice.split(':');
  return {
    ...base,
    meaning: meaning as IntakeTableColumn['meaning'],
    gender: gender === 'male' || gender === 'female' ? gender : base.gender,
  };
}

/** **The premium table**: its columns, its cells as written (from the grid itself, or the transcription), its questions. */
function tableOf(card: Card, item: ReadItem, ctx: UnderstandingContext): IntakeTable | null {
  const t = item.table;
  if (!t) return null;
  const columns: IntakeTableColumn[] = t.columns.map((c: ReadColumn) => ({
    column: c.column.slice(0, 40), header: c.header.slice(0, 80), meaning: c.clear ? c.meaning : 'unclear',
    gender: c.gender, smoker: c.smoker, plan: c.plan, payTermKey: c.payTermKey,
  }));
  for (const c of columns.filter((col) => col.meaning === 'unclear')) {
    const said = t.columns.find((x) => x.column === c.column)?.question;
    card.ask({
      kind: 'column', about: `column:${c.column}`,
      text: said?.trim() || `Kolom "${c.header || c.column}" ini berisi apa?`,
      choices: [...COLUMN_CHOICES],
    });
  }
  if (t.basis === 'unclear') {
    card.ask({
      kind: 'choice', about: 'basis', text: 'Tabel ini berisi apa?',
      choices: [
        { value: 'per_mille', label: 'Tarif per Rp1.000 UP' },
        { value: 'per_plan', label: 'Premi tetap per plan' },
        { value: 'per_band', label: 'Tarif per rentang UP' },
      ],
    });
  }
  if (t.currency === 'unclear') {
    card.ask({ kind: 'choice', about: 'currency', text: 'Tabel ini dalam mata uang apa?', choices: [{ value: 'IDR', label: 'Rupiah' }, { value: 'USD', label: 'Dolar AS' }] });
  }

  const rows: IntakeTable['rows'] = [];
  const gaps = t.gaps.map((g) => g.slice(0, 160)).slice(0, 50);
  const grid = ctx.file.grid;
  if (grid) {
    // A workbook or a CSV: every cell read from the grid itself, the model's mapping deciding only which.
    const first = t.firstRow ?? (t.headerRow !== null ? t.headerRow + 1 : null);
    const last = t.lastRow;
    const sheet = t.sheet ?? grid[0]?.name ?? null;
    const sheetRows = grid.find((g) => g.name === sheet)?.rows ?? [];
    const wanted = columns.filter((c) => COLUMN_LETTER.test(c.column) && c.meaning !== 'ignore');
    for (const r of sheetRows) {
      if (first === null || r.row < first || (last !== null && r.row > last)) continue;
      if (rows.length >= INTAKE.TABLE_ROWS_MAX) break;
      const cells: IntakeTable['rows'][number]['cells'] = {};
      for (const c of wanted) {
        const text = cellAt(grid, sheet, r.row, c.column);
        if (text !== null) cells[c.column] = { text, value: null, certain: true };
      }
      if (Object.keys(cells).length) rows.push({ row: r.row, page: null, cells });
    }
  } else {
    // A PDF, a picture or a Word file: the transcription, each value kept with its certainty.
    let asked = 0;
    let skipped = 0;
    const ageColumn = columns.find((c) => c.meaning === 'age')?.column;
    for (const [i, r] of t.rows.slice(0, INTAKE.TABLE_ROWS_MAX).entries()) {
      const cells: IntakeTable['rows'][number]['cells'] = {};
      for (const cell of r.cells) {
        const exact = cell.value.certain ? exactAsWritten(cell.value.asWritten, cell.value.value) : null;
        const isText = columns.find((c) => c.column === cell.column)?.meaning;
        const textual = isText === 'gender' || isText === 'smoker' || isText === 'plan' || isText === 'pay_term';
        const certain = textual ? cell.value.certain : exact !== null;
        cells[cell.column] = { text: cell.value.asWritten.slice(0, 60), value: exact ? plainText(exact) : null, certain };
        if (!certain) {
          if (asked < 40) {
            asked += 1;
            const age = ageColumn ? r.cells.find((x) => x.column === ageColumn)?.value.asWritten : null;
            const header = columns.find((c) => c.column === cell.column)?.header ?? cell.column;
            card.ask({
              kind: 'type_number', about: `cell:${i}:${cell.column}`,
              text: `Angka di ${age ? `baris usia ${age}` : `baris ${i + 1}`}, kolom "${header}" tidak terbaca jelas${ctx.file.name ? '' : ''}. Ketik angkanya.`,
              choices: [],
            });
          } else {
            skipped += 1;
          }
        }
      }
      rows.push({ row: r.source.page === null ? i + 1 : null, page: r.source.page, cells });
    }
    if (skipped) gaps.push(`${skipped} angka lain tidak terbaca jelas dan dilewati: kombinasinya tidak ada di tabel.`);
  }
  return {
    sheet: t.sheet, basis: t.basis === 'unclear' ? null : t.basis, currency: t.currency === 'unclear' ? null : t.currency,
    columns, rows, gaps,
  };
}

/** The card's product: matched and clear, else a question (*File ini untuk produk apa?* or *tidak ada di katalog*). */
function productOf(card: Card, item: ReadItem, companyId: string | null, ctx: UnderstandingContext): { productId: string | null; asWritten: string | null } {
  const named = item.products[0] ?? null;
  const asWritten = named?.asWritten?.trim().slice(0, 120) || item.newProductName?.trim().slice(0, 120) || null;
  const match = named?.id ? ctx.catalogue.find((p) => p.id === named.id && (companyId === null || p.companyId === companyId)) : undefined;
  if (item.kind !== 'new_product' && match && named?.clear) return { productId: match.id, asWritten };

  const likely = likelyProducts(asWritten ?? '', ctx.catalogue, companyId);
  if (item.kind === 'new_product' || (asWritten && !match && !named?.id && !namesAProduct(asWritten, ctx.catalogue, companyId))) {
    const q = card.ask({
      kind: 'unknown_product', about: 'product',
      text: `Produk "${asWritten ?? 'tanpa nama'}" tidak ada di katalog: produk baru, nama baru dari produk lama, atau abaikan?`,
      choices: [
        { value: 'new', label: 'Produk baru' },
        ...likely.slice(0, 6).map((p) => ({ value: `rename:${p.id}`, label: `Nama baru dari ${p.name}` })),
        { value: 'ignore', label: 'Abaikan' },
      ],
    });
    card.ask({ kind: 'text', about: 'new:code', text: 'Kode produk barunya apa? (huruf besar, contoh PRUNEWX)', choices: [], when: { question: q.id, answer: 'new' } });
    card.ask({
      kind: 'choice', about: 'new:category', text: 'Produk baru ini termasuk kategori apa?', when: { question: q.id, answer: 'new' },
      choices: [
        { value: 'health', label: 'Kesehatan' }, { value: 'ci', label: 'Penyakit kritis' },
        { value: 'life', label: 'Jiwa' }, { value: 'education', label: 'Pendidikan' }, { value: 'investment', label: 'Investasi / dana masa depan' },
      ],
    });
    card.ask({
      kind: 'choice', about: 'new:channel', text: 'Konvensional atau syariah?', when: { question: q.id, answer: 'new' },
      choices: [{ value: 'conventional', label: 'Konvensional' }, { value: 'syariah', label: 'Syariah' }],
    });
    return { productId: null, asWritten };
  }
  card.ask({
    kind: 'product', about: 'product', text: 'File ini untuk produk apa?',
    choices: [...likely.map((p) => ({ value: p.id, label: p.name })), { value: 'ignore', label: 'Abaikan' }],
  });
  return { productId: null, asWritten };
}

/**
 * **One card from one item the reading reported** — its company, product, dates, values old → new, table, percentage and
 * every question it must ask. `null` for an item that says nothing we keep (a kind with nothing in it).
 */
export function understand(item: ReadItem, ctx: UnderstandingContext): ItemDraft {
  const card = new Card(ctx);

  // The company: the upload's, else the file's when it says it clearly, else a question.
  let companyId = ctx.companyId;
  if (!companyId) {
    const said = item.company?.id && ctx.companies.some((c) => c.id === item.company!.id) ? item.company.id : null;
    if (said && item.company?.clear) companyId = said;
    else {
      card.ask({
        kind: 'company', about: 'company',
        text: item.company?.asWritten ? `Perusahaan "${item.company.asWritten}" yang mana?` : 'File ini dari perusahaan asuransi mana?',
        choices: ctx.companies.map((c) => ({ value: c.id, label: c.name })),
      });
    }
  }

  const { productId, asWritten } = productOf(card, item, companyId, ctx);
  const product = productId ? ctx.products.get(productId) ?? null : null;

  // From when: the file's day when it says it clearly, else a question.
  let effectiveFrom: string | null = null;
  const needsDay = NEEDS_DATE.includes(item.kind) || item.kind === 'illustration';
  if (item.effectiveFrom.clear && isRealDay(item.effectiveFrom.date)) effectiveFrom = item.effectiveFrom.date;
  else if (needsDay) {
    card.ask({
      kind: 'date', about: 'effectiveFrom',
      text: item.kind === 'illustration'
        ? 'Tanggal ilustrasi tidak ditemukan. Tanggal berapa?'
        : item.effectiveFrom.asWritten
          ? `Tanggal berlaku "${item.effectiveFrom.asWritten.slice(0, 40)}" kurang jelas. Mulai kapan?`
          : 'Tanggal berlaku tidak ditemukan. Mulai kapan?',
      choices: [],
    });
  }
  const effectiveTo = item.effectiveTo.clear && isRealDay(item.effectiveTo.date) ? item.effectiveTo.date : null;

  let table: IntakeTable | null = null;
  let percent: ItemDraft['percent'] = null;
  const src = sourceOf(ctx.file, item.source);

  switch (item.kind) {
    case 'premium_table': {
      table = tableOf(card, item, ctx);
      const count = table?.rows.length ?? 0;
      card.diff.push({
        key: 'table', label: 'Tabel premi',
        old: product?.table ? `Berlaku ${formatDate(product.table.effectiveFrom, 'id')}` : 'Belum ada',
        new: `Tabel premi baru${effectiveFrom ? `, berlaku ${formatDate(effectiveFrom, 'id')}` : ''}, ${count.toLocaleString('id-ID')} baris`,
        value: count, certain: true, source: src,
      });
      if (item.changes.length) ruleRows(card, item, product, ctx);
      break;
    }
    case 'product_rules':
    case 'field_change':
      ruleRows(card, item, product, ctx);
      break;
    case 'percent_change': {
      const p = item.percent;
      const factor = p ? factorOf(p.asWritten, p.direction) : null;
      const basis = product?.table?.basis ?? null;
      const rounding = basis === 'per_plan' || basis === null ? 'dibulatkan ke rupiah' : `dibulatkan ke ${product?.table?.rateDecimals ?? 0} angka desimal seperti tabel asal`;
      const rule = factor ? `semua tarif × ${factorText(factor)}, ${rounding}` : '';
      percent = p && factor ? { asWritten: p.asWritten.slice(0, 40), direction: p.direction, rule, factor: `${factor.numerator}/${factor.denominator}` } : null;
      card.diff.push({
        key: 'percent', label: 'Perubahan premi',
        old: product?.table ? `Tabel berlaku ${formatDate(product.table.effectiveFrom, 'id')}` : 'Belum ada tabel',
        new: p ? `${p.direction === 'up' ? 'Naik' : 'Turun'} ${p.asWritten}` : null,
        value: null, certain: factor !== null, source: src,
      });
      card.ask({
        kind: 'approve_rule', about: 'percent',
        text: factor
          ? `File ini hanya menyebut premi ${p!.direction === 'up' ? 'naik' : 'turun'} ${p!.asWritten}. Hitung tabel baru dengan aturan: ${rule}? Hasilnya tetap harus lolos 3 contoh uji sebelum aktif.`
          : 'Persentase di file ini tidak terbaca jelas. Unggah tabel barunya.',
        choices: factor
          ? [{ value: 'approve', label: 'Setujui perhitungan' }, { value: 'reject', label: 'Tidak, saya unggah tabel baru' }]
          : [{ value: 'reject', label: 'Mengerti' }],
      });
      break;
    }
    case 'withdrawn_product':
      card.diff.push({ key: 'lifecycle', label: 'Status produk', old: product ? (product.lifecycle === 'withdrawn' ? 'Ditarik' : 'Dijual') : null, new: 'Ditarik', value: 'withdrawn', certain: true, source: src });
      break;
    case 'new_product':
      card.diff.push({ key: 'product', label: 'Produk', old: 'Belum ada', new: asWritten, value: asWritten, certain: true, source: src });
      break;
    case 'illustration':
      card.diff.push({
        key: 'illustration', label: 'Ilustrasi', old: null,
        new: `Ilustrasi resmi${effectiveFrom ? ` tanggal ${formatDate(effectiveFrom, 'id')}` : ''}: dirangkum jadi detail PDF setelah dikonfirmasi`,
        value: null, certain: true, source: src,
      });
      break;
  }

  const summary = item.summary.trim().slice(0, 200) || card.diff[0]?.new || '';
  const open = openQuestions(card.questions).length > 0;
  return {
    companyId,
    productId,
    productAsWritten: asWritten,
    kind: item.kind,
    summary,
    effectiveFrom,
    effectiveTo,
    source: src,
    diff: card.diff,
    table,
    percent,
    newProductName: item.kind === 'new_product' ? (item.newProductName?.trim().slice(0, 120) ?? asWritten) : null,
    questions: card.questions,
    confidence: card.uncertain || !card.diff.every((d) => d.certain) ? 'low' : 'high',
    status: open ? 'needs_answers' : 'ready',
  };
}

/** **The questions a card still waits on**: unanswered, and asked (no condition, or its condition holds). */
export function openQuestions(questions: readonly IntakeQuestion[]): IntakeQuestion[] {
  const answers = new Map(questions.map((q) => [q.id, q.answer]));
  return questions.filter((q) => q.answer === null && (q.when === null || answers.get(q.when.question) === q.when.answer));
}
