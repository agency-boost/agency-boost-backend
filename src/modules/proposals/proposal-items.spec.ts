import { DomainException } from '@/common/errors/domain.exception';
import type { PayTerm, ProposalField } from '@/modules/products/proposal-fields';
import {
  applyItemPatch, currencyOf, defaultFrequencyOf, insuredAgeOf, itemName, longestAllowed, missingOf, newItem,
  payTermAllowed, planOf, settlePayTerm, snapshotOf, totalPaidOf, totalsOf, withDerived,
  type ProductForItem, type StoredItem,
} from './proposal-items';

const field = (over: Partial<ProposalField> & Pick<ProposalField, 'key' | 'label' | 'type'>): ProposalField => ({
  labelSyariah: null, options: [], default: null, quickAmounts: [], minMinor: null, showOnPdf: true,
  showOnSummary: false, paymentYears: false, plan: false, currency: false, draft: false, ...over,
});
const opt = (label: string, years: number | null = null, currency: 'IDR' | 'USD' | null = null) => ({ label, years, currency });
const term = (key: string, over: Partial<PayTerm> = {}): PayTerm => ({
  key, label: key, years: null, toAge: null, single: false, maxEntryAge: null, default: false, ...over,
});

const HEALTH: ProductForItem = {
  _id: 'p1', code: 'PRUWELL_MEDICAL', version: 4, channel: 'conventional', category: 'health', currencies: ['IDR'],
  primaryNeeds: ['health'],
  benefits: ['a', 'b', 'c', 'd', 'e'],
  proposalFields: [
    field({ key: 'plan', label: 'Plan', type: 'chips', options: [opt('Silver'), opt('Gold')], default: 'Gold', plan: true }),
    field({ key: 'masa_bayar', label: 'Masa bayar', type: 'chips', options: [opt('10 tahun', 10), opt('s.d. usia 60')], default: '10 tahun', paymentYears: true }),
    field({ key: 'saver', label: 'Saver', type: 'chips', options: [opt('Tidak')] }),
    field({ key: 'wilayah', label: 'Wilayah', type: 'fixed', options: [opt('Indonesia')], default: 'Indonesia', draft: true }),
    field({ key: 'up', label: 'Uang pertanggungan', labelSyariah: 'Santunan asuransi', type: 'money', minMinor: 10_000_000_000, quickAmounts: [10_000_000_000] }),
  ],
  pdfDetail: [{ block: 'manfaat', rows: [{ label: 'x', note: null, formula: '2 × up', text: null }], source: { file: 'f.pdf', page: 2, date: '2026-10-01' }, notGuaranteed: false }],
  syariahName: 'PRUWell Medical Syariah',
  defaultInsured: null,
  proposalTypeLabel: null,
};
const EDU: ProductForItem = { _id: 'p2', code: 'PRUCERAH', version: 1, channel: 'syariah', category: 'education', proposalFields: [] };
const BOTH: ProductForItem = {
  _id: 'p3', code: 'PRUFUTURE', version: 1, channel: 'conventional', category: 'life', currencies: ['IDR', 'USD'],
  calcType: 'up_premium',
  proposalFields: [
    field({ key: 'mata_uang', label: 'Mata uang', type: 'chips', options: [opt('Rupiah', null, 'IDR'), opt('Dolar', null, 'USD')], default: 'Rupiah', currency: true }),
    field({ key: 'target', label: 'Target', type: 'money', minMinor: 10_000_000_000 }),
  ],
};
/** PCB88 as the list of 11 November draws it: `up_premium`, four terms, smoker-rated. */
const CI: ProductForItem = {
  _id: 'p4', code: 'PCB88', version: 2, channel: 'conventional', category: 'ci', calcType: 'up_premium', smokerRated: true,
  entryAge: { min: 1, max: 60 },
  payTerms: [
    term('y5', { years: 5, maxEntryAge: 60 }), term('y10', { years: 10, maxEntryAge: 60, default: true }),
    term('y15', { years: 15, maxEntryAge: 50 }), term('single', { single: true, maxEntryAge: 60, label: 'Sekali bayar' }),
  ],
};
/** PRUWell Medical's derived plan. */
const DERIVED: ProductForItem = {
  _id: 'p5', code: 'DERIVED', version: 1, channel: 'syariah', category: 'health', frequencies: ['annual', 'monthly'],
  proposalFields: [
    field({ key: 'wilayah', label: 'Wilayah', type: 'chips', options: [opt('Indonesia'), opt('Asia')], default: 'Indonesia' }),
    field({ key: 'kamar', label: 'Kamar', type: 'chips', options: [opt('2'), opt('1')], default: '2' }),
    field({ key: 'plan', label: 'Plan', type: 'derived', options: [opt('Bronze A'), opt('Bronze B'), opt('Silver')], plan: true }),
  ],
  planRule: {
    field: 'plan',
    rules: [
      { when: { wilayah: 'Indonesia', kamar: '2' }, value: 'Bronze A' },
      { when: { wilayah: 'Indonesia', kamar: '1' }, value: 'Bronze B' },
      { when: { wilayah: 'Asia' }, value: 'Silver' },
    ],
  },
};
const ANNUAL_ONLY: ProductForItem = { _id: 'p6', code: 'PROSPER', version: 1, channel: 'conventional', category: 'investment', currencies: ['USD'], frequencies: ['annual'] };
const SINGLE_ONLY: ProductForItem = { _id: 'p7', code: 'ONCE', version: 1, channel: 'conventional', category: 'life', frequencies: ['single'] };

