import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { PLATFORM_READ } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth,
} from '../../../../test/http-permissions';
import { listenOnLoopback } from '../../../../test/listen';
import { startMongo, stopMongo } from '../../../../test/mongo';
import { PlatformPeopleController } from './platform-people.controller';
import { PlatformReadsController } from './platform-reads.controller';
import { PlatformReads } from './platform-reads.service';
import { TestAccounts } from './test-accounts.service';

const NOW = new Date('2026-11-20T05:00:00Z');
const PRUDENTIAL = '66f0000000000000000001c1';
const SEJAHTERA = '66f0000000000000000001c2';
const BSD = '66f0000000000000000001a1';
const CEMPAKA = '66f0000000000000000001b1';

const U = {
  WILSON: '66f00000000000000000ab01',
  SARI: '66f00000000000000000ab02',
  RINA: '66f00000000000000000ab03',
  HADI: '66f00000000000000000ab04',
  TES: '66f00000000000000000ab05',
  DUA: '66f00000000000000000ab06',
  ROOT: '66f00000000000000000ab90',
} as const;
const M = {
  WILSON: '66f00000000000000000ac01',
  SARI: '66f00000000000000000ac02',
  RINA: '66f00000000000000000ac03',
  HADI: '66f00000000000000000ac04',
  TES: '66f00000000000000000ac05',
  DUA_BSD: '66f00000000000000000ac06',
  DUA_CEMPAKA: '66f00000000000000000ac07',
} as const;

