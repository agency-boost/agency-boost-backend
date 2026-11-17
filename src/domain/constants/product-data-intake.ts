/**
 * **P19.15-T2, T3 — *Unggah file* and the illustration** (ADR-0259; `metrics-and-definitions.md` §B.40): the bounds of
 * an upload, how long a reading may be *Sedang dibaca* before it is reported failed, and the illustration's blocks.
 * Each value is pinned by `product-data-intake.spec.ts`; the screens read them from the API, never re-declare them.
 */

import { PRODUCT_DATA } from './product-data';

/** What an upload may hold, and what one reading is allowed (ADR-0259 §2). */
export const INTAKE = {
  /** Files chosen in one upload, a ZIP counting as one. */
  FILES_MAX: 10,
  /** One file as uploaded, a ZIP included: 20 MiB. The browser's form is refused past it before a byte is read. */
  FILE_MAX_BYTES: 20 * 1024 * 1024,
  /** Everything one upload carries, together: 50 MiB. */
  UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
  /** The files a ZIP may hold. A ZIP inside a ZIP is refused, whatever its size. */
  ZIP_ENTRIES_MAX: 20,
  /** What a ZIP's files may add up to, unpacked, as its own directory declares them: 50 MiB. */
  ZIP_UNPACKED_MAX_BYTES: 50 * 1024 * 1024,
  /** The files one upload is read as, after its ZIPs are unpacked. */
  READ_FILES_MAX: 20,
  /**
   * **A picture's longest side as it is sent** (2576 px): the most Claude Opus 5.5 reads in full. A photo larger than
   * that is scaled down, never up, before it is sent — the model would scale it down itself, at the same cost.
   */
  IMAGE_LONG_EDGE_PX: 2576,
  /**
   * **The text a spreadsheet, a CSV or a Word file is sent as, at most** (400,000 characters, about 120,000 tokens):
   * a premium table of 1,320 rows by ten columns is about a third of it. Past it the file is not read and its card
   * says why, rather than send part of a table.
   */
  TEXT_MAX_CHARS: 400_000,
  /** A spreadsheet's cells sent, at most, across its sheets: the same bound counted in cells. */
  CELLS_MAX: 60_000,
  /**
   * **A reading still *Sedang dibaca* this long after it started is reported failed** (15 minutes) on the next read:
   * the reading runs in the API's own process, and a process that restarted mid-reading leaves nothing to finish it.
   */
  STALE_READING_MINUTES: 15,
  /** One call to Claude: at most 10 minutes, as the SDK's own default. */
  AI_TIMEOUT_MS: 10 * 60 * 1000,
  /** Retries the SDK makes on a 408, 409, 429 or 5xx, and on a lost connection — its default. */
  AI_MAX_RETRIES: 2,
  /** The most a reading answers, in tokens: streamed, so the long answer of a long table is never cut by a timeout. */
  AI_MAX_TOKENS: 64_000,
  /** The intakes a list shows, newest first. */
  LIST_MAX: 30,
  /** An answer typed into a question card, at most. */
  ANSWER_MAX_LENGTH: 200,
  /** The rows of one premium table an item may carry: twice the 1,320 the spec's example names, and then some. */
  TABLE_ROWS_MAX: 20_000,
} as const;

/** What an upload's file is read as, after its bytes are checked (ADR-0259 §2). */
export const INTAKE_FILE_KINDS = ['xlsx', 'csv', 'pdf', 'image', 'docx'] as const;
export type IntakeFileKind = (typeof INTAKE_FILE_KINDS)[number];

/** An upload's state: stored, and recomputed from its items after every answer, confirm and reject. */
export const INTAKE_STATUSES = ['reading', 'needs_answers', 'ready', 'applied', 'rejected', 'failed'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** **What one item found in a file is** (the P1b spec §0, *kind of update*). */
export const INTAKE_ITEM_KINDS = [
  'premium_table', 'product_rules', 'illustration', 'new_product', 'withdrawn_product', 'field_change', 'percent_change',
] as const;
export type IntakeItemKind = (typeof INTAKE_ITEM_KINDS)[number];

export const INTAKE_ITEM_STATUSES = ['needs_answers', 'ready', 'applied', 'rejected'] as const;
export type IntakeItemStatus = (typeof INTAKE_ITEM_STATUSES)[number];

/**
 * **A question card's kind** (the P1b spec §0, *Asks instead of guessing*): which product, which company, what a column
 * means, from when, a product the catalogue does not have, a number that must be typed, a percentage that needs an
 * explicit approval, and a short text (a new product's code).
 */
export const INTAKE_QUESTION_KINDS = [
  'product', 'company', 'column', 'date', 'unknown_product', 'type_number', 'approve_rule', 'text', 'choice',
] as const;
export type IntakeQuestionKind = (typeof INTAKE_QUESTION_KINDS)[number];

/**
 * **What a rules item may change** (ADR-0259 §4): the rule names D1's rate table carries (ADR-0258), and the four the
 * catalogue keeps. A value the model names outside this list is never applied; its card says so.
 */
export const INTAKE_RULE_KEYS = [
  'upStep', 'upMin', 'upMax', 'premiumMin', 'premiumMax', 'entryAgeMin', 'entryAgeMax', 'payTermMaxAge',
  'frequencyFactor',
] as const;
export type IntakeRuleKey = (typeof INTAKE_RULE_KEYS)[number];

export const INTAKE_FIELD_KEYS = ['name', 'smokerRated', 'frequencies', 'optionAdded', 'optionRemoved'] as const;
export type IntakeFieldKey = (typeof INTAKE_FIELD_KEYS)[number];

/** The illustration's state: being read, a draft the Super Admin checks, published, or a reading that failed. */
export const ILLUSTRATION_STATUSES = ['reading', 'draft', 'published', 'failed'] as const;
export type IllustrationStatus = (typeof ILLUSTRATION_STATUSES)[number];

/** **The illustration's condensing** (P19.15-T2; the P1b spec §3 *Ilustrasi*). */
export const ILLUSTRATION = {
  /** One illustration's PDF: 20 MiB, the intake's file bound. */
  FILE_MAX_BYTES: 20 * 1024 * 1024,
  /** *Manfaat utama*: three to six benefits. */
  BENEFITS_MIN: 3,
  BENEFITS_MAX: 6,
  /** *Yang tidak ditanggung*: the three most important. */
  EXCLUSIONS_MAX: 3,
  /** *Nilai tunai*: up to three sample years, marked *tidak dijamin*. */
  CASH_VALUE_YEARS_MAX: 3,
  /** **A formula is checked against two numbers printed in the illustration** (AC-2): fewer, and it is *belum dicek*. */
  CHECK_SAMPLES: 2,
  /**
   * A computed amount matches a printed one within Rp1 (100 minor units): **the premium test's own tolerance**, derived
   * from it so the two checks cannot drift apart (§B.39, invariant §7).
   */
  CHECK_TOLERANCE_MINOR: PRODUCT_DATA.TEST_TOLERANCE_UNITS * PRODUCT_DATA.ROUNDING_UNIT_MINOR.IDR,
  /** The plan an illustration is for, at most. */
  PLAN_MAX_LENGTH: 60,
} as const;

/** How a formula's check came out: matched both numbers, matched not, or could not be checked. */
export const ILLUSTRATION_CHECK_STATES = ['match', 'mismatch', 'unchecked'] as const;
export type IllustrationCheckState = (typeof ILLUSTRATION_CHECK_STATES)[number];
