import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { PlatformTeamController } from './platform-team.controller';
import { PlatformTeamService } from './platform-team.service';

const ROOT = '66f0000000000000000000e1';
const DINA = '66f0000000000000000000e2';
const NEW = '66f0000000000000000000e3';
const MEMBER = '66f0000000000000000000e4';
const RAW = '66f0000000000000000000e5';
const GONE = '66f0000000000000000000e6';

/** The Super Admin signed in: a real account, so *Anda* and *never yourself* have somebody to be. */
const ME = RequestContext.platform(ROOT);
/** A support session as the Owner: it acts as its member, who holds no platform grant. */
const SUPPORT_SESSION = new RequestContext('u-owner', 'none', OWNER.membership, ROOT, null, false, true);
const VERIFIED = new Date('2026-11-01T00:00:00Z');

/**
 * ***Tim Super Admin* over HTTP** (P19.23-T6 AC-2; ADR-0279): `GET`, `POST /admin/platform/team` and `DELETE
 * /admin/platform/team/:userId` — who may call them, who can be made one, who can never be removed, what is recorded.
 */
describe('Tim Super Admin (P19.23-T6 AC-2)', () => {
  let app: INestApplication;
  let users: mongoose.Model<User>;
  let audit: mongoose.Model<AuditLog>;

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    const memberships = mongoose.model(Membership.name, MembershipSchema);
    const service = new PlatformTeamService(users as never, new MembershipRepository(memberships as never), new AuditService(audit as never));
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformTeamController],
      providers: [{ provide: PlatformTeamService, useValue: service }],
    }).compile();
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
    session.current = ME;
    const db = mongoose.connection.db!;
    const person = (id: string, over: Record<string, unknown>) => ({
      _id: new mongoose.Types.ObjectId(id), passwordHash: 'x', status: 'active', platformRole: 'none', deletedAt: null,
      emailVerifiedAt: VERIFIED, ...over,
    });
    await db.collection('users').insertMany([
      person(ROOT, { email: 'superadmin@agencyboost.id', fullName: 'PLATFORM OPERATOR', platformRole: 'super_admin' }),
      person(DINA, { email: 'dina@agencyboost.id', fullName: 'DINA KUSUMA', platformRole: 'super_admin' }),
      person(NEW, { email: 'rudi@agencyboost.id', fullName: 'Rudi Hartono' }),
      person(MEMBER, { email: 'owner@kpm.test', fullName: 'Andi Wijaya' }),
      person(RAW, { email: 'baru@agencyboost.id', fullName: 'Belum Verifikasi', emailVerifiedAt: null }),
      person(GONE, { email: 'nonaktif@agencyboost.id', fullName: 'Nonaktif', status: 'deactivated' }),
    ]);
    await db.collection('memberships').insertOne({
      kpmId: '66f0000000000000000000a1', userId: MEMBER, status: 'active', deletedAt: null, agentCode: '0001', leaderCode: 'LTEAM1',
    });
  });

  const api = () => request(app.getHttpServer());
  const rows = (body: { fullName: string; isYou: boolean }[]) => body.map((r) => `${r.fullName}${r.isYou ? ' (Anda)' : ''}`);

  it('P19.23-T6 AC-2 each route names the permission it is guarded by', () => {
    expect(declaredPermissions(PlatformTeamController)).toEqual({
      list: 'super_admin:read', add: 'super_admin:grant', revoke: 'super_admin:revoke',
    });
  });

  it('P19.23-T6 AC-2 lists the Super Admins by name, the reader marked Anda', async () => {
    const { body } = await api().get('/api/admin/platform/team').expect(200);
    expect(rows(body)).toEqual(['DINA KUSUMA', 'PLATFORM OPERATOR (Anda)']);
    expect(body[0]).toEqual({ userId: DINA, fullName: 'DINA KUSUMA', email: 'dina@agencyboost.id', status: 'active', isYou: false });
  });

  describe('add', () => {
    it('P19.23-T6 AC-2 makes an existing, verified account with no KPM a Super Admin, by its email as typed, audited', async () => {
      const { body } = await api().post('/api/admin/platform/team').send({ email: '  Rudi@AgencyBoost.id ' }).expect(200);
      expect(rows(body)).toEqual(['DINA KUSUMA', 'PLATFORM OPERATOR (Anda)', 'Rudi Hartono']);
      expect((await users.findById(NEW).lean())?.platformRole).toBe('super_admin');
      const [entry] = await audit.find({ action: 'super_admin.granted' }).lean();
      expect(entry).toMatchObject({
        kpmId: null, actorUserId: ROOT, targetCollection: 'users', targetId: NEW,
        before: { platformRole: 'none' }, after: { platformRole: 'super_admin', email: 'rudi@agencyboost.id' },
      });
    });

    it('P19.23-T6 AC-2 adding someone who already is one changes nothing and records nothing', async () => {
      await api().post('/api/admin/platform/team').send({ email: 'dina@agencyboost.id' }).expect(200);
      expect(await audit.countDocuments({ action: 'super_admin.granted' })).toBe(0);
    });

    it.each([
      ['an email no account has', 'nobody@agencyboost.id', 422, 'SUPER_ADMIN_NO_ACCOUNT', { field: 'email', reason: 'no_account' }],
      ['a deactivated account', 'nonaktif@agencyboost.id', 422, 'SUPER_ADMIN_NO_ACCOUNT', { field: 'email', reason: 'deactivated' }],
      ['an address not yet verified', 'baru@agencyboost.id', 422, 'SUPER_ADMIN_UNVERIFIED', { field: 'email' }],
      ['a KPM member — never a KPM role', 'owner@kpm.test', 409, 'SUPER_ADMIN_HAS_MEMBERSHIP', { field: 'email' }],
    ])('P19.23-T6 AC-2 refuses %s, and writes nothing', async (_label, email, status, code, details) => {
      const { body } = await api().post('/api/admin/platform/team').send({ email }).expect(status);
      expect(body.error).toMatchObject({ code, details });
      expect(await users.countDocuments({ platformRole: 'super_admin' })).toBe(2);
      expect(await audit.countDocuments({})).toBe(0);
    });

    it('P19.23-T6 AC-2 refuses what is not an email address, 400', async () => {
      const { body } = await api().post('/api/admin/platform/team').send({ email: 'rudi' }).expect(400);
      expect(body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('revoke', () => {
    it('P19.23-T6 AC-2 takes another Super Admin’s role away, the login kept, audited', async () => {
      const { body } = await api().delete(`/api/admin/platform/team/${DINA}`).expect(200);
      expect(rows(body)).toEqual(['PLATFORM OPERATOR (Anda)']);
      expect(await users.findById(DINA).lean()).toMatchObject({ platformRole: 'none', status: 'active' });
      const [entry] = await audit.find({ action: 'super_admin.revoked' }).lean();
      expect(entry).toMatchObject({
        actorUserId: ROOT, targetId: DINA, before: { platformRole: 'super_admin' }, after: { platformRole: 'none' },
      });
    });

    it('P19.23-T6 AC-2 never your own role: another Super Admin removes it', async () => {
      const { body } = await api().delete(`/api/admin/platform/team/${ROOT}`).expect(409);
      expect(body.error.code).toBe('SUPER_ADMIN_SELF');
      expect((await users.findById(ROOT).lean())?.platformRole).toBe('super_admin');
    });

    it('P19.23-T6 AC-2 never the last active Super Admin — a deactivated one does not count', async () => {
      // Signed in on a session that outlived its account's deactivation: the only other one left is Dina.
      await users.updateOne({ _id: ROOT }, { $set: { status: 'deactivated' } });
      const { body } = await api().delete(`/api/admin/platform/team/${DINA}`).expect(409);
      expect(body.error.code).toBe('SUPER_ADMIN_LAST');
      expect((await users.findById(DINA).lean())?.platformRole).toBe('super_admin');
      expect(await audit.countDocuments({})).toBe(0);
    });

    it.each([['an account that is no Super Admin', NEW], ['an id that is not one', 'not-an-id']])(
      'P19.23-T6 AC-2 answers 404 for %s',
      async (_label, id) => {
        expect((await api().delete(`/api/admin/platform/team/${id}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      },
    );
  });

  describe('who may', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT], ['a support session', SUPPORT_SESSION]])(
      'P19.23-T6 AC-2 refuses %s every route, 403 PERM_DENIED',
      async (_label, ctx) => {
        session.current = ctx;
        expect((await api().get('/api/admin/platform/team').expect(403)).body.error.code).toBe('PERM_DENIED');
        expect((await api().post('/api/admin/platform/team').send({ email: 'rudi@agencyboost.id' }).expect(403)).body.error.code)
          .toBe('PERM_DENIED');
        expect((await api().delete(`/api/admin/platform/team/${DINA}`).expect(403)).body.error.code).toBe('PERM_DENIED');
        expect(await users.countDocuments({ platformRole: 'super_admin' })).toBe(2);
      },
    );
  });
});
