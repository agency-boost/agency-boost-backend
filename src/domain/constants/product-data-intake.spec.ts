import {
  ILLUSTRATION, ILLUSTRATION_CHECK_STATES, ILLUSTRATION_STATUSES, INTAKE, INTAKE_FILE_KINDS, INTAKE_ITEM_KINDS,
  INTAKE_ITEM_STATUSES, INTAKE_QUESTION_KINDS, INTAKE_STATUSES,
} from '@/domain/constants';

/**
 * **P19.15-T2, T3 — *Unggah file*'s and the illustration's constants, pinned** (`metrics-and-definitions.md` §B.40;
 * ADR-0259). A drift fails here by name.
 */
describe('P19.15-T3 the intake’s bounds (§B.40)', () => {
  it('P19.15-T3 AC-1 pins INTAKE whole: files, sizes, the ZIP’s bounds, the picture’s edge, the text and the stale window', () => {
    expect(INTAKE).toEqual({
      FILES_MAX: 10,
      FILE_MAX_BYTES: 20 * 1024 * 1024,
      UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
      ZIP_ENTRIES_MAX: 20,
      ZIP_UNPACKED_MAX_BYTES: 50 * 1024 * 1024,
      READ_FILES_MAX: 20,
      IMAGE_LONG_EDGE_PX: 2576,
      TEXT_MAX_CHARS: 400_000,
      CELLS_MAX: 60_000,
      STALE_READING_MINUTES: 15,
      AI_TIMEOUT_MS: 600_000,
      AI_MAX_RETRIES: 2,
      AI_MAX_TOKENS: 64_000,
      LIST_MAX: 30,
      ANSWER_MAX_LENGTH: 200,
      TABLE_ROWS_MAX: 20_000,
    });
  });

  it('P19.15-T3 AC-1 reads the five kinds the spec names, ZIPs unpacked into them', () => {
    expect(INTAKE_FILE_KINDS).toEqual(['xlsx', 'csv', 'pdf', 'image', 'docx']);
  });

  it('P19.15-T3 AC-2 AC-3 names every kind of card, state and question the spec lists', () => {
    expect(INTAKE_STATUSES).toEqual(['reading', 'needs_answers', 'ready', 'applied', 'rejected', 'failed']);
    expect(INTAKE_ITEM_KINDS).toEqual([
      'premium_table', 'product_rules', 'illustration', 'new_product', 'withdrawn_product', 'field_change', 'percent_change',
    ]);
    expect(INTAKE_ITEM_STATUSES).toEqual(['needs_answers', 'ready', 'applied', 'rejected']);
    expect(INTAKE_QUESTION_KINDS).toEqual(['product', 'company', 'column', 'date', 'unknown_product', 'type_number', 'approve_rule', 'text', 'choice']);
  });
});

describe('P19.15-T2 the illustration’s bounds (§B.40)', () => {
  it('P19.15-T2 AC-1 AC-2 pins ILLUSTRATION: 3–6 benefits, 3 exclusions, 3 cash-value years, 2 samples within Rp1', () => {
    expect(ILLUSTRATION).toEqual({
      FILE_MAX_BYTES: 20 * 1024 * 1024,
      BENEFITS_MIN: 3,
      BENEFITS_MAX: 6,
      EXCLUSIONS_MAX: 3,
      CASH_VALUE_YEARS_MAX: 3,
      CHECK_SAMPLES: 2,
      CHECK_TOLERANCE_MINOR: 100,
      PLAN_MAX_LENGTH: 60,
    });
    expect(ILLUSTRATION_STATUSES).toEqual(['reading', 'draft', 'published', 'failed']);
    expect(ILLUSTRATION_CHECK_STATES).toEqual(['match', 'mismatch', 'unchecked']);
  });
});
