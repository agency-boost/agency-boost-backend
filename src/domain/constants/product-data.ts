/**
 * **Proposal data per insurer: premium tables, their rules and the calculation** (P19.15-T1, T4 AC-1; ADR-0258;
 * `metrics-and-definitions.md` §B.39). Every bound and window the premium tables, their upload, their three test
 * profiles, the Proposal tab's *Perlu dicek* and the agent's calculating card read, once, pinned by
 * `product-data.spec.ts`.
 */

/**
 * **How a premium table states its price** (the P1b spec's *What to upload*; ADR-0258 §4):
 *
 * - `per_mille` — a rate per Rp1.000 of the sum assured (or of the goal amount), a decimal (*12,35*);
 * - `per_plan` — a fixed **annual premium** for the plan, in minor units of the row's currency (health products);
 * - `per_band` — a rate per Rp1.000 that applies while the sum assured is inside the row's band (`bandMin`–`bandMax`).
 */
export const RATE_BASES = ['per_mille', 'per_plan', 'per_band'] as const;
export type RateBasis = (typeof RATE_BASES)[number];

/**
 * **A premium table version's state, derived and never stored** (ADR-0258 §2): `draft` — not activated; `scheduled` —
 * activated, its *Berlaku mulai* after today in Asia/Jakarta; `active` — the version in force today; `old` — superseded
 * by a later one, or past its *Berlaku sampai*; `off` — turned off.
 */
export const RATE_TABLE_STATUSES = ['draft', 'scheduled', 'active', 'old', 'off'] as const;
export type RateTableStatus = (typeof RATE_TABLE_STATUSES)[number];

/** Where a version came from (the contract's `source.type`): an upload of each kind, or *Unggah file*'s intake (D3). */
export const RATE_TABLE_SOURCES = ['xlsx', 'csv', 'pdf', 'intake'] as const;
export type RateTableSource = (typeof RATE_TABLE_SOURCES)[number];

/**
 * **What a column of an uploaded table may mean** (*Cocokkan kolom*; ADR-0258 §3): the price's attributes, its rate or
 * premium, its band, and `ignore` for a column the table does not need.
 */
export const RATE_COLUMN_ROLES = [
  'age', 'gender', 'smoker', 'plan', 'payTerm', 'currency', 'frequency', 'rate', 'premium', 'bandMin', 'bandMax', 'ignore',
] as const;
export type RateColumnRole = (typeof RATE_COLUMN_ROLES)[number];

/**
 * **A product's status on the Proposal tab** (P1b §1; ADR-0258 §8), in the list's default order: *Perlu dicek*, *Ketik
 * manual*, *Siap hitung*, then *Ditarik*.
 */
export const PRODUCT_DATA_STATUSES = ['check', 'manual', 'ready', 'withdrawn'] as const;
export type ProductDataStatus = (typeof PRODUCT_DATA_STATUSES)[number];

/** **Why a product is *Perlu dicek*** (P1b §1): its table ends soon, has gaps, or its product changed after it. */
export const PRODUCT_DATA_CHECK_REASONS = ['ending', 'gaps', 'changed'] as const;
export type ProductDataCheckReason = (typeof PRODUCT_DATA_CHECK_REASONS)[number];

/**
 * **A calculation's state on a card** (ADR-0258 §5): `ok`; `needs_amount` — nothing typed to calculate from;
 * `needs_input` — the insured's age or gender, which the table prices by, is missing; `missing_combination` — the
 * table has no row for it; `no_frequency` — the table prices no such *Cara bayar*; `age_outside` — the version's entry
 * ages or the pay term's maximum leave the insured out; `table_off` — the version the amounts came from is no longer in
 * force and nothing replaced it.
 */
export const CALC_STATES = [
  'ok', 'needs_amount', 'needs_input', 'missing_combination', 'no_frequency', 'age_outside', 'table_off',
] as const;
export type CalcState = (typeof CALC_STATES)[number];

