import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import type { Clock } from '@/common/clock/clock.port';
import type { ProposalField } from '@/modules/products/proposal-fields';
import { BrandingReader } from '@/modules/branding/branding-reader';
import { KpmBrandingRepository } from '@/modules/branding/kpm-branding.repository';
import { KpmBranding, KpmBrandingSchema } from '@/modules/branding/kpm-branding.schema';
import { ProposalBranding } from '@/modules/proposals/proposal-branding';
import { ProposalPdfBuilder } from '@/modules/proposals/proposal-pdf.builder';
import { ProposalPdfService } from '@/modules/proposals/proposal-pdf.service';
import { configModule, provisionOffice } from './config-module';

/**
 * **The proposal's specs' office** (P19.7-T2): two offices of one company and an office of another, a small unit — an AB
 * over an AAB over two Agents — an Owner and an Admin who also stand on a rung (*Akun saya*, ADR-0198 §1), Sales and
 * Recruit leads with and without an age, and a shelf whose products each answer one of ADR-0225 §7's rules.
 */

/** 10:00 on 5 November 2026 in Jakarta. */
export const NOW = new Date('2026-11-05T03:00:00Z');
export const KPM_A = '66f0000000000000000000a1';
export const KPM_B = '66f0000000000000000000b1';
export const COMPANY = '66f0000000000000000000c1';
export const OTHER_COMPANY = '66f0000000000000000000c2';

export const AB = '66f000000000000000000101';
export const AAB = '66f000000000000000000102';
export const AGENT = '66f000000000000000000103';
export const SIBLING = '66f000000000000000000104';
export const OWNER = '66f000000000000000000105';
export const ADMIN = '66f000000000000000000106';
/** A member of office B. */
export const AGENT_B = '66f000000000000000000107';

export const ctxFor = (
  membershipId: string, rung: string, kpmId = KPM_A, over: Record<string, unknown> = {}, readOnly = false,
) => new RequestContext(
  'u-' + membershipId, 'none', {
    membershipId, kpmId, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1, ...over,
  } as never,
  readOnly ? 'u-superadmin' : null, null, false, readOnly,
);

export const agent = () => ctxFor(AGENT, 'AGENT');
export const sibling = () => ctxFor(SIBLING, 'AGENT');
export const aab = () => ctxFor(AAB, 'AAB');
export const ab = () => ctxFor(AB, 'AB');
/** The Owner in *Akun saya*: their own rung's grants (an AB rung here). */
export const owner = () => ctxFor(OWNER, 'AB', KPM_A, { isKpmOwner: true });
export const admin = () => ctxFor(ADMIN, 'AGENT', KPM_A, { isKpmAdmin: true });
export const agentB = () => ctxFor(AGENT_B, 'AGENT', KPM_B);
/** The Super Admin viewing as the Agent: reads as the member, writes nothing (ADR-0206 §4). */
export const viewAsAgent = () => ctxFor(AGENT, 'AGENT', KPM_A, {}, true);

const field = (over: Partial<ProposalField> & Pick<ProposalField, 'key' | 'label' | 'type'>): ProposalField => ({
  labelSyariah: null, options: [], default: null, quickAmounts: [], minMinor: null, showOnPdf: true,
  showOnSummary: false, paymentYears: false, plan: false, currency: false, draft: false, ...over,
});
const option = (label: string, years: number | null = null, currency: 'IDR' | 'USD' | null = null) => ({ label, years, currency });

/** The shelf, by code: each product is one rule's case. */
export const PRODUCT_IDS = {
  HEALTH: '66f0000000000000000003a1',
  EDU: '66f0000000000000000003a2',
  SYARIAH: '66f0000000000000000003a3',
  CONV_SYARIAH_NAME: '66f0000000000000000003a4',
  USD: '66f0000000000000000003a5',
  BOTH: '66f0000000000000000003a6',
  WITHDRAWN: '66f0000000000000000003a7',
  CLOSED: '66f0000000000000000003a8',
  RIDER: '66f0000000000000000003a9',
  SENIOR: '66f0000000000000000003aa',
  DELETED: '66f0000000000000000003ab',
  OFF: '66f0000000000000000003ac',
  OTHER_CO: '66f0000000000000000003ad',
  LIFE: '66f0000000000000000003ae',
} as const;

const ALL_BANDS = [1, 2, 3, 4, 5];

