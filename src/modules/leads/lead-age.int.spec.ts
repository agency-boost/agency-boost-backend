import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { AGENT, FIXTURE_KPM, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

const NOW = new Date('2026-11-05T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';

/**
 * **P19.14-T1 AC-4 — a lead carries no age and no gender, over HTTP** (ADR-0254 §1, superseding ADR-0224): the lead
 * stays general. `age` and `gender` in a body are unknown fields, refused `400` as `birthDate` and `ageRecordedOn` always
 * were, and no answer carries them. The client's age and gender are each proposal's, entered at its step 1 — and the
 * age's own refusal, `422 LEAD_AGE_OUT_OF_RANGE`, is the proposal's now (`proposal.int.spec.ts`).
 */
describe('P19.14-T1 AC-4 a lead carries no age or gender (HTTP)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

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
    session.current = AGENT;
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    });
    await provisionOffice(wired, FIXTURE_KPM, COMPANY);
  });

  const http = () => request(app.getHttpServer());
  const add = (body: Record<string, unknown>) => http().post('/leads').send({ name: 'Pak Budi', ...body });

  it.each([
    [{ age: 36 }], [{ gender: 'male' }], [{ age: null }], [{ gender: null }], [{ birthDate: '1990-03-01' }], [{ ageRecordedOn: '2020-01-01' }],
  ])('P19.14-T1 AC-4 refuses %p on POST /leads as an unknown field: 400, nothing written', async (extra) => {
    const res = await add({ type: 'sales', ...extra }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((await http().get('/leads').expect(200)).body.total).toBe(0);
  });

  it('P19.14-T1 AC-4 refuses an age or a gender on PATCH /leads/:id, and changes nothing', async () => {
    const lead = await add({ type: 'sales' }).expect(201);
    for (const body of [{ age: 40 }, { gender: 'female' }]) {
      const res = await http().patch(`/leads/${lead.body.id}`).send({ ...body, version: lead.body.version }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await http().get(`/leads/${lead.body.id}`).expect(200)).body.version).toBe(lead.body.version);
  });

  it('P19.14-T1 AC-4 answers no age, no ageRecordedOn and no gender on a write or a read', async () => {
    const created = await add({ type: 'sales', contact: { phone: '0812 1100 2200', email: null } }).expect(201);
    const read = await http().get(`/leads/${created.body.id}`).expect(200);
    const page = await http().get('/leads').expect(200);
    for (const view of [created.body, read.body, page.body.rows[0]]) {
      for (const key of ['age', 'ageRecordedOn', 'gender']) expect(view).not.toHaveProperty(key);
    }
  });

  it('P19.14-T1 AC-2 + Lead baru saves the name and an optional phone as a Sales lead, then moves it to its first stage', async () => {
    const res = await add({ name: 'Ibu Wulan', type: 'sales', contact: { phone: '0812 1100 2200', email: null } }).expect(201);
    expect(res.body).toMatchObject({ name: 'Ibu Wulan', type: 'sales', contact: { phone: '+6281211002200' } });
    // The screen's second call, as the lead sheet's *+ Tambah lead* makes it: the Sales ladder's first stage (*Baru* in
    // the spec; the office's own first stage, *Belum didekati* in the seed).
    const moved = await http().patch(`/leads/${res.body.id}/status`).send({ statusCode: 'NOT_YET_APPROACHED', version: res.body.version }).expect(200);
    expect(moved.body).toMatchObject({ type: 'sales', statusCode: 'NOT_YET_APPROACHED' });
  });

  it('P19.14-T1 AC-4 refuses the Super Admin outside a session: no membership, no lead', async () => {
    session.current = SUPER_ADMIN;
    const res = await add({ type: 'sales' });
    expect(res.status).toBe(403);
  });
});
