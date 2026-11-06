import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { up as templateCompany } from '@/migrations/0037-template-company';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { configModule } from '../../../test/config-module';
import { EVERY_MEMBER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AdminController } from './admin.controller';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { TEMPLATE_LIBRARY } from './template-library';
import { TenantService } from './tenant.service';

const NOW = new Date('2026-10-26T03:00:00Z');
const LIBRARY = TEMPLATE_LIBRARY.companyId;
const LIBRARY_DEFAULT = TEMPLATE_LIBRARY.defaultTemplateId;
const REFUSAL = 'Start from a template — the Template’s Default template holds the AgencyBoost defaults — or Empty.';

/**
 * **`POST /admin/tenants` and *Start from*, over HTTP** (ADR-0168 §2, OD-209): a new office starts from one of
 * the company's templates, *Template · Default template* or *Empty*. `startFrom.kind: 'defaults'` is refused at the
 * route, `400 VALIDATION_FAILED` naming `startFrom.kind`, before anything is read or written — one editable
 * source, the Template's Default template, holds the AgencyBoost defaults. Every other source still works.
 *
 * `TenantService` is real over a real database holding what migration `0037` makes, wired as the application
 * wires it; the controller's other collaborators are inert, since no route here reaches them.
 */
describe('POST /admin/tenants — Start from, without the AgencyBoost defaults (ADR-0168 §2)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let tenants: TenantService;
  let companyId: string;
  let ownDefault: string;
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const clock = new FixedClock(NOW);
    const users = wired.users as never;
    tenants = new TenantService(
      wired.kpms as never,
      wired.companies as never,
      users,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never,
      wired.audit,
      clock,
      new HierarchyService(
        wired.memberships, wired.kpms as never, users,
        new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
        clock, wired.orgLevels,
      ),
      wired.memberships,
      wired.orgLevels,
      wired.provisioning,
      wired.products,
      wired.campaigns,
      wired.namedTemplates,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: TenantService, useValue: tenants }],
    })
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
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
    for (const name of ['companies', 'companyOrgLevels', 'products', 'qualificationRules', 'recruitmentPlaybooks',
      'companyTemplates', 'templates', 'kpms', 'users', 'auditLog', 'kpmRequests', 'activityTypes']) {
      await col(name).deleteMany({});
    }
    session.current = SUPER_ADMIN;
    // What every environment holds before any tenant (ADR-0164 §2), and an insurer copied from it.
    await templateCompany(db(), NOW);
    companyId = String((await tenants.createCompany(SUPER_ADMIN, { name: 'Prudential', slug: 'prudential' }))._id);
    // A new company has no template (ADR-0213 §3): its first, copied from the built-in default, becomes its default.
    ownDefault = (await wired.templateCopies.importFrom(SUPER_ADMIN, companyId, {
      fromCompanyId: LIBRARY, templateId: LIBRARY_DEFAULT, name: 'Prudential template',
    })).id;
  });

  const post = (startFrom?: Record<string, unknown>, code = '0417') => request(app.getHttpServer())
    .post('/api/admin/tenants')
    .send({ companyId, code, branchName: 'BSD City Branch', ...(startFrom ? { startFrom } : {}) });
  const startedFrom = async (code: string) => (await col('kpms').findOne({ companyId, code }))?.startedFrom;

  it('refuses the AgencyBoost defaults, 400 VALIDATION_FAILED naming startFrom.kind, and writes nothing', async () => {
    const res = await post({ kind: 'defaults' }).expect(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_FAILED', message: REFUSAL, details: { field: 'startFrom.kind' },
    });
    expect(await col('kpms').countDocuments({})).toBe(0);
    expect(await col('activityTypes').countDocuments({})).toBe(0);
    expect(await col('auditLog').countDocuments({ action: 'kpm.created' })).toBe(0);
  });

  it('refuses them before the company is looked at: the same 400 for the Template library, or no company at all', async () => {
    // The source is the request's own mistake; which company it names is the service's question, never reached.
    for (const named of [LIBRARY, '66f00000000000000000ffff']) {
      const res = await request(app.getHttpServer()).post('/api/admin/tenants')
        .send({ companyId: named, code: '0418', branchName: 'Serpong', startFrom: { kind: 'defaults' } })
        .expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'startFrom.kind' } });
    }
    expect(await col('kpms').countDocuments({})).toBe(0);
  });

  it('refuses a kind that is none of the three at the door, from the pipe, as before', async () => {
    const res = await post({ kind: 'platform' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.violations.join(' ')).toContain('kind');
    expect(await col('kpms').countDocuments({})).toBe(0);
  });

  /** A source as the request sends it, and the office's record of it; functions, for the ids `beforeEach` makes. */
  type Source = [string, () => Record<string, unknown> | undefined, () => Record<string, unknown>];
  it.each<Source>([
    ['one of the company’s templates', () => ({ kind: 'template', templateId: ownDefault }),
      () => ({ source: 'template', templateId: ownDefault, templateName: 'Prudential template' })],
    ['Template · Default template', () => ({ kind: 'template', templateLibrary: true }),
      () => ({ source: 'template', templateId: LIBRARY_DEFAULT, templateName: 'Default template', companyId: LIBRARY })],
    ['Empty', () => ({ kind: 'empty' }),
      () => ({ source: 'empty', templateId: null, templateName: null })],
    ['nothing: the company’s default template', () => undefined,
      () => ({ source: 'template', templateId: ownDefault, templateName: 'Prudential template' })],
  ])('still takes %s, 201, and records it', async (_label, startFrom, recorded) => {
    const res = await post(startFrom()).expect(201);
    expect(res.body.code).toBe('0417');
    expect(await startedFrom('0417')).toEqual(recorded());
  });

  it.each(EVERY_MEMBER)('refuses %s 403 PERM_DENIED before the source is read', async (_who, ctx) => {
    session.current = ctx;
    const res = await post({ kind: 'defaults' }).expect(403);
    expect(res.body.error.code).toBe('PERM_DENIED');
    expect(await col('kpms').countDocuments({})).toBe(0);
  });
});
