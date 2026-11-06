import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { CoachingSurveyController } from './coaching-survey.controller';
import { CoachingSurveyService } from './coaching-survey.service';
import { SurveyRunsController } from './survey-runs.controller';
import { SurveyRunsService } from './survey-runs.service';
import { SurveysController } from './surveys.controller';
import { SurveysService } from './surveys.service';

const RUN = '66f0000000000000000000d1';
const PERSON = '66f0000000000000000000e1';

/** A view-as session, read-only, as `ContextResolver` builds every one (ADR-0206 §4). */
const viewAs = (ctx: RequestContext) =>
  new RequestContext(ctx.userId, 'none', ctx.membership, 'u-super', null, false, true);

/**
 * **The survey routes over HTTP** (P19.5-T4; ADR-0216 §8; roles §3.8, §3.9): who the API lets through, per role, both
 * ways, before any service runs — and a view-as session refused every write. What the services answer on real rows is
 * `surveys.tenancy.spec.ts`'s.
 */
describe('P19.5-T4 the survey routes — who may call them', () => {
  let app: INestApplication;
  const member = {
    pending: jest.fn(async () => ({ today: '2026-11-05', kpmCode: '0417', open: [], sentOpen: [], popup: null })),
    list: jest.fn(async () => ({ today: '2026-11-05', open: [], history: [] })),
    form: jest.fn(async () => ({ state: 'open' })),
    answer: jest.fn(async () => ({ answeredCount: 1, totalCount: 6 })),
    submit: jest.fn(async () => ({ submittedAt: '2026-11-05T03:00:00.000Z' })),
    popupShown: jest.fn(async () => undefined),
  };
  const runs = {
    results: jest.fn(async () => ({ kind: 'nps', runs: [] })),
    create: jest.fn(async () => ({ runId: RUN })),
    update: jest.fn(async () => ({ runId: RUN })),
    cancel: jest.fn(async () => undefined),
  };
  const coaching = { read: jest.fn(async () => ({ state: 'none' })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SurveysController, SurveyRunsController, CoachingSurveyController],
      providers: [
        { provide: SurveysService, useValue: member },
        { provide: SurveyRunsService, useValue: runs },
        { provide: CoachingSurveyService, useValue: coaching },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(app.get(Reflector)), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    for (const fn of [...Object.values(member), ...Object.values(runs), ...Object.values(coaching)]) fn.mockClear();
  });

  const http = () => request(app.getHttpServer());
  const RUN_BODY = { kind: 'nps', opensOn: '2026-11-10', closesOn: '2026-11-20', invitedRoleClasses: ['agent'], anonymous: true, remindHalfway: true };

  it('P19.5-T4 each route declares its grant: the writes survey:respond, the KPM’s advanced_analytics, the tab survey_answers:read', () => {
    expect(declaredPermissions(SurveysController)).toEqual({
      pending: undefined, list: undefined, form: undefined,
      popupShown: 'survey:respond', answer: 'survey:respond', submit: 'survey:respond',
    });
    expect(declaredPermissions(SurveyRunsController)).toEqual({
      nps: 'advanced_analytics:read', qual: 'advanced_analytics:read',
      create: 'advanced_analytics:write', update: 'advanced_analytics:write', cancel: 'advanced_analytics:write',
    });
    expect(declaredPermissions(CoachingSurveyController)).toEqual({ read: 'survey_answers:read' });
  });

  describe('survey:respond — every tenant role, positive; the Super Admin, negative', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]])(
      'P19.5-T4 %s answers and sends (the service then answers only an invitee)', async (_who, ctx) => {
        session.current = ctx;
        await http().put(`/surveys/${RUN}/answers/P1`).send({ value: { score: 9 } }).expect(200);
        await http().post(`/surveys/${RUN}/submit`).expect(201);
        await http().post('/surveys/popup/shown').send({ moment: 'opened', runIds: [RUN] }).expect(204);
        expect(member.answer).toHaveBeenCalledTimes(1);
      },
    );

    it('P19.5-T4 a Super Admin holds no survey:respond: 403 PERM_DENIED, nothing runs', async () => {
      session.current = SUPER_ADMIN;
      const { body } = await http().put(`/surveys/${RUN}/answers/P1`).send({ value: { score: 9 } }).expect(403);
      expect(body.error.code).toBe('PERM_DENIED');
      expect(member.answer).not.toHaveBeenCalled();
    });

    it('ADR-0216 §3 a view-as session reads the reminder, the list and the form, and is refused every write', async () => {
      session.current = viewAs(AGENT);
      await http().get('/surveys/pending').expect(200);
      await http().get('/surveys').expect(200);
      await http().get(`/surveys/${RUN}`).expect(200);
      for (const call of [
        http().put(`/surveys/${RUN}/answers/P1`).send({ value: { score: 9 } }),
        http().post(`/surveys/${RUN}/submit`),
        http().post('/surveys/popup/shown').send({ moment: 'opened', runIds: [RUN] }),
      ]) {
        const { body } = await call.expect(403);
        expect(body.error.code).toBe('IMPERSONATION_READ_ONLY');
      }
      expect(member.answer).not.toHaveBeenCalled();
      expect(member.submit).not.toHaveBeenCalled();
    });

    it('400 VALIDATION_FAILED for an answer that is not an object, and a popup naming no run', async () => {
      session.current = AGENT;
      await http().put(`/surveys/${RUN}/answers/P1`).send({ value: 9 }).expect(400);
      await http().post('/surveys/popup/shown').send({ moment: 'opened', runIds: [] }).expect(400);
      await http().post('/surveys/popup/shown').send({ moment: 'someday', runIds: [RUN] }).expect(400);
    });
  });

  describe('advanced_analytics — the Owner’s and the Admins’ runs; the reads to a Core Leader too', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN]])('P19.5-T4 AC-1 %s starts, changes and cancels a run', async (_who, ctx) => {
      session.current = ctx;
      await http().post('/kpm/advanced-analytics/surveys/runs').send(RUN_BODY).expect(201);
      await http().patch(`/kpm/advanced-analytics/surveys/runs/${RUN}`).send({ remindHalfway: false }).expect(200);
      await http().delete(`/kpm/advanced-analytics/surveys/runs/${RUN}`).expect(204);
      await http().get('/kpm/advanced-analytics/nps').expect(200);
      await http().get('/kpm/advanced-analytics/qual').expect(200);
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an agent', AGENT], ['a Super Admin', SUPER_ADMIN]])(
      'P19.5-T4 AC-1 %s starts no run: 403 PERM_DENIED', async (_who, ctx) => {
        session.current = ctx;
        const { body } = await http().post('/kpm/advanced-analytics/surveys/runs').send(RUN_BODY).expect(403);
        expect(body.error.code).toBe('PERM_DENIED');
        expect(runs.create).not.toHaveBeenCalled();
      },
    );

    it.each([['an AB', AB], ['an AAB', AAB]])('P19.5-T4 %s passes the guard on the results (a Core Leader only; the service 404s the rest)', async (_who, ctx) => {
      session.current = ctx;
      await http().get('/kpm/advanced-analytics/nps').expect(200);
    });

    it.each([['an agent', AGENT], ['a Super Admin', SUPER_ADMIN]])('P19.5-T4 %s reads no results: 403', async (_who, ctx) => {
      session.current = ctx;
      await http().get('/kpm/advanced-analytics/qual').expect(403);
      expect(runs.results).not.toHaveBeenCalled();
    });

    it('P19.5-T4 a view-as session as the Owner reads the results and starts no run', async () => {
      session.current = viewAs(OWNER);
      await http().get('/kpm/advanced-analytics/nps').expect(200);
      const { body } = await http().post('/kpm/advanced-analytics/surveys/runs').send(RUN_BODY).expect(403);
      expect(body.error.code).toBe('IMPERSONATION_READ_ONLY');
    });

    it('AC-1 400 for dates that are not days, no role invited, or a kind that is neither', async () => {
      session.current = OWNER;
      await http().post('/kpm/advanced-analytics/surveys/runs').send({ ...RUN_BODY, opensOn: '2026-02-31' }).expect(400);
      await http().post('/kpm/advanced-analytics/surveys/runs').send({ ...RUN_BODY, invitedRoleClasses: [] }).expect(400);
      await http().post('/kpm/advanced-analytics/surveys/runs').send({ ...RUN_BODY, kind: 'pulse' }).expect(400);
      await http().get('/kpm/advanced-analytics/nps?runId=nope').expect(400);
      expect(runs.create).not.toHaveBeenCalled();
    });
  });

  describe('survey_answers:read — the coaching Survei tab', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB]])(
      'P19.5-T4 AC-16 %s passes the guard (the service checks the line and the run)', async (_who, ctx) => {
        session.current = ctx;
        await http().get(`/coaching/${PERSON}/survey`).expect(200);
      },
    );

    it.each([['an agent', AGENT], ['a Super Admin', SUPER_ADMIN]])('P19.5-T4 AC-16 %s is refused 403 before any read', async (_who, ctx) => {
      session.current = ctx;
      await http().get(`/coaching/${PERSON}/survey`).expect(403);
      expect(coaching.read).not.toHaveBeenCalled();
    });
  });
});
