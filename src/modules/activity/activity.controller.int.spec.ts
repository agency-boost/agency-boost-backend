import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth,
  SUPER_ADMIN,
} from '../../../test/http-permissions';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-03-11T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const TODAY = '2026-03-11';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  readDay: 'activity_log:read_raw',
  saveDay: 'activity_log:create',
  correctDay: 'activity_log:update',
  summary: 'activity_ratios:read',
  dashboard: 'activity_log:read_raw',
  ratios: 'activity_ratios:read',
  compliance: 'activity_log:read_raw',
};

/**
 * Logging a day, over HTTP (P6).
 *
 * `activity.tenancy.spec.ts` proves the day boundary, the correction window and the scoped reads
 * by calling the service. What only a request can answer lives here: the decorators, the pipe, and
 * the shape of the write route.
 *
 * **The write route has no `membershipId` and that is the point.** No role may log on another
 * person's behalf (`roles-and-permissions.md` §3.5). A check can be forgotten; a parameter that
 * does not exist cannot be passed.
 */
describe('logging a day over HTTP (P6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = '/activity';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [ActivityController],
      providers: [{ provide: ActivityService, useValue: wired.activityLogs }],
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
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A',
      timezone: 'Asia/Jakarta',
    });
    await provisionOffice(wired, FIXTURE_KPM, COMPANY);
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(ActivityController)).toEqual(ROUTES);
  });

  describe('who may log', () => {
    /*
     * **Every member of the office may log their own day, the Owner and the Admin included.**
     *
     * §3.5's table shows `—` in the Owner and Admin columns, and that is easy to misread. The
     * grant is on the **rung**, and admin rights are orthogonal to hierarchy role — an Owner is
     * also an AB or an AAB, stands on the ladder like anybody else, and has a day of their own to
     * report. What the `—` means is that being the Owner grants nothing extra here: it buys no
     * right to write *somebody else's* day, which is what `proxy_create` would have been.
     */
    it.each(EVERY_MEMBER)('lets %s save their own day', async (_name, who) => {
      session.current = who;

      const res = await request(app.getHttpServer()).put(`${url}/log`)
        .send({ counts: { SELL_SUBMISSION: 2 } }).expect(200);

      expect(res.body).toMatchObject({ localDate: TODAY, totalCount: 2, version: 1 });
      expect(res.body.membershipId).toBe(who.membershipId);
    });

    it('refuses a Super Admin, who stands on no rung and has no day here', async () => {
      session.current = SUPER_ADMIN;

      await request(app.getHttpServer()).put(`${url}/log`)
        .send({ counts: { SELL_SUBMISSION: 1 } }).expect(403);
    });

    it('has no way to name whose day is being written', async () => {
      // `forbidNonWhitelisted` refuses the field outright, so the attempt cannot even be
      // mistaken for a silent drop.
      const res = await request(app.getHttpServer()).put(`${url}/log`)
        .send({ counts: {}, membershipId: 'somebody-else' }).expect(400);

      expect(res.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
    });
  });

  describe('the day', () => {
    it('defaults to today in the office, and comes back with every active type', async () => {
      const res = await request(app.getHttpServer()).get(`${url}/log`).expect(200);

      expect(res.body.localDate).toBe(TODAY);
      expect(res.body.entries).toHaveLength(12);
      expect(res.body.editable).toBe(true);
    });

    it('refuses a date that is not a date, naming the shape', async () => {
      const res = await request(app.getHttpServer()).get(`${url}/log`)
        .query({ date: '11-03-2026' }).expect(400);

      expect(JSON.stringify(res.body)).toMatch(/YYYY-MM-DD/);
    });

    it('refuses a day that has not happened, with a code a client can branch on', async () => {
      // 422 and ACTIVITY_FUTURE_DATE, not a bare 400. The error catalog carried these codes from
      // an earlier phase and the module shipped producing none of them — found at the Phase 6
      // exit review, and a client written against the catalog would have branched on nothing.
      const res = await request(app.getHttpServer()).put(`${url}/log`)
        .send({ date: '2026-03-12', counts: {} }).expect(422);

      expect(res.body.error.code).toBe('ACTIVITY_FUTURE_DATE');
    });

    it('refuses a day past its window with the code that offers the next step', async () => {
      const res = await request(app.getHttpServer()).put(`${url}/log`)
        .send({ date: '2026-01-20', counts: {} }).expect(422);

      // The one refusal with somewhere to go: the screen switches to the correction form.
      expect(res.body.error.code).toBe('ACTIVITY_DATE_OUT_OF_WINDOW');
    });

    it('refuses a code this office does not have, by name', async () => {
      const res = await request(app.getHttpServer()).put(`${url}/log`)
        .send({ counts: { NOT_A_CODE: 1 } }).expect(400);

      expect(res.body.error.message).toMatch(/NOT_A_CODE/);
    });
  });

  describe('correcting a frozen day', () => {
    it('needs a reason, through the pipe as well as the service', async () => {
      await request(app.getHttpServer()).post(`${url}/log/correction`)
        .send({ date: '2026-02-20', counts: {} }).expect(400);
    });

    it('refuses a day that is still open, pointing at the ordinary save', async () => {
      await request(app.getHttpServer()).put(`${url}/log`).send({ counts: {} }).expect(200);

      const res = await request(app.getHttpServer()).post(`${url}/log/correction`)
        .send({ date: TODAY, counts: {}, reason: 'Because.' }).expect(400);

      expect(res.body.error.message).toMatch(/still open/);
    });
  });

  describe('the reads', () => {
    it('answers the summary over a named period, with every code present', async () => {
      await request(app.getHttpServer()).put(`${url}/log`)
        .send({ counts: { SELL_SUBMISSION: 3 } }).expect(200);

      const res = await request(app.getHttpServer()).get(`${url}/summary`)
        .query({ period: 'ROLLING_7D' }).expect(200);

      expect(res.body).toMatchObject({ from: '2026-03-05', to: TODAY, daysLogged: 1 });
      expect(res.body.totals).toHaveLength(12);
    });

    it('refuses a period the registry does not name', async () => {
      await request(app.getHttpServer()).get(`${url}/summary`)
        .query({ period: 'LAST_FORTNIGHT' }).expect(400);
    });

    it('answers compliance as Logged or Missed, with no partial state', async () => {
      const before = await request(app.getHttpServer()).get(`${url}/compliance`).expect(200);
      expect(before).toMatchObject({ body: { compliant7d: false, lastLoggedOn: null } });

      // An all-zero day counts: the metric asks whether they reported (ADR-0042, OD-30).
      await request(app.getHttpServer()).put(`${url}/log`).send({ counts: {} }).expect(200);

      const after = await request(app.getHttpServer()).get(`${url}/compliance`).expect(200);
      expect(after.body).toMatchObject({
        compliant7d: true, compliantMonth: true, lastLoggedOn: TODAY, windowDays: 7,
      });
    });

    it.each(EVERY_MEMBER)('lets %s read their own compliance', async (_name, who) => {
      session.current = who;

      await request(app.getHttpServer()).get(`${url}/compliance`).expect(200);
    });
  });

  describe('the ratios (P10-T2, P10-T3)', () => {
    it.each(EVERY_MEMBER)('answers %s their own ratios over the last 30 days', async (_name, who) => {
      session.current = who;
      const res = await request(app.getHttpServer()).get(`${url}/ratios`).expect(200);
      expect(res.body).toMatchObject({ membershipId: who.membershipId, from: '2026-02-10', to: TODAY, days: 30 });
      expect(res.body.ratios.length).toBeGreaterThan(0);
    });

    it('sends not enough data as null, not as a missing key or a zero', async () => {
      const res = await request(app.getHttpServer()).get(`${url}/ratios`).expect(200);
      expect(res.body.ratios[0]).toHaveProperty('value', null);
      expect(res.body.ratios[0]).toHaveProperty('status', 'neutral');
    });

    it('refuses a Super Admin, who has no ratios of their own', async () => {
      session.current = SUPER_ADMIN;
      await request(app.getHttpServer()).get(`${url}/ratios`).expect(403);
    });

    it('has no way to name whose ratios are read — a leader’s view of a downline is Phase 11’s', async () => {
      const res = await request(app.getHttpServer()).get(`${url}/ratios`)
        .query({ membershipId: 'somebody-else' }).expect(400);
      expect(res.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
    });
  });

  describe('the Activity Dashboard (P10-T1)', () => {
    it.each(EVERY_MEMBER)('answers %s their own days, the last 7 by default', async (_name, who) => {
      session.current = who;
      await request(app.getHttpServer()).put(`${url}/log`)
        .send({ counts: { SELL_SUBMISSION: 2 } }).expect(200);

      const res = await request(app.getHttpServer()).get(`${url}/dashboard`).expect(200);

      expect(res.body).toMatchObject({ range: 'ROLLING_7D', from: '2026-03-05', to: TODAY, today: TODAY, total: 2 });
      expect(res.body.buckets).toHaveLength(7);
    });

    it('refuses a Super Admin, who has no days of their own', async () => {
      session.current = SUPER_ADMIN;
      await request(app.getHttpServer()).get(`${url}/dashboard`).expect(403);
    });

    it('has no way to name whose days are read', async () => {
      const res = await request(app.getHttpServer()).get(`${url}/dashboard`)
        .query({ membershipId: 'somebody-else' }).expect(400);
      expect(res.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
    });

    it('answers the last 30 days in blocks, and a custom range as asked', async () => {
      const month = await request(app.getHttpServer()).get(`${url}/dashboard`)
        .query({ range: 'ROLLING_30D' }).expect(200);
      expect(month.body.buckets.map((b: { kind: string }) => b.kind))
        .toEqual(['week', 'week', 'week', 'week', 'remainder']);

      const custom = await request(app.getHttpServer()).get(`${url}/dashboard`)
        .query({ range: 'CUSTOM', from: '2026-03-01', to: '2026-03-03' }).expect(200);
      expect(custom.body).toMatchObject({ days: 3, from: '2026-03-01', to: '2026-03-03' });
    });

    it('refuses a range it cannot show, with a code and the field a client can point at', async () => {
      const future = await request(app.getHttpServer()).get(`${url}/dashboard`)
        .query({ range: 'CUSTOM', from: '2026-03-01', to: '2026-03-20' }).expect(400);
      expect(future.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'to', today: TODAY } });

      const tooLong = await request(app.getHttpServer()).get(`${url}/dashboard`)
        .query({ range: 'CUSTOM', from: '2024-01-01', to: TODAY }).expect(400);
      expect(tooLong.body.error.details).toMatchObject({ max: 366 });

      await request(app.getHttpServer()).get(`${url}/dashboard`).query({ range: 'LAST_QUARTER' }).expect(400);
      await request(app.getHttpServer()).get(`${url}/dashboard`)
        .query({ range: 'CUSTOM', from: '01-03-2026', to: TODAY }).expect(400);
    });
  });
});
