import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, NO_CLASS, OWNER, SUPER_ADMIN, declaredPermissions, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { ActivityBindingAdminController, ActivityBindingReadController } from './activity-binding.controller';
import { ActivityBindingService } from './activity-binding.service';
import { ActivityConfigService } from './activity.service';
import { ConfigChangeService } from './changes.service';
import { LeadStatusService } from './lead-status.service';
import { RatioService } from './ratio.service';
import { TenantConfigService } from './tenant-config.service';
import { TenantConfigController } from './config.controller';
import { TenantService } from '@/modules/tenants/tenant.service';

const NOW = new Date('2026-10-26T03:00:00Z');
const OTHER_KPM = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const TODAY = { leads: ['LEADS_CONTACTED'], appointments: ['SELL_PRESENTATION'], closings: ['SELL_SUBMISSION'] };

/** An Owner or Admin with no field rung of their own, as `NO_CLASS` says (ADR-0156). */
const office = (over: Record<string, unknown>) => new RequestContext(`u-${String(over.membershipId)}`, 'none', {
  membershipId: 'mem-x', kpmId: FIXTURE_KPM, orgLevelCode: null, hierarchyRole: NO_CLASS, status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
} as never);
const OWNER_A = office({ membershipId: 'mem-owner-a', isKpmOwner: true });
const ADMIN_A = office({ membershipId: 'mem-admin-a', isKpmAdmin: true });
const OWNER_B = office({ membershipId: 'mem-owner-b', kpmId: OTHER_KPM, isKpmOwner: true });

/**
 * **An office's activity binding over HTTP** (P18.9-T2 AC-3, AC-4), behind the real `PermissionsGuard` and the
 * production pipe: the Super Admin's read and write per office, the Owner's and the Admin's read of their own, and
 * the archive of a bound type refused — positive and negative per role, and across offices.
 */
