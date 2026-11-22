import { readFileSync } from 'node:fs';
import type { CatalogueEntry } from './ai/reader.port';
import type { ReadItem } from './ai/reading-schema';
import {
  effectiveFromOf, rateRowsOf, scaledRows, settledChanges, storedFactor, typedNumber,
} from './intake-apply-plan';
import {
  exactAsWritten, factorOf, factorText, minorUnitsOf, plainText, readingsOf, scaledToRupiah,
} from './intake-numbers';
import { intakeStatusOf, isStale, itemStatusOf } from './intake-status';
import { isRealDay, likelyProducts, openQuestions, understand, type ProductNow, type UnderstandingContext } from './intake-understanding';
import type { IntakeQuestion } from './upload-intake.schema';

/**
 * **P19.15-T3 — *Unggah file*'s rules, without a database** (ADR-0259 §3, §4): numbers only exactly as written, every
 * unclear point a question, a percentage never applied by itself, nothing filled in.
 */

const COMPANY = '66f0000000000000000000c1';
const CERAH = '66f00000000000000000p001';
const MEDICAL = '66f00000000000000000p002';

const catalogue: CatalogueEntry[] = [
  { id: CERAH, companyId: COMPANY, code: 'PRUCERAH', name: 'PRUCerah', syariahName: null, category: 'life', calcType: 'up_premium', payTerms: [{ key: 'y10', label: '10 tahun' }], formulaNames: ['up'], lifecycle: 'active' },
  { id: MEDICAL, companyId: COMPANY, code: 'PRUWELL_MEDICAL', name: 'PRUWell Medical', syariahName: null, category: 'health', calcType: 'plan_priced', payTerms: [], formulaNames: [], lifecycle: 'active' },
];

const cerahNow: ProductNow = {
  id: CERAH, companyId: COMPANY, name: 'PRUCerah', lifecycle: 'active', smokerRated: false, frequencies: ['monthly', 'annual'],
  payTerms: [{ key: 'y10', label: '10 tahun', years: 10 }],
  chipFields: [],
  rules: {
    upStep: 1_000_000_00, upMin: 100_000_000_00, upMax: null, premiumMin: null, premiumMax: null,
    entryAgeMin: 1, entryAgeMax: 60, payTermMaxAge: { y10: 55 }, frequencyFactor: { monthly: 0.0875, quarterly: null, semiannual: null },
  },
  table: { effectiveFrom: '2026-04-01', basis: 'per_mille', rateDecimals: 2 },
};

let ids = 0;
const ctx = (over: Partial<UnderstandingContext> = {}): UnderstandingContext => ({
  companyId: COMPANY,
  companies: [{ id: COMPANY, name: 'Prudential' }],
  catalogue,
  products: new Map([[CERAH, cerahNow]]),
  file: { index: 0, name: 'tarif.pdf', grid: null },
  today: '2026-11-12',
  newId: () => `q${(ids += 1)}`,
  ...over,
});

const source = { page: 2, sheet: null, cell: null, quote: null };
const day = (date: string | null, clear = true) => ({ asWritten: date, date, clear });
const read = (over: Partial<ReadItem>): ReadItem => ({
  kind: 'product_rules', summary: '', company: null, products: [{ asWritten: 'PRUCerah', id: CERAH, clear: true }],
  effectiveFrom: day('2026-12-01'), effectiveTo: day(null, false), source, changes: [], table: null, percent: null,
  newProductName: null, questions: [], ...over,
});
const answered = (questions: IntakeQuestion[], about: string, answer: string) =>
  questions.map((q) => (q.about === about ? { ...q, answer } : q));

describe('P19.15-T3 AC-3 a number is taken only exactly as written (intake-numbers.ts)', () => {
  it('reads every exact reading of a figure and keeps the model’s value only when it is one of them', () => {
    expect(readingsOf('Rp 1.250.000').map(plainText)).toEqual(['1250000']);
    expect(readingsOf('1.320').map(plainText)).toEqual(['1320', '1.32']);
    expect(readingsOf('0,123').map(plainText)).toEqual(['0.123']);
    expect(readingsOf('Rp100 jt').map(plainText)).toEqual(['100000000']);
    expect(readingsOf('1,5 M').map(plainText)).toEqual(['1500000000']);
    expect(exactAsWritten('1.320', '1320')).not.toBeNull();
    expect(exactAsWritten('1.320', '1.32')).not.toBeNull();
  });

  it('refuses a value that is a rounding, a recalculation or an invention of what is written', () => {
    expect(exactAsWritten('1.234,56', '1235')).toBeNull(); // rounded
    expect(exactAsWritten('Rp100 jt', '105000000')).toBeNull(); // "naik 5%" applied
    expect(exactAsWritten('12,35', '12.4')).toBeNull();
    expect(exactAsWritten('sekitar 100', '100')).toBeNull(); // not one figure
    expect(exactAsWritten('1.320', null)).toBeNull(); // two readings and no choice
  });

  it('turns rupiah into minor units, and a percentage into an exact factor, rounded to a rupiah only by the stated rule', () => {
    expect(minorUnitsOf(readingsOf('Rp150 jt')[0])).toBe(15_000_000_000);
    const f = factorOf('5%', 'up')!;
    expect(factorText(f)).toBe('1,05');
    expect(factorText(factorOf('2,5%', 'down')!)).toBe('0,975');
    expect(scaledToRupiah(123_456_78, f)).toBe(129_630_00); // Rp123.456,78 × 1,05 = Rp129.629,619 → Rp129.630, half up
  });
});

