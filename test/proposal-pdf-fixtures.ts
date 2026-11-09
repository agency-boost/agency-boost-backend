import { PROPOSAL, PROPOSAL_TEXT_MAX } from '@/domain/constants';
import type { ProposalField } from '@/modules/products/proposal-fields';
import { AGENCYBOOST_PDF_BRANDING, type PdfBranding } from '@/modules/proposals/proposal-branding';
import { totalPaidOf, totalsOf, type SnapshotBlock, type StoredItem } from '@/modules/proposals/proposal-items';
import type { PdfInput } from '@/modules/proposals/proposal-pdf.layout';
import type { ProposalItemView, ProposalView } from '@/modules/proposals/proposal.service';

/**
 * **Proposals for the PDF's specs** (P19.7-T3): the proposal as every route answers it, built without a database —
 * ordinary ones, and the worst case ADR-0223 §5 asks for: every bound at its maximum, the longest names.
 */

type Field = Omit<ProposalField, 'draft'>;

export const field = (over: Partial<Field> & Pick<Field, 'key' | 'label' | 'type'>): Field => ({
  labelSyariah: null, options: [], default: null, quickAmounts: [], minMinor: null, showOnPdf: true,
  showOnSummary: false, paymentYears: false, plan: false, currency: false, ...over,
});
export const option = (label: string, years: number | null = null) => ({ label, years, currency: null });

/** One item as the API answers it, from a stored one. */
export function itemView(stored: StoredItem, channel: 'conventional' | 'syariah', pay: ProposalView['payFrequency'], plan: string | null = null): ProposalItemView {
  return {
    itemId: stored.itemId,
    productId: stored.productId,
    productCode: stored.productCode,
    productVersion: stored.productVersion,
    name: channel === 'syariah' && stored.snapshot.syariahName ? stored.snapshot.syariahName : stored.snapshot.name,
    plan,
    currency: stored.premium.currency,
    snapshot: stored.snapshot,
    insured: stored.insured,
    fieldValues: stored.fieldValues,
    premium: stored.premium,
    totalPaid: totalPaidOf(stored, pay),
    choice: null,
  };
}

export interface ItemSpec {
  name: string;
  typeLabel?: string;
  category?: string;
  syariahName?: string | null;
  fields?: Field[];
  values?: Record<string, string | number>;
  premium?: number | null;
  currency?: 'IDR' | 'USD';
  insured?: StoredItem['insured'];
  benefits?: string[];
  pdfDetail?: SnapshotBlock[];
  plan?: string | null;
}

export function stored(spec: ItemSpec, at: number): StoredItem {
  return {
    itemId: `item-${at}`,
    productId: `product-${at}`,
    productCode: `P${at}`,
    productVersion: 1,
    snapshot: {
      name: spec.name,
      syariahName: spec.syariahName ?? null,
      typeLabel: spec.typeLabel ?? 'KESEHATAN',
      category: spec.category ?? 'health',
      currencies: [spec.currency ?? 'IDR'],
      fields: spec.fields ?? [],
      benefits: spec.benefits ?? [],
      pdfDetail: spec.pdfDetail ?? [],
    },
    insured: spec.insured ?? { relation: 'client', name: null, age: null },
    fieldValues: spec.values ?? {},
    premium: { amountMinor: spec.premium === undefined ? 1_250_000_00 : spec.premium, currency: spec.currency ?? 'IDR' },
    choice: null,
  };
}

export interface ProposalSpec {
  client?: { name: string; age: number; gender: 'male' | 'female' };
  channel?: 'conventional' | 'syariah';
  payFrequency?: ProposalView['payFrequency'];
  showTotal?: boolean;
  status?: 'draft' | 'done';
  date?: string;
  items: ItemSpec[];
}

