import type { ProductCurrency, ProposalCalcType, ProposalNeedTag, ProposalPayFrequency } from '@/domain/constants';

/**
 * **The Prudential proposal fields of 11 November 2026** (P19.14-T2 AC-5; ADR-0255 §9;
 * `revisions/2026-11-13/files/proposal/product-fields-prudential.md`): every product's category, need, calculation type,
 * fields, pay terms with their maximum entry age, entry ages and smoker rating, mapped to the Prudential catalogue's
 * product codes. **It replaces the draft of 3 November** (`prudential-2026-11-03`, P19.7-T1), which the import
 * overwrites wherever a product still holds exactly what that draft wrote (`PRUDENTIAL_PROPOSAL_SUPERSEDES`).
 *
 * - **Checked field by field** by the owner, so no field is a *Perlu dicek* draft. **What the list marks *[cek]* stays
 *   unknown**: an entry age it does not give is `entryAge: null` (no limit), a pay term's maximum entry age it does not
 *   give is `maxEntryAge: null`. Nothing is invented.
 * - **The sum assured is no field** on an `up_premium` product: it is the item's `up`, beside the premium, so 19.15 can
 *   work either out from the other. **The premium is no field** either — *Penyisihan dana* and *Premi tahunan* are the
 *   premium (`premium_benefit`).
 * - **Every product is `manual` until a premium table is loaded** (`rateTableId: null`): `calcType` decides which amounts
 *   the card shows, never a figure.
 * - ★ is `showOnSummary`. The pay term in bold is `default`. *Cara bayar* is the four periodic ones unless a row says so.
 * - **PRUWell Medical's plan is derived** from *Wilayah* and *Kamar* (`planRule`), shown as text, *otomatis*.
 * - Kept with the products module, as the draft was: the operator's import runs from the API image, which ships `dist/`
 *   and never the seed's source, so the data it imports must be in it. The demo seed reads the same rows.
 */

/** The import's name: what `proposalFieldsSource.import` records on each product it writes. */
export const PRUDENTIAL_PROPOSAL_IMPORT = 'prudential-2026-11-11';

/**
 * **The imports this one replaces** (ADR-0255 §9): a product whose fields are still exactly what one of these wrote is
 * written again; one anybody edited since is skipped, never overwritten.
 */
export const PRUDENTIAL_PROPOSAL_SUPERSEDES: readonly string[] = ['prudential-2026-11-03'];

/**
 * **The one option the draft of 3 November gave a *[cek]* field with no options** (OD-273): a proposal made from it
 * still holds the text, and the PDF leaves it out. The list of 11 November writes it nowhere.
 */
export const CHECK_ILLUSTRATION = 'Sesuai ilustrasi resmi';

type RawOption = { label: string; years?: number | null; currency?: ProductCurrency | null };
type RawField = {
  key: string; label: string; labelSyariah?: string; type: 'chips' | 'money' | 'fixed' | 'derived'; options?: RawOption[];
  default?: string; minMinor?: number; quickAmounts?: number[]; showOnSummary?: boolean; paymentYears?: boolean;
  plan?: boolean; currency?: boolean; draft?: boolean;
};
type RawPayTerm = {
  key: string; label: string; years?: number | null; toAge?: number | null; single?: boolean; maxEntryAge?: number | null;
  default?: boolean;
};

/** One row of the list: the codes it covers, its words, its fields and its calculation fields. */
export interface ProposalImportRow {
  /** The list's own name for the row. */
  readonly row: string;
  readonly codes: readonly string[];
  readonly typeLabel: string;
  /** *Anak* where the list says so (education): every other row reads the category's. */
  readonly defaultInsured?: 'child';
  readonly fields: (currencies: readonly ProductCurrency[]) => RawField[];
  readonly calc: {
    calcType: ProposalCalcType;
    needTag: ProposalNeedTag;
    entryAge?: { min: number; max: number } | null;
    payTerms?: RawPayTerm[];
    frequencies?: ProposalPayFrequency[];
    smokerRated?: boolean;
    planRule?: { field: string; rules: { when: Record<string, string>; value: string }[] } | null;
    premiumMin?: number | null;
    premiumMax?: number | null;
  };
}

