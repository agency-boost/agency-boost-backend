/**
 * **The proposal's constants that P19.7-T1 writes** (ADR-0224, ADR-0225; `metrics-and-definitions.md` §B.34): the
 * client's age a lead may carry, and the bounds a company's catalogue holds a product's proposal fields to. The page
 * and field bounds are what make the PDF's two pages provable (ADR-0223 §5): **raising one means running the
 * worst-case PDF test again.** P19.7-T2 and T3 added their own (`ITEMS_MAX`, `PAYMENTS_PER_YEAR`, the PDF's pages,
 * sizes and concurrency) here with what reads them.
 *
 * Documented once in §B.34 and pinned by `proposal.spec.ts`. The frontend re-declares none of it but the two age
 * bounds and the field counts its editors stop at, each held to the API document by `contract.spec.ts`.
 */

/**
 * **The client's age at the next birthday** (*Umur ulang tahun berikutnya*; ADR-0224 §3): what a lead, a *Klien baru*
 * or an insured may be given. Outside it, `422 LEAD_AGE_OUT_OF_RANGE` with `details: { min, max }`.
 */
export const LEAD_AGE = { MIN: 1, MAX: 100 } as const;

/** **A lead's gender** (ADR-0224 §1): ADR-0158's two values, *Laki-laki* and *Perempuan* on screen; or `null`. */
export { GENDERS as LEAD_GENDERS, type Gender as LeadGender } from './personal-data';

/** How a proposal field is drawn (ADR-0225 §1): one-tap choices, a money box, or a sentence. */
export const PROPOSAL_FIELD_TYPES = ['chips', 'money', 'fixed'] as const;
export type ProposalFieldType = (typeof PROPOSAL_FIELD_TYPES)[number];

/** Page 2's detail blocks (ADR-0225 §1; the spec's *Manfaat utama, Jadwal, Masa, Yang tidak ditanggung, Nilai tunai*). */
export const PDF_DETAIL_BLOCKS = ['manfaat', 'jadwal', 'masa', 'pengecualian', 'nilai_tunai'] as const;
export type PdfDetailBlockKind = (typeof PDF_DETAIL_BLOCKS)[number];

/** Who a product insures unless the agent says otherwise (ADR-0225 §1). */
export const PROPOSAL_DEFAULT_INSURED = ['client', 'child'] as const;
export type ProposalDefaultInsured = (typeof PROPOSAL_DEFAULT_INSURED)[number];

/**
 * **The bounds a product's proposal fields are held to** (ADR-0225 §2, §4; §B.34). Each refused, past it, with `400
 * VALIDATION_FAILED` naming the field's path.
 */