function products() {
  const P = PRODUCT_IDS;
  const base = (id: string, code: string, name: string, over: Record<string, unknown> = {}) => ({
    _id: new mongoose.Types.ObjectId(id), companyId: COMPANY, code, name, channel: 'conventional', category: 'life',
    kind: 'base', attachesTo: [], currencies: ['IDR'], eligibleAgeBands: ALL_BANDS, lifecycle: 'active',
    activeByDefault: true, sortOrder: Object.keys(P).indexOf(code) + 1, version: 1, deletedAt: null,
    benefits: ['Manfaat satu', 'Manfaat dua', 'Manfaat tiga', 'Manfaat empat', 'Manfaat lima'], ...over,
  });
  return [
    base(P.HEALTH, 'HEALTH', 'PRUWell Medical', {
      category: 'health',
      proposalFields: [
        field({ key: 'plan', label: 'Plan', type: 'chips', options: [option('Silver'), option('Gold')], default: 'Gold', plan: true, showOnSummary: true }),
        field({ key: 'masa_bayar', label: 'Masa bayar', type: 'chips', options: [option('10 tahun', 10), option('s.d. usia 60', null)], default: '10 tahun', paymentYears: true }),
        field({ key: 'saver', label: 'Saver', type: 'chips', options: [option('Tidak')], default: null }),
        field({ key: 'catatan', label: 'Wilayah', type: 'fixed', options: [option('Indonesia')], default: 'Indonesia', draft: true }),
      ],
      planOptions: [
        { name: 'Silver', popular: false, highlights: [{ label: 'Kamar', value: 'Rp 1 jt' }] },
        { name: 'Gold', popular: true, highlights: [{ label: 'Kamar', value: 'Rp 1,5 jt' }] },
      ],
      faq: [{ question: 'Ada masa tunggu?', answer: '30 hari.' }],
      pdfDetail: [{ block: 'manfaat', rows: [{ label: 'Rawat inap', note: null, formula: null, text: 'Sesuai plan' }], source: { file: 'ilustrasi.pdf', page: 1, date: '2026-10-01' }, notGuaranteed: false }],
    }),
    base(P.EDU, 'EDU', 'PRUCerah', {
      category: 'education',
      proposalFields: [
        field({ key: 'up', label: 'Uang pertanggungan', labelSyariah: 'Santunan asuransi', type: 'money', quickAmounts: [10_000_000_000, 25_000_000_000], minMinor: 10_000_000_000 }),
        field({ key: 'masa', label: 'Masa tunggu', type: 'fixed', options: [option('Dilindungi sampai usia 88', 18)], default: 'Dilindungi sampai usia 88', paymentYears: true }),
      ],
    }),
    base(P.SYARIAH, 'SYARIAH', 'PRU Anugerah Syariah', { channel: 'syariah' }),
    base(P.CONV_SYARIAH_NAME, 'CONV_SYARIAH_NAME', 'PRUCinta', { syariahName: 'PRUCinta Syariah' }),
    base(P.USD, 'USD', 'PRU Prosper', { category: 'investment', currencies: ['USD'] }),
    base(P.BOTH, 'BOTH', 'PRUFuture', {
      currencies: ['IDR', 'USD'],
      proposalFields: [
        field({ key: 'mata_uang', label: 'Mata uang', type: 'chips', options: [option('Rupiah', null, 'IDR'), option('Dolar', null, 'USD')], default: 'Rupiah', currency: true }),
        field({ key: 'up', label: 'Uang pertanggungan', type: 'money' }),
      ],
    }),
    base(P.WITHDRAWN, 'WITHDRAWN', 'PRUlama', { lifecycle: 'withdrawn' }),
    base(P.CLOSED, 'CLOSED', 'PRUtutup', { lifecycle: 'closed_to_new_business' }),
    base(P.RIDER, 'RIDER', 'PRU Personal Accident', { kind: 'rider', attachesTo: [P.HEALTH], category: 'health' }),
    base(P.SENIOR, 'SENIOR', 'PRUsenja', { eligibleAgeBands: [5] }),
    base(P.DELETED, 'DELETED', 'PRUhilang', { lifecycle: 'withdrawn', deletedAt: new Date('2026-10-01T00:00:00Z') }),
    base(P.OFF, 'OFF', 'PRUmati', { activeByDefault: false }),
    base(P.OTHER_CO, 'OTHER_CO', 'Asing Sehat', { companyId: OTHER_COMPANY }),
    base(P.LIFE, 'LIFE', 'PRUlink', {}),
  ];
}

/** The Agent's leads: one with an age and a gender, one without, a Recruit lead. Answered by name. */
export interface SeededLeads { budi: string; sari: string; recruit: string; siblings: string; officeB: string }

