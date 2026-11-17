import { PRODUCT_DATA } from '@/domain/constants';
import type { EngineRow } from './premium-engine';
import {
  agesOf, amountMinorOf, basisOf, fingerprintOf, gapsOf, ketentuanRows, mappingFault, norm, parseNumber, payTermOf,
  rangesOf, rawFromRows, rawFromSheets, rowsFromRaw, rulesFromKetentuan, suggestMapping, templateHeader, type RawTable,
  type TableFacts,
} from './rate-file';
import type { RateRules } from './rate-table.schema';

const FACTS: TableFacts = {
  calcType: 'up_premium',
  currencies: ['IDR'],
  smokerRated: true,
  plans: [],
  payTerms: [
    { key: 'y5', label: '5 tahun', years: 5, toAge: null, single: false, maxEntryAge: 60 },
    { key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 60 },
    { key: 'to60', label: 's/d usia 60', years: null, toAge: 60, single: false, maxEntryAge: 50 },
    { key: 'single', label: 'Sekali bayar', years: null, toAge: null, single: true, maxEntryAge: 60 },
  ],
  entryAge: { min: 30, max: 32 },
};
const RULES: RateRules = {
  upStep: null, upMin: null, upMax: null, premiumMin: null, premiumMax: null, entryAgeMin: null, entryAgeMax: null, payTermMaxAge: {},
};
const raw = (header: string[], rows: string[][], ketentuan: string[][] | null = null): RawTable => ({ header, rows, firstRow: 2, ketentuan });
const row = (over: Partial<EngineRow> = {}): EngineRow => ({
  age: 30, gender: 'male', smoker: false, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille',
  rate: 1, bandMin: null, bandMax: null, ...over,
});