/** **A card's one-line note** (P1 spec's *How it behaves*; P1b *Versions*), stored as a code the screen words. */
export const CALC_NOTES = ['up_rounded', 'rates_updated', 'table_off'] as const;
export type CalcNote = (typeof CALC_NOTES)[number];

/** **A limit a card's amounts fall outside** (P1 spec's *Limits*). */
export const CALC_LIMIT_KINDS = ['up_min', 'up_max', 'premium_min', 'premium_max'] as const;
export type CalcLimitKind = (typeof CALC_LIMIT_KINDS)[number];

/** **A gap a table leaves** (*Cek kelengkapan*), worded on the screen. */
export const RATE_GAP_KINDS = ['ages', 'combination', 'smoker', 'gender', 'plan', 'payTerm', 'currency'] as const;
export type RateGapKind = (typeof RATE_GAP_KINDS)[number];

export const PRODUCT_DATA = {
  /** *Uji 3 contoh*: the profiles typed from the official illustration before a version may be activated. */
  TEST_PROFILES: 3,
  /**
   * *"✓ when they match (within Rp1 rounding)"*: the most a test's result may differ from the illustration's premium, in
   * **rounding units** of its currency — Rp1 (100 sen) for IDR, one cent for USD (`ROUNDING_UNIT_MINOR`).
   */
  TEST_TOLERANCE_UNITS: 1,
  /** A premium is rounded to the nearest whole unit of its currency, half up: Rp1 is 100 sen, a cent is 1. */
  ROUNDING_UNIT_MINOR: { IDR: 100, USD: 1 },
  /** *Perlu dicek*: a table whose *Berlaku sampai* is within this many days of today, nothing scheduled after it. */
  CHECK_WINDOW_DAYS: 30,
  /**
   * *"The app recalculates about 300 ms after any change on the card"*: how long the agent's card waits after the last
   * keystroke in an amount before it saves, and so before the server calculates. The frontend's `PROPOSAL_RECALC_MS`.
   */
  RECALC_DEBOUNCE_MS: 300,
  /**
   * 2 MiB: the most an uploaded premium table may weigh. A full table — 100 ages × 2 genders × 2 smoker rates × 6 pay
   * terms is 2,400 rows, a large one 10,000 (`ROWS_MAX`) — is under 600 KB as CSV and smaller as a workbook. Refused
   * `413 ASSET_TOO_LARGE` before a byte is read; a workbook is unpacked within `SPREADSHEET`'s limits as every import is.
   */
  UPLOAD_MAX_BYTES: 2 * 1024 * 1024,
  /** The most data rows a table may hold, its header aside: `SPREADSHEET.MAX_ROWS`, the same ten thousand. */
  ROWS_MAX: 10_000,
  /** The rows of a draft's file answered as a preview under *Cocokkan kolom*. */
  PREVIEW_ROWS: 5,
  /** A rate's decimals: a rate per Rp1.000 is held to six (`0,000001`), and computed exactly in integer micros. */
  RATE_DECIMALS: 6,
  /** The largest rate per Rp1.000 a row may hold: a premium of the whole sum assured is 1.000. */
  RATE_MAX: 1_000,
  /** A *Cara bayar* factor against the annual premium (*0,0875* a month): above zero, at most this. */
  FACTOR_MAX: 1.5,
  /** The written reason that activates a version whose three profiles do not all match. */
  OVERRIDE_REASON_MAX: 500,
  /** *Cek kelengkapan*'s list: the gaps answered in full; past it, the count of the rest. */
  GAPS_MAX: 50,
  /** Problems with the file's cells answered at once, each with its row and column. */
  PROBLEMS_MAX: 20,
  /** The sheet of the template that carries the product's rules (P1b *Tabel premi*). */
  KETENTUAN_SHEET: 'Ketentuan',
  /** A file name kept with the version, as uploaded, trimmed to this. */
  FILE_NAME_MAX: 200,
} as const;