describe('P19.15-T3 AC-2 AC-3 every unclear point becomes a question card (intake-understanding.ts)', () => {
  beforeEach(() => { ids = 0; });

  it('makes a rules card old → new with each value’s source when the file is clear', () => {
    const card = understand(read({
      changes: [{ key: 'upMin', payTermKey: null, frequency: null, fieldKey: null, label: 'UP minimum', value: { asWritten: 'Rp150 jt', value: '150000000', certain: true }, source }],
    }), ctx());
    expect(card.status).toBe('ready');
    expect(card.questions).toEqual([]);
    expect(card.diff).toEqual([expect.objectContaining({ key: 'upMin', label: 'UP minimum', old: 'Rp 100 Jt', new: 'Rp 150 Jt', value: 15_000_000_000, certain: true, source: expect.objectContaining({ file: 0, fileName: 'tarif.pdf', page: 2 }) })]);
  });

  it('asks "Ketik angkanya" for a number not read with certainty (a blurry photo), never filling it in', () => {
    const card = understand(read({
      changes: [{ key: 'upMin', payTermKey: null, frequency: null, fieldKey: null, label: 'UP minimum', value: { asWritten: 'Rp1?0 jt', value: '150000000', certain: false }, source }],
    }), ctx());
    expect(card.status).toBe('needs_answers');
    expect(card.diff[0]).toMatchObject({ new: null, value: null, certain: false });
    expect(card.questions[0]).toMatchObject({ kind: 'type_number', about: 'diff:upMin' });
    expect(card.questions[0].text).toContain('Ketik angkanya');
  });

  it('asks which product, which company and from when when the file does not say it clearly', () => {
    const card = understand(read({
      company: { asWritten: 'Pru', id: COMPANY, clear: false },
      products: [{ asWritten: 'Cerah', id: CERAH, clear: false }],
      effectiveFrom: day(null, false),
    }), ctx({ companyId: null }));
    expect(card.questions.map((q) => q.kind)).toEqual(['company', 'product', 'date']);
    expect(card.questions[1].text).toBe('File ini untuk produk apa?');
    expect(card.questions[1].choices[0]).toEqual({ value: CERAH, label: 'PRUCerah' });
    expect(card.questions[2].text).toBe('Tanggal berlaku tidak ditemukan. Mulai kapan?');
    expect(card.companyId).toBeNull();
  });

  it('asks about a product the catalogue does not have — new, a new name of an old one, or ignore — and its code when new', () => {
    const card = understand(read({ kind: 'new_product', products: [{ asWritten: 'PRU New X', id: null, clear: false }], newProductName: 'PRU New X' }), ctx());
    const [what, code] = card.questions;
    expect(what.text).toBe('Produk "PRU New X" tidak ada di katalog: produk baru, nama baru dari produk lama, atau abaikan?');
    expect(what.choices.map((c) => c.value)).toEqual(expect.arrayContaining(['new', 'ignore']));
    expect(code).toMatchObject({ kind: 'text', when: { question: what.id, answer: 'new' } });
    expect(openQuestions(card.questions)).toEqual([what]);
    expect(openQuestions(answered(card.questions, 'product', 'new')).map((q) => q.about)).toEqual(['new:code', 'new:category', 'new:channel']);
  });

  it('makes "naik 5%" an approval request with its rule, never a table', () => {
    const card = understand(read({ kind: 'percent_change', percent: { asWritten: '5%', direction: 'up', appliesTo: 'semua tarif' } }), ctx());
    expect(card.table).toBeNull();
    expect(card.percent).toEqual({ asWritten: '5%', direction: 'up', rule: 'semua tarif × 1,05, dibulatkan ke 2 angka desimal seperti tabel asal', factor: '105/100' });
    expect(card.questions[0]).toMatchObject({ kind: 'approve_rule', choices: [{ value: 'approve', label: 'Setujui perhitungan' }, { value: 'reject', label: 'Tidak, saya unggah tabel baru' }] });
    expect(card.status).toBe('needs_answers');
  });

  it('asks what an unclear column means, and a "ketik angkanya" for each blurry cell of a photographed table', () => {
    const card = understand(read({
      kind: 'premium_table', changes: [],
      table: {
        sheet: null, headerRow: null, firstRow: null, lastRow: null, basis: 'per_mille', currency: 'IDR', gaps: ['Usia 61–65 tidak ada di tabel'],
        columns: [
          { column: 'Usia', header: 'Usia', meaning: 'age', gender: null, smoker: null, plan: null, payTermKey: null, clear: true, question: null },
          { column: 'Rate A', header: 'Rate A', meaning: 'unclear', gender: null, smoker: null, plan: null, payTermKey: null, clear: false, question: 'Kolom \'Rate A\' ini tarif laki-laki atau perempuan?' },
        ],
        rows: [
          { source, cells: [{ column: 'Usia', value: { asWritten: '46', value: '46', certain: true } }, { column: 'Rate A', value: { asWritten: '12,35', value: '12.35', certain: true } }] },
          { source, cells: [{ column: 'Usia', value: { asWritten: '47', value: '47', certain: true } }, { column: 'Rate A', value: { asWritten: '1?,40', value: '12.40', certain: false } }] },
        ],
      },
    }), ctx());
    expect(card.questions.map((q) => [q.kind, q.text])).toEqual([
      ['column', 'Kolom \'Rate A\' ini tarif laki-laki atau perempuan?'],
      ['type_number', 'Angka di baris usia 47, kolom "Rate A" tidak terbaca jelas. Ketik angkanya.'],
    ]);
    expect(card.table?.gaps).toEqual(['Usia 61–65 tidak ada di tabel']);
    expect(card.diff[0]).toMatchObject({ key: 'table', old: 'Berlaku 1 Apr 2026', new: 'Tabel premi baru, berlaku 1 Des 2026, 2 baris' });

    // Answered: the column is men's, the blurry cell typed. Rows are the file's; the gap stays a gap.
    let questions = answered(card.questions, 'column:Rate A', 'rate:male');
    questions = answered(questions, 'cell:1:Rate A', '12,4');
    const { rows, skipped } = rateRowsOf({ table: card.table, questions }, cerahNow.payTerms);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({ age: 46, gender: 'male', rate: 12.35, basis: 'per_mille', currency: 'IDR' }),
      expect.objectContaining({ age: 47, gender: 'male', rate: 12.4 }),
    ]);
  });

  it('reads a workbook’s cells from the grid itself, the model naming only the columns', () => {
    const grid = [{ name: 'Tarif', rows: [
      { row: 1, cells: [{ col: 'A', text: 'Usia' }, { col: 'B', text: 'L' }, { col: 'C', text: 'P' }] },
      { row: 2, cells: [{ col: 'A', text: '30' }, { col: 'B', text: '1.25' }, { col: 'C', text: '1.1' }] },
      { row: 3, cells: [{ col: 'A', text: '31' }, { col: 'B', text: 'n/a' }, { col: 'C', text: '1.15' }] },
    ] }];
    const card = understand(read({
      kind: 'premium_table',
      table: {
        sheet: 'Tarif', headerRow: 1, firstRow: 2, lastRow: 3, basis: 'per_mille', currency: 'IDR', gaps: [],
        columns: [
          { column: 'A', header: 'Usia', meaning: 'age', gender: null, smoker: null, plan: null, payTermKey: null, clear: true, question: null },
          { column: 'B', header: 'L', meaning: 'rate', gender: 'male', smoker: null, plan: null, payTermKey: null, clear: true, question: null },
          { column: 'C', header: 'P', meaning: 'rate', gender: 'female', smoker: null, plan: null, payTermKey: null, clear: true, question: null },
        ],
        // A model that transcribed rows anyway is ignored for a grid: the cells are read here.
        rows: [{ source, cells: [{ column: 'B', value: { asWritten: '9.99', value: '9.99', certain: true } }] }],
      },
    }), ctx({ file: { index: 0, name: 'tarif.xlsx', grid } }));
    expect(card.questions).toEqual([]);
    const { rows, skipped } = rateRowsOf(card, []);
    // `n/a` is no rate: skipped and missing, never filled from a neighbour.
    expect(skipped).toBe(1);
    expect(rows.map((r) => [r.age, r.gender, r.rate])).toEqual([[30, 'male', 1.25], [30, 'female', 1.1], [31, 'female', 1.15]]);
  });

  it('ranks the likely products by name, code or syariah name', () => {
    expect(likelyProducts('PRU Cerah', catalogue, COMPANY)[0].id).toBe(CERAH);
    expect(likelyProducts('pruwell medical', catalogue, COMPANY)[0].id).toBe(MEDICAL);
  });

  it('knows a real day', () => {
    expect(isRealDay('2026-12-01')).toBe(true);
    expect(isRealDay('2026-02-30')).toBe(false);
    expect(isRealDay('1 Des 2026')).toBe(false);
  });
});

