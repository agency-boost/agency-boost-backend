import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import type { BrandingReader } from '@/modules/branding/branding-reader';
import type { KpmProductService } from '@/modules/products/kpm-product.service';
import { TenantService } from '@/modules/tenants/tenant.service';
import { declaredPermissions, productionPipe } from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { ActivityConfigService } from './activity.service';
import { ConfigChangeService } from './changes.service';
import { TenantConfigController } from './config.controller';
import { LeadStatusService } from './lead-status.service';
import { RatioService } from './ratio.service';
import { SettingsOverviewController } from './settings-overview.controller';
import { SettingsOverviewService } from './settings-overview.service';
import { TenantConfigService } from './tenant-config.service';

const NOW = new Date('2026-11-20T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

type Over = Partial<{ isKpmOwner: boolean; isKpmAdmin: boolean; isCoreLeader: boolean; hierarchyRole: string; orgLevelCode: string }>;
const member = (kpmId: string, over: Over = {}) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
} as never);

const ROLES: Record<string, RequestContext> = {
  OWNER: member(KPM_A, { isKpmOwner: true }),
  ADMIN: member(KPM_A, { isKpmAdmin: true }),
  CORE_LEADER: member(KPM_A, { isCoreLeader: true }),
  SUPER_ADMIN_IN_KPM: RequestContext.superAdminInKpm(RequestContext.platform('root'), KPM_A),
  AB: member(KPM_A),
  AAB: member(KPM_A, { hierarchyRole: 'aab', orgLevelCode: 'AAB' }),
  AGENT: member(KPM_A, { hierarchyRole: 'agent', orgLevelCode: 'AGENT' }),
  OWNER_B: member(KPM_B, { isKpmOwner: true }),
};

let current: RequestContext = ROLES.OWNER;
class StubAuth implements CanActivate {
  canActivate(execution: ExecutionContext): boolean {
    execution.switchToHttp().getRequest<{ context: RequestContext }>().context = current;
    return true;
  }
}

/**
 * **`GET /kpm/settings/publish-state`, `POST /kpm/settings/publish` and `GET /kpm/settings/overview` over HTTP**
 * (P19.21-T2 AC-1 to AC-3): the real permission guard and the deployed validation pipe, each role for and against.
 */
