import {
  CanActivate, ExecutionContext, INestApplication, RequestMethod, ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { REQUIRED_PERMISSION } from '@/common/auth/auth.decorators';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { ActivityConfigService } from './activity.service';
import { ConfigChangeService } from './changes.service';
import { TenantConfigController, TenantConfigReadController } from './config.controller';
import { LeadStatusService } from './lead-status.service';
import { RatioService } from './ratio.service';
import { TenantConfigService } from './tenant-config.service';
import { TenantService } from '@/modules/tenants/tenant.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-17T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const COMPANY = '66f0000000000000000000c1';

const member = (over: Partial<Record<string, unknown>> = {}) => ({
  membershipId: 'mem-a', kpmId: KPM_A, orgLevelCode: 'AB', hierarchyRole: 'ab' as const,
  status: 'active' as const, isKpmOwner: true, isKpmAdmin: false, directCount: 0, ...over,
});
const OWNER = new RequestContext('u-owner', 'none', member() as never);
const AGENT = new RequestContext('u-agent', 'none', member({
  membershipId: 'mem-b', orgLevelCode: 'AGENT', hierarchyRole: 'agent', isKpmOwner: false,
}) as never);
const ADMIN = new RequestContext('u-admin', 'none', member({
  membershipId: 'mem-c', isKpmOwner: false, isKpmAdmin: true,
}) as never);

/** Whoever the current test is signed in as. The real guard runs behind this. */
let current: RequestContext = OWNER;

class StubAuth implements CanActivate {
  canActivate(execution: ExecutionContext): boolean {
    execution.switchToHttp().getRequest<{ context: RequestContext }>().context = current;
    return true;
  }
}

/**
 * The configuration controllers over HTTP (P4-T27).
 *
 * **Every route here was only ever exercised by calling its service directly.** The
 * controller sat at 20% branch and 31% function coverage while the module's floor said 87,
 * and the gap is not cosmetic: the Phase 4 exit review found three defects of exactly this
 * shape, including a route whose permission name was right in the registry and wrong in the
 * decorator. A service test cannot see a decorator.
 *
 * The auth guard is a stub — which session is signed in is `auth.e2e.int.spec.ts`'s
 * question. **`PermissionsGuard` is the real one**, because whether it refuses is this
 * file's question.
 */
describe('the configuration controllers', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [TenantConfigController, TenantConfigReadController],
      providers: [
        { provide: ActivityConfigService, useValue: wired.activity },
        { provide: LeadStatusService, useValue: wired.leads },
        { provide: RatioService, useValue: wired.ratios },
        { provide: TenantConfigService, useValue: wired.config },
        { provide: ConfigChangeService, useValue: wired.changes },
        // Only two of its methods are reachable from here, and neither is this file's
        // subject — `tenant.service`'s own specs own them.
        {
          provide: TenantService,
          useValue: {
            readProfile: async () => ({ code: '0417', branchName: 'A' }),
            updateIdentity: async (_c: unknown, _k: string, dto: unknown) => dto,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    // Listening once keeps supertest from cycling an ephemeral port per request.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    current = OWNER;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> })
      .create({ _id: COMPANY, name: 'Prudential', slug: 'p' });
    const sa = RequestContext.platform('root');
    for (const [i, code] of ['AGENT', 'AAB', 'AB'].entries()) {
      await wired.orgLevels.create(sa, { companyId: COMPANY, code, label: code, displayOrder: i + 1 });
    }
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    });
    const seeded = await wired.provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
    await wired.provisioning.seedRatioDefinitions(KPM_A, COMPANY, seeded.typeCodes);
    await wired.provisioning.seedLeadPipelines(KPM_A, COMPANY);
  });

  describe('every route declares what it needs', () => {
    /*
     * Structural, and the cheapest guard against the defect the exit review actually found:
     * four writes on `AuthController` declared no permission at all, and a read-only support
     * session wrote through one of them. A route added here without a decorator would be
     * caught by this and by nothing else in the suite.
     */
    const routes = (controller: object) => {
      const prototype = Object.getPrototypeOf(controller) as object;
      return Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => {
          const handler = (prototype as Record<string, unknown>)[name] as () => unknown;
          return {
            name,
            method: Reflect.getMetadata('method', handler) as RequestMethod | undefined,
            permission: new Reflector().get<string>(REQUIRED_PERMISSION, handler),
          };
        })
        .filter((r) => r.method !== undefined);
    };

    it.each([
      ['TenantConfigController', TenantConfigController],
      ['TenantConfigReadController', TenantConfigReadController],
    ])('%s: every route names a permission', (_label, Controller) => {
      const found = routes(Object.create(Controller.prototype) as object);
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((r) => !r.permission).map((r) => r.name)).toEqual([]);
    });

    it('never gates a write on a read-shaped permission', () => {
      /*
       * The rule the guard itself uses, not a spelling convention: `permissions.ts` decides
       * read-versus-write from the **action** after the colon, and a read-only support
       * session is refused every permission that does not look like a read. So a write
       * gated on a read-shaped name would let that session through — the inverse of OD-49,
       * and the one worth failing a build over.
       *
       * Kept apart from the test below on purpose: that one pins a product decision, which
       * an ADR may one day change, and this one pins a guard rule, which no ADR should.
       */
      const readLike = /^(read|list|search|preview|view|export)/;
      const found = [
        ...routes(Object.create(TenantConfigController.prototype) as object),
        ...routes(Object.create(TenantConfigReadController.prototype) as object),
      ];
      const writes = found.filter((r) => r.method !== RequestMethod.GET);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes
        .filter((r) => readLike.test(r.permission?.split(':')[1] ?? ''))
        .map((r) => r.name)).toEqual([]);
    });

    it('gates every write on tenant_config:write, Branch info included (ADR-0027)', () => {
      /*
       * One permission for every page under Settings, held by the Owner and the Admin and by
       * nobody else. A write here under any other name is a page that has been given a rule of
       * its own — a product decision, with an ADR — or a mistake. Branch info was the one
       * exception, behind an Owner-only permission, until the product owner removed it.
       */
      const found = [
        ...routes(Object.create(TenantConfigController.prototype) as object),
        ...routes(Object.create(TenantConfigReadController.prototype) as object),
      ];
      const writes = found.filter((r) => r.method !== RequestMethod.GET);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes
        .filter((r) => r.permission !== 'tenant_config:write')
        .map((r) => `${r.name}: ${r.permission}`)).toEqual([]);
    });

    it('gates every read on a read-shaped permission, so a support session can look', () => {
      // OD-49 is this defect on `modules/org`: `GET /members/groups` sits behind
      // `group_informal:create`, so a read-only session cannot see an office's groups —
      // a false denial on exactly the surface the session exists to inspect.
      const readLike = /^(read|list|search|preview|view|export)/;
      const found = [
        ...routes(Object.create(TenantConfigController.prototype) as object),
        ...routes(Object.create(TenantConfigReadController.prototype) as object),
      ];
      const reads = found.filter((r) => r.method === RequestMethod.GET);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads
        .filter((r) => !readLike.test(r.permission?.split(':')[1] ?? ''))
        .map((r) => r.name)).toEqual([]);
    });
  });

  describe('POST /kpm/settings/changes', () => {
    it('refuses a member who may read the configuration and not write it', async () => {
      // The API refuses it too — hiding the controls on screen is convenience, not control.
      current = AGENT;
      await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({ ops: [{ op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } }] })
        .expect(403);

      current = OWNER;
      const after = await wired.activity.list(OWNER, true);
      expect(after.some((c) => c.code === 'REFERRALS')).toBe(false);
    });

    it('applies a batch for an Owner and answers with the configuration', async () => {
      const res = await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({ ops: [{ op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } }] })
        .expect(201);

      expect(res.body.activity.some((c: { code: string }) => c.code === 'REFERRALS')).toBe(true);
    });

    it('answers 404 for a row that is not this office’s', async () => {
      await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({
          ops: [{
            op: 'ratio.update', id: '66f0000000000000000000ff', expectedVersion: 1,
            body: { benchmark: 0.2 },
          }],
        })
        .expect(404);
    });

    it('refuses a body that is not a list of operations', async () => {
      await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({ ops: 'everything' })
        .expect(400);
    });
  });

  describe('reads', () => {
    it('hides archived rows unless asked, and returns them when asked', async () => {
      const type = (await wired.activity.list(OWNER, true)).flatMap((c) => c.types)[0];
      await wired.activity.archiveType(OWNER, type.id);

      const plain = await request(app.getHttpServer())
        .get('/kpm/settings/activity-types').expect(200);
      const withArchived = await request(app.getHttpServer())
        .get('/kpm/settings/activity-types?includeArchived=true').expect(200);

      const codes = (body: { types: { code: string }[] }[]) => body.flatMap((c) => c.types).map((t) => t.code);
      expect(codes(plain.body)).not.toContain(type.code);
      expect(codes(withArchived.body)).toContain(type.code);
    });

    it('lets an agent read the configuration they log against', async () => {
      current = AGENT;
      await request(app.getHttpServer()).get('/kpm/settings/activity-types').expect(200);
      await request(app.getHttpServer()).get('/kpm/settings/ratio-benchmarks').expect(200);
      await request(app.getHttpServer()).get('/kpm/settings/lead-statuses').expect(200);
    });

    it('answers /kpm/config with a strong ETag, and 304 when it is sent back', async () => {
      // The agent loop runs on a mid-range Android over 4G; a repeat read costs headers.
      const first = await request(app.getHttpServer()).get('/kpm/config').expect(200);
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();
      expect(first.headers['cache-control']).toBe('private, no-cache');

      await request(app.getHttpServer())
        .get('/kpm/config').set('If-None-Match', etag).expect(304);
    });

    it('serves the company ladder the office reads its rungs from', async () => {
      const res = await request(app.getHttpServer()).get('/kpm/org-levels').expect(200);
      expect(res.body.map((r: { code: string }) => r.code)).toEqual(['AGENT', 'AAB', 'AB']);
    });
  });

  describe('the single-operation write routes the screens still call', () => {
    /*
     * Each of these has a screen behind it (`check-api-consumers.py`), and none had ever
     * been reached over HTTP — only by calling its service. A route whose decorator names
     * the wrong permission, or whose `:id` param is read from the wrong place, fails here
     * and nowhere else.
     */
    const sales = async () => {
      const [pipeline] = await wired.leads.list(OWNER, true);
      return pipeline.statuses;
    };

    it('adds, renames, reorders, closes, archives and restores a lead status', async () => {
      const created = await request(app.getHttpServer())
        .post('/kpm/settings/lead-statuses')
        .send({ pipeline: 'sales', code: 'AWAITING_UNDERWRITING', label: 'Awaiting underwriting' })
        .expect(201);
      const id = created.body.id as string;

      await request(app.getHttpServer())
        .patch(`/kpm/settings/lead-statuses/${id}`)
        .send({ label: 'Menunggu underwriting' })
        .expect(200);

      const ids = (await sales()).map((st) => st.id).reverse();
      await request(app.getHttpServer())
        .patch('/kpm/settings/lead-statuses/reorder')
        .send({ pipeline: 'sales', ids })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/kpm/settings/lead-statuses/${id}/terminal`).expect(201);
      const afterTerminal = (await sales()).find((st) => st.id === id)!;
      expect(afterTerminal).toMatchObject({ label: 'Menunggu underwriting', isTerminal: true });

      // The stage that closes a pipeline cannot be archived — leads would have no way to
      // be marked successful. Move it first, then archive.
      const other = (await sales()).find((st) => st.id !== id)!;
      await request(app.getHttpServer())
        .post(`/kpm/settings/lead-statuses/${other.id}/terminal`).expect(201);
      await request(app.getHttpServer())
        .delete(`/kpm/settings/lead-statuses/${id}`).expect(200);
      // `sales()` reads the archived rows too — invariant §3 keeps them, so the assertion
      // is about the status, not about the row vanishing.
      expect((await sales()).find((st) => st.id === id)!.status).toBe('archived');

      await request(app.getHttpServer())
        .post(`/kpm/settings/lead-statuses/${id}/restore`).expect(201);
      expect((await sales()).find((st) => st.id === id)!.status).toBe('active');
    });

    it('adds, archives and restores a ratio', async () => {
      const created = await request(app.getHttpServer())
        .post('/kpm/settings/ratio-benchmarks')
        .send({
          code: 'REFERRAL_RATE', label: 'Referral rate',
          numerator: ['SELL_SUBMISSION'], denominator: ['LEADS_CONTACTED'],
          benchmark: 0.2, comparison: 'gte',
        })
        .expect(201);
      const id = created.body.id as string;
      expect(created.body).toMatchObject({ origin: 'office', displayUnit: 'decimal' });

      await request(app.getHttpServer())
        .delete(`/kpm/settings/ratio-benchmarks/${id}`).expect(200);
      expect((await wired.ratios.list(OWNER)).some((r) => r.id === id)).toBe(false);

      await request(app.getHttpServer())
        .post(`/kpm/settings/ratio-benchmarks/${id}/restore`).expect(201);
      expect((await wired.ratios.list(OWNER)).some((r) => r.id === id)).toBe(true);
    });

    it('refuses a benchmark outside the range the DTO allows', async () => {
      // The validation pipe, not the service — and the reason the batch's own bypass of
      // these DTOs is worth recording.
      await request(app.getHttpServer())
        .post('/kpm/settings/ratio-benchmarks')
        .send({
          code: 'WILD', label: 'Wild', numerator: ['SELL_SUBMISSION'],
          denominator: ['LEADS_CONTACTED'], benchmark: 5000, comparison: 'gte',
        })
        .expect(400);
    });

    it('reorders activity types by naming the whole list', async () => {
      const ids = (await wired.activity.list(OWNER, true))
        .flatMap((c) => c.types).map((t) => t.id).reverse();
      await request(app.getHttpServer())
        .patch('/kpm/settings/activity-types/reorder').send({ ids }).expect(200);
    });

    it('reorders the sections the same way', async () => {
      const ids = (await wired.activity.list(OWNER, true)).map((c) => c.id).reverse();
      await request(app.getHttpServer())
        .patch('/kpm/settings/activity-categories/reorder').send({ ids }).expect(200);
    });

    it('publishes, and says what agents are on', async () => {
      const before = await request(app.getHttpServer())
        .get('/kpm/settings/publish-state').expect(200);
      expect(before.body).toHaveProperty('publishedVersion');

      const published = await request(app.getHttpServer())
        .post('/kpm/settings/publish').expect(201);
      expect(published.body.hasUnpublishedChanges).toBe(false);
    });
  });

  describe('branch info', () => {
    it('is readable, and writable by the Owner and the Admin alike (ADR-0027)', async () => {
      await request(app.getHttpServer()).get('/kpm/settings/branch-info').expect(200);

      await request(app.getHttpServer())
        .patch('/kpm/settings/branch-info').send({ branchName: 'BSD City Branch' }).expect(200);

      // It answered PERM_OWNER_ONLY to an Admin until 2026-09-17.
      current = ADMIN;
      const renamed = await request(app.getHttpServer())
        .patch('/kpm/settings/branch-info').send({ branchName: 'Serpong Branch' }).expect(200);
      expect(renamed.body.branchName).toBe('Serpong Branch');

      current = AGENT;
      const refused = await request(app.getHttpServer())
        .patch('/kpm/settings/branch-info').send({ branchName: 'Mine now' }).expect(403);
      expect(refused.body.error.code).toBe('PERM_DENIED');
    });
  });
});
