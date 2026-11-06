import type { ProductCurrency } from '@/domain/constants';

/**
 * **The Prudential proposal fields, as the owner drafted them on 3 November 2026** (P19.7-T1 AC-4; ADR-0225 §10;
 * `revisions/2026-11-03/files/proposal/proposal-fields-prudential-2026-11-03.md`; OD-273): the draft's 16 product rows,
 * mapped to the 18 product codes of the Prudential catalogue.
 *
 * **A draft, and marked so.** Every option or default the draft marks *[cek]* — still to be checked against
 * Prudential's official illustration tool — is a field with `draft: true`, which the Super Admin's editor shows as
 * *Perlu dicek* and no agent ever sees. **Where the draft names a field and no options** (*Masa bayar · chips [cek]*),
 * the field has one option, *"Sesuai ilustrasi resmi"*, with no years: drawn as plain text, it tells the agent where
 * the answer is, and invents no term the owner has not given. ★ is `showOnSummary`. A `fixed` field is its sentence.
 * *Mata uang* is the `currency` field, with only the options the product's own `currencies` allow. No `pdfDetail`: the
 * draft has none yet, and no quick amounts, which it does not give.
 *
 * Kept here, with the products module, rather than under `src/seed/` (as ADR-0225 §10 first wrote): the operator's
 * import runs from the API image, which ships `dist/` and never the seed's source (`tsconfig.build.json`), so the data
 * it imports must be in it. The demo seed reads the same rows.
 */

/** The import's name: what `proposalFieldsSource.import` records on each product it writes. */
export const PRUDENTIAL_PROPOSAL_IMPORT = 'prudential-2026-11-03';

/** The option an un-checked field holds until the owner gives its real ones (OD-273). */
export const CHECK_ILLUSTRATION = 'Sesuai ilustrasi resmi';

type RawOption = { label: string; years?: number | null; currency?: ProductCurrency | null };
type RawField = {
  key: string; label: string; labelSyariah?: string; type: 'chips' | 'money' | 'fixed'; options?: RawOption[];
  default?: string; minMinor?: number; showOnSummary?: boolean; paymentYears?: boolean; plan?: boolean;
  currency?: boolean; draft?: boolean;
};

/** One row of the draft: the codes it covers, its type label, and its fields for a product's currencies. */
export interface ProposalImportRow {
  /** The draft's own name for the row. */
  readonly row: string;
  readonly codes: readonly string[];
  readonly typeLabel: string;
  /** *Anak* where the draft says so (PRUCerah): every other row reads the category's. */
  readonly defaultInsured?: 'child';
  readonly fields: (currencies: readonly ProductCurrency[]) => RawField[];
}

const opts = (...labels: string[]): RawOption[] => labels.map((label) => ({ label }));

/** *[cek]* with no options given: the one honest option, no years. */
const toCheck = (key: string, label: string, over: Partial<RawField> = {}): RawField => ({
  key, label, type: 'chips', options: [{ label: CHECK_ILLUSTRATION, years: null }], default: CHECK_ILLUSTRATION,
  draft: true, ...over,
});

const masaBayarToCheck = (over: Partial<RawField> = {}) => toCheck('masa_bayar', 'Masa bayar', { paymentYears: true, ...over });

const merokok = (): RawField => ({ key: 'merokok', label: 'Merokok?', type: 'chips', options: opts('Tidak', 'Ya'), default: 'Tidak' });

/** *Mata uang* — *Rupiah / Dolar* — with only what the product sells (ADR-0225 §10). */
const mataUang = (currencies: readonly ProductCurrency[]): RawField => {
  const options = [{ label: 'Rupiah', currency: 'IDR' as const }, { label: 'Dolar', currency: 'USD' as const }]
    .filter((option) => currencies.includes(option.currency));
  return { key: 'mata_uang', label: 'Mata uang', type: 'chips', options, default: options[0]?.label, currency: true };
};

const money = (key: string, label: string, over: Partial<RawField> = {}): RawField => ({ key, label, type: 'money', ...over });