describe('per-setting publish and the Pengaturan hub over HTTP (P19.21-T2)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const http = () => request(app.getHttpServer());
  const as = (role: keyof typeof ROLES) => { current = ROLES[role]; };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const overview = new SettingsOverviewService(
      wired.config, wired.activity, wired.training, wired.capability, wired.activation,
      { list: async () => [] } as unknown as KpmProductService, wired.recruitmentPitch,
      { shownFor: async () => ({ logo: null }) } as unknown as BrandingReader,
      wired.kpms as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [TenantConfigController, SettingsOverviewController],
      providers: [
        { provide: ActivityConfigService, useValue: wired.activity },
        { provide: LeadStatusService, useValue: wired.leads },
        { provide: RatioService, useValue: wired.ratios },
        { provide: TenantConfigService, useValue: wired.config },
        { provide: ConfigChangeService, useValue: wired.changes },
        { provide: TenantService, useValue: {} },
        { provide: SettingsOverviewService, useValue: overview },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    current = ROLES.OWNER;
    await clearCollections();
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
    await wired.config.publish(ROLES.OWNER);
    await wired.config.publish(ROLES.OWNER_B);
    const [pipeline] = await wired.leads.list(ROLES.OWNER);
    await wired.leads.rename(ROLES.OWNER, pipeline.statuses[0].id, 'Belum didekati');
  });

  it('P19.21-T2 declares the hub under tenant_config:read', () => {
    expect(declaredPermissions(SettingsOverviewController)).toEqual({ read: 'tenant_config:read' });
  });

  describe('GET /kpm/settings/publish-state', () => {
    it('P19.21-T2 AC-3 answers each setting’s version and changes, beside the office’s fields', async () => {
      const body = (await http().get('/kpm/settings/publish-state').expect(200)).body;
      expect(body).toMatchObject({ publishedVersion: 1, hasUnpublishedChanges: true });
      expect(body.settings).toHaveLength(6);
      expect(body.settings[1]).toEqual({
        setting: 'lead_statuses', version: 1, hasUnpublishedChanges: true, publishedAt: NOW.toISOString(),
      });
    });
  });

  describe('POST /kpm/settings/publish', () => {
    it('P19.21-T2 AC-3 publishes the settings named, and only those', async () => {
      const body = (await http().post('/kpm/settings/publish').send({ settings: ['lead_statuses'] }).expect(201)).body;
      expect(body.publishedVersion).toBe(2);
      expect(body.settings.find((s: { setting: string }) => s.setting === 'lead_statuses'))
        .toMatchObject({ version: 2, hasUnpublishedChanges: false });
      expect(body.settings.find((s: { setting: string }) => s.setting === 'events')).toMatchObject({ version: 1 });
    });

    it('P19.21-T2 AC-3 with no body publishes every setting — what callers before P19.21 sent', async () => {
      const body = (await http().post('/kpm/settings/publish').expect(201)).body;
      expect(body.hasUnpublishedChanges).toBe(false);
      expect(body.settings.every((s: { hasUnpublishedChanges: boolean }) => !s.hasUnpublishedChanges)).toBe(true);
      const empty = (await http().post('/kpm/settings/publish').send({ settings: [] }).expect(201)).body;
      expect(empty.publishedVersion).toBe(3);
    });

    it.each([
      ['an unknown setting', { settings: ['products'] }],
      ['a setting that is not a word', { settings: [3] }],
      ['settings that are not a list', { settings: 'lead_statuses' }],
      ['a field it does not take', { all: true }],
    ])('P19.21-T2 AC-3 validation: %s is 400', async (_what, body) => {
      const res = await http().post('/kpm/settings/publish').send(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it.each(['OWNER', 'ADMIN', 'CORE_LEADER', 'SUPER_ADMIN_IN_KPM'] as const)(
      'P19.21-T2 AC-3 positive: %s publishes one setting', async (role) => {
        as(role);
        await http().post('/kpm/settings/publish').send({ settings: ['lead_statuses'] }).expect(201);
      },
    );

    it.each(['AB', 'AAB', 'AGENT'] as const)('P19.21-T2 AC-3 negative: %s is refused 403', async (role) => {
      as(role);
      const res = await http().post('/kpm/settings/publish').send({ settings: ['lead_statuses'] }).expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
      as('OWNER');
      expect((await http().get('/kpm/settings/publish-state').expect(200)).body.settings[1].version).toBe(1);
    });

    it('P19.21-T2 cross-tenant: KPM B’s Owner publishing moves KPM B only', async () => {
      as('OWNER_B');
      await http().post('/kpm/settings/publish').send({ settings: ['lead_statuses'] }).expect(201);
      as('OWNER');
      const mine = (await http().get('/kpm/settings/publish-state').expect(200)).body;
      expect(mine.publishedVersion).toBe(1);
      expect(mine.settings[1]).toMatchObject({ version: 1, hasUnpublishedChanges: true });
    });
  });

  describe('GET /kpm/settings/overview', () => {
    it('P19.21-T2 AC-1 AC-2 answers the eleven settings, Belum diterbitkan where changes wait, and the bar’s list', async () => {
      const body = (await http().get('/kpm/settings/overview').expect(200)).body;
      expect(body.settings).toHaveLength(11);
      expect(body.unpublished).toEqual(['lead_statuses']);
      expect(body.settings[1]).toMatchObject({ setting: 'lead_statuses', status: { kind: 'unpublished' } });
      expect(body.settings[0].status).toBeNull();
      expect(body.settings[10]).toMatchObject({ setting: 'branding', status: { kind: 'no_logo' } });
    });

    it.each(['OWNER', 'ADMIN', 'CORE_LEADER', 'SUPER_ADMIN_IN_KPM'] as const)('P19.21-T2 AC-1 positive: %s reads it', async (role) => {
      as(role);
      await http().get('/kpm/settings/overview').expect(200);
    });

    it.each(['AB', 'AAB', 'AGENT'] as const)('P19.21-T2 AC-1 negative: %s is answered 404', async (role) => {
      as(role);
      expect((await http().get('/kpm/settings/overview').expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.21-T2 cross-tenant: KPM B’s Owner reads KPM B’s hub, with none of KPM A’s changes', async () => {
      as('OWNER_B');
      expect((await http().get('/kpm/settings/overview').expect(200)).body.unpublished).toEqual([]);
    });
  });
});
