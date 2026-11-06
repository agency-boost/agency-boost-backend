import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { up as templateCompany } from '@/migrations/0037-template-company';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { configModule } from '../../../test/config-module';
import { EVERY_MEMBER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AdminController } from './admin.controller';
import { PlatformReads } from '@/modules/reporting/platform/platform-reads.service';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { KpmRequestService } from './kpm-request.service';
import { TEMPLATE_LIBRARY } from './template-library';
import { TenantService } from './tenant.service';

const NOW = new Date('2026-11-04T03:00:00Z');

/**
 * **The Super Admin's KPM requests and KPMs, over HTTP** (P19-T3; ADR-0191 §2–§5, ADR-0190 §4): *Ganti Owner*'s
 * picker and its refusals, the code checked as it is typed, moving an office to another company, deleting an empty
 * one and removing a request — each refused to every role an office has (the routes are the platform's: an Owner of
 * one office reaches no other's through them) — and the *stellar* clean-up of Q-5 done in these routes alone.
 *
 * `TenantService` and `KpmRequestService` are real, over a real database holding what migration `0037` makes, wired
 * as the application wires them; the controller's other collaborators are inert.
 */
describe('P19-T3 the Super Admin’s requests and KPMs, over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let tenants: TenantService;
  let prudential: string;
  let manulife: string;
  let seq = 0;
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const clock = new FixedClock(NOW);
    const users = wired.users as never;
    // A collection of office data the delete counts, registered as the application registers it.
    mongoose.model(JoinRequest.name, JoinRequestSchema);
    tenants = new TenantService(
      wired.kpms as never, wired.companies as never, users,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.audit, clock,
      new HierarchyService(
        wired.memberships, wired.kpms as never, users,
        new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
        clock, wired.orgLevels,
      ),
      wired.memberships, wired.orgLevels, wired.provisioning, wired.products, wired.campaigns,
      wired.namedTemplates,
    );
    const requests = new KpmRequestService(
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.companies as never, users, tenants,
      wired.audit, clock,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: TenantService, useValue: tenants }, { provide: KpmRequestService, useValue: requests },
        // *Data terakhir* on the offices list (P19.4-T3 AC-8) is the platform reads'; these offices hold no file.
        { provide: PlatformReads, useValue: { dataStatusAcrossTenants: async () => new Map() } },
      ],
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
      'companyTemplates', 'templates', 'kpms', 'users', 'auditLog', 'kpmRequests', 'activityTypes', 'memberships',
      'membershipHistory', 'joinRequests']) {
      await col(name).deleteMany({});
    }
    session.current = SUPER_ADMIN;
    await templateCompany(db(), NOW);
    prudential = String((await tenants.createCompany(SUPER_ADMIN, { name: 'Prudential', slug: 'prudential' }))._id);
    manulife = String((await tenants.createCompany(SUPER_ADMIN, { name: 'Manulife', slug: 'manulife' }))._id);
    // A new company has no template (ADR-0213 §3): each is given its first, which becomes its default.
    for (const [companyId, name] of [[prudential, 'Prudential template'], [manulife, 'Manulife template']]) {
      await wired.templateCopies.importFrom(SUPER_ADMIN, companyId, {
        fromCompanyId: TEMPLATE_LIBRARY.companyId, templateId: TEMPLATE_LIBRARY.defaultTemplateId, name,
      });
    }
  });

  const api = () => request(app.getHttpServer());

  async function account(fullName: string, companyId: string | null, over: Record<string, unknown> = {}) {
    seq += 1;
    const user = await (wired.users as unknown as mongoose.Model<Record<string, unknown>>).create({
      email: `${fullName.toLowerCase().replace(/\W+/g, '.')}@example.test`, passwordHash: 'x', fullName,
      status: 'active', platformRole: 'none', companyId, agentCode: companyId ? String(70000 + seq) : null,
      emailVerifiedAt: NOW, phone: '+62 811 0000 000', ...over,
    });
    return String(user._id);
  }

  async function office(companyId: string, code: string, branchName = 'stellar'): Promise<string> {
    return (await tenants.createKpm(SUPER_ADMIN, { companyId, code, branchName }))._id;
  }

  const live = async (kpmId: string) => col('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpmId) });

  describe('Ganti Owner (AC-5)', () => {
    it('P19-T3 AC-5 finds accounts by name or email, with their company, verification and the offices they hold', async () => {
      const victor = await account('Victor Gunawan', manulife);
      const kpmId = await office(manulife, '3001', 'Kemang');
      await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ userId: victor }).expect(200);
      await account('Victoria Halim', prudential, { emailVerifiedAt: null });
      await account('Root Operator', null, { platformRole: 'super_admin' });

      const byName = await api().get('/api/admin/accounts?q=vic').expect(200);
      expect(byName.body.map((a: { fullName: string }) => a.fullName)).toEqual(['Victor Gunawan', 'Victoria Halim']);
      expect(byName.body[0]).toMatchObject({
        userId: victor, email: 'victor.gunawan@example.test', companyName: 'Manulife', emailVerified: true,
        hasAgentCode: true, offices: [{ kpmId, code: '3001', branchName: 'Kemang', companyName: 'Manulife', isOwner: true }],
      });
      expect(byName.body[1]).toMatchObject({ companyName: 'Prudential', emailVerified: false, offices: [] });

      const byEmail = await api().get('/api/admin/accounts?q=victoria.halim@').expect(200);
      expect(byEmail.body).toHaveLength(1);
      // A Super Admin sells for nobody, and is not offered.
      expect((await api().get('/api/admin/accounts?q=root').expect(200)).body).toEqual([]);
      expect((await api().get('/api/admin/accounts?q=v').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19-T3 AC-5 lists the offices an account is in as they stand: a request to join pending, an office deleted since gone', async () => {
      const rina = await account('Rina Wijaya', prudential);
      const joining = await office(prudential, '1001', 'Kemang');
      const deleted = await office(prudential, '1002', 'Serpong');
      for (const [kpmId, status, code] of [[joining, 'pending', '7101'], [deleted, 'active', '7102']]) {
        await wired.memberships.create(RequestContext.superAdminInTenant('root', kpmId), {
          userId: rina, role: 'agent', status, agentCode: code, agentSeq: 1, leaderCode: `LC${code}`,
          orgLevelId: 'x', orgLevelCode: 'AGENT',
        } as never);
      }
      await col('kpms').updateOne({ _id: new mongoose.Types.ObjectId(deleted) }, { $set: { deletedAt: NOW } });

      const [found] = (await api().get('/api/admin/accounts?q=rina').expect(200)).body;
      expect(found.offices).toEqual([{
        kpmId: joining, code: '1001', branchName: 'Kemang', companyName: 'Prudential', isOwner: false, membershipStatus: 'pending',
      }]);
    });

    it('P19-T3 AC-5 refuses an account of another company, naming both, before anything is written', async () => {
      const kpmId = await office(prudential, '1001');
      const victor = await account('Victor Gunawan', manulife);
      const res = await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ userId: victor }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'TENANT_COMPANY_MISMATCH', details: { userCompanyId: manulife, kpmCompanyId: prudential },
      });
      expect(res.body.error.message).toContain('Victor Gunawan signed up with Manulife');
      expect((await live(kpmId))?.ownerUserId).toBeNull();
      expect(await col('memberships').countDocuments({ kpmId })).toBe(0);
    });

    it('P19-T3 AC-5 refuses an unverified address (ADR-0190 §4), and makes a verified one the Owner', async () => {
      const kpmId = await office(manulife, '1001');
      const unverified = await account('Dewi Lestari', manulife, { emailVerifiedAt: null });
      const res = await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ userId: unverified }).expect(409);
      expect(res.body.error.code).toBe('AUTH_EMAIL_NOT_VERIFIED');

      const victor = await account('Victor Gunawan', manulife);
      const ok = await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ userId: victor }).expect(200);
      expect(ok.body).toMatchObject({ ownerUserId: victor, ownerName: 'Victor Gunawan' });
    });
  });

  describe('the KPM code (AC-2, AC-4)', () => {
    it('P19-T3 AC-2 says whether a code is free in a company, and which office holds it when not', async () => {
      const kpmId = await office(prudential, '1001');
      expect((await api().get(`/api/admin/tenants/code-availability?companyId=${prudential}&code=1001`).expect(200)).body)
        .toEqual({ available: false, takenBy: { kpmId, code: '1001', branchName: 'stellar', companyName: 'Prudential' } });
      // Unique per company (OD-246's default): Manulife's 1001 is free.
      expect((await api().get(`/api/admin/tenants/code-availability?companyId=${manulife}&code=1001`).expect(200)).body)
        .toEqual({ available: true, takenBy: null });
      await api().get('/api/admin/tenants/code-availability?companyId=nope&code=1001').expect(400);
      await api().get(`/api/admin/tenants/code-availability?companyId=${'0'.repeat(24)}&code=1001`).expect(404);
    });

    it('P19-T3 AC-4 TENANT_CODE_TAKEN names the office that holds the code', async () => {
      await office(prudential, '1001');
      const res = await api().post('/api/admin/tenants')
        .send({ companyId: prudential, code: '1001', branchName: 'stellar' }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'TENANT_CODE_TAKEN', message: 'Code 1001 is already used by another KPM at Prudential: KPM 1001 · stellar.',
        details: { code: '1001', branchName: 'stellar', companyName: 'Prudential' },
      });
    });
  });

  describe('Pindahkan ke perusahaan lain (AC-6)', () => {
    it('P19-T3 AC-6 moves an empty office, provisioning it again from the new company’s default template', async () => {
      const kpmId = await office(prudential, '1001');
      const before = await col('activityTypes').countDocuments({ kpmId, deletedAt: null });
      expect(before).toBeGreaterThan(0);

      const res = await api().patch(`/api/admin/tenants/${kpmId}/company`).send({ companyId: manulife }).expect(200);
      expect(res.body).toMatchObject({ _id: kpmId, companyId: manulife, companyName: 'Manulife', code: '1001' });

      const manulifeDefault = (await wired.namedTemplates.list(manulife))[0];
      expect((await live(kpmId))?.startedFrom).toMatchObject({ source: 'template', templateId: manulifeDefault.id });
      // The old configuration retired, a new one live, as many as a new Manulife office has.
      expect(await col('activityTypes').countDocuments({ kpmId, deletedAt: { $ne: null } })).toBe(before);
      expect(await col('activityTypes').countDocuments({ kpmId, deletedAt: null })).toBeGreaterThan(0);
      expect(await col('auditLog').findOne({ action: 'kpm.company_moved' }))
        .toMatchObject({ before: { companyId: prudential }, after: { companyId: manulife } });
    });

    it('P19-T3 AC-6 takes the Owner along, on the new company’s rung of the same code', async () => {
      const kpmId = await office(prudential, '1001');
      const owner = await account('Hendra Wijaya', prudential);
      await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ userId: owner }).expect(200);
      // Their account moved company first (the only way an Owner can move with the office).
      await col('users').updateOne({ _id: new mongoose.Types.ObjectId(owner) }, { $set: { companyId: manulife } });

      await api().patch(`/api/admin/tenants/${kpmId}/company`).send({ companyId: manulife }).expect(200);
      const membership = await col('memberships').findOne({ kpmId, userId: owner });
      const rung = await col('companyOrgLevels').findOne({ companyId: manulife, code: membership?.orgLevelCode });
      expect(String(rung?._id)).toBe(membership?.orgLevelId);
    });

    it('P19-T3 AC-6 a company that is not there — never made, or deleted — is 404, and the office stays where it is', async () => {
      const kpmId = await office(prudential, '1001');
      await col('companies').updateOne({ _id: new mongoose.Types.ObjectId(manulife) }, { $set: { deletedAt: NOW } });
      for (const companyId of [manulife, '0'.repeat(24)]) {
        const res = await api().patch(`/api/admin/tenants/${kpmId}/company`).send({ companyId }).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect((await live(kpmId))?.companyId).toBe(prudential);
      expect(await col('auditLog').countDocuments({ action: 'kpm.company_moved' })).toBe(0);
    });

    it('P19-T3 AC-6 refuses an office with members besides its Owner, with the reason, and writes nothing', async () => {
      const kpmId = await office(prudential, '1001');
      const owner = await account('Hendra Wijaya', prudential);
      await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ userId: owner }).expect(200);
      const agent = await account('Rina Wijaya', prudential);
      await wired.memberships.create(RequestContext.superAdminInTenant('root', kpmId), {
        userId: agent, role: 'agent', status: 'active', agentCode: '1', agentSeq: 2, leaderCode: 'LC2',
        orgLevelId: 'x', orgLevelCode: 'AGENT',
      } as never);

      const res = await api().patch(`/api/admin/tenants/${kpmId}/company`).send({ companyId: manulife }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'TENANT_NOT_EMPTY', details: { members: 1 } });
      expect(res.body.error.message).toContain('1 member besides its Owner');
      expect((await live(kpmId))?.companyId).toBe(prudential);
    });

    it('P19-T3 AC-6 refuses an Owner of the old company, a code taken in the new one, the same company and the Template library', async () => {
      const kpmId = await office(prudential, '1001');
      const owner = await account('Hendra Wijaya', prudential);
      await api().patch(`/api/admin/tenants/${kpmId}/owner`).send({ userId: owner }).expect(200);
      expect((await api().patch(`/api/admin/tenants/${kpmId}/company`).send({ companyId: manulife }).expect(409))
        .body.error.code).toBe('TENANT_COMPANY_MISMATCH');

      const empty = await office(prudential, '2001');
      await office(manulife, '2001', 'Manulife 2001');
      const clash = await api().patch(`/api/admin/tenants/${empty}/company`).send({ companyId: manulife }).expect(409);
      expect(clash.body.error).toMatchObject({ code: 'TENANT_CODE_TAKEN', details: { branchName: 'Manulife 2001' } });

      expect((await api().patch(`/api/admin/tenants/${empty}/company`).send({ companyId: prudential }).expect(400))
        .body.error.code).toBe('VALIDATION_FAILED');
      expect((await api().patch(`/api/admin/tenants/${empty}/company`)
        .send({ companyId: TEMPLATE_LIBRARY.companyId }).expect(409)).body.error.code).toBe('COMPANY_IS_TEMPLATE_LIBRARY');
      expect((await live(empty))?.companyId).toBe(prudential);
    });
  });

  describe('Hapus KPM (AC-7)', () => {
    it('P19-T3 AC-7 counts an empty office’s members and records, deletes it softly, audits it, and frees its code', async () => {
      const kpmId = await office(prudential, '2001');
      expect((await api().get(`/api/admin/tenants/${kpmId}/contents`).expect(200)).body)
        .toEqual({ members: 0, records: 0, deletable: true });

      expect((await api().delete(`/api/admin/tenants/${kpmId}`).expect(200)).body).toEqual({ deleted: true, kpmId });
      expect((await live(kpmId))?.deletedAt).toEqual(NOW);
      expect((await api().get('/api/admin/tenants').expect(200)).body).toEqual([]);
      await api().get(`/api/admin/tenants/${kpmId}`).expect(404);
      expect(await col('auditLog').findOne({ action: 'kpm.deleted' }))
        .toMatchObject({ targetId: kpmId, before: { code: '2001', branchName: 'stellar' } });
      expect(await col('activityTypes').countDocuments({ kpmId, deletedAt: null })).toBe(0);

      // The code is the company's to give again.
      await api().post('/api/admin/tenants').send({ companyId: prudential, code: '2001', branchName: 'Baru' }).expect(201);
    });

    it('P19-T3 AC-7 refuses an office with a member or a record, with the counts — it is archived instead', async () => {
      const owned = await office(prudential, '1001');
      await api().patch(`/api/admin/tenants/${owned}/owner`).send({ userId: await account('Hendra Wijaya', prudential) })
        .expect(200);
      const held = (await api().get(`/api/admin/tenants/${owned}/contents`).expect(200)).body;
      expect(held).toMatchObject({ members: 1, deletable: false });
      const res = await api().delete(`/api/admin/tenants/${owned}`).expect(409);
      expect(res.body.error).toMatchObject({ code: 'TENANT_NOT_EMPTY', details: { members: 1 } });
      expect(res.body.error.message).toContain('Archive it instead.');

      const withData = await office(prudential, '1002');
      await col('joinRequests').insertOne({ kpmId: withData, deletedAt: null });
      expect((await api().get(`/api/admin/tenants/${withData}/contents`).expect(200)).body)
        .toEqual({ members: 0, records: 1, deletable: false });
      await api().delete(`/api/admin/tenants/${withData}`).expect(409);
      expect((await live(withData))?.deletedAt).toBeNull();

      // Archiving stays the way for those (ADR-0191 §5).
      await api().patch(`/api/admin/tenants/${owned}/status`).send({ status: 'archived' }).expect(200);
      await api().delete(`/api/admin/tenants/${'0'.repeat(24)}`).expect(404);
    });
  });

  describe('a request’s Hapus, and approving with the company corrected (AC-2, AC-3, AC-7)', () => {
    it('P19-T3 AC-2 AC-3 approves with the company chosen on the card, and refuses a malformed one at the door', async () => {
      const victor = await account('Victor Gunawan', manulife);
      const requestId = String((await col('kpmRequests').insertOne({
        companyId: prudential, branchName: 'stellar', requestedByUserId: victor, note: null, status: 'pending',
        decidedAt: null, decidedByUserId: null, reason: null, createdKpmId: null, approvingSince: null, deletedAt: null,
        createdAt: NOW, updatedAt: NOW,
      })).insertedId);

      await api().post(`/api/admin/kpm-requests/${requestId}/approve`).send({ code: '1001', companyId: 'x' }).expect(400);
      const res = await api().post(`/api/admin/kpm-requests/${requestId}/approve`)
        .send({ code: '1001', companyId: manulife }).expect(200);
      expect(res.body[0]).toMatchObject({
        status: 'approved', companyName: 'Manulife', createdKpm: { code: '1001', branchName: 'stellar', deleted: false },
      });
    });

    it('P19-T3 AC-7 removes a request', async () => {
      const victor = await account('Victor Gunawan', manulife);
      const requestId = String((await col('kpmRequests').insertOne({
        companyId: manulife, branchName: 'stellar', requestedByUserId: victor, note: null, status: 'pending',
        decidedAt: null, decidedByUserId: null, reason: null, createdKpmId: null, approvingSince: null, deletedAt: null,
      })).insertedId);
      expect((await api().delete(`/api/admin/kpm-requests/${requestId}`).expect(200)).body).toEqual([]);
      await api().delete(`/api/admin/kpm-requests/${requestId}`).expect(404);
    });
  });

  describe('who may (positive and negative, every role an office has)', () => {
    const ID = '66f0000000000000000000a1';
    const routes: Array<[string, () => request.Test]> = [
      ['GET /admin/accounts', () => api().get('/api/admin/accounts?q=victor')],
      ['GET /admin/tenants/code-availability', () => api().get(`/api/admin/tenants/code-availability?companyId=${ID}&code=1001`)],
      ['PATCH /admin/tenants/:id/company', () => api().patch(`/api/admin/tenants/${ID}/company`).send({ companyId: ID })],
      ['GET /admin/tenants/:id/contents', () => api().get(`/api/admin/tenants/${ID}/contents`)],
      ['DELETE /admin/tenants/:id', () => api().delete(`/api/admin/tenants/${ID}`)],
      ['DELETE /admin/kpm-requests/:id', () => api().delete(`/api/admin/kpm-requests/${ID}`)],
      ['POST /admin/kpm-requests/:id/approve', () => api().post(`/api/admin/kpm-requests/${ID}/approve`).send({ code: '1001' })],
    ];

    it.each(routes)('P19-T3 %s is refused 403 to every role an office has — its Owner of this very office included', async (_route, call) => {
      for (const [, who] of EVERY_MEMBER) {
        session.current = who;
        const res = await call().expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
      }
    });

    it.each(routes)('P19-T3 %s reaches the service for the Super Admin', async (_route, call) => {
      session.current = SUPER_ADMIN;
      // Past the guard: the service answers — a 200, or the 404 of an id that is nobody's.
      const res = await call();
      expect([200, 404]).toContain(res.status);
    });
  });

  it('P19-T3 AC-9 the stellar clean-up is done in these routes: 1001 to Manulife with Victor Gunawan as Owner; 2001 deleted', async () => {
    // Production on 4 November (UI-165): two ownerless "stellar · Prudential" offices, and Victor's request as Prudential.
    const k1001 = await office(prudential, '1001');
    const k2001 = await office(prudential, '2001');
    const victor = await account('Victor Gunawan', manulife);
    const requestId = String((await col('kpmRequests').insertOne({
      companyId: prudential, branchName: 'stellar', requestedByUserId: victor, note: null, status: 'pending',
      decidedAt: null, decidedByUserId: null, reason: null, createdKpmId: null, approvingSince: null, deletedAt: null,
    })).insertedId);

    // 1. Hapus KPM on 2001: empty, so deletable.
    expect((await api().get(`/api/admin/tenants/${k2001}/contents`).expect(200)).body.deletable).toBe(true);
    await api().delete(`/api/admin/tenants/${k2001}`).expect(200);
    // 2. Pindahkan ke perusahaan lain: 1001 to Manulife.
    await api().patch(`/api/admin/tenants/${k1001}/company`).send({ companyId: manulife }).expect(200);
    // 3. Ganti Owner: Victor, found by name.
    const [found] = (await api().get('/api/admin/accounts?q=victor').expect(200)).body;
    await api().patch(`/api/admin/tenants/${k1001}/owner`).send({ userId: found.userId }).expect(200);
    // 4. Hapus the request the office now answers.
    await api().delete(`/api/admin/kpm-requests/${requestId}`).expect(200);

    const all = (await api().get('/api/admin/tenants').expect(200)).body;
    expect(all.map((k: Record<string, unknown>) => [k.code, k.branchName, k.companyName, k.ownerName]))
      .toEqual([['1001', 'stellar', 'Manulife', 'Victor Gunawan']]);
    expect((await api().get('/api/admin/kpm-requests').expect(200)).body).toEqual([]);
  });
});
