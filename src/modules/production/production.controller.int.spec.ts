import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  ADMIN, declaredPermissions, FIXTURE_KPM, NOT_ADMINISTRATORS, OWNER, productionPipe, session,
  StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

const NOW = new Date('2026-09-27T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const RINA = '66f000000000000000000101';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  readMonth: 'data_upload:read',
};

/**
 * The month table over HTTP (P9-T1 AC-5, AC-7).
 *
 * `production.tenancy.spec.ts` proves the rules through the service. What only a request can answer
 * is here: that the route declares the grant it should, and that §3.9 is what the guard enforces —
 * an Owner and an Admin may read the office's production, and nobody below them may.
 */
describe('production over HTTP (P9-T1)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductionController],
      providers: [{ provide: ProductionService, useValue: wired.production }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    });
    await mongoose.connection.db!.collection('memberships').insertOne({
      _id: new mongoose.Types.ObjectId(RINA), kpmId: FIXTURE_KPM, userId: '66f000000000000000000301',
      agentCode: 'PRU-001', agentSeq: 1, leaderCode: 'LC-101', orgLevelCode: 'AGENT',
      hierarchyRole: 'agent', leaderId: null, ancestorIds: [], status: 'active', deletedAt: null,
    } as never);
    await mongoose.connection.db!.collection('users').insertOne({
      _id: new mongoose.Types.ObjectId('66f000000000000000000301'),
      email: 'rina@kpm.test', fullName: 'Rina Wijaya', deletedAt: null,
    } as never);
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(ProductionController)).toEqual(ROUTES);
  });

  it('answers the Owner the office’s month, every member a row', async () => {
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ month: '2026-09', withData: 0 });
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ name: 'Rina Wijaya', agentCode: 'PRU-001' });
    expect(res.body.rows[0].metrics.ape.monthly).toEqual({ value: null, provenance: null });
  });

  it('answers the Admin the same — §3.9 grants both', async () => {
    session.current = ADMIN;
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
    expect(res.status).toBe(200);
  });

  describe('AC-5 — who may not', () => {
    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))(
      'refuses %s: production is the office’s business, not a rung’s',
      async (_who, ctx) => {
        session.current = ctx;
        const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
        expect(res.status).toBe(403);
      },
    );

    it('refuses a Super Admin by name rather than by a 500', async () => {
      // §3.9 grants them `all`, and the route resolves the office from the caller's membership,
      // which they have none of. The guard passes and the service refuses cleanly.
      session.current = SUPER_ADMIN;
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
      expect(res.status).not.toBe(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(typeof res.body.error?.code).toBe('string');
    });
  });

  it('refuses a path that is not a month, with a code a client can branch on', async () => {
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/september');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
