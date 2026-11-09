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
 * **P19.7-T1 AC-1 — the lead's age and gender over HTTP** (ADR-0224 §3, §6): the pipe lets both through, takes no birth
 * date and no `ageRecordedOn`, refuses a shape with `400` and a whole number outside 1–100 with `422
 * LEAD_AGE_OUT_OF_RANGE`, `details: { min, max }`, in the reader's language.
 */
describe('P19.7-T1 AC-1 the lead’s age and gender over HTTP', () => {
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

  it('P19.7-T1 AC-1 takes age and gender through the pipe on POST and PATCH, and answers them with the day', async () => {
    const created = await add({ type: 'sales', age: 36, gender: 'male' }).expect(201);
    expect(created.body).toMatchObject({ age: 36, ageRecordedOn: '2026-11-05', gender: 'male' });
    const patched = await http().patch(`/leads/${created.body.id}`).send({ gender: 'female', age: 40 }).expect(200);
    expect(patched.body).toMatchObject({ age: 40, ageRecordedOn: '2026-11-05', gender: 'female' });
    const read = await http().get(`/leads/${created.body.id}`).expect(200);
    expect(read.body).toMatchObject({ age: 40, gender: 'female' });
  });

  it('P19.7-T1 AC-1 refuses a birth date as an unknown field: 400, nothing written (minimisation)', async () => {
    const res = await add({ birthDate: '1990-03-01' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).toMatch(/birthDate/);
    const lead = await add({}).expect(201);
    await http().patch(`/leads/${lead.body.id}`).send({ birthDate: '1990-03-01' }).expect(400);
  });

  it('P19.7-T1 AC-1 refuses ageRecordedOn in a body: the day is the server’s', async () => {
    const res = await add({ age: 30, ageRecordedOn: '2020-01-01' }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/ageRecordedOn/);
  });

  it.each([[36.5], ['36'], [true], [{ $gt: 1 }]])('P19.7-T1 AC-1 refuses an age that is not a whole number (%p): 400', async (age) => {
    const res = await add({ age }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it.each([['x'], ['MALE'], [1]])('P19.7-T1 AC-1 refuses a gender that is not male, female or null (%p): 400', async (gender) => {
    await add({ gender }).expect(400);
  });

  it.each([[0], [101], [150]])('P19.7-T1 AC-1 refuses %p with 422 LEAD_AGE_OUT_OF_RANGE, details { min: 1, max: 100 }', async (age) => {
    const res = await add({ age }).expect(422);
    expect(res.body.error).toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', details: { min: 1, max: 100 } });
  });

  it('P19.7-T1 AC-1 says the screen’s own sentence in Indonesian: "Umur harus 1–100."', async () => {
    const res = await add({ age: 0 }).set('Accept-Language', 'id').expect(422);
    expect(res.body.error.message).toBe('Umur harus 1–100.');
  });

  it('P19.7-T1 AC-1 accepts the bounds themselves, 1 and 100', async () => {
    await add({ age: 1 }).expect(201);
    await add({ age: 100 }).expect(201);
  });

  it('P19.7-T1 AC-1 refuses the Super Admin outside a session: no membership, no lead', async () => {
    session.current = SUPER_ADMIN;
    const res = await add({ age: 36 });
    expect(res.status).toBe(403);
  });
});
