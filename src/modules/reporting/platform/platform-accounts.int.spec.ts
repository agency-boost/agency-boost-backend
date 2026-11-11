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
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../../test/http-permissions';
import { listenOnLoopback } from '../../../../test/listen';
import { startMongo, stopMongo } from '../../../../test/mongo';
import { PlatformReadsController } from './platform-reads.controller';
import { PlatformReads } from './platform-reads.service';

const NOW = new Date('2026-11-11T05:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/** Every field a row of *Akun terdaftar* carries (ADR-0245 §1, §2), and nothing else. */
const ACCOUNT_FIELDS = [
  'company', 'email', 'emailVerified', 'fullName', 'kpmCount', 'lastSignInOn', 'registeredOn', 'userId',
].sort();

/** The people of the client's case and around it: who registered when, and what each holds. */
const PEOPLE = {
  /** The client's test account (PZ-2): a leader who registered, signed in, and joined no KPM. */
  HADI: { id: '66f00000000000000000aa01', email: 'hadi.leader@contoh.test', fullName: 'Hadi Santoso', company: PRUDENTIAL,
    createdAt: new Date('2026-11-10T18:00:00Z'), verified: true, lastLoginAt: new Date('2026-11-10T18:05:00Z') },
  /** Registered today, never verified, and never signed in. */
  CITRA: { id: '66f00000000000000000aa02', email: 'citra@contoh.test', fullName: 'Citra Lestari', company: ALLIANZ,
    createdAt: new Date('2026-11-11T02:00:00Z'), verified: false, lastLoginAt: null },
  RINA: { id: '66f00000000000000000aa03', email: 'rina@kpm0417.test', fullName: 'Rina Wijaya', company: PRUDENTIAL,
    createdAt: new Date('2026-10-01T03:00:00Z'), verified: true, lastLoginAt: new Date('2026-11-09T01:00:00Z') },
  /** Waiting on a leader: a pending membership is a KPM. */
  BAYU: { id: '66f00000000000000000aa04', email: 'bayu@kpm0417.test', fullName: 'Bayu Saputra', company: PRUDENTIAL,
    createdAt: new Date('2026-10-02T03:00:00Z'), verified: true, lastLoginAt: null },
  /** Left the KPM: a membership that ended is none. */
  FAJAR: { id: '66f00000000000000000aa05', email: 'fajar@kpm0417.test', fullName: 'Fajar Nugroho', company: PRUDENTIAL,
    createdAt: new Date('2026-10-03T03:00:00Z'), verified: true, lastLoginAt: null },
  /** In two KPMs. */
  DUA: { id: '66f00000000000000000aa06', email: 'dua@kpm0417.test', fullName: 'Dua Kantor', company: PRUDENTIAL,
    createdAt: new Date('2026-10-04T03:00:00Z'), verified: true, lastLoginAt: null },
  /** An erased membership is none. */
  DEWI: { id: '66f00000000000000000aa07', email: 'dewi@kpm0417.test', fullName: 'Dewi Anggraini', company: PRUDENTIAL,
    createdAt: new Date('2026-10-05T03:00:00Z'), verified: true, lastLoginAt: null },
  /** An account with no insurer on it. */
  LAMA: { id: '66f00000000000000000aa08', email: 'lama@contoh.test', fullName: 'Akun Lama', company: null,
    createdAt: new Date('2026-09-01T03:00:00Z'), verified: true, lastLoginAt: null },
} as const;
const SA_ID = '66f00000000000000000aa90';
const ERASED_ID = '66f00000000000000000aa91';

/** The support session's context: the member's own, a Super Admin acting as them (`compliance-office.ts`'s `supporting`). */
const SUPPORT = new RequestContext(OWNER.userId, 'none', OWNER.membership, 'u-support', null, false, true);

/**
 * **Akun terdaftar, over HTTP** (P19.12-T2 AC-1, AC-2; ADR-0245 §1, §2; the client's message of 11 November 2026, item 2):
 * the real `PermissionsGuard` and pipe and the real read over a database holding the client's case — a leader who
 * registered and joined no KPM, whom *All members* cannot list — beside accounts in a KPM, waiting, gone, erased, and a
 * Super Admin. Each assertion: the account found by email and by name; *Tanpa KPM* and *Punya KPM*; the listed fields;
 * the Super Admin alone; the audit entry, or no answer.
 */
describe('P19.12-T2 Akun terdaftar — every registered account, with or without a KPM (ADR-0245 §1)', () => {
  let app: INestApplication;
  let audit: AuditService;
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const asSuperAdmin = () => { session.current = SUPER_ADMIN; };
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
    audit = new AuditService(model(AuditLog.name, AuditLogSchema) as never);

    await db().collection('companies').insertMany([
      { _id: oid(PRUDENTIAL), name: 'Prudential', slug: 'prudential-accounts', deletedAt: null },
      { _id: oid(ALLIANZ), name: 'Allianz Life', slug: 'allianz-accounts', deletedAt: null },
    ]);
    const account = (p: { id: string; email: string; fullName: string; company: string | null; createdAt: Date;
      verified: boolean; lastLoginAt: Date | null }, over: Record<string, unknown> = {}) => ({
      _id: oid(p.id), email: p.email, fullName: p.fullName, passwordHash: 'x', companyId: p.company, agentCode: null,
      platformRole: 'none', status: p.verified ? 'active' : 'invited', emailVerifiedAt: p.verified ? p.createdAt : null,
      lastLoginAt: p.lastLoginAt, phone: '+6281234567890', dateOfBirth: '1988-02-03', gender: 'male',
      createdAt: p.createdAt, updatedAt: p.createdAt, deletedAt: null, ...over,
    });
    await db().collection('users').insertMany([
      ...Object.values(PEOPLE).map((p) => account(p)),
      account({ id: SA_ID, email: 'root@agencyboost.test', fullName: 'Hadi Root', company: null,
        createdAt: new Date('2026-11-11T04:00:00Z'), verified: true, lastLoginAt: NOW }, { platformRole: 'super_admin' }),
      account({ id: ERASED_ID, email: 'hadi.erased@contoh.test', fullName: 'Hadi Terhapus', company: PRUDENTIAL,
        createdAt: new Date('2026-11-11T03:00:00Z'), verified: true, lastLoginAt: null }, { deletedAt: NOW }),
      // Fifty older accounts with no KPM, for the pages.
      ...Array.from({ length: 50 }, (_, n) => account({
        id: new mongoose.Types.ObjectId().toString(), email: `isi${n}@contoh.test`, fullName: `Isi ${String(n).padStart(2, '0')}`,
        company: PRUDENTIAL, createdAt: new Date(Date.UTC(2026, 6, 1 + n)), verified: true, lastLoginAt: null,
      })),
    ]);
    const membership = (userId: string, kpmId: string, over: Record<string, unknown> = {}) => ({
      // A leader code each: `leaderCode` is unique across live memberships, and a run that built the index first refuses
      // two rows without one.
      kpmId, userId, agentCode: `A${Math.random()}`, leaderCode: `L${Math.random()}`, role: 'agent', status: 'active',
      deletedAt: null, ...over,
    });
    await db().collection('memberships').insertMany([
      membership(PEOPLE.RINA.id, KPM_A),
      membership(PEOPLE.BAYU.id, KPM_A, { status: 'pending' }),
      membership(PEOPLE.FAJAR.id, KPM_A, { status: 'removed', removedAt: new Date('2026-10-20T00:00:00Z') }),
      membership(PEOPLE.DUA.id, KPM_A),
      membership(PEOPLE.DUA.id, KPM_B),
      membership(PEOPLE.DEWI.id, KPM_A, { deletedAt: new Date('2026-10-21T00:00:00Z') }),
    ]);

    const reads = new PlatformReads(
      kpms as never, companies as never, users as never, new MembershipRepository(memberships as never),
      // What *Akun terdaftar* never reads: the per-KPM figures.
      null as never, null as never, null as never, null as never, null as never, null as never, null as never,
      null as never, null as never, audit, new FixedClock(NOW),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformReadsController],
      providers: [{ provide: PlatformReads, useValue: reads }],
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

  describe('P19.12-T2 AC-1 the Super Admin’s alone', () => {
    it('P19.12-T2 AC-1 the route declares the All members grant', () => {
      expect(declaredPermissions(PlatformReadsController)).toMatchObject({ accounts: 'platform_members:read' });
    });

    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]] as const)(
      'P19.12-T2 AC-1 negative: %s is refused, 403, and nothing is recorded',
      async (_who, ctx) => {
        session.current = ctx;
        const at = await mark();
        const res = await http().get('/admin/users').expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
        expect(await since(at)).toEqual([]);
      },
    );

    it('P19.12-T2 AC-1 negative: a support session — a Super Admin acting as a member — is refused', async () => {
      session.current = SUPPORT;
      await http().get('/admin/users').expect(403);
      // And the service's own second wall, behind the guard.
      await expect(app.get(PlatformReads).accounts(SUPPORT, {})).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('P19.12-T2 AC-1 positive: the Super Admin reads it', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/users').expect(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: PLATFORM_READ.PAGE_SIZE, total: 58 });
    });
  });

  describe('P19.12-T2 AC-2 the client’s case: registered, no KPM, found', () => {
    it('P19.12-T2 AC-2 found by email and by name, with every field — where All members finds nobody', async () => {
      asSuperAdmin();
      const hadi = {
        userId: PEOPLE.HADI.id, fullName: 'Hadi Santoso', email: 'hadi.leader@contoh.test',
        company: { id: PRUDENTIAL, name: 'Prudential' },
        // 18:00 UTC on the 10th is the 11th in Jakarta: an account's days are read in Asia/Jakarta (ADR-0016).
        registeredOn: '2026-11-11', emailVerified: true, lastSignInOn: '2026-11-11', kpmCount: 0,
      };
      for (const q of ['hadi.leader@contoh', 'HADI.LEADER@CONTOH.TEST', 'Hadi Sant', 'santoso']) {
        const res = await http().get('/admin/users').query({ q }).expect(200);
        expect([q, res.body.rows]).toEqual([q, [hadi]]);
      }
      // *All members* is built from memberships: the same search there is empty, which is the gap this closes.
      const members = await http().get('/admin/members').query({ q: 'hadi.leader@contoh' }).expect(200);
      expect(members.body.rows).toEqual([]);
    });

    it('P19.12-T2 AC-2 an unverified account that never signed in reads so', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/users').query({ q: 'citra' }).expect(200);
      expect(res.body.rows).toEqual([expect.objectContaining({
        fullName: 'Citra Lestari', company: { id: ALLIANZ, name: 'Allianz Life' }, registeredOn: '2026-11-11',
        emailVerified: false, lastSignInOn: null, kpmCount: 0,
      })]);
    });
  });

  describe('P19.12-T2 AC-1 the list', () => {
    it('P19.12-T2 AC-1 the listed fields alone — never a phone, a birth date or a gender', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/users').expect(200);
      for (const row of res.body.rows) {
        expect(Object.keys(row).sort()).toEqual(ACCOUNT_FIELDS);
        if (row.company !== null) expect(Object.keys(row.company).sort()).toEqual(['id', 'name']);
      }
      expect(JSON.stringify(res.body)).not.toMatch(/6281234567890|1988-02-03|"phone"|"dateOfBirth"|"gender"|"male"/);
      expect(res.body.rows.find((r: { fullName: string }) => r.fullName === 'Akun Lama').company).toBeNull();
    });

    it('P19.12-T2 AC-1 newest registration first; Super Admins and erased accounts left out', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/users').expect(200);
      expect(names(res).slice(0, 8)).toEqual([
        'Citra Lestari', 'Hadi Santoso', 'Dewi Anggraini', 'Dua Kantor', 'Fajar Nugroho', 'Bayu Saputra', 'Rina Wijaya',
        'Akun Lama',
      ]);
      const hadis = await http().get('/admin/users').query({ q: 'hadi' }).expect(200);
      expect(names(hadis)).toEqual(['Hadi Santoso']);
    });

    it('P19.12-T2 AC-1 Tanpa KPM: no active or pending membership — one that ended or was erased is none', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/users').query({ kpm: 'none' }).expect(200);
      expect(res.body.total).toBe(55);
      expect(names(res).slice(0, 5)).toEqual(['Citra Lestari', 'Hadi Santoso', 'Dewi Anggraini', 'Fajar Nugroho', 'Akun Lama']);
      for (const row of res.body.rows) expect(row.kpmCount).toBe(0);
    });

    it('P19.12-T2 AC-1 Punya KPM: active or pending, each with how many', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/users').query({ kpm: 'some' }).expect(200);
      expect(res.body.rows.map((r: { fullName: string; kpmCount: number }) => [r.fullName, r.kpmCount]))
        .toEqual([['Dua Kantor', 2], ['Bayu Saputra', 1], ['Rina Wijaya', 1]]);
      expect(res.body.total).toBe(3);
      const searched = await http().get('/admin/users').query({ kpm: 'some', q: 'hadi' }).expect(200);
      expect(searched.body).toMatchObject({ rows: [], total: 0 });
    });

    it('P19.12-T2 AC-1 fifty a page; the second holds the rest, and a page past the last is empty', async () => {
      asSuperAdmin();
      const first = await http().get('/admin/users').expect(200);
      const second = await http().get('/admin/users').query({ page: 2 }).expect(200);
      expect(first.body.rows).toHaveLength(50);
      expect(second.body).toMatchObject({ page: 2, total: 58 });
      expect(second.body.rows).toHaveLength(8);
      const ids = new Set([...first.body.rows, ...second.body.rows].map((r: { userId: string }) => r.userId));
      expect(ids.size).toBe(58);
      expect(names(second)).toEqual(['Isi 07', 'Isi 06', 'Isi 05', 'Isi 04', 'Isi 03', 'Isi 02', 'Isi 01', 'Isi 00']);
      const past = await http().get('/admin/users').query({ page: 9 }).expect(200);
      expect(past.body).toMatchObject({ rows: [], page: 9, total: 58 });
    });

    it('P19.12-T2 AC-1 refuses a search under two characters, an unknown kpm, a bad page, an operator and any other parameter — recording nothing', async () => {
      asSuperAdmin();
      const at = await mark();
      for (const query of [{ q: 'a' }, { q: '  b ' }, { kpm: 'all' }, { page: '0' }, { 'q[$ne]': 'x' }, { role: 'ab' }, { extra: '1' }]) {
        const res = await http().get('/admin/users').query(query).expect(400);
        expect([query, res.body.error.code]).toEqual([query, 'VALIDATION_FAILED']);
      }
      const short = await http().get('/admin/users').query({ q: 'a' }).set('Accept-Language', 'id').expect(400);
      expect(short.body.error.message).toBe('Ketik minimal dua karakter nama atau alamat email.');
      expect(await since(at)).toEqual([]);
    });

    it('P19.12-T2 AC-1 a phone number finds nobody here: a name or an email only', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/users').query({ q: '081234567890' }).expect(200);
      expect(res.body).toMatchObject({ rows: [], total: 0 });
    });
  });

  describe('P19.12-T2 AC-1 audited per read (ADR-0207 §5)', () => {
    it('P19.12-T2 AC-1 one entry in the platform’s log: the purpose, the filters, the page, the count and the accounts returned', async () => {
      asSuperAdmin();
      const at = await mark();
      const res = await http().get('/admin/users').query({ q: 'kpm0417', kpm: 'some' }).expect(200);
      const rows = await since(at);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: PLATFORM_READ.ACTION.accounts, kpmId: null, actorUserId: 'root', targetCollection: 'users', targetId: null,
        after: {
          purpose: PLATFORM_READ.PURPOSE.accounts, filters: { q: 'kpm0417', kpm: 'some' }, page: 1, rows: 3,
          userIds: res.body.rows.map((r: { userId: string }) => r.userId),
        },
      });
      expect(rows[0].after.userIds).toEqual([PEOPLE.DUA.id, PEOPLE.BAYU.id, PEOPLE.RINA.id]);
    });

    it('P19.12-T2 AC-1 an entry that cannot be written fails the read, 500, and nothing is served', async () => {
      asSuperAdmin();
      const spy = jest.spyOn(audit, 'recordInScopesOrFail').mockRejectedValueOnce(new Error('audit down'));
      const res = await http().get('/admin/users').expect(500);
      expect(res.body.rows).toBeUndefined();
      spy.mockRestore();
    });

    it('P19.12-T2 AC-1 the read writes nothing but its entry', async () => {
      asSuperAdmin();
      const count = async () => Promise.all(['users', 'memberships', 'companies'].map((c) => db().collection(c).countDocuments()));
      const before = await count();
      await http().get('/admin/users').query({ kpm: 'none' }).expect(200);
      expect(await count()).toEqual(before);
    });
  });
});
