import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, AGENT, FIXTURE_KPM, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { ProductDataAccess } from './product-data-access.service';
import { ProductDataCompaniesService } from './product-data-companies.service';
import { ProductDataCompaniesController, ProductDataGrantController } from './product-data-grant.controller';
import { ProductDataGrant, ProductDataGrantSchema } from './product-data-grant.schema';
import { ProductDataGrantService } from './product-data-grant.service';

const NOW = new Date('2026-11-12T03:00:00Z');
const PRU = '66f0000000000000000000c1';
const MANU = '66f0000000000000000000c2';
const TEMPLATE_CO = '66f0000000000000000000c3';
const KPM_B = '66f0000000000000000000b1';
const ROOT_ID = '66f0000000000000000000e1';
const MAYA = '66f0000000000000000000e2';
const MAYA_MEMBERSHIP = '66f0000000000000000000d2';
const OWNER = '66f0000000000000000000e3';
const AGENT_ID = '66f0000000000000000000e4';
const REMOVED_ADMIN = '66f0000000000000000000e5';
const PCB88 = '66f0000000000000000000d1';
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** A KPM Admin of `FIXTURE_KPM` (a Prudential office), with the companies her grant ticks on her context. */
const admin = (companies: string[] = [], userId = MAYA, impersonatedBy: string | null = null) => new RequestContext(
  userId, 'none',
  {
    membershipId: 'mem-maya', kpmId: FIXTURE_KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
    isKpmOwner: false, isKpmAdmin: true, directCount: 0,
  },
  impersonatedBy, null, false, impersonatedBy !== null, undefined, companies,
);
const owner = (companies: string[] = []) => new RequestContext(
  OWNER, 'none',
  {
    membershipId: 'mem-owner', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  },
  null, null, false, false, undefined, companies,
);

/**
 * **P19.15-T4 AC-2, AC-3 — *Kelola data produk*, over HTTP** (ADR-0260; the P1b spec's *Who can do what*, *Giving
 * access*, *Rules*): the Super Admin gives it to a KPM Owner or KPM Admin for ticked insurers, changes them, removes it;
 * *Perubahan oleh pengelola* lists what holders changed; `GET /product-data/companies` answers each reader the companies
 * *Data produk* opens — the grant holder's ticked ones in full, an Owner's or Admin's own read-only, an agent nothing.
 * The services are real over a real database, with the deployed pipe and the real permission and view-only guards.
 */
