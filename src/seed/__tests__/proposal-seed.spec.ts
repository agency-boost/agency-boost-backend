import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { PROPOSAL_DEMO_AGES, PROPOSAL_DEMO_WORDS, seedProposalFixture } from '../proposal-fixture';

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
 * **P19.7-T1 AC-1, AC-4 — the proposal's fields, seeded** (`proposal-fixture.ts`): the Prudential draft imported by the
 * operator's own function, plans and a FAQ on two products, an age and a gender on two of Rina's leads and on no other —
 * and a second run writes nothing. Read back through the services, so what is asserted is what the screens read.
 */
describe('P19.7-T1 the proposal seed', () => {
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

  it('P19.7-T1 AC-4 imports the Prudential draft onto the company: 17 products written, PRUProsper reported', async () => {
    const first = await seedProposalFixture(deps);
    expect(first.imported.written).toHaveLength(17);
    expect(first.imported.missing).toEqual(['PRUPROSPER']);
    expect(first.worded).toBe(2);
    expect(first.aged).toBe(2);
    expect(first.proposals).toBe(2);
    expect([first.abLeads, first.abProposals]).toEqual([2, 4]);
    const medical = (await wired.products.list(COMPANY, { withCommission: false })).find((p) => p.code === 'PRUWELL_MEDICAL')!;
    expect(medical.proposalFields.map((f) => f.key)).toEqual(['plan', 'wilayah', 'kamar', 'saver']);
    expect(medical.planOptions).toEqual(PROPOSAL_DEMO_WORDS.PRUWELL_MEDICAL.planOptions);
    expect(medical.faq).toEqual(PROPOSAL_DEMO_WORDS.PRUWELL_MEDICAL.faq);
    expect(first.guide).toContain('Perlu dicek');
  });

  it('P19.7-T1 AC-4 every demo plan card names an option of its product’s plan field, as a save would check', async () => {
    const products = await wired.products.list(COMPANY, { withCommission: false });
    for (const code of Object.keys(PROPOSAL_DEMO_WORDS)) {
      const product = products.find((p) => p.code === code)!;
      const names = product.proposalFields.find((f) => f.plan)!.options.map((o) => o.label);
      for (const plan of product.planOptions) expect(names).toContain(plan.name);
    }
  });

  it('P19.7-T1 AC-1 gives two of Rina’s leads an age and a gender, and the rest neither', async () => {
    const rows = (await wired.leadRecords.list(rina, { pageSize: 200 })).rows;
    for (const [name, { age, gender }] of Object.entries(PROPOSAL_DEMO_AGES)) {
      expect(rows.find((r) => r.name === name)).toMatchObject({ age, gender, ageRecordedOn: '2026-11-05' });
    }
    expect(rows.find((r) => r.name === 'Ibu Wulan Sari')).toMatchObject({ age: null, gender: null });
  });

  it('P19.7-T2 AC-10 gives Rina a Selesai proposal and a Draf, as the API stores them (the seed’s *Riwayat*)', async () => {
    const page = await wired.proposals.list(rina, {});
    expect(page.rows.map((r) => [r.client.name, r.status])).toEqual(expect.arrayContaining([
      ['Ibu Rosa Damayanti', 'done'], ['Pak Hendro Gunawan', 'draft'],
    ]));
    const done = page.rows.find((r) => r.status === 'done')!;
    expect(done.products.map((p) => p.name)).toEqual(['PRUWell Medical Syariah', 'PRUCerah']);
    expect(done.totals).toEqual([{ currency: 'IDR', amountMinor: 2_000_000_00 }]);
    const read = await wired.proposals.read(rina, done.id);
    expect(read).toMatchObject({ channel: 'syariah', client: { age: 42, gender: 'female' } });
    expect(read.items[1]).toMatchObject({ insured: { relation: 'child', name: 'Nadia', age: 8 }, choice: null });
    // Complete and still offered on 0417's shelf: *Simpan PDF* takes it again.
    expect((await wired.proposals.done(rina, done.id, read.version)).status).toBe('done');
  });

  it('P19.7-T2 AC-12 shows both proposals on Rina’s leads, and the Selesai one in Ibu Rosa’s Riwayat', async () => {
    const rows = (await wired.leadRecords.list(rina, { pageSize: 200 })).rows;
    const rosaDone = (await wired.proposals.list(rina, { status: 'done' })).rows.find((r) => r.client.name === 'Ibu Rosa Damayanti')!;
    expect(rows.find((r) => r.name === 'Ibu Rosa Damayanti')!.proposals).toEqual({
      count: 1, latest: { products: ['PRUWell Medical Syariah', 'PRUCerah'] }, done: 1, latestDone: { id: rosaDone.id },
    });
    expect(rows.find((r) => r.name === 'Pak Hendro Gunawan')!.proposals).toEqual({
      count: 1, latest: { products: ['PRUWell Medical'] }, done: 0, latestDone: null,
    });
    expect(rows.find((r) => r.name === 'Ibu Wulan Sari')!.proposals).toBeNull();
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
    expect(natalia).toMatchObject({ type: 'sales', age: 38, gender: 'female', contact: { phone: '+6281355502468' } });
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
    expect([again.worded, again.aged, again.proposals, again.abLeads, again.abProposals]).toEqual([0, 0, 0, 0, 0]);
    expect(await mongoose.connection.db!.collection('products').find({}).toArray()).toEqual(products);
  });
});