export const PROPOSAL = {
  /** Proposal fields per product, *Tertanggung* and the premium not counted. The Prudential draft's largest is 6. */
  FIELDS_MAX: 8,
  /** `showOnSummary` fields per product, printed on page 1 (the spec's *"2–4 key numbers"*). */
  SUMMARY_FIELDS_MAX: 4,
  /** Options of one `chips` field. The Prudential draft's largest is 5. */
  CHIP_OPTIONS_MAX: 8,
  /** Quick amounts of one `money` field (the spec's *"100 jt · 250 jt · 500 jt · 1 M"*). */
  QUICK_AMOUNTS_MAX: 4,
  /** Plan cards per product (PRUWell Medical has five). */
  PLAN_OPTIONS_MAX: 8,
  /** Highlights on one plan card (the spec's *"the 3–4 numbers that matter most"*). */
  PLAN_HIGHLIGHTS_MAX: 4,
  /** Questions in a product's FAQ, the company's or an office's. */
  FAQ_MAX: 20,
  /** Rows of one `pdfDetail` block. */
  PDF_DETAIL_ROWS_MAX: 8,
  /** Rows of the *Yang tidak ditanggung* block (the spec's *"the 3 key exclusions"*). */
  EXCLUSIONS_MAX: 3,
  /** Characters of one `pdfDetail` formula. */
  FORMULA_MAX_LENGTH: 120,
  /** A `paymentYears` option's `years`: a whole number of years, from 1 to this. */
  PAYMENT_YEARS_MAX: 99,

  // ---- P19.7-T2: the proposal itself (ADR-0221; §B.34) ----

  /** Products in one proposal (ADR-0221 §1; the spec's *"also with 4 products"*). A sixth is `400`. */
  ITEMS_MAX: 5,
  /** Benefits an item copies from the product for page 2 (ADR-0223 §4; the spec's *"Up to 4 key benefits"*). */
  BENEFITS_ON_PDF_MAX: 4,
  /** *Total dibayar*'s payments a year for each *Cara bayar* (the spec's *"premium × payments per year × years"*). */
  PAYMENTS_PER_YEAR: { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 },
  /** *Riwayat*'s page: 20 rows unless asked, at most 50 (ADR-0221 §5). */
  LIST_PAGE_SIZE: 20,
  LIST_PAGE_SIZE_MAX: 50,
  /** Characters of *Riwayat*'s search box (ADR-0221 §5). */
  SEARCH_MAX_LENGTH: 120,
  /** An insured's name under *Pasangan*, *Anak* or *Orang lain*: a lead's name bound (`LEAD_BOUNDS.name.max`). */
  INSURED_NAME_MAX: 120,
  /**
   * **The largest premium one item takes**, in minor units of its currency: Rp 10 miliar (USD 10 billion) a payment.
   * Kept so that *Total dibayar* — the premium × 12 × 99 years — stays a safe integer (invariant §9).
   */
  PREMIUM_MAX_MINOR: 1_000_000_000_000,
  /** **The largest money field value** (a sum assured, a target), minor units: Rp 10 triliun. Five sum to a safe integer. */
  MONEY_MAX_MINOR: 1_000_000_000_000_000,

  // ---- P19.7-T3: the PDF (ADR-0222, ADR-0223; §B.34) ----

  /** **A4 pages, always**: *Ringkasan*, then *Rincian* (ADR-0223 §1; the owner's *"two A4 pages at most"*). */
  PDF_PAGES: 2,
  /** **The smallest text on the PDF**, in points, but the footer's (the spec's *"Body ≥ 11pt when printed"*). */
  PDF_BODY_MIN_PT: 11,
  /** *Dibuat dengan AgencyBoost*, in points: the spec's *"small grey"* (ADR-0223 §2). */
  PDF_FOOTER_PT: 8,
  /** **PDFs built at once in one API process**; others wait their turn (ADR-0222 §3; the 512 MB container). */
  PDF_CONCURRENCY: 2,
  /** Characters of the client's name in `Proposal-{Nama}-{tanggal}.pdf` (ADR-0222 §6). */
  FILE_NAME_CLIENT_MAX: 60,
} as const;

/** ***Konvensional / Syariah*** (ADR-0221 §1, §9): `conventional` by default. */
export const PROPOSAL_CHANNELS = ['conventional', 'syariah'] as const;
export type ProposalChannel = (typeof PROPOSAL_CHANNELS)[number];

/** ***Cara bayar*** (ADR-0221 §1): *Bulanan · Kuartalan · Semesteran · Tahunan*, `monthly` by default. */
export const PROPOSAL_PAY_FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const;
export type ProposalPayFrequency = (typeof PROPOSAL_PAY_FREQUENCIES)[number];

