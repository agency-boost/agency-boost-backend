import {
  PRODUCT_AGE_BAND_LABELS, PROPOSAL, PROPOSAL_CALC_TYPES, PROPOSAL_CATALOGUE, PROPOSAL_CLIENT_NEEDS,
  PROPOSAL_CLIENT_STATUSES, PROPOSAL_CLIENT_TEXT_MAX, PROPOSAL_FIELD_TYPES, PROPOSAL_FIXED_FIELDS,
  PROPOSAL_INSURED_RELATIONS, PROPOSAL_NEED_TAGS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_PERIODIC_FREQUENCIES,
  PROPOSAL_REFUSAL_REASONS, PROPOSAL_STATUSES, ageBandOf, needTagFor,
} from '@/domain/constants';

/**
 * **P19.7-T2 — the proposal's constants, pinned** (`metrics-and-definitions.md` §B.34; ADR-0221, ADR-0225 §7). The whole
 * `PROPOSAL` object, T1's bounds with T2's, so a drift in either fails here by name.
 */
describe('P19.7-T2 the proposal’s constants (§B.34)', () => {
  it('P19.7-T2 AC-6 pins PROPOSAL whole but the PDF’s own: T1’s field bounds and T2’s record bounds', () => {
    // The PDF's bounds (`PDF_*`, `FILE_NAME_CLIENT_MAX`) are pinned by the PDF's own test below (P19.14-T3 redraws them).
    const pdfOwn = (key: string) => (key.startsWith('PDF_') && key !== 'PDF_DETAIL_ROWS_MAX') || key === 'FILE_NAME_CLIENT_MAX';
    const own = Object.fromEntries(Object.entries(PROPOSAL).filter(([key]) => !pdfOwn(key)));
    expect(own).toEqual({
      // CHIP_OPTIONS_MAX raised from 8 by P19.14-T2 (ADR-0255 §9): PRUCerah's *Masa tunggu* has 11.
      FIELDS_MAX: 8, SUMMARY_FIELDS_MAX: 4, CHIP_OPTIONS_MAX: 12, QUICK_AMOUNTS_MAX: 4, PLAN_OPTIONS_MAX: 8,
      PLAN_HIGHLIGHTS_MAX: 4, FAQ_MAX: 20, PDF_DETAIL_ROWS_MAX: 8, EXCLUSIONS_MAX: 3, FORMULA_MAX_LENGTH: 120,
      PAYMENT_YEARS_MAX: 99,
      ITEMS_MAX: 5, BENEFITS_ON_PDF_MAX: 4,
      PAYMENTS_PER_YEAR: { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 },
      LIST_PAGE_SIZE: 20, LIST_PAGE_SIZE_MAX: 50, SEARCH_MAX_LENGTH: 120, INSURED_NAME_MAX: 120,
      PREMIUM_MAX_MINOR: 1_000_000_000_000, MONEY_MAX_MINOR: 1_000_000_000_000_000,
    });
  });

  it('P19.14-T3 AC-1 AC-2 pins the PDF’s pages, its type floors, its rows and tints, its concurrency and the file name’s bound (§B.34)', () => {
    // The PDF's own (ADR-0256); `PDF_DETAIL_ROWS_MAX` is the catalogue's (T1), pinned above.
    const pdf = Object.fromEntries(Object.entries(PROPOSAL).filter(([key]) => key.startsWith('PDF_') && key !== 'PDF_DETAIL_ROWS_MAX'));
    expect(pdf).toEqual({
      PDF_PAGES: 2, PDF_PAGES_ONE_PRODUCT: 1,
      PDF_BODY_MIN_PT: 12, PDF_LABEL_MIN_PT: 10, PDF_PRODUCT_NAME_MIN_PT: 15, PDF_PREMIUM_MIN_PT: 18, PDF_CLIENT_NAME_MIN_PT: 24,
      PDF_BOX_ROWS_FEW: 7, PDF_BOX_ROWS_MANY: 5, PDF_HERO_ROWS_MAX: 8, PDF_PROTECTION_MAX: 3, PDF_FACTS_MAX: 2, PDF_NEED_TILES_MAX: 4,
      PDF_TINT_LIGHT: 0.07, PDF_TINT_STRONG: 0.14,
      PDF_CONCURRENCY: 2,
    });
    expect(PROPOSAL.FILE_NAME_CLIENT_MAX).toBe(60);
    // The spec's order of sizes: labels < body < product names < premiums < the client's name.
    expect(PROPOSAL.PDF_LABEL_MIN_PT).toBeLessThan(PROPOSAL.PDF_BODY_MIN_PT);
    expect(PROPOSAL.PDF_BODY_MIN_PT).toBeLessThan(PROPOSAL.PDF_PRODUCT_NAME_MIN_PT);
    expect(PROPOSAL.PDF_PRODUCT_NAME_MIN_PT).toBeLessThan(PROPOSAL.PDF_PREMIUM_MIN_PT);
    expect(PROPOSAL.PDF_PREMIUM_MIN_PT).toBeLessThan(PROPOSAL.PDF_CLIENT_NAME_MIN_PT);
  });

  it('P19.14-T2 AC-1 names Cara bayar — the four periodic and Sekali bayar — the statuses, Tertanggung and the refusals; no channel', () => {
    expect(PROPOSAL_PAY_FREQUENCIES).toEqual(['monthly', 'quarterly', 'semiannual', 'annual', 'single']);
    expect(PROPOSAL_PERIODIC_FREQUENCIES).toEqual(['monthly', 'quarterly', 'semiannual', 'annual']);
    // Sekali bayar has no payments a year: *Total dibayar* is never counted for it.
    expect(Object.keys(PROPOSAL.PAYMENTS_PER_YEAR)).toEqual([...PROPOSAL_PERIODIC_FREQUENCIES]);
    expect(PROPOSAL_STATUSES).toEqual(['draft', 'done']);
    expect(PROPOSAL_INSURED_RELATIONS).toEqual(['client', 'spouse', 'child', 'other']);
    expect(PROPOSAL_REFUSAL_REASONS).toEqual(['withdrawn', 'closed', 'rider', 'not_on_shelf', 'age']);
  });

  it('P19.14-T2 AC-5 pins the calculation types, the fixed fields, the field types and the catalogue’s bounds (ADR-0255)', () => {
    expect(PROPOSAL_CALC_TYPES).toEqual(['up_premium', 'goal', 'premium_benefit', 'plan_priced', 'manual']);
    expect(PROPOSAL_FIXED_FIELDS).toEqual(['up', 'premium', 'goal', 'none']);
    expect(PROPOSAL_FIELD_TYPES).toEqual(['chips', 'money', 'fixed', 'derived']);
    expect(PROPOSAL_CATALOGUE).toEqual({ PAY_TERMS_MAX: 8, PAY_TERM_LABEL_MAX: 60, PLAN_RULES_MAX: 24, PLAN_RULE_WHEN_MAX: 4, AGE_MAX: 100 });
  });

  it('P19.14-T1 AC-3 pins the client’s details: two statuses, the six needs in the spec’s order, the text bounds (ADR-0254 §3)', () => {
    expect(PROPOSAL_CLIENT_STATUSES).toEqual(['single', 'married']);
    expect(PROPOSAL_CLIENT_NEEDS).toEqual(['HOSPITAL', 'CRITICAL_INCOME', 'FAMILY', 'EDUCATION', 'FUTURE', 'OTHER']);
    expect(PROPOSAL_NEED_TAGS).toEqual(PROPOSAL_CLIENT_NEEDS.filter((need) => need !== 'OTHER'));
    expect(PROPOSAL_CLIENT_TEXT_MAX).toEqual({ DEPENDANTS: 80, OCCUPATION: 60, CITY: 60, NEEDS_OTHER: 80 });
  });

  it.each([
    ['health', ['health'], 'HOSPITAL'], ['health', ['accident'], 'HOSPITAL'], ['ci', [], 'CRITICAL_INCOME'],
    ['life', ['legacy'], 'FAMILY'], ['life', ['retirement'], 'FUTURE'], ['education', [], 'EDUCATION'],
    ['investment', [], 'FUTURE'], ['life', ['unknown'], 'FAMILY'], ['other', [], 'FAMILY'],
  ])('P19.14-T2 AC-5 needTagFor(%p, %p) is %p (ADR-0255 §5)', (category, needs, tag) => {
    expect(needTagFor(category as string, needs as string[])).toBe(tag);
  });

  it('P19.7-T2 AC-6 keeps the largest Total dibayar and five Total premi safe integers (invariant §9)', () => {
    expect(PROPOSAL.PREMIUM_MAX_MINOR * 12 * PROPOSAL.PAYMENT_YEARS_MAX).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(PROPOSAL.MONEY_MAX_MINOR * PROPOSAL.ITEMS_MAX).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    [1, 1], [24, 1], [25, 2], [34, 2], [35, 3], [49, 3], [50, 4], [64, 4], [65, 5], [100, 5],
  ])('P19.7-T2 AC-6 ageBandOf(%p) is band %p, as PRODUCT_AGE_BAND_LABELS draws it', (age, band) => {
    expect(ageBandOf(age)).toBe(band);
  });

  it('P19.7-T2 AC-6 reads the same bounds the labels print: each band’s floor is its label’s first number', () => {
    expect(PRODUCT_AGE_BAND_LABELS).toEqual({ 1: '< 25', 2: '25–34', 3: '35–49', 4: '50–64', 5: '65+' });
    for (const band of [2, 3, 4, 5]) {
      const floor = Number(/\d+/.exec(PRODUCT_AGE_BAND_LABELS[band])![0]);
      expect([band, ageBandOf(floor), ageBandOf(floor - 1)]).toEqual([band, band, band - 1]);
    }
  });
});