export function proposalView(spec: ProposalSpec): ProposalView {
  const channel = spec.channel ?? 'conventional';
  const pay = spec.payFrequency ?? 'monthly';
  const items = spec.items.map((item, at) => stored(item, at));
  return {
    id: '66f0000000000000000009a1',
    version: 3,
    leadId: '66f0000000000000000009b1',
    leadDeleted: false,
    client: spec.client ?? { name: 'Pak Budi Santoso', age: 36, gender: 'male' },
    channel,
    payFrequency: pay,
    showTotal: spec.showTotal ?? false,
    status: spec.status ?? 'draft',
    doneAt: null,
    firstDoneAt: null,
    date: spec.date ?? '2026-11-05',
    items: items.map((s, at) => itemView(s, channel, pay, spec.items[at].plan ?? null)),
    totals: totalsOf(items),
    duplicatedFrom: null,
    createdAt: '2026-11-05T03:00:00.000Z',
    updatedAt: '2026-11-05T03:00:00.000Z',
    fileName: '',
  } as ProposalView;
}

export function pdfInput(proposal: ProposalView, over: Partial<PdfInput> = {}): PdfInput {
  return {
    proposal,
    agent: { name: 'Rina Wijaya', code: 'AG-0417-001', phone: '0812 3456 7890' },
    insurer: 'PT Prudential Life Assurance',
    kpmName: 'KPM Cahaya Jakarta',
    branding: AGENCYBOOST_PDF_BRANDING,
    ...over,
  };
}

/** **PRUWell Medical**, as the demo seed has it: a plan, a term in years, a sum assured, benefits and detail blocks. */
export const HEALTH: ItemSpec = {
  name: 'PRUWell Medical',
  typeLabel: 'KESEHATAN',
  plan: 'Gold',
  fields: [
    field({ key: 'plan', label: 'Plan', type: 'chips', options: [option('Silver'), option('Gold')], default: 'Gold', plan: true, showOnSummary: true }),
    field({ key: 'masa_bayar', label: 'Masa bayar', type: 'chips', options: [option('10 tahun', 10)], default: '10 tahun', paymentYears: true, showOnSummary: true }),
    field({ key: 'up', label: 'Uang pertanggungan', labelSyariah: 'Santunan asuransi', type: 'money', showOnSummary: true }),
    field({ key: 'wilayah', label: 'Wilayah', type: 'fixed', options: [option('Indonesia')], default: 'Indonesia' }),
  ],
  values: { plan: 'Gold', masa_bayar: '10 tahun', up: 100_000_000_000 },
  benefits: ['Rawat inap sesuai tagihan', 'Pembedahan', 'Perawatan intensif', 'Rawat jalan kanker', 'Manfaat kelima'],
  pdfDetail: [
    { block: 'manfaat', rows: [{ label: 'Batas tahunan', note: null, formula: '2 × up', text: null }, { label: 'Kamar', note: 'per hari', formula: null, text: 'Rp 1,5 jt' }], notGuaranteed: false },
    { block: 'jadwal', rows: [{ label: 'Pembayaran premi', note: null, formula: null, text: '10 tahun' }], notGuaranteed: false },
    { block: 'pengecualian', rows: [{ label: 'Kondisi yang sudah ada', note: null, formula: null, text: '12 bulan' }], notGuaranteed: false },
    { block: 'nilai_tunai', rows: [{ label: 'Tahun ke-10', note: 'contoh', formula: '10% × up', text: null }], notGuaranteed: true },
  ],
};

/** A product with no fields at all: *Tertanggung* and the premium. */
export const PLAIN: ItemSpec = { name: 'PRUlink', typeLabel: 'JIWA', category: 'life', benefits: ['Santunan meninggal'] };

/** A USD product. */
export const DOLLAR: ItemSpec = { name: 'PRU Prosper', typeLabel: 'INVESTASI', category: 'investment', currency: 'USD', premium: 125_000 };

/** An education product insuring a child. */
export const EDUCATION: ItemSpec = {
  name: 'PRUCerah',
  typeLabel: 'DANA PENDIDIKAN',
  category: 'education',
  insured: { relation: 'child', name: 'Adik Raka', age: 8 },
  fields: [
    field({ key: 'target_dana', label: 'Target dana', type: 'money', showOnSummary: true }),
    field({ key: 'masa', label: 'Masa tunggu', type: 'fixed', options: [option('Dilindungi sampai usia 88', 18)], default: 'Dilindungi sampai usia 88', paymentYears: true }),
  ],
  values: { target_dana: 50_000_000_000 },
  pdfDetail: [{ block: 'manfaat', rows: [{ label: 'Tahapan dana', note: null, formula: '5% × target_dana', text: null }], notGuaranteed: false }],
};