/** *Draf* or *Selesai* (ADR-0221 §1): a proposal is *Selesai* from *Simpan PDF* until its next change. */
export const PROPOSAL_STATUSES = ['draft', 'done'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** ***Tertanggung*** (ADR-0221 §1): *Klien · Pasangan · Anak · Orang lain*. Anyone but *Klien* has a name and an age. */
export const PROPOSAL_INSURED_RELATIONS = ['client', 'spouse', 'child', 'other'] as const;
export type ProposalInsuredRelation = (typeof PROPOSAL_INSURED_RELATIONS)[number];

/**
 * **Why a product may not be added** (ADR-0225 §7): `422 PROPOSAL_PRODUCT_WITHDRAWN`'s `details.reason`. Another
 * company's product is `not_on_shelf`, and says nothing of it.
 */
export const PROPOSAL_REFUSAL_REASONS = ['withdrawn', 'closed', 'rider', 'not_on_shelf', 'channel', 'age'] as const;
export type ProposalRefusalReason = (typeof PROPOSAL_REFUSAL_REASONS)[number];

/**
 * **The age band holding a client's age** (ADR-0225 §7; §B.34, *The age band*): `PRODUCT_AGE_BAND_LABELS`' bands —
 * *< 25*, *25–34*, *35–49*, *50–64*, *65+* — by their lower bounds. The backend's one reading; the catalogue filters
 * by it, and `proposal.spec.ts` holds it to the labels.
 */
export const PRODUCT_AGE_BAND_FLOORS: Readonly<Record<number, number>> = { 1: 0, 2: 25, 3: 35, 4: 50, 5: 65 };

export function ageBandOf(age: number): number {
  let band = 1;
  for (const [key, floor] of Object.entries(PRODUCT_AGE_BAND_FLOORS)) {
    if (age >= floor) band = Number(key);
  }
  return band;
}

/**
 * **The longest text each proposal field holds** (ADR-0225 §2), in characters, each plain text — markup taken out
 * (P19-T6's validator) — and one line but an FAQ answer, which keeps its line breaks.
 */
export const PROPOSAL_TEXT_MAX = {
  /** A field's `label`, and its `labelSyariah`. */
  FIELD_LABEL: 60,
  /** A `chips` or `fixed` option's label. */
  OPTION_LABEL: 40,
  /** A plan's `name`: one of the `plan` field's option labels. */
  PLAN_NAME: 40,
  /** A highlight's `label` on a plan card. */
  HIGHLIGHT_LABEL: 30,
  /** A highlight's `value` on a plan card. */
  HIGHLIGHT_VALUE: 40,
  /** An FAQ question. */
  FAQ_QUESTION: 200,
  /** An FAQ answer, line breaks kept. */
  FAQ_ANSWER: 1000,
  /** A `pdfDetail` row's label. */
  DETAIL_LABEL: 80,
  /** A `pdfDetail` row's note, and its text where it has no formula. */
  DETAIL_NOTE: 40,
  /** A `pdfDetail` block's source file name. */
  SOURCE_FILE: 120,
  /** `syariahName`. */
  SYARIAH_NAME: 80,
  /** `proposalTypeLabel`, printed in capitals. */
  TYPE_LABEL: 30,
} as const;

/** **A field's key** (ADR-0225 §2): lower case, a letter first, at most 40 characters, unique in its product. */
export const PROPOSAL_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** **Two keys no field may take** (ADR-0225 §2): *Tertanggung* and the premium, which every panel has. */
export const PROPOSAL_RESERVED_KEYS = ['insured', 'premium'] as const;

/**
 * **The PDF's type label where a product sets none** (ADR-0225 §1, by category; OD-273's default), stored as typed and
 * printed in capitals.
 */
export const PROPOSAL_TYPE_LABEL_BY_CATEGORY = {
  life: 'JIWA',
  health: 'KESEHATAN',
  ci: 'PENYAKIT KRITIS',
  education: 'DANA PENDIDIKAN',
  investment: 'INVESTASI',
} as const;

/** **Who a product insures where it sets nobody** (ADR-0225 §1): *Anak* for an education product, else *Klien*. */
export function defaultInsuredFor(category: string): ProposalDefaultInsured {
  return category === 'education' ? 'child' : 'client';
}
