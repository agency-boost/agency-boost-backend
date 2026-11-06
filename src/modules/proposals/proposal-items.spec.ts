import { DomainException } from '@/common/errors/domain.exception';
import type { ProposalField } from '@/modules/products/proposal-fields';
import {
  applyItemPatch, currencyOf, itemName, missingOf, newItem, planOf, snapshotOf, totalPaidOf, totalsOf,
  withPremiumsEmptied, type ProductForItem, type StoredItem,
} from './proposal-items';

const field = (over: Partial<ProposalField> & Pick<ProposalField, 'key' | 'label' | 'type'>): ProposalField => ({
  labelSyariah: null, options: [], default: null, quickAmounts: [], minMinor: null, showOnPdf: true,
  showOnSummary: false, paymentYears: false, plan: false, currency: false, draft: false, ...over,
});
const opt = (label: string, years: number | null = null, currency: 'IDR' | 'USD' | null = null) => ({ label, years, currency });

const HEALTH: ProductForItem = {
  _id: 'p1', code: 'PRUWELL_MEDICAL', version: 4, category: 'health', currencies: ['IDR'],
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
const EDU: ProductForItem = { _id: 'p2', code: 'PRUCERAH', version: 1, category: 'education', proposalFields: [] };
const BOTH: ProductForItem = {
  _id: 'p3', code: 'PRUFUTURE', version: 1, category: 'life', currencies: ['IDR', 'USD'],
  proposalFields: [
    field({ key: 'mata_uang', label: 'Mata uang', type: 'chips', options: [opt('Rupiah', null, 'IDR'), opt('Dolar', null, 'USD')], default: 'Rupiah', currency: true }),
    field({ key: 'up', label: 'UP', type: 'money', minMinor: 10_000_000_000 }),
  ],
};

const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { return { code: (e as DomainException).code, status: (e as DomainException).getStatus(), details: (e as DomainException).details }; }
  throw new Error('not refused');
};

