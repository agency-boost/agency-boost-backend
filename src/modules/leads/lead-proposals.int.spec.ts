import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  NOW, PRODUCT_IDS as P, aab, ab, agent, agentB, completeProposal, seedProposalOffice, type SeededLeads,
} from '../../../test/proposals';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

/**
 * **P19.7-T2 AC-11, AC-12 — proposals on the Leads page, over HTTP** (ADR-0221 §6; Acc. 4, 5): the list's `proposals`
 * on the owner's own leads and `null` on everybody else's, `hasProposal` beside every other filter, and the lead's
 * *Riwayat* gaining *"Proposal dibuat"* for its owner alone.
 */
describe('P19.7-T2 AC-12 proposals on the Leads page (HTTP)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let leads: SeededLeads;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [LeadController],
      providers: [{ provide: LeadService, useValue: wired.leadRecords }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
    await stopMongo();
  });
  beforeEach(async () => {
    (wired.clock as FixedClock).set(NOW);
    await clearCollections();
    leads = await seedProposalOffice(wired);
    session.current = agent();
  });

  const http = () => request(app.getHttpServer());
  const rowOf = (body: { rows: { id: string }[] }, id: string) => body.rows.find((r) => r.id === id) as Record<string, unknown> | undefined;

  it('P19.7-T2 AC-12 answers each own lead’s count and its latest proposal’s products, with no extra call (Acc. 4)', async () => {
    await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.EDU]);
    await wired.proposals.create(agent(), leads.budi); // an empty draft, updated last: counted, never the "latest"
    const res = await http().get('/leads').expect(200);
    expect(rowOf(res.body, leads.budi)?.proposals).toEqual({ count: 2, latest: { products: ['PRUWell Medical', 'PRUCerah'] } });
    expect(rowOf(res.body, leads.sari)?.proposals).toBeNull();
  });

  it('P19.7-T2 AC-12 answers only empty drafts as a count with no products', async () => {
    await wired.proposals.create(agent(), leads.budi);
    const res = await http().get('/leads').expect(200);
    expect(rowOf(res.body, leads.budi)?.proposals).toEqual({ count: 1, latest: { products: [] } });
  });

  it('P19.7-T2 AC-13 answers null on every lead the caller does not own: a leader reads the lead, never its proposals', async () => {
    await completeProposal(wired, agent(), leads.budi);
    for (const leader of [aab(), ab()]) {
      session.current = leader;
      const res = await http().get('/leads').expect(200);
      expect(rowOf(res.body, leads.budi)).toBeDefined();
      expect(rowOf(res.body, leads.budi)?.proposals).toBeNull();
      const one = await http().get(`/leads/${leads.budi}`).expect(200);
      expect(one.body.proposals).toBeNull();
    }
  });

  it('P19.7-T2 AC-12 hasProposal=true and =false split your own leads, beside type and search (Acc. 5)', async () => {
    await completeProposal(wired, agent(), leads.budi);
    const withOne = await http().get('/leads?hasProposal=true').expect(200);
    expect(withOne.body.rows.map((r: { id: string }) => r.id)).toEqual([leads.budi]);
    const without = await http().get('/leads?hasProposal=false&type=sales').expect(200);
    expect(without.body.rows.map((r: { id: string }) => r.id)).toEqual([leads.sari]);
    const searched = await http().get('/leads?hasProposal=false&search=calon').expect(200);
    expect(searched.body.rows.map((r: { id: string }) => r.id)).toEqual([leads.recruit]);
  });

  it('P19.7-T2 AC-12 hasProposal narrows a leader’s list to their own leads first', async () => {
    await completeProposal(wired, agent(), leads.budi);
    session.current = aab();
    expect((await http().get('/leads?hasProposal=true').expect(200)).body.rows).toEqual([]);
    expect((await http().get('/leads?hasProposal=false').expect(200)).body.rows).toEqual([]);
    expect((await http().get(`/leads?hasProposal=true&owner=${agent().membershipId}`).expect(200)).body.rows).toEqual([]);
  });

  it.each([['yes'], ['1'], ['TRUE']])('P19.7-T2 AC-12 refuses hasProposal=%s: 400', async (value) => {
    await http().get(`/leads?hasProposal=${value}`).expect(400);
  });

  it('P19.7-T2 AC-12 a deleted proposal takes its pill away', async () => {
    const p = await completeProposal(wired, agent(), leads.budi);
    await wired.proposals.remove(agent(), p.id, p.version);
    const res = await http().get('/leads').expect(200);
    expect(rowOf(res.body, leads.budi)?.proposals).toBeNull();
    expect((await http().get('/leads?hasProposal=true').expect(200)).body.rows).toEqual([]);
  });

  it('P19.7-T2 AC-12 a write to the lead answers its pill too, so the row the screen redraws keeps it', async () => {
    await completeProposal(wired, agent(), leads.budi);
    const res = await http().patch(`/leads/${leads.budi}`).send({ remarks: 'Telepon lagi' }).expect(200);
    expect(res.body.proposals).toMatchObject({ count: 1 });
  });

  it('P19.7-T2 AC-11 the owner’s Riwayat gains "Proposal dibuat · …", dated and linked, beside the stage moves', async () => {
    let p = await completeProposal(wired, agent(), leads.budi);
    p = await wired.proposals.done(agent(), p.id, p.version);
    (wired.clock as FixedClock).set(new Date('2026-11-05T05:00:00Z'));
    await http().patch(`/leads/${leads.budi}/status`).send({ statusCode: 'FOLLOW_UP' }).expect(200);
    const res = await http().get(`/leads/${leads.budi}`).expect(200);
    // Oldest first: the proposal was saved before the move.
    expect(res.body.history.map((h: { kind: string }) => h.kind)).toEqual(['proposal', 'stage']);
    expect(res.body.history.find((h: { kind: string }) => h.kind === 'proposal'))
      .toEqual({ kind: 'proposal', at: NOW.toISOString(), proposalId: p.id, products: ['PRUWell Medical'] });
    for (const move of res.body.history.filter((h: { kind: string }) => h.kind === 'stage')) {
      expect(move).toHaveProperty('toStatusCode');
    }
  });

  it('P19.7-T2 AC-12 office B reads none of office A’s proposals on its leads (cross-tenant)', async () => {
    await completeProposal(wired, agent(), leads.budi);
    await completeProposal(wired, agentB(), leads.officeB);
    session.current = agentB();
    const res = await http().get('/leads').expect(200);
    expect(res.body.rows.map((r: { id: string }) => r.id)).toEqual([leads.officeB]);
    expect(rowOf(res.body, leads.officeB)?.proposals).toMatchObject({ count: 1 });
    await http().get(`/leads/${leads.budi}`).expect(404);
  });
});