describe('P19.15-T3 AC-3 AC-4 what a confirmed card applies (intake-apply-plan.ts)', () => {
  it('settles rules from their values and typed answers, a pay term chosen where the file named none', () => {
    const { rules, fields } = settledChanges({
      diff: [
        { key: 'upMin', label: 'UP minimum', old: null, new: 'Rp 150 Jt', value: 15_000_000_000, certain: true, source: {} as never },
        { key: 'premiumMin', label: 'Premi minimum', old: null, new: null, value: null, certain: false, source: {} as never },
        { key: 'payTermMaxAge:?', label: 'x', old: null, new: '60 tahun', value: 60, certain: true, source: {} as never },
        { key: 'name', label: 'Nama produk', old: 'PRUCerah', new: 'PRUCerah Plus', value: 'PRUCerah Plus', certain: true, source: {} as never },
      ],
      questions: [
        { id: 'a', kind: 'type_number', text: '', choices: [], about: 'diff:premiumMin', when: null, answer: '1.200.000', answeredBy: null, answeredAt: null },
        { id: 'b', kind: 'choice', text: '', choices: [], about: 'payterm:2', when: null, answer: 'y10', answeredBy: null, answeredAt: null },
      ],
    });
    expect(rules).toEqual({ upMin: 15_000_000_000, premiumMin: 120_000_000, payTermMaxAge: { y10: 60 } });
    expect(fields).toEqual({ name: 'PRUCerah Plus' });
  });

  it('scales a table only by the approved rule: premiums to a whole rupiah, rates to their own decimals', () => {
    const f = storedFactor('105/100')!;
    const rows = scaledRows([
      { age: 30, gender: 'male', smoker: null, plan: 'Silver', payTerm: null, currency: 'IDR', frequency: null, basis: 'per_plan', rate: 1_234_567_00, bandMin: null, bandMax: null },
      { age: 30, gender: 'male', smoker: null, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille', rate: 12.35, bandMin: null, bandMax: null },
    ], f);
    expect(rows[0].rate).toBe(1_296_295_00); // 1.234.567 × 1,05 = 1.296.295,35 → Rp1.296.295
    expect(rows[1].rate).toBe(12.97); // 12,35 × 1,05 = 12,9675 → 12,97
  });

  it('reads a typed number as Indonesians type it, and the date from the file or its answer', () => {
    expect(plainText(typedNumber('1.250.000')!)).toBe('1250000');
    expect(plainText(typedNumber('0,123')!)).toBe('0.123');
    expect(typedNumber('dua belas')).toBeNull();
    expect(effectiveFromOf({ effectiveFrom: null, questions: [{ id: 'x', kind: 'date', text: '', choices: [], about: 'effectiveFrom', when: null, answer: '2026-12-01', answeredBy: null, answeredAt: null }] })).toBe('2026-12-01');
  });
});

describe('P19.15-T3 an upload’s state follows its cards (intake-status.ts)', () => {
  it('reads reading, failed, needs_answers, ready, applied and rejected', () => {
    const read1 = [{ status: 'read' as const }];
    expect(intakeStatusOf(true, read1, [])).toBe('reading');
    expect(intakeStatusOf(false, [{ status: 'failed' }], [])).toBe('failed');
    expect(intakeStatusOf(false, read1, [])).toBe('rejected');
    expect(intakeStatusOf(false, read1, [{ status: 'needs_answers' }, { status: 'ready' }])).toBe('needs_answers');
    expect(intakeStatusOf(false, read1, [{ status: 'ready' }, { status: 'applied' }])).toBe('ready');
    expect(intakeStatusOf(false, read1, [{ status: 'rejected' }, { status: 'applied' }])).toBe('applied');
    expect(intakeStatusOf(false, read1, [{ status: 'rejected' }])).toBe('rejected');
    expect(itemStatusOf([], 'applied')).toBe('applied');
  });

  it('reports a reading older than 15 minutes as stale', () => {
    const start = new Date('2026-11-12T03:00:00Z');
    expect(isStale(start, new Date('2026-11-12T03:15:00Z'))).toBe(false);
    expect(isStale(start, new Date('2026-11-12T03:15:01Z'))).toBe(true);
  });
});

describe('P19.15-T3 the prompt states the hard rules (ai/reading-prompts.ts)', () => {
  it('tells Claude the numbers rules, the percentage rule and to ask rather than decide', () => {
    const text = readFileSync(`${__dirname}/ai/reading-prompts.ts`, 'utf8');
    expect(text).toContain('Take a number ONLY exactly as it is written in the file');
    expect(text).toContain('"premi naik 5%" is NOT a new table');
    expect(text).toContain('Never decide the company, the product or the effective date');
    expect(text).toContain('EVERY AMOUNT IS A FORMULA');
  });
});