/** PRUWell Medical's fields, which PRUWell Health shares but for its own plan, sum and cover term. */
const wellCare = (): RawField[] => [
  { key: 'wilayah', label: 'Wilayah', type: 'chips', options: opts('Indonesia', 'Asia', 'Seluruh dunia'), default: 'Indonesia', showOnSummary: true, draft: true },
  { key: 'kamar', label: 'Kamar', type: 'chips', options: opts('1 tempat tidur', '2 tempat tidur'), default: '1 tempat tidur', showOnSummary: true },
  { key: 'saver', label: 'Saver', type: 'chips', options: opts('Tidak', 'Ya'), default: 'Tidak' },
];

export const PRUDENTIAL_PROPOSAL_ROWS: readonly ProposalImportRow[] = [
  {
    row: 'PRUWell Medical / Syariah',
    codes: ['PRUWELL_MEDICAL', 'PRUWELL_MEDICAL_SYARIAH'],
    typeLabel: 'KESEHATAN',
    fields: () => [
      // *Gold [cek]*: the default is the one to check.
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'), default: 'Gold', showOnSummary: true, plan: true, draft: true },
      ...wellCare(),
    ],
  },
  {
    row: 'PRUWell Health / Syariah',
    codes: ['PRUWELL_HEALTH', 'PRUWELL_HEALTH_SYARIAH'],
    typeLabel: 'KESEHATAN',
    fields: () => [
      toCheck('plan', 'Plan', { showOnSummary: true, plan: true }),
      ...wellCare(),
      money('up', 'Uang pertanggungan dasar', { labelSyariah: 'Santunan asuransi dasar', minMinor: 100_000_000_00 }),
      { key: 'masa_pertanggungan', label: 'Masa pertanggungan', type: 'chips', options: opts('s.d. usia 75', 's.d. usia 85', 's.d. usia 99'), default: 's.d. usia 75', draft: true },
    ],
  },
  {
    row: 'PRUSehat',
    codes: ['PRUSEHAT'],
    typeLabel: 'KESEHATAN',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('A', 'B'), default: 'A', showOnSummary: true, plan: true },
      masaBayarToCheck(),
    ],
  },
  {
    row: 'PRUCritical Benefit 88',
    codes: ['PRUCRITICAL_BENEFIT_88'],
    typeLabel: 'PENYAKIT KRITIS',
    fields: () => [
      // *sekaligus/… [cek]*: one option given, the rest to check.
      { key: 'masa_bayar', label: 'Masa bayar', type: 'chips', options: [{ label: 'Sekaligus', years: null }, { label: CHECK_ILLUSTRATION, years: null }], default: 'Sekaligus', paymentYears: true, draft: true },
      money('up', 'Uang pertanggungan', { labelSyariah: 'Santunan asuransi', showOnSummary: true }),
    ],
  },
  {
    row: 'PRUCritical Amanah (PCA)',
    codes: ['PRUCRITICAL_AMANAH'],
    typeLabel: 'PENYAKIT KRITIS',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('Basic', 'Plus'), default: 'Basic', showOnSummary: true, plan: true },
      masaBayarToCheck(),
      merokok(),
      money('santunan', 'Santunan asuransi', { showOnSummary: true }),
    ],
  },
  {
    row: 'PRUSolusi Kondisi Kritis Syariah (PKKS)',
    codes: ['PRUSOLUSI_KONDISI_KRITIS_SYARIAH'],
    typeLabel: 'PENYAKIT KRITIS',
    fields: () => [masaBayarToCheck(), money('santunan', 'Santunan asuransi', { showOnSummary: true })],
  },
  {
    row: 'PRUCinta',
    codes: ['PRUCINTA'],
    typeLabel: 'JIWA',
    fields: () => [
      // *fixed · 10 th [cek]*.
      { key: 'masa_bayar', label: 'Masa bayar', type: 'fixed', options: [{ label: '10 tahun', years: 10 }], paymentYears: true, draft: true },
      money('santunan', 'Santunan meninggal dunia', { showOnSummary: true }),
    ],
  },
  {
    row: 'PRU Anugerah Syariah',
    codes: ['PRUANUGERAH_SYARIAH'],
    typeLabel: 'JIWA',
    fields: () => [masaBayarToCheck(), money('santunan', 'Santunan asuransi', { showOnSummary: true })],
  },
  {
    row: 'PRUFuture',
    codes: ['PRUFUTURE'],
    typeLabel: 'WARISAN',
    fields: (currencies) => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('Basic', 'Waiver'), default: 'Basic', showOnSummary: true, plan: true },
      mataUang(currencies),
      merokok(),
      masaBayarToCheck(),
      money('up', 'Uang pertanggungan', { labelSyariah: 'Santunan asuransi', showOnSummary: true }),
    ],
  },
  {
    row: 'PRUHeritage Syariah',
    codes: ['PRUHERITAGE_SYARIAH'],
    typeLabel: 'WARISAN',
    fields: (currencies) => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('Essential'), default: 'Essential', showOnSummary: true, plan: true },
      mataUang(currencies),
      { key: 'masa_bayar', label: 'Masa bayar', type: 'chips', options: [{ label: 's.d. usia 60', years: null }, { label: 's.d. usia 99', years: null }], default: 's.d. usia 60', paymentYears: true },
      merokok(),
      money('santunan', 'Santunan asuransi', { showOnSummary: true }),
    ],
  },
  {
    row: 'PRUCerah / PRUCerah Plus',
    codes: ['PRUCERAH'],
    typeLabel: 'DANA PENDIDIKAN',
    defaultInsured: 'child',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('PRUCerah', 'PRUCerah Plus'), default: 'PRUCerah', showOnSummary: true, plan: true },
      // *Masa bayar · fixed · sama dengan masa tunggu*: the years are the waiting period's (ADR-0225 §2).
      toCheck('masa_tunggu', 'Masa tunggu', { showOnSummary: true, paymentYears: true }),
      { key: 'masa_bayar', label: 'Masa bayar', type: 'fixed', options: [{ label: 'Sama dengan masa tunggu' }] },
      money('penarikan_bulanan', 'Penarikan per bulan', { showOnSummary: true }),
    ],
  },
  {
    row: 'PRUTahapan Cemerlang',
    codes: ['PRUTAHAPAN_CEMERLANG'],
    typeLabel: 'DANA PENDIDIKAN',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('PRO', 'MAX'), default: 'PRO', showOnSummary: true, plan: true },
      { key: 'masa_bayar', label: 'Masa bayar', type: 'fixed', options: [{ label: 'Sesuai masa kepesertaan', years: null }], paymentYears: true },
      money('target_dana', 'Target dana', { showOnSummary: true }),
      toCheck('mpa', 'MPA'),
    ],
  },
  {
    row: 'PRUSmart Plan',
    codes: ['PRUSMART_PLAN'],
    typeLabel: 'DANA MASA DEPAN',
    fields: () => [
      // *6-Pay / 8-Pay*: the plan is the payment term, so it carries the years.
      { key: 'plan', label: 'Plan', type: 'chips', options: [{ label: '6-Pay', years: 6 }, { label: '8-Pay', years: 8 }], default: '6-Pay', showOnSummary: true, plan: true, paymentYears: true },
      money('penyisihan_bulanan', 'Penyisihan dana per bulan', { showOnSummary: true }),
    ],
  },
  {
    row: 'PRUMapan',
    codes: ['PRUMAPAN'],
    typeLabel: 'DANA PENSIUN',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('Berkala', 'Lumpsum & Berkala'), default: 'Berkala', showOnSummary: true, plan: true },
      masaBayarToCheck(),
      money('penyisihan_bulanan', 'Penyisihan dana per bulan', { showOnSummary: true }),
    ],
  },
  {
    row: 'PRU Prosper',
    codes: ['PRUPROSPER'],
    typeLabel: 'DANA MASA DEPAN',
    // The premium in USD is the product's own `currencies: ['USD']` (ADR-0225 §8), not a field.
    fields: () => [masaBayarToCheck()],
  },
  {
    row: 'PRULady',
    codes: ['PRULADY'],
    typeLabel: 'KHUSUS WANITA',
    fields: () => [
      { key: 'plan', label: 'Plan', type: 'chips', options: opts('Basic', 'Plus'), default: 'Basic', showOnSummary: true, plan: true },
      masaBayarToCheck(),
      money('up', 'Uang pertanggungan', { labelSyariah: 'Santunan asuransi', showOnSummary: true }),
    ],
  },
];
