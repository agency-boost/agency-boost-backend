import {
  CanActivate, ExecutionContext, INestApplication, RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { REQUIRED_PERMISSION } from '@/common/auth/auth.decorators';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { productionPipe } from '../../../test/http-permissions';
import { ActivityConfigService } from './activity.service';
import { ConfigChangeService } from './changes.service';
import { TenantConfigController, TenantConfigReadController } from './config.controller';
import { TrainingController } from '@/modules/training/training.controller';
import { ActivationController } from '@/modules/activation/activation.controller';
import { ActivationService } from '@/modules/activation/activation.service';
import { TrainingService } from '@/modules/training/training.service';
import { LeadStatusService } from './lead-status.service';
import { RatioService } from './ratio.service';
import { TenantConfigService } from './tenant-config.service';
import { TenantService } from '@/modules/tenants/tenant.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';

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
      controllers: [
        TenantConfigController, TenantConfigReadController, TrainingController, ActivationController,
      ],
      providers: [
        { provide: ActivityConfigService, useValue: wired.activity },
        { provide: LeadStatusService, useValue: wired.leads },
        { provide: RatioService, useValue: wired.ratios },
        { provide: TenantConfigService, useValue: wired.config },
        { provide: ConfigChangeService, useValue: wired.changes },
        { provide: TrainingService, useValue: wired.training },
        { provide: ActivationService, useValue: wired.activation },
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
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    // Listening once keeps supertest from cycling an ephemeral port per request.
    await listenOnLoopback(app);
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
    const seeded = await wired.provisioning.seedActivityTaxonomy(KPM_A);
    await wired.provisioning.seedRatioDefinitions(KPM_A, seeded.typeCodes);
    await wired.provisioning.seedLeadPipelines(KPM_A);
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
      ['TrainingController', TrainingController],
      ['ActivationController', ActivationController],
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
        ...routes(Object.create(TrainingController.prototype) as object),
        ...routes(Object.create(ActivationController.prototype) as object),
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
        ...routes(Object.create(TrainingController.prototype) as object),
        ...routes(Object.create(ActivationController.prototype) as object),
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
        ...routes(Object.create(TrainingController.prototype) as object),
        ...routes(Object.create(ActivationController.prototype) as object),
      ];
      const reads = found.filter((r) => r.method === RequestMethod.GET);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads
        .filter((r) => !readLike.test(r.permission?.split(':')[1] ?? ''))
        .map((r) => r.name)).toEqual([]);
    });
  });

  describe('GET /kpm/settings/training (P5-T1)', () => {
    it('reads the office\'s taxonomy nested, drafts included, archived rows on request', async () => {
      await wired.provisioning.seedTrainingTaxonomy(KPM_A);
      await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({ ops: [
          { op: 'trainingModule.create', body: { code: 'WIP', skillCode: 'CLOSING', title: 'In progress' } },
        ] })
        .expect(201);
      const sales = (await wired.training.list(OWNER, true)).find((c) => c.code === 'SALES')!;
      await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({ ops: [{ op: 'trainingCategory.archive', id: sales.id, expectedVersion: sales.version }] })
        .expect(201);

      const live = await request(app.getHttpServer()).get('/kpm/settings/training').expect(200);
      expect(live.body.map((c: { code: string }) => c.code)).not.toContain('SALES');

      const all = await request(app.getHttpServer())
        .get('/kpm/settings/training?includeArchived=true').expect(200);
      const closing = all.body[0].skills.find((s: { code: string }) => s.code === 'CLOSING');
      expect(closing.modules.map((m: { code: string; publishState: string }) => [m.code, m.publishState]))
        .toContainEqual(['WIP', 'draft']);
    });

    /*
     * P18.5-T1 AC-8 (the leak): this asserted the opposite until 2026-10-10 — *"readable by every member"* — and
     * the read answers drafts and archived rows. The settings read is the office's administration's
     * (`training_settings:read`); an agent reads what is offered, at `/training`.
     */
    it('P18.5-T1 AC-8 refuses a field member the settings read, as the batch refuses them its writes', async () => {
      current = AGENT;
      await request(app.getHttpServer()).get('/kpm/settings/training').expect(403);
      await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({ ops: [{ op: 'trainingCategory.create', body: { code: 'MINE_NOW', label: 'Mine' } }] })
        .expect(403);
    });
  });

  describe('/kpm/settings/activation-checklist (P5-T3)', () => {
    const draftOf = (body: { published: { aspects: unknown[] } }) => ({
      aspects: (body.published.aspects as {
        code: string; label: string; items: { code: string; label: string; autoLink: string | null }[];
      }[]).map((aspect) => ({
        code: aspect.code,
        label: aspect.label,
        items: aspect.items.map((i) => ({ code: i.code, label: i.label, autoLink: i.autoLink })),
      })),
    });

    beforeEach(async () => {
      const training = await wired.provisioning.seedTrainingTaxonomy(KPM_A);
      await wired.provisioning.seedActivationChecklist(KPM_A, training.publishedModuleCodes);
    });

    it('reads the published version, its window, and every link resolved', async () => {
      const res = await request(app.getHttpServer())
        .get('/kpm/settings/activation-checklist').expect(200);

      expect(res.body.published).toMatchObject({ version: 1, status: 'published' });
      expect(res.body.draft).toBeNull();
      const items = res.body.published.aspects.flatMap((a: { items: unknown[] }) => a.items);
      expect(items).toHaveLength(16);
      expect(items.find((i: { code: string }) => i.code === 'GOAL_SETTING').link)
        .toMatchObject({ label: 'Goal Settings', route: '/goals', live: true });
    });

    it('saves a draft and publishes it as the next version', async () => {
      const read = await request(app.getHttpServer()).get('/kpm/settings/activation-checklist');
      const next = draftOf(read.body);
      next.aspects[0].label = '1. Induction';

      const saved = await request(app.getHttpServer())
        .put('/kpm/settings/activation-checklist').send(next).expect(200);
      expect(saved.body.draft).toMatchObject({ version: 2, status: 'draft' });
      expect(saved.body.published.aspects[0].label).toBe('1. Pengenalan');

      const published = await request(app.getHttpServer())
        .post('/kpm/settings/activation-checklist/publish').expect(201);
      expect(published.body.draft).toBeNull();
      expect(published.body.published).toMatchObject({ version: 2 });
      expect(published.body.published.aspects[0].label).toBe('1. Induction');
    });

    it('refuses a draft the checker will not have, naming every problem', async () => {
      const res = await request(app.getHttpServer())
        .put('/kpm/settings/activation-checklist')
        .send({ aspects: [{ code: 'A_CODE', label: 'A', items: [{ code: 'X', label: '' }] }] })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    /*
     * The Phase 18.5 exit review (permission review B2): this asserted *"readable by every member"* until 2026-10-10,
     * and the read answers the draft and names each training link by its working title, a draft module's included. The
     * settings read is the office's administration's (`activation_settings:read`); a field member reads their own
     * activation, named from what the office offers.
     */
    it.each([
      ['an agent', AGENT],
      ['an AB', new RequestContext('u-ab', 'none', member({ membershipId: 'mem-d', isKpmOwner: false }) as never)],
      ['an AAB', new RequestContext('u-aab', 'none', member({
        membershipId: 'mem-e', orgLevelCode: 'AAB', hierarchyRole: 'aab', isKpmOwner: false,
      }) as never)],
    ])('P18.5 exit review B2 refuses %s the settings read, as it refuses them both writes', async (_name, who) => {
      current = who;
      const res = await request(app.getHttpServer()).get('/kpm/settings/activation-checklist').expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
      await request(app.getHttpServer())
        .put('/kpm/settings/activation-checklist')
        .send({ aspects: [{ code: 'MINE', label: 'Mine', items: [{ code: 'M_ITEM', label: 'Item' }] }] })
        .expect(403);
      await request(app.getHttpServer())
        .post('/kpm/settings/activation-checklist/publish').expect(403);
    });

    it('P18.5 exit review B2 the Owner, the Admin and a read-only session as the Owner read it; a Super Admin in no office is refused', async () => {
      for (const who of [OWNER, ADMIN, new RequestContext(OWNER.userId, 'none', OWNER.membership, 'u-support', null, false, true)]) {
        current = who;
        await request(app.getHttpServer()).get('/kpm/settings/activation-checklist').expect(200);
      }
      current = RequestContext.platform('root');
      const res = await request(app.getHttpServer()).get('/kpm/settings/activation-checklist').expect(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P18.5 exit review B2 names a training link by the module’s working title here, a draft’s included — the settings read alone', async () => {
      const module = (await wired.training.list(OWNER, true))
        .flatMap((c) => c.skills.flatMap((s) => s.modules)).find((m) => m.code === 'CLOSING_TECHNIQUES')!;
      const read = await request(app.getHttpServer()).get('/kpm/settings/activation-checklist');
      const next = draftOf(read.body);
      next.aspects[2].items[0].autoLink = 'training:CLOSING_TECHNIQUES';
      await request(app.getHttpServer()).put('/kpm/settings/activation-checklist').send(next).expect(200);
      await request(app.getHttpServer()).post('/kpm/settings/activation-checklist/publish').expect(201);
      await wired.training.updateModule(OWNER, module.id, { title: 'Closing, the draft rename', publishState: 'draft' });

      const settings = await request(app.getHttpServer()).get('/kpm/settings/activation-checklist').expect(200);
      const bound = settings.body.published.aspects[2].items[0];
      expect(bound.link).toMatchObject({ kind: 'training:CLOSING_TECHNIQUES', label: 'Closing, the draft rename' });

      // What `/kpm/config` would publish to every member names no draft: the module is not offered, so its code.
      const snapshot = await wired.activation.publishedForSnapshot(OWNER);
      expect(snapshot!.aspects[2].items[0].link).toMatchObject({ label: 'CLOSING_TECHNIQUES', route: null });
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

    it('P18.98-T5 AC-7 names the op that failed, its field sentences and a missing row in Indonesian for an Indonesian reader', async () => {
      const ops = [
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
        { op: 'category.create', body: { code: 'x', label: '' } },
      ];
      const res = await request(app.getHttpServer())
        .post('/kpm/settings/changes').set(...IN_INDONESIAN).send({ ops }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toBe(
        'Perubahan 2 (category.create): code: Kode terdiri dari 3–40 karakter A–Z, 0–9 dan garis bawah, diawali huruf.; '
          + 'label harus 1–80 karakter.',
      );
      expect(res.body.error.details.violations).toEqual([
        'code: Kode terdiri dari 3–40 karakter A–Z, 0–9 dan garis bawah, diawali huruf.',
        'label harus 1–80 karakter.',
      ]);

      // The same refusal in English for an English reader — the words the batch has always written.
      const english = await request(app.getHttpServer()).post('/kpm/settings/changes').send({ ops }).expect(400);
      expect(english.body.error.message).toBe(
        'Change 2 (category.create): code: A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a '
          + 'letter.; label must be 1–80 characters.',
      );

      const missing = await request(app.getHttpServer())
        .post('/kpm/settings/changes').set(...IN_INDONESIAN)
        .send({ ops: [{ op: 'ratio.update', id: '66f0000000000000000000ff', expectedVersion: 1, body: { benchmark: 0.2 } }] })
        .expect(404);
      expect(missing.body.error).toMatchObject({
        code: 'NOT_FOUND', message: 'Perubahan 1 (ratio.update): Baris itu tidak ditemukan.',
      });
      // Nothing of the first batch was written: its second op was refused before any was.
      const after = await wired.activity.list(OWNER, true);
      expect(after.some((c) => c.code === 'REFERRALS')).toBe(false);
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

    it('ticks and unticks the expected-to-close flag over HTTP (ADR-0043)', async () => {
      const submitted = (await sales()).find((st) => st.code === 'POLICY_SUBMITTED')!;
      expect(submitted.isLateStage).toBe(true);

      const off = await request(app.getHttpServer())
        .patch(`/kpm/settings/lead-statuses/${submitted.id}/late-stage`)
        .send({ isLateStage: false })
        .expect(200);
      expect(off.body).toMatchObject({ code: 'POLICY_SUBMITTED', isLateStage: false });

      const on = await request(app.getHttpServer())
        .patch(`/kpm/settings/lead-statuses/${submitted.id}/late-stage`)
        .send({ isLateStage: true })
        .expect(200);
      expect(on.body.isLateStage).toBe(true);
    });

    it('needs a real boolean, through the pipe rather than the service', async () => {
      // `enableImplicitConversion: false`, so the string "true" is not a boolean and the
      // Owner's browser cannot half-tick a checkbox.
      const submitted = (await sales()).find((st) => st.code === 'POLICY_SUBMITTED')!;

      await request(app.getHttpServer())
        .patch(`/kpm/settings/lead-statuses/${submitted.id}/late-stage`)
        .send({ isLateStage: 'true' })
        .expect(400);

      await request(app.getHttpServer())
        .patch(`/kpm/settings/lead-statuses/${submitted.id}/late-stage`)
        .send({})
        .expect(400);
    });

    it('refuses the flag on the stage that closes the pipeline', async () => {
      const closed = (await sales()).find((st) => st.isTerminal)!;

      const res = await request(app.getHttpServer())
        .patch(`/kpm/settings/lead-statuses/${closed.id}/late-stage`)
        .send({ isLateStage: true })
        .expect(400);

      expect(res.body.error.message).toMatch(/already closed/);
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

  describe('the summary tile a section counts toward (ADR-0064, P10.1-T5)', () => {
    /*
     * The same rules the service spec pins, through the pipe and the filter: a refusal reaches the
     * client as the envelope a screen reads, with the details it points at the field with.
     */
    const section = async (code: string) =>
      (await wired.activity.list(OWNER, true)).find((c) => c.code === code)!;

    it('regroups a section on its own edit, bumping its version', async () => {
      const selling = await section('SELLING');
      const res = await request(app.getHttpServer())
        .patch(`/kpm/settings/activity-categories/${selling.id}`)
        .send({ summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Pengembangan' })
        .expect(200);
      expect(res.body).toMatchObject({
        summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Pengembangan', version: selling.version + 1,
      });
    });

    it('refuses a label the tile does not carry: 422 and the envelope’s details', async () => {
      const selling = await section('SELLING');
      const res = await request(app.getHttpServer())
        .patch(`/kpm/settings/activity-categories/${selling.id}`)
        .send({ summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth' })
        .expect(422);
      expect(res.body.error).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH',
        details: { summaryGroupCode: 'DEVELOPMENT', labels: ['Growth', 'Pengembangan'] },
      });

      const batch = await request(app.getHttpServer())
        .post('/kpm/settings/changes')
        .send({
          ops: [{
            op: 'category.update', id: selling.id, expectedVersion: selling.version,
            body: { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth' },
          }],
        })
        .expect(422);
      expect(batch.body.error).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH',
        details: { summaryGroupCode: 'DEVELOPMENT', labels: ['Growth', 'Pengembangan'] },
      });
    });

    it('refuses a code without a label on a new section, as the batch would', async () => {
      const res = await request(app.getHttpServer())
        .post('/kpm/settings/activity-categories')
        .send({ code: 'REFERRALS', label: 'Referrals', summaryGroupCode: 'SELLING' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('serves the tiles in /kpm/config, and null on a section with none', async () => {
      await request(app.getHttpServer())
        .post('/kpm/settings/activity-categories')
        .send({ code: 'REFERRALS', label: 'Referrals', summaryGroupCode: null, summaryGroupLabel: null })
        .expect(201);
      await request(app.getHttpServer()).post('/kpm/settings/publish').expect(201);

      current = AGENT;
      const res = await request(app.getHttpServer()).get('/kpm/config').expect(200);
      const tiles = Object.fromEntries(res.body.activity.map(
        (c: { code: string; summaryGroupCode: string | null; summaryGroupLabel: string | null }) =>
          [c.code, [c.summaryGroupCode, c.summaryGroupLabel]],
      ));
      expect(tiles).toEqual({
        LEADS_GENERATION: [null, null],
        SELLING: [null, null],
        RECRUITMENT: [null, null],
        PERSONAL_DEVELOPMENT: ['DEVELOPMENT', 'Pengembangan'],
        TEAM_DEVELOPMENT: ['DEVELOPMENT', 'Pengembangan'],
        REFERRALS: [null, null],
      });
    });

    it('refuses an agent the edit, which is the Owner’s and the Admins’', async () => {
      const selling = await section('SELLING');
      current = AGENT;
      await request(app.getHttpServer())
        .patch(`/kpm/settings/activity-categories/${selling.id}`)
        .send({ summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Pengembangan' })
        .expect(403);

      current = ADMIN;
      await request(app.getHttpServer())
        .patch(`/kpm/settings/activity-categories/${selling.id}`)
        .send({ summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Pengembangan' })
        .expect(200);
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
