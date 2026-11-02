import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SETUP_SESSION_WRITE_SCOPE } from '@/modules/rbac/permissions';
import { GoalController } from '@/modules/goals/goal.controller';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadController } from '@/modules/leads/lead.controller';
import { LeadService } from '@/modules/leads/lead.service';
import { ProductionController } from '@/modules/production/production.controller';
import { ProductionCorrections } from '@/modules/production/production-correction.service';
import { ProductionImportService } from '@/modules/production/production-import.service';
import { ProductionMonth } from '@/modules/production/production-month.schema';
import { ProductionMonths } from '@/modules/production/production-months.service';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import { ProductionService } from '@/modules/production/production.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { FIXTURE_KPM, OWNER, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-27T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const KPM_B = '66f0000000000000000000b2';
const RINA = '66f000000000000000000101';
const BUDI = '66f000000000000000000102';

/** A support session as office A's Owner — `setup` with the scope, `support` without it (ADR-0162). */
const asOwner = (writeScope: readonly string[]) =>
  new RequestContext(OWNER.userId, 'none', OWNER.membership, 'sa-1', null, false, true, writeScope);
const SETUP = asOwner(SETUP_SESSION_WRITE_SCOPE);
const LOOK_ONLY = asOwner([]);
/** Office B's own Owner, signed in as themselves, to read what B holds. */
const OWNER_B = new RequestContext('u-owner-b', 'none', {
  ...OWNER.membership!, membershipId: 'mem-b', kpmId: KPM_B,
});

/**
 * **A setup session over HTTP, on the routes `auth.e2e.int.spec.ts` does not mount** (P18.9-T1 AC-2, AC-6;
 * ADR-0162): the production file it may upload, and the lead and the goal it may not write.
 *
 * Who is signed in is the stubbed guard's, as in every controller spec: whether a real token resolves to
 * this context is `auth.e2e`'s question, and asked there. What only a request answers is here — that
 * `PermissionsGuard` lets a scoped write through and refuses the rest, on real routes with their own
 * decorators, and that the write lands in the session's office alone.
 */
describe('a setup session over HTTP: the file, a lead and a goal (P18.9-T1)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductionController, LeadController, GoalController],
      providers: [
        { provide: ProductionService, useValue: wired.production },
        { provide: ProductionImportService, useValue: wired.productionImport },
        { provide: ProductionMonths, useValue: wired.productionMonths },
        { provide: ProductionCorrections, useValue: wired.productionCorrections },
        { provide: LeadService, useValue: wired.leadRecords },
        { provide: GoalService, useValue: wired.goals },
      ],
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
    session.current = SETUP;
    await clearCollections();
    await mongoose.model(ProductionMonth.name).syncIndexes();
    const kpms = wired.kpms as { create: (d: unknown) => Promise<unknown> };
    for (const [id, code] of [[FIXTURE_KPM, '0417'], [KPM_B, '0418']]) {
      await kpms.create({ _id: id, companyId: COMPANY, code, branchName: code, timezone: 'Asia/Jakarta' });
    }
    // One agent in each office, with the same agent code: a file for A can only ever name A's.
    for (const [id, kpmId, userId, name] of [
      [RINA, FIXTURE_KPM, '66f000000000000000000301', 'Rina Wijaya'],
      [BUDI, KPM_B, '66f000000000000000000302', 'Budi Santoso'],
    ]) {
      await mongoose.connection.db!.collection('memberships').insertOne({
        _id: new mongoose.Types.ObjectId(id), kpmId, userId, agentCode: 'PRU-001', agentSeq: 1,
        leaderCode: `LC-${id.slice(-3)}`, orgLevelCode: 'AGENT', hierarchyRole: 'agent', leaderId: null,
        ancestorIds: [], status: 'active', deletedAt: null,
      } as never);
      await mongoose.connection.db!.collection('users').insertOne({
        _id: new mongoose.Types.ObjectId(userId), email: `${userId}@kpm.test`, fullName: name, deletedAt: null,
      } as never);
    }
  });

  const FILLED = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,,,,,,,,,,,\n`;
  const preview = () => http().post('/kpm/data-upload/preview').field('month', '2026-09')
    .attach('file', Buffer.from(FILLED), 'filled.csv');
  const commit = () => http().post('/kpm/data-upload/commit').field('month', '2026-09').field('revision', '0')
    .attach('file', Buffer.from(FILLED), 'filled.csv');

  it('AC-6 uploads a production file: previews it and confirms the import, in its own office', async () => {
    expect((await preview()).status).toBe(200);
    const committed = await commit();
    expect(committed.status).toBe(201);
    expect(committed.body.batch).toMatchObject({ status: 'committed', cellCount: 1 });

    const month = await http().get('/kpm/data-upload/2026-09');
    expect(month.body.rows[0].metrics.ape.monthly).toMatchObject({ value: 150_000_000, provenance: 'imported' });
  });

  it('AC-6 a setup session for office A writes nothing of office B', async () => {
    await commit();
    session.current = OWNER_B;
    const b = await http().get('/kpm/data-upload/2026-09');
    expect(b.status).toBe(200);
    expect(b.body.rows.map((r: { name: string }) => r.name)).toEqual(['Budi Santoso']);
    expect(b.body.rows[0].metrics.ape.monthly.value).toBeNull();
    expect(b.body.withData).toBe(0);
  });

  it('AC-2 a session that only looks is refused the same upload', async () => {
    session.current = LOOK_ONLY;
    for (const res of [await preview(), await commit()]) {
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('read-only support session');
    }
    // And reads it as before.
    expect((await http().get('/kpm/data-upload/2026-09')).status).toBe(200);
  });

  it('AC-6 may not write a lead or a goal — the Owner\'s own, as the root AB, included', async () => {
    const refusals: [string, request.Test, string][] = [
      ['create a lead', http().post('/leads').send({ name: 'Calon', typeCode: 'NEW' }), 'lead:create'],
      ['change a lead', http().patch('/leads/66f0000000000000000000d1').send({ name: 'x' }), 'lead:update'],
      ['set a goal', http().put('/goals/2026').send({ mode: 'direct' }), 'goal:update'],
    ];
    for (const [what, req, permission] of refusals) {
      const res = await req;
      expect([what, res.status, res.body.error?.code, res.body.error?.details?.permission])
        .toEqual([what, 403, 'PERM_DENIED', permission]);
      expect(res.body.error.message).toContain('This setup session can change the office');
    }
    // Reading them is a read, and stays open.
    expect((await http().get('/leads')).status).toBe(200);
  });
});
