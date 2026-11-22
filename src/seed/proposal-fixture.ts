import mongoose, { type Model } from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { Product, ProductSchema, type ProductDocument } from '@/modules/products/product.schema';
import { importProposalFields, type ProposalFieldsImportReport } from '@/modules/products/proposal-fields-import';
import {
  PRUDENTIAL_PROPOSAL_IMPORT, PRUDENTIAL_PROPOSAL_ROWS, PRUDENTIAL_PROPOSAL_SUPERSEDES,
} from '@/modules/products/proposal-fields-prudential';
import type { FaqEntry, PlanOption } from '@/modules/products/proposal-fields';
import { Proposal, ProposalSchema } from '@/modules/proposals/proposal.schema';
import { EMPTY_CLIENT_DETAILS, type ProposalClient, type ProposalClientDetails } from '@/modules/proposals/proposal-client';
import { applyItemPatch, itemName, newItem, type ItemPatch, type StoredItem } from '@/modules/proposals/proposal-items';
import { seedObjectId } from './coaching-fixture';

/**
 * **The proposal's lead and catalogue fields, seeded** (P19.7-T1 AC-1, AC-4; ADR-0224, ADR-0225 §10;
 * `functional/proposal.md`, `leads.md` and `sales-tools.md`).
 *
 * | What | Who to sign in as, and what they see |
 * |---|---|
 * | **The Prudential list of 11 November**, imported onto the demo's Prudential company by the operator's own function over the draft of 3 November (P19.14-T2; PRUProsper, PRUCare 360 Syariah and PRUCerah Plus are production's) | `superadmin@agencyboost.test` at `/admin/companies` → *Prudential* → *Produk* → a product → *Proposal*: its fields and, under *Perhitungan*, its calculation type, entry ages, pay terms, *Cara bayar*, smoker rating and plan rule |
 * | **Plans and a FAQ** on *PRUWell Medical* (plan cards of its derived plans) and a FAQ on *PRUCerah* — **demo figures, not Prudential's** | the same section's *Plan* and *Tanya-jawab*; `owner@kpm0417.test` at `/kpm/settings/products` → *PRUWell Medical* → *Sesuaikan* |
 * | **Rina's proposals**: a *Selesai* one for Ibu Rosa (PRUWell Medical Syariah and PRUCerah for her daughter), a *Draf* for Pak Hendro, and (P19.14) a *Selesai* one for Ibu Wulan Sari with her details — *Menikah*, *Suami, 2 anak*, *Guru*, *Bandung*, three needs — and three products on three *Cara bayar*: PRUWell Medical Syariah monthly (a syariah product), PCB88 annually with its sum assured, PRUCerah for her son monthly | `rina@kpm0417.test` at `/proposal` and `/leads`: each card's pill (*"PRUWell Medical Syariah +2"*), *Buat proposal*; Ibu Wulan Sari's sheet lists her proposal; *+ Buat proposal* on her starts from her details, her age moved up a year after a year |
 * | **The AB's leads** (P19.11-T3; `PROPOSAL_DEMO_AB_LEADS`) | `agus@kpm0417.test` at `/leads`: *Ibu Natalia Prameswari* — a *Selesai* and a later *Draf*, both rows in her sheet; *Pak Benny Tanoto* — two drafts, the pill from the one with a product |
 *
 * **No lead carries an age or a gender** (P19.14-T1; ADR-0254): the client's are each proposal's own.
 *
 * **Written once, until `--reset`.** The import changes nothing on a second run (it is the operator's, and says so);
 * the plans and the FAQ are written only onto a product that has neither — or, once, over the demo's own plan cards of
 * 3 November, which name plans the list of 11 November no longer has — so a walk that edited them is never undone.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** The two products whose *Plan* and *Tanya-jawab* the demo fills. Demo figures, not Prudential's. */