const opts = (...labels: string[]): RawOption[] => labels.map((label) => ({ label }));

/** *n tahun*, paid for `years`, offered up to `maxEntryAge` (`null` where the list gives none). */
const years = (n: number, maxEntryAge: number | null, isDefault = false): RawPayTerm =>
  ({ key: `y${n}`, label: `${n} tahun`, years: n, maxEntryAge, default: isDefault });

/** A term that is one sentence: the card shows it as text. */
const sentence = (key: string, label: string, over: Partial<RawPayTerm> = {}): RawPayTerm =>
  ({ key, label, default: true, ...over });

const RENEW_99 = sentence('renew_99', 'Diperbarui tiap tahun s/d usia 99', { toAge: 99 });

/** Two of the five that the monthly and annual *Cara bayar* leave (*PRUSmart Plan*, *PRUMapan*). */
const MONTHLY_ANNUAL: ProposalPayFrequency[] = ['monthly', 'annual'];

const JT = 1_000_000_00;

/** PRUWell's *Wilayah*, *Kamar* and *Saver*, and the plan they decide (PRUWell Medical, Health and their Syariah). */
const WILAYAH = ['Indonesia', 'Asia (kec. JPN, HK, SGP)', 'Seluruh Asia', 'Seluruh Dunia (kec. USA)', 'Seluruh Dunia'];
const KAMAR = ['2 tempat tidur', '1 tempat tidur'];
const wellCare = (): RawField[] => [
  { key: 'wilayah', label: 'Wilayah', type: 'chips', options: opts(...WILAYAH), default: 'Indonesia', showOnSummary: true },
  { key: 'kamar', label: 'Kamar', type: 'chips', options: opts(...KAMAR), default: '2 tempat tidur', showOnSummary: true },
  { key: 'saver', label: 'Saver', type: 'chips', options: opts('Tidak', 'Ya'), default: 'Tidak' },
];
const WELL_PLANS = ['Bronze A', 'Bronze B', 'Silver A', 'Silver B', 'Gold', 'Platinum', 'Diamond'];
const wellPlan = (): RawField => ({ key: 'plan', label: 'Plan', type: 'derived', options: opts(...WELL_PLANS), plan: true, showOnSummary: true });
/** *Indonesia → Bronze A/B, Asia kec. → Silver A/B, Seluruh Asia → Gold, Dunia kec. USA → Platinum, Dunia → Diamond (A = 2 beds, B = 1 bed)*. */
const WELL_RULE: { field: string; rules: { when: Record<string, string>; value: string }[] } = {
  field: 'plan',
  rules: [
    { when: { wilayah: WILAYAH[0], kamar: KAMAR[0] }, value: 'Bronze A' },
    { when: { wilayah: WILAYAH[0], kamar: KAMAR[1] }, value: 'Bronze B' },
    { when: { wilayah: WILAYAH[1], kamar: KAMAR[0] }, value: 'Silver A' },
    { when: { wilayah: WILAYAH[1], kamar: KAMAR[1] }, value: 'Silver B' },
    { when: { wilayah: WILAYAH[2] }, value: 'Gold' },
    { when: { wilayah: WILAYAH[3] }, value: 'Platinum' },
    { when: { wilayah: WILAYAH[4] }, value: 'Diamond' },
  ],
};

/** A plan chips field whose options name a currency, with only what the product sells (ADR-0225 §8). */
const planByCurrency = (currencies: readonly ProductCurrency[], options: RawOption[], fallback: string): RawField => {
  const sold = options.filter((o) => currencies.includes(o.currency as ProductCurrency));
  const both = currencies.length > 1;
  return {
    key: 'plan', label: 'Plan', type: 'chips',
    options: sold.map((o) => ({ label: o.label, currency: both ? o.currency : null })),
    default: sold.some((o) => o.label === fallback) ? fallback : sold[0]?.label,
    showOnSummary: true, plan: true, currency: both,
  };
};

