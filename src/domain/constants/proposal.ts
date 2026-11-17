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

/**
 * How a proposal field is drawn (ADR-0225 §1): one-tap choices, a money box, or a sentence. *Since 2026-11-12
 * (P19.14-T2; ADR-0255 §3):* **`derived`** — plain text worked out from other fields by the product's `planRule`
 * (*Plan "Silver A"* from *Wilayah* + *Kamar*), never chosen; its options are the values the rule may give.
 */
export const PROPOSAL_FIELD_TYPES = ['chips', 'money', 'fixed', 'derived'] as const;
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
  /**
   * Options of one `chips` field. *Raised 2026-11-12 from 8 (P19.14-T2; ADR-0255 §9):* the Prudential list of 11 November's
   * largest is 11 (PRUCerah's *Masa tunggu*, 8 to 18 years). A chips field prints one value, so the PDF's bounds do not move.
   */
  CHIP_OPTIONS_MAX: 12,
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

  // ---- P19.7-T3: the PDF (ADR-0222; §B.34) — *redrawn 2026-11-12 by P19.14-T3 (ADR-0256, superseding ADR-0223)* ----

  /**
   * **A4 pages with two products or more: exactly two**, never more (ADR-0256 §1; the 11 Nov spec's *"1 product = 1
   * page. 2 or more products = 2 pages. Never more."*). Page 1 the overview, page 2 *Rincian program*.
   */
  PDF_PAGES: 2,
  /** **A4 pages with one product: one** (ADR-0256 §1), the agent and the disclaimer on it. */
  PDF_PAGES_ONE_PRODUCT: 1,
  /** **Body text**, in points, at least (ADR-0256 §2; the 11 Nov spec's *"body text at least 12 pt"*). */
  PDF_BODY_MIN_PT: 12,
  /** **Labels** — captions, pills, the footer — in points, at least (*"labels at least 10 pt"*): nothing is smaller. */
  PDF_LABEL_MIN_PT: 10,
  /** **A product's name**, in points, at least (*"product names at least 15 pt"*). */
  PDF_PRODUCT_NAME_MIN_PT: 15,
  /** **A premium and the total**, in points, at least (*"premiums at least 18 pt"*). */
  PDF_PREMIUM_MIN_PT: 18,
  /** **The client's name**, in points, at least (*"the client's name at least 24 pt"*). */
  PDF_CLIENT_NAME_MIN_PT: 24,
  /** **Rows a page-2 box starts with**, most important first: 7 with two products, 5 with three or more (*"5–7"*). */
  PDF_BOX_ROWS_FEW: 7,
  PDF_BOX_ROWS_MANY: 5,
  /** **The one-product card's rows**, in two columns (*"up to 8 benefit rows"*). */
  PDF_HERO_ROWS_MAX: 8,
  /** *Perlindungan Anda*'s boxes (*"up to 3"*), *Yang perlu diketahui*'s facts (*"2 short facts"*), the need tiles (*"up to 4"*). */
  PDF_PROTECTION_MAX: 3,
  PDF_FACTS_MAX: 2,
  PDF_NEED_TILES_MAX: 4,
  /** **The light tints**: the main colour at 7 % and 14 % over white (*"main colour at 7–14% on white"*). */
  PDF_TINT_LIGHT: 0.07,
  PDF_TINT_STRONG: 0.14,
  /** **PDFs built at once in one API process**; others wait their turn (ADR-0222 §3; the 512 MB container). */
  PDF_CONCURRENCY: 2,
  /** Characters of the client's name in `Proposal-{Nama}-{tanggal}.pdf` (ADR-0222 §6). */
  FILE_NAME_CLIENT_MAX: 60,
} as const;

/*
 * *Removed 2026-11-12 (P19.14-T2; ADR-0255 §1):* `PROPOSAL_CHANNELS` — the proposal-wide *Konvensional / Syariah*
 * switch. A syariah product is a product of its own (`products.channel: 'syariah'`), read as `isSyariah`.
 */

/**
 * ***Cara bayar***, **per product** (ADR-0221 §1; *since 2026-11-12, P19.14-T2, ADR-0255 §2:* each item's own, from its
 * product's `frequencies`): *Bulanan · Kuartalan · Semesteran · Tahunan*, and ***Sekali bayar*** (`single`) for a
 * single-premium product or pay term. `monthly` by default where the product allows it.
 */
export const PROPOSAL_PAY_FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'single'] as const;
export type ProposalPayFrequency = (typeof PROPOSAL_PAY_FREQUENCIES)[number];

/** **The four periodic ones**: what a product offers where its catalogue names no `frequencies` (ADR-0255 §2). */
export const PROPOSAL_PERIODIC_FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const;
export type ProposalPeriodicFrequency = (typeof PROPOSAL_PERIODIC_FREQUENCIES)[number];

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
export const PROPOSAL_REFUSAL_REASONS = ['withdrawn', 'closed', 'rider', 'not_on_shelf', 'age'] as const;
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

// ------------------------------------------------------------------------------------------------ P19.14 (ADR-0254, ADR-0255)

