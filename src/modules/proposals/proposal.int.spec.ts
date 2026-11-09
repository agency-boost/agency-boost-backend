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
  KPM_A, NOW, OWNER, PRODUCT_IDS as P, aab, ab, admin, agent, completeProposal, ctxFor, owner, seedProposalOffice,
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
        const lead = await wired.leadRecords.create(who(), { name: 'Klien', type: 'sales', age: 40, gender: 'male' });
        const created = await http().post('/proposals').send({ leadId: lead.id }).expect(201);
        await http().get('/proposals').expect(200);
        await http().get(`/proposals/${created.body.id}`).expect(200);
        await http().get('/proposals/catalog?channel=conventional&age=40').expect(200);
        const added = await http().post(`/proposals/${created.body.id}/items`).send({ expectedVersion: 1, productId: P.HEALTH }).expect(201);
        await http().patch(`/proposals/${created.body.id}`).send({ expectedVersion: added.body.version, payFrequency: 'annual' }).expect(200);
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
        http().get('/proposals'), http().get('/proposals/catalog?channel=conventional&age=40'),
        http().post('/proposals').send({ leadId: leads.budi }), http().get(`/proposals/${leads.budi}`),
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
      await http().get('/proposals/catalog?channel=conventional&age=36').expect(200);
    });

    it('P19.7-T2 AC-14 refuses every write: 403 IMPERSONATION_READ_ONLY, and nothing changes', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const itemId = mine.items[0].itemId;
      session.current = viewAsAgent();
      for (const call of [
        http().post('/proposals').send({ leadId: leads.budi }),
        http().patch(`/proposals/${mine.id}`).send({ expectedVersion: mine.version, showTotal: true }),
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
      ['POST /proposals without a leadId', () => http().post('/proposals').send({})],
      ['POST /proposals with a malformed leadId', () => http().post('/proposals').send({ leadId: 'x' })],
      ['POST /proposals with an unknown field', () => http().post('/proposals').send({ leadId: leads.budi, share: true })],
      ['the catalogue without a channel', () => http().get('/proposals/catalog?age=30')],
      ['the catalogue with another channel', () => http().get('/proposals/catalog?channel=takaful&age=30')],
      ['the catalogue at age 0', () => http().get('/proposals/catalog?channel=conventional&age=0')],
      ['the catalogue at age 101', () => http().get('/proposals/catalog?channel=conventional&age=101')],
      ['a page of 51', () => http().get('/proposals?pageSize=51')],
      ['a search of 121 characters', () => http().get(`/proposals?search=${'a'.repeat(121)}`)],
      ['a status that is neither', () => http().get('/proposals?status=sent')],
    ])('P19.7-T2 AC-2 refuses %s', async (_label, call) => {
      const res = await call();
      expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('P19.7-T2 AC-2 refuses a write without expectedVersion, or with a body of the wrong shape', async () => {
      const p = await wired.proposals.create(agent(), leads.budi);
      for (const call of [
        http().patch(`/proposals/${p.id}`).send({ showTotal: true }),
        http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, payFrequency: 'weekly' }),
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
    it('P19.7-T2 AC-6 answers the catalogue for the channel and the age, and an empty list where nothing is offered (Acc. 21)', async () => {
      const res = await http().get('/proposals/catalog?channel=conventional&age=36').expect(200);
      expect(res.body.products.map((p: { code: string }) => p.code)).toEqual(['HEALTH', 'EDU', 'CONV_SYARIAH_NAME', 'USD', 'BOTH', 'LIFE']);
      const health = res.body.products[0];
      expect(health).toMatchObject({ name: 'PRUWell Medical', typeLabel: 'KESEHATAN', currency: { fixed: 'IDR' }, riders: [{ code: 'RIDER' }] });
      expect(health.faq).toEqual([{ question: 'Ada masa tunggu?', answer: '30 hari.' }]);
      expect(health.fields.some((f: Record<string, unknown>) => 'draft' in f)).toBe(false);
      const syariah = await http().get('/proposals/catalog?channel=syariah&age=36').expect(200);
      expect(syariah.body.products.map((p: { name: string }) => p.name)).toEqual(['PRU Anugerah Syariah', 'PRUCinta Syariah']);
      await mongoose.connection.db!.collection('products').updateMany({}, { $set: { lifecycle: 'withdrawn' } });
      expect((await http().get('/proposals/catalog?channel=conventional&age=36').expect(200)).body).toEqual({ products: [] });
    });

    it('P19.7-T2 AC-2 answers a 409 with both versions, and a 422 with its reason', async () => {
      const p = await wired.proposals.create(agent(), leads.budi);
      await http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, showTotal: true }).expect(200);
      const stale = await http().patch(`/proposals/${p.id}`).send({ expectedVersion: 1, showTotal: false }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });
      const rider = await http().post(`/proposals/${p.id}/items`).send({ expectedVersion: 2, productId: P.RIDER }).expect(422);
      expect(rider.body.error).toMatchObject({ code: 'PROPOSAL_PRODUCT_WITHDRAWN', details: { reason: 'rider' } });
      const incomplete = await http().post(`/proposals/${p.id}/done`).send({ expectedVersion: 2 }).expect(422);
      expect(incomplete.body.error).toMatchObject({ code: 'PROPOSAL_INCOMPLETE', details: { items: [] } });
    });

    it('P19.7-T2 AC-11 POST …/done answers 200 with the proposal Selesai', async () => {
      const p = await completeProposal(wired, agent(), leads.budi);
      const res = await http().post(`/proposals/${p.id}/done`).send({ expectedVersion: p.version }).expect(200);
      expect(res.body).toMatchObject({ status: 'done', firstDoneAt: NOW.toISOString(), date: '2026-11-05' });
    });

    it('P19.7-T2 AC-7 PATCH …/items/:itemId takes a partial insured, a cleared money field and a premium', async () => {
      let p = await wired.proposals.create(agent(), leads.budi);
      p = await wired.proposals.addItem(agent(), p.id, p.version, P.EDU);
      const url = `/proposals/${p.id}/items/${p.items[0].itemId}`;
      let res = await http().patch(url).send({ expectedVersion: p.version, insured: { relation: 'spouse' } }).expect(200);
      res = await http().patch(url).send({ expectedVersion: res.body.version, insured: { relation: 'spouse', name: 'Ibu Ani', age: null } }).expect(200);
      res = await http().patch(url).send({ expectedVersion: res.body.version, fieldValues: { up: 25_000_000_000 }, premium: { amountMinor: 400_000_00 } }).expect(200);
      res = await http().patch(url).send({ expectedVersion: res.body.version, fieldValues: { up: null } }).expect(200);
      expect(res.body.items[0]).toMatchObject({ insured: { relation: 'spouse', name: 'Ibu Ani', age: null }, fieldValues: {}, premium: { amountMinor: 400_000_00 } });
      const age = await http().patch(url).send({ expectedVersion: res.body.version, insured: { relation: 'spouse', age: 150 } }).expect(422);
      expect(age.body.error).toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', details: { min: 1, max: 100 } });
    });
  });
});

