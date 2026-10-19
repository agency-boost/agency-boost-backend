import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import * as metricsModule from '@/domain/constants/metrics';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, NOT_ADMINISTRATORS, OWNER, ADMIN, AB, AAB, AGENT,
  productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignStandingOverrides } from './campaign-standing-overrides';
import { MetricRegistryController } from './metric-registry.controller';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-18T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  // P18.5-T7 (leak 15): the settings reads are the Owner's and the Admins', as training's and events' are.
  listRules: 'campaign_settings:read',
  list: 'campaign_settings:read',
  create: 'tenant_config:write',
  update: 'tenant_config:write',
  archive: 'tenant_config:write',
  restore: 'tenant_config:write',
  // P18.6-T2 AC-5: the override of a final standing (its own spec: `campaign-standing-overrides.int.spec.ts`).
  override: 'campaign_qualification:override',
  clearOverride: 'campaign_qualification:override',
};

const aCampaign = (over: Record<string, unknown> = {}) => ({
  code: 'YEAR_END_DRIVE',
  title: 'Year-End Star Club Drive',
  // Whole office months (P18.5-T7, D-windows): 00:00 on 1 October to 23:59 on 31 December, Jakarta.
  startsAt: '2026-09-30T17:00:00Z',
  endsAt: '2026-12-31T16:59:59Z',
  reward: 'Extra unit budget',
  requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 500_000_000 * 100 }],
  ...over,
});

/**
 * An office's campaigns, and the metric registry beside them, over HTTP (P5-T7, P5-T9).
 *
 * Neither controller was called by any test. `metric-registry.controller.ts` was the starkest
 * case in the phase — a single route, and nothing in the backend ever invoked its handler — while
 * `SaveCampaignDto` carried only Swagger decorators, so the global pipe stripped every field of
 * every create and update and the routes could not succeed at all. Both are the same gap: the
 * suite tested services, and a service does not have a pipe or a decorator.
 */
