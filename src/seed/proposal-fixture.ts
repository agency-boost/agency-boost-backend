import mongoose, { type Model } from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { Product, ProductSchema, type ProductDocument } from '@/modules/products/product.schema';
import { importProposalFields, type ProposalFieldsImportReport } from '@/modules/products/proposal-fields-import';
import { PRUDENTIAL_PROPOSAL_IMPORT, PRUDENTIAL_PROPOSAL_ROWS } from '@/modules/products/proposal-fields-prudential';
import type { FaqEntry, PlanOption } from '@/modules/products/proposal-fields';
import { Proposal, ProposalSchema } from '@/modules/proposals/proposal.schema';
import { applyItemPatch, itemName, newItem, type ItemPatch, type StoredItem } from '@/modules/proposals/proposal-items';
import { seedObjectId } from './coaching-fixture';

/**
 * **The proposal's lead and catalogue fields, seeded** (P19.7-T1 AC-1, AC-4; ADR-0224, ADR-0225 §10;
 * `functional/proposal.md`, `leads.md` and `sales-tools.md`).
 *
 * | What | Who to sign in as, and what they see |
 * |---|---|
 * | **The Prudential draft**, imported onto the demo's Prudential company by the operator's own function (17 products; PRUProsper is production's) | `superadmin@agencyboost.test` at `/admin/companies` → *Prudential* → *Produk* → a product → *Proposal*: its fields in order, *Perlu dicek* on every *[cek]* one |
 * | **Plans and a FAQ** on *PRUWell Medical* and *PRUCerah* — **demo figures, not Prudential's** | the same section's *Plan* and *Tanya-jawab*; `owner@kpm0417.test` at `/kpm/settings/products` → *PRUWell Medical* → *Sesuaikan*: the FAQ and each plan's highlights, *Mengikuti Prudential* |
 * | **The client's age and gender** on two of Rina's leads, and on none of the others | `rina@kpm0417.test` at `/leads`: *Ibu Rosa Damayanti* and *Pak Hendro Gunawan* open with *Umur* and *Laki-laki / Perempuan* filled; *Ibu Wulan Sari* with neither |
 * | **Two of Rina's proposals** (P19.7-T2): a *Selesai* one for Ibu Rosa — *Syariah*, PRUWell Medical Syariah and PRUCerah for her daughter, saved an hour before the seed ran — and a *Draf* for Pak Hendro, PRUWell Medical with its premium still to type | `rina@kpm0417.test` at `/proposal` (*Riwayat*: *Draf* and *Selesai*); `/leads`: both cards carry the pill, *Belum ada proposal* leaves Ibu Wulan Sari; Ibu Rosa's sheet: the *Proposal* section and *"Proposal dibuat · …"* in *Riwayat*; her leader on `/unit/dashboard`: *Proposal* 1 this month, and no client |
 *
 * | **The AB's finished and drafts-only leads** (P19.11-T3; `PROPOSAL_DEMO_AB_LEADS`) | `agus@kpm0417.test` at `/leads`: *Ibu Natalia Prameswari*'s card wears the proposal icon, opening her *Selesai* proposal, and her sheet's *Proposal* shows it alone (a later *Draf* hidden); *Pak Benny Tanoto* (drafts only) has no icon and *Buat proposal* alone; both drafts in `/proposal` |
 *
 * **Written once, until `--reset`.** The import changes nothing on a second run (it is the operator's, and says so);
 * the plans and the FAQ are written only onto a product that has neither, and an age only onto a lead with none — so a
 * walk that edited them is never undone by the next run.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** The two products whose *Plan* and *Tanya-jawab* the demo fills. Demo figures, not Prudential's. */
