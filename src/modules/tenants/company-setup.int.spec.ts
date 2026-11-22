import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { up as templateCompany } from '@/migrations/0037-template-company';
import {
  AAB, AB, ADMIN, AGENT, OWNER, SUPER_ADMIN, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { configModule } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { CompanySetupController } from './company-setup.controller';
import { CompanySetupService } from './company-setup.service';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { TEMPLATE_LIBRARY } from './template-library';
import { TenantService } from './tenant.service';

const NOW = new Date('2026-11-20T03:00:00Z');
const LIBRARY = TEMPLATE_LIBRARY.companyId;

/**
 * ***Perusahaan baru*** over HTTP (P19.23-T4 AC-1; ADR-0278 §3): a new company starts from the Default template or a
 * copy of another company — its ladder, carrier rules and default template, never its products — behind the real
 * `PermissionsGuard` and the production pipe, over a database holding what migration `0037` makes.
 */
describe('P19.23-T4 AC-1 Perusahaan baru from the Default template or a copy', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let tenants: TenantService;
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const clock = new FixedClock(NOW);
    const users = wired.users as never;
    tenants = new TenantService(
      wired.kpms as never, wired.companies as never, users,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.audit, clock,
      new HierarchyService(
        wired.memberships, wired.kpms as never, users,
        new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
        clock, wired.orgLevels,
      ),
      wired.memberships, wired.orgLevels, wired.provisioning, wired.products, wired.campaigns, wired.namedTemplates,
    );
    const setup = new CompanySetupService(
      wired.companies as never, tenants, wired.namedTemplates, wired.templateCopies, wired.audit,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [CompanySetupController],
      providers: [{ provide: CompanySetupService, useValue: setup }],
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
    for (const name of ['companies', 'companyOrgLevels', 'products', 'companyTemplates', 'templates', 'auditLog']) {
      await col(name).deleteMany({});
    }
    session.current = SUPER_ADMIN;
    await templateCompany(db(), NOW);
  });

  const rungsOf = async (companyId: string) =>
    (await col('companyOrgLevels').find({ companyId, status: 'active', deletedAt: null }).sort({ displayOrder: 1 }).toArray())
      .map((r) => r.code);
  const defaultOf = (companyId: string) => col('templates').findOne({ companyId, isDefault: true, deletedAt: null });

  it('P19.23-T4 AC-1 from the Default template: its ladder and its default template as the new default, no products', async () => {
    const { body } = await http().post('/admin/companies/setup')
      .send({ name: 'AIA Financial', slug: 'aia-financial', from: 'default' }).expect(201);
    const id = String(body._id);
    expect(body).toMatchObject({ name: 'AIA Financial', kind: 'insurer', startedBlank: false, templateId: expect.any(String) });
    expect(await rungsOf(id)).toEqual(await rungsOf(LIBRARY));
    const template = await defaultOf(id);
    expect(String(template!._id)).toBe(body.templateId);
    expect(template!.origin).toMatchObject({ kind: 'import', companyId: LIBRARY });
    // Each kind the Default template published is the new company's version 1.
    expect(await col('companyTemplates').countDocuments({ companyId: id, templateId: body.templateId, status: 'published' }))
      .toBeGreaterThan(0);
    expect(await col('products').countDocuments({ companyId: id })).toBe(0);
    expect(await col('auditLog').findOne({ action: 'company.set_up', targetId: id })).toMatchObject({
      after: { from: 'default', source: { companyId: LIBRARY } },
    });
  });

  it('P19.23-T4 AC-1 a copy of another company: its own ladder and default template, never its products', async () => {
    const first = await http().post('/admin/companies/setup')
      .send({ name: 'Prudential', slug: 'prudential', from: 'default' }).expect(201);
    const prudential = String(first.body._id);
    await col('companyOrgLevels').insertOne({
      companyId: prudential, code: 'UM', label: 'Unit Manager', displayOrder: 2.5, leaderTier: 'associate',
      status: 'active', archivedAt: null, deletedAt: null,
    });
    await wired.products.create(SUPER_ADMIN, prudential, { code: 'PRUSEHAT', name: 'PRUSehat', channel: 'conventional', category: 'health' });

    const { body } = await http().post('/admin/companies/setup')
      .send({ name: 'Sejahtera Baru Life', slug: 'sejahtera', from: 'company', fromCompanyId: prudential }).expect(201);
    const id = String(body._id);
    expect(await rungsOf(id)).toEqual(await rungsOf(prudential));
    expect((await defaultOf(id))!.origin).toMatchObject({ kind: 'import', companyId: prudential });
    expect(await col('products').countDocuments({ companyId: id })).toBe(0);
  });

  it('P19.23-T4 AC-1 refuses the Default template named as a company, an unknown company, a missing source and a taken slug', async () => {
    await http().post('/admin/companies/setup')
      .send({ name: 'X Life', slug: 'x-life', from: 'company', fromCompanyId: LIBRARY }).expect(400);
    await http().post('/admin/companies/setup')
      .send({ name: 'X Life', slug: 'x-life', from: 'company', fromCompanyId: '66f0000000000000000000ff' }).expect(404);
    await http().post('/admin/companies/setup').send({ name: 'X Life', slug: 'x-life', from: 'company' }).expect(400);
    await http().post('/admin/companies/setup').send({ name: 'X Life', slug: 'X Life', from: 'default' }).expect(400);
    await http().post('/admin/companies/setup').send({ name: 'X Life', slug: 'x-life', from: 'nothing' }).expect(400);
    // Nothing was made by any refusal.
    expect(await col('companies').countDocuments({ slug: 'x-life' })).toBe(0);

    await http().post('/admin/companies/setup').send({ name: 'AIA', slug: 'aia', from: 'default' }).expect(201);
    const taken = await http().post('/admin/companies/setup').send({ name: 'AIA 2', slug: 'aia', from: 'default' }).expect(409);
    expect(taken.body.error.code).toBe('COMPANY_SLUG_TAKEN');
  });

  it.each([
    ['an Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
  ])('P19.23-T4 AC-1 refuses %s', async (_who, who) => {
    session.current = who;
    await http().post('/admin/companies/setup').send({ name: 'AIA', slug: 'aia', from: 'default' }).expect(403);
    expect(await col('companies').countDocuments({ slug: 'aia' })).toBe(0);
  });
});