describe('campaigns and the metric registry over HTTP (P5-T7, P5-T9)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = '/kpm/settings/campaigns';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [CampaignController, MetricRegistryController],
      providers: [
        { provide: CampaignService, useValue: wired.campaigns },
        { provide: CampaignStandingOverrides, useValue: wired.campaignStandingOverrides },
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
    session.current = OWNER;
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: PRUDENTIAL, code: '0417', branchName: 'A',
      timezone: 'Asia/Jakarta',
    });
    await wired.campaigns.seedForCompany(PRUDENTIAL);
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(CampaignController)).toEqual(ROUTES);
    expect(declaredPermissions(MetricRegistryController)).toEqual({
      list: 'metric_registry:read',
    });
  });

  describe('the campaigns an office runs', () => {
    it.each([['the Owner', OWNER], ['the Admin', ADMIN]])(
      'lets %s create one, and the unit comes from the registry', async (_name, who) => {
        session.current = who;

        const res = await request(app.getHttpServer()).post(url).send(aCampaign()).expect(201);

        expect(res.body).toMatchObject({ code: 'YEAR_END_DRIVE' });
        // Never from the caller: a client sending its own could label sen as rupiah.
        expect(res.body.requirements[0]).toMatchObject({
          metricKey: 'APE_ACHIEVED', unit: 'idr_minor',
        });
      },
    );

    it.each(NOT_ADMINISTRATORS)('refuses %s every write', async (_name, who) => {
      session.current = who;
      const server = app.getHttpServer();

      await request(server).post(url).send(aCampaign()).expect(403);
      await request(server).patch(`${url}/whatever`).send({ title: 'X' }).expect(403);
      await request(server).post(`${url}/whatever/archive`).send({}).expect(403);
      await request(server).post(`${url}/whatever/restore`).send({}).expect(403);
    });

    it.each([['the Owner', OWNER], ['the Admin', ADMIN]])('P18.5-T7 shows %s the campaigns and the carrier rules', async (_name, who) => {
      session.current = who;

      await request(app.getHttpServer()).get(url).expect(200);
      const rules = await request(app.getHttpServer()).get(`${url}/rules`).expect(200);

      expect(rules.body.length).toBeGreaterThan(0);
    });

    /*
     * P18.5-T7, the phase file's *Found while preparing* 15: both reads sat on `tenant_config:read`, which every member
     * holds, so a field member could read archived campaigns and the requirements of drafts. A member reads campaigns
     * at `GET /campaigns`, active ones only.
     */
    it('P18.5-T8 review item 20 refuses a Super Admin outside a support session both settings reads: no office', async () => {
      session.current = SUPER_ADMIN;
      for (const path of [url, `${url}/rules`]) {
        expect((await request(app.getHttpServer()).get(path).expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      }
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]])(
      'P18.5-T7 refuses %s the campaigns settings and the carrier rules (leak 15)', async (_name, who) => {
        session.current = who;

        for (const path of [url, `${url}?includeArchived=true`, `${url}/rules`]) {
          const res = await request(app.getHttpServer()).get(path).expect(403);
          expect(res.body.error.code).toBe('PERM_DENIED');
        }
      },
    );

    it('keeps `rules` a literal rather than a campaign id', async () => {
      await request(app.getHttpServer()).post(url).send(aCampaign({ code: 'RULES' })).expect(201);

      const rules = await request(app.getHttpServer()).get(`${url}/rules`).expect(200);

      expect(rules.body.every((r: { kind?: string }) => r.kind !== undefined)).toBe(true);
    });

    it('refuses a metric the product does not measure, naming it', async () => {
      const res = await request(app.getHttpServer()).post(url).send(aCampaign({
        // `NET_APE` was the example until Phase 18 registered it (D-registry); FLC's count is not one (OD-26).
        requirements: [{ metricKey: 'FLC_COUNT', comparator: 'gte', value: 100 }],
      })).expect(400);

      expect(res.body.error.message).toMatch(/FLC_COUNT/);
    });

    it('refuses a body carrying a field the DTO never declared', async () => {
      /*
       * The pipe only refuses it because every declared property carries `@Allow()`. Without
       * those the whole body was stripped instead, and the route answered *"property code should
       * not exist"* for fields it does declare — which is how creating a campaign shipped broken.
       */
      const res = await request(app.getHttpServer()).post(url)
        .send(aCampaign({ status: 'active' })).expect(400);

      expect(res.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('status')]));
    });
  });

  describe('every route answers, not just the ones a role test reaches', () => {
    it('edits a campaign, archives it and brings it back', async () => {
      const made = await request(app.getHttpServer()).post(url).send(aCampaign()).expect(201);

      const edited = await request(app.getHttpServer())
        .patch(`${url}/${made.body.id}`).send({ reward: 'A trip' }).expect(200);
      expect(edited.body.reward).toBe('A trip');

      await request(app.getHttpServer()).post(`${url}/${made.body.id}/archive`).send({})
        .expect(201);
      expect((await request(app.getHttpServer()).get(url).expect(200)).body).toHaveLength(0);

      const restored = await request(app.getHttpServer())
        .post(`${url}/${made.body.id}/restore`).send({}).expect(201);
      expect(restored.body.status).toBe('active');
    });
  });

  describe('the metric registry', () => {
    // One test below moves `CAMPAIGN_EVALUATION_PHASE` with `replaceProperty`; this puts it back.
    afterEach(() => jest.restoreAllMocks());

    it('answers every member of the office, and the platform', async () => {
      for (const who of [...EVERY_MEMBER.map(([, w]) => w), SUPER_ADMIN]) {
        session.current = who;

        const res = await request(app.getHttpServer()).get('/metrics').expect(200);

        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body[0]).toMatchObject({
          key: expect.any(String), name: expect.any(String), unit: expect.any(String),
          phase: expect.any(Number), computed: expect.any(Boolean),
        });
      }
    });

    it('says which metrics nothing computes yet, rather than implying they all do', async () => {
      session.current = AGENT;
      type Served = { key: string; computed: boolean };

      // Since the 2026-10-08 re-plan campaigns are evaluated in 18.5, after every metric registered
      // today, so every one answers `computed: true` (`registry.spec.ts` pins the set by key).
      const today = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(today.body.filter((m: Served) => !m.computed)).toEqual([]);

      // ADR-0035: a rule naming a metric whose phase has not shipped is recorded as waiting on
      // it. A screen can only say so if the wire carries the distinction, so it is proven with the
      // evaluation placed before the latest metrics, as it stood for a metric registered later.
      jest.replaceProperty(metricsModule as { CAMPAIGN_EVALUATION_PHASE: number }, 'CAMPAIGN_EVALUATION_PHASE', 18);
      const res = await request(app.getHttpServer()).get('/metrics').expect(200);
      // The two event metrics are 18.5's since P18-T0 (D-registry), so they wait with the other three.
      // P18.5-T8 registers *New Hire* at 18.5 (OD-152), so it waits with them.
      expect(res.body.filter((m: Served) => !m.computed).map((m: Served) => m.key).sort()).toEqual([
        'CAMPAIGN_QUALIFICATION_STATUS', 'EVENT_ATTENDANCE_RATE', 'EVENT_ATTENDANCE_STATUS', 'EVENT_NPS', 'NEW_HIRES',
        'TRAINING_COMPLETION_PCT',
      ]);
    });

    it('P18.5-T8 AC-1 serves the `campaign` flag on exactly the evaluable set, beside every requirable metric', async () => {
      session.current = OWNER;
      type Served = { key: string; campaign: boolean };
      const res = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(res.body.every((m: Served) => typeof m.campaign === 'boolean')).toBe(true);
      expect(res.body.filter((m: Served) => m.campaign).map((m: Served) => m.key).sort())
        .toEqual(metricsModule.CAMPAIGN_METRICS.map((m) => m.key).sort());
      // The carrier rules' list is unchanged: every requirable metric is still served.
      expect(res.body).toHaveLength(metricsModule.REQUIREMENT_METRICS.length);
      expect(res.body.find((m: Served) => m.key === 'TRAINING_COMPLETION_PCT')).toMatchObject({ campaign: false });
    });

    it('P18.5-T8 AC-1 refuses a requirement outside the evaluable set over HTTP, naming it', async () => {
      session.current = OWNER;
      const res = await request(app.getHttpServer()).post('/kpm/settings/campaigns').send(aCampaign({
        requirements: [{ metricKey: 'TRAINING_COMPLETION_PCT', comparator: 'gte', value: 80 }],
      })).expect(400);
      expect(res.body.error.message).toMatch(/Training completion is not something a campaign can measure/);
    });
  });
});
