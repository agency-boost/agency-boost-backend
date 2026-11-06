import {
  PRODUCT_AGE_BAND_LABELS, PROPOSAL, PROPOSAL_CHANNELS, PROPOSAL_INSURED_RELATIONS, PROPOSAL_PAY_FREQUENCIES,
  PROPOSAL_REFUSAL_REASONS, PROPOSAL_STATUSES, ageBandOf,
} from '@/domain/constants';

/**
 * **P19.7-T2 — the proposal's constants, pinned** (`metrics-and-definitions.md` §B.34; ADR-0221, ADR-0225 §7). The whole
 * `PROPOSAL` object, T1's bounds with T2's, so a drift in either fails here by name.
 */
describe('P19.7-T2 the proposal’s constants (§B.34)', () => {
  it('P19.7-T2 AC-6 pins PROPOSAL whole: T1’s field bounds and T2’s record bounds', () => {
    expect(PROPOSAL).toEqual({
      FIELDS_MAX: 8, SUMMARY_FIELDS_MAX: 4, CHIP_OPTIONS_MAX: 8, QUICK_AMOUNTS_MAX: 4, PLAN_OPTIONS_MAX: 8,
      PLAN_HIGHLIGHTS_MAX: 4, FAQ_MAX: 20, PDF_DETAIL_ROWS_MAX: 8, EXCLUSIONS_MAX: 3, FORMULA_MAX_LENGTH: 120,
      PAYMENT_YEARS_MAX: 99,
      ITEMS_MAX: 5, BENEFITS_ON_PDF_MAX: 4,
      PAYMENTS_PER_YEAR: { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 },
      LIST_PAGE_SIZE: 20, LIST_PAGE_SIZE_MAX: 50, SEARCH_MAX_LENGTH: 120, INSURED_NAME_MAX: 120,
      PREMIUM_MAX_MINOR: 1_000_000_000_000, MONEY_MAX_MINOR: 1_000_000_000_000_000,
      PDF_PAGES: 2, PDF_BODY_MIN_PT: 11, PDF_FOOTER_PT: 8, PDF_CONCURRENCY: 2, FILE_NAME_CLIENT_MAX: 60,
    });
  });

  it('P19.7-T3 AC-6 pins the PDF’s pages, its smallest sizes, its concurrency and the file name’s bound (§B.34)', () => {
    expect([PROPOSAL.PDF_PAGES, PROPOSAL.PDF_BODY_MIN_PT, PROPOSAL.PDF_FOOTER_PT]).toEqual([2, 11, 8]);
    expect([PROPOSAL.PDF_CONCURRENCY, PROPOSAL.FILE_NAME_CLIENT_MAX]).toEqual([2, 60]);
    // The footer is the only text below the body's size (ADR-0223 §2).
    expect(PROPOSAL.PDF_FOOTER_PT).toBeLessThan(PROPOSAL.PDF_BODY_MIN_PT);
  });

  it('P19.7-T2 AC-5 names the channels, the four *Cara bayar*, the statuses and *Tertanggung*, in the spec’s order', () => {
    expect(PROPOSAL_CHANNELS).toEqual(['conventional', 'syariah']);
    expect(PROPOSAL_PAY_FREQUENCIES).toEqual(['monthly', 'quarterly', 'semiannual', 'annual']);
    expect(Object.keys(PROPOSAL.PAYMENTS_PER_YEAR)).toEqual([...PROPOSAL_PAY_FREQUENCIES]);
    expect(PROPOSAL_STATUSES).toEqual(['draft', 'done']);
    expect(PROPOSAL_INSURED_RELATIONS).toEqual(['client', 'spouse', 'child', 'other']);
    expect(PROPOSAL_REFUSAL_REASONS).toEqual(['withdrawn', 'closed', 'rider', 'not_on_shelf', 'channel', 'age']);
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