const longText = (n: number, seed: string) => (seed.repeat(Math.ceil(n / seed.length))).slice(0, n);

/**
 * **The worst case** (ADR-0223 §5): `PROPOSAL.ITEMS_MAX` products, each with `PROPOSAL.FIELDS_MAX` fields at their
 * longest labels and values, `SUMMARY_FIELDS_MAX` of them on page 1, four benefits, every block at its most rows, the
 * longest names an agent can give, and the client's and the insured's at their bounds.
 */
export function worstCase(): ProposalSpec {
  const words = 'Manfaat perlindungan menyeluruh ';
  const fields: Field[] = Array.from({ length: PROPOSAL.FIELDS_MAX }, (_, i) => field({
    key: `f${i}`,
    label: longText(PROPOSAL_TEXT_MAX.FIELD_LABEL, `Kolom ${i} `),
    type: 'chips',
    // The second field is the term: 99 years, so *Total dibayar* is printed at its longest.
    options: [option(longText(PROPOSAL_TEXT_MAX.OPTION_LABEL, 'Pilihan panjang '), i === 1 ? PROPOSAL.PAYMENT_YEARS_MAX : null)],
    default: longText(PROPOSAL_TEXT_MAX.OPTION_LABEL, 'Pilihan panjang '),
    showOnSummary: i < PROPOSAL.SUMMARY_FIELDS_MAX,
    plan: i === 0,
    paymentYears: i === 1,
  }));
  const values = Object.fromEntries(fields.map((f) => [f.key, f.default!]));
  const row = {
    label: longText(PROPOSAL_TEXT_MAX.DETAIL_LABEL, words), note: longText(PROPOSAL_TEXT_MAX.DETAIL_NOTE, 'catatan '),
    formula: null, text: longText(PROPOSAL_TEXT_MAX.DETAIL_NOTE, 'teks '),
  };
  const item = (i: number): ItemSpec => ({
    // An office's display name may be 200 characters (`SaveProductOverridesDto`).
    name: longText(200, `Produk Asuransi ${i} `),
    typeLabel: longText(PROPOSAL_TEXT_MAX.TYPE_LABEL, 'PERLINDUNGAN '),
    plan: values.f0 as string,
    fields,
    values,
    premium: PROPOSAL.PREMIUM_MAX_MINOR,
    insured: { relation: 'spouse', name: longText(PROPOSAL.INSURED_NAME_MAX, 'Nama Pasangan Panjang '), age: 100 },
    benefits: Array.from({ length: 4 }, () => longText(200, words)),
    pdfDetail: (['manfaat', 'jadwal', 'masa', 'pengecualian', 'nilai_tunai'] as const).map((block) => ({
      block,
      rows: Array.from({ length: block === 'pengecualian' ? PROPOSAL.EXCLUSIONS_MAX : PROPOSAL.PDF_DETAIL_ROWS_MAX }, () => ({ ...row })),
      notGuaranteed: block === 'nilai_tunai',
    })),
  });
  return {
    client: { name: longText(PROPOSAL.INSURED_NAME_MAX, 'Nama Klien Sangat Panjang '), age: 100, gender: 'female' },
    payFrequency: 'semiannual',
    showTotal: true,
    items: Array.from({ length: PROPOSAL.ITEMS_MAX }, (_, i) => item(i)),
  };
}

/** The longest agent and insurer the worst case prints. */
export const WORST_AGENT = { name: longText(160, 'Nama Agen Yang Panjang '), code: 'AG-0417-0000000001', phone: '+62 812 3456 7890 1234' };
export const WORST_INSURER = longText(200, 'PT Asuransi Jiwa Nama Panjang ');

/**
 * **A KPM's branding**, as P19.6-T1's palette would hand it: a violet primary whose ink is itself (it reads 5.7:1), a
 * light blue secondary whose ink is darkened to read 4.5:1 — and a 480 × 96 logo, the size ADR-0218 §2 keeps.
 */
export const KPM_BRANDING: PdfBranding = {
  logo: null, primary: '#7C3AED', primaryInk: '#7C3AED', secondary: '#38BDF8', secondaryInk: '#0369A1',
};