/** The Super Admin, with an account of their own so the audit names somebody. */
const ROOT = RequestContext.platform(U.ROOT);
/** A support session: a Super Admin acting as the Owner of BSD City Branch. */
const SUPPORT = new RequestContext(OWNER.userId, 'none', OWNER.membership, U.ROOT, null, false, true);
const TENANT_ROLES = [['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]] as const;

/**
 * ***Anggota* over HTTP** (P19.23-T3 AC-1; the Super Admin spec of 20 November 2026, §6; ADR-0277; OD-421): the real
 * guard, pipe and reads over a database of two companies — the list (test accounts left out, *Akun tes* alone on asking,
 * the class tab, the photo, `kpmCount`), the detail with the phone and the email, audited per read, and the *Akun tes*
 * switch writing the account and every membership's copy together. The Super Admin's alone: every tenant role and a
 * support session refused.
 */
describe('P19.23-T3 Anggota — every member of every KPM, a detail and the Akun tes switch (ADR-0277)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const asSuperAdmin = () => { session.current = ROOT; };
  const mark = async (): Promise<mongoose.mongo.ObjectId | null> =>
    ((await db().collection('auditLog').find({}).sort({ _id: -1 }).limit(1).next())?._id as mongoose.mongo.ObjectId) ?? null;
  const since = async (at: mongoose.mongo.ObjectId | null, action?: string) => db().collection('auditLog').find({
    ...(at ? { _id: { $gt: at } } : {}), ...(action ? { action } : {}),
  }).toArray();
  const names = (res: request.Response) => res.body.rows.map((r: { fullName: string }) => r.fullName);

  beforeAll(async () => {
    await startMongo();
    const model = <T>(name: string, schema: mongoose.Schema<T>) => mongoose.models[name] ?? mongoose.model(name, schema);
    const users = model(User.name, UserSchema);
    const companies = model(Company.name, CompanySchema);
    const kpms = model(Kpm.name, KpmSchema);
    const memberships = model(Membership.name, MembershipSchema);
    const audit = new AuditService(model(AuditLog.name, AuditLogSchema) as never);

    await db().collection('companies').insertMany([
      { _id: oid(PRUDENTIAL), name: 'Prudential', slug: 'prudential-anggota', deletedAt: null },
      { _id: oid(SEJAHTERA), name: 'Sejahtera Baru Life', slug: 'sejahtera-anggota', deletedAt: null },
    ]);
    await db().collection('kpms').insertMany([
      { _id: oid(BSD), companyId: PRUDENTIAL, code: '0417', branchName: 'BSD City Branch', timezone: 'Asia/Jakarta',
        ownerUserId: U.WILSON, status: 'active', deletedAt: null },
      { _id: oid(CEMPAKA), companyId: SEJAHTERA, code: '0701', branchName: 'Cempaka Putih Branch', timezone: 'Asia/Jakarta',
        ownerUserId: U.HADI, status: 'active', deletedAt: null },
    ]);
    const account = (id: string, fullName: string, over: Record<string, unknown> = {}) => ({
      _id: oid(id), email: `${fullName.split(' ')[0].toLowerCase()}@contoh.test`, fullName, passwordHash: 'x',
      platformRole: 'none', status: 'active', phone: '+6281234567890', testAccount: false, avatarUrl: null,
      lastLoginAt: null, createdAt: NOW, updatedAt: NOW, deletedAt: null, ...over,
    });
    await db().collection('users').insertMany([
      account(U.WILSON, 'Wilson Tanoto', { avatarUrl: 'user/wilson/avatar.jpg', phone: '+6281211112222' }),
      account(U.SARI, 'Sari Puspita'),
      account(U.RINA, 'Rina Kurnia', { phone: null }),
      account(U.HADI, 'Hadi Gunawan'),
      account(U.TES, 'Tes Impor Satu', { testAccount: true }),
      account(U.DUA, 'Dua Kantor'),
      account(U.ROOT, 'Dina Kusuma', { platformRole: 'super_admin' }),
    ]);
    const membership = (id: string, userId: string, kpmId: string, role: 'ab' | 'aab' | 'agent', over: Record<string, unknown> = {}) => ({
      _id: oid(id), kpmId, userId, agentCode: `A-${id.slice(-4)}`, leaderCode: `L-${id.slice(-4)}`, role,
      orgLevelCode: role.toUpperCase(), status: 'active', leaderId: null, testAccount: false, joinDate: '2024-03-01',
      deletedAt: null, ...over,
    });
    await db().collection('memberships').insertMany([
      membership(M.WILSON, U.WILSON, BSD, 'ab'),
      membership(M.SARI, U.SARI, BSD, 'aab', { leaderId: M.WILSON }),
      membership(M.RINA, U.RINA, BSD, 'agent', { leaderId: M.SARI }),
      membership(M.HADI, U.HADI, CEMPAKA, 'ab'),
      membership(M.TES, U.TES, BSD, 'agent', { leaderId: M.SARI, testAccount: true }),
      membership(M.DUA_BSD, U.DUA, BSD, 'agent', { leaderId: M.WILSON }),
      membership(M.DUA_CEMPAKA, U.DUA, CEMPAKA, 'agent', { leaderId: M.HADI }),
    ]);

    const ladder = [
      { code: 'AGENT', label: 'Agent' }, { code: 'AAB', label: 'Associate Agency Builder' }, { code: 'AB', label: 'Agency Builder' },
    ];
    const orgLevels = { laddersByCompany: async (ids: string[]) => new Map(ids.map((id) => [id, ladder])) };
    const activity = {
      lastLoggedOnMany: async (_ctx: unknown, ids: string[]) => new Map(ids.filter((id) => id === M.WILSON).map((id) => [id, '2026-11-20'])),
    };
    const avatarLinks = {
      linksFor: async (keys: (string | null)[]) => new Map(keys.filter((k): k is string => Boolean(k)).map((k) => [k, `https://signed.test/${k}`])),
    };
    const repo = new MembershipRepository(memberships as never);
    const reads = new PlatformReads(
      kpms as never, companies as never, users as never, repo, orgLevels as never, activity as never,
      // What *Anggota* never reads: the per-KPM figures.
      null as never, null as never,
      audit, new FixedClock(NOW), avatarLinks as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformReadsController, PlatformPeopleController],
      providers: [
        { provide: PlatformReads, useValue: reads },
        { provide: TestAccounts, useValue: new TestAccounts(users as never, repo, audit) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  describe('P19.23-T3 AC-1 the list', () => {
    it('P19.23-T3 AC-1 leaves test accounts out of the rows and the counts, and says how many KPMs', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').expect(200);
      expect(names(res)).toEqual(['Dua Kantor', 'Dua Kantor', 'Hadi Gunawan', 'Rina Kurnia', 'Sari Puspita', 'Wilson Tanoto']);
      expect(res.body).toMatchObject({ total: 6, kpmCount: 2, page: 1, pageSize: PLATFORM_READ.PAGE_SIZE });
    });

    it('P19.23-T3 AC-1 Akun tes lists the test accounts alone, each saying so (OD-421)', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ testAccount: 'only' }).expect(200);
      expect(res.body.rows).toEqual([expect.objectContaining({ fullName: 'Tes Impor Satu', testAccount: true })]);
      expect(res.body).toMatchObject({ total: 1, kpmCount: 1 });
    });

    it('P19.23-T3 AC-1 the AB · AAB · Agent tabs are the rung’s class', async () => {
      asSuperAdmin();
      expect(names(await http().get('/admin/members').query({ role: 'aab' }).expect(200))).toEqual(['Sari Puspita']);
      expect(names(await http().get('/admin/members').query({ role: 'ab' }).expect(200))).toEqual(['Hadi Gunawan', 'Wilson Tanoto']);
    });

    it('P19.23-T3 AC-1 a row: the person, the photo as a signed link, the class, Owner, the KPM and its company — no phone, no email', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ q: 'wilson' }).expect(200);
      expect(res.body.rows).toEqual([expect.objectContaining({
        membershipId: M.WILSON, userId: U.WILSON, fullName: 'Wilson Tanoto',
        avatarUrl: 'https://signed.test/user/wilson/avatar.jpg',
        company: { id: PRUDENTIAL, name: 'Prudential' },
        kpm: { id: BSD, code: '0417', branch: 'BSD City Branch' },
        role: { code: 'AB', label: 'Agency Builder', class: 'ab', isOwner: true, isAdmin: false },
        testAccount: false, lastActiveOn: '2026-11-20', lastActive: { days: 0, status: 'recent' },
      })]);
      expect(res.body.rows[0]).not.toHaveProperty('phone');
      expect(res.body.rows[0]).not.toHaveProperty('email');
      // A person with no photo draws the initials.
      const sari = await http().get('/admin/members').query({ q: 'sari' }).expect(200);
      expect(sari.body.rows[0]).toMatchObject({ avatarUrl: null, role: { class: 'aab', isOwner: false } });
    });

    it('P19.23-T3 AC-1 searches a phone number however it is typed, never returning it', async () => {
      asSuperAdmin();
      expect(names(await http().get('/admin/members').query({ q: '0812-1111-2222' }).expect(200))).toEqual(['Wilson Tanoto']);
    });

    it('P19.23-T3 AC-1 validation: an Akun tes filter that is not `only` is 400 naming it', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/members').query({ testAccount: 'yes' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('P19.23-T3 AC-1 the detail', () => {
    it('P19.23-T3 AC-1 the route declares the All members grant, and the switch its own', () => {
      expect(declaredPermissions(PlatformPeopleController)).toMatchObject({
        detail: 'platform_members:read', setTestAccount: 'test_account:set',
      });
    });

    it('P19.23-T3 AC-1 positive: the phone, the email, the upline and the rest, and the read is audited', async () => {
      asSuperAdmin();
      const at = await mark();
      const res = await http().get(`/admin/members/${M.RINA}`).expect(200);
      expect(res.body).toMatchObject({
        membershipId: M.RINA, userId: U.RINA, fullName: 'Rina Kurnia', phone: null, email: 'rina@contoh.test',
        leader: { fullName: 'Sari Puspita' }, status: 'active', joinedOn: '2024-03-01', lastActiveOn: null,
        lastActive: { days: null, status: 'never' },
        kpm: { branch: 'BSD City Branch' }, company: { name: 'Prudential' }, role: { class: 'agent' },
      });
      const wilson = await http().get(`/admin/members/${M.WILSON}`).expect(200);
      expect(wilson.body).toMatchObject({ phone: '+6281211112222', email: 'wilson@contoh.test' });
      const entries = await since(at, PLATFORM_READ.ACTION.memberDetail);
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries.some((e) => e.after?.filters?.membershipId === M.RINA)).toBe(true);
    });

    it('P19.23-T3 AC-1 a test account’s detail is readable: it is how its switch is reached', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/members/${M.TES}`).expect(200);
      expect(res.body).toMatchObject({ fullName: 'Tes Impor Satu', testAccount: true });
    });

    it('P19.23-T3 AC-1 a membership whose account id is no account’s: still its detail, with no phone and no email', async () => {
      asSuperAdmin();
      await db().collection('memberships').updateOne({ _id: oid(M.RINA) }, { $set: { userId: 'legacy-import' } });
      try {
        const res = await http().get(`/admin/members/${M.RINA}`).expect(200);
        expect(res.body).toMatchObject({ membershipId: M.RINA, userId: 'legacy-import', fullName: '', phone: null, email: '' });
      } finally {
        await db().collection('memberships').updateOne({ _id: oid(M.RINA) }, { $set: { userId: U.RINA } });
      }
    });

    it('P19.23-T3 AC-1 an id that names no membership is 404, a malformed one included', async () => {
      asSuperAdmin();
      await http().get('/admin/members/66f00000000000000000ffff').expect(404);
      await http().get('/admin/members/not-an-id').expect(404);
    });

    it.each(TENANT_ROLES)('P19.23-T3 AC-1 negative: %s is refused the detail, 403, and nothing is recorded', async (_who, ctx) => {
      session.current = ctx;
      const at = await mark();
      const res = await http().get(`/admin/members/${M.RINA}`).expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
      expect(await since(at)).toEqual([]);
    });

    it('P19.23-T3 AC-1 negative: a support session is refused the detail, by the guard and by the service', async () => {
      session.current = SUPPORT;
      await http().get(`/admin/members/${M.RINA}`).expect(403);
      await expect(app.get(PlatformReads).memberDetail(SUPPORT, M.RINA)).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });
  });

  describe('P19.23-T3 AC-1 the Akun tes switch (ADR-0267 §1)', () => {
    const flags = async (userId: string) => ({
      user: (await db().collection('users').findOne({ _id: oid(userId) }))?.testAccount,
      memberships: (await db().collection('memberships').find({ userId }).toArray()).map((m) => m.testAccount),
    });

    it('P19.23-T3 AC-1 positive: flags the account and every membership in every KPM, audited before → after', async () => {
      asSuperAdmin();
      const at = await mark();
      const res = await http().patch(`/admin/users/${U.DUA}/test-account`).send({ testAccount: true }).expect(200);
      expect(res.body).toEqual({ userId: U.DUA, testAccount: true, memberships: 2 });
      expect(await flags(U.DUA)).toEqual({ user: true, memberships: [true, true] });
      const [entry] = await since(at, 'user.test_account_set');
      expect(entry).toMatchObject({
        targetCollection: 'users', targetId: U.DUA, before: { testAccount: false },
        after: { testAccount: true, memberships: 2, kpmIds: [BSD, CEMPAKA].sort() },
      });
      // Out of the list and its counts at once, and under *Akun tes*.
      expect(names(await http().get('/admin/members').expect(200))).not.toContain('Dua Kantor');
      expect(names(await http().get('/admin/members').query({ testAccount: 'only' }).expect(200))).toContain('Dua Kantor');

      // And back: a real person again.
      await http().patch(`/admin/users/${U.DUA}/test-account`).send({ testAccount: false }).expect(200);
      expect(await flags(U.DUA)).toEqual({ user: false, memberships: [false, false] });
    });

    it('P19.23-T3 AC-1 setting the flag it already has writes nothing and records nothing', async () => {
      asSuperAdmin();
      const at = await mark();
      const res = await http().patch(`/admin/users/${U.TES}/test-account`).send({ testAccount: true }).expect(200);
      expect(res.body).toMatchObject({ testAccount: true });
      expect(await since(at)).toEqual([]);
    });

    it.each([
      ['a string', { testAccount: 'yes' }],
      ['nothing', {}],
      ['another field', { testAccount: true, kpmId: BSD }],
    ])('P19.23-T3 AC-1 validation: %s is 400, and nothing is written', async (_what, body) => {
      asSuperAdmin();
      const res = await http().patch(`/admin/users/${U.SARI}/test-account`).send(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await flags(U.SARI)).toEqual({ user: false, memberships: [false] });
    });

    it('P19.23-T3 AC-1 an account that is not there, a malformed id, or a Super Admin’s is 404', async () => {
      asSuperAdmin();
      await http().patch('/admin/users/66f00000000000000000ffff/test-account').send({ testAccount: true }).expect(404);
      await http().patch('/admin/users/not-an-id/test-account').send({ testAccount: true }).expect(404);
      await http().patch(`/admin/users/${U.ROOT}/test-account`).send({ testAccount: true }).expect(404);
    });

    it.each(TENANT_ROLES)('P19.23-T3 AC-1 negative: %s is refused the switch, 403, and nothing is written', async (_who, ctx) => {
      session.current = ctx;
      await http().patch(`/admin/users/${U.SARI}/test-account`).send({ testAccount: true }).expect(403);
      expect(await flags(U.SARI)).toEqual({ user: false, memberships: [false] });
    });

    it('P19.23-T3 AC-1 negative: a support session is refused the switch, by the guard and by the service', async () => {
      session.current = SUPPORT;
      await http().patch(`/admin/users/${U.SARI}/test-account`).send({ testAccount: true }).expect(403);
      await expect(app.get(TestAccounts).set(SUPPORT, U.SARI, true)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      expect(await flags(U.SARI)).toEqual({ user: false, memberships: [false] });
    });
  });
});
