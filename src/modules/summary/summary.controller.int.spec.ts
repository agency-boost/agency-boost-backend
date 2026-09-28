import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { Goal } from '@/modules/goals/goal.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { SummaryController } from './summary.controller';
import { SummaryService } from './summary.service';

const NOW = new Date('2026-09-14T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';

/** The Personal Summary over HTTP (P10-T4): the decorators, the pipe, and the wire shape. */
describe('the Personal Summary over HTTP (P10-T4)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [SummaryController],
      providers: [{ provide: SummaryService, useValue: wired.summary }],
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
    await mongoose.model(Goal.name).syncIndexes();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    });
  });

  it('declares its permission, and the right one', () => {
    expect(declaredPermissions(SummaryController)).toEqual({ read: 'personal_summary:read' });
  });

  it.each(EVERY_MEMBER)('answers %s their own Summary', async (_name, who) => {
    session.current = who;
    const res = await request(app.getHttpServer()).get('/summary').expect(200);

    expect(res.body).toMatchObject({ year: '2026', month: '2026-09', today: '2026-09-14', goal: { set: false } });
    // Nothing measured is sent as null, not dropped: a missing key and a zero would read alike.
    expect(res.body.monthly).toHaveProperty('attainmentPct', null);
    expect(res.body).toHaveProperty('pace', null);
    // P10-T5: the chips go out for both periods, with a null target rather than none.
    for (const period of ['monthly', 'yearly']) {
      expect(res.body.activity[period].targets.map((t: { key: string }) => t.key)).toEqual(['leads', 'appointments', 'closings']);
      expect(res.body.activity[period].targets[0]).toHaveProperty('target', null);
      expect(res.body.activity[period]).toHaveProperty('total');
      expect(res.body.activity[period]).toHaveProperty('sections');
    }
  });

  it('refuses a Super Admin, who has no Summary of their own', async () => {
    session.current = SUPER_ADMIN;
    await request(app.getHttpServer()).get('/summary').expect(403);
  });

  it('has no way to name whose Summary is read — a leader’s view of a downline is Phase 13’s', async () => {
    const res = await request(app.getHttpServer()).get('/summary').query({ membershipId: 'somebody-else' }).expect(400);
    expect(res.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
  });
});
