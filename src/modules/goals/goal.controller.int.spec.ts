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
import {
  AB, AGENT, declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth,
  SUPER_ADMIN,
} from '../../../test/http-permissions';
import { GoalController } from './goal.controller';
import { GoalService } from './goal.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-25T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';

/** Every route, and the permission it must declare (§3.6). */
const ROUTES: Record<string, string> = {
  read: 'goal:read',
  preview: 'goal:read',
  save: 'goal:update',
  saveEstimate: 'goal:update',
};

/**
 * Goals over HTTP (P8-T3).
 *
 * `goal.tenancy.spec.ts` proves the rules by calling the service. What only a request can answer
 * lives here: the decorators, and **the pipe** — a property with no validation decorator is
 * stripped by `forbidNonWhitelisted` before a service sees it, which is how three event and
 * campaign DTOs shipped unable to accept the fields they documented.
 */

/**
 * **An Agent who stands above nobody in this office** (P19.9-T6): the shared fixture's `AGENT` is `mem-a`, the leader the
 * subjects below are written under, and an Agent who leads somebody reaches them since ADR-0234 — so the *anybody else*
 * cases name an Agent elsewhere in the tree.
 */
const AGENT_ELSEWHERE = new RequestContext('u-agent-z', 'none', { ...AGENT.membership!, membershipId: 'mem-z' } as never);