export const PROPOSAL_DEMO_WORDS: Readonly<Record<string, { planOptions: PlanOption[]; faq: FaqEntry[] }>> = {
  PRUWELL_MEDICAL: {
    planOptions: [
      { name: 'Bronze', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 500 rb' }, { label: 'Batas tahunan', value: 'Rp 5 M' }, { label: 'Wilayah', value: 'Indonesia' }] },
      { name: 'Silver', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 1 jt' }, { label: 'Batas tahunan', value: 'Rp 10 M' }, { label: 'Wilayah', value: 'Indonesia' }] },
      { name: 'Gold', popular: true, highlights: [{ label: 'Kamar per hari', value: 'Rp 1,5 jt' }, { label: 'Batas tahunan', value: 'Rp 25 M' }, { label: 'Wilayah', value: 'Asia' }] },
      { name: 'Platinum', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 2,5 jt' }, { label: 'Batas tahunan', value: 'Rp 50 M' }, { label: 'Wilayah', value: 'Asia' }] },
      { name: 'Diamond', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 4 jt' }, { label: 'Batas tahunan', value: 'Rp 100 M' }, { label: 'Wilayah', value: 'Seluruh dunia' }] },
    ],
    faq: [
      { question: 'Apakah ada masa tunggu?', answer: 'Ada, 30 hari untuk sakit biasa.\nTidak ada masa tunggu untuk kecelakaan.' },
      { question: 'Bisakah dipakai di luar negeri?', answer: 'Bisa, sesuai wilayah plan yang dipilih: Asia atau Seluruh dunia.' },
      { question: 'Apa itu Saver?', answer: 'Pilihan yang membuat premi lebih ringan, dengan sebagian biaya ditanggung sendiri.' },
    ],
  },
  PRUCERAH: {
    planOptions: [
      { name: 'PRUCerah', popular: true, highlights: [{ label: 'Tertanggung', value: 'Anak' }, { label: 'Dana pendidikan', value: 'Bertahap' }, { label: 'Masa tunggu', value: '5–15 tahun' }] },
      { name: 'PRUCerah Plus', popular: false, highlights: [{ label: 'Tertanggung', value: 'Anak' }, { label: 'Dana pendidikan', value: 'Bertahap' }, { label: 'Perlindungan jiwa', value: 'Orang tua' }] },
    ],
    faq: [
      { question: 'Kapan dana pendidikan mulai cair?', answer: 'Setelah masa tunggu selesai, setiap bulan sesuai penarikan yang dipilih.' },
    ],
  },
};

/** Rina's two leads that carry an age and a gender; every other lead carries neither (ADR-0224). */
export const PROPOSAL_DEMO_AGES: Readonly<Record<string, { age: number; gender: 'male' | 'female' }>> = {
  'Ibu Rosa Damayanti': { age: 42, gender: 'female' },
  'Pak Hendro Gunawan': { age: 51, gender: 'male' },
};

/**
 * **Rina's two proposals** (P19.7-T2): what each is made of, by product code — built with the module's own functions
 * (`newItem`, `applyItemPatch`), so the seed stores exactly what the API would. **Demo figures, not Prudential's.**
 */
export const PROPOSAL_DEMO_PROPOSALS: readonly {
  lead: string;
  channel: 'conventional' | 'syariah';
  done: boolean;
  items: { code: string; patch: ItemPatch }[];
}[] = [
  {
    lead: 'Ibu Rosa Damayanti',
    channel: 'syariah',
    done: true,
    items: [
      { code: 'PRUWELL_MEDICAL_SYARIAH', patch: { premium: { amountMinor: 1_250_000_00 } } },
      {
        code: 'PRUCERAH',
        patch: { insured: { relation: 'child', name: 'Nadia', age: 8 }, fieldValues: { penarikan_bulanan: 2_500_000_00 }, premium: { amountMinor: 750_000_00 } },
      },
    ],
  },
  { lead: 'Pak Hendro Gunawan', channel: 'conventional', done: false, items: [{ code: 'PRUWELL_MEDICAL', patch: {} }] },
];

/**
 * **The AB demo login's two Sales leads and their proposals** (P19.11-T3 AC-1, AC-7; UX-9, UX-11), so the card's icon
 * rule and the sheet's one finished proposal show in a browser as `agus@kpm0417.test`:
 *
 * - *Ibu Natalia Prameswari*: a **Selesai** proposal saved yesterday, and a **Draf** changed since — the card wears the
 *   proposal icon, which opens the finished one; her sheet's *Proposal* shows that one alone, above *Buat proposal*.
 * - *Pak Benny Tanoto*: **drafts only** — one with a product, one still empty — so his card has no icon and his sheet's
 *   *Proposal* is *Buat proposal* alone. Both stay in *Riwayat proposal*, where a draft is resumed.
 *
 * Clients take names no member of the office has (`calendar-fixture.ts`). Ids derived (`seedObjectId`), so a second run
 * writes nothing. **Demo figures, not Prudential's.**
 */
export const PROPOSAL_DEMO_AB_LEADS: readonly {
  key: string;
  name: string;
  age: number;
  gender: 'male' | 'female';
  phone: string;
  stage: string;
  proposals: { done: boolean; hoursAgo: number; items: { code: string; patch: ItemPatch }[] }[];
}[] = [
  {
    key: 'agus-finished', name: 'Ibu Natalia Prameswari', age: 38, gender: 'female', phone: '+6281355502468',
    stage: 'APPROVED_NOT_PAID',
    proposals: [
      { done: true, hoursAgo: 26, items: [{ code: 'PRUWELL_MEDICAL', patch: { premium: { amountMinor: 950_000_00 } } }] },
      { done: false, hoursAgo: 2, items: [{ code: 'PRUWELL_MEDICAL', patch: {} }] },
    ],
  },
  {
    key: 'agus-drafts', name: 'Pak Benny Tanoto', age: 45, gender: 'male', phone: '+6281355502469', stage: 'FOLLOW_UP',
    proposals: [
      { done: false, hoursAgo: 5, items: [{ code: 'PRUWELL_MEDICAL', patch: {} }] },
      { done: false, hoursAgo: 3, items: [] },
    ],
  },
];

/** The AB's seeded lead's id: derived, so a re-seed finds it (`seedObjectId`). */
export const proposalDemoLeadId = (kpmId: string, key: string) => seedObjectId('proposal-fixture', 'lead', kpmId, key);

export interface ProposalFixtureDeps {
  clock: Clock;
  /** The demo's Prudential company. */
  companyId: string;
  kpm0417: string;
  rina: string;
  /** The AB demo login's membership (`agus@kpm0417.test`), for `PROPOSAL_DEMO_AB_LEADS`. */
  agus: string;
  superAdminUserId: string;
}

export interface ProposalFixture {
  imported: ProposalFieldsImportReport;
  worded: number;
  aged: number;
  /** Rina's proposals written by this run: two the first time, none after. */
  proposals: number;
  /** The AB's leads and proposals written by this run (P19.11-T3): two and four the first time, none after. */
  abLeads: number;
  abProposals: number;
  guide: string;
}

export async function seedProposalFixture(deps: ProposalFixtureDeps): Promise<ProposalFixture> {
  const { clock, companyId } = deps;
  const Products = mongoose.model(Product.name, ProductSchema, undefined, RECOMPILE) as unknown as Model<ProductDocument>;
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema, undefined, RECOMPILE);
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, clock.now());

  // The Prudential draft, by the operator's own function (ADR-0225 §10).
  const imported = await importProposalFields(
    {
      products: Products,
      clock,
      audit: async (entry) => {
        await Audit.create({ ...entry, kpmId: null, actorUserId: deps.superAdminUserId, actorMembershipId: null });
      },
    },
    companyId,
    { name: PRUDENTIAL_PROPOSAL_IMPORT, rows: PRUDENTIAL_PROPOSAL_ROWS },
  );

  // Plans and a FAQ on two products, only where the product has neither.
  let worded = 0;
  for (const [code, words] of Object.entries(PROPOSAL_DEMO_WORDS)) {
    const result = await Products.findOneAndUpdate(
      { companyId, code, deletedAt: null, planOptions: { $size: 0 }, faq: { $size: 0 } },
      { $set: { planOptions: words.planOptions, faq: words.faq }, $inc: { version: 1 } },
      { new: true },
    ).exec();
    if (!result) continue;
    await Audit.create({
      kpmId: null, actorUserId: deps.superAdminUserId, action: 'product.updated', targetCollection: 'products',
      targetId: String(result._id), before: { planOptions: 0, faq: 0 }, after: { fields: ['planOptions', 'faq'] },
    });
    worded += 1;
  }

  // The client's age and gender on two of Rina's leads, only where the lead has no age yet.
  let aged = 0;
  for (const [name, { age, gender }] of Object.entries(PROPOSAL_DEMO_AGES)) {
    const result = await Leads.updateOne(
      { kpmId: deps.kpm0417, ownerMembershipId: deps.rina, name, deletedAt: null, $or: [{ age: null }, { age: { $exists: false } }] },
      { $set: { age, ageRecordedOn: today, gender } },
    ).exec();
    aged += result.modifiedCount;
  }

  // Rina's two proposals (P19.7-T2), only while she has none: a walk that edited or deleted them is never undone.
  const Proposals = mongoose.model(Proposal.name, ProposalSchema, undefined, RECOMPILE);
  let proposals = 0;
  if (!(await Proposals.exists({ kpmId: deps.kpm0417, ownerMembershipId: deps.rina }))) {
    // Finished an hour ago, so the leader's *Proposal* column counts it this month.
    const earlier = new Date(clock.now().getTime() - 60 * 60 * 1000);
    for (const plan of PROPOSAL_DEMO_PROPOSALS) {
      const lead = await Leads.findOne({ kpmId: deps.kpm0417, ownerMembershipId: deps.rina, name: plan.lead, deletedAt: null }).lean().exec() as
        { _id: unknown; name: string; age: number | null; gender: 'male' | 'female' | null } | null;
      if (!lead || lead.age === null || !lead.gender) continue;
      const items: StoredItem[] = [];
      for (const { code, patch } of plan.items) {
        const product = await Products.findOne({ companyId, code, deletedAt: null }).exec();
        if (!product) continue;
        items.push(applyItemPatch(newItem(new mongoose.Types.ObjectId().toHexString(), product, product.name), patch));
      }
      const at = plan.done ? earlier : clock.now();
      await Proposals.create({
        kpmId: deps.kpm0417, ownerMembershipId: deps.rina, leadId: String(lead._id),
        client: { name: lead.name, age: lead.age, gender: lead.gender },
        channel: plan.channel, payFrequency: 'monthly', showTotal: false,
        status: plan.done ? 'done' : 'draft', doneAt: plan.done ? at : null, firstDoneAt: plan.done ? at : null,
        firstDoneProducts: plan.done ? items.map((item) => itemName(item.snapshot, plan.channel)) : [],
        items, duplicatedFrom: null, version: 1, createdBy: deps.rina, updatedBy: deps.rina,
        createdAt: at, updatedAt: at,
      });
      proposals += 1;
    }
  }

  // The AB demo login's two leads and their proposals (P19.11-T3), each written once by its derived id.
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema, undefined, RECOMPILE);
  let abLeads = 0;
  let abProposals = 0;
  for (const plan of PROPOSAL_DEMO_AB_LEADS) {
    const leadId = proposalDemoLeadId(deps.kpm0417, plan.key);
    if (await Leads.exists({ _id: new mongoose.Types.ObjectId(leadId) }).exec()) continue;
    const status = await LeadStatuses.findOne({ kpmId: deps.kpm0417, code: plan.stage }).lean().exec() as { _id: unknown } | null;
    const registered = new Date(clock.now().getTime() - 12 * 24 * 60 * 60 * 1000);
    await Leads.create({
      _id: new mongoose.Types.ObjectId(leadId),
      kpmId: deps.kpm0417, ownerMembershipId: deps.agus, name: plan.name, type: 'sales',
      contact: { phone: plan.phone, email: null },
      statusCode: plan.stage, statusId: status ? String(status._id) : null,
      commitments: [], remarks: null, nextActionDate: null, nextActionNote: null,
      outcome: null, outcomeAt: null, dateRegistered: registered, source: null, joinedMembershipId: null,
      age: plan.age, ageRecordedOn: today, gender: plan.gender,
      version: 2, transitions: [{ fromStatusCode: null, toStatusCode: plan.stage, at: registered, byMembershipId: deps.agus }],
      deletedAt: null, createdBy: deps.agus, updatedBy: deps.agus,
    });
    abLeads += 1;
    for (const [index, proposal] of plan.proposals.entries()) {
      const items: StoredItem[] = [];
      for (const { code, patch } of proposal.items) {
        const product = await Products.findOne({ companyId, code, deletedAt: null }).exec();
        if (!product) continue;
        items.push(applyItemPatch(newItem(seedObjectId('proposal-fixture', 'item', leadId, String(index), code), product, product.name), patch));
      }
      const at = new Date(clock.now().getTime() - proposal.hoursAgo * 60 * 60 * 1000);
      await Proposals.create({
        _id: new mongoose.Types.ObjectId(seedObjectId('proposal-fixture', 'proposal', leadId, String(index))),
        kpmId: deps.kpm0417, ownerMembershipId: deps.agus, leadId,
        client: { name: plan.name, age: plan.age, gender: plan.gender },
        channel: 'conventional', payFrequency: 'monthly', showTotal: false,
        status: proposal.done ? 'done' : 'draft', doneAt: proposal.done ? at : null, firstDoneAt: proposal.done ? at : null,
        firstDoneProducts: proposal.done ? items.map((item) => itemName(item.snapshot, 'conventional')) : [],
        items, duplicatedFrom: null, version: 1, createdBy: deps.agus, updatedBy: deps.agus,
        createdAt: at, updatedAt: at,
      });
      abProposals += 1;
    }
  }

  const guide = `
  THE PROPOSAL'S FIELDS  (from src/seed/proposal-fixture.ts)
    superadmin@agencyboost.test  /admin/companies → Prudential → Produk → a product → Proposal: the Prudential
                                 draft of 3 Nov (17 products), "Perlu dicek" on each [cek] field; PRUWell Medical
                                 and PRUCerah with plans and a Tanya-jawab (demo figures, not Prudential's)
    owner@kpm0417.test           /kpm/settings/products → PRUWell Medical → Sesuaikan: Tanya-jawab and each plan's
                                 highlights, the company's until the office writes and approves its own
    rina@kpm0417.test            /leads: Ibu Rosa Damayanti (42, Perempuan) and Pak Hendro Gunawan (51, Laki-laki)
                                 carry Umur and the gender; Ibu Wulan Sari neither
    rina@kpm0417.test            /proposal: Riwayat with a Selesai proposal (Ibu Rosa Damayanti, Syariah, PRUWell
                                 Medical Syariah + PRUCerah for her daughter) and a Draf (Pak Hendro Gunawan, PRUWell
                                 Medical, premium to type); /leads: both cards carry the proposal pill, Ibu Rosa's
                                 sheet has the Proposal section and "Proposal dibuat" in Riwayat
    her leader, /unit/dashboard  the Proposal column: 1 for Rina this month, and nothing about the client
    agus@kpm0417.test            /leads: Ibu Natalia Prameswari wears the proposal icon (a Selesai proposal; a later
                                 Draf hidden) and it opens the Selesai one; Pak Benny Tanoto (drafts only) has none.
                                 Her sheet's Proposal shows the one Selesai proposal above Buat proposal; his shows
                                 Buat proposal alone. Both drafts are in /proposal (Riwayat), where a draft is resumed
`;
  return { imported, worded, aged, proposals, abLeads, abProposals, guide };
}
