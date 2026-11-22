import { PROPOSAL, PROPOSAL_CLIENT_TEXT_MAX, PROPOSAL_TEXT_MAX } from '@/domain/constants';
import { AGENCYBOOST_PDF_BRANDING, type PdfBranding } from '@/modules/proposals/proposal-branding';
import type {
  PdfClientSource, PdfDetailBlockSource, PdfFieldSource, PdfItemSource, PdfModelInput, PdfPayTermSource, PdfProposalSource,
} from '@/modules/proposals/proposal-pdf.model';

/**
 * **Proposals for the PDF's specs** (P19.14-T3): the stored shapes the file is built from (ADR-0254, ADR-0255), without a
 * database — the four products of the approved mockup (`revisions/2026-11-13/files/proposal/mockups/`), a syariah and a
 * USD product, and the worst case the catalogue allows: every bound at its maximum, the longest names.
 */

export const field = (over: Partial<PdfFieldSource> & Pick<PdfFieldSource, 'key' | 'label' | 'type'>): PdfFieldSource => ({
  labelSyariah: null, options: [], showOnPdf: true, showOnSummary: false, paymentYears: false, plan: false, ...over,
});
export const option = (label: string, years: number | null = null) => ({ label, years });
export const term = (key: string, label: string, over: Partial<PdfPayTermSource> = {}): PdfPayTermSource => ({
  key, label, years: null, toAge: null, single: false, ...over,
});
const text = (label: string, value: string, note: string | null = null) => ({ label, note, formula: null, text: value });
const rupiah = (whole: number) => whole * 100;

export function item(over: Partial<Omit<PdfItemSource, 'snapshot'>> & { snapshot?: Partial<PdfItemSource['snapshot']> } = {}): PdfItemSource {
  const { snapshot, ...rest } = over;
  return {
    insured: { relation: 'client', name: null, age: null },
    fieldValues: {},
    payFrequency: 'monthly',
    payTerm: null,
    up: null,
    premium: { amountMinor: rupiah(1_250_000), currency: 'IDR' },
    rateTableVersionId: null,
    rateTableEffectiveFrom: null,
    ...rest,
    snapshot: {
      name: 'PRUlink', typeLabel: 'JIWA', category: 'life', fields: [], benefits: [], pdfDetail: [], currencies: ['IDR'],
      isSyariah: false, needTag: null, payTerms: [], ...snapshot,
    },
  };
}

/** **PRUWell Medical · Silver A**, as the mockup draws it: a derived plan, the region and the room, page 2's rows. */
export const HEALTH: PdfItemSource = item({
  snapshot: {
    name: 'PRUWell Medical', typeLabel: 'KESEHATAN', category: 'health', needTag: 'HOSPITAL',
    fields: [
      field({ key: 'wilayah', label: 'Wilayah', type: 'chips', options: [option('Indonesia'), option('Asia kec. JPN, HK, SGP')], showOnSummary: true }),
      field({ key: 'kamar', label: 'Jenis kamar', type: 'chips', options: [option('2 tempat tidur'), option('1 tempat tidur')], showOnSummary: true }),
      field({ key: 'plan', label: 'Plan', type: 'derived', options: [option('Silver A')], plan: true }),
    ],
    payTerms: [term('renew', 'Diperbarui tiap tahun s/d usia 99', { toAge: 99 })],
    benefits: ['Rawat inap sesuai tagihan', 'Pembedahan', 'Perawatan intensif'],
    pdfDetail: [
      { block: 'manfaat', rows: [
        text('Rawat inap, bedah, ICU', 'sesuai tagihan'), text('Dokter dan obat', 'sesuai tagihan'),
        text('Kamar per hari', 'maks Rp600 ribu'), text('Limit per tahun', 'Rp4 miliar'), text('Cadangan limit', 'Rp8 miliar'),
        text('Total maksimal', 'Rp12 miliar'), text('Perawatan kanker', 'sesuai tagihan'), text('Cuci darah', 'sesuai tagihan'),
      ] },
      { block: 'masa', rows: [
        text('Masa tunggu', '30 hari', 'Kecelakaan ditanggung sejak hari pertama.'),
        text('Premi', 'naik sesuai usia', 'Premi kesehatan disesuaikan tiap tahun.'),
      ] },
    ] as PdfDetailBlockSource[],
  },
  fieldValues: { wilayah: 'Asia kec. JPN, HK, SGP', kamar: '2 tempat tidur', plan: 'Silver A' },
  payTerm: 'renew',
  premium: { amountMinor: rupiah(828_000), currency: 'IDR' },
});

/** **PCB88**: a sum assured, ten years of paying, *Total dibayar*, its benefits. */
export const CRITICAL: PdfItemSource = item({
  snapshot: {
    name: 'PCB88', typeLabel: 'PENYAKIT KRITIS', category: 'ci', needTag: 'CRITICAL_INCOME',
    fields: [field({ key: 'up', label: 'Uang pertanggungan', labelSyariah: 'Santunan asuransi', type: 'money', showOnSummary: true })],
    payTerms: [term('t5', '5 tahun', { years: 5 }), term('t10', '10 tahun', { years: 10 }), term('single', 'Sekali bayar', { single: true })],
    benefits: ['Santunan 88 kondisi kritis', 'Manfaat meninggal dunia'],
  },
  fieldValues: { up: rupiah(500_000_000) },
  payTerm: 't10',
  up: { amountMinor: rupiah(500_000_000), currency: 'IDR' },
  premium: { amountMinor: rupiah(1_690_000), currency: 'IDR' },
});