describe('P19.15-T1 AC-1 a premium table’s file, read exactly as written (ADR-0258 §3)', () => {
  describe('Cocokkan kolom: the columns suggested', () => {
    it('normalises a name', () => {
      expect(norm('Tarif per 1.000 UP')).toBe('tarif per 1000 up');
      expect(norm('  Jenis_Kelamin ')).toBe('jeniskelamin');
    });

    it('P19.15-T1 AC-1 suggests the template’s names exactly, others by what they contain, each role once', () => {
      expect(suggestMapping(['Usia', 'Jenis kelamin', 'Merokok', 'Masa bayar', 'Tarif per 1.000 UP', 'Catatan', ''])).toEqual({
        Usia: 'age', 'Jenis kelamin': 'gender', Merokok: 'smoker', 'Masa bayar': 'payTerm', 'Tarif per 1.000 UP': 'rate',
        Catatan: 'ignore', '': 'ignore',
      });
      expect(suggestMapping(['Umur Tertanggung', 'Premi Tahunan (Rp)', 'Plan', 'Plan lain'])).toEqual({
        'Umur Tertanggung': 'age', 'Premi Tahunan (Rp)': 'premium', Plan: 'plan', 'Plan lain': 'ignore',
      });
    });

    it('a basis from the columns', () => {
      expect(basisOf({ a: 'rate' })).toBe('per_mille');
      expect(basisOf({ a: 'rate', b: 'bandMin', c: 'bandMax' })).toBe('per_band');
      expect(basisOf({ a: 'premium' })).toBe('per_plan');
      expect(basisOf({ a: 'age' })).toBeNull();
    });

    it('a mapping’s faults: an unknown column or role, a role twice, no price or two, half a band', () => {
      const h = ['A', 'B', 'C'];
      expect(mappingFault(h, { Z: 'age' })).toEqual({ kind: 'columnUnknown', column: 'Z' });
      expect(mappingFault(h, { A: 'nope' })).toEqual({ kind: 'role', column: 'A' });
      expect(mappingFault(h, { A: 'age', B: 'age' })).toEqual({ kind: 'roleTwice', role: 'age' });
      expect(mappingFault(h, { A: 'age', B: 'ignore', C: 'ignore' })).toEqual({ kind: 'rateColumn' });
      expect(mappingFault(h, { A: 'rate', B: 'premium' })).toEqual({ kind: 'rateColumn' });
      expect(mappingFault(h, { A: 'rate', B: 'bandMin' })).toEqual({ kind: 'bandColumns' });
      expect(mappingFault(h, { A: 'premium', B: 'bandMin', C: 'bandMax' })).toEqual({ kind: 'bandColumns' });
      expect(mappingFault(h, { A: 'rate', B: 'bandMin', C: 'bandMax' })).toBeNull();
    });
  });

  describe('the file’s sheets and rows', () => {
    it('the Data sheet, else the first that is not Ketentuan; Ketentuan beside it', () => {
      const data = { sheet: 'Data', rows: [['Usia', 'Tarif'], ['30', '1']] };
      const ketentuan = { sheet: 'Ketentuan', rows: [['Ketentuan', 'Nilai'], [], ['UP minimum', '100000000']] };
      expect(rawFromSheets([ketentuan, data])).toEqual({
        header: ['Usia', 'Tarif'], rows: [['30', '1']], firstRow: 2, ketentuan: [['Ketentuan', 'Nilai'], ['UP minimum', '100000000']],
      });
      expect(rawFromSheets([{ sheet: 'Tarif 2026', rows: [[], ['Usia'], ['31']] }])).toMatchObject({ header: ['Usia'], firstRow: 3, ketentuan: null });
      expect(rawFromSheets([ketentuan])).toBeNull();
      expect(rawFromSheets([{ sheet: 'Data', rows: [[''], []] }])).toBeNull();
    });

    it('a CSV’s records, the header first, trailing empty rows dropped, rows numbered as the file numbers them', () => {
      expect(rawFromRows([['Usia', 'Tarif'], ['30', '1'], ['', '']], [1, 2, 5])).toEqual({
        header: ['Usia', 'Tarif'], rows: [['30', '1']], firstRow: 2, ketentuan: null,
      });
      expect(rawFromRows([])).toBeNull();
    });

    it('P19.15-T1 AC-1 a number as typed in Indonesia or elsewhere', () => {
      expect(parseNumber('12,35', false)).toBe(12.35);
      expect(parseNumber('12.35', false)).toBe(12.35);
      expect(parseNumber('1.500', false)).toBe(1.5);
      expect(parseNumber('1.500', true)).toBe(1500);
      expect(parseNumber('4.500.000', true)).toBe(4_500_000);
      expect(parseNumber('4,500,000', true)).toBe(4_500_000);
      expect(parseNumber('1.234,5', true)).toBe(1234.5);
      expect(parseNumber('1,234.5', true)).toBe(1234.5);
      expect(parseNumber('Rp 100 jt', true)).toBe(100_000_000);
      expect(parseNumber('2,5 M', true)).toBe(2_500_000_000);
      expect(parseNumber('500rb', true)).toBe(500_000);
      expect(parseNumber('', true)).toBeNull();
      expect(parseNumber('-', true)).toBeNull();
      expect(parseNumber('abc', true)).toBeNaN();
      expect(amountMinorOf('Rp4.500.000')).toBe(450_000_000);
      expect(amountMinorOf('')).toBeNull();
      expect(amountMinorOf('x')).toBeNaN();
    });

    it('a pay term by key, label, years, age, or single', () => {
      expect(payTermOf('y10', FACTS.payTerms)).toBe('y10');
      expect(payTermOf('10 Tahun', FACTS.payTerms)).toBe('y10');
      expect(payTermOf('5', FACTS.payTerms)).toBe('y5');
      expect(payTermOf('5 th', FACTS.payTerms)).toBe('y5');
      expect(payTermOf('sampai usia 60', FACTS.payTerms)).toBe('to60');
      expect(payTermOf('Sekaligus', FACTS.payTerms)).toBe('single');
      expect(payTermOf('', FACTS.payTerms)).toBeNull();
      expect(payTermOf('15 tahun', FACTS.payTerms)).toBeUndefined();
      expect(payTermOf('s/d usia 99', FACTS.payTerms)).toBeUndefined();
      expect(payTermOf('kapan saja', FACTS.payTerms)).toBeUndefined();
    });

    it('an age, a range of ages, or any', () => {
      expect(agesOf('45')).toEqual([45]);
      expect(agesOf('61-63')).toEqual([61, 62, 63]);
      expect(agesOf('61 s/d 62')).toEqual([61, 62]);
      expect(agesOf('')).toBeNull();
      expect(agesOf('Semua')).toBeNull();
      expect(agesOf('121')).toBeUndefined();
      expect(agesOf('65-61')).toBeUndefined();
      expect(agesOf('lima')).toBeUndefined();
    });
  });

  describe('P19.15-T1 AC-1 the rows, under the columns confirmed', () => {
    const header = ['Usia', 'Jenis kelamin', 'Merokok', 'Masa bayar', 'Tarif per 1.000 UP'];
    const map = suggestMapping(header);

    it('reads every cell, a range of ages one row each', () => {
      const out = rowsFromRaw(raw(header, [['30-31', 'L', 'Tidak', '10 tahun', '12,35'], ['30', 'P', 'Ya', 'y5', '9.1'], ['', '', '', '', '']]), map, FACTS);
      expect(out.problems).toEqual([]);
      expect(out.rows).toEqual([
        { age: 30, gender: 'male', smoker: false, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille', rate: 12.35, bandMin: null, bandMax: null },
        { age: 31, gender: 'male', smoker: false, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille', rate: 12.35, bandMin: null, bandMax: null },
        { age: 30, gender: 'female', smoker: true, plan: null, payTerm: 'y5', currency: 'IDR', frequency: null, basis: 'per_mille', rate: 9.1, bandMin: null, bandMax: null },
      ]);
    });

    it('P19.15-T1 AC-1 never guesses: every unreadable cell is a problem with its row and column', () => {
      const out = rowsFromRaw(raw(header, [
        ['tiga puluh', 'X', 'mungkin', '15 tahun', 'abc'],
        ['30', 'L', 'Tidak', '10 tahun', '1'],
        ['30', 'L', 'Tidak', '10 tahun', '2'],
      ]), map, FACTS);
      expect(out.problems.map((p) => p.reason)).toEqual(['age', 'gender', 'smoker', 'payTerm', 'number', 'duplicate']);
      expect(out.problems[0]).toEqual({ row: 2, column: 'Usia', value: 'tiga puluh', reason: 'age' });
      expect(out.problems[5].row).toBe(4);
      expect(out.rows).toHaveLength(1);
    });

    it('a plan, a currency and a Cara bayar named in the file; an unknown one refused', () => {
      const facts = { ...FACTS, plans: ['Silver', 'Gold'], currencies: ['IDR', 'USD'] as ('IDR' | 'USD')[] };
      const h = ['Usia', 'Plan', 'Mata uang', 'Cara bayar', 'Premi tahunan'];
      const out = rowsFromRaw(raw(h, [
        ['30', 'gold', 'USD', 'Bulanan', '1.200,50'],
        ['30', 'Silver', '', '', '4.800.000'],
        ['30', 'Platinum', 'EUR', 'mingguan', '0'],
      ]), suggestMapping(h), facts);
      expect(out.rows.map((r) => [r.plan, r.currency, r.frequency, r.basis, r.rate])).toEqual([
        ['Gold', 'USD', 'monthly', 'per_plan', 120_050], ['Silver', 'IDR', null, 'per_plan', 480_000_000],
      ]);
      expect(out.problems.map((p) => p.reason)).toEqual(['plan', 'currency', 'frequency', 'number']);
    });

    it('a band: both ends, in order', () => {
      const h = ['Usia', 'UP dari', 'UP sampai', 'Tarif'];
      const m = { Usia: 'age', 'UP dari': 'bandMin', 'UP sampai': 'bandMax', Tarif: 'rate' } as const;
      const out = rowsFromRaw(raw(h, [['30', '100 jt', '499 jt', '13'], ['30', 'x', '1', '1'], ['30', '1', '', '1'], ['30', '9', '1', '1']]), m, FACTS);
      expect(out.rows[0]).toMatchObject({ basis: 'per_band', bandMin: 10_000_000_000, bandMax: 49_900_000_000 });
      expect(out.problems.map((p) => p.reason)).toEqual(['number', 'number', 'band']);
    });

    it('a rate above 1.000 per mille, or below zero, is no rate', () => {
      expect(rowsFromRaw(raw(['Tarif'], [['1001']]), { Tarif: 'rate' }, FACTS).problems[0].reason).toBe('number');
    });

    it('counts every problem, answering at most PROBLEMS_MAX', () => {
      const many = Array.from({ length: PRODUCT_DATA.PROBLEMS_MAX + 5 }, () => ['x', '1']);
      const out = rowsFromRaw(raw(['Usia', 'Tarif'], many), { Usia: 'age', Tarif: 'rate' }, FACTS);
      expect(out.problemCount).toBe(PRODUCT_DATA.PROBLEMS_MAX + 5);
      expect(out.problems).toHaveLength(PRODUCT_DATA.PROBLEMS_MAX);
    });

    it('ten thousand rows at most, ranges counted', () => {
      const out = rowsFromRaw(raw(['Usia', 'Tarif'], Array.from({ length: 101 }, (_, i) => [`0-99`, String(i)])), { Usia: 'age', Tarif: 'rate' }, { ...FACTS, payTerms: [] });
      expect(out.problems.some((p) => p.reason === 'duplicate')).toBe(true);
      const big = Array.from({ length: 101 }, (_, i) => ['0-99', String(i)]);
      const plans = { ...FACTS, plans: Array.from({ length: 101 }, (_, i) => `P${i}`) };
      const wide = rowsFromRaw(raw(['Usia', 'Tarif', 'Plan'], big.map((r, i) => [...r, `P${i}`])), { Usia: 'age', Tarif: 'rate', Plan: 'plan' }, plans);
      expect(wide.rows.length).toBe(10_100);
      expect(wide.problems.at(-1)?.reason).toBe('range');
    });
  });

  describe('P19.15-T1 AC-4 Ketentuan: the rules, read and never guessed', () => {
    it('reads each rule by its label; an empty value is no limit', () => {
      const read = rulesFromKetentuan([
        ['Ketentuan', 'Nilai'],
        ['UP kelipatan', '1.000.000'],
        ['UP minimum', '100 jt'],
        ['UP maksimum', ''],
        ['Premi minimum per tahun', '1.500.000'],
        ['Faktor bulanan', '0,09'],
        ['Faktor tahunan', ''],
        ['Usia masuk minimum', '1'],
        ['Usia masuk maksimum', '60'],
        ['Usia masuk maks. 15 tahun', ''],
        ['Usia masuk maks. 10 tahun', '55'],
        [],
      ], FACTS);
      expect(read.problems).toEqual([]);
      expect(read.rules).toEqual({
        upStep: 100_000_000, upMin: 10_000_000_000, upMax: null, premiumMin: 150_000_000, entryAgeMin: 1, entryAgeMax: 60,
        payTermMaxAge: { y10: 55 },
      });
      expect(read.frequencies).toEqual({ monthly: 0.09, annual: null });
    });

    it('a label it does not have, a value that is no number, a zero step, a factor out of range: problems', () => {
      const read = rulesFromKetentuan([
        ['Diskon', '5%'], ['UP minimum', 'banyak'], ['UP kelipatan', '0'], ['Faktor bulanan', '2'], ['Usia masuk minimum', 'x'],
        ['Usia masuk maks. 99 tahun', '50'],
      ], FACTS);
      expect(read.problems.map((p) => p.label)).toEqual([
        'Diskon', 'UP minimum', 'UP kelipatan', 'Faktor bulanan', 'Usia masuk minimum', 'Usia masuk maks. 99 tahun',
      ]);
      expect(read.rules).toEqual({});
    });

    it('the template’s Ketentuan, filled with the rules it replaces', () => {
      const rows = ketentuanRows(FACTS, { ...RULES, upStep: 100_000_000, entryAgeMin: 1, payTermMaxAge: { y5: 60 } }, {
        monthly: 0.09, quarterly: null, semiannual: null, annual: 1,
      });
      expect(rows[0]).toEqual(['Ketentuan', 'Nilai']);
      expect(rows).toContainEqual(['UP kelipatan', '1000000']);
      expect(rows).toContainEqual(['Faktor bulanan', '0.09']);
      expect(rows).toContainEqual(['Usia masuk minimum', '1']);
      expect(rows).toContainEqual(['Usia masuk maksimum', '']);
      expect(rows).toContainEqual(['Usia masuk maks. 5 tahun', '60']);
      expect(rows).toContainEqual(['Usia masuk maks. 10 tahun', '']);
      // Read back, it says the same.
      expect(rulesFromKetentuan(rows, FACTS).rules).toMatchObject({ upStep: 100_000_000, entryAgeMin: 1, payTermMaxAge: { y5: 60 } });
      expect(ketentuanRows({ ...FACTS, payTerms: [FACTS.payTerms[3]] }, RULES, { monthly: null, quarterly: null, semiannual: null, annual: null }))
        .not.toContainEqual(['Usia masuk maks. Sekali bayar', '']);
    });

    it('P19.15-T1 AC-1 the template’s columns, the product’s own', () => {
      expect(templateHeader(FACTS)).toEqual(['Usia', 'Jenis kelamin', 'Merokok', 'Masa bayar', 'Tarif per 1.000 UP']);
      expect(templateHeader({ ...FACTS, calcType: 'plan_priced', smokerRated: false, plans: ['A'], payTerms: [], currencies: ['IDR', 'USD'] }))
        .toEqual(['Usia', 'Jenis kelamin', 'Plan', 'Mata uang', 'Premi tahunan']);
    });
  });

  describe('P19.15-T1 AC-1 Cek kelengkapan: every gap, never blocking', () => {
    it('consecutive ages as ranges', () => {
      expect(rangesOf([63, 61, 62, 70, 61])).toEqual([[61, 63], [70, 70]]);
    });

    it('no rows, no gaps', () => {
      expect(gapsOf([], FACTS, RULES)).toEqual({ gaps: [], count: 0 });
    });

    it('a smoker rate where it matters, a gender, a pay term, an age everywhere and for one combination', () => {
      const facts = { ...FACTS, payTerms: FACTS.payTerms.slice(0, 2) };
      const rows = [
        row({ age: 30 }), row({ age: 31 }), row({ age: 30, payTerm: 'y5' }),
      ];
      const { gaps, count } = gapsOf(rows, facts, RULES);
      expect(gaps).toEqual([
        { kind: 'smoker' },
        { kind: 'gender', gender: 'female' },
        { kind: 'ages', from: 32, to: 32 },
        { kind: 'ages', from: 31, to: 31, plan: null, payTerm: 'y5', payTermLabel: '5 tahun', gender: 'male', smoker: false },
      ]);
      expect(count).toBe(4);
    });

    it('a currency, a plan, a pay term, a plan with a pay term', () => {
      const facts: TableFacts = { ...FACTS, smokerRated: false, plans: ['Silver', 'Gold', 'MAX'], currencies: ['IDR', 'USD'], payTerms: FACTS.payTerms.slice(0, 3), entryAge: null };
      const rows = [
        row({ plan: 'Silver', payTerm: 'y5', gender: null }), row({ plan: 'Silver', payTerm: 'y10', gender: null }),
        row({ plan: 'MAX', payTerm: 'y5', gender: null }),
      ];
      const kinds = gapsOf(rows, facts, RULES).gaps.map((g) => [g.kind, g.plan ?? g.currency ?? g.payTerm ?? null]);
      expect(kinds).toEqual([
        ['currency', 'USD'], ['plan', 'Gold'], ['payTerm', 'to60'], ['combination', 'MAX'],
      ]);
    });

    it('rows for any age cover every age; the rules’ entry ages win over the product’s', () => {
      expect(gapsOf([row({ age: null, smoker: null, gender: null })], { ...FACTS, smokerRated: false, payTerms: [] }, RULES).gaps).toEqual([]);
      const { gaps } = gapsOf([row({ age: 30, smoker: null, payTerm: null, gender: null })], { ...FACTS, smokerRated: false, payTerms: [] }, { ...RULES, entryAgeMin: 30, entryAgeMax: 31 });
      expect(gaps).toEqual([{ kind: 'ages', from: 31, to: 31 }]);
    });

    it('a pay term’s own maximum entry age bounds what it is expected to price', () => {
      const facts = { ...FACTS, smokerRated: false, payTerms: [FACTS.payTerms[2]], entryAge: { min: 49, max: 52 } };
      const rows = [49, 50, 51, 52].map((age) => row({ age, gender: null, payTerm: age <= 50 ? 'to60' : 'y10' }));
      const { gaps } = gapsOf(rows.filter((r) => r.payTerm === 'to60'), facts, RULES);
      expect(gaps).toEqual([{ kind: 'ages', from: 51, to: 52 }]);
      expect(gapsOf([...rows.filter((r) => r.payTerm === 'to60'), row({ age: 51, gender: null, payTerm: null }), row({ age: 52, gender: null, payTerm: null })], facts, RULES).gaps).toEqual([]);
    });

    it('answers at most GAPS_MAX, counting the rest', () => {
      const facts = { ...FACTS, smokerRated: false, payTerms: [], entryAge: { min: 0, max: 120 } };
      const rows = Array.from({ length: 61 }, (_, i) => row({ age: i * 2, payTerm: null, gender: null }));
      const { gaps, count } = gapsOf(rows, facts, RULES);
      expect(gaps).toHaveLength(PRODUCT_DATA.GAPS_MAX);
      expect(count).toBe(60);
    });
  });

  it('P19.15-T4 AC-1 a fingerprint moves with what the rows mean, not with a label', () => {
    const base = fingerprintOf(FACTS);
    expect(fingerprintOf({ ...FACTS, payTerms: FACTS.payTerms.map((t) => ({ ...t, label: `${t.label}!` })) })).toBe(base);
    expect(fingerprintOf({ ...FACTS, smokerRated: false })).not.toBe(base);
    expect(fingerprintOf({ ...FACTS, plans: ['A'] })).not.toBe(base);
  });
});