describe('the activity binding over HTTP (P18.9-T2)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const http = () => request(app.getHttpServer());
  const admin = (kpmId = FIXTURE_KPM) => `/admin/tenants/${kpmId}/activity-binding`;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [ActivityBindingAdminController, ActivityBindingReadController, TenantConfigController],
      providers: [
        { provide: ActivityBindingService, useValue: wired.activityBindings },
        { provide: ActivityConfigService, useValue: wired.activity },
        { provide: LeadStatusService, useValue: wired.leads },
        { provide: RatioService, useValue: wired.ratios },
        { provide: TenantConfigService, useValue: wired.config },
        { provide: ConfigChangeService, useValue: wired.changes },
        { provide: TenantService, useValue: {} },
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
    await clearCollections();
    session.current = SUPER_ADMIN;
    await (wired.kpms as unknown as mongoose.Model<never>).create([
      { _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: OTHER_KPM, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ] as never);
    await provisionOffice(wired, FIXTURE_KPM, COMPANY);
    await provisionOffice(wired, OTHER_KPM, COMPANY);
  });

  it('declares activity_binding:read and :write on its routes, and nothing else', () => {
    expect(declaredPermissions(ActivityBindingAdminController)).toEqual({
      read: 'activity_binding:read', update: 'activity_binding:write',
    });
    expect(declaredPermissions(ActivityBindingReadController)).toEqual({ read: 'activity_binding:read' });
  });

  describe('the Super Admin', () => {
    it('P18.9-T2 AC-3 reads one office’s binding with every type it may name, archived ones included', async () => {
      const res = await http().get(admin()).expect(200);
      expect(res.body).toMatchObject({ kpmId: FIXTURE_KPM, ...TODAY, version: 1 });
      expect(res.body.types).toHaveLength(12);
      expect(res.body.types[0]).toEqual(expect.objectContaining({ code: expect.any(String), status: 'active' }));
    });

    it('P18.9-T2 AC-3 saves [A] → [A, B] in that office alone, an archived code allowed', async () => {
      // Archive a type nothing binds, then bind it beside the old one: its history counts.
      session.current = OWNER_A;
      const types = (await http().get('/kpm/settings/activity-types?includeArchived=true').expect(200)).body
        .flatMap((c: { types: { id: string; code: string }[] }) => c.types);
      await http().delete(`/kpm/settings/activity-types/${types.find((t: { code: string }) => t.code === 'SELL_FOLLOWUP').id}`).expect(200);

      session.current = SUPER_ADMIN;
      const saved = await http().put(admin())
        .send({ ...TODAY, appointments: ['SELL_PRESENTATION', 'sell_followup'], expectedVersion: 1 }).expect(200);
      expect(saved.body).toMatchObject({ appointments: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'], version: 2 });
      expect(saved.body.types.find((t: { code: string }) => t.code === 'SELL_FOLLOWUP').status).toBe('archived');
      // The other office is not touched.
      expect((await http().get(admin(OTHER_KPM)).expect(200)).body).toMatchObject({ ...TODAY, version: 1 });
    });

    it('P18.9-T2 AC-3 refuses 400 a code not in the office, an empty role and a code in two roles', async () => {
      for (const body of [
        { ...TODAY, leads: ['NOT_A_TYPE'] },
        { ...TODAY, closings: [] },
        { ...TODAY, appointments: ['SELL_SUBMISSION'] },
        { ...TODAY, leads: 'LEADS_CONTACTED' },
      ]) {
        const res = await http().put(admin()).send(body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect((await http().get(admin()).expect(200)).body).toMatchObject({ ...TODAY, version: 1 });
    });

    it('P18.9-T2 AC-3 answers 409 VERSION_CONFLICT to a stale version, and 404 to an office that does not exist', async () => {
      const stale = await http().put(admin()).send({ ...TODAY, expectedVersion: 0 }).expect(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      await http().get(admin(new mongoose.Types.ObjectId().toString())).expect(404);
      await http().put(admin('not-an-id')).send(TODAY).expect(404);
    });

    it('P18.9-T2 AC-3 has no office of its own to read at the settings route', async () => {
      const res = await http().get('/kpm/settings/activity-binding').expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });
  });

  describe('the Owner and the Admin read their own office’s, and nobody else writes it', () => {
    it.each([['the Owner', OWNER_A], ['the Admin', ADMIN_A]] as [string, RequestContext][])('%s', async (_who, ctx) => {
      session.current = SUPER_ADMIN;
      await http().put(admin(OTHER_KPM)).send({ ...TODAY, leads: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'] }).expect(200);

      session.current = ctx;
      // Their own office's, at both routes — not office B's rebind.
      expect((await http().get('/kpm/settings/activity-binding').expect(200)).body).toMatchObject({ ...TODAY, version: 1 });
      expect((await http().get(admin()).expect(200)).body).toMatchObject({ kpmId: FIXTURE_KPM, ...TODAY });
      // Another office is 404, never 403.
      await http().get(admin(OTHER_KPM)).expect(404);
      // The write is the Super Admin's.
      await http().put(admin()).send(TODAY).expect(403);
      await http().put(admin(OTHER_KPM)).send(TODAY).expect(403);
    });

    it('P18.9-T2 AC-3 office B’s Owner reads B’s', async () => {
      await http().put(admin(OTHER_KPM)).send({ ...TODAY, leads: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'] }).expect(200);
      session.current = OWNER_B;
      expect((await http().get('/kpm/settings/activity-binding').expect(200)).body)
        .toMatchObject({ leads: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'], version: 2 });
      await http().get(admin()).expect(404);
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT]] as [string, RequestContext][])(
      'P18.9-T2 AC-3 refuses %s every route, 403',
      async (_who, ctx) => {
        session.current = ctx;
        await http().get('/kpm/settings/activity-binding').expect(403);
        await http().get(admin()).expect(403);
        await http().put(admin()).send(TODAY).expect(403);
      },
    );

    it('P18.9-T2 AC-3 the fixture Owner and Admin, who hold an AB class too, are served the same', async () => {
      for (const ctx of [OWNER, ADMIN]) {
        session.current = ctx;
        await http().get('/kpm/settings/activity-binding').expect(200);
        await http().put(admin()).send(TODAY).expect(403);
      }
    });
  });

  describe('AC-4: archiving a bound type, by every role that may archive', () => {
    it.each([['the Owner', OWNER_A], ['the Admin', ADMIN_A]] as [string, RequestContext][])('%s', async (_who, ctx) => {
      session.current = SUPER_ADMIN;
      await http().put(admin()).send({ ...TODAY, leads: ['LEADS_CONTACTED', 'RECRUIT_FOLLOWUP'] }).expect(200);

      session.current = ctx;
      const sections = (await http().get('/kpm/settings/activity-types').expect(200)).body as {
        id: string; code: string; types: { id: string; code: string }[];
      }[];
      const type = (code: string) => sections.flatMap((c) => c.types).find((t) => t.code === code)!;
      const refused = await http().delete(`/kpm/settings/activity-types/${type('RECRUIT_FOLLOWUP').id}`).expect(409);
      expect(refused.body.error).toMatchObject({
        code: 'ACTIVITY_TYPE_BOUND', details: { codes: ['RECRUIT_FOLLOWUP'], roles: ['Set appointment'] },
      });
      const recruitment = sections.find((c) => c.code === 'RECRUITMENT')!;
      const section = await http().delete(`/kpm/settings/activity-categories/${recruitment.id}`).expect(409);
      expect(section.body.error.details.codes).toEqual(['RECRUIT_FOLLOWUP']);

      // Unbound by the Super Admin, both archive — the platform's own LEADS_CONTACTED too, once nothing binds it.
      session.current = SUPER_ADMIN;
      await http().put(admin()).send({ ...TODAY, leads: ['LEADS_GEN_ACTIVITY'] }).expect(200);
      session.current = ctx;
      await http().delete(`/kpm/settings/activity-types/${type('RECRUIT_FOLLOWUP').id}`).expect(200);
      await http().delete(`/kpm/settings/activity-types/${type('LEADS_CONTACTED').id}`).expect(200);
      await http().delete(`/kpm/settings/activity-types/${type('LEADS_GEN_ACTIVITY').id}`).expect(409);
    });
  });
});