describe('P19.7-T2 a proposal’s items (proposal-items.ts)', () => {
  const health = () => newItem('i1', HEALTH, 'PRUWell Medical');

  describe('a new item', () => {
    it('P19.7-T2 AC-7 preselects every chips field — its default, else its only option — and leaves money empty', () => {
      expect(health().fieldValues).toEqual({ plan: 'Gold', masa_bayar: '10 tahun', saver: 'Tidak' });
    });

    it('P19.7-T2 AC-7 insures the client by default, and the child on an education product (Acc. 12)', () => {
      expect(health().insured).toEqual({ relation: 'client', name: null, age: null });
      expect(newItem('i2', EDU, 'PRUCerah').insured).toEqual({ relation: 'child', name: null, age: null });
      expect(newItem('i2', { ...EDU, defaultInsured: 'client' }, 'PRUCerah').insured.relation).toBe('client');
    });

    it('P19.7-T2 AC-15 copies the product’s labels, flags, version and up to four benefits; choice is null', () => {
      const item = health();
      expect(item).toMatchObject({ productId: 'p1', productCode: 'PRUWELL_MEDICAL', productVersion: 4, choice: null });
      expect(item.snapshot).toMatchObject({ name: 'PRUWell Medical', syariahName: 'PRUWell Medical Syariah', typeLabel: 'KESEHATAN', category: 'health', currencies: ['IDR'] });
      expect(item.snapshot.benefits).toEqual(['a', 'b', 'c', 'd']);
      expect(item.snapshot.fields.find((f) => f.key === 'up')).toMatchObject({ label: 'Uang pertanggungan', labelSyariah: 'Santunan asuransi' });
    });

    it('P19.7-T2 AC-15 keeps no agent the Super Admin’s marks: no *Perlu dicek*, no block source', () => {
      const item = health();
      expect(item.snapshot.fields.every((f) => !('draft' in f))).toBe(true);
      expect(item.snapshot.pdfDetail[0]).toEqual({ block: 'manfaat', rows: [{ label: 'x', note: null, formula: '2 × up', text: null }], notGuaranteed: false });
    });

    it('P19.7-T2 AC-15 is a copy: a later change to the catalogue does not reach it', () => {
      const product = structuredClone(HEALTH);
      const item = newItem('i1', product, 'PRUWell Medical');
      product.proposalFields![0].label = 'Pilihan plan';
      product.proposalFields![0].options[0].label = 'Bronze';
      expect(item.snapshot.fields[0]).toMatchObject({ label: 'Plan', options: [{ label: 'Silver' }, { label: 'Gold' }] });
    });

    it('P19.7-T2 AC-15 a product with no proposal fields is still an item: Tertanggung and the premium', () => {
      const item = newItem('i9', { _id: 'p9', code: 'X', version: 1, category: 'life' }, 'X');
      expect(item).toMatchObject({ fieldValues: {}, premium: { amountMinor: null, currency: 'IDR' } });
      expect(item.snapshot).toMatchObject({ fields: [], currencies: ['IDR'], pdfDetail: [] });
    });
  });

  describe('what an item reads', () => {
    it('P19.7-T2 AC-5 names it by its syariah name on a Syariah proposal, where it has one (Acc. 10)', () => {
      const { snapshot } = health();
      expect(itemName(snapshot, 'conventional')).toBe('PRUWell Medical');
      expect(itemName(snapshot, 'syariah')).toBe('PRUWell Medical Syariah');
      expect(itemName({ ...snapshot, syariahName: null }, 'syariah')).toBe('PRUWell Medical');
    });

    it('P19.7-T1 AC-6 a USD product’s premium is in USD; a product selling both follows its currency field (ADR-0225 §8)', () => {
      expect(newItem('u', { ...EDU, currencies: ['USD'] }, 'PRU Prosper').premium.currency).toBe('USD');
      const both = newItem('b', BOTH, 'PRUFuture');
      expect(both.premium.currency).toBe('IDR');
      expect(currencyOf(both.snapshot, { mata_uang: 'Dolar' })).toBe('USD');
      expect(currencyOf({ currencies: ['IDR'], fields: both.snapshot.fields }, { mata_uang: 'Dolar' })).toBe('IDR');
    });

    it('P19.7-T2 AC-8 reads the plan field’s value', () => {
      expect(planOf(health())).toBe('Gold');
      expect(planOf(newItem('i2', EDU, 'PRUCerah'))).toBeNull();
    });

    it.each([
      ['monthly', 12], ['quarterly', 4], ['semiannual', 2], ['annual', 1],
    ] as const)('P19.7-T2 AC-7 Total dibayar on %s is the premium × %p a year × the years (Acc. 11)', (frequency, perYear) => {
      const item = { ...health(), premium: { amountMinor: 1_000_000_00, currency: 'IDR' as const } };
      expect(totalPaidOf(item, frequency)).toEqual({ amountMinor: 1_000_000_00 * perYear * 10, years: 10 });
    });

    it('P19.7-T2 AC-7 has no Total dibayar without a premium, or where the term is no whole number of years', () => {
      expect(totalPaidOf(health(), 'monthly')).toBeNull();
      const toSixty = { ...health(), fieldValues: { ...health().fieldValues, masa_bayar: 's.d. usia 60' }, premium: { amountMinor: 100, currency: 'IDR' as const } };
      expect(totalPaidOf(toSixty, 'monthly')).toBeNull();
    });

    it('P19.7-T2 AC-7 reads a fixed paymentYears field’s one option', () => {
      const item = newItem('e', { ...EDU, proposalFields: [field({ key: 'masa', label: 'Masa', type: 'fixed', options: [opt('Sampai 18', 18)], default: 'Sampai 18', paymentYears: true })] }, 'PRUCerah');
      expect(totalPaidOf({ ...item, premium: { amountMinor: 10, currency: 'IDR' } }, 'annual')).toEqual({ amountMinor: 180, years: 18 });
    });

    it('P19.7-T2 AC-12 Total premi sums per currency, IDR first, and never adds IDR to USD', () => {
      expect(totalsOf([
        { premium: { amountMinor: 300, currency: 'USD' } },
        { premium: { amountMinor: 100, currency: 'IDR' } },
        { premium: { amountMinor: 200, currency: 'IDR' } },
        { premium: { amountMinor: null, currency: 'IDR' } },
      ])).toEqual([{ currency: 'IDR', amountMinor: 300 }, { currency: 'USD', amountMinor: 300 }]);
      expect(totalsOf([{ premium: { amountMinor: null, currency: 'IDR' } }])).toEqual([]);
    });

    it('P19.7-T2 AC-11 says what Simpan PDF still needs: a premium above zero, the insured’s name and age, every chips value', () => {
      const item = health();
      expect(missingOf(item)).toEqual(['premium']);
      const child: StoredItem = { ...item, insured: { relation: 'child', name: null, age: null }, premium: { amountMinor: 0, currency: 'IDR' }, fieldValues: {} };
      expect(missingOf(child)).toEqual(['premium', 'insured.name', 'insured.age', 'plan', 'masa_bayar', 'saver']);
      expect(missingOf({ ...item, premium: { amountMinor: 1, currency: 'IDR' } })).toEqual([]);
    });
  });

  describe('a write to an item (AC-7)', () => {
    it('P19.7-T2 AC-7 merges field values: a chips label, a money amount, null to clear a money field', () => {
      let item = applyItemPatch(health(), { fieldValues: { plan: 'Silver', up: 25_000_000_000 } });
      expect(item.fieldValues).toMatchObject({ plan: 'Silver', up: 25_000_000_000, masa_bayar: '10 tahun' });
      item = applyItemPatch(item, { fieldValues: { up: null } });
      expect(item.fieldValues).not.toHaveProperty('up');
    });

    it.each([
      ['a chips value that is no option', { plan: 'Platinum' }],
      ['a chips field cleared', { plan: null }],
      ['a fixed field', { wilayah: 'Asia' }],
      ['a key the product does not have', { kamar: '1' }],
      ['a money value that is not whole', { up: 10.5 }],
      ['a negative money value', { up: -1 }],
      ['a money value as text', { up: '100' }],
    ])('P19.7-T2 AC-7 refuses %s: 400 naming the field', (_label, fieldValues) => {
      const r = refusal(() => applyItemPatch(health(), { fieldValues }));
      expect(r).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(String(r.details?.field)).toMatch(/^fieldValues\./);
    });

    it('P19.7-T2 AC-7 holds a money field to its least sum on an IDR item (PRUWell Health’s min 100 jt)', () => {
      expect(refusal(() => applyItemPatch(health(), { fieldValues: { up: 9_999_999_999 } }))).toMatchObject({ status: 400, details: { field: 'fieldValues.up' } });
      expect(applyItemPatch(health(), { fieldValues: { up: 10_000_000_000 } }).fieldValues.up).toBe(10_000_000_000);
    });

    it('P19.7-T1 AC-6 a change of currency empties the item’s money values and premium; a USD amount is not held to rupiah', () => {
      let item = newItem('b', BOTH, 'PRUFuture');
      item = applyItemPatch(item, { fieldValues: { up: 20_000_000_000 }, premium: { amountMinor: 5_000_000 } });
      item = applyItemPatch(item, { fieldValues: { mata_uang: 'Dolar' } });
      expect(item.fieldValues).toEqual({ mata_uang: 'Dolar' });
      expect(item.premium).toEqual({ amountMinor: null, currency: 'USD' });
      expect(applyItemPatch(item, { fieldValues: { up: 500_00 } }).fieldValues.up).toBe(500_00);
    });

    it('P19.7-T2 AC-7 anyone but Klien takes a name and an age, each null while typed; Klien clears both', () => {
      let item = applyItemPatch(health(), { insured: { relation: 'spouse' } });
      expect(item.insured).toEqual({ relation: 'spouse', name: null, age: null });
      item = applyItemPatch(item, { insured: { relation: 'spouse', name: '  Ibu Ani  ', age: 34 } });
      expect(item.insured).toEqual({ relation: 'spouse', name: 'Ibu Ani', age: 34 });
      item = applyItemPatch(item, { insured: { relation: 'other' } });
      expect(item.insured).toEqual({ relation: 'other', name: 'Ibu Ani', age: 34 });
      expect(applyItemPatch(item, { insured: { relation: 'client' } }).insured).toEqual({ relation: 'client', name: null, age: null });
    });

    it.each([[0], [101]])('P19.7-T2 AC-7 refuses an insured’s age of %p: 422 LEAD_AGE_OUT_OF_RANGE (ADR-0224 §7)', (age) => {
      expect(refusal(() => applyItemPatch(health(), { insured: { relation: 'child', name: 'Adik', age } })))
        .toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', status: 422, details: { min: 1, max: 100 } });
    });

    it.each([
      ['an age that is not whole', { relation: 'child', age: 8.5 }],
      ['an empty name', { relation: 'child', name: '   ' }],
      ['a name of 121 characters', { relation: 'child', name: 'x'.repeat(121) }],
      ['a name for Klien', { relation: 'client', name: 'Pak Budi' }],
      ['a relation that is none of the four', { relation: 'cousin' }],
    ])('P19.7-T2 AC-7 refuses %s: 400', (_label, insured) => {
      expect(refusal(() => applyItemPatch(health(), { insured: insured as never }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    });

    it.each([[-1], [1.5], [1_000_000_000_001]])('P19.7-T2 AC-7 refuses a premium of %p: 400', (amountMinor) => {
      expect(refusal(() => applyItemPatch(health(), { premium: { amountMinor } }))).toMatchObject({ status: 400, details: { field: 'premium.amountMinor' } });
    });

    it('P19.7-T2 AC-5 a change of Cara bayar empties every premium (ADR-0221 §3)', () => {
      const item = applyItemPatch(health(), { premium: { amountMinor: 700_000_00 } });
      expect(withPremiumsEmptied([item])[0].premium).toEqual({ amountMinor: null, currency: 'IDR' });
    });

    it('P19.7-T2 AC-15 never rewrites the snapshot or the choice', () => {
      const before = health();
      const after = applyItemPatch(before, { fieldValues: { plan: 'Silver' }, premium: { amountMinor: 1 } });
      expect(after.snapshot).toEqual(snapshotOf(HEALTH, 'PRUWell Medical'));
      expect(after.choice).toBeNull();
      expect(before.fieldValues.plan).toBe('Gold');
    });
  });
});