/** The office, its people, its shelf and its leads. */
export async function seedProposalOffice(wired: ReturnType<typeof configModule>): Promise<SeededLeads> {
  const db = mongoose.connection.db!;
  await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
    { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
    { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
  ]);
  await provisionOffice(wired, KPM_A, COMPANY);
  await provisionOffice(wired, KPM_B, COMPANY);
  const person = (id: string, rung: string, leaderId: string | null, ancestors: string[], kpmId = KPM_A, over = {}) => ({
    _id: new mongoose.Types.ObjectId(id), kpmId, leaderCode: `LC-${id.slice(-3)}`,
    userId: '66f0000000000000000002' + id.slice(-2), orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
    role: rung.toLowerCase(), leaderId, ancestorIds: ancestors, depth: ancestors.length, status: 'active',
    deletedAt: null, ...over,
  });
  await db.collection('memberships').insertMany([
    person(AB, 'AB', null, []),
    person(AAB, 'AAB', AB, [AB]),
    person(AGENT, 'AGENT', AAB, [AB, AAB]),
    person(SIBLING, 'AGENT', AAB, [AB, AAB]),
    person(OWNER, 'AB', null, [], KPM_A, { isKpmOwner: true }),
    person(ADMIN, 'AGENT', OWNER, [OWNER], KPM_A, { isKpmAdmin: true }),
    person(AGENT_B, 'AGENT', null, [], KPM_B),
  ] as never);
  await db.collection('users').insertMany([AB, AAB, AGENT, SIBLING, OWNER, ADMIN, AGENT_B].map((id) => ({
    _id: new mongoose.Types.ObjectId('66f0000000000000000002' + id.slice(-2)),
    email: `${id}@kpm.test`, fullName: `Person ${id.slice(-3)}`, deletedAt: null,
  })) as never);
  const Products = mongoose.model('ProductModel');
  await Products.create(products());

  const make = (ctx: RequestContext, body: Record<string, unknown>) => wired.leadRecords.create(ctx, body);
  const budi = await make(agent(), { name: 'Pak Budi Santoso', type: 'sales', age: 36, gender: 'male' });
  const sari = await make(agent(), { name: 'Ibu Sari', type: 'sales' });
  const recruit = await make(agent(), { name: 'Mas Calon', type: 'recruitment', age: 25, gender: 'male' });
  const siblings = await make(sibling(), { name: 'Ibu Rosa', type: 'sales', age: 42, gender: 'female' });
  const officeB = await make(agentB(), { name: 'Pak Lain', type: 'sales', age: 30, gender: 'male' });
  return { budi: budi.id, sari: sari.id, recruit: recruit.id, siblings: siblings.id, officeB: officeB.id };
}

/** A proposal of `ctx`'s with these products, every gap filled so *Simpan PDF* takes it. */
export async function completeProposal(
  wired: ReturnType<typeof configModule>, ctx: RequestContext, leadId: string, productIds: string[] = [PRODUCT_IDS.HEALTH],
) {
  let proposal = await wired.proposals.create(ctx, leadId);
  for (const productId of productIds) proposal = await wired.proposals.addItem(ctx, proposal.id, proposal.version, productId);
  for (const item of proposal.items) {
    const patch: Record<string, unknown> = { premium: { amountMinor: 50_000_000 } };
    if (item.insured.relation !== 'client') patch.insured = { relation: item.insured.relation, name: 'Adik', age: 8 };
    if (item.snapshot.fields.some((f) => f.key === 'up')) patch.fieldValues = { up: 25_000_000_000 };
    proposal = await wired.proposals.updateItem(ctx, proposal.id, item.itemId, proposal.version, patch as never);
  }
  return proposal;
}

/**
 * **P19.6-T1's branding reader over the specs' database** (ADR-0218 §3): the KPM's own `kpmBranding` row, its template's
 * published *Tampilan*, and the logo's bytes from the stub storage (`wired.storage.holdBytes`).
 */
export function brandingReaderFor(wired: ReturnType<typeof configModule>): BrandingReader {
  const rows = mongoose.models[KpmBranding.name] ?? mongoose.model(KpmBranding.name, KpmBrandingSchema);
  return new BrandingReader(
    new KpmBrandingRepository(rows as never), wired.kpms as never, wired.templates as never, wired.analyticsConfig, wired.storage,
  );
}

/**
 * **The PDF's service over the specs' office** (P19.7-T3): the proposal service, the real builder and fonts, the default
 * branding reader (or one a spec hands in), and the office's own people, KPM and company. The company is named here, so
 * the disclaimer has an insurer to print.
 */
export async function pdfServiceFor(
  wired: ReturnType<typeof configModule>, branding: ProposalBranding = new ProposalBranding(brandingReaderFor(wired)),
): Promise<ProposalPdfService> {
  const db = mongoose.connection.db!;
  await db.collection('companies').updateOne(
    { _id: new mongoose.Types.ObjectId(COMPANY) },
    { $set: { name: 'PT Prudential Life Assurance', slug: 'prudential', deletedAt: null } },
    { upsert: true },
  );
  await db.collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(AGENT) }, { $set: { agentCode: 'AG-0417-103' } });
  await db.collection('users').updateOne(
    { _id: new mongoose.Types.ObjectId('66f0000000000000000002' + AGENT.slice(-2)) },
    { $set: { fullName: 'Rina Wijaya', phone: '0812 3456 7890' } },
  );
  return new ProposalPdfService(
    wired.proposals, new ProposalPdfBuilder(), branding, wired.memberships, wired.audit, wired.clock as Clock,
    wired.users as never, wired.kpms as never, wired.companies as never,
  );
}
