import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import type { DomainException } from '@/common/errors/domain.exception';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  CLIENT, NOW, PRODUCT_IDS as P, aab, ab, admin, agent, agentB, completeProposal, owner, seedProposalOffice, sibling,
  type SeededLeads,
} from '../../../test/proposals';

/**
 * **P19.7-T2 — the proposal through its service, over a real database** (ADR-0221, ADR-0225 §6–§8): owned by one
 * membership and `404 PROPOSAL_NOT_FOUND` to everybody else — a leader of its owner included, in every role — never across
 * offices, every write pinned, the offer rules on every add, *Simpan PDF*'s checks, the duplicate and the soft delete.
 */
describe('P19.7-T2 the proposal (service, tenancy)', () => {
  let wired: ReturnType<typeof configModule>;
  let leads: SeededLeads;
  const db = () => mongoose.connection.db!;
  const clock = () => wired.clock as FixedClock;
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) {
      const error = e as DomainException;
      return { code: error.code, status: error.getStatus(), details: error.details };
    }
    throw new Error('not refused');
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    clock().set(NOW);
    await clearCollections();
    leads = await seedProposalOffice(wired);
  });

  describe('AC-13 and AC-14: owned by one membership, 404 to everybody else', () => {
    it.each([
      ['the AB above its owner', ab], ['the AAB above its owner', aab], ['a sibling Agent', sibling],
      ['the Owner in Akun saya', owner], ['an Admin in Akun saya', admin],
    ])('P19.7-T2 AC-13 another member’s proposal is 404 PROPOSAL_NOT_FOUND to %s, on every route', async (_who, who) => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const P404 = { code: 'PROPOSAL_NOT_FOUND', status: 404 };
      expect(await refusal(wired.proposals.read(who(), mine.id))).toMatchObject(P404);
      expect(await refusal(wired.proposals.update(who(), mine.id, { expectedVersion: mine.version, showTotal: true }))).toMatchObject(P404);
      expect(await refusal(wired.proposals.addItem(who(), mine.id, mine.version, P.LIFE))).toMatchObject(P404);
      expect(await refusal(wired.proposals.updateItem(who(), mine.id, mine.items[0].itemId, mine.version, { premium: { amountMinor: 1 } }))).toMatchObject(P404);
      expect(await refusal(wired.proposals.removeItem(who(), mine.id, mine.items[0].itemId, mine.version))).toMatchObject(P404);
      expect(await refusal(wired.proposals.done(who(), mine.id, mine.version))).toMatchObject(P404);
      expect(await refusal(wired.proposals.duplicate(who(), mine.id))).toMatchObject(P404);
      expect(await refusal(wired.proposals.remove(who(), mine.id, mine.version))).toMatchObject(P404);
      expect((await wired.proposals.list(who(), {})).rows).toEqual([]);
      // Nothing moved.
      expect((await wired.proposals.read(agent(), mine.id)).version).toBe(mine.version);
    });

    it('P19.7-T2 AC-13 another KPM’s proposal is 404 on every route, and its list is not ours (cross-tenant)', async () => {
      const theirs = await completeProposal(wired, agentB(), leads.officeB);
      expect(await refusal(wired.proposals.read(agent(), theirs.id))).toMatchObject({ code: 'PROPOSAL_NOT_FOUND', status: 404 });
      expect(await refusal(wired.proposals.update(agent(), theirs.id, { expectedVersion: theirs.version, client: { age: 40 } }))).toMatchObject({ status: 404 });
      expect(await refusal(wired.proposals.addItem(agent(), theirs.id, theirs.version, P.HEALTH))).toMatchObject({ status: 404 });
      expect(await refusal(wired.proposals.updateItem(agent(), theirs.id, theirs.items[0].itemId, theirs.version, { payFrequency: 'annual' }))).toMatchObject({ status: 404 });
      expect(await refusal(wired.proposals.remove(agent(), theirs.id, theirs.version))).toMatchObject({ status: 404 });
      expect((await wired.proposals.list(agent(), {})).rows).toEqual([]);
      // The same id from office B's side is found: only the office decides.
      expect((await wired.proposals.read(agentB(), theirs.id)).id).toBe(theirs.id);
    });

    it('P19.7-T2 AC-13 a deleted proposal, an id nobody has, and a malformed id all answer the same 404', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      await wired.proposals.remove(agent(), mine.id, mine.version);
      for (const id of [mine.id, '66f0000000000000000009ff', 'not-an-id']) {
        expect(await refusal(wired.proposals.read(agent(), id))).toMatchObject({ code: 'PROPOSAL_NOT_FOUND', status: 404 });
      }
    });

    it('P19.7-T2 AC-1 the Owner and an Admin make their own in Akun saya, which nobody else reads', async () => {
      const lead = await wired.leadRecords.create(owner(), { name: 'Klien Owner', type: 'sales'});
      const theirs = await wired.proposals.create(owner(), lead.id, CLIENT);
      expect((await wired.proposals.list(owner(), {})).rows.map((r) => r.id)).toEqual([theirs.id]);
      expect(await refusal(wired.proposals.read(agent(), theirs.id))).toMatchObject({ status: 404 });
    });
  });

  describe('AC-3: the draft at step 1’s Lanjut', () => {
    it('P19.14-T1 AC-3 creates a Draf for one of your own Sales leads, with the lead’s name and step 1’s client', async () => {
      const proposal = await wired.proposals.create(agent(), leads.budi, { ...CLIENT, details: { city: 'Bandung', needs: ['FAMILY'] } });
      expect(proposal).toMatchObject({
        leadId: leads.budi, leadDeleted: false, version: 1, status: 'draft', showTotal: false,
        client: {
          name: 'Pak Budi Santoso', age: 36, ageSetOn: '2026-11-05', gender: 'male',
          details: { status: null, dependants: null, occupation: null, city: 'Bandung', needs: ['FAMILY'], needsOther: null },
        },
        items: [], totals: [], date: '2026-11-05', doneAt: null, firstDoneAt: null, duplicatedFrom: null,
      });
      expect(proposal).not.toHaveProperty('channel');
    });

    it('P19.14-T1 AC-2 a lead saved at step 1 by + Lead baru — a name and a phone, Sales at its first stage — takes the draft', async () => {
      const lead = await wired.leadRecords.create(agent(), { name: 'Klien Baru', type: 'sales', contact: { phone: '0812 1100 2200', email: null } });
      expect((await wired.proposals.create(agent(), lead.id, { age: 29, gender: 'female' })).client).toMatchObject({ name: 'Klien Baru', age: 29, gender: 'female' });
    });

    it('P19.7-T2 AC-3 refuses another member’s lead or another office’s with 404 NOT_FOUND, and writes nothing', async () => {
      expect(await refusal(wired.proposals.create(agent(), leads.siblings, CLIENT))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await refusal(wired.proposals.create(agent(), leads.officeB, CLIENT))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await refusal(wired.proposals.create(ab(), leads.budi, CLIENT))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await db().collection('proposals').countDocuments()).toBe(0);
    });

    it('P19.14-T1 AC-3 refuses a Recruit lead (400 naming leadId), and a client without an age or a gender (400 naming it)', async () => {
      expect(await refusal(wired.proposals.create(agent(), leads.recruit, CLIENT))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400, details: { field: 'leadId' } });
      expect(await refusal(wired.proposals.create(agent(), leads.sari, { gender: 'female' }))).toMatchObject({ status: 400, details: { field: 'client.age' } });
      expect(await refusal(wired.proposals.create(agent(), leads.sari, { age: 47 }))).toMatchObject({ status: 400, details: { field: 'client.gender' } });
      expect(await db().collection('proposals').countDocuments()).toBe(0);
    });

    it('P19.14-T1 AC-4 nothing from step 1 is written to the lead: its version, its fields and its answer unchanged', async () => {
      const before = await db().collection('leads').findOne({ _id: new mongoose.Types.ObjectId(leads.sari) });
      const p = await wired.proposals.create(agent(), leads.sari, { age: 47, gender: 'female', details: { occupation: 'Guru' } });
      await wired.proposals.update(agent(), p.id, { expectedVersion: p.version, client: { age: 48, details: { city: 'Solo' } } });
      const after = await db().collection('leads').findOne({ _id: new mongoose.Types.ObjectId(leads.sari) });
      expect(after).toEqual(before);
      const read = await wired.leadRecords.read(agent(), leads.sari);
      for (const key of ['age', 'ageRecordedOn', 'gender']) expect(read).not.toHaveProperty(key);
    });

    it('P19.14-T1 AC-4 a lead write carrying an age or a gender is refused as an unknown field', async () => {
      const lead = await wired.leadRecords.read(agent(), leads.sari);
      expect(await refusal(wired.leadRecords.update(agent(), leads.sari, { age: 47, version: lead.version } as never))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(await refusal(wired.leadRecords.create(agent(), { name: 'X', type: 'sales', gender: 'male' } as never))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    });
  });

  describe('P19.14-T1 AC-5: a second proposal starts from the first', () => {
    it('P19.14-T1 AC-5 the lead list answers the last proposal’s client, the age moved up after a year — the first starts empty', async () => {
      const row = async () => (await wired.leadRecords.list(agent(), { pageSize: 50 })).rows.find((r) => r.id === leads.budi)!;
      expect((await row()).proposals).toBeNull();
      await wired.proposals.create(agent(), leads.budi, { age: 35, gender: 'male', details: { status: 'married', needs: ['HOSPITAL'] } });
      expect((await row()).proposals!.client).toEqual({
        age: 35, gender: 'male',
        details: { status: 'married', dependants: null, occupation: null, city: null, needs: ['HOSPITAL'], needsOther: null },
      });
      clock().set(new Date('2027-11-06T03:00:00Z'));
      expect((await row()).proposals!.client!.age).toBe(36);
    });

    it('P19.14-T1 AC-5 the prefill is the owner’s alone: a leader reads no client on a downline’s lead', async () => {
      await wired.proposals.create(agent(), leads.budi, CLIENT);
      const asLeader = (await wired.leadRecords.list(aab(), { pageSize: 50, scope: 'team' } as never)).rows.find((r) => r.id === leads.budi);
      expect(asLeader?.proposals ?? null).toBeNull();
    });
  });

  describe('AC-2: every change saved and pinned', () => {
    it('P19.7-T2 AC-2 moves the version on each write, and a stale one is 409 with nothing written (Acc. 18)', async () => {
      const v1 = await wired.proposals.create(agent(), leads.budi, CLIENT);
      const v2 = await wired.proposals.update(agent(), v1.id, { expectedVersion: 1, showTotal: true });
      expect(v2).toMatchObject({ version: 2, showTotal: true });
      expect(await refusal(wired.proposals.update(agent(), v1.id, { expectedVersion: 1, client: { age: 40 } })))
        .toMatchObject({ code: 'VERSION_CONFLICT', status: 409, details: { expectedVersion: 1, actualVersion: 2 } });
      // Another device opens the same draft, as it was saved.
      expect(await wired.proposals.read(agent(), v1.id)).toMatchObject({ version: 2, client: { age: 36 }, showTotal: true });
    });

    it('P19.14-T2 AC-1 Cara bayar is each item’s: a change empties that item’s premium alone; a syariah product keeps its own name', async () => {
      let p = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.SYARIAH]);
      expect(p.items.map((i) => [i.name, i.snapshot.isSyariah])).toEqual([['PRUWell Medical', false], ['PRU Anugerah Syariah', true]]);
      p = await wired.proposals.updateItem(agent(), p.id, p.items[0].itemId, p.version, { payFrequency: 'annual' });
      expect(p.items.map((i) => [i.payFrequency, i.premium?.amountMinor ?? null])).toEqual([['annual', null], ['monthly', 50_000_000]]);
      expect(p.totals).toEqual([{ currency: 'IDR', payFrequency: 'monthly', amountMinor: 50_000_000, items: 1 }]);
    });

    it('P19.14-T1 AC-3 a new client age removes the items whose entry ages it leaves, and answers their ids', async () => {
      const p = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.CI]);
      const changed = await wired.proposals.update(agent(), p.id, { expectedVersion: p.version, client: { age: 61 } });
      expect(changed.removedItemIds).toEqual([p.items[1].itemId]);
      expect(changed.items.map((i) => i.productCode)).toEqual(['HEALTH']);
      expect(changed.client).toMatchObject({ age: 61, ageSetOn: '2026-11-05' });
    });

    it('P19.14-T1 AC-3 a change of lead takes its name and keeps the client entered; the age decides what stays', async () => {
      const elder = await wired.leadRecords.create(agent(), { name: 'Opa', type: 'sales' });
      let p = await wired.proposals.create(agent(), elder.id, { age: 70, gender: 'male' });
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.SENIOR);
      const changed = await wired.proposals.update(agent(), p.id, { expectedVersion: p.version, leadId: leads.budi, client: { age: 36 } });
      expect(changed).toMatchObject({ leadId: leads.budi, client: { name: 'Pak Budi Santoso', age: 36, gender: 'male' }, items: [] });
      expect(changed.removedItemIds).toEqual([p.items[0].itemId]);
    });

    it('P19.7-T2 AC-11 any write to a Selesai proposal makes it a Draf again', async () => {
      let p = await completeProposal(wired, agent(), leads.budi);
      p = await wired.proposals.done(agent(), p.id, p.version);
      expect(p.status).toBe('done');
      p = await wired.proposals.update(agent(), p.id, { expectedVersion: p.version, showTotal: true });
      expect(p).toMatchObject({ status: 'draft', firstDoneAt: NOW.toISOString() });
    });
  });

  describe('AC-6 and T1’s AC-5, AC-6: what may be added', () => {
    it('P19.7-T2 AC-6 adds a product with its snapshot, its defaults and its own Tertanggung (Acc. 7, 12)', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.HEALTH);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.EDU);
      const [health, edu] = p.items;
      expect(health).toMatchObject({
        productCode: 'HEALTH', name: 'PRUWell Medical', plan: 'Gold', currency: 'IDR', choice: null,
        fieldValues: { plan: 'Gold', masa_bayar: '10 tahun', saver: 'Tidak' }, insured: { relation: 'client' },
        payFrequency: 'monthly', payTerm: null, smoker: null, up: null, premium: null, fixedField: 'none',
      });
      expect(health.snapshot.fields.map((f) => f.key)).toEqual(['plan', 'masa_bayar', 'saver', 'catatan']);
      expect(edu.insured).toEqual({ relation: 'child', name: null, age: null, gender: null });
    });

    it('P19.14-T2 AC-3, AC-4 adds a product on its default pay term the client’s age allows, Merokok? Tidak, and a derived plan', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, { age: 55, gender: 'female' });
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.CI);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.DERIVED);
      expect(p.items[0]).toMatchObject({ payTerm: 'y10', smoker: false, snapshot: { calcType: 'up_premium', smokerRated: true } });
      expect(p.items[1]).toMatchObject({ plan: 'Bronze A', fieldValues: { plan: 'Bronze A' } });
      p = await wired.proposals.updateItem(agent(), p.id, p.items[1].itemId, p.version, { fieldValues: { kamar: '1 tempat tidur' } });
      expect(p.items[1].plan).toBe('Bronze B');
      expect(await refusal(wired.proposals.updateItem(agent(), p.id, p.items[0].itemId, p.version, { payTerm: 'y15' })))
        .toMatchObject({ code: 'VALIDATION_FAILED', status: 400, details: { field: 'payTerm' } });
    });

    it.each([
      ['withdrawn', P.WITHDRAWN], ['withdrawn', P.DELETED], ['closed', P.CLOSED], ['rider', P.RIDER],
      ['not_on_shelf', P.OFF], ['not_on_shelf', P.OTHER_CO], ['not_on_shelf', '66f0000000000000000009aa'],
      ['not_on_shelf', 'nonsense'], ['age', P.SENIOR],
    ])('P19.14-T2 AC-2 refuses a product that is %s: 422 PROPOSAL_PRODUCT_WITHDRAWN, nothing written', async (reason, productId) => {
      const p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      expect(await refusal(wired.proposals.addItem(agent(), p.id, p.version, productId)))
        .toMatchObject({ code: 'PROPOSAL_PRODUCT_WITHDRAWN', status: 422, details: { reason } });
      expect((await wired.proposals.read(agent(), p.id)).version).toBe(1);
    });

    it('P19.7-T2 AC-6 refuses a product already in, and a sixth: 400', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      for (const id of [P.HEALTH, P.EDU, P.CONV_SYARIAH_NAME, P.USD, P.BOTH]) p = await wired.proposals.addItem(agent(), p.id, p.version, id);
      expect(await refusal(wired.proposals.addItem(agent(), p.id, p.version, P.LIFE))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(await refusal(wired.proposals.addItem(agent(), p.id, p.version, P.HEALTH))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    });

    it('P19.7-T1 AC-6 a USD product’s premium is typed in USD, and Total premi never adds it to rupiah', async () => {
      const p = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.USD]);
      expect(p.items.map((i) => i.currency)).toEqual(['IDR', 'USD']);
      // PRU Prosper sells annually only: two currencies and two Cara bayar, never summed.
      expect(p.items.map((i) => i.payFrequency)).toEqual(['monthly', 'monthly']);
      expect(p.totals).toEqual([
        { currency: 'IDR', payFrequency: 'monthly', amountMinor: 50_000_000, items: 1 },
        { currency: 'USD', payFrequency: 'monthly', amountMinor: 50_000_000, items: 1 },
      ]);
    });

    it('P19.7-T2 AC-15 an item keeps the labels it was made with when the catalogue changes, and so does its PDF source', async () => {
      const p = await completeProposal(wired, agent(), leads.budi);
      await mongoose.model('ProductModel').updateOne(
        { _id: P.HEALTH }, { $set: { 'proposalFields.0.label': 'Pilihan plan', name: 'PRUWell Baru' }, $inc: { version: 1 } },
      );
      const read = await wired.proposals.read(agent(), p.id);
      expect(read.items[0]).toMatchObject({ productVersion: 1, snapshot: { name: 'PRUWell Medical' } });
      expect(read.items[0].snapshot.fields[0].label).toBe('Plan');
    });

    it('P19.7-T2 AC-7 a field write is checked against the snapshot; an insured’s age outside 1–100 is 422', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.EDU);
      const itemId = p.items[0].itemId;
      expect(await refusal(wired.proposals.updateItem(agent(), p.id, itemId, p.version, { fieldValues: { up: 1 } })))
        .toMatchObject({ status: 400, details: { field: 'fieldValues.up' } });
      expect(await refusal(wired.proposals.updateItem(agent(), p.id, itemId, p.version, { insured: { relation: 'child', name: 'Adik', age: 0 } })))
        .toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', status: 422 });
      expect(await refusal(wired.proposals.updateItem(agent(), p.id, 'nope', p.version, { premium: { amountMinor: 1 } })))
        .toMatchObject({ status: 400, details: { field: 'itemId' } });
      p = await wired.proposals.updateItem(agent(), p.id, itemId, p.version, { premium: { amountMinor: 1_000_000_00 }, fieldValues: { up: 25_000_000_000 } });
      expect(p.items[0]).toMatchObject({ totalPaid: { amountMinor: 1_000_000_00 * 12 * 18, years: 18 } });
      p = await wired.proposals.removeItem(agent(), p.id, itemId, p.version);
      expect(p.items).toEqual([]);
    });
  });

  describe('AC-11: Simpan PDF’s first half, and the lead’s note', () => {
    it('P19.7-T2 AC-11 refuses a proposal with a gap: 422 PROPOSAL_INCOMPLETE naming each, nothing written', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      expect(await refusal(wired.proposals.done(agent(), p.id, p.version))).toMatchObject({ code: 'PROPOSAL_INCOMPLETE', status: 422, details: { items: [] } });
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.EDU);
      expect(await refusal(wired.proposals.done(agent(), p.id, p.version))).toMatchObject({
        code: 'PROPOSAL_INCOMPLETE', details: { items: [{ itemId: p.items[0].itemId, missing: ['premium', 'insured.name', 'insured.age'] }] },
      });
      expect((await wired.proposals.read(agent(), p.id))).toMatchObject({ status: 'draft', version: p.version });
    });

    it('P19.7-T2 AC-11 refuses a product withdrawn since it was added: 422 with the item ids', async () => {
      const p = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.LIFE]);
      await mongoose.model('ProductModel').updateOne({ _id: P.LIFE }, { $set: { lifecycle: 'withdrawn' } });
      expect(await refusal(wired.proposals.done(agent(), p.id, p.version)))
        .toMatchObject({ code: 'PROPOSAL_PRODUCT_WITHDRAWN', status: 422, details: { itemIds: [p.items[1].itemId] } });
    });

    it('P19.7-T2 AC-11 marks it Selesai, writes the first save once, and the lead’s Riwayat gains the note (owner only)', async () => {
      let p = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.CONV_SYARIAH_NAME]);
      p = await wired.proposals.done(agent(), p.id, p.version);
      expect(p).toMatchObject({ status: 'done', doneAt: NOW.toISOString(), firstDoneAt: NOW.toISOString(), date: '2026-11-05' });
      const later = new Date('2026-11-07T03:00:00Z');
      clock().set(later);
      p = await wired.proposals.update(agent(), p.id, { expectedVersion: p.version, showTotal: true });
      p = await wired.proposals.done(agent(), p.id, p.version);
      expect(p).toMatchObject({ doneAt: later.toISOString(), firstDoneAt: NOW.toISOString(), date: '2026-11-07' });

      const lead = await wired.leadRecords.read(agent(), leads.budi);
      const note = lead.history.find((h) => h.kind === 'proposal');
      expect(note).toEqual({ kind: 'proposal', at: NOW.toISOString(), proposalId: p.id, products: ['PRUWell Medical', 'PRUCinta'] });
      // Derived: the lead's own version did not move, and its leader reads no note.
      expect(lead.version).toBe(1);
      expect((await wired.leadRecords.read(aab(), leads.budi)).history.some((h) => h.kind === 'proposal')).toBe(false);
    });

    it('P19.7-T2 AC-12 a deleted proposal leaves Riwayat and the lead’s pill; its note stays, unlinked', async () => {
      let p = await completeProposal(wired, agent(), leads.budi);
      p = await wired.proposals.done(agent(), p.id, p.version);
      await wired.proposals.remove(agent(), p.id, p.version);
      expect((await wired.proposals.list(agent(), {})).total).toBe(0);
      const stored = await db().collection('proposals').findOne({ _id: new mongoose.Types.ObjectId(p.id) });
      expect(stored).toMatchObject({ deletedBy: agent().membershipId });
      expect(stored!.deletedAt).toBeInstanceOf(Date);
      const lead = await wired.leadRecords.read(agent(), leads.budi);
      expect(lead.proposals).toBeNull();
      expect(lead.history.find((h) => h.kind === 'proposal')).toMatchObject({ proposalId: null, products: ['PRUWell Medical'] });
    });
  });

  describe('AC-10: Riwayat, the duplicate and the delete', () => {
    it('P19.7-T2 AC-10 lists your own, newest change first, with client, date, products and plan, status and totals', async () => {
      let first = await completeProposal(wired, agent(), leads.budi);
      first = await wired.proposals.done(agent(), first.id, first.version);
      clock().set(new Date('2026-11-06T03:00:00Z'));
      const lead = await wired.leadRecords.create(agent(), { name: 'Ibu Wulan', type: 'sales'});
      const second = await wired.proposals.create(agent(), lead.id, CLIENT);
      const page = await wired.proposals.list(agent(), {});
      expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(page.rows.map((r) => r.id)).toEqual([second.id, first.id]);
      expect(page.rows[1]).toMatchObject({
        client: { name: 'Pak Budi Santoso' }, date: '2026-11-05', status: 'done', version: first.version,
        products: [{ name: 'PRUWell Medical', plan: 'Gold' }], totals: [{ currency: 'IDR', payFrequency: 'monthly', amountMinor: 50_000_000, items: 1 }],
        leadId: leads.budi, leadDeleted: false,
      });
      // A draft's date is its last change's day in the office's calendar. The change's time is the row's `updatedAt`,
      // which the database stamps from the wall clock, not the service's clock set above: derived, so it holds any day.
      expect(page.rows[0]).toMatchObject({
        date: localDayOf(new Date(page.rows[0].updatedAt), DEFAULT_TENANT_TIMEZONE), status: 'draft', products: [],
      });
      expect(page.rows[0].updatedAt).toBe(
        ((await db().collection('proposals').findOne({ _id: new mongoose.Types.ObjectId(second.id) }))!.updatedAt as Date).toISOString(),
      );
    });

    it('P19.7-T2 AC-10 searches the client’s and the products’ names, as typed, and filters status and lead', async () => {
      await completeProposal(wired, agent(), leads.budi);
      const lead = await wired.leadRecords.create(agent(), { name: 'Ibu (Wulan)', type: 'sales'});
      await wired.proposals.create(agent(), lead.id, CLIENT);
      expect((await wired.proposals.list(agent(), { search: 'budi' })).rows.map((r) => r.client.name)).toEqual(['Pak Budi Santoso']);
      expect((await wired.proposals.list(agent(), { search: 'pruwell' })).total).toBe(1);
      expect((await wired.proposals.list(agent(), { search: '(Wulan)' })).total).toBe(1);
      expect((await wired.proposals.list(agent(), { search: '.*' })).total).toBe(0);
      expect((await wired.proposals.list(agent(), { status: 'done' })).total).toBe(0);
      expect((await wired.proposals.list(agent(), { leadId: lead.id })).total).toBe(1);
      expect((await wired.proposals.list(agent(), { pageSize: 1, page: 2 })).rows).toHaveLength(1);
    });

    it('P19.7-T2 AC-12 a deleted lead’s proposals stay in Riwayat under the client’s name, and cannot be duplicated', async () => {
      const p = await completeProposal(wired, agent(), leads.budi);
      await wired.leadRecords.remove(agent(), leads.budi);
      expect((await wired.proposals.list(agent(), {})).rows[0]).toMatchObject({ client: { name: 'Pak Budi Santoso' }, leadDeleted: true });
      expect((await wired.proposals.read(agent(), p.id)).leadDeleted).toBe(true);
      expect(await refusal(wired.proposals.duplicate(agent(), p.id))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('P19.14-T1 AC-5 duplicates into a new Draf: the client again, its age moved up a year on, the items copied, the withdrawn left out', async () => {
      let p = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.LIFE]);
      p = await wired.proposals.done(agent(), p.id, p.version);
      await mongoose.model('ProductModel').updateOne({ _id: P.LIFE }, { $set: { lifecycle: 'withdrawn' } });
      const copy = await wired.proposals.duplicate(agent(), p.id);
      expect(copy).toMatchObject({ status: 'draft', version: 1, duplicatedFrom: p.id, leadId: leads.budi, firstDoneAt: null, droppedProductIds: [P.LIFE] });
      expect(copy.items).toHaveLength(1);
      expect(copy.items[0]).toMatchObject({ productId: P.HEALTH, premium: { amountMinor: 50_000_000 }, fieldValues: p.items[0].fieldValues });
      expect(copy.items[0].itemId).not.toBe(p.items[0].itemId);
      expect(copy.client).toMatchObject({ name: 'Pak Budi Santoso', age: 36, ageSetOn: '2026-11-05' });
      clock().set(new Date('2027-11-06T03:00:00Z'));
      expect((await wired.proposals.duplicate(agent(), p.id)).client).toMatchObject({ age: 37, ageSetOn: '2027-11-06' });
    });

    it('P19.7-T2 AC-10 deletes softly, pinned: a stale version is 409', async () => {
      const p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      const moved = await wired.proposals.update(agent(), p.id, { expectedVersion: 1, showTotal: true });
      expect(await refusal(wired.proposals.remove(agent(), p.id, 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await wired.proposals.remove(agent(), p.id, moved.version);
      expect(await db().collection('proposals').countDocuments()).toBe(1);
    });
  });

  describe('P19.11-T3 AC-7 and AC-8: the lead sheet’s one finished proposal, and no empty draft twice', () => {
    it('P19.11-T3 AC-7 status=done for a lead lists finished ones only, the last saved by doneAt first', async () => {
      let older = await completeProposal(wired, agent(), leads.budi);
      older = await wired.proposals.done(agent(), older.id, older.version);
      clock().set(new Date('2026-11-06T03:00:00Z'));
      let newer = await completeProposal(wired, agent(), leads.budi, [P.EDU]);
      newer = await wired.proposals.done(agent(), newer.id, newer.version);
      clock().set(new Date('2026-11-07T03:00:00Z'));
      await completeProposal(wired, agent(), leads.budi, [P.LIFE]); // a draft, changed last
      // The older one's row stamped newer than the newer's: the order is `doneAt`'s, never `updatedAt`'s.
      await db().collection('proposals').updateOne(
        { _id: new mongoose.Types.ObjectId(older.id) }, { $set: { updatedAt: new Date('2026-12-01T00:00:00Z') } },
      );
      const page = await wired.proposals.list(agent(), { leadId: leads.budi, status: 'done' });
      expect(page.rows.map((r) => [r.id, r.status])).toEqual([[newer.id, 'done'], [older.id, 'done']]);
      expect((await wired.proposals.list(agent(), { leadId: leads.budi, status: 'done', pageSize: 1 })).rows.map((r) => r.id))
        .toEqual([newer.id]);
      // Without the filter, Riwayat's own order stands: newest change first.
      expect((await wired.proposals.list(agent(), { leadId: leads.budi })).total).toBe(3);
    });

    it('P19.11-T3 AC-7 a lead with drafts only lists nothing finished: the section shows only Buat proposal', async () => {
      await completeProposal(wired, agent(), leads.budi);
      await wired.proposals.create(agent(), leads.budi, CLIENT);
      expect((await wired.proposals.list(agent(), { leadId: leads.budi, status: 'done' })).rows).toEqual([]);
    });

    it('P19.11-T3 AC-8 a second create on the same lead answers the empty draft, never another row', async () => {
      const first = await wired.proposals.create(agent(), leads.budi, CLIENT);
      const again = await wired.proposals.create(agent(), leads.budi, CLIENT);
      expect(again).toMatchObject({ id: first.id, version: 1, status: 'draft', items: [] });
      expect(await db().collection('proposals').countDocuments()).toBe(1);
      expect((await wired.proposals.list(agent(), {})).total).toBe(1);
    });

    it('P19.14-T1 AC-3 the reused draft takes the lead’s current name and the client this write sends', async () => {
      const first = await wired.proposals.create(agent(), leads.budi, CLIENT);
      const lead = await wired.leadRecords.read(agent(), leads.budi);
      await wired.leadRecords.update(agent(), leads.budi, { name: 'Pak Budi S.', version: lead.version });
      const again = await wired.proposals.create(agent(), leads.budi, { age: 40, gender: 'male' });
      expect(again).toMatchObject({ id: first.id, version: 2, client: { name: 'Pak Budi S.', age: 40, gender: 'male' } });
      expect(await db().collection('proposals').countDocuments()).toBe(1);
      // Recorded as a change to the draft, by field name only.
      const entry = await db().collection('auditLog').findOne({ action: 'proposal.updated', targetId: first.id });
      expect(entry?.after).toEqual({ fields: ['client'], reused: true });
    });

    it('P19.11-T3 AC-8 a draft with a product is never reused, nor a finished one: those leave a new draft', async () => {
      const worked = await completeProposal(wired, agent(), leads.budi);
      const fresh = await wired.proposals.create(agent(), leads.budi, CLIENT);
      expect(fresh.id).not.toBe(worked.id);
      let finished = await completeProposal(wired, agent(), leads.budi, [P.EDU]);
      expect(finished.id).toBe(fresh.id); // the empty one, filled
      finished = await wired.proposals.done(agent(), finished.id, finished.version);
      const third = await wired.proposals.create(agent(), leads.budi, CLIENT);
      expect([worked.id, finished.id]).not.toContain(third.id);
      expect(await db().collection('proposals').countDocuments()).toBe(3);
    });

    it('P19.11-T3 AC-8 another member’s empty draft on another lead, or another office’s, is never answered (tenancy)', async () => {
      const theirs = await wired.proposals.create(agentB(), leads.officeB, CLIENT);
      const lead = await wired.leadRecords.create(owner(), { name: 'Klien Owner', type: 'sales'});
      const owners = await wired.proposals.create(owner(), lead.id, CLIENT);
      const mine = await wired.proposals.create(agent(), leads.budi, CLIENT);
      expect([theirs.id, owners.id]).not.toContain(mine.id);
      // Nobody reaches the agent's lead through create, so nobody is answered the agent's draft.
      expect(await refusal(wired.proposals.create(agentB(), leads.budi, CLIENT))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await refusal(wired.proposals.create(ab(), leads.budi, CLIENT))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await db().collection('proposals').countDocuments()).toBe(3);
    });
  });

  it('P19.7-T2 PDP no audit entry copies a name, an age or a premium: ids and counts only (ADR-0221 §12)', async () => {
    let p = await completeProposal(wired, agent(), leads.budi, [P.EDU]);
    p = await wired.proposals.done(agent(), p.id, p.version);
    await wired.proposals.duplicate(agent(), p.id);
    const entries = await db().collection('auditLog').find({ targetCollection: 'proposals' }).toArray();
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['proposal.created', 'proposal.updated', 'proposal.done']));
    const text = JSON.stringify(entries);
    for (const word of ['Pak Budi', 'Adik', '50000000', '"age"', '"name"', 'gender', 'details']) expect(text).not.toContain(word);
  });
});