/** **PRUTahapan Cemerlang · PRO**: a child insured, a target, paid yearly, and the school-stage timeline. */
export const EDUCATION: PdfItemSource = item({
  snapshot: {
    name: 'PRUTahapan Cemerlang', typeLabel: 'DANA PENDIDIKAN', category: 'education', needTag: 'EDUCATION',
    fields: [
      field({ key: 'plan', label: 'Plan', type: 'chips', options: [option('PRO'), option('MAX')], plan: true, showOnSummary: true }),
      field({ key: 'target_dana', label: 'Target dana', type: 'money', showOnSummary: true }),
      field({ key: 'mpa', label: 'Masa asuransi', type: 'chips', options: [option('18 tahun')] }),
    ],
    payTerms: [term('t10', '10 tahun', { years: 10 })],
    pdfDetail: [{ block: 'jadwal', rows: [text('SD', '10%'), text('SMP', '15%'), text('SMA', '25%'), text('Kuliah', '50%')] }],
  },
  insured: { relation: 'child', name: 'Raka', age: 5 },
  fieldValues: { plan: 'PRO', target_dana: rupiah(300_000_000), mpa: '18 tahun' },
  payFrequency: 'annual',
  payTerm: 't10',
  premium: { amountMinor: rupiah(24_000_000), currency: 'IDR' },
});

/** **PRUSmart Plan · 6-Pay**: the future; six years of paying. */
export const FUTURE: PdfItemSource = item({
  snapshot: {
    name: 'PRUSmart Plan', typeLabel: 'DANA MASA DEPAN', category: 'investment', needTag: 'FUTURE',
    fields: [
      field({ key: 'plan', label: 'Plan', type: 'chips', options: [option('6-Pay'), option('8-Pay')], plan: true, showOnSummary: true }),
      field({ key: 'masa', label: 'Masa asuransi', type: 'fixed', options: [option('20 tahun')] }),
    ],
    payTerms: [term('six', '6 tahun', { years: 6 })],
    benefits: ['Dana di akhir masa asuransi', 'Santunan meninggal dunia'],
  },
  fieldValues: { plan: '6-Pay' },
  payTerm: 'six',
  premium: { amountMinor: rupiah(2_000_000), currency: 'IDR' },
});

/** **PRU Anugerah Syariah**: a syariah product — *Santunan asuransi*, *Kontribusi*. */
export const SYARIAH: PdfItemSource = item({
  snapshot: {
    name: 'PRU Anugerah Syariah', typeLabel: 'JIWA', category: 'life', needTag: 'FAMILY', isSyariah: true,
    fields: [field({ key: 'up', label: 'Uang pertanggungan', labelSyariah: 'Santunan asuransi', type: 'money', showOnSummary: true })],
    payTerms: [term('t10', '10 tahun', { years: 10 })],
  },
  fieldValues: { up: rupiah(250_000_000) },
  payTerm: 't10',
  up: { amountMinor: rupiah(250_000_000), currency: 'IDR' },
  premium: { amountMinor: rupiah(450_000), currency: 'IDR' },
});

/** **PRU Prosper**: in USD, paid yearly. */
export const DOLLAR: PdfItemSource = item({
  snapshot: { name: 'PRU Prosper', typeLabel: 'DANA MASA DEPAN', category: 'investment', needTag: 'FUTURE', currencies: ['USD'] },
  payFrequency: 'annual',
  premium: { amountMinor: 250_000, currency: 'USD' },
});

/** The mockup's client: married, a child, a job and a city, four needs discussed. */
export const BUDI: PdfClientSource = {
  name: 'Budi Contoh', age: 35, gender: 'male',
  details: {
    status: 'married', dependants: 'Istri, 1 anak (5 th)', occupation: 'Karyawan swasta', city: 'Tangerang Selatan',
    needs: ['HOSPITAL', 'CRITICAL_INCOME', 'EDUCATION', 'FUTURE'], needsOther: null,
  },
};

export function proposal(items: PdfItemSource[], over: Partial<PdfProposalSource> = {}): PdfProposalSource {
  return { client: BUDI, showTotal: false, date: '2026-11-11', items, ...over };
}

export function input(p: PdfProposalSource, over: Partial<PdfModelInput> = {}): PdfModelInput {
  return {
    proposal: p,
    agent: { name: 'Rina Wijaya', code: '80008', phone: '0812 3456 7890' },
    insurer: 'Prudential',
    kpmName: 'BSD City',
    branding: AGENCYBOOST_PDF_BRANDING,
    ...over,
  };
}

/** The mockup's KPM: *KPM 0417 · BSD City*, dark green and light green, no logo. */
export const KPM_GREEN: PdfBranding = { branded: true, name: 'KPM 0417 · BSD City', logo: null, main: '#0F6E56', second: '#5DCAA5' };