describe('goals over HTTP (P8-T3)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = '/goals/2026';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [GoalController],
      providers: [{ provide: GoalService, useValue: wired.goals }],
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
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A',
      timezone: 'Asia/Jakarta',
    });
  });

  const http = () => request(app.getHttpServer());
  const plan = (over: Record<string, unknown> = {}) => ({
    mode: 'direct',
    annualApeTargetMinor: 500_000_000_00,
    savingsTargetMinor: 50_000_000_00,
    commissionRatePct: 10,
    monthsLeft: 5,
    apeAchievedMinor: 0,
    caseSizeMinor: 18_000_000_00,
    leadsToApptPct: 30,
    closingRatePct: 30,
    ...over,
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(GoalController)).toEqual(ROUTES);
  });

  describe('the body survives the pipe', () => {
    it('takes every field the DTO documents, not a stripped subset', async () => {
      const res = await http().put(url).send(plan()).expect(200);

      expect(res.body).toMatchObject({
        period: '2026',
        mode: 'direct',
        annualApeTargetMinor: 500_000_000_00,
        caseSizeMinor: 18_000_000_00,
        leadsToApptPct: 30,
      });
    });

    it('refuses a field nobody defined, rather than dropping it', async () => {
      const res = await http().put(url).send({ ...plan(), snapshot: { policiesPerMonth: 6 } })
        .expect(400);

      expect(JSON.stringify(res.body)).toMatch(/snapshot/);
    });

    it('takes a decimal rate over the wire, which the prototype cannot (I-108)', async () => {
      const res = await http().put(url)
        .send(plan({ mode: 'from_savings', commissionRatePct: 12.5 })).expect(200);

      expect(res.body.commissionRatePct).toBe(12.5);
      // 50,000,000 / 0.125 = 400,000,000 — not the 40,000,000 a stripped `125` would give.
      expect(res.body.projected.annualApeTargetMinor).toBe(400_000_000_00);
    });
  });

  describe('the period is the path', () => {
    it('ignores a body that disagrees with it', async () => {
      // Two sources for one key is one source too many.
      const res = await http().put('/goals/2027').send(plan({ period: '2099' })).expect(200);

      expect(res.body.period).toBe('2027');
    });

    it('refuses a path that is not a calendar year', async () => {
      await http().put('/goals/2026-Q1').send(plan()).expect(400);
    });
  });

  describe('reading', () => {
    it('answers the office’s defaults when there is no goal, rather than a 404', async () => {
      // A first-time reader opens on five filled cards. A cascade with nothing in it teaches
      // nobody what the screen is for.
      const res = await http().get(url).expect(200);

      expect(res.body.savedAt).toBeNull();
      expect(res.body.annualApeTargetMinor).toBe(500_000_000_00);
      expect(res.body.projected.leadsPerMonth).toBeGreaterThan(0);
      // P10-T9: the measured line, with not enough data sent as null rather than dropped or zeroed.
      expect(res.body.measured).toMatchObject({ days: 30, leadToAppointmentRate: null, closingRate: null });
      expect(res.body.measured).toHaveProperty('closingRate', null);
    });

    it('answers the goal once there is one, with both halves', async () => {
      await http().put(url).send(plan()).expect(200);

      const res = await http().get(url).expect(200);

      expect(res.body.snapshot.leadsPerMonth).toBe(67);
      expect(res.body.projected.leadsPerMonth).toBe(67);
      expect(res.body.savedByMembershipId).toBe('mem-a');
    });
  });

  /*
   * **`for` is validated as every query field is** (P11-T7; `functional/coaching.md`, the Data contract):
   * it was a raw `@Query('for')`, the one subject parameter the pipe never saw. And a plan read for
   * somebody else carries no measured rates (AC-10, D-rates).
   */
  describe('whose plan: for (P11-T7)', () => {
    const SUBJECT = '66f0000000000000000000d1';

    beforeEach(async () => {
      await mongoose.connection.db!.collection('memberships').insertOne({
        _id: new mongoose.Types.ObjectId(SUBJECT), kpmId: FIXTURE_KPM, userId: 'u-subject', leaderCode: 'LC-D1',
        orgLevelCode: 'AGENT', hierarchyRole: 'agent', leaderId: 'mem-a', ancestorIds: ['mem-a'],
        status: 'active', deletedAt: null,
      } as never);
    });

    it('P11-T7 AC-10 the caller’s own plan, named or not, keeps their measured rates', async () => {
      const absent = await http().get(url).expect(200);
      const named = await http().get(url).query({ for: 'mem-a' }).expect(200);

      expect(named.body).toEqual(absent.body);
      expect(named.body.measured).toMatchObject({ days: 30 });
    });

    it('P11-T7 AC-10 somebody else’s plan answers measured: null, a leader’s read and the Owner’s alike', async () => {
      for (const who of [AB, OWNER]) {
        session.current = who;
        const res = await http().get(url).query({ for: SUBJECT }).expect(200);
        expect(res.body).toHaveProperty('measured', null);
        expect(res.body.annualApeTargetMinor).toBe(500_000_000_00);
      }
    });

    it('P11-T7 any other query parameter is refused by name', async () => {
      const res = await http().get(url).query({ membershipId: SUBJECT }).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('membershipId')]));
    });

    it('P19.9-T6 AC-2 an Agent who leads them reads their plan — the coaching Goal Setting tab (ADR-0234)', async () => {
      // SUBJECT reports to `mem-a`, and the session is `mem-a` on the Agent rung: an upline, who coaches.
      const res = await http().get(url).query({ for: SUBJECT }).expect(200);
      expect(res.body).toHaveProperty('measured', null);
    });

    it('P11-T7 for is a string of at most 64 characters', async () => {
      const long = await http().get(url).query({ for: 'a'.repeat(65) }).expect(400);
      expect(long.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('for')]));
      await http().get(`${url}?for=${SUBJECT}&for=mem-a`).expect(400);
    });

    it('P11-T7 an Agent naming anybody else is not found, as is an id that is nobody’s', async () => {
      // An Agent who stands above nobody here: `mem-a`, the shared fixture's Agent, is SUBJECT's leader (below).
      session.current = AGENT_ELSEWHERE;
      expect((await http().get(url).query({ for: SUBJECT }).expect(404)).body.error.code).toBe('NOT_FOUND');
      session.current = AB;
      await http().get(url).query({ for: new mongoose.Types.ObjectId().toString() }).expect(404);
    });
  });

  /*
   * **The preview over HTTP** (P18.11-T5, UI V1 UI-014): the body a save takes, a read's `for`, a 200 that writes
   * nothing. Its reach and the cross-office 404 are `goal-access.tenancy.spec.ts`'.
   */
  describe('P18.11-T5 UI-014 the preview', () => {
    const preview = `${url}/preview`;

    it('P18.11-T5 UI-014 works out what the inputs would make, as a save would, and writes nothing', async () => {
      const res = await http().post(preview).send(plan()).expect(200);

      expect(res.body).toMatchObject({
        period: '2026', monthsLeft: 5, monthsLeftIsOverride: true,
        achieved: { minor: 0, provenance: 'self_reported', month: null },
        projected: { policiesPerMonth: 6, appointmentsPerMonth: 20, leadsPerMonth: 67, policiesPerWeek: 1.4 },
      });
      expect((await http().get(url).expect(200)).body.savedAt).toBeNull();
      // And the save stores exactly what the preview showed.
      const saved = await http().put(url).send(plan()).expect(200);
      expect(saved.body.projected).toEqual(res.body.projected);
    });

    it('P18.11-T5 UI-014 moves with an input: a case size halved doubles the policies', async () => {
      const res = await http().post(preview).send(plan({ caseSizeMinor: 9_000_000_00 })).expect(200);

      expect(res.body.projected.policiesPerMonth).toBe(12);
    });

    it('P18.11-T5 UI-014 answers an unusable assumption with projected: null, where a save answers 422', async () => {
      const res = await http().post(preview).send(plan({ caseSizeMinor: 0 })).expect(200);

      expect(res.body.projected).toBeNull();
      await http().put(url).send(plan({ caseSizeMinor: 0 })).expect(422);
    });

    it('P18.11-T5 UI-014 refuses a field that is no number, and a field nobody defined, by name', async () => {
      const shape = await http().post(preview).send(plan({ caseSizeMinor: 'many' })).expect(400);
      expect(JSON.stringify(shape.body)).toMatch(/caseSizeMinor/);
      const extra = await http().post(preview).send({ ...plan(), snapshot: { policiesPerMonth: 6 } }).expect(400);
      expect(JSON.stringify(extra.body)).toMatch(/snapshot/);
      await http().post('/goals/2026-Q1/preview').send(plan()).expect(400);
    });

    it('P18.11-T5 UI-014 takes a read’s for, and an Agent naming anybody else is not found', async () => {
      const SUBJECT = '66f0000000000000000000d2';
      await mongoose.connection.db!.collection('memberships').insertOne({
        _id: new mongoose.Types.ObjectId(SUBJECT), kpmId: FIXTURE_KPM, userId: 'u-subject', leaderCode: 'LC-D2',
        orgLevelCode: 'AGENT', hierarchyRole: 'agent', leaderId: 'mem-a', ancestorIds: ['mem-a'],
        status: 'active', deletedAt: null,
      } as never);

      session.current = AGENT_ELSEWHERE;
      expect((await http().post(preview).query({ for: SUBJECT }).send(plan()).expect(404)).body.error.code).toBe('NOT_FOUND');
      session.current = AB;
      const res = await http().post(preview).query({ for: SUBJECT }).send(plan({ apeAchievedMinor: 400_000_000_00 }))
        .expect(200);
      // ADR-0183: with no figure held for the member, the leader's typed one is what the plan is measured against —
      // and it would be theirs (S2): `mem-a`, whom this spec's office holds no membership row to name.
      expect(res.body.achieved).toEqual({
        minor: 400_000_000_00, provenance: 'self_reported', month: null, typedBy: { membershipId: 'mem-a', name: null },
      });
      await http().post(preview).query({ membershipId: SUBJECT }).send(plan()).expect(400);
    });

    it.each(EVERY_MEMBER)('P18.11-T5 UI-014 lets %s preview their own plan', async (_name, who) => {
      session.current = who;
      await http().post(preview).send(plan()).expect(200);
    });

    it('L4 a read-only support session previews, as it reads: it writes nothing — and the save stays refused', async () => {
      session.current = new RequestContext(AGENT.userId, 'none', AGENT.membership, 'u-support', null, false, true);

      const res = await http().post(preview).send(plan()).expect(200);

      expect(res.body.projected).not.toBeNull();
      expect((await http().put(url).send(plan()).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await mongoose.connection.db!.collection('goals').countDocuments({})).toBe(0);
    });

    it('P18.11-T5 UI-014 refuses a Super Admin by name, as the read does', async () => {
      session.current = SUPER_ADMIN;
      const res = await http().post(preview).send(plan()).expect(403);

      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });
  });

  describe('a period that has ended (P8-T6)', () => {
    it('refuses a write to last year with a code a client can branch on', async () => {
      const res = await http().put('/goals/2025').send(plan()).expect(409);

      expect(res.body.error.code).toBe('GOAL_PERIOD_LOCKED');
      expect(res.body.error.details).toMatchObject({ period: '2025', currentPeriod: '2026' });
    });

    it('still reads last year’s plan, because it is history rather than forbidden', async () => {
      await http().get('/goals/2025').expect(200);
    });

    it('takes a write to next year, which is planning ahead rather than rewriting', async () => {
      await http().put('/goals/2027').send(plan()).expect(200);
    });
  });

  describe('every plan agreed for a period — retired (P10.1-T6 AC-10)', () => {
    it('answers 404: the prototype draws no goal history, so no screen reads one', async () => {
      await http().put(url).send(plan({ annualApeTargetMinor: 300_000_000_00 })).expect(200);
      await http().put(url).send(plan({ annualApeTargetMinor: 500_000_000_00 })).expect(200);

      await http().get(`${url}/history`).expect(404);
      // The plan itself still reads; its stored versions are pinned in goal.tenancy.spec.ts (ADR-0042).
      expect((await http().get(url).expect(200)).body.annualApeTargetMinor).toBe(500_000_000_00);
    });
  });

  describe('an assumption that cannot make a plan', () => {
    it('refuses with a code a client can branch on, and writes nothing', async () => {
      const res = await http().put(url).send(plan({ caseSizeMinor: 0 })).expect(422);

      expect(res.body.error.code).toBe('GOAL_INVALID_ASSUMPTION');
      expect(res.body.error.details.violations).toHaveLength(1);
      expect((await http().get(url).expect(200)).body.savedAt).toBeNull();
    });

    it('refuses a conversion rate above a hundred', async () => {
      const res = await http().put(url).send(plan({ closingRatePct: 101 })).expect(422);

      expect(res.body.error.code).toBe('GOAL_INVALID_ASSUMPTION');
    });
  });

  /*
   * **The same refusals in Indonesian** (P18.10-T5 AC-7): the request's `Accept-Language` decides the words. Goal
   * Settings' own labels — *Closing rate* — stay English in both (glossary §A.4), and a figure is written the reader's
   * way: *12,5*.
   */
  describe('P18.10-T5 AC-7 in Indonesian', () => {
    it('P18.10-T5 AC-7 refuses a period that has ended in Indonesian, its details unchanged', async () => {
      const res = await http().put('/goals/2025').set('Accept-Language', 'id').send(plan()).expect(409);

      expect(res.body.error).toMatchObject({
        code: 'GOAL_PERIOD_LOCKED',
        message: '2025 sudah berakhir. Rencananya adalah yang disepakati saat itu dan tetap seperti semula; '
          + 'buat rencana untuk 2026 sebagai gantinya.',
        details: { period: '2025', currentPeriod: '2026' },
      });
    });

    it('P18.10-T5 AC-7 says every assumption that cannot make a plan in Indonesian, one after another', async () => {
      const res = await http().put(url).set('Accept-Language', 'id')
        .send(plan({ caseSizeMinor: 0, closingRatePct: 101 })).expect(422);

      const violations = [
        'Average case size harus di atas nol: itulah nilai satu polis.',
        'Closing rate harus di atas 0 dan paling tinggi 100 persen.',
      ];
      expect(res.body.error).toMatchObject({ code: 'GOAL_INVALID_ASSUMPTION', message: violations.join(' '), details: { violations } });
    });

    it('P18.10-T5 AC-7 refuses a goal’s own fields in Indonesian, a figure in Indonesian figures', async () => {
      const res = await http().put(url).set('Accept-Language', 'id')
        .send(plan({ caseSizeMinor: 1_000.5, commissionRatePct: -1 })).expect(400);

      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { violations: [
          'caseSizeMinor dalam satuan sen IDR dan harus berupa bilangan bulat.',
          'commissionRatePct harus berupa persentase, ditulis sebagai angka seperti 30 atau 12,5.',
        ] },
      });
    });
  });

  describe('P19.1-T4 the member’s own estimate: PUT /goals/:period/ape-estimate (UI-157 item 4; ADR-0195)', () => {
    const estimateUrl = '/goals/2026/ape-estimate';

    it.each(EVERY_MEMBER)('P19.1-T4 AC-10 positive: %s writes the estimate on their own plan, and reads it back', async (_name, who) => {
      session.current = who;
      await http().put(url).send(plan()).expect(200);
      const res = await http().put(estimateUrl).send({ apeAchievedMinor: 120_000_000_00 }).expect(200);
      expect(res.body).toMatchObject({
        apeAchievedMinor: 120_000_000_00,
        achieved: { minor: 120_000_000_00, provenance: 'self_reported', month: null },
        projected: { remainingApeMinor: 380_000_000_00 },
      });
      expect((await http().get(url).expect(200)).body.apeAchievedMinor).toBe(120_000_000_00);
      // *Hapus*: null clears it, as 0 does.
      expect((await http().put(estimateUrl).send({ apeAchievedMinor: null }).expect(200)).body.apeAchievedMinor).toBe(0);
      expect((await http().put(estimateUrl).send({ apeAchievedMinor: 0 }).expect(200)).body.apeAchievedMinor).toBe(0);
    });

    it('P19.1-T4 AC-13 negative: a Super Admin holds no goal:update, and is refused by the guard', async () => {
      session.current = SUPER_ADMIN;
      const res = await http().put(estimateUrl).send({ apeAchievedMinor: 1 }).expect(403);
      expect(res.body.error.details).toEqual({ permission: 'goal:update' });
    });

    it('P19.1-T4 AC-13 a plan nobody saved is not found: there is no target to estimate against', async () => {
      await http().put(estimateUrl).send({ apeAchievedMinor: 120_000_000_00 }).expect(404);
    });

    it('P19.1-T4 AC-13 refuses a fraction of a sen, a negative figure, a missing one and a field nobody defined', async () => {
      await http().put(url).send(plan()).expect(200);
      for (const body of [{ apeAchievedMinor: 1.5 }, { apeAchievedMinor: -1 }, {}, { apeAchievedMinor: 1, for: 'x' }]) {
        const res = await http().put(estimateUrl).send(body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('P19.1-T4 AC-13 a year that has ended is not estimated for: GOAL_PERIOD_LOCKED', async () => {
      await mongoose.connection.db!.collection('goals').insertOne({
        kpmId: FIXTURE_KPM, membershipId: AGENT.membershipId, period: '2025', mode: 'direct', annualApeTargetMinor: 1,
        savingsTargetMinor: 0, commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 1,
        leadsToApptPct: 30, closingRatePct: 30, version: 1, savedAt: NOW, deletedAt: null,
      });
      const res = await http().put('/goals/2025/ape-estimate').send({ apeAchievedMinor: 1 }).expect(409);
      expect(res.body.error.code).toBe('GOAL_PERIOD_LOCKED');
    });
  });

  describe('who may do what (§3.6)', () => {
    it.each(EVERY_MEMBER)('lets %s keep their own goal', async (_name, who) => {
      session.current = who;
      await http().put(url).send(plan()).expect(200);
      await http().get(url).expect(200);
    });

    it('refuses a Super Admin the write, which §3.6 grants them nowhere', async () => {
      session.current = SUPER_ADMIN;
      await http().put(url).send(plan()).expect(403);
    });

    it('refuses a Super Admin the read by name rather than by a 500', async () => {
      /*
       * §3.6 grants them `all` on `goal:read`, and ADR-0044's reasoning applies: the route
       * resolves `kpmId` from the caller's membership, which they have none of. The guard passes
       * and the service refuses cleanly.
       */
      session.current = SUPER_ADMIN;
      const res = await http().get(url).expect(403);

      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });
  });
});