describe('P19.15-T4 Kelola data produk over HTTP', () => {
  let app: INestApplication;
  const db = () => mongoose.connection.db!;
  const grants = () => mongoose.model(ProductDataGrant.name, ProductDataGrantSchema);

  beforeAll(async () => {
    await startMongo();
    const model = (name: string, schema: mongoose.Schema) => mongoose.model(name, schema) as never;
    const companies = model(Company.name, CompanySchema);
    const kpms = model(Kpm.name, KpmSchema);
    const service = new ProductDataGrantService(
      model(ProductDataGrant.name, ProductDataGrantSchema), model(User.name, UserSchema), companies, kpms,
      model(Product.name, ProductSchema), new MembershipRepository(model(Membership.name, MembershipSchema)),
      new AuditService(model(AuditLog.name, AuditLogSchema)), new FixedClock(NOW),
    );
    const readable = new ProductDataCompaniesService(companies, kpms, new ProductDataAccess(companies, kpms));

    const moduleRef = await Test.createTestingModule({
      controllers: [ProductDataGrantController, ProductDataCompaniesController],
      providers: [
        { provide: ProductDataGrantService, useValue: service },
        { provide: ProductDataCompaniesService, useValue: readable },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(reflector), new PermissionsGuard(reflector));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['users', 'companies', 'kpms', 'memberships', 'products', 'auditLog']) {
      await db().collection(name).deleteMany({});
    }
    session.current = SUPER_ADMIN;
    await db().collection('users').insertMany([
      { _id: oid(ROOT_ID), email: 'root@agencyboost.test', fullName: 'Superadmin', platformRole: 'super_admin', deletedAt: null },
      { _id: oid(MAYA), email: 'maya@kpm0417.test', fullName: 'Maya Sari', platformRole: 'none', deletedAt: null },
      { _id: oid(OWNER), email: 'owner@kpm0417.test', fullName: 'Budi Owner', platformRole: 'none', deletedAt: null },
      { _id: oid(AGENT_ID), email: 'agent@kpm0417.test', fullName: 'Rina Agent', platformRole: 'none', deletedAt: null },
      { _id: oid(REMOVED_ADMIN), email: 'ex@kpm0417.test', fullName: 'Ex Admin', platformRole: 'none', deletedAt: null },
    ]);
    await db().collection('companies').insertMany([
      { _id: oid(PRU), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null },
      { _id: oid(MANU), name: 'Manulife', slug: 'manulife', kind: 'insurer', deletedAt: null },
      { _id: oid(TEMPLATE_CO), name: 'Template library', slug: 'template', kind: 'template', deletedAt: null },
    ]);
    await db().collection('kpms').insertMany([
      { _id: oid(FIXTURE_KPM), companyId: PRU, code: '0417', branchName: 'Bandung', ownerUserId: OWNER, status: 'active', deletedAt: null },
      { _id: oid(KPM_B), companyId: MANU, code: '0900', branchName: 'Medan', ownerUserId: null, status: 'active', deletedAt: null },
    ]);
    const membership = (userId: string, over: Record<string, unknown>) => ({
      kpmId: FIXTURE_KPM, userId, status: 'active', role: 'agent', deletedAt: null, adminAccess: { isKpmAdmin: false },
      // Unique across every office, as every membership's is (`memberships.leaderCode`'s index).
      leaderCode: `LC-${userId.slice(-4)}`, ...over,
    });
    await db().collection('memberships').insertMany([
      membership(MAYA, { _id: oid(MAYA_MEMBERSHIP), adminAccess: { isKpmAdmin: true, grantedAt: NOW } }),
      membership(OWNER, { role: 'ab' }),
      membership(AGENT_ID, {}),
      membership(REMOVED_ADMIN, { status: 'removed', adminAccess: { isKpmAdmin: true } }),
    ]);
    await db().collection('products').insertOne({ _id: oid(PCB88), companyId: PRU, code: 'PCB88', name: 'PRUCritical Benefit 88' });
  });

  const api = () => request(app.getHttpServer());
  const put = (userId: string, companyIds: unknown) => api().put(`/api/admin/product-data-grants/${userId}`).send({ companyIds });

  describe('giving, changing and removing it', () => {
    it('P19.15-T4 AC-2 the Super Admin gives a KPM Admin Kelola data produk for Prudential, audited before and after', async () => {
      const body = (await put(MAYA, [PRU]).expect(200)).body;
      expect(body).toMatchObject({
        userId: MAYA, fullName: 'Maya Sari', kpmId: FIXTURE_KPM, kpmLabel: 'KPM 0417 — Bandung', holds: true,
        companies: [{ companyId: PRU, name: 'Prudential' }], grantedByName: null,
      });
      const audit = await db().collection('auditLog').find({ action: 'product_data_grant.granted' }).toArray();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: 'root', before: null, after: { userId: MAYA, companyIds: [PRU] } });
      expect((await api().get('/api/admin/product-data-grants').expect(200)).body.map((r: { userId: string }) => r.userId))
        .toEqual([MAYA]);
    });

    it('P19.15-T4 AC-2 ticking another insurer changes the live grant, once; the same insurers again change nothing', async () => {
      await put(MAYA, [PRU]).expect(200);
      const changed = (await put(MAYA, [MANU, PRU]).expect(200)).body;
      expect(changed.companies.map((c: { name: string }) => c.name)).toEqual(['Manulife', 'Prudential']);
      await put(MAYA, [PRU, MANU]).expect(200);
      expect(await grants().countDocuments({ userId: MAYA })).toBe(1);
      const changes = await db().collection('auditLog').find({ action: 'product_data_grant.changed' }).toArray();
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ before: { companyIds: [PRU] }, after: { companyIds: [MANU, PRU] } });
    });

    it('P19.15-T4 AC-2 the Owner may be given it too', async () => {
      expect((await put(OWNER, [MANU]).expect(200)).body).toMatchObject({ userId: OWNER, holds: true });
    });

    it('P19.15-T4 AC-2 removing it writes revokedAt, keeps the row, audits it, and a second removal is 404', async () => {
      await put(MAYA, [PRU]).expect(200);
      expect((await api().delete(`/api/admin/product-data-grants/${MAYA}`).expect(200)).body)
        .toEqual({ userId: MAYA, revokedAt: NOW.toISOString() });
      const row = await grants().findOne({ userId: MAYA }).lean();
      expect(row).toMatchObject({ revokedAt: NOW, revokedBy: 'root', companyIds: [PRU] });
      expect(await db().collection('auditLog').countDocuments({ action: 'product_data_grant.revoked' })).toBe(1);
      expect((await api().get('/api/admin/product-data-grants').expect(200)).body).toEqual([]);
      const again = await api().delete(`/api/admin/product-data-grants/${MAYA}`).expect(404);
      expect(again.body.error.code).toBe('NOT_FOUND');
      // Given again after a removal: a new row.
      await put(MAYA, [MANU]).expect(200);
      expect(await grants().countDocuments({ userId: MAYA })).toBe(2);
    });

    it('P19.15-T4 AC-2 refuses an empty list, a repeated id, a malformed id and a company that is not an insurer', async () => {
      expect((await put(MAYA, []).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await put(MAYA, [PRU, PRU]).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await put(MAYA, ['nope']).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await put(MAYA, 'x').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      const template = (await put(MAYA, [TEMPLATE_CO]).expect(400)).body.error;
      expect(template).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'companyIds', companyId: TEMPLATE_CO } });
      expect((await put(MAYA, ['66f0000000000000000000cf']).expect(400)).body.error.details.companyId)
        .toBe('66f0000000000000000000cf');
      expect(await grants().countDocuments()).toBe(0);
    });

    it('P19.15-T4 AC-2 only a KPM Owner or Admin may hold it: an agent, a removed Admin, a Super Admin are 409', async () => {
      for (const userId of [AGENT_ID, REMOVED_ADMIN, ROOT_ID]) {
        const refused = (await put(userId, [PRU]).expect(409)).body.error;
        expect(refused).toMatchObject({ code: 'PRODUCT_DATA_GRANT_NOT_ELIGIBLE', details: { userId } });
      }
      expect((await put('66f0000000000000000000ef', [PRU]).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await put('not-an-id', [PRU]).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect(await grants().countDocuments()).toBe(0);
    });

    it('P19.15-T4 AC-2 a grant kept for somebody no longer an Admin is listed as holding nothing', async () => {
      await put(MAYA, [PRU]).expect(200);
      await db().collection('memberships').updateOne({ userId: MAYA }, { $set: { 'adminAccess.isKpmAdmin': false } });
      const rows = (await api().get('/api/admin/product-data-grants').expect(200)).body;
      expect(rows[0]).toMatchObject({ userId: MAYA, holds: false, kpmId: null, kpmLabel: null });
    });

    it.each([
      ['the Owner', owner()], ['an Admin holding the grant', admin([PRU])], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT],
    ])('P19.15-T4 AC-2 refuses %s every grant route, 403', async (_name, who) => {
      session.current = who;
      await api().get('/api/admin/product-data-grants').expect(403);
      await api().get('/api/admin/product-data-grants/changes').expect(403);
      await put(MAYA, [PRU]).expect(403);
      await api().delete(`/api/admin/product-data-grants/${MAYA}`).expect(403);
      expect(await grants().countDocuments()).toBe(0);
    });

    it('P19.15-T4 AC-2 a support session gives and removes nothing', async () => {
      session.current = admin([PRU], MAYA, 'root');
      expect((await put(OWNER, [PRU]).expect(403)).body.error.code).toBe('IMPERSONATION_READ_ONLY');
      expect((await api().delete(`/api/admin/product-data-grants/${MAYA}`).expect(403)).body.error.code)
        .toBe('IMPERSONATION_READ_ONLY');
    });
  });

  describe('Perubahan oleh pengelola', () => {
    async function write(minutesAgo: number, over: Record<string, unknown>) {
      const createdAt = new Date(NOW.getTime() - minutesAgo * 60_000);
      await db().collection('auditLog').insertOne({
        // In the platform's log, as `recordForCompany` writes it; the office is read off the holder's membership.
        kpmId: null, actorUserId: MAYA, actorMembershipId: MAYA_MEMBERSHIP, effectiveUserId: null, action: 'rate_table.activated',
        targetCollection: 'rateTables', targetId: '66f0000000000000000000f1',
        before: null, after: { companyId: PRU, productId: PCB88, version: 2 }, createdAt, updatedAt: createdAt, ...over,
      });
    }

    it('P19.15-T4 AC-2 lists every product data change by a holder, named, newest first — and nothing else', async () => {
      await put(MAYA, [PRU]).expect(200);
      await write(30, {});
      await write(20, { action: 'intake.applied', targetCollection: 'intakeItems', after: { companyId: PRU, productId: null } });
      // Not listed: the Super Admin's own change, a holder's change to something else, and an agent's.
      await write(10, { actorUserId: 'root', kpmId: null });
      await write(5, { action: 'lead.created', targetCollection: 'leads' });
      await write(3, { actorUserId: AGENT_ID });
      const page = (await api().get('/api/admin/product-data-grants/changes').expect(200)).body;
      expect(page.items.map((r: { action: string }) => r.action)).toEqual(['intake.applied', 'rate_table.activated']);
      expect(page.items[1]).toMatchObject({
        actorUserId: MAYA, actorName: 'Maya Sari', kpmId: FIXTURE_KPM, officeLabel: 'KPM 0417 · Bandung',
        companyId: PRU, companyName: 'Prudential', productId: PCB88, productName: 'PRUCritical Benefit 88',
        targetCollection: 'rateTables', targetId: '66f0000000000000000000f1',
      });
      expect(page.page).toMatchObject({ nextCursor: null, hasMore: false, limit: 50 });
    });

    it('P19.15-T4 AC-2 keeps listing a holder\'s changes after the grant is removed', async () => {
      await put(MAYA, [PRU]).expect(200);
      await write(30, {});
      await api().delete(`/api/admin/product-data-grants/${MAYA}`).expect(200);
      expect((await api().get('/api/admin/product-data-grants/changes').expect(200)).body.items).toHaveLength(1);
    });

    it('P19.15-T4 AC-2 pages fifty at a time with a cursor, and refuses a cursor it did not write', async () => {
      await put(MAYA, [PRU]).expect(200);
      for (let i = 0; i < 55; i += 1) await write(100 - i, { targetId: `t-${i}` });
      const first = (await api().get('/api/admin/product-data-grants/changes').expect(200)).body;
      expect(first.items).toHaveLength(50);
      expect(first.page.hasMore).toBe(true);
      const second = (await api().get(`/api/admin/product-data-grants/changes?cursor=${first.page.nextCursor}`).expect(200)).body;
      expect(second.items).toHaveLength(5);
      expect(second.page.nextCursor).toBeNull();
      expect((await api().get('/api/admin/product-data-grants/changes?cursor=bm9wZQ').expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
    });

    it('P19.15-T4 AC-2 is empty while nobody has ever held the grant', async () => {
      await write(30, {});
      expect((await api().get('/api/admin/product-data-grants/changes').expect(200)).body.items).toEqual([]);
    });
  });

  describe('GET /product-data/companies — what Data produk opens', () => {
    const readable = async () => (await api().get('/api/product-data/companies').expect(200)).body.items;

    it('P19.15-T4 AC-2 a holder: her own company and each ticked insurer, in full where ticked', async () => {
      session.current = admin([PRU, MANU]);
      expect(await readable()).toEqual([
        { companyId: PRU, name: 'Prudential', canManage: true, own: true },
        { companyId: MANU, name: 'Manulife', canManage: true, own: false },
      ]);
    });

    it('P19.15-T4 AC-2 a holder for another insurer only: that one in full, her own read-only', async () => {
      session.current = admin([MANU]);
      expect(await readable()).toEqual([
        { companyId: PRU, name: 'Prudential', canManage: false, own: true },
        { companyId: MANU, name: 'Manulife', canManage: true, own: false },
      ]);
    });

    it('P19.15-T4 AC-3 an Owner or Admin without it: their own company, read-only', async () => {
      for (const who of [owner(), admin([])]) {
        session.current = who;
        expect(await readable()).toEqual([{ companyId: PRU, name: 'Prudential', canManage: false, own: true }]);
      }
    });

    it('P19.15-T4 AC-2 removal takes effect at once: the next request answers the own company read-only', async () => {
      session.current = admin([PRU]);
      expect((await readable())[0].canManage).toBe(true);
      // The resolver reads the grant on every request; a context built after the removal carries none.
      session.current = admin([]);
      expect(await readable()).toEqual([{ companyId: PRU, name: 'Prudential', canManage: false, own: true }]);
    });

    it('P19.15-T4 AC-2 the Super Admin: every insurer, in full, never the Template library', async () => {
      expect((await readable()).map((c: { name: string; canManage: boolean }) => [c.name, c.canManage]))
        .toEqual([['Manulife', true], ['Prudential', true]]);
    });

    it('P19.15-T4 AC-2 a support session as the holder only looks', async () => {
      session.current = admin([PRU], MAYA, 'root');
      expect(await readable()).toEqual([{ companyId: PRU, name: 'Prudential', canManage: false, own: true }]);
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]])('P19.15-T4 AC-3 refuses %s, 403', async (_n, who) => {
      session.current = who;
      expect((await api().get('/api/product-data/companies').expect(403)).body.error.code).toBe('PERM_DENIED');
    });
  });
});
