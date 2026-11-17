import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { PROPOSAL_DEMO_WORDS, seedProposalFixture } from '../proposal-fixture';

const NOW = new Date('2026-11-05T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const KPM = '66f0000000000000000000a1';
const RINA = '66f000000000000000000103';
const AGUS = '66f000000000000000000101';

const rina = new RequestContext('u-rina', 'none', {
  membershipId: RINA, kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);
/** The AB demo login (`agus@kpm0417.test`), for P19.11-T3's two leads. */
const agus = new RequestContext('u-agus', 'none', {
  membershipId: AGUS, kpmId: KPM, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **P19.7-T1 AC-4, P19.14 — the proposal, seeded** (`proposal-fixture.ts`): the Prudential list of 11 November imported
 * by the operator's own function, plans and a FAQ on two products, Rina's proposals — one with the client's details and
 * three products on three *Cara bayar* — the AB's leads, **no age or gender on any lead**, and a second run writes
 * nothing. Read back through the services, so what is asserted is what the screens read.
 */
describe('P19.7-T1 / P19.14 the proposal seed', () => {
  let wired: ReturnType<typeof configModule>;
  const clock = new FixedClock(NOW);
  const deps = { clock, companyId: COMPANY, kpm0417: KPM, rina: RINA, agus: AGUS, superAdminUserId: 'u-super' };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await mongoose.connection.db!.collection('companies').insertOne({
      _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'prudential', deletedAt: null,
    });
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    });
    await provisionOffice(wired, KPM, COMPANY);
    await wired.products.seedForCompany(COMPANY);
    for (const name of ['Ibu Rosa Damayanti', 'Pak Hendro Gunawan', 'Ibu Wulan Sari']) {
      await wired.leadRecords.create(rina, { name, type: 'sales' });
    }
  });
  afterAll(stopMongo);

  it('P19.14-T2 AC-5 imports the list of 11 November onto the company: 17 products written, production’s codes reported', async () => {
    const first = await seedProposalFixture(deps);
    expect(first.imported.written).toHaveLength(17);
    expect(first.imported.missing).toEqual(['PRUCARE_360_SYARIAH', 'PRUCERAH_PLUS', 'PRUPROSPER']);
    expect(first.worded).toBe(2);
    expect(first.proposals).toBe(3);
    expect([first.abLeads, first.abProposals]).toEqual([2, 4]);
    const products = await wired.products.list(COMPANY, { withCommission: false });
    const medical = products.find((p) => p.code === 'PRUWELL_MEDICAL')!;
    expect(medical.proposalFields.map((f) => [f.key, f.type])).toEqual([['wilayah', 'chips'], ['kamar', 'chips'], ['saver', 'chips'], ['plan', 'derived']]);
    expect(medical).toMatchObject({ calcType: 'plan_priced', entryAge: { min: 1, max: 75 }, needTag: 'HOSPITAL', rateTableId: null });
    expect(medical.planRule!.rules).toHaveLength(7);
    expect(medical.planOptions).toEqual(PROPOSAL_DEMO_WORDS.PRUWELL_MEDICAL.planOptions);
    expect(medical.faq).toEqual(PROPOSAL_DEMO_WORDS.PRUWELL_MEDICAL.faq);
    const pcb = products.find((p) => p.code === 'PRUCRITICAL_BENEFIT_88')!;
    expect(pcb).toMatchObject({ calcType: 'up_premium', proposalFields: [] });
    expect(pcb.payTerms.map((t) => [t.key, t.maxEntryAge, t.default])).toEqual([['y5', 60, false], ['y10', 60, true], ['y15', 50, false], ['single', 60, false]]);
    expect(products.find((p) => p.code === 'PRUCRITICAL_AMANAH')!.smokerRated).toBe(true);
    expect(products.find((p) => p.code === 'PRUMAPAN')!.frequencies).toEqual(['monthly', 'annual']);
    // Every product is typed by the agent until 19.15 loads a table.
    expect(products.every((p) => p.rateTableId === null)).toBe(true);
    expect(first.guide).toContain('Perhitungan');
  });

  it('P19.7-T1 AC-4 every demo plan card names an option of its product’s plan field, as a save would check', async () => {
    const products = await wired.products.list(COMPANY, { withCommission: false });
    for (const code of Object.keys(PROPOSAL_DEMO_WORDS)) {
      const product = products.find((p) => p.code === code)!;
      const names = product.proposalFields.find((f) => f.plan)?.options.map((o) => o.label) ?? [];
      for (const plan of product.planOptions) expect(names).toContain(plan.name);
    }
  });

  it('P19.14-T1 AC-4 gives no lead an age or a gender: the client’s are each proposal’s', async () => {
    expect(await mongoose.connection.db!.collection('leads').countDocuments({ $or: [{ age: { $exists: true } }, { gender: { $exists: true } }] })).toBe(0);
  });

  it('P19.14-T1 AC-3, T2 AC-3 gives Rina a proposal with the client’s details and three products on three Cara bayar', async () => {
    const wulan = (await wired.proposals.list(rina, {})).rows.find((r) => r.client.name === 'Ibu Wulan Sari')!;
    const read = await wired.proposals.read(rina, wulan.id);
    expect(read).toMatchObject({
      status: 'done',
      client: { age: 35, gender: 'female', details: { status: 'married', dependants: 'Suami, 2 anak', occupation: 'Guru', city: 'Bandung', needs: ['HOSPITAL', 'CRITICAL_INCOME', 'EDUCATION'] } },
    });
    expect(read.items.map((i) => [i.productCode, i.payFrequency, i.snapshot.isSyariah])).toEqual([
      ['PRUWELL_MEDICAL_SYARIAH', 'monthly', true], ['PRUCRITICAL_BENEFIT_88', 'annual', false], ['PRUCERAH', 'monthly', true],
    ]);
    expect(read.items[0].plan).toBe('Bronze B');
    expect(read.items[1]).toMatchObject({ payTerm: 'y10', up: { amountMinor: 500_000_000_00 }, premium: { amountMinor: 4_200_000_00 } });
    expect(read.items[2].insured).toEqual({ relation: 'child', name: 'Raka', age: 6, gender: 'male' });
    expect(read.totals.map((t) => [t.payFrequency, t.amountMinor])).toEqual([['monthly', 1_500_000_00], ['annual', 4_200_000_00]]);
    // Complete and still offered on 0417's shelf: Simpan PDF takes it again.
    expect((await wired.proposals.done(rina, read.id, read.version)).status).toBe('done');
  });

  it('P19.7-T2 AC-10 gives Rina a Selesai proposal and a Draf, as the API stores them (the seed’s *Riwayat*)', async () => {
    const page = await wired.proposals.list(rina, { status: undefined });
    expect(page.rows.map((r) => [r.client.name, r.status])).toEqual(expect.arrayContaining([
      ['Ibu Rosa Damayanti', 'done'], ['Pak Hendro Gunawan', 'draft'],
    ]));
    const done = page.rows.find((r) => r.status === 'done' && r.client.name === 'Ibu Rosa Damayanti')!;
    expect(done.products.map((p) => p.name)).toEqual(['PRUWell Medical Syariah', 'PRUCerah']);
    expect(done.totals).toEqual([{ currency: 'IDR', payFrequency: 'monthly', amountMinor: 2_000_000_00, items: 2 }]);
    const read = await wired.proposals.read(rina, done.id);
    expect(read).toMatchObject({ client: { age: 42, gender: 'female' } });
    expect(read.items[1]).toMatchObject({ insured: { relation: 'child', name: 'Nadia', age: 8, gender: 'female' }, choice: null });
    // Complete and still offered on 0417's shelf: *Simpan PDF* takes it again.
    expect((await wired.proposals.done(rina, done.id, read.version)).status).toBe('done');
  });

  it('P19.14-T4 AC-1 shows each proposal’s pill on Rina’s leads, and the Selesai ones in their Riwayat', async () => {
    const rows = (await wired.leadRecords.list(rina, { pageSize: 200 })).rows;
    const rosaDone = (await wired.proposals.list(rina, { status: 'done' })).rows.find((r) => r.client.name === 'Ibu Rosa Damayanti')!;
    expect(rows.find((r) => r.name === 'Ibu Rosa Damayanti')!.proposals).toMatchObject({
      count: 1, latest: { id: rosaDone.id, products: ['PRUWell Medical Syariah', 'PRUCerah'] }, done: 1, latestDone: { id: rosaDone.id },
      client: { age: 42, gender: 'female' },
    });
    expect(rows.find((r) => r.name === 'Pak Hendro Gunawan')!.proposals).toMatchObject({
      count: 1, latest: { products: ['PRUWell Medical'] }, done: 0, latestDone: null,
    });
    expect(rows.find((r) => r.name === 'Ibu Wulan Sari')!.proposals).toMatchObject({
      count: 1, latest: { products: ['PRUWell Medical Syariah', 'PRUCritical Benefit 88', 'PRUCerah'] }, client: { age: 35, details: { city: 'Bandung' } },
    });
    const rosa = await wired.leadRecords.read(rina, rows.find((r) => r.name === 'Ibu Rosa Damayanti')!.id);
    expect(rosa.history.filter((h) => h.kind === 'proposal')).toHaveLength(1);
  });

  it('P19.11-T3 AC-1 gives the AB demo login a lead with a finished proposal and one with drafts only, as the card reads them', async () => {
    const rows = (await wired.leadRecords.list(agus, { pageSize: 200 })).rows;
    const natalia = rows.find((r) => r.name === 'Ibu Natalia Prameswari')!;
    const benny = rows.find((r) => r.name === 'Pak Benny Tanoto')!;
    const done = (await wired.proposals.list(agus, { leadId: natalia.id, status: 'done', pageSize: 1 })).rows;
    expect(done).toHaveLength(1);
    // The icon: shown on hers and opening the finished one; none on his, whose proposals are drafts.
    expect(natalia.proposals).toMatchObject({ count: 2, done: 1, latestDone: { id: done[0].id } });
    expect(benny.proposals).toMatchObject({ count: 2, done: 0, latestDone: null });
    expect(natalia).toMatchObject({ type: 'sales', contact: { phone: '+6281355502468' } });
    expect(natalia).not.toHaveProperty('age');
    expect(natalia.proposals!.client).toMatchObject({ age: 38, gender: 'female' });
    // The finished one is complete and still offered: Simpan PDF takes it again.
    const read = await wired.proposals.read(agus, done[0].id);
    expect((await wired.proposals.done(agus, done[0].id, read.version)).status).toBe('done');
  });

  it('P19.11-T3 AC-7 the AB’s drafts-only lead lists nothing finished; both drafts are in Riwayat', async () => {
    const benny = (await wired.leadRecords.list(agus, { pageSize: 200 })).rows.find((r) => r.name === 'Pak Benny Tanoto')!;
    expect((await wired.proposals.list(agus, { leadId: benny.id, status: 'done' })).rows).toEqual([]);
    expect((await wired.proposals.list(agus, { leadId: benny.id })).rows.map((r) => r.status)).toEqual(['draft', 'draft']);
  });

  it('P19.7-T1 AC-4 writes nothing on a second run', async () => {
    const products = await mongoose.connection.db!.collection('products').find({}).toArray();
    const again = await seedProposalFixture(deps);
    expect(again.imported.written).toEqual([]);
    expect(again.imported.unchanged).toHaveLength(17);
    expect([again.worded, again.proposals, again.abLeads, again.abProposals]).toEqual([0, 0, 0, 0]);
    expect(await mongoose.connection.db!.collection('products').find({}).toArray()).toEqual(products);
  });
});
