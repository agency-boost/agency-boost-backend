import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  declaredPermissions, NO_CLASS, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  CLIENT, KPM_A, NOW, OWNER, PRODUCT_IDS as P, aab, ab, admin, agent, completeProposal, ctxFor, owner, seedProposalOffice,
  viewAsAgent, type SeededLeads,
} from '../../../test/proposals';
import { ProposalController } from './proposal.controller';
import { ProposalPdfService } from './proposal-pdf.service';
import { ProposalService } from './proposal.service';

/**
 * **P19.7-T2 — the proposal's routes over HTTP** (ADR-0221 §2, §3; `functional/proposal.md`, *Data contract*): each
 * route under its grant, the AB, the AAB and the Agent let in and nobody else, the pipe's refusals, the view-only
 * session that reads and writes nothing (Acc. 22), and `PROPOSAL_NOT_FOUND` in the reader's language.
 */
describe('P19.7-T2 the proposal’s routes (HTTP)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let leads: SeededLeads;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProposalController],
      // The PDF's own routes are `proposal-pdf.int.spec.ts`'s (P19.7-T3).
      providers: [{ provide: ProposalService, useValue: wired.proposals }, { provide: ProposalPdfService, useValue: {} }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    const reflector = app.get(Reflector);
    // The deployed order: who it is, then a view-only session's writes, then the route's own grant.
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(reflector), new PermissionsGuard(reflector));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
    await stopMongo();
  });
  beforeEach(async () => {
    await clearCollections();
    leads = await seedProposalOffice(wired);
    session.current = agent();
  });

  const http = () => request(app.getHttpServer());

  it('P19.7-T2 AC-13 declares a proposal grant on every route, and the catalogue above :proposalId', () => {
    expect(declaredPermissions(ProposalController)).toEqual({
      list: 'proposal:read', catalog: 'proposal:read', read: 'proposal:read', create: 'proposal:create',
      update: 'proposal:update', addItem: 'proposal:update', updateItem: 'proposal:update', removeItem: 'proposal:update',
      done: 'proposal:update', duplicate: 'proposal:create', remove: 'proposal:delete', pdf: 'proposal:download',
    });
  });

  describe('who may (positive and negative, per role)', () => {
    it.each([['an Agent', agent], ['an AAB', aab], ['an AB', ab], ['the Owner on their own rung (Akun saya)', owner]])(
      'P19.7-T2 AC-1 lets %s make, read, change and delete their own proposal', async (_who, who) => {
        session.current = who();
        const lead = await wired.leadRecords.create(who(), { name: 'Klien', type: 'sales' });
        const created = await http().post('/proposals').send({ leadId: lead.id, client: { age: 40, gender: 'male' } }).expect(201);
        await http().get('/proposals').expect(200);
        await http().get(`/proposals/${created.body.id}`).expect(200);
        await http().get('/proposals/catalog?age=40').expect(200);
        const added = await http().post(`/proposals/${created.body.id}/items`).send({ expectedVersion: 1, productId: P.HEALTH }).expect(201);
        await http().patch(`/proposals/${created.body.id}`).send({ expectedVersion: added.body.version, client: { age: 41 } }).expect(200);
        await http().post(`/proposals/${created.body.id}/duplicate`).expect(201);
        await http().delete(`/proposals/${created.body.id}?expectedVersion=${added.body.version + 1}`).expect(204);
      },
    );

    it.each([
      ['the Owner with no field rung', () => ctxFor(OWNER, 'AB', KPM_A, { isKpmOwner: true, hierarchyRole: NO_CLASS })],
      ['an Admin with no field rung', () => ctxFor(OWNER, 'AB', KPM_A, { isKpmAdmin: true, hierarchyRole: NO_CLASS })],
      ['the Super Admin outside a session', () => SUPER_ADMIN],
    ])('P19.7-T2 AC-13 refuses %s every route: 403 PERM_DENIED', async (_who, who) => {
      session.current = who() as RequestContext;
      for (const call of [
        http().get('/proposals'), http().get('/proposals/catalog?age=40'),
        http().post('/proposals').send({ leadId: leads.budi, client: CLIENT }), http().get(`/proposals/${leads.budi}`),
      ]) {
        const res = await call;
        expect([res.status, res.body.error?.code]).toEqual([403, 'PERM_DENIED']);
      }
    });

    it('P19.7-T2 AC-13 answers another member’s proposal 404 PROPOSAL_NOT_FOUND, in the reader’s language', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      session.current = aab();
      const en = await http().get(`/proposals/${mine.id}`).expect(404);
      expect(en.body.error).toMatchObject({ code: 'PROPOSAL_NOT_FOUND', message: 'No proposal of yours has that id. It may have been deleted.' });
      const id = await http().get(`/proposals/${mine.id}`).set('Accept-Language', 'id').expect(404);
      expect(id.body.error.message).toBe('Tidak ada proposal milik Anda dengan id ini. Mungkin sudah dihapus.');
      await http().delete(`/proposals/${mine.id}?expectedVersion=${mine.version}`).expect(404);
    });

    it('P19.7-T2 AC-13 another KPM’s proposal is 404 over HTTP (cross-tenant)', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      session.current = ctxFor(admin().membershipId!, 'AGENT', '66f0000000000000000000b1');
      await http().get(`/proposals/${mine.id}`).expect(404);
    });
  });

  describe('AC-14: the Super Admin in a view-only session (Acc. 22)', () => {
    it('P19.7-T2 AC-14 opens Riwayat, a proposal and the catalogue as the member', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      session.current = viewAsAgent();
      expect((await http().get('/proposals').expect(200)).body.total).toBe(1);
      await http().get(`/proposals/${mine.id}`).expect(200);
      await http().get('/proposals/catalog?age=36').expect(200);
    });

    it('P19.7-T2 AC-14 refuses every write: 403 IMPERSONATION_READ_ONLY, and nothing changes', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const itemId = mine.items[0].itemId;
      session.current = viewAsAgent();
      for (const call of [
        http().post('/proposals').send({ leadId: leads.budi, client: CLIENT }),
        http().patch(`/proposals/${mine.id}`).send({ expectedVersion: mine.version, showTotal: true }),
        http().patch(`/proposals/${mine.id}`).send({ expectedVersion: mine.version, client: { age: 40 } }),
        http().post(`/proposals/${mine.id}/items`).send({ expectedVersion: mine.version, productId: P.LIFE }),
        http().patch(`/proposals/${mine.id}/items/${itemId}`).send({ expectedVersion: mine.version, premium: { amountMinor: 1 } }),
        http().delete(`/proposals/${mine.id}/items/${itemId}?expectedVersion=${mine.version}`),
        http().post(`/proposals/${mine.id}/done`).send({ expectedVersion: mine.version }),
        http().post(`/proposals/${mine.id}/duplicate`),
        http().delete(`/proposals/${mine.id}?expectedVersion=${mine.version}`),
      ]) {
        const res = await call;
        expect([res.status, res.body.error?.code]).toEqual([403, 'IMPERSONATION_READ_ONLY']);
      }
      expect((await wired.proposals.read(agent(), mine.id)).version).toBe(mine.version);
      expect((await wired.proposals.list(agent(), {})).total).toBe(1);
    });
  });

  describe('the pipe’s refusals (400 VALIDATION_FAILED)', () => {
    it.each([
      ['POST /proposals without a leadId', () => http().post('/proposals').send({ client: CLIENT })],
      ['POST /proposals without a client', () => http().post('/proposals').send({ leadId: leads.budi })],
      ['POST /proposals with a malformed leadId', () => http().post('/proposals').send({ leadId: 'x', client: CLIENT })],
      ['POST /proposals with an unknown field', () => http().post('/proposals').send({ leadId: leads.budi, client: CLIENT, share: true })],
      ['POST /proposals with a client of the wrong shape', () => http().post('/proposals').send({ leadId: leads.budi, client: 'Pak Budi' })],
      // P19.14-T2 AC-1: no channel any more — the switch is gone, and so is the parameter.
      ['the catalogue with a channel', () => http().get('/proposals/catalog?channel=conventional&age=30')],
      ['the catalogue at age 0', () => http().get('/proposals/catalog?age=0')],
      ['the catalogue at age 101', () => http().get('/proposals/catalog?age=101')],
      ['a page of 51', () => http().get('/proposals?pageSize=51')],
      ['a search of 121 characters', () => http().get(`/proposals?search=${'a'.repeat(121)}`)],
      ['a status that is neither', () => http().get('/proposals?status=sent')],
    ])('P19.7-T2 AC-2 refuses %s', async (_label, call) => {
      const res = await call();
      expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('P19.14-T2 AC-1 refuses a write without expectedVersion, with a body of the wrong shape, or with a proposal-wide channel or cara bayar', async () => {
      const p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      for (const call of [
        http().patch(`/proposals/${p.id}`).send({ showTotal: true }),
        http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, payFrequency: 'annual' }),
        http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, channel: 'syariah' }),
        http().patch(`/proposals/${p.id}/items/x`).send({ expectedVersion: 1, payFrequency: 'weekly' }),
        http().patch(`/proposals/${p.id}/items/x`).send({ expectedVersion: 1, smoker: 'ya' }),
        http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, showTotal: 'yes' }),
        http().post(`/proposals/${p.id}/items`).send({ productId: P.HEALTH }),
        http().post(`/proposals/${p.id}/done`).send({}),
        http().delete(`/proposals/${p.id}`),
        http().patch(`/proposals/${p.id}/items/x`).send({ expectedVersion: 1, fieldValues: 'Gold' }),
        http().patch(`/proposals/${p.id}/items/x`).send({ expectedVersion: 1, insured: { relation: 'cousin' } }),
      ]) {
        const res = await call;
        expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });
  });

  describe('the answers', () => {
    it('P19.14-T2 AC-1, AC-2, AC-6 answers one catalogue — conventional and syariah — greying a product the age cannot enter, and an empty list where nothing is offered', async () => {
      const res = await http().get('/proposals/catalog?age=36').expect(200);
      expect(res.body.products.map((p: { code: string }) => p.code))
        .toEqual(['HEALTH', 'EDU', 'SYARIAH', 'CONV_SYARIAH_NAME', 'USD', 'BOTH', 'SENIOR', 'LIFE', 'CI', 'DERIVED']);
      const health = res.body.products[0];
      expect(health).toMatchObject({ name: 'PRUWell Medical', typeLabel: 'KESEHATAN', currency: { fixed: 'IDR' }, riders: [{ code: 'RIDER' }], isSyariah: false, calcType: 'manual', outOfAge: false });
      expect(health.faq).toEqual([{ question: 'Ada masa tunggu?', answer: '30 hari.' }]);
      expect(health.fields.some((f: Record<string, unknown>) => 'draft' in f)).toBe(false);
      const byCode = (code: string) => res.body.products.find((p: { code: string }) => p.code === code);
      expect(byCode('SYARIAH')).toMatchObject({ name: 'PRU Anugerah Syariah', isSyariah: true });
      // A conventional product is offered by its own name: there is no channel to read a syariah name under.
      expect(byCode('CONV_SYARIAH_NAME')).toMatchObject({ name: 'PRUCinta', isSyariah: false });
      expect(byCode('SENIOR')).toMatchObject({ outOfAge: true, entryAge: { min: 65, max: 100 } });
      expect(byCode('CI')).toMatchObject({ calcType: 'up_premium', smokerRated: true, entryAge: { min: 1, max: 60 }, frequencies: ['monthly', 'quarterly', 'semiannual', 'annual'] });
      expect(byCode('CI').payTerms.map((t: { key: string }) => t.key)).toEqual(['y5', 'y10', 'y15', 'single']);
      expect(byCode('DERIVED')).toMatchObject({ frequencies: ['monthly', 'annual'], planRule: { field: 'plan' } });
      // No age: nothing is outside its entry ages.
      expect((await http().get('/proposals/catalog').expect(200)).body.products.every((p: { outOfAge: boolean }) => !p.outOfAge)).toBe(true);
      await mongoose.connection.db!.collection('products').updateMany({}, { $set: { lifecycle: 'withdrawn' } });
      expect((await http().get('/proposals/catalog?age=36').expect(200)).body).toEqual({ products: [] });
    });

    it('P19.14-T1 AC-3 POST /proposals takes the client — the age and gender required, an age out of range 422 — and writes nothing to the lead', async () => {
      const missing = await http().post('/proposals').send({ leadId: leads.budi, client: { age: 36 } }).expect(400);
      expect(missing.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'client.gender' } });
      const old = await http().post('/proposals').send({ leadId: leads.budi, client: { age: 101, gender: 'male' } }).expect(422);
      expect(old.body.error).toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', details: { min: 1, max: 100, field: 'client.age' } });
      const res = await http().post('/proposals').send({
        leadId: leads.budi,
        client: { age: 36, gender: 'male', details: { status: 'married', dependants: 'Istri, 2 anak', needs: ['HOSPITAL', 'EDUCATION'] } },
      }).expect(201);
      expect(res.body.client).toEqual({
        name: 'Pak Budi Santoso', age: 36, ageSetOn: '2026-11-05', gender: 'male',
        details: { status: 'married', dependants: 'Istri, 2 anak', occupation: null, city: null, needs: ['HOSPITAL', 'EDUCATION'], needsOther: null },
      });
      expect(res.body).not.toHaveProperty('channel');
      expect(res.body).not.toHaveProperty('payFrequency');
      const lead = await mongoose.connection.db!.collection('leads').findOne({ _id: new mongoose.Types.ObjectId(leads.budi) });
      expect(lead).not.toHaveProperty('age');
      expect(lead).not.toHaveProperty('gender');
    });

    it('P19.7-T2 AC-2 answers a 409 with both versions, and a 422 with its reason', async () => {
      const p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      await http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, showTotal: true }).expect(200);
      const stale = await http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, showTotal: false }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });
      const rider = await http().post(`/proposals/${p.id}/items`).send({ expectedVersion: 2, productId: P.RIDER }).expect(422);
      expect(rider.body.error).toMatchObject({ code: 'PROPOSAL_PRODUCT_WITHDRAWN', details: { reason: 'rider' } });
      const incomplete = await http().post(`/proposals/${p.id}/done`).send({ expectedVersion: 2 }).expect(422);
      expect(incomplete.body.error).toMatchObject({ code: 'PROPOSAL_INCOMPLETE', details: { items: [] } });
      const senior = await http().post(`/proposals/${p.id}/items`).send({ expectedVersion: 2, productId: P.SENIOR }).expect(422);
      expect(senior.body.error).toMatchObject({ code: 'PROPOSAL_PRODUCT_WITHDRAWN', details: { reason: 'age' } });
    });

    it('P19.11-T3 AC-8 POST /proposals twice on one lead answers the same empty draft, 201 both times', async () => {
      const first = await http().post('/proposals').send({ leadId: leads.budi, client: CLIENT }).expect(201);
      const again = await http().post('/proposals').send({ leadId: leads.budi, client: CLIENT }).expect(201);
      expect(again.body).toMatchObject({ id: first.body.id, status: 'draft', items: [] });
      expect((await http().get(`/proposals?leadId=${leads.budi}`).expect(200)).body.total).toBe(1);
    });

    it('P19.11-T3 AC-7 GET /proposals?leadId=&status=done&pageSize=1 answers the lead’s last finished proposal, never a draft', async () => {
      let p = await completeProposal(wired, agent(), leads.budi);
      p = await wired.proposals.done(agent(), p.id, p.version);
      await completeProposal(wired, agent(), leads.budi, [P.EDU]);
      const res = await http().get(`/proposals?leadId=${leads.budi}&status=done&pageSize=1`).expect(200);
      expect(res.body).toMatchObject({ total: 1, pageSize: 1 });
      expect(res.body.rows.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([[p.id, 'done']]);
    });

    it('P19.7-T2 AC-11 POST …/done answers 200 with the proposal Selesai', async () => {
      const p = await completeProposal(wired, agent(), leads.budi);
      const res = await http().post(`/proposals/${p.id}/done`).send({ expectedVersion: p.version }).expect(200);
      expect(res.body).toMatchObject({ status: 'done', firstDoneAt: NOW.toISOString(), date: '2026-11-05' });
    });

    it('P19.7-T2 AC-7 PATCH …/items/:itemId takes a partial insured, a cleared money field and a premium', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.EDU);
      const url = `/proposals/${p.id}/items/${p.items[0].itemId}`;
      let res = await http().patch(url).send({ expectedVersion: p.version, insured: { relation: 'spouse' } }).expect(200);
      res = await http().patch(url).send({ expectedVersion: res.body.version, insured: { relation: 'spouse', name: 'Ibu Ani', age: null, gender: 'female' } }).expect(200);
      res = await http().patch(url).send({ expectedVersion: res.body.version, fieldValues: { up: 25_000_000_000 }, premium: { amountMinor: 400_000_00 } }).expect(200);
      res = await http().patch(url).send({ expectedVersion: res.body.version, fieldValues: { up: null } }).expect(200);
      expect(res.body.items[0]).toMatchObject({
        insured: { relation: 'spouse', name: 'Ibu Ani', age: null, gender: 'female' }, fieldValues: {},
        premium: { amountMinor: 400_000_00, currency: 'IDR' }, payFrequency: 'monthly',
      });
      const age = await http().patch(url).send({ expectedVersion: res.body.version, insured: { relation: 'spouse', age: 150 } }).expect(422);
      expect(age.body.error).toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', details: { min: 1, max: 100 } });
    });

    it('P19.14-T2 AC-3, AC-4 PATCH …/items/:itemId takes a pay term, Cara bayar, Merokok? and the sum assured, per product', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.CI);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.HEALTH);
      const [ci, health] = p.items;
      expect(ci).toMatchObject({ payTerm: 'y10', payFrequency: 'monthly', smoker: false, up: null, premium: null, fixedField: 'none' });
      const url = `/proposals/${p.id}/items/${ci.itemId}`;
      let res = await http().patch(url).send({
        expectedVersion: p.version, payTerm: 'y15', payFrequency: 'annual', smoker: true,
        up: { amountMinor: 500_000_000_00 }, premium: { amountMinor: 4_200_000_00 },
      }).expect(200);
      expect(res.body.items[0]).toMatchObject({
        payTerm: 'y15', payFrequency: 'annual', smoker: true, up: { amountMinor: 500_000_000_00, currency: 'IDR' },
        premium: { amountMinor: 4_200_000_00, currency: 'IDR' }, totalPaid: { amountMinor: 4_200_000_00 * 15, years: 15 },
      });
      res = await http().patch(`/proposals/${p.id}/items/${health.itemId}`).send({ expectedVersion: res.body.version, premium: { amountMinor: 900_000_00 } }).expect(200);
      // Totals per currency and per Cara bayar: never a monthly and an annual figure in one sum.
      expect(res.body.totals).toEqual([
        { currency: 'IDR', payFrequency: 'monthly', amountMinor: 900_000_00, items: 1 },
        { currency: 'IDR', payFrequency: 'annual', amountMinor: 4_200_000_00, items: 1 },
      ]);
      for (const body of [{ payFrequency: 'single' }, { payTerm: 'y99' }, { smoker: true, up: { amountMinor: 1 } }]) {
        const target = 'up' in body ? health.itemId : ci.itemId;
        const refused = await http().patch(`/proposals/${p.id}/items/${target}`).send({ expectedVersion: res.body.version, ...body }).expect(400);
        expect(refused.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('P19.14-T2 AC-4 a client older than a pay term’s limit, written at step 1, moves it to the longest allowed', async () => {
      let p = await wired.proposals.create(agent(), leads.budi, CLIENT);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.CI);
      p = await wired.proposals.updateItem(agent(), p.id, p.items[0].itemId, p.version, { payTerm: 'y15' });
      const res = await http().patch(`/proposals/${p.id}`).send({ expectedVersion: p.version, client: { age: 55 } }).expect(200);
      expect(res.body).toMatchObject({ client: { age: 55 }, removedItemIds: [] });
      expect(res.body.items[0].payTerm).toBe('y10');
      const out = await http().patch(`/proposals/${p.id}`).send({ expectedVersion: res.body.version, client: { age: 61 } }).expect(200);
      expect(out.body).toMatchObject({ items: [], removedItemIds: [p.items[0].itemId] });
    });
  });
});

