import {
  LEAD_AGE, PDF_DETAIL_BLOCKS, PROPOSAL, PROPOSAL_FIELD_TYPES, PROPOSAL_RESERVED_KEYS, PROPOSAL_TEXT_MAX,
  PROPOSAL_TYPE_LABEL_BY_CATEGORY, defaultInsuredFor,
} from '@/domain/constants';
import { english, indonesian } from '../../../test/i18n';
import {
  checkProposalSettings, effectiveProposalWordsOf, insuredOf, readFaq, readOfficePlanHighlights, typeLabelOf,
  type ProductFacts,
} from './proposal-fields';
import { PROPOSAL_FIELDS_REFUSALS } from './proposal-fields.messages';

const FACTS: ProductFacts = { channel: 'conventional', category: 'health', currencies: ['IDR'], today: '2026-11-05' };

const chips = (key: string, labels: string[], over: Record<string, unknown> = {}) => ({
  key, label: key.toUpperCase(), type: 'chips', options: labels.map((label) => ({ label })), default: labels[0], ...over,
});
const money = (key: string, over: Record<string, unknown> = {}) => ({ key, label: key.toUpperCase(), type: 'money', ...over });

/** The refusal a check throws, as `{ code, field }`. */
function refusal(run: () => unknown): { code: string; field: string } {
  try {
    run();
  } catch (err) {
    const e = err as { code: string; details: { field: string } };
    return { code: e.code, field: e.details.field };
  }
  throw new Error('not refused');
}
const check = (input: Record<string, unknown>, facts: Partial<ProductFacts> = {}) =>
  checkProposalSettings(input, {}, { ...FACTS, ...facts });

/**
 * **P19.7-T1 AC-2, AC-3 — a product's proposal fields, and every bound a save checks** (ADR-0225 §1, §2, §4;
 * `metrics-and-definitions.md` §B.34). Each refusal is `400 VALIDATION_FAILED` with `details.field` naming the path.
 */