export const PROPOSAL_DEMO_WORDS: Readonly<Record<string, { planOptions: PlanOption[]; faq: FaqEntry[] }>> = {
  PRUWELL_MEDICAL: {
    // P19.14-T2: the plan is derived from *Wilayah* and *Kamar*; the cards compare five of its values.
    planOptions: [
      { name: 'Bronze A', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 500 rb' }, { label: 'Batas tahunan', value: 'Rp 5 M' }, { label: 'Wilayah', value: 'Indonesia' }] },
      { name: 'Silver A', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 1 jt' }, { label: 'Batas tahunan', value: 'Rp 10 M' }, { label: 'Wilayah', value: 'Asia (kec. JPN, HK, SGP)' }] },
      { name: 'Gold', popular: true, highlights: [{ label: 'Kamar per hari', value: 'Rp 1,5 jt' }, { label: 'Batas tahunan', value: 'Rp 25 M' }, { label: 'Wilayah', value: 'Seluruh Asia' }] },
      { name: 'Platinum', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 2,5 jt' }, { label: 'Batas tahunan', value: 'Rp 50 M' }, { label: 'Wilayah', value: 'Dunia (kec. USA)' }] },
      { name: 'Diamond', popular: false, highlights: [{ label: 'Kamar per hari', value: 'Rp 4 jt' }, { label: 'Batas tahunan', value: 'Rp 100 M' }, { label: 'Wilayah', value: 'Seluruh Dunia' }] },
    ],
    faq: [
      { question: 'Apakah ada masa tunggu?', answer: 'Ada, 30 hari untuk sakit biasa.\nTidak ada masa tunggu untuk kecelakaan.' },
      { question: 'Bisakah dipakai di luar negeri?', answer: 'Bisa, sesuai wilayah yang dipilih: Asia, Seluruh Asia, atau Seluruh Dunia.' },
      { question: 'Apa itu Saver?', answer: 'Pilihan yang membuat premi lebih ringan, dengan sebagian biaya ditanggung sendiri.' },
    ],
  },
  PRUCERAH: {
    // P19.14-T2: PRUCerah has no plan field since the list of 11 November (PRUCerah Plus is its own product).
    planOptions: [],
    faq: [
      { question: 'Kapan dana pendidikan mulai cair?', answer: 'Setelah masa tunggu selesai, setiap bulan sesuai penarikan yang dipilih.' },
    ],
  },
};

/** A client as the demo writes one: an age and a gender, and details where the plan says. */
const demoClient = (
  name: string, age: number, gender: 'male' | 'female', ageSetOn: string, details: Partial<ProposalClientDetails> = {},
): ProposalClient => ({ name, age, ageSetOn, gender, details: { ...EMPTY_CLIENT_DETAILS, ...details } });

/**
 * **Rina's proposals** (P19.7-T2; P19.14): what each is made of, by product code — built with the module's own functions
 * (`newItem`, `applyItemPatch`), so the seed stores exactly what the API would. **Demo figures, not Prudential's.**
 * The first two are written while Rina has no proposal; the third (P19.14) by its own derived id, once.
 */
export const PROPOSAL_DEMO_PROPOSALS: readonly {
  key: string;
  lead: string;
  client: { age: number; gender: 'male' | 'female'; details?: Partial<ProposalClientDetails> };
  done: boolean;
  items: { code: string; patch: ItemPatch }[];
}[] = [
  {
    key: 'rina-rosa',
    lead: 'Ibu Rosa Damayanti',
    client: { age: 42, gender: 'female' },
    done: true,
    items: [
      { code: 'PRUWELL_MEDICAL_SYARIAH', patch: { premium: { amountMinor: 1_250_000_00 } } },
      {
        code: 'PRUCERAH',
        patch: { insured: { relation: 'child', name: 'Nadia', age: 8, gender: 'female' }, fieldValues: { penarikan_bulanan: 2_500_000_00 }, premium: { amountMinor: 750_000_00 } },
      },
    ],
  },
  { key: 'rina-hendro', lead: 'Pak Hendro Gunawan', client: { age: 51, gender: 'male' }, done: false, items: [{ code: 'PRUWELL_MEDICAL', patch: {} }] },
];

/**
 * **P19.14's demo proposal** (ADR-0254, ADR-0255): the client's details on the proposal, and three products on three
 * *Cara bayar* — a syariah product monthly, PCB88 annually with its sum assured on a 10-year term, PRUCerah for her son
 * monthly — so the result screen's totals, the lead's pill and its sheet all show in a browser. Written once, by id.
 */
export const PROPOSAL_DEMO_P1914 = {
  key: 'rina-wulan',
  lead: 'Ibu Wulan Sari',
  client: {
    age: 35, gender: 'female' as const,
    details: {
      status: 'married' as const, dependants: 'Suami, 2 anak', occupation: 'Guru', city: 'Bandung',
      needs: ['HOSPITAL' as const, 'CRITICAL_INCOME' as const, 'EDUCATION' as const],
    },
  },
  done: true,
  items: [
    { code: 'PRUWELL_MEDICAL_SYARIAH', patch: { fieldValues: { kamar: '1 tempat tidur' }, premium: { amountMinor: 850_000_00 } } as ItemPatch },
    {
      code: 'PRUCRITICAL_BENEFIT_88',
      patch: { payTerm: 'y10', payFrequency: 'annual', up: { amountMinor: 500_000_000_00 }, premium: { amountMinor: 4_200_000_00 } } as ItemPatch,
    },
    {
      code: 'PRUCERAH',
      patch: {
        insured: { relation: 'child', name: 'Raka', age: 6, gender: 'male' }, fieldValues: { penarikan_bulanan: 2_000_000_00 },
        premium: { amountMinor: 650_000_00 },
      } as ItemPatch,
    },
  ],
};

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
  /** The client the proposals carry — never the lead (ADR-0254). */
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
  /** Rina's proposals written by this run: three the first time, none after. */
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

  // The Prudential list of 11 November, by the operator's own function, over the draft of 3 November (ADR-0255 §9).
  const imported = await importProposalFields(
    {
      products: Products,
      clock,
      audit: async (entry) => {
        await Audit.create({ ...entry, kpmId: null, actorUserId: deps.superAdminUserId, actorMembershipId: null });
      },
    },
    companyId,
    { name: PRUDENTIAL_PROPOSAL_IMPORT, rows: PRUDENTIAL_PROPOSAL_ROWS, supersedes: PRUDENTIAL_PROPOSAL_SUPERSEDES },
  );

  // Plans and a FAQ on two products, only where the product has neither — or still holds a plan card the list of
  // 11 November no longer names (the demo's own of 3 November).
  let worded = 0;
  for (const [code, words] of Object.entries(PROPOSAL_DEMO_WORDS)) {
    const product = await Products.findOne({ companyId, code, deletedAt: null }).exec();
    if (!product) continue;
    const planNames = (product.proposalFields ?? []).find((f) => f.plan)?.options.map((o) => o.label) ?? [];
    const stale = (product.planOptions ?? []).some((plan) => !planNames.includes(plan.name));
    const empty = (product.planOptions ?? []).length === 0 && (product.faq ?? []).length === 0;
    if (!empty && !stale) continue;
    const result = await Products.findOneAndUpdate(
      { _id: product._id, version: product.version },
      { $set: { planOptions: words.planOptions, faq: words.faq }, $inc: { version: 1 } },
      { new: true },
    ).exec();
    if (!result) continue;
    await Audit.create({
      kpmId: null, actorUserId: deps.superAdminUserId, action: 'product.updated', targetCollection: 'products',
      targetId: String(result._id), before: { planOptions: product.planOptions.length, faq: product.faq.length },
      after: { fields: ['planOptions', 'faq'] },
    });
    worded += 1;
  }

  const Proposals = mongoose.model(Proposal.name, ProposalSchema, undefined, RECOMPILE);
  /** A proposal's items, built with the module's own functions for this client's age. */
  const itemsOf = async (plan: readonly { code: string; patch: ItemPatch }[], age: number, idOf: (code: string) => string) => {
    const items: StoredItem[] = [];
    for (const { code, patch } of plan) {
      const product = await Products.findOne({ companyId, code, deletedAt: null }).exec();
      if (!product) continue;
      items.push(applyItemPatch(newItem(idOf(code), product, product.name, age), patch, age));
    }
    return items;
  };
  /** Finished an hour ago, so the leader's *Proposal* column counts it this month. */
  const earlier = new Date(clock.now().getTime() - 60 * 60 * 1000);
  const write = async (
    plan: { key?: string; lead: string; client: { age: number; gender: 'male' | 'female'; details?: Partial<ProposalClientDetails> }; done: boolean; items: { code: string; patch: ItemPatch }[] },
    id: string | null,
  ): Promise<boolean> => {
    const lead = await Leads.findOne({ kpmId: deps.kpm0417, ownerMembershipId: deps.rina, name: plan.lead, deletedAt: null }).lean().exec() as
      { _id: unknown; name: string } | null;
    if (!lead) return false;
    const items = await itemsOf(plan.items, plan.client.age, () => new mongoose.Types.ObjectId().toHexString());
    const at = plan.done ? earlier : clock.now();
    await Proposals.create({
      ...(id ? { _id: new mongoose.Types.ObjectId(id) } : {}),
      kpmId: deps.kpm0417, ownerMembershipId: deps.rina, leadId: String(lead._id),
      client: demoClient(lead.name, plan.client.age, plan.client.gender, today, plan.client.details),
      showTotal: false,
      status: plan.done ? 'done' : 'draft', doneAt: plan.done ? at : null, firstDoneAt: plan.done ? at : null,
      firstDoneProducts: plan.done ? items.map((item) => itemName(item.snapshot)) : [],
      items, duplicatedFrom: null, version: 1, createdBy: deps.rina, updatedBy: deps.rina,
      createdAt: at, updatedAt: at,
    });
    return true;
  };

  // Rina's two proposals (P19.7-T2), only while she has none: a walk that edited or deleted them is never undone.
  let proposals = 0;
  if (!(await Proposals.exists({ kpmId: deps.kpm0417, ownerMembershipId: deps.rina }))) {
    for (const plan of PROPOSAL_DEMO_PROPOSALS) if (await write(plan, null)) proposals += 1;
  }
  // P19.14's: the client's details and three Cara bayar, once by its derived id — on a database seeded before, too.
  const p1914 = seedObjectId('proposal-fixture', 'proposal', deps.kpm0417, PROPOSAL_DEMO_P1914.key);
  if (!(await Proposals.exists({ _id: new mongoose.Types.ObjectId(p1914) }))) {
    if (await write(PROPOSAL_DEMO_P1914, p1914)) proposals += 1;
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
      version: 2, transitions: [{ fromStatusCode: null, toStatusCode: plan.stage, at: registered, byMembershipId: deps.agus }],
      deletedAt: null, createdBy: deps.agus, updatedBy: deps.agus,
    });
    abLeads += 1;
    for (const [index, proposal] of plan.proposals.entries()) {
      const items = await itemsOf(proposal.items, plan.age, (code) => seedObjectId('proposal-fixture', 'item', leadId, String(index), code));
      const at = new Date(clock.now().getTime() - proposal.hoursAgo * 60 * 60 * 1000);
      await Proposals.create({
        _id: new mongoose.Types.ObjectId(seedObjectId('proposal-fixture', 'proposal', leadId, String(index))),
        kpmId: deps.kpm0417, ownerMembershipId: deps.agus, leadId,
        client: demoClient(plan.name, plan.age, plan.gender, today),
        showTotal: false,
        status: proposal.done ? 'done' : 'draft', doneAt: proposal.done ? at : null, firstDoneAt: proposal.done ? at : null,
        firstDoneProducts: proposal.done ? items.map((item) => itemName(item.snapshot)) : [],
        items, duplicatedFrom: null, version: 1, createdBy: deps.agus, updatedBy: deps.agus,
        createdAt: at, updatedAt: at,
      });
      abProposals += 1;
    }
  }

  const guide = `
  THE PROPOSAL  (from src/seed/proposal-fixture.ts)
    superadmin@agencyboost.test  /admin/companies → Prudential → Produk → a product → Proposal: the Prudential list
                                 of 11 Nov (its fields, and under Perhitungan its calculation type, entry ages, pay
                                 terms with their maximum entry age, Cara bayar, smoker rating and plan rule)
    owner@kpm0417.test           /kpm/settings/products → PRUWell Medical → Sesuaikan: Tanya-jawab and each plan's
                                 highlights, the company's until the office writes and approves its own
    rina@kpm0417.test            /proposal: Riwayat — Ibu Wulan Sari (Selesai: PRUWell Medical Syariah monthly, PCB88
                                 annually with UP Rp 500 jt, PRUCerah for Raka monthly; Menikah, Guru, Bandung), Ibu
                                 Rosa Damayanti (Selesai) and Pak Hendro Gunawan (Draf). /leads: each card's pill and
                                 Buat proposal; Ibu Wulan Sari → + Buat proposal starts from her details. No lead
                                 carries an age or a gender
    her leader, /unit/dashboard  the Proposal column: Rina's this month, and nothing about the client
    agus@kpm0417.test            /leads: Ibu Natalia Prameswari (a Selesai and a later Draf, both in her sheet) and Pak
                                 Benny Tanoto (two drafts; the pill from the one with a product)
`;
  return { imported, worded, proposals, abLeads, abProposals, guide };
}
