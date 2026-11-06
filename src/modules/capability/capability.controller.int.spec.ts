import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, NOT_ADMINISTRATORS, OWNER, ADMIN,
  productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { CapabilityController } from './capability.controller';
import { CapabilityService } from './capability.service';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';

const NOW = new Date('2026-09-18T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  read: 'tenant_config:read',
  rename: 'tenant_config:write',
  setStatus: 'tenant_config:write',
  add: 'tenant_config:write',
  reorder: 'tenant_config:write',
};

/**
 * Skills & stages over HTTP (P5-T8).
 *
 * The screen was renamed from *Capability catalog* and its route moved with it; what did not move
 * is that nothing ever called this controller. Its five decorators were unexecuted, and the route
 * it answers on had just changed — so a path that no test exercised was edited by hand.
 *
 * There is no id in any of these URLs: the catalog is one document per office, resolved from the
 * caller's own context. That is why `capability.tenancy.spec.ts` has no 404 test to write and why
 * the whole boundary here is the permission.
 */
describe('skills and stages over HTTP (P5-T8)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = '/kpm/settings/capability-mapping';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [CapabilityController],
      providers: [{ provide: CapabilityService, useValue: wired.capability }],
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
    session.current = OWNER;
    await clearCollections();
    await provisionOffice(wired, FIXTURE_KPM, COMPANY);
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(CapabilityController)).toEqual(ROUTES);
  });

  it('answers on the renamed path, and on nothing else', async () => {
    await request(app.getHttpServer()).get(url).expect(200);
    await request(app.getHttpServer()).get('/kpm/settings/capability-catalog').expect(404);
  });

  it.each(EVERY_MEMBER)('shows %s the catalog', async (_name, who) => {
    session.current = who;

    const res = await request(app.getHttpServer()).get(url).expect(200);

    expect(res.body.stages.length).toBeGreaterThan(0);
    expect(res.body.grids.length).toBeGreaterThan(0);
  });

  it.each(NOT_ADMINISTRATORS)('refuses %s every write', async (_name, who) => {
    session.current = who;
    const server = app.getHttpServer();

    await request(server).patch(`${url}/label`)
      .send({ part: 'stage', code: 'X', label: 'X' }).expect(403);
    await request(server).patch(`${url}/status`)
      .send({ part: 'stage', code: 'X', status: 'archived' }).expect(403);
    await request(server).post(`${url}/items`)
      .send({ part: 'milestone', code: 'X', label: 'X' }).expect(403);
    await request(server).patch(`${url}/order`)
      .send({ part: 'milestone', codes: [] }).expect(403);
  });

  it.each([['the Owner', OWNER], ['the Admin', ADMIN]])(
    'lets %s add a milestone and rename it', async (_name, who) => {
      session.current = who;

      const added = await request(app.getHttpServer()).post(`${url}/items`)
        .send({ part: 'milestone', code: 'closes_alone', label: 'Closes alone' }).expect(201);
      expect(added.body.milestones.map((m: { code: string }) => m.code))
        .toContain('CLOSES_ALONE');

      const renamed = await request(app.getHttpServer()).patch(`${url}/label`)
        .send({ part: 'milestone', code: 'CLOSES_ALONE', label: 'Closes on their own' })
        .expect(200);
      expect(renamed.body.milestones.find((m: { code: string }) => m.code === 'CLOSES_ALONE').label)
        .toBe('Closes on their own');
    },
  );

  it('archives a milestone and reorders what is left', async () => {
    // The two handlers no role test enters: a 403 stops at the guard.
    const before = (await request(app.getHttpServer()).get(url).expect(200)).body;
    const codes = before.milestones.map((m: { code: string }) => m.code);

    const reordered = await request(app.getHttpServer()).patch(`${url}/order`)
      .send({ part: 'milestone', codes: [...codes].reverse() }).expect(200);
    expect(reordered.body.milestones.map((m: { code: string }) => m.code))
      .toEqual([...codes].reverse());

    const archived = await request(app.getHttpServer()).patch(`${url}/status`)
      .send({ part: 'grid', code: before.grids[0].code, status: 'archived' }).expect(200);
    expect(archived.body.grids.find((g: { code: string }) => g.code === before.grids[0].code)
      .status).toBe('archived');
  });

  it('refuses a part the catalog does not have, before the service sees it', async () => {
    // `@IsIn` on the DTO, so the four named parts are the whole vocabulary over the wire.
    await request(app.getHttpServer()).post(`${url}/items`)
      .send({ part: 'rung', code: 'X', label: 'X' }).expect(400);
  });

  it('P18.10-T5 AC-7 refuses a reused code, and a reorder naming too few, in Indonesian for an Indonesian reader', async () => {
    const before = (await request(app.getHttpServer()).get(url).expect(200)).body;
    const taken = before.milestones[0].code as string;

    const reused = await request(app.getHttpServer()).post(`${url}/items`).set(...IN_INDONESIAN)
      .send({ part: 'milestone', code: taken, label: 'Again' }).expect(400);
    expect(reused.body.error.code).toBe('VALIDATION_FAILED');
    expect(reused.body.error.message).toBe(
      `${taken} sudah dipakai di katalog ini. Kode tidak pernah dipakai ulang — centang merujuk ke satu kode, `
        + 'jadi kode yang sama dua kali akan menjadi centang yang sama.',
    );

    const short = await request(app.getHttpServer()).patch(`${url}/order`).set(...IN_INDONESIAN)
      .send({ part: 'milestone', codes: [taken] }).expect(400);
    expect(short.body.error.message)
      .toBe(`Kirim setiap milestone masing-masing sekali — semuanya ${before.milestones.length}.`);

    // The same refusal, in English for an English reader: the words the API has always written.
    const english = await request(app.getHttpServer()).patch(`${url}/order`)
      .send({ part: 'milestone', codes: [taken] }).expect(400);
    expect(english.body.error.message).toBe(`Send every milestone once each — ${before.milestones.length} of them.`);
  });

  it('refuses a body carrying a field the DTO never declared', async () => {
    const res = await request(app.getHttpServer()).post(`${url}/items`)
      .send({ part: 'milestone', code: 'X', label: 'X', stageOrder: 3 }).expect(400);

    expect(res.body.error.details.violations)
      .toEqual(expect.arrayContaining([expect.stringContaining('stageOrder')]));
  });
});
