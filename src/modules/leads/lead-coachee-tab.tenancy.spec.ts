import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

/**
 * **The coachee's *Leads* tab, and the Coaching Session's Leads card** (UI V1, UI-029, UI-062; Phase 18.99 T8) — one
 * read, `GET /leads?owner=`, every lead of that agent, open and closed, which the screen splits into rows and the
 * *Ditutup* line. The route is ADR-0076's; this spec is the tab's boundary:
 *
 * - **positive**: the coachee's own leader and a leader further up read that agent's leads — theirs alone;
 * - **negative, reach**: a peer, a peer leader, and the agent themselves for somebody else, are answered 404 — the
 *   same answer as an id that names nobody, so nothing says the person exists;
 * - **negative, tenancy**: another office's leader naming this office's agent, and this office's leader naming
 *   another office's agent, are answered 404, and **no audit entry is written for a refused read**;
 * - **a Super Admin** is refused by name (403), never a cross-office read.
 */
describe('P18.99-T8 — a coachee’s Leads tab, across the boundary (UI-029)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const reads = () => db().collection('auditLog').find({ action: SUBJECT_READ_ACTION, 'after.surface': 'leads' }).toArray();
  const leadOf = async (who: Who, name: string, over: Record<string, unknown> = {}) =>
    wired.leadRecords.create(office.as(who), { name, type: 'sales', ...over });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);

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
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await db().collection('leads').deleteMany({});
    await db().collection('auditLog').deleteMany({});
    await leadOf('RINA', 'Ibu Shinta Maharani');
    const won = await leadOf('RINA', 'Pak Won');
    await wired.leadRecords.setOutcome(office.as('RINA'), won.id, 'lost');
    await leadOf('BUDI', 'Budi’s lead');
    await leadOf('B_AGENT', 'Another office’s lead');
  });

  it('UI-029 answers her direct leader (an AAB) and the AB above: her leads alone, open and closed', async () => {
    for (const leader of ['SARI', 'AGUS'] as const) {
      as(leader);
      const res = await http().get('/leads').query({ owner: office.id.RINA, page: 1, pageSize: 200 }).expect(200);
      expect(res.body.rows.map((r: { name: string }) => r.name).sort()).toEqual(['Ibu Shinta Maharani', 'Pak Won']);
      expect(res.body.rows.every((r: { ownerMembershipId: string }) => r.ownerMembershipId === office.id.RINA)).toBe(true);
      // The closed lead comes back too: the tab's *Ditutup* line counts it.
      expect(res.body.rows.find((r: { name: string }) => r.name === 'Pak Won').outcome).toBe('lost');
    }
  });

  it('UI-029 refuses outside the reader’s reach with 404: a peer leader, an agent for a peer, the coachee’s own peer', async () => {
    for (const [reader, owner] of [['PEER_AAB', 'RINA'], ['PEER_AB', 'RINA'], ['BUDI', 'RINA'], ['RINA', 'BUDI']] as const) {
      as(reader);
      const res = await http().get('/leads').query({ owner: office.id[owner] }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect(await reads()).toHaveLength(0);
  });

  it('UI-029 never crosses offices: KPM B’s leader cannot read KPM A’s agent, nor KPM A’s leader KPM B’s — 404, nothing audited', async () => {
    as('B_AB');
    const across = await http().get('/leads').query({ owner: office.id.RINA }).expect(404);
    expect(across.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(across.body)).not.toContain('Shinta');

    as('AGUS');
    const back = await http().get('/leads').query({ owner: office.id.B_AGENT }).expect(404);
    expect(back.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(back.body)).not.toContain('Another office');

    expect(await reads()).toHaveLength(0);
  });

  it('UI-029 refuses a Super Admin by name: no cross-office read through the tab', async () => {
    session.current = SUPER_ADMIN;
    const res = await http().get('/leads').query({ owner: office.id.RINA }).expect(403);
    expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
  });

  it('UI-029 writes one leads entry for the leader’s read, the coachee as its subject (roles §3.5)', async () => {
    as('SARI');
    await http().get('/leads').query({ owner: office.id.RINA }).expect(200);
    const written = await reads();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actorMembershipId: office.id.SARI, targetMembershipId: office.id.RINA });
  });
});
