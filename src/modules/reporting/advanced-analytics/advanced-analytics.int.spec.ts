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
} from '../../../../test/http-permissions';
import { listenOnLoopback } from '../../../../test/listen';
import { AdminAdvancedAnalyticsController, AdvancedAnalyticsController } from './advanced-analytics.controller';
import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { AdminAdvancedAnalytics } from './admin-advanced-analytics.service';

const HEAD = '66f0000000000000000000e1';
const KPM = '66f0000000000000000000a1';

/** A view-as session, read-only, as `ContextResolver` builds every one (ADR-0206 §4). */
const viewAs = (ctx: RequestContext) => new RequestContext(ctx.userId, 'none', ctx.membership, 'u-super', null, false, true);

/**
 * **The *Advanced analytics* routes over HTTP** (P19.5-T3 AC-1, AC-12, AC-13; ADR-0215 §2, §9; roles §3.9): who the API
 * lets through, per role, both ways, and what it refuses before any service runs — a malformed parameter, a view-as
 * session's write. What the services answer on real rows is `advanced-analytics.tenancy.spec.ts`'s.
 */
describe('P19.5-T3 the Advanced analytics routes — who may call them', () => {
  let app: INestApplication;
  const page = {
    shell: jest.fn(async () => ({ sections: [] })),
    demographics: jest.fn(async () => ({ manpower: 0 })),
    mapa: jest.fn(async () => ({ rows: [] })),
    quantView: jest.fn(async () => ({ metrics: [] })),
    subgroup: jest.fn(async () => ({ groups: [] })),
    subgroupPeople: jest.fn(async () => ({ driver: 'maa' })),
    eventsNps: jest.fn(async () => ({ events: [] })),
    demographicsFile: jest.fn(async () => ({ filename: 'x.csv', file: '' })),
    uploadDemographics: jest.fn(async () => ({ updated: 0, unchanged: 0, skipped: 0, rows: [] })),
  };
  const admin = { read: jest.fn(async () => ({ sections: [] })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdvancedAnalyticsController, AdminAdvancedAnalyticsController],
      providers: [
        { provide: AdvancedAnalyticsService, useValue: page },
        { provide: AdminAdvancedAnalytics, useValue: admin },
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
    for (const fn of [...Object.values(page), ...Object.values(admin)]) fn.mockClear();
  });

  const http = () => request(app.getHttpServer());
  const AB_ID = '66f0000000000000000000b1';
  const READS = ['', '/demographics', '/mapa', '/quant', '/subgroup', `/subgroup/people?ab=${AB_ID}&driver=maa`, '/events'];

  it('P19.5-T3 AC-13 each route declares its grant: the reads advanced_analytics:read, the targets :write, the tab platform_kpm_figures:read', () => {
    expect(declaredPermissions(AdvancedAnalyticsController)).toEqual({
      shell: 'advanced_analytics:read', demographics: 'advanced_analytics:read', mapa: 'advanced_analytics:read',
      quant: 'advanced_analytics:read', subgroup: 'advanced_analytics:read', events: 'advanced_analytics:read',
      // P19.22 (ADR-0275): the sheets are reads; Demografi's list and upload the stewards' writes. The typed MAPA target is gone.
      subgroupPeople: 'advanced_analytics:read',
      demographicsFile: 'advanced_analytics:write', uploadDemographics: 'advanced_analytics:write',
    });
    expect(declaredPermissions(AdminAdvancedAnalyticsController)).toEqual({
      shell: 'platform_kpm_figures:read', section: 'platform_kpm_figures:read',
    });
  });

  describe('the reads — the Owner, the Admins, an AB and an AAB through the guard; an Agent and the Super Admin refused', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB]])(
      'P19.5-T3 AC-1 AC-13 %s reaches every read (a leader not tagged Core Leader is then 404 by the service)', async (_who, ctx) => {
        session.current = ctx;
        for (const path of READS) await http().get(`/kpm/advanced-analytics${path}`).expect(200);
        expect(page.shell).toHaveBeenCalledTimes(1);
        expect(page.eventsNps).toHaveBeenCalledTimes(1);
      },
    );

    it.each([['an Agent', AGENT], ['the Super Admin', SUPER_ADMIN]])(
      'P19.5-T3 AC-1 AC-13 %s holds no advanced_analytics:read: 403, nothing runs', async (_who, ctx) => {
        session.current = ctx;
        for (const path of READS) {
          const { body } = await http().get(`/kpm/advanced-analytics${path}`).expect(403);
          expect(body.error.code).toBe('PERM_DENIED');
        }
        expect(page.shell).not.toHaveBeenCalled();
      },
    );

    it('P19.5-T3 AC-13 a malformed parameter is 400 by name before any service runs', async () => {
      session.current = OWNER;
      for (const path of [
        '/demographics?month=2026-13', '/mapa?year=2026', '/mapa?month=26', '/quant?periodEnd=2026-05', '/events?month=nov', '?section=x',
        '/subgroup?month=2026-1', '/subgroup?ab=x', `/subgroup/people?ab=${AB_ID}`, `/subgroup/people?ab=${AB_ID}&driver=apa`,
        '/subgroup/people?driver=maa',
      ]) {
        const { body } = await http().get(`/kpm/advanced-analytics${path}`).expect(400);
        expect(body.error.code).toBe('VALIDATION_FAILED');
      }
      expect(page.demographics).not.toHaveBeenCalled();
      expect(page.quantView).not.toHaveBeenCalled();
    });

    it('ADR-0206 a view-as session reads the page', async () => {
      session.current = viewAs(OWNER);
      for (const path of READS) await http().get(`/kpm/advanced-analytics${path}`).expect(200);
    });
  });

  describe('P19.22-T2 Demografi’s list and upload — the stewards; everyone else refused, a view-as session too', () => {
    const FILE = { file: 'Kode agen,Status kerja\nPRU-1,Full-time\n' };

    it.each([['the Owner', OWNER], ['an Admin', ADMIN]])('P19.22-T2 AC-1 %s downloads the list and uploads it', async (_who, ctx) => {
      session.current = ctx;
      await http().get('/kpm/advanced-analytics/demographics/file').expect(200);
      await http().post('/kpm/advanced-analytics/demographics/upload').send(FILE).expect(200);
      expect(page.uploadDemographics).toHaveBeenCalledWith(expect.anything(), FILE);
    });

    it('P19.17-T4 P19.22-T3 the yearly sub-group target and the typed MAPA target are gone (404)', async () => {
      session.current = OWNER;
      await http().put(`/kpm/advanced-analytics/targets/subgroup/${HEAD}`).send({ aaTarget: 4, recTarget: 8 }).expect(404);
      await http().put('/kpm/advanced-analytics/targets/mapa').send({ month: '2026-11', row: 'ape', value: 1 }).expect(404);
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT], ['the Super Admin outside a KPM', SUPER_ADMIN]])(
      'P19.22-T2 AC-1 %s holds no advanced_analytics:write: 403, nothing runs', async (_who, ctx) => {
        session.current = ctx;
        expect((await http().post('/kpm/advanced-analytics/demographics/upload').send(FILE).expect(403)).body.error.code).toBe('PERM_DENIED');
        expect((await http().get('/kpm/advanced-analytics/demographics/file').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect(page.uploadDemographics).not.toHaveBeenCalled();
      },
    );

    it('P19.22-T2 AC-1 a view-as session is refused the upload: IMPERSONATION_READ_ONLY', async () => {
      session.current = viewAs(OWNER);
      expect((await http().post('/kpm/advanced-analytics/demographics/upload').send(FILE).expect(403)).body.error.code)
        .toBe('IMPERSONATION_READ_ONLY');
      expect(page.uploadDemographics).not.toHaveBeenCalled();
    });

    it('P19.22-T2 AC-1 the body is checked: no file, a file that is no text, an unknown field', async () => {
      session.current = OWNER;
      for (const body of [{}, { file: 42 }, { ...FILE, extra: 1 }, { file: 'x'.repeat(90_001) }]) {
        expect((await http().post('/kpm/advanced-analytics/demographics/upload').send(body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      }
      expect(page.uploadDemographics).not.toHaveBeenCalled();
    });
  });

  describe('the Super Admin’s tab (AC-12)', () => {
    it('P19.5-T3 AC-12 the Super Admin reads the shell and a section', async () => {
      session.current = SUPER_ADMIN;
      await http().get(`/admin/tenants/${KPM}/advanced-analytics`).expect(200);
      await http().get(`/admin/tenants/${KPM}/advanced-analytics/quant?periodEnd=2026-06`).expect(200);
      expect(admin.read).toHaveBeenCalledWith(expect.anything(), KPM, 'shell', {});
      expect(admin.read).toHaveBeenCalledWith(expect.anything(), KPM, 'quant', { periodEnd: '2026-06' });
    });

    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an Agent', AGENT], ['a view-as session', viewAs(OWNER)]])(
      'P19.5-T3 AC-12 %s holds no platform_kpm_figures:read: 403, nothing runs', async (_who, ctx) => {
        session.current = ctx;
        await http().get(`/admin/tenants/${KPM}/advanced-analytics`).expect(403);
        await http().get(`/admin/tenants/${KPM}/advanced-analytics/nps`).expect(403);
        expect(admin.read).not.toHaveBeenCalled();
      },
    );

    it('P19.5-T3 AC-12 an unknown parameter is refused by name', async () => {
      session.current = SUPER_ADMIN;
      await http().get(`/admin/tenants/${KPM}/advanced-analytics/mapa?member=x`).expect(400);
      await http().get(`/admin/tenants/${KPM}/advanced-analytics/mapa?year=2026`).expect(400);
      await http().get(`/admin/tenants/${KPM}/advanced-analytics?section=mapa`).expect(400);
      expect(admin.read).not.toHaveBeenCalled();
    });
  });
});