const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { return { code: (e as DomainException).code, status: (e as DomainException).getStatus(), details: (e as DomainException).details }; }
  throw new Error('not refused');
};

describe('P19.7-T2 / P19.14-T2 a proposal’s items (proposal-items.ts)', () => {
  const health = () => newItem('i1', HEALTH, 'PRUWell Medical', 36);
  const ci = (age: number | null = 36) => newItem('i4', CI, 'PCB88', age);

  describe('a new item', () => {
    it('P19.7-T2 AC-7 preselects every chips field — its default, else its only option — and leaves money empty', () => {
      expect(health().fieldValues).toEqual({ plan: 'Gold', masa_bayar: '10 tahun', saver: 'Tidak' });
    });

    it('P19.14-T2 AC-3 insures the client by default, and the child on an education product, with no gender yet', () => {
      expect(health().insured).toEqual({ relation: 'client', name: null, age: null, gender: null });
      expect(newItem('i2', EDU, 'PRUCerah', 36).insured).toEqual({ relation: 'child', name: null, age: null, gender: null });
      expect(newItem('i2', { ...EDU, defaultInsured: 'client' }, 'PRUCerah', 36).insured.relation).toBe('client');
    });

    it('P19.14-T2 AC-3 stores nothing calculated: no sum assured, no premium, fixedField none, the 19.15 fields null', () => {
      expect(health()).toMatchObject({
        up: null, premium: null, fixedField: 'none', rateTableVersionId: null, rateTableEffectiveFrom: null, calcNote: null, choice: null,
      });
    });

    it('P19.14-T2 AC-5 copies the product’s words, need, syariah flag, calculation type, terms and frequencies', () => {
      const item = health();
      expect(item).toMatchObject({ productId: 'p1', productCode: 'PRUWELL_MEDICAL', productVersion: 4 });
      expect(item.snapshot).toMatchObject({
        name: 'PRUWell Medical', syariahName: 'PRUWell Medical Syariah', typeLabel: 'KESEHATAN', category: 'health',
        currencies: ['IDR'], needTag: 'HOSPITAL', isSyariah: false, calcType: 'manual', payTerms: [], planRule: null,
        frequencies: ['monthly', 'quarterly', 'semiannual', 'annual'], smokerRated: false, entryAge: null,
        limits: { upStep: null, upMin: null, upMax: null, premiumMin: null, premiumMax: null },
      });
      expect(item.snapshot.benefits).toEqual(['a', 'b', 'c', 'd']);
      expect(newItem('i2', EDU, 'PRUCerah', 36).snapshot).toMatchObject({ isSyariah: true, needTag: 'EDUCATION' });
      expect(ci().snapshot).toMatchObject({ calcType: 'up_premium', smokerRated: true, entryAge: { min: 1, max: 60 } });
    });

    it('P19.7-T2 AC-15 keeps no agent the Super Admin’s marks: no *Perlu dicek*, no block source', () => {
      const item = health();
      expect(item.snapshot.fields.every((f) => !('draft' in f))).toBe(true);
      expect(item.snapshot.pdfDetail[0]).toEqual({ block: 'manfaat', rows: [{ label: 'x', note: null, formula: '2 × up', text: null }], notGuaranteed: false });
    });

    it('P19.7-T2 AC-15 is a copy: a later change to the catalogue does not reach it', () => {
      const product = structuredClone(HEALTH);
      const item = newItem('i1', product, 'PRUWell Medical', 36);
      product.proposalFields![0].label = 'Pilihan plan';
      expect(item.snapshot.fields[0]).toMatchObject({ label: 'Plan', options: [{ label: 'Silver' }, { label: 'Gold' }] });
      const pcb = structuredClone(CI);
      const copied = newItem('i4', pcb, 'PCB88', 36);
      (pcb.payTerms as PayTerm[])[0].label = 'Lima';
      expect(copied.snapshot.payTerms[0].label).toBe('y5');
    });

    it('P19.14-T2 AC-3 starts on Bulanan where offered, else the first periodic one, else single', () => {
      expect(health().payFrequency).toBe('monthly');
      expect(newItem('i6', ANNUAL_ONLY, 'Prosper', 36).payFrequency).toBe('annual');
      expect(newItem('i7', SINGLE_ONLY, 'Once', 36).payFrequency).toBe('single');
      expect(defaultFrequencyOf({ frequencies: ['annual', 'monthly'] })).toBe('monthly');
    });

    it('P19.14-T2 AC-4 starts on the default pay term the age allows, else the longest allowed', () => {
      expect(ci(36).payTerm).toBe('y10');
      const noDefault = { ...CI, payTerms: (CI.payTerms as PayTerm[]).map((t) => ({ ...t, default: false })) };
      expect(newItem('i4', noDefault, 'PCB88', 36).payTerm).toBe('y15');
      expect(newItem('i4', noDefault, 'PCB88', 55).payTerm).toBe('y10');
      expect(health().payTerm).toBeNull();
    });

    it('P19.14-T2 AC-4 asks Merokok? only of a smoker-rated product, Tidak by default', () => {
      expect(ci().smoker).toBe(false);
      expect(health().smoker).toBeNull();
    });

    it('P19.14-T2 AC-3 works out a derived plan from the chips, and the name is the product’s own', () => {
      const item = newItem('i5', DERIVED, 'PRUWell Medical Syariah', 36);
      expect(item.fieldValues).toEqual({ wilayah: 'Indonesia', kamar: '2', plan: 'Bronze A' });
      expect(planOf(item)).toBe('Bronze A');
      expect(itemName(item.snapshot)).toBe('PRUWell Medical Syariah');
      expect(item.payFrequency).toBe('monthly');
    });

    it('P19.7-T2 AC-15 a product with no proposal fields is still an item: Tertanggung and the premium', () => {
      const item = newItem('i9', { _id: 'p9', code: 'X', version: 1, channel: 'conventional', category: 'life' }, 'X', null);
      expect(item.snapshot.fields).toEqual([]);
      expect(missingOf(item)).toEqual(['premium']);
    });
  });

  describe('reading one', () => {
    it('P19.7-T2 AC-6 reads the item’s currency: USD-only, IDR, or the currency field’s option', () => {
      expect(currencyOf(snapshotOf(ANNUAL_ONLY, 'x'), {})).toBe('USD');
      expect(currencyOf(snapshotOf(HEALTH, 'x'), {})).toBe('IDR');
      expect(currencyOf(snapshotOf(BOTH, 'x'), { mata_uang: 'Dolar' })).toBe('USD');
      expect(currencyOf(snapshotOf(BOTH, 'x'), { mata_uang: 'Rupiah' })).toBe('IDR');
    });

    it('P19.14-T2 AC-4 the insured’s age is the client’s for Klien, else their own', () => {
      expect(insuredAgeOf({ insured: { relation: 'client', name: null, age: null, gender: null } }, 40)).toBe(40);
      expect(insuredAgeOf({ insured: { relation: 'child', name: 'A', age: 8, gender: null } }, 40)).toBe(8);
    });

    it.each([
      [null, 30, true], [60, 60, true], [60, 61, false], [50, null, true],
    ])('P19.14-T2 AC-4 a term with maxEntryAge %p at age %p is allowed: %p', (max, age, allowed) => {
      expect(payTermAllowed({ maxEntryAge: max }, age)).toBe(allowed);
    });

    it('P19.14-T2 AC-4 the longest allowed: years, then the years to an age, single shortest, the first of equals', () => {
      const terms = CI.payTerms as PayTerm[];
      expect(longestAllowed(terms, 40)?.key).toBe('y15');
      expect(longestAllowed(terms, 55)?.key).toBe('y10');
      expect(longestAllowed(terms, 61)).toBeNull();
      expect(longestAllowed([term('to60', { toAge: 60 }), term('y10', { years: 10 })], 40)?.key).toBe('to60');
      expect(longestAllowed([term('a', { years: 5 }), term('b', { years: 5 })], 40)?.key).toBe('a');
    });

    it('P19.14-T2 AC-3 Total dibayar: the premium × payments a year of the item’s Cara bayar × the pay term’s years (§B.34)', () => {
      const item = applyItemPatch(ci(), { premium: { amountMinor: 1_000_000_00 } }, 36);
      expect(totalPaidOf(item)).toEqual({ amountMinor: 1_000_000_00 * 12 * 10, years: 10 });
      const annual = applyItemPatch(item, { payFrequency: 'annual', premium: { amountMinor: 11_000_000_00 } }, 36);
      expect(totalPaidOf(annual)).toEqual({ amountMinor: 11_000_000_00 * 10, years: 10 });
      // An item made before P19.14: the paymentYears field still counts.
      expect(totalPaidOf(applyItemPatch(health(), { premium: { amountMinor: 500_000_00 } }, 36))).toEqual({ amountMinor: 500_000_00 * 12 * 10, years: 10 });
    });

    it('P19.14-T2 AC-3 Total dibayar is null without a premium, for Sekali bayar, or without whole years', () => {
      expect(totalPaidOf(ci())).toBeNull();
      const single = applyItemPatch(ci(), { payTerm: 'single', premium: { amountMinor: 9_000_000_00 } }, 36);
      expect(single.payFrequency).toBe('single');
      expect(totalPaidOf(single)).toBeNull();
      const toSixty = applyItemPatch(health(), { fieldValues: { masa_bayar: 's.d. usia 60' }, premium: { amountMinor: 1 } }, 36);
      expect(totalPaidOf(toSixty)).toBeNull();
    });

    it('P19.14-T2 AC-3 Total premi sums per currency and per Cara bayar, never across either, IDR first (ADR-0255 §7)', () => {
      const items = [
        { premium: { amountMinor: 100, currency: 'IDR' as const }, payFrequency: 'monthly' as const },
        { premium: { amountMinor: 50, currency: 'IDR' as const }, payFrequency: 'monthly' as const },
        { premium: { amountMinor: 1_000, currency: 'IDR' as const }, payFrequency: 'annual' as const },
        { premium: { amountMinor: 7, currency: 'USD' as const }, payFrequency: 'annual' as const },
        { premium: null, payFrequency: 'monthly' as const },
      ];
      expect(totalsOf(items)).toEqual([
        { currency: 'IDR', payFrequency: 'monthly', amountMinor: 150, items: 2 },
        { currency: 'IDR', payFrequency: 'annual', amountMinor: 1_000, items: 1 },
        { currency: 'USD', payFrequency: 'annual', amountMinor: 7, items: 1 },
      ]);
      expect(totalsOf([])).toEqual([]);
    });

    it('P19.14-T2 AC-3 missingOf: a premium, a non-client’s name and age (gender asked, never required), chips and derived values, a pay term', () => {
      const child = applyItemPatch(health(), { insured: { relation: 'child' } }, 36);
      expect(missingOf(child)).toEqual(['premium', 'insured.name', 'insured.age']);
      const done = applyItemPatch(child, { insured: { relation: 'child', name: 'Adik', age: 8 }, premium: { amountMinor: 1 } }, 36);
      expect(missingOf(done)).toEqual([]);
      const zero = applyItemPatch(health(), { premium: { amountMinor: 0 } }, 36);
      expect(missingOf(zero)).toEqual(['premium']);
      const noTerm = { ...applyItemPatch(ci(), { premium: { amountMinor: 1 } }, 36), payTerm: null };
      expect(missingOf(noTerm)).toEqual(['payTerm']);
      const noPlan = { ...newItem('i5', DERIVED, 'D', 36), fieldValues: { wilayah: 'Indonesia' }, premium: { amountMinor: 1, currency: 'IDR' as const } };
      expect(missingOf(noPlan)).toEqual(['kamar', 'plan']);
    });
  });

  describe('writing one', () => {
    it('P19.7-T2 AC-7 a chips field takes one of its options; a money field a whole sum or null; fixed, derived and unknown keys refused', () => {
      const item = applyItemPatch(health(), { fieldValues: { plan: 'Silver', up: 25_000_000_000 } }, 36);
      expect(item.fieldValues).toMatchObject({ plan: 'Silver', up: 25_000_000_000 });
      expect(applyItemPatch(item, { fieldValues: { up: null } }, 36).fieldValues.up).toBeUndefined();
      expect(refusal(() => applyItemPatch(item, { fieldValues: { plan: 'Bronze' } }, 36))).toMatchObject({ status: 400, details: { field: 'fieldValues.plan' } });
      expect(refusal(() => applyItemPatch(item, { fieldValues: { plan: null } }, 36))).toMatchObject({ status: 400 });
      expect(refusal(() => applyItemPatch(item, { fieldValues: { wilayah: 'Asia' } }, 36))).toMatchObject({ details: { field: 'fieldValues.wilayah' } });
      expect(refusal(() => applyItemPatch(item, { fieldValues: { nope: 1 } }, 36))).toMatchObject({ details: { field: 'fieldValues.nope' } });
      expect(refusal(() => applyItemPatch(item, { fieldValues: { up: 1.5 } }, 36))).toMatchObject({ status: 400 });
      expect(refusal(() => applyItemPatch(item, { fieldValues: { up: 1 } }, 36))).toMatchObject({ details: { field: 'fieldValues.up' } });
      const derived = newItem('i5', DERIVED, 'D', 36);
      expect(refusal(() => applyItemPatch(derived, { fieldValues: { plan: 'Silver' } }, 36))).toMatchObject({ details: { field: 'fieldValues.plan' } });
    });

    it('P19.14-T2 AC-3 a chips change works the derived plan out again; a rule matching nothing empties it', () => {
      const derived = newItem('i5', DERIVED, 'D', 36);
      expect(applyItemPatch(derived, { fieldValues: { kamar: '1' } }, 36).fieldValues.plan).toBe('Bronze B');
      expect(applyItemPatch(derived, { fieldValues: { wilayah: 'Asia' } }, 36).fieldValues.plan).toBe('Silver');
      const strict = { ...derived, snapshot: { ...derived.snapshot, planRule: { field: 'plan', rules: [{ when: { wilayah: 'Asia' }, value: 'Silver' }] } } };
      expect(withDerived(strict.snapshot, { wilayah: 'Indonesia' })).toEqual({ wilayah: 'Indonesia' });
      expect(withDerived(snapshotOf(HEALTH, 'x'), { plan: 'Gold' })).toEqual({ plan: 'Gold' });
    });

    it('P19.7-T2 AC-6 a change of the currency field empties the money values, the sum assured and the premium', () => {
      let item = newItem('i3', BOTH, 'PRUFuture', 36);
      item = applyItemPatch(item, { fieldValues: { target: 20_000_000_000 }, up: { amountMinor: 1_000 }, premium: { amountMinor: 5_000 } }, 36);
      expect(item.premium).toEqual({ amountMinor: 5_000, currency: 'IDR' });
      const usd = applyItemPatch(item, { fieldValues: { mata_uang: 'Dolar' } }, 36);
      expect(usd.fieldValues).toEqual({ mata_uang: 'Dolar' });
      expect([usd.up, usd.premium]).toEqual([null, null]);
      // The least sum is in rupiah: a USD item takes any whole sum.
      expect(applyItemPatch(usd, { fieldValues: { target: 5 } }, 36).fieldValues.target).toBe(5);
    });

    it('P19.14-T2 AC-3 Tertanggung: Klien clears the name, age and gender; anyone else keeps what was sent', () => {
      let item = applyItemPatch(health(), { insured: { relation: 'spouse', name: '  Ibu Ani ', age: 40, gender: 'female' } }, 36);
      expect(item.insured).toEqual({ relation: 'spouse', name: 'Ibu Ani', age: 40, gender: 'female' });
      item = applyItemPatch(item, { insured: { relation: 'other' } }, 36);
      expect(item.insured).toEqual({ relation: 'other', name: 'Ibu Ani', age: 40, gender: 'female' });
      expect(applyItemPatch(item, { insured: { relation: 'client' } }, 36).insured).toEqual({ relation: 'client', name: null, age: null, gender: null });
      expect(refusal(() => applyItemPatch(item, { insured: { relation: 'client', gender: 'male' } }, 36))).toMatchObject({ status: 400, details: { field: 'insured' } });
      expect(refusal(() => applyItemPatch(item, { insured: { relation: 'other', gender: 'x' as never } }, 36))).toMatchObject({ details: { field: 'insured.gender' } });
      expect(refusal(() => applyItemPatch(item, { insured: { relation: 'other', name: '' } }, 36))).toMatchObject({ details: { field: 'insured.name' } });
      expect(refusal(() => applyItemPatch(item, { insured: { relation: 'nobody' as never } }, 36))).toMatchObject({ details: { field: 'insured.relation' } });
    });

    it('P19.14-T2 AC-3 an insured’s age outside 1–100 is 422 LEAD_AGE_OUT_OF_RANGE, a fraction 400', () => {
      expect(refusal(() => applyItemPatch(health(), { insured: { relation: 'child', age: 101 } }, 36)))
        .toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', status: 422, details: { min: 1, max: 100, field: 'insured.age' } });
      expect(refusal(() => applyItemPatch(health(), { insured: { relation: 'child', age: 2.5 } }, 36))).toMatchObject({ status: 400 });
    });

    it('P19.14-T2 AC-4 a pay term the insured’s age does not allow is refused; a single term makes Cara bayar single', () => {
      expect(applyItemPatch(ci(), { payTerm: 'y5' }, 36).payTerm).toBe('y5');
      expect(refusal(() => applyItemPatch(ci(55), { payTerm: 'y15' }, 55))).toMatchObject({ status: 400, details: { field: 'payTerm' } });
      expect(refusal(() => applyItemPatch(ci(), { payTerm: 'nope' }, 36))).toMatchObject({ details: { field: 'payTerm' } });
      const once = applyItemPatch(applyItemPatch(ci(), { premium: { amountMinor: 1 } }, 36), { payTerm: 'single' }, 36);
      expect([once.payFrequency, once.premium]).toEqual(['single', null]);
      const back = applyItemPatch(once, { payTerm: 'y10' }, 36);
      expect(back.payFrequency).toBe('monthly');
    });

    it('P19.14-T2 AC-4 an insured older than a term’s limit moves it to the longest allowed (the card says so)', () => {
      let item = applyItemPatch(ci(), { insured: { relation: 'spouse', name: 'B', age: 30 } }, 36);
      item = applyItemPatch(item, { payTerm: 'y15' }, 36);
      expect(applyItemPatch(item, { insured: { relation: 'spouse', age: 55 } }, 36).payTerm).toBe('y10');
      expect(applyItemPatch(item, { insured: { relation: 'spouse', age: 61 } }, 36).payTerm).toBeNull();
      // The client’s age, through `settlePayTerm` (the service calls it when step 1 changes it).
      expect(settlePayTerm(applyItemPatch(ci(), { payTerm: 'y15' }, 36), 52).payTerm).toBe('y10');
      expect(settlePayTerm(ci(), 40).payTerm).toBe('y10');
      expect(settlePayTerm(health(), 99)).toEqual(health());
    });

    it('P19.14-T2 AC-3 Cara bayar is one the product offers; a change empties this item’s premium only', () => {
      const typed = applyItemPatch(ci(), { premium: { amountMinor: 1_000 }, up: { amountMinor: 50_000 } }, 36);
      const annual = applyItemPatch(typed, { payFrequency: 'annual' }, 36);
      expect([annual.payFrequency, annual.premium, annual.up]).toEqual(['annual', null, { amountMinor: 50_000, currency: 'IDR' }]);
      expect(applyItemPatch(typed, { payFrequency: 'monthly' }, 36).premium).toEqual({ amountMinor: 1_000, currency: 'IDR' });
      expect(refusal(() => applyItemPatch(newItem('i6', ANNUAL_ONLY, 'P', 36), { payFrequency: 'monthly' }, 36))).toMatchObject({ details: { field: 'payFrequency' } });
      // Single comes with a single pay term, never on its own.
      expect(refusal(() => applyItemPatch(ci(), { payFrequency: 'single' }, 36))).toMatchObject({ details: { field: 'payFrequency' } });
      const once = applyItemPatch(ci(), { payTerm: 'single' }, 36);
      expect(refusal(() => applyItemPatch(once, { payFrequency: 'annual' }, 36))).toMatchObject({ details: { field: 'payFrequency' } });
    });

    it('P19.14-T2 AC-4 Merokok? takes true or false on a smoker-rated product only', () => {
      expect(applyItemPatch(ci(), { smoker: true }, 36).smoker).toBe(true);
      expect(refusal(() => applyItemPatch(health(), { smoker: true }, 36))).toMatchObject({ details: { field: 'smoker' } });
      expect(refusal(() => applyItemPatch(ci(), { smoker: 'ya' as never }, 36))).toMatchObject({ details: { field: 'smoker' } });
    });

    it('P19.14-T2 AC-5 the sum assured on an up_premium product only; the premium on any, in the item’s currency', () => {
      expect(applyItemPatch(ci(), { up: { amountMinor: 500_000_000_00 } }, 36).up).toEqual({ amountMinor: 500_000_000_00, currency: 'IDR' });
      expect(applyItemPatch(applyItemPatch(ci(), { up: { amountMinor: 1 } }, 36), { up: { amountMinor: null } }, 36).up).toBeNull();
      expect(refusal(() => applyItemPatch(health(), { up: { amountMinor: 1 } }, 36))).toMatchObject({ details: { field: 'up.amountMinor' } });
      expect(refusal(() => applyItemPatch(ci(), { up: { amountMinor: -1 } }, 36))).toMatchObject({ details: { field: 'up.amountMinor' } });
      expect(applyItemPatch(newItem('i6', ANNUAL_ONLY, 'P', 36), { premium: { amountMinor: 250_000 } }, 36).premium).toEqual({ amountMinor: 250_000, currency: 'USD' });
      expect(applyItemPatch(applyItemPatch(health(), { premium: { amountMinor: 1 } }, 36), { premium: { amountMinor: null } }, 36).premium).toBeNull();
      expect(refusal(() => applyItemPatch(health(), { premium: { amountMinor: 1.5 } }, 36))).toMatchObject({ details: { field: 'premium.amountMinor' } });
      expect(refusal(() => applyItemPatch(health(), { premium: { amountMinor: 1e13 } }, 36))).toMatchObject({ status: 400 });
    });

    it('P19.7-T2 AC-7 never changes the item it was given', () => {
      const before = ci();
      const copy = structuredClone(before);
      applyItemPatch(before, { fieldValues: {}, payTerm: 'y5', premium: { amountMinor: 1 }, insured: { relation: 'child', name: 'A' } }, 36);
      expect(before).toEqual(copy);
    });
  });

  it('P19.14-T2 AC-1 an item’s name is its product’s: a syariah product is a product of its own', () => {
    expect(itemName({ name: 'PRU Anugerah Syariah' })).toBe('PRU Anugerah Syariah');
    const item: StoredItem = newItem('i2', EDU, 'PRUCerah', 30);
    expect(item.snapshot.isSyariah).toBe(true);
  });
});