/**
 * **How a product's amounts are worked out** (P19.14-T2; ADR-0255 §4; the 11 Nov spec's *Premium and UP*): the
 * catalogue's `calcType`. It decides which amounts the agent's card shows — `up_premium` the sum assured and the premium
 * side by side, every other the premium — and, once 19.15 loads a premium table, which one the app fills. **Until a
 * product has a table (`rateTableId: null`) every product is `manual`**: the agent types the premium.
 */
export const PROPOSAL_CALC_TYPES = ['up_premium', 'goal', 'premium_benefit', 'plan_priced', 'manual'] as const;
export type ProposalCalcType = (typeof PROPOSAL_CALC_TYPES)[number];

/** **Which amount the agent typed last**, the one a calculation keeps (ADR-0255 §4): `none` while nothing calculates. */
export const PROPOSAL_FIXED_FIELDS = ['up', 'premium', 'goal', 'none'] as const;
export type ProposalFixedField = (typeof PROPOSAL_FIXED_FIELDS)[number];

/** ***Status*** in *Detail klien* (ADR-0254 §3): *Lajang* or *Menikah*. */
export const PROPOSAL_CLIENT_STATUSES = ['single', 'married'] as const;
export type ProposalClientStatus = (typeof PROPOSAL_CLIENT_STATUSES)[number];

/**
 * ***Yang dibahas*** (ADR-0254 §3), in the spec's order: *Biaya rumah sakit · Penghasilan saat sakit kritis · Santunan
 * keluarga · Dana pendidikan · Dana masa depan / pensiun · Lainnya* — `OTHER` with its own words (`needsOther`).
 */
export const PROPOSAL_CLIENT_NEEDS = ['HOSPITAL', 'CRITICAL_INCOME', 'FAMILY', 'EDUCATION', 'FUTURE', 'OTHER'] as const;
export type ProposalClientNeed = (typeof PROPOSAL_CLIENT_NEEDS)[number];

/**
 * **The need a product ticks** (`needTag`; ADR-0255 §5): the PDF's need tiles, one per need the client may discuss but
 * *Lainnya* — so a product and a client's *Yang dibahas* speak of the same five needs.
 */
export const PROPOSAL_NEED_TAGS = ['HOSPITAL', 'CRITICAL_INCOME', 'FAMILY', 'EDUCATION', 'FUTURE'] as const;
export type ProposalNeedTag = (typeof PROPOSAL_NEED_TAGS)[number];

/**
 * **A product's need where its catalogue sets none** (ADR-0255 §5): from its first `primaryNeeds` that maps, else its
 * category. *Accident* is a health need; *legacy* a family one; *investment* and *retirement* the future.
 */
const NEED_TAG_OF_NEED: Readonly<Record<string, ProposalNeedTag>> = {
  health: 'HOSPITAL', accident: 'HOSPITAL', ci: 'CRITICAL_INCOME', 'life-protection': 'FAMILY', legacy: 'FAMILY',
  education: 'EDUCATION', investment: 'FUTURE', retirement: 'FUTURE',
};
const NEED_TAG_OF_CATEGORY: Readonly<Record<string, ProposalNeedTag>> = {
  life: 'FAMILY', health: 'HOSPITAL', ci: 'CRITICAL_INCOME', education: 'EDUCATION', investment: 'FUTURE',
};
export function needTagFor(category: string, primaryNeeds: readonly string[] = []): ProposalNeedTag {
  for (const need of primaryNeeds) if (NEED_TAG_OF_NEED[need]) return NEED_TAG_OF_NEED[need];
  return NEED_TAG_OF_CATEGORY[category] ?? 'FAMILY';
}

/**
 * **The bounds of the client's details on a proposal** (ADR-0254 §3), in characters, each one line of plain text: what
 * *Detail klien* takes and the PDF prints only when filled.
 */
export const PROPOSAL_CLIENT_TEXT_MAX = {
  /** *Tanggungan*, e.g. *"Istri, 2 anak"*. */
  DEPENDANTS: 80,
  OCCUPATION: 60,
  CITY: 60,
  /** *Lainnya*'s words under *Yang dibahas*. */
  NEEDS_OTHER: 80,
} as const;

/**
 * **The bounds of a product's calculation fields** (ADR-0255 §5): what the catalogue holds a product's pay terms and
 * its plan rule to. Each refused, past it, with `400 VALIDATION_FAILED` naming the path.
 */
export const PROPOSAL_CATALOGUE = {
  /** Pay terms per product (PRU Heritage Syariah has five). */
  PAY_TERMS_MAX: 8,
  /** A pay term's label (*"10 tahun"*, *"s/d usia 60"*, *"Diperbarui tiap tahun s/d usia 99"*). */
  PAY_TERM_LABEL_MAX: 60,
  /** The rules of one `planRule` (PRUWell Medical's has ten: five regions × two rooms). */
  PLAN_RULES_MAX: 24,
  /** The conditions of one rule (*Wilayah* and *Kamar*). */
  PLAN_RULE_WHEN_MAX: 4,
  /** The oldest an age bound may say — the oldest age at the next birthday a proposal takes (`LEAD_AGE.MAX`). */
  AGE_MAX: 100,
} as const;

/** **A pay term's key** (ADR-0255 §2): as a field's — lower case, a letter first — and unique in its product. */
export const PROPOSAL_PAY_TERM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