/** A KPM whose main colour is too light for white words. */
export const KPM_LIGHT: PdfBranding = { branded: true, name: 'KPM Cahaya', logo: null, main: '#FFD84D', second: '#7FD3F7' };

const long = (n: number, seed: string) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);

/**
 * **The worst case** (ADR-0256 §1): `PROPOSAL.ITEMS_MAX` products, each with `FIELDS_MAX` fields at their longest labels
 * and values, every `pdfDetail` block at its most rows, four benefits, the longest names an agent can give, a child's
 * timeline, the client's every detail at its bound and every need, the total on — and the longest agent and insurer.
 */
export function worstCase(): PdfModelInput {
  const words = 'Manfaat perlindungan menyeluruh ';
  const fields = Array.from({ length: PROPOSAL.FIELDS_MAX }, (_, i) => field({
    key: `f${i}`,
    label: long(PROPOSAL_TEXT_MAX.FIELD_LABEL, `Kolom ${i} `),
    type: 'chips',
    options: [option(long(PROPOSAL_TEXT_MAX.OPTION_LABEL, 'Pilihan panjang '))],
    showOnSummary: i < PROPOSAL.SUMMARY_FIELDS_MAX,
    plan: i === 0,
  }));
  const values = Object.fromEntries(fields.map((f) => [f.key, f.options[0].label]));
  const row = { label: long(PROPOSAL_TEXT_MAX.DETAIL_LABEL, words), note: long(PROPOSAL_TEXT_MAX.DETAIL_NOTE, 'catatan '), formula: null, text: long(PROPOSAL_TEXT_MAX.DETAIL_NOTE, 'teks ') };
  const one = (i: number): PdfItemSource => item({
    snapshot: {
      // An office's display name may be 200 characters (`SaveProductOverridesDto`).
      name: long(200, `Produk Asuransi ${i} `),
      typeLabel: long(PROPOSAL_TEXT_MAX.TYPE_LABEL, 'PERLINDUNGAN '),
      category: ['health', 'ci', 'life', 'education', 'investment'][i % 5],
      fields,
      benefits: Array.from({ length: PROPOSAL.BENEFITS_ON_PDF_MAX }, () => long(200, words)),
      payTerms: [term('t', long(60, 'Masa bayar panjang '), { years: PROPOSAL.PAYMENT_YEARS_MAX })],
      pdfDetail: [
        ...(['manfaat', 'masa', 'pengecualian', 'nilai_tunai'] as const).map((block) => ({
          block,
          rows: Array.from({ length: block === 'pengecualian' ? PROPOSAL.EXCLUSIONS_MAX : PROPOSAL.PDF_DETAIL_ROWS_MAX }, () => ({ ...row })),
          notGuaranteed: block === 'nilai_tunai',
        })),
        { block: 'jadwal' as const, rows: ['SD', 'SMP', 'SMA', 'Kuliah'].map((s) => text(s, long(PROPOSAL_TEXT_MAX.DETAIL_NOTE, '99% '))) },
      ],
    },
    insured: { relation: 'spouse', name: long(PROPOSAL.INSURED_NAME_MAX, 'Nama Pasangan Panjang '), age: 100 },
    fieldValues: values,
    payFrequency: 'semiannual',
    payTerm: 't',
    up: { amountMinor: PROPOSAL.MONEY_MAX_MINOR, currency: 'IDR' },
    premium: { amountMinor: PROPOSAL.PREMIUM_MAX_MINOR, currency: i === 4 ? 'USD' : 'IDR' },
  });
  return input(
    {
      client: {
        name: long(PROPOSAL.INSURED_NAME_MAX, 'Nama Klien Sangat Panjang '), age: 100, gender: 'female',
        details: {
          status: 'married',
          dependants: long(PROPOSAL_CLIENT_TEXT_MAX.DEPENDANTS, 'Suami dan anak '),
          occupation: long(PROPOSAL_CLIENT_TEXT_MAX.OCCUPATION, 'Pekerjaan panjang '),
          city: long(PROPOSAL_CLIENT_TEXT_MAX.CITY, 'Kota panjang '),
          needs: ['HOSPITAL', 'CRITICAL_INCOME', 'FAMILY', 'EDUCATION', 'FUTURE', 'OTHER'],
          needsOther: long(PROPOSAL_CLIENT_TEXT_MAX.NEEDS_OTHER, 'Kebutuhan lain '),
        },
      },
      showTotal: true,
      date: '2026-11-11',
      items: Array.from({ length: PROPOSAL.ITEMS_MAX }, (_, i) => one(i)),
    },
    {
      agent: { name: long(160, 'Nama Agen Yang Panjang '), code: 'AG-0417-0000000001', phone: '+62 812 3456 7890 1234' },
      insurer: long(200, 'PT Asuransi Jiwa Nama Panjang '),
      kpmName: long(120, 'Nama KPM Panjang '),
      branding: { branded: true, name: long(120, 'Nama KPM Panjang '), logo: null, main: '#FFFF00', second: '#FFFFFF' },
    },
  );
}
