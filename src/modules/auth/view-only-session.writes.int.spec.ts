import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
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

/** A support session as office A's Owner: the only kind there is, which only looks (ADR-0206 §3). */
const SESSION = new RequestContext(OWNER.userId, 'none', OWNER.membership, 'sa-1', null, false, true);
/** Office B's own Owner, signed in as themselves, to read what B holds. */
const OWNER_B = new RequestContext('u-owner-b', 'none', {
  ...OWNER.membership!, membershipId: 'mem-b', kpmId: KPM_B,
});

/**
 * **A session's writes over HTTP, on the routes `auth.e2e.int.spec.ts` does not mount** (P19.4-T2 AC-2, AC-7;
 * ADR-0206 §4; Overview case 9). Each was *"a setup session may"* (P18.6-T1, ADR-0162, superseded) and is pinned the
 * other way round: the production file a setup session uploaded, and the lead and the goal it never could, are each
 * `403 IMPERSONATION_READ_ONLY` with nothing written — and read as before.
 *
 * Who is signed in is the stubbed guard's, as in every controller spec: that a real token resolves to a session is
 * `auth.e2e`'s question. `ViewOnlySessionGuard` and `PermissionsGuard` run as the app runs them, in that order.
 * `view-only-session.int.spec.ts` walks every write route of the real app.
 */
describe('P19.4-T2 a session over HTTP: the file, a lead and a goal', () => {
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
    app.useGlobalGuards(
      new StubAuth(), new ViewOnlySessionGuard(app.get(Reflector)), new PermissionsGuard(app.get(Reflector)),
    );
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    session.current = SESSION;
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

  /** What the office holds: its months and its batches — compared before and after each refusal. */
  const held = async () => ({
    months: await mongoose.connection.db!.collection('productionMonths').countDocuments({}),
    batches: await mongoose.connection.db!.collection('dataUploadBatches').countDocuments({}),
    leads: await mongoose.connection.db!.collection('leads').countDocuments({}),
    goals: await mongoose.connection.db!.collection('goals').countDocuments({}),
  });

  it('P19.4-T2 AC-7 refuses the production file a setup session uploaded: preview and commit, nothing written', async () => {
    const before = await held();
    for (const res of [await preview(), await commit()]) {
      expect([res.status, res.body.error?.code]).toEqual([403, 'IMPERSONATION_READ_ONLY']);
      expect(res.body.error.message)
        .toBe('This is a view-only session. Nothing can be changed while you view as somebody else.');
    }
    expect(await held()).toEqual(before);
    // And reads the month as before.
    expect((await http().get('/kpm/data-upload/2026-09')).status).toBe(200);
  });

  it('P19.4-T2 AC-2 refuses a lead and a goal — the Owner\'s own, as the root AB, included — nothing written', async () => {
    const before = await held();
    const refusals: [string, request.Test][] = [
      ['create a lead', http().post('/leads').send({ name: 'Calon', typeCode: 'NEW' })],
      ['change a lead', http().patch('/leads/66f0000000000000000000d1').send({ name: 'x' })],
      ['set a goal', http().put('/goals/2026').send({ mode: 'direct' })],
    ];
    for (const [what, req] of refusals) {
      const res = await req;
      expect([what, res.status, res.body.error?.code]).toEqual([what, 403, 'IMPERSONATION_READ_ONLY']);
    }
    expect(await held()).toEqual(before);
    // Reading them is a read, and stays open.
    expect((await http().get('/leads')).status).toBe(200);
  });

  it('P19.4-T2 AC-2 the Owner themselves uploads the same file, in their own office alone', async () => {
    session.current = OWNER;
    expect((await preview()).status).toBe(200);
    const committed = await commit();
    expect(committed.status).toBe(201);
    expect(committed.body.batch).toMatchObject({ status: 'committed', cellCount: 1 });

    session.current = OWNER_B;
    const b = await http().get('/kpm/data-upload/2026-09');
    expect(b.status).toBe(200);
    expect(b.body.rows.map((r: { name: string }) => r.name)).toEqual(['Budi Santoso']);
    expect(b.body.rows[0].values.APE.value).toBeNull();
  });
});