/** *Masa tunggu* 8 to 18 years, 15 by default (PRUCerah and PRUCerah Plus). */
const masaTunggu = (): RawField => ({
  key: 'masa_tunggu', label: 'Masa tunggu', type: 'chips',
  options: Array.from({ length: 11 }, (_, i) => ({ label: `${8 + i} tahun`, years: 8 + i })),
  default: '15 tahun', showOnSummary: true,
});
const cerahTerms = (): RawPayTerm[] => [years(5, null, true), sentence('masa_tunggu', 'Sesuai masa tunggu', { default: false })];

export const PRUDENTIAL_PROPOSAL_ROWS: readonly ProposalImportRow[] = [
  {
    row: 'PRUWell Medical / Syariah',
    codes: ['PRUWELL_MEDICAL', 'PRUWELL_MEDICAL_SYARIAH'],
    typeLabel: 'KESEHATAN',
    fields: () => [...wellCare(), wellPlan()],
    calc: { calcType: 'plan_priced', needTag: 'HOSPITAL', entryAge: { min: 1, max: 75 }, payTerms: [RENEW_99], planRule: WELL_RULE },
  },
  {
    row: 'PRUWell Health / Syariah (rider on PRULink NextGen)',
    codes: ['PRUWELL_HEALTH', 'PRUWELL_HEALTH_SYARIAH'],
    typeLabel: 'KESEHATAN',
    fields: () => [
      {
        key: 'up_dasar', label: 'UP dasar', labelSyariah: 'Santunan asuransi dasar', type: 'money',
        minMinor: 100 * JT, quickAmounts: [100 * JT], showOnSummary: true,
      },
      {
        key: 'masa_dasar', label: 'Masa pertanggungan produk dasar', type: 'chips',
        options: opts('s/d usia 75', 's/d usia 85', 's/d usia 99'), default: 's/d usia 99',
      },
      ...wellCare(),
      {
        key: 'masa_pertanggungan', label: 'Masa pertanggungan PRUWell Health', type: 'chips',
        options: opts('s/d usia 55', 's/d usia 65', 's/d usia 75', 's/d usia 85', 's/d usia 99'), default: 's/d usia 75',
      },
      { ...wellPlan(), showOnSummary: false },
    ],
    // *[cek]*: the entry ages.
    calc: {
      calcType: 'plan_priced', needTag: 'HOSPITAL', entryAge: null, planRule: WELL_RULE,
      payTerms: [sentence('paydi', 'Premi berkala PRULink NextGen')],
    },
  },
  {
    row: 'PRUSehat',
    codes: ['PRUSEHAT'],
    typeLabel: 'KESEHATAN',
    fields: () => [{ key: 'plan', label: 'Plan', type: 'chips', options: opts('Plan Sehat A', 'Plan Sehat B'), default: 'Plan Sehat A', showOnSummary: true, plan: true }],
    calc: { calcType: 'plan_priced', needTag: 'HOSPITAL', entryAge: null, payTerms: [RENEW_99] },
  },
  {
    row: 'PCB88 (PRUCritical Benefit 88)',
    codes: ['PRUCRITICAL_BENEFIT_88'],
    typeLabel: 'PENYAKIT KRITIS',
    fields: () => [],
    calc: {
      calcType: 'up_premium', needTag: 'CRITICAL_INCOME', entryAge: { min: 1, max: 60 },
      payTerms: [years(5, 60), years(10, 60, true), years(15, 50), sentence('single', 'Sekali bayar', { single: true, maxEntryAge: 60, default: false })],
    },
  },
  {
    row: 'PCA (PRUCritical Amanah, syariah)',
    codes: ['PRUCRITICAL_AMANAH'],
    typeLabel: 'PENYAKIT KRITIS',
    fields: () => [{ key: 'plan', label: 'Plan', type: 'chips', options: opts('Basic', 'Plus'), default: 'Basic', showOnSummary: true, plan: true }],
    calc: {
      calcType: 'up_premium', needTag: 'CRITICAL_INCOME', entryAge: { min: 6, max: 60 }, smokerRated: true,
      payTerms: [years(5, 60), years(10, 55), years(15, 50, true)],
    },
  },
  {
    row: 'PKKS (PRUSolusi Kondisi Kritis Syariah)',
    codes: ['PRUSOLUSI_KONDISI_KRITIS_SYARIAH'],
    typeLabel: 'PENYAKIT KRITIS',
    fields: () => [],
    calc: {
      calcType: 'up_premium', needTag: 'CRITICAL_INCOME', entryAge: { min: 21, max: 70 },
      payTerms: [sentence('renew_99', 'Diperpanjang tiap tahun s/d usia 99', { toAge: 99 })],
    },
  },
  {
    row: 'PRUCinta',
    codes: ['PRUCINTA'],
    typeLabel: 'JIWA',
    fields: () => [],
    calc: {
      calcType: 'up_premium', needTag: 'FAMILY', entryAge: { min: 10, max: 60 },
      payTerms: [sentence('y10', 'Bayar 10 th · lindung 20 th', { years: 10 })],
    },
  },
  {
    row: 'PRU Anugerah Syariah',
    codes: ['PRUANUGERAH_SYARIAH'],
    typeLabel: 'JIWA',
    fields: () => [],
    calc: {
      calcType: 'up_premium', needTag: 'FAMILY', entryAge: { min: 21, max: 70 },
      payTerms: [years(5, 70), years(10, 60, true), years(15, 55)],
    },
  },
  {
    row: 'PRUCare 360 Syariah',
    codes: ['PRUCARE_360_SYARIAH'],
    typeLabel: 'JIWA',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('Prime', 'Classic'), default: 'Prime', showOnSummary: true, plan: true },
      { key: 'usia_non_produktif', label: 'Usia non-produktif', type: 'chips', options: opts('58', '65'), default: '65' },
    ],
    // *[cek]*: the maximum entry age of *Hingga usia non-produktif*.
    calc: {
      calcType: 'up_premium', needTag: 'FAMILY', entryAge: { min: 18, max: 53 },
      payTerms: [years(8, null, true), years(12, null), sentence('non_produktif', 'Hingga usia non-produktif', { default: false })],
    },
  },
  {
    row: 'PRUFuture',
    codes: ['PRUFUTURE'],
    typeLabel: 'WARISAN',
    fields: (currencies) => [planByCurrency(currencies, [
      { label: 'Basic (IDR)', currency: 'IDR' }, { label: 'Waiver (IDR)', currency: 'IDR' },
      { label: 'Basic (USD)', currency: 'USD' }, { label: 'Waiver (USD)', currency: 'USD' },
    ], 'Basic (IDR)')],
    // *[cek]*: the entry ages. The USD plans' terms are offered to 55 (OD-336): the IDR limits are kept here.
    calc: {
      calcType: 'up_premium', needTag: 'FAMILY', entryAge: null, smokerRated: true,
      payTerms: [years(5, 70), years(10, 65), years(15, 60, true)],
    },
  },
  {
    row: 'PRU Heritage Syariah',
    codes: ['PRUHERITAGE_SYARIAH'],
    typeLabel: 'WARISAN',
    fields: (currencies) => [planByCurrency(currencies, [
      { label: 'Essential (IDR)', currency: 'IDR' }, { label: 'Essential (USD)', currency: 'USD' },
    ], 'Essential (IDR)')],
    calc: {
      calcType: 'up_premium', needTag: 'FAMILY', entryAge: null, smokerRated: true,
      payTerms: [
        years(5, 70), years(10, 65), years(15, 60, true),
        { key: 'to_60', label: 's/d usia 60', toAge: 60, maxEntryAge: 45 },
        { key: 'to_99', label: 's/d usia 99', toAge: 99, maxEntryAge: 60 },
      ],
    },
  },
  {
    row: 'PRULady',
    codes: ['PRULADY'],
    typeLabel: 'KHUSUS WANITA',
    fields: () => [{ key: 'plan', label: 'Plan', type: 'chips', options: opts('Basic', 'Plus'), default: 'Plus', showOnSummary: true, plan: true }],
    calc: {
      calcType: 'up_premium', needTag: 'HOSPITAL', entryAge: null,
      payTerms: [years(5, 60), years(10, 55), years(15, 50, true)],
    },
  },
  {
    row: 'PRUCerah Plus',
    codes: ['PRUCERAH_PLUS'],
    typeLabel: 'DANA PENDIDIKAN',
    defaultInsured: 'child',
    fields: () => [{ key: 'penarikan_bulanan', label: 'Penarikan per bulan', type: 'money', showOnSummary: true }, masaTunggu()],
    // The entry ages are the parent's — the client's.
    calc: { calcType: 'goal', needTag: 'EDUCATION', entryAge: { min: 21, max: 55 }, payTerms: cerahTerms() },
  },
  {
    row: 'PRUCerah (non-Plus)',
    codes: ['PRUCERAH'],
    typeLabel: 'DANA PENDIDIKAN',
    defaultInsured: 'child',
    fields: () => [{ key: 'penarikan_bulanan', label: 'Penarikan per bulan', type: 'money', showOnSummary: true }, masaTunggu()],
    // No simulator seen: `manual` until its premium table exists. *[cek]*: the entry ages.
    calc: { calcType: 'manual', needTag: 'EDUCATION', entryAge: null, payTerms: cerahTerms() },
  },
  {
    row: 'PRU Tahapan Cemerlang',
    codes: ['PRUTAHAPAN_CEMERLANG'],
    typeLabel: 'DANA PENDIDIKAN',
    defaultInsured: 'child',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('PRO', 'MAX'), default: 'PRO', showOnSummary: true, plan: true },
      { key: 'target_dana', label: 'Target dana', type: 'money', showOnSummary: true },
      { key: 'mpa', label: 'MPA', type: 'chips', options: opts('15 tahun', '16 tahun', '17 tahun', '18 tahun'), default: '18 tahun', showOnSummary: true },
    ],
    // *[cek]*: the entry ages, and the MAX plan's limit of 45 on every term, which no term-level field holds (OD-336).
    calc: {
      calcType: 'goal', needTag: 'EDUCATION', entryAge: null,
      payTerms: [years(5, null, true), years(10, null), sentence('masa_kepesertaan', 'Sesuai masa kepesertaan', { default: false })],
    },
  },
  {
    row: 'PRUSmart Plan',
    codes: ['PRUSMART_PLAN'],
    typeLabel: 'DANA MASA DEPAN',
    fields: () => [{
      key: 'plan', label: 'Plan', type: 'chips', options: [{ label: '6-Pay', years: 6 }, { label: '8-Pay', years: 8 }],
      default: '6-Pay', showOnSummary: true, plan: true, paymentYears: true,
    }],
    // *Penyisihan dana* is the premium; the plan is the term (*6 or 8 th · lindung 20 th*). *From 21*: no upper bound given.
    calc: { calcType: 'premium_benefit', needTag: 'FUTURE', entryAge: { min: 21, max: 100 }, frequencies: MONTHLY_ANNUAL },
  },
  {
    row: 'PRUMapan',
    codes: ['PRUMAPAN'],
    typeLabel: 'DANA PENSIUN',
    fields: () => [{ key: 'plan', label: 'Plan', type: 'chips', options: opts('Berkala', 'Lumpsum & Berkala'), default: 'Berkala', showOnSummary: true, plan: true }],
    calc: {
      calcType: 'premium_benefit', needTag: 'FUTURE', entryAge: null, frequencies: MONTHLY_ANNUAL,
      payTerms: [sentence('to_55', 's/d usia 55', { toAge: 55 })],
    },
  },
  {
    row: 'PRU Prosper (Endowment USD)',
    codes: ['PRUPROSPER'],
    typeLabel: 'DANA MASA DEPAN',
    fields: () => [],
    // *Premi tahunan · USD 2.500–200.000 in steps of USD 100*: the premium, its limits in cents (no premium step field).
    calc: {
      calcType: 'premium_benefit', needTag: 'FUTURE', entryAge: { min: 1, max: 65 }, frequencies: ['annual'],
      payTerms: [sentence('y5', 'Bayar 5 th · lindung 15 th', { years: 5 })],
      premiumMin: 2_500_00, premiumMax: 200_000_00,
    },
  },
];
