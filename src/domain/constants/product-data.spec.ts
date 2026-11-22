import {
  CALC_LIMIT_KINDS, CALC_NOTES, CALC_STATES, PRODUCT_DATA, PRODUCT_DATA_CHECK_REASONS, PRODUCT_DATA_STATUSES, RATE_BASES,
  RATE_COLUMN_ROLES, RATE_GAP_KINDS, RATE_TABLE_SOURCES, RATE_TABLE_STATUSES, SPREADSHEET,
} from '@/domain/constants';

/**
 * **P19.15-T1 — the premium tables' constants, pinned** (`metrics-and-definitions.md` §B.39; ADR-0258): each fails here
 * if it drifts from the document.
 */
describe('P19.15-T1 the premium tables’ constants (§B.39)', () => {
  it('three test profiles, matched within Rp1 (one rounding unit: 100 sen, or a cent)', () => {
    expect(PRODUCT_DATA.TEST_PROFILES).toBe(3);
    expect(PRODUCT_DATA.TEST_TOLERANCE_UNITS).toBe(1);
    expect(PRODUCT_DATA.ROUNDING_UNIT_MINOR).toEqual({ IDR: 100, USD: 1 });
  });

  it('Perlu dicek: a table ending within 30 days', () => {
    expect(PRODUCT_DATA.CHECK_WINDOW_DAYS).toBe(30);
  });

  it('the card recalculates about 300 ms after a change', () => {
    expect(PRODUCT_DATA.RECALC_DEBOUNCE_MS).toBe(300);
  });

  it('a file of 2 MiB and 10,000 rows at most — the spreadsheet reader’s own row bound', () => {
    expect(PRODUCT_DATA.UPLOAD_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(PRODUCT_DATA.ROWS_MAX).toBe(10_000);
    expect(PRODUCT_DATA.ROWS_MAX).toBe(SPREADSHEET.MAX_ROWS);
    expect(PRODUCT_DATA.PREVIEW_ROWS).toBe(5);
    expect(PRODUCT_DATA.PROBLEMS_MAX).toBe(20);
    expect(PRODUCT_DATA.GAPS_MAX).toBe(50);
    expect(PRODUCT_DATA.FILE_NAME_MAX).toBe(200);
  });

  it('a rate to six decimals, at most 1.000 ‰; a factor above 0, at most 1,5; a reason of 500 characters', () => {
    expect(PRODUCT_DATA.RATE_DECIMALS).toBe(6);
    expect(PRODUCT_DATA.RATE_MAX).toBe(1_000);
    expect(PRODUCT_DATA.FACTOR_MAX).toBe(1.5);
    expect(PRODUCT_DATA.OVERRIDE_REASON_MAX).toBe(500);
    expect(PRODUCT_DATA.KETENTUAN_SHEET).toBe('Ketentuan');
  });

  it('the words a version, a product, a card and a column may be', () => {
    expect(RATE_TABLE_STATUSES).toEqual(['draft', 'scheduled', 'active', 'old', 'off']);
    expect(RATE_BASES).toEqual(['per_mille', 'per_plan', 'per_band']);
    expect(RATE_TABLE_SOURCES).toEqual(['xlsx', 'csv', 'pdf', 'intake']);
    expect(PRODUCT_DATA_STATUSES).toEqual(['check', 'manual', 'ready', 'withdrawn']);
    expect(PRODUCT_DATA_CHECK_REASONS).toEqual(['ending', 'gaps', 'changed']);
    expect(CALC_STATES).toEqual(['ok', 'needs_amount', 'needs_input', 'missing_combination', 'no_frequency', 'age_outside', 'table_off']);
    expect(CALC_NOTES).toEqual(['up_rounded', 'rates_updated', 'table_off']);
    expect(CALC_LIMIT_KINDS).toEqual(['up_min', 'up_max', 'premium_min', 'premium_max']);
    expect(RATE_GAP_KINDS).toEqual(['ages', 'combination', 'smoker', 'gender', 'plan', 'payTerm', 'currency']);
    expect(RATE_COLUMN_ROLES).toEqual([
      'age', 'gender', 'smoker', 'plan', 'payTerm', 'currency', 'frequency', 'rate', 'premium', 'bandMin', 'bandMax', 'ignore',
    ]);
  });
});