describe('P19.7-T1 the catalogue’s proposal fields (proposal-fields.ts)', () => {
  it('P19.7-T1 AC-2 pins the bounds of §B.34', () => {
    // T1's bounds; T2's own (ITEMS_MAX and the rest) are pinned with the whole object by `domain/constants/proposal.spec.ts`.
    expect(PROPOSAL).toMatchObject({
      FIELDS_MAX: 8, SUMMARY_FIELDS_MAX: 4, CHIP_OPTIONS_MAX: 8, QUICK_AMOUNTS_MAX: 4, PLAN_OPTIONS_MAX: 8,
      PLAN_HIGHLIGHTS_MAX: 4, FAQ_MAX: 20, PDF_DETAIL_ROWS_MAX: 8, EXCLUSIONS_MAX: 3, FORMULA_MAX_LENGTH: 120,
      PAYMENT_YEARS_MAX: 99,
    });
    expect(PROPOSAL_TEXT_MAX).toEqual({
      FIELD_LABEL: 60, OPTION_LABEL: 40, PLAN_NAME: 40, HIGHLIGHT_LABEL: 30, HIGHLIGHT_VALUE: 40, FAQ_QUESTION: 200,
      FAQ_ANSWER: 1000, DETAIL_LABEL: 80, DETAIL_NOTE: 40, SOURCE_FILE: 120, SYARIAH_NAME: 80, TYPE_LABEL: 30,
    });
    expect(LEAD_AGE).toEqual({ MIN: 1, MAX: 100 });
    expect(PROPOSAL_FIELD_TYPES).toEqual(['chips', 'money', 'fixed']);
    expect(PDF_DETAIL_BLOCKS).toEqual(['manfaat', 'jadwal', 'masa', 'pengecualian', 'nilai_tunai']);
    expect(PROPOSAL_RESERVED_KEYS).toEqual(['insured', 'premium']);
  });

  it('P19.7-T1 AC-2 reads the defaults where nothing was set: the type label by category, Anak for education', () => {
    expect(PROPOSAL_TYPE_LABEL_BY_CATEGORY).toEqual({
      life: 'JIWA', health: 'KESEHATAN', ci: 'PENYAKIT KRITIS', education: 'DANA PENDIDIKAN', investment: 'INVESTASI',
    });
    expect(typeLabelOf({ category: 'education', proposalTypeLabel: null })).toBe('DANA PENDIDIKAN');
    expect(typeLabelOf({ category: 'life', proposalTypeLabel: 'Warisan' })).toBe('Warisan');
    expect(defaultInsuredFor('education')).toBe('child');
    expect(insuredOf({ category: 'health', defaultInsured: null })).toBe('client');
    expect(insuredOf({ category: 'health', defaultInsured: 'child' })).toBe('child');
  });

  it('P19.7-T1 AC-2 stores the three types with their defaults: chips preselected, fixed as its text, money with quick amounts', () => {
    const out = check({
      proposalFields: [
        chips('plan', ['Silver', 'Gold'], { default: 'Gold', plan: true, showOnSummary: true, draft: true }),
        { key: 'masa_bayar', label: 'Masa bayar', type: 'fixed', options: [{ label: 'sama dengan masa tunggu', years: 10 }], paymentYears: true },
        money('up', { labelSyariah: 'Santunan asuransi', quickAmounts: [100_000_000_00, 250_000_000_00], minMinor: 100_000_000_00 }),
      ],
    });
    expect(out.proposalFields[0]).toMatchObject({
      type: 'chips', default: 'Gold', showOnPdf: true, showOnSummary: true, plan: true, draft: true, paymentYears: false,
    });
    expect(out.proposalFields[1]).toMatchObject({ type: 'fixed', default: 'sama dengan masa tunggu', paymentYears: true });
    expect(out.proposalFields[2]).toMatchObject({
      type: 'money', default: null, labelSyariah: 'Santunan asuransi', quickAmounts: [100_000_000_00, 250_000_000_00],
      minMinor: 100_000_000_00, options: [],
    });
  });

  it('P19.7-T1 AC-2 strips markup from every label, as P19-T6’s validator does', () => {
    const out = check({ proposalFields: [chips('plan', ['<b>Gold</b>'], { label: '<script>x</script>Plan', default: 'Gold' })] });
    expect(out.proposalFields[0]).toMatchObject({ label: 'Plan', options: [{ label: 'Gold' }], default: 'Gold' });
  });

  describe('P19.7-T1 AC-3 every bound of a field is refused with its path', () => {
    it.each<[string, Record<string, unknown>, string]>([
      ['a key in capitals', { proposalFields: [chips('Plan', ['A'])] }, 'proposalFields[0].key'],
      ['a key of 41 characters', { proposalFields: [chips(`a${'b'.repeat(40)}`, ['A'])] }, 'proposalFields[0].key'],
      ['the reserved key insured', { proposalFields: [chips('insured', ['A'])] }, 'proposalFields[0].key'],
      ['the reserved key premium', { proposalFields: [money('premium')] }, 'proposalFields[0].key'],
      ['a key twice', { proposalFields: [chips('plan', ['A']), money('plan')] }, 'proposalFields[1].key'],
      ['an empty label', { proposalFields: [chips('plan', ['A'], { label: ' ' })] }, 'proposalFields[0].label'],
      ['a label of 61 characters', { proposalFields: [chips('plan', ['A'], { label: 'x'.repeat(61) })] }, 'proposalFields[0].label'],
      ['a syariah label of 61', { proposalFields: [money('up', { labelSyariah: 'x'.repeat(61) })] }, 'proposalFields[0].labelSyariah'],
      ['an unknown type', { proposalFields: [{ key: 'x', label: 'X', type: 'slider' }] }, 'proposalFields[0].type'],
      ['an unknown property', { proposalFields: [money('up', { rateTable: [] })] }, 'proposalFields[0].rateTable'],
      ['nine fields', { proposalFields: Array.from({ length: 9 }, (_, i) => money(`m${i}`)) }, 'proposalFields'],
      ['five on the summary', { proposalFields: Array.from({ length: 5 }, (_, i) => money(`m${i}`, { showOnSummary: true })) }, 'proposalFields[4].showOnSummary'],
      ['two paymentYears', { proposalFields: [chips('a', ['1'], { paymentYears: true }), chips('b', ['1'], { paymentYears: true })] }, 'proposalFields[1].paymentYears'],
      ['two plan fields', { proposalFields: [chips('a', ['1'], { plan: true }), chips('b', ['1'], { plan: true })] }, 'proposalFields[1].plan'],
      ['two currency fields', { proposalFields: [chips('a', ['1'], { currency: true }), chips('b', ['1'], { currency: true })] }, 'proposalFields[0].options[0].currency'],
      ['chips with no option', { proposalFields: [{ key: 'a', label: 'A', type: 'chips', options: [], default: null }] }, 'proposalFields[0].options'],
      ['chips with nine options', { proposalFields: [chips('a', Array.from({ length: 9 }, (_, i) => `o${i}`))] }, 'proposalFields[0].options'],
      ['an option of 41 characters', { proposalFields: [chips('a', ['x'.repeat(41)])] }, 'proposalFields[0].options[0].label'],
      ['an option twice', { proposalFields: [chips('a', ['Gold', 'Gold'])] }, 'proposalFields[0].options'],
      ['a default that is no option', { proposalFields: [chips('a', ['Gold'], { default: 'Silver' })] }, 'proposalFields[0].default'],
      ['chips with no default', { proposalFields: [chips('a', ['Gold'], { default: null })] }, 'proposalFields[0].default'],
      ['fixed with two options', { proposalFields: [{ key: 'a', label: 'A', type: 'fixed', options: [{ label: 'x' }, { label: 'y' }] }] }, 'proposalFields[0].options'],
      ['money with options', { proposalFields: [money('up', { options: [{ label: 'x' }] })] }, 'proposalFields[0].options'],
      ['money with a default', { proposalFields: [money('up', { default: '100' })] }, 'proposalFields[0].default'],
      ['five quick amounts', { proposalFields: [money('up', { quickAmounts: [1, 2, 3, 4, 5] })] }, 'proposalFields[0].quickAmounts'],
      ['quick amounts out of order', { proposalFields: [money('up', { quickAmounts: [5, 2] })] }, 'proposalFields[0].quickAmounts'],
      ['a quick amount of zero', { proposalFields: [money('up', { quickAmounts: [0] })] }, 'proposalFields[0].quickAmounts'],
      ['a quick amount that is not whole', { proposalFields: [money('up', { quickAmounts: [1.5] })] }, 'proposalFields[0].quickAmounts'],
      ['a negative minMinor', { proposalFields: [money('up', { minMinor: -1 })] }, 'proposalFields[0].minMinor'],
      ['quick amounts on chips', { proposalFields: [chips('a', ['x'], { quickAmounts: [1] })] }, 'proposalFields[0].quickAmounts'],
      ['paymentYears on money', { proposalFields: [money('up', { paymentYears: true })] }, 'proposalFields[0].paymentYears'],
      ['plan on fixed', { proposalFields: [{ key: 'a', label: 'A', type: 'fixed', options: [{ label: 'x' }], plan: true }] }, 'proposalFields[0].plan'],
      ['years of 100', { proposalFields: [chips('a', ['x'], { options: [{ label: 'x', years: 100 }], default: 'x' })] }, 'proposalFields[0].options[0].years'],
      ['years of 0', { proposalFields: [chips('a', ['x'], { options: [{ label: 'x', years: 0 }], default: 'x' })] }, 'proposalFields[0].options[0].years'],
      ['a flag that is not a boolean', { proposalFields: [money('up', { showOnPdf: 'yes' })] }, 'proposalFields[0].showOnPdf'],
      ['a list that is not a list', { proposalFields: 'plan' }, 'proposalFields'],
    ])('P19.7-T1 AC-3 refuses %s', (_case, input, field) => {
      expect(refusal(() => check(input))).toEqual({ code: 'VALIDATION_FAILED', field });
    });

    it('P19.7-T1 AC-3 refuses a currency option the product does not sell, and takes one it does', () => {
      const field = chips('mata_uang', ['Rupiah', 'Dolar'], {
        currency: true, options: [{ label: 'Rupiah', currency: 'IDR' }, { label: 'Dolar', currency: 'USD' }],
      });
      expect(refusal(() => check({ proposalFields: [field] }))).toEqual({
        code: 'VALIDATION_FAILED', field: 'proposalFields[0].options[1].currency',
      });
      const out = check({ proposalFields: [field] }, { currencies: ['IDR', 'USD'] });
      expect(out.proposalFields[0].options.map((o) => o.currency)).toEqual(['IDR', 'USD']);
      // On any other field, an option's currency is not kept.
      expect(check({ proposalFields: [chips('a', ['x'], { options: [{ label: 'x', currency: 'IDR' }] })] })
        .proposalFields[0].options[0].currency).toBeNull();
    });

    it('P19.7-T1 AC-3 accepts the bounds themselves: 8 fields, 4 on the summary, 8 options, 4 quick amounts', () => {
      const out = check({
        proposalFields: [
          chips('a', Array.from({ length: 8 }, (_, i) => `o${i}`), { showOnSummary: true }),
          money('b', { quickAmounts: [1, 2, 3, 4], showOnSummary: true }),
          ...Array.from({ length: 6 }, (_, i) => money(`m${i}`, { showOnSummary: i < 2 })),
        ],
      });
      expect(out.proposalFields).toHaveLength(8);
    });
  });

  describe('P19.7-T1 AC-3 plans, FAQ, detail blocks and the product’s own words', () => {
    const plan = chips('plan', ['Silver', 'Gold', 'Platinum'], { plan: true });
    const card = (name: string, over: Record<string, unknown> = {}) => ({
      name, highlights: [{ label: 'Kamar', value: 'Rp 1 jt/hari' }], ...over,
    });

    it('P19.7-T1 AC-2 keeps plan cards in order, cheapest first, with one popular', () => {
      const out = check({ proposalFields: [plan], planOptions: [card('Silver'), card('Gold', { popular: true })] });
      expect(out.planOptions).toEqual([
        { name: 'Silver', highlights: [{ label: 'Kamar', value: 'Rp 1 jt/hari' }], popular: false },
        { name: 'Gold', highlights: [{ label: 'Kamar', value: 'Rp 1 jt/hari' }], popular: true },
      ]);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['cards with no plan field', { planOptions: [card('Gold')] }, 'planOptions'],
      ['a card naming no option', { proposalFields: [plan], planOptions: [card('Diamond')] }, 'planOptions[0].name'],
      ['a card twice', { proposalFields: [plan], planOptions: [card('Gold'), card('Gold')] }, 'planOptions[1].name'],
      ['two popular', { proposalFields: [plan], planOptions: [card('Gold', { popular: true }), card('Silver', { popular: true })] }, 'planOptions[1].popular'],
      ['nine cards', { proposalFields: [chips('plan', Array.from({ length: 8 }, (_, i) => `p${i}`), { plan: true })], planOptions: Array.from({ length: 9 }, (_, i) => card(`p${i % 8}`)) }, 'planOptions'],
      ['a card with no highlight', { proposalFields: [plan], planOptions: [card('Gold', { highlights: [] })] }, 'planOptions[0].highlights'],
      ['five highlights', { proposalFields: [plan], planOptions: [card('Gold', { highlights: Array.from({ length: 5 }, () => ({ label: 'a', value: 'b' })) })] }, 'planOptions[0].highlights'],
      ['a highlight label of 31', { proposalFields: [plan], planOptions: [card('Gold', { highlights: [{ label: 'x'.repeat(31), value: 'v' }] })] }, 'planOptions[0].highlights[0].label'],
      ['a highlight value of 41', { proposalFields: [plan], planOptions: [card('Gold', { highlights: [{ label: 'l', value: 'x'.repeat(41) }] })] }, 'planOptions[0].highlights[0].value'],
      ['21 questions', { faq: Array.from({ length: 21 }, () => ({ question: 'q', answer: 'a' })) }, 'faq'],
      ['a question of 201', { faq: [{ question: 'x'.repeat(201), answer: 'a' }] }, 'faq[0].question'],
      ['an answer of 1,001', { faq: [{ question: 'q', answer: 'x'.repeat(1001) }] }, 'faq[0].answer'],
      ['an empty answer', { faq: [{ question: 'q', answer: '' }] }, 'faq[0].answer'],
      ['syariahName of 81', { syariahName: 'x'.repeat(81) }, 'syariahName'],
      ['a type label of 31', { proposalTypeLabel: 'x'.repeat(31) }, 'proposalTypeLabel'],
      ['an unknown insured', { defaultInsured: 'spouse' }, 'defaultInsured'],
    ])('P19.7-T1 AC-3 refuses %s', (_case, input, field) => {
      expect(refusal(() => check(input))).toEqual({ code: 'VALIDATION_FAILED', field });
    });

    it('P19.7-T1 AC-3 refuses syariahName on a syariah product: it is offered under Syariah by its own name (§3)', () => {
      expect(refusal(() => check({ syariahName: 'PRUWell Medical Syariah' }, { channel: 'syariah' })))
        .toEqual({ code: 'VALIDATION_FAILED', field: 'syariahName' });
      expect(check({ syariahName: 'PRUWell Medical Syariah' }).syariahName).toBe('PRUWell Medical Syariah');
    });

    it('P19.7-T1 AC-3 keeps an FAQ answer’s line breaks, and a question on one line', () => {
      expect(readFaq([{ question: 'Apakah\nada masa tunggu?', answer: 'Ya.\n\n\n\nTiga puluh hari.' }]))
        .toEqual([{ question: 'Apakah ada masa tunggu?', answer: 'Ya.\n\nTiga puluh hari.' }]);
    });

    it('P19.7-T1 AC-3 checks a plan card against the plan field the same save leaves: removing an option a card names is refused', () => {
      const stored = checkProposalSettings({ proposalFields: [plan], planOptions: [card('Platinum')] }, {}, FACTS);
      expect(refusal(() => checkProposalSettings(
        { proposalFields: [chips('plan', ['Silver', 'Gold'], { plan: true })] }, stored, FACTS,
      ))).toEqual({ code: 'VALIDATION_FAILED', field: 'planOptions[0].name' });
    });

    const block = (over: Record<string, unknown> = {}) => ({
      block: 'manfaat',
      rows: [{ label: 'Meninggal dunia', formula: '200% × up' }],
      source: { file: 'Ilustrasi PRUCinta.pdf', page: 3, date: '2026-11-01' },
      ...over,
    });

    it('P19.7-T1 AC-3 stores a detail block whose formula names a money key of its own product', () => {
      const out = check({ proposalFields: [money('up')], pdfDetail: [block()] });
      expect(out.pdfDetail[0]).toMatchObject({
        block: 'manfaat', rows: [{ label: 'Meninggal dunia', formula: '200% × up', text: null, note: null }],
        source: { file: 'Ilustrasi PRUCinta.pdf', page: 3, date: '2026-11-01' }, notGuaranteed: false,
      });
    });

    it('P19.7-T1 AC-3 refuses a formula naming another product’s key, an unknown key or a chips key — "`{name}` bukan kolom uang produk ini."', () => {
      for (const name of ['santunan', 'plan']) {
        let thrown: { code: string; details: { field: string }; message: unknown } | null = null;
        try {
          check({ proposalFields: [money('up'), plan], pdfDetail: [block({ rows: [{ label: 'x', formula: `2 × ${name}` }] })] });
        } catch (err) { thrown = err as never; }
        expect(thrown).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'pdfDetail[0].rows[0].formula' } });
      }
      expect(indonesian(PROPOSAL_FIELDS_REFUSALS.VALIDATION_FAILED.formulaName({ name: 'santunan' })))
        .toBe('`santunan` bukan kolom uang produk ini.');
    });

    it('P19.7-T1 AC-3 refuses a formula that leaves the grammar, and one removed under it by the same save', () => {
      expect(refusal(() => check({ proposalFields: [money('up')], pdfDetail: [block({ rows: [{ label: 'x', formula: 'up ** 2' }] })] })))
        .toEqual({ code: 'VALIDATION_FAILED', field: 'pdfDetail[0].rows[0].formula' });
      const stored = check({ proposalFields: [money('up')], pdfDetail: [block()] });
      expect(refusal(() => checkProposalSettings({ proposalFields: [money('santunan')] }, stored, FACTS)))
        .toEqual({ code: 'VALIDATION_FAILED', field: 'pdfDetail[0].rows[0].formula' });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['a block twice', { pdfDetail: [block(), block()] }, 'pdfDetail[1].block'],
      ['an unknown block', { pdfDetail: [block({ block: 'ringkasan' })] }, 'pdfDetail[0].block'],
      ['nine rows', { pdfDetail: [block({ rows: Array.from({ length: 9 }, () => ({ label: 'x', text: 'y' })) })] }, 'pdfDetail[0].rows'],
      ['four exclusions', { pdfDetail: [block({ block: 'pengecualian', rows: Array.from({ length: 4 }, () => ({ label: 'x', text: 'y' })) })] }, 'pdfDetail[0].rows'],
      ['a block with no row', { pdfDetail: [block({ rows: [] })] }, 'pdfDetail[0].rows'],
      ['a row with both a formula and a text', { pdfDetail: [block({ rows: [{ label: 'x', formula: 'up', text: 'y' }] })] }, 'pdfDetail[0].rows[0]'],
      ['a row with neither', { pdfDetail: [block({ rows: [{ label: 'x' }] })] }, 'pdfDetail[0].rows[0]'],
      ['a row label of 81', { pdfDetail: [block({ rows: [{ label: 'x'.repeat(81), text: 'y' }] })] }, 'pdfDetail[0].rows[0].label'],
      ['a note of 41', { pdfDetail: [block({ rows: [{ label: 'x', text: 'y', note: 'n'.repeat(41) }] })] }, 'pdfDetail[0].rows[0].note'],
      ['no source', { pdfDetail: [block({ source: undefined })] }, 'pdfDetail[0].source'],
      ['a source file of 121', { pdfDetail: [block({ source: { file: 'f'.repeat(121), page: 1, date: '2026-11-01' } })] }, 'pdfDetail[0].source.file'],
      ['a page of 0', { pdfDetail: [block({ source: { file: 'f', page: 0, date: '2026-11-01' } })] }, 'pdfDetail[0].source.page'],
      ['a source dated tomorrow', { pdfDetail: [block({ source: { file: 'f', page: 1, date: '2026-11-06' } })] }, 'pdfDetail[0].source.date'],
      ['notGuaranteed on manfaat', { pdfDetail: [block({ notGuaranteed: true })] }, 'pdfDetail[0].notGuaranteed'],
    ])('P19.7-T1 AC-3 refuses %s', (_case, input, field) => {
      expect(refusal(() => check({ proposalFields: [money('up')], ...input }))).toEqual({ code: 'VALIDATION_FAILED', field });
    });

    it('P19.7-T1 AC-3 marks nilai_tunai not guaranteed', () => {
      const out = check({
        proposalFields: [money('up')],
        pdfDetail: [block({ block: 'nilai_tunai', notGuaranteed: true, rows: [{ label: 'Tahun ke-10', formula: '30% × up' }] })],
      });
      expect(out.pdfDetail[0].notGuaranteed).toBe(true);
    });
  });

  describe('P19.7-T1 AC-3 an office’s FAQ and plan highlights (ADR-0225 §5)', () => {
    it('P19.7-T1 AC-3 takes highlights for the company’s own plans, and refuses a plan it does not have', () => {
      expect(readOfficePlanHighlights({ Gold: [{ label: 'Kamar', value: 'VIP' }] }, ['Silver', 'Gold']))
        .toEqual({ Gold: [{ label: 'Kamar', value: 'VIP' }] });
      expect(refusal(() => readOfficePlanHighlights({ Diamond: [{ label: 'a', value: 'b' }] }, ['Gold'])))
        .toEqual({ code: 'VALIDATION_FAILED', field: 'planHighlights.Diamond' });
      expect(refusal(() => readOfficePlanHighlights([], ['Gold']))).toEqual({ code: 'VALIDATION_FAILED', field: 'planHighlights' });
      expect(refusal(() => readOfficePlanHighlights({ Gold: [] }, ['Gold'])))
        .toEqual({ code: 'VALIDATION_FAILED', field: 'planHighlights.Gold' });
    });

    it('P19.7-T1 AC-3 serves agents the approved FAQ and highlights only, and ignores a plan the company no longer has', () => {
      const product = {
        faq: [{ question: 'Q?', answer: 'Company.' }],
        planOptions: [
          { name: 'Silver', highlights: [{ label: 'Kamar', value: '1 jt' }], popular: false },
          { name: 'Gold', highlights: [{ label: 'Kamar', value: '2 jt' }], popular: true },
        ],
      };
      expect(effectiveProposalWordsOf(product, undefined)).toEqual({
        faq: product.faq, plans: product.planOptions, source: 'company',
      });
      const words = effectiveProposalWordsOf(product, {
        faq: [{ question: 'Q?', answer: 'Office.' }],
        planHighlights: { Gold: [{ label: 'Kamar', value: 'VIP' }], Retired: [{ label: 'x', value: 'y' }] },
      });
      expect(words.source).toBe('kpm');
      expect(words.faq).toEqual([{ question: 'Q?', answer: 'Office.' }]);
      expect(words.plans.map((p) => [p.name, p.highlights[0].value])).toEqual([['Silver', '1 jt'], ['Gold', 'VIP']]);
    });
  });

  it('P19.7-T1 AC-3 says every refusal in English and Indonesian', () => {
    const SAY = PROPOSAL_FIELDS_REFUSALS.VALIDATION_FAILED as unknown as Record<string, unknown>;
    for (const [entry, sentence] of Object.entries(SAY)) {
      const said = typeof sentence === 'function'
        ? (sentence as (v: Record<string, unknown>) => never)({
          field: 'proposalFields[0]', max: 4, min: 1, flag: 'plan', types: 'chips', type: 'money', key: 'up',
          label: 'Gold', name: 'Gold', currencies: 'IDR', block: 'manfaat', at: '**',
        })
        : sentence;
      expect([entry, english(said as never)]).not.toEqual([entry, '']);
      expect(indonesian(said as never)).not.toBe(english(said as never));
    }
  });
});
