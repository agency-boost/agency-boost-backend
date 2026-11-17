import { catalogOf, outsideEntryAge, refusalOf } from './proposal-offer';

type Entry = Parameters<typeof refusalOf>[0];

const entry = (product: Record<string, unknown>, view: Record<string, unknown> = {}, approved?: Record<string, unknown>): Entry => ({
  product: {
    _id: product.code, kind: 'base', lifecycle: 'active', deletedAt: null, channel: 'conventional', category: 'life',
    eligibleAgeBands: [1, 2, 3, 4, 5], currencies: ['IDR'], attachesTo: [], proposalFields: [], planOptions: [], faq: [],
    syariahName: null, ...product,
  } as never,
  view: { active: { value: true }, sellable: true, displayName: { value: String(product.name ?? product.code) }, ...view } as never,
  approved,
});

/**
 * **P19.7-T2 AC-6, P19.14-T2 AC-1, AC-2 — what a proposal offers, and why it refuses the rest** (ADR-0225 §7; ADR-0255
 * §1, §8; Acc. 17, 21; OD-273's riders): no channel any more, and the entry ages instead of the age bands.
 */
describe('P19.7-T2 / P19.14-T2 what a proposal offers (proposal-offer.ts)', () => {
  it('P19.7-T2 AC-6 offers a base product on sale on the shelf at the client’s age — conventional and syariah alike', () => {
    expect(refusalOf(entry({ code: 'A' }), 36)).toBeNull();
    expect(refusalOf(entry({ code: 'S', channel: 'syariah' }), 36)).toBeNull();
  });

  it.each([
    ['rider', { kind: 'rider' }, {}],
    ['withdrawn', { lifecycle: 'withdrawn' }, {}],
    ['withdrawn', { lifecycle: 'withdrawn', deletedAt: new Date() }, {}],
    ['closed', { lifecycle: 'closed_to_new_business' }, {}],
    ['not_on_shelf', {}, { active: { value: false } }],
    ['not_on_shelf', {}, { sellable: false }],
    ['age', { entryAge: { min: 40, max: 60 } }, {}],
    ['age', { entryAge: { min: 1, max: 35 } }, {}],
  ])('P19.14-T2 AC-2 refuses %s', (reason, product, view) => {
    expect(refusalOf(entry({ code: 'A', ...product }, view), 36)).toBe(reason);
  });

  it('P19.14-T2 AC-2 the entry ages decide, inclusive; no range, or no age yet, is never outside — the age bands no longer do', () => {
    expect(outsideEntryAge({ entryAge: { min: 21, max: 70 } }, 21)).toBe(false);
    expect(outsideEntryAge({ entryAge: { min: 21, max: 70 } }, 70)).toBe(false);
    expect(outsideEntryAge({ entryAge: { min: 21, max: 70 } }, 71)).toBe(true);
    expect(outsideEntryAge({ entryAge: null }, 99)).toBe(false);
    expect(outsideEntryAge({ entryAge: { min: 21, max: 70 } }, null)).toBe(false);
    expect(refusalOf(entry({ code: 'SENIOR', eligibleAgeBands: [5] }), 36)).toBeNull();
  });

  describe('the catalogue (GET /proposals/catalog)', () => {
    const shelf = [
      entry({ code: 'HEALTH', name: 'PRUWell', category: 'health', planOptions: [{ name: 'Gold', popular: true, highlights: [{ label: 'Kamar', value: '1 Jt' }] }], faq: [{ question: 'Q?', answer: 'A.' }], proposalFields: [{ key: 'plan', label: 'Plan', draft: true, type: 'chips', options: [], currency: false }] }),
      entry({ code: 'RIDER', name: 'PA', kind: 'rider', attachesTo: ['HEALTH'] }),
      entry({ code: 'OLD_RIDER', name: 'PA lama', kind: 'rider', attachesTo: ['HEALTH'], lifecycle: 'withdrawn' }),
      entry({ code: 'USD', name: 'Prosper', currencies: ['USD'], category: 'investment', frequencies: ['annual'] }),
      entry({ code: 'BOTH', name: 'Future', currencies: ['IDR', 'USD'], proposalFields: [{ key: 'mata_uang', label: 'Mata uang', type: 'chips', options: [], currency: true }] }),
      entry({ code: 'EDU', name: 'Cerah', category: 'education' }),
      entry({ code: 'SYARIAH', name: 'Anugerah', channel: 'syariah' }),
      entry({ code: 'CI', name: 'PCB88', category: 'ci', calcType: 'up_premium', smokerRated: true, entryAge: { min: 1, max: 60 },
        payTerms: [{ key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 60, default: true }] }),
      entry({ code: 'OFF', name: 'Off' }, { sellable: false }),
    ];

    it('P19.14-T2 AC-1 lists conventional and syariah products together, in the company’s order; a rider is never a card', () => {
      expect(catalogOf(shelf, 36).map((p) => p.code)).toEqual(['HEALTH', 'USD', 'BOTH', 'EDU', 'SYARIAH', 'CI']);
      expect(catalogOf(shelf, 36).find((p) => p.code === 'SYARIAH')).toMatchObject({ isSyariah: true, name: 'Anugerah' });
      expect(catalogOf(shelf, 36).find((p) => p.code === 'HEALTH')!.isSyariah).toBe(false);
    });

    it('P19.14-T2 AC-2 greys a product the client’s age cannot enter, and still lists it with its range', () => {
      const old = catalogOf(shelf, 61).find((p) => p.code === 'CI')!;
      expect(old).toMatchObject({ outOfAge: true, entryAge: { min: 1, max: 60 } });
      expect(catalogOf(shelf, 60).find((p) => p.code === 'CI')!.outOfAge).toBe(false);
      expect(catalogOf(shelf, null).every((p) => !p.outOfAge)).toBe(true);
    });

    it('P19.14-T2 AC-5 answers each product’s calculation fields, need and Cara bayar — every product calculating nothing', () => {
      const ci = catalogOf(shelf, 36).find((p) => p.code === 'CI')!;
      expect(ci).toMatchObject({ calcType: 'up_premium', smokerRated: true, needTag: 'CRITICAL_INCOME', planRule: null });
      expect(ci.payTerms).toEqual([{ key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 60, default: true }]);
      expect(ci.frequencies).toEqual(['monthly', 'quarterly', 'semiannual', 'annual']);
      expect(catalogOf(shelf, 36).find((p) => p.code === 'USD')!.frequencies).toEqual(['annual']);
      expect(catalogOf(shelf, 36).find((p) => p.code === 'HEALTH')!).toMatchObject({ calcType: 'manual', needTag: 'HOSPITAL' });
    });

    it('P19.7-T1 AC-6 puts a base’s riders on sale under it, as Bisa ditambah, and adds none', () => {
      const health = catalogOf(shelf, 36).find((p) => p.code === 'HEALTH')!;
      expect(health.riders).toEqual([{ code: 'RIDER', name: 'PA' }]);
    });

    it('P19.7-T2 AC-8, AC-9 answers each product’s plans and FAQ as the office approved them, else the company’s', () => {
      const own = [{ ...shelf[0], approved: { faq: [{ question: 'Kantor?', answer: 'Ya.' }], planHighlights: { Gold: [{ label: 'Kamar', value: '2 Jt' }] } } }];
      const [product] = catalogOf(own, 36);
      expect(product.faq).toEqual([{ question: 'Kantor?', answer: 'Ya.' }]);
      expect(product.plans).toEqual([{ name: 'Gold', popular: true, highlights: [{ label: 'Kamar', value: '2 Jt' }] }]);
      expect(catalogOf(shelf, 36)[0].faq).toEqual([{ question: 'Q?', answer: 'A.' }]);
    });

    it('P19.7-T2 AC-6 answers the type label, the default insured, the fields without Perlu dicek, and the currency rule', () => {
      const products = catalogOf(shelf, 36);
      expect(products[0]).toMatchObject({ typeLabel: 'KESEHATAN', defaultInsured: 'client', currency: { fixed: 'IDR' } });
      expect(products[0].fields[0]).not.toHaveProperty('draft');
      expect(products.find((p) => p.code === 'USD')!.currency).toEqual({ fixed: 'USD' });
      expect(products.find((p) => p.code === 'BOTH')!.currency).toEqual({ byField: 'mata_uang' });
      expect(products.find((p) => p.code === 'EDU')!).toMatchObject({ defaultInsured: 'child', typeLabel: 'DANA PENDIDIKAN' });
    });

    it('P19.14-T2 AC-6 an empty shelf is an empty list, never an error', () => {
      expect(catalogOf([], 36)).toEqual([]);
    });
  });
});
