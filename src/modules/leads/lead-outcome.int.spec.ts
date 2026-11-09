import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { NO_CLASS, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

/**
 * **P19.1-T2 AC-10 — `PATCH /leads/:id/outcome` at and below the final stage, per role** (UI-160, ADR-0194): through the
 * real `PermissionsGuard`, the production pipe and the real service over `test/coaching-office.ts`'s office. Each role
 * holding `lead:mark_outcome` — the Agent on their own lead, the AAB and the AB on a coachee's, pinned — is answered
 * *won* at the final stage and refused *lost* there (`LEAD_STATUS_FINAL`), and the mirror below it
 * (`LEAD_STATUS_NOT_FINAL`). A member on no rung is refused by the guard; another office's lead is 404.
 */
describe('P19.1-T2 AC-10 the outcome buttons over HTTP (UI-160)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const stored = async (id: string) => db().collection('leads').findOne({ _id: new mongoose.Types.ObjectId(id) });
  /** Rina's sales lead at `stage`, as she would leave it. */
  const rinasLead = async (stage: string, type: 'sales' | 'recruitment' = 'sales') => {
    const lead = await wired.leadRecords.create(office.as('RINA'), { name: 'Ibu Kartika Dewanti', type, thisMonth: true });
    return wired.leadRecords.setStatus(office.as('RINA'), lead.id, stage);
  };
  const outcome = (id: string, body: Record<string, unknown>) => http().patch(`/leads/${id}/outcome`).send(body);

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
  });

  describe.each([
    ['the Agent, on their own lead', 'RINA'],
    ['the AAB, on a coachee’s lead', 'SARI'],
    ['the AB, on a nested coachee’s lead', 'AGUS'],
  ] as const)('%s', (_, who) => {
    it(`P19.1-T2 AC-10 positive: ${who} marks a lead won at the final stage`, async () => {
      const lead = await rinasLead('PAID_AND_ISSUED');
      as(who);
      const res = await outcome(lead.id, { outcome: 'won', version: lead.version }).expect(200);
      expect(res.body).toMatchObject({ outcome: 'won', thisMonth: true, closedThisMonth: true });
    });

    it(`P19.1-T2 AC-10 negative: ${who} is refused lost at the final stage — LEAD_STATUS_FINAL, nothing written`, async () => {
      const lead = await rinasLead('PAID_AND_ISSUED');
      as(who);
      const res = await outcome(lead.id, { outcome: 'lost', version: lead.version }).expect(422);
      expect(res.body.error).toMatchObject({ code: 'LEAD_STATUS_FINAL', details: { statusCode: 'PAID_AND_ISSUED' } });
      expect(await stored(lead.id)).toMatchObject({ outcome: null, version: lead.version });
    });

    it(`P19.1-T2 AC-10 negative: ${who} is still refused won below it — LEAD_STATUS_NOT_FINAL; lost there is taken`, async () => {
      const lead = await rinasLead('APPROVED_NOT_PAID');
      as(who);
      expect((await outcome(lead.id, { outcome: 'won', version: lead.version }).expect(422)).body.error.code)
        .toBe('LEAD_STATUS_NOT_FINAL');
      await outcome(lead.id, { outcome: 'lost', version: lead.version }).expect(200);
    });
  });

  it('P19.1-T2 AC-10 a Recruit lead at the office’s final Recruit stage: won taken, lost refused', async () => {
    const joined = await rinasLead('NEW_ACTIVE_AGENT', 'recruitment');
    as('SARI');
    expect((await outcome(joined.id, { outcome: 'lost', version: joined.version }).expect(422)).body.error.code)
      .toBe('LEAD_STATUS_FINAL');
    await outcome(joined.id, { outcome: 'won', version: joined.version }).expect(200);
  });

  it('P19.1-T2 AC-10 the refusal is said in the reader’s language', async () => {
    const lead = await rinasLead('PAID_AND_ISSUED');
    as('RINA');
    const res = await outcome(lead.id, { outcome: 'lost' }).set('Accept-Language', 'id').expect(422);
    expect(res.body.error.message).toMatch(/hanya bisa ditandai berhasil/);
  });

  it('P19.1-T2 AC-10 negative: a member on no rung the matrix names is refused by the guard', async () => {
    const lead = await rinasLead('PAID_AND_ISSUED');
    const owner = office.as('OWNER');
    session.current = new RequestContext('u-x', 'none', { ...owner.membership!, orgLevelCode: 'NOT_A_RUNG', hierarchyRole: NO_CLASS });
    const res = await outcome(lead.id, { outcome: 'won', version: lead.version }).expect(403);
    expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'lead:mark_outcome' } });
  });

  it('P19.1-T2 AC-10 negative: a peer AAB, and another office, are answered 404 — whichever outcome', async () => {
    const lead = await rinasLead('PAID_AND_ISSUED');
    for (const who of ['PEER_AAB', 'B_AB'] as const) {
      as(who);
      for (const asked of ['won', 'lost']) {
        const res = await outcome(lead.id, { outcome: asked, version: lead.version }).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    }
    expect(await stored(lead.id)).toMatchObject({ outcome: null });
  });
});
