import { catalogOf, inChannel, offeredName, refusalOf } from './proposal-offer';

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
 * **P19.7-T2 AC-6 and T1's AC-5, AC-6 — what a proposal offers, and why it refuses the rest** (ADR-0225 §3, §7;
 * Acc. 17, 21; OD-273's riders).
 */
describe('P19.7-T2 what a proposal offers (proposal-offer.ts)', () => {
  it('P19.7-T2 AC-6 offers a base product on sale on the shelf, in the channel, at the client’s age', () => {
    expect(refusalOf(entry({ code: 'A' }), 'conventional', 36)).toBeNull();
  });

  it.each([
    ['rider', { kind: 'rider' }, {}],
    ['withdrawn', { lifecycle: 'withdrawn' }, {}],
    ['withdrawn', { lifecycle: 'withdrawn', deletedAt: new Date() }, {}],
    ['closed', { lifecycle: 'closed_to_new_business' }, {}],
    ['not_on_shelf', {}, { active: { value: false } }],
    ['not_on_shelf', {}, { sellable: false }],
    ['channel', { channel: 'syariah' }, {}],
    ['age', { eligibleAgeBands: [5] }, {}],
    ['age', { eligibleAgeBands: [] }, {}],
  ])('P19.7-T1 AC-5 refuses %s', (reason, product, view) => {
    expect(refusalOf(entry({ code: 'A', ...product }, view), 'conventional', 36)).toBe(reason);
  });

  it('P19.7-T2 AC-5 a Konvensional proposal offers conventional products alone; a Syariah one syariah products and syariah names', () => {
    expect(inChannel({ channel: 'conventional' }, 'conventional')).toBe(true);
    expect(inChannel({ channel: 'syariah' }, 'conventional')).toBe(false);
    expect(inChannel({ channel: 'syariah' }, 'syariah')).toBe(true);
    expect(inChannel({ channel: 'conventional', syariahName: 'X Syariah' }, 'syariah')).toBe(true);
    expect(inChannel({ channel: 'conventional', syariahName: null }, 'syariah')).toBe(false);
  });

  it('P19.7-T2 AC-5 names a conventional product by its syariah name on Syariah, and a syariah one by the office’s name', () => {
    expect(offeredName(entry({ code: 'A', name: 'PRUCinta', syariahName: 'PRUCinta Syariah' }), 'syariah')).toBe('PRUCinta Syariah');
    expect(offeredName(entry({ code: 'A', name: 'PRUCinta', syariahName: 'PRUCinta Syariah' }), 'conventional')).toBe('PRUCinta');
    expect(offeredName(entry({ code: 'S', channel: 'syariah' }, { displayName: { value: 'Anugerah (kantor)' } }), 'syariah')).toBe('Anugerah (kantor)');
  });

  describe('the catalogue (GET /proposals/catalog)', () => {
    const shelf = [
      entry({ code: 'HEALTH', name: 'PRUWell', category: 'health', planOptions: [{ name: 'Gold', popular: true, highlights: [{ label: 'Kamar', value: '1 jt' }] }], faq: [{ question: 'Q?', answer: 'A.' }], proposalFields: [{ key: 'plan', label: 'Plan', draft: true, type: 'chips', options: [], currency: false }] }),
      entry({ code: 'RIDER', name: 'PA', kind: 'rider', attachesTo: ['HEALTH'] }),
      entry({ code: 'OLD_RIDER', name: 'PA lama', kind: 'rider', attachesTo: ['HEALTH'], lifecycle: 'withdrawn' }),
      entry({ code: 'USD', name: 'Prosper', currencies: ['USD'], category: 'investment' }),
      entry({ code: 'BOTH', name: 'Future', currencies: ['IDR', 'USD'], proposalFields: [{ key: 'mata_uang', label: 'Mata uang', type: 'chips', options: [], currency: true }] }),
      entry({ code: 'EDU', name: 'Cerah', category: 'education' }),
      entry({ code: 'SYARIAH', name: 'Anugerah', channel: 'syariah' }),
    ];

    it('P19.7-T2 AC-6 lists the offered products in the company’s order; a rider is never a card (Acc. 17)', () => {
      expect(catalogOf(shelf, 'conventional', 36).map((p) => p.code)).toEqual(['HEALTH', 'USD', 'BOTH', 'EDU']);
      expect(catalogOf(shelf, 'syariah', 36).map((p) => p.code)).toEqual(['SYARIAH']);
    });

    it('P19.7-T1 AC-6 puts a base’s riders on sale under it, as Bisa ditambah, and adds none', () => {
      const health = catalogOf(shelf, 'conventional', 36).find((p) => p.code === 'HEALTH')!;
      expect(health.riders).toEqual([{ code: 'RIDER', name: 'PA' }]);
    });

    it('P19.7-T2 AC-8, AC-9 answers each product’s plans and FAQ as the office approved them, else the company’s', () => {
      const own = [{ ...shelf[0], approved: { faq: [{ question: 'Kantor?', answer: 'Ya.' }], planHighlights: { Gold: [{ label: 'Kamar', value: '2 jt' }] } } }];
      const [product] = catalogOf(own, 'conventional', 36);
      expect(product.faq).toEqual([{ question: 'Kantor?', answer: 'Ya.' }]);
      expect(product.plans).toEqual([{ name: 'Gold', popular: true, highlights: [{ label: 'Kamar', value: '2 jt' }] }]);
      expect(catalogOf(shelf, 'conventional', 36)[0].faq).toEqual([{ question: 'Q?', answer: 'A.' }]);
    });

    it('P19.7-T2 AC-6 answers the type label, the default insured, the fields without Perlu dicek, and the currency rule', () => {
      const products = catalogOf(shelf, 'conventional', 36);
      expect(products[0]).toMatchObject({ typeLabel: 'KESEHATAN', defaultInsured: 'client', currency: { fixed: 'IDR' } });
      expect(products[0].fields[0]).not.toHaveProperty('draft');
      expect(products.find((p) => p.code === 'USD')!.currency).toEqual({ fixed: 'USD' });
      expect(products.find((p) => p.code === 'BOTH')!.currency).toEqual({ byField: 'mata_uang' });
      expect(products.find((p) => p.code === 'EDU')!).toMatchObject({ defaultInsured: 'child', typeLabel: 'DANA PENDIDIKAN' });
    });

    it('P19.7-T2 AC-6 filters by the client’s age band (Acc. 21), and an empty shelf is an empty list', () => {
      expect(catalogOf([entry({ code: 'SENIOR', eligibleAgeBands: [5] })], 'conventional', 64)).toEqual([]);
      expect(catalogOf([entry({ code: 'SENIOR', eligibleAgeBands: [5] })], 'conventional', 65)).toHaveLength(1);
      expect(catalogOf([], 'conventional', 36)).toEqual([]);
    });
  });
});
