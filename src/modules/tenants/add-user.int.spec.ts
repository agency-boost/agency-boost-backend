import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { INVITES } from '@/domain/constants';
import { up as templateCompany } from '@/migrations/0037-template-company';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import type { NotificationService } from '@/modules/notifications/notification.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { JoinRequestRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { UserInvitationRepository } from '@/modules/org/user-invitation.repository';
import { UserInvitation, UserInvitationSchema } from '@/modules/org/user-invitation.schema';
import { AnggotaWaiting } from '@/modules/reporting/platform/anggota-waiting';
import { AnggotaWaitingController } from '@/modules/reporting/platform/anggota-waiting.controller';
import { countedMembers } from '@/modules/org/counted-members';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AddUserController, PlacementController, UserInviteLinkController } from './add-user.controller';
import { AddUserService } from './add-user.service';
import { KpmOwnersService } from './kpm-owners.service';
import { KpmRequest, KpmRequestSchema } from './kpm-request.schema';
import { TEMPLATE_LIBRARY } from './template-library';
import { TenantService, type KpmAdminView } from './tenant.service';

const NOW = new Date('2026-11-22T03:00:00Z');
const DAY = 24 * 60 * 60_000;
const APP = 'https://app.agencyboost.test';

/**
 * ***Tambah user* and *Masukkan*** (P19.28-T1 AC-1 to AC-6; ADR-0286), over HTTP against a real database holding what
 * migration `0037` makes: the invitation and its link, *Kirim ulang* and *Batalkan*, accepting it signed in, the
 * placement of somebody with no KPM, a new KPM with its first owner in one step — and its rollback — and who may do each.
 * `TenantService`, `KpmOwnersService`, `HierarchyService` and the service under test are real; nothing is sent.
 */
describe('P19.28-T1 Tambah user and Masukkan (ADR-0286)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let tenants: TenantService;
  let owners: KpmOwnersService;
  let hierarchy: HierarchyService;
  let waiting: AnggotaWaiting;
  let clock: FixedClock;
  let sent: { userId: string; templateId: string; payload: Record<string, unknown> }[];
  let prudential: string;
  let manulife: string;
  let seq = 0;
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);
  const oid = (id: string) => new mongoose.Types.ObjectId(id);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    clock = new FixedClock(NOW);
    const users = wired.users as never;
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    hierarchy = new HierarchyService(wired.memberships, wired.kpms as never, users, history, clock, wired.orgLevels);
    owners = new KpmOwnersService(wired.kpms as never, users, wired.memberships, wired.audit, clock);
    tenants = new TenantService(
      wired.kpms as never, wired.companies as never, users,
      mongoose.model(KpmRequest.name, KpmRequestSchema) as never, wired.audit, clock, hierarchy,
      wired.memberships, wired.orgLevels, wired.provisioning, wired.products, wired.campaigns,
      wired.namedTemplates, null, owners,
    );
    sent = [];
    const notifications = {
      send: async (r: { userId: string; templateId: string; payload: Record<string, unknown> }) => { sent.push(r); },
    } as unknown as NotificationService;
    const invitations = new UserInvitationRepository(mongoose.model(UserInvitation.name, UserInvitationSchema) as never);
    const service = new AddUserService(
      wired.kpms as never, wired.companies as never, users, invitations, wired.memberships, history,
      new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never),
      hierarchy, wired.orgLevels, tenants, owners, notifications, wired.audit, clock,
    );
    waiting = new AnggotaWaiting(
      wired.kpms as never, wired.companies as never, users, wired.memberships, invitations, wired.orgLevels, wired.audit,
      clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [AddUserController, PlacementController, UserInviteLinkController, AnggotaWaitingController],
      providers: [
        { provide: AddUserService, useValue: service },
        { provide: AnggotaWaiting, useValue: waiting },
        { provide: RateLimiter, useValue: new RateLimiter(clock) },
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'APP_ORIGIN' ? `${APP}/` : undefined) } },
      ],
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
    for (const name of ['companies', 'companyOrgLevels', 'products', 'qualificationRules', 'recruitmentPlaybooks',
      'companyTemplates', 'templates', 'kpms', 'users', 'auditLog', 'kpmRequests', 'activityTypes', 'memberships',
      'membershipHistory', 'userInvitations', 'joinRequests']) {
      await col(name).deleteMany({});
    }
    sent.length = 0;
    clock.set(NOW);
    session.current = SUPER_ADMIN;
    await templateCompany(db(), NOW);
    prudential = String((await tenants.createCompany(SUPER_ADMIN, { name: 'Prudential', slug: 'prudential' }))._id);
    manulife = String((await tenants.createCompany(SUPER_ADMIN, { name: 'Manulife', slug: 'manulife' }))._id);
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
      email: `${fullName.toLowerCase().replace(/\W+/g, '.')}.${seq}@example.test`, passwordHash: 'x', fullName,
      status: 'active', platformRole: 'none', companyId, agentCode: companyId ? String(70000 + seq) : null,
      emailVerifiedAt: NOW, phone: null, lastLoginAt: NOW, ...over,
    });
    return String(user._id);
  }

  const inKpm = (kpmId: string) => RequestContext.superAdminInTenant('root', kpmId);

  /** A member placed by hand, as an office's own paths place one. */
  async function member(kpmId: string, fullName: string, role: string, leaderId: string | null = null, over: Record<string, unknown> = {}) {
    const userId = await account(fullName, prudential, over);
    const m = await hierarchy.create(inKpm(kpmId), {
      userId, role, leaderId, status: 'active', joining: { joinedAs: 'existing_agent' },
    });
    return { userId, membershipId: String(m._id) };
  }

  /** A KPM of Prudential with its owner (an AB) and an AAB under them. */
  async function office(branchName: string) {
    const made = await tenants.createKpm(SUPER_ADMIN, { companyId: prudential, branchName });
    const kpmId = made._id;
    const owner = await member(kpmId, `Owner of ${branchName}`, 'AB');
    await owners.add(inKpm(kpmId), kpmId, owner.userId);
    const aab = await member(kpmId, `Sinta ${branchName}`, 'AAB', owner.membershipId);
    return { kpmId, owner, aab };
  }

  const as = (userId: string, kpmId: string, membershipId: string, over: Record<string, unknown> = {}) =>
    new RequestContext(userId, 'none', {
      membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 1, ...over,
    });
  const ownerOf = (o: Awaited<ReturnType<typeof office>>) =>
    as(o.owner.userId, o.kpmId, o.owner.membershipId, { isKpmOwner: true });

  const add = (body: Record<string, unknown>) => api().post('/api/user-invitations').send(body);
  const tokenOf = (link: string) => decodeURIComponent(link.split('/user-invite/')[1]);
  const rina = (kpmId: string, leaderId: string, over: Record<string, unknown> = {}) => ({
    fullName: 'Rina Kartika', phone: '0812-7788-4410', kpmId, role: 'AGENT', leaderMembershipId: leaderId, ...over,
  });

  describe('Tambah user — the invitation (AC-1)', () => {
    it('P19.28-T1 AC-1 the Super Admin invites a new person to any KPM: a waiting invitation, its link, audited', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const res = await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'invited',
        kpm: { id: bekasi.kpmId, branch: 'Bekasi Barat Branch', created: false },
        invitation: {
          fullName: 'Rina Kartika', phone: '+6281277884410', email: null, role: { code: 'AGENT', class: 'agent' },
          leaderMembershipId: bekasi.aab.membershipId, makeOwner: false, state: 'pending', invitedAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + INVITES.EXPIRY_DAYS * DAY).toISOString(),
        },
      });
      expect(res.body.link).toMatch(new RegExp(`^${APP}/user-invite/${bekasi.kpmId}\\.`));
      const row = await col('userInvitations').findOne({});
      expect(row).toMatchObject({ kpmId: bekasi.kpmId, status: 'pending', userId: null, invitedByUserId: 'root' });
      expect(JSON.stringify(row)).not.toContain(tokenOf(res.body.link).split('.')[1]);
      // No membership until they accept: it counts in nothing.
      expect(await col('memberships').countDocuments({ kpmId: bekasi.kpmId })).toBe(2);
      const audit = await col('auditLog').findOne({ action: 'user_invitation.created' });
      expect(audit).toMatchObject({ kpmId: bekasi.kpmId, actorUserId: 'root' });
      expect(audit?.after).toMatchObject({ kpmId: bekasi.kpmId, fullName: 'Rina Kartika', role: 'AGENT', newKpm: false });
      expect(JSON.stringify(audit?.after)).not.toContain('7788');
    });

    it.each([
      ['a number that is not one', { phone: '12' }, 400, 'VALIDATION_FAILED'],
      ['no role', { role: undefined }, 400, 'VALIDATION_FAILED'],
      ['no leader for an Agent', { leaderMembershipId: undefined }, 400, 'VALIDATION_FAILED'],
      ['a role the company does not publish', { role: 'MANAGER' }, 409, 'ORG_LEVEL_NOT_ON_LADDER'],
      ['both a KPM and a new one', { newKpm: { branchName: 'X', companyId: '66f0000000000000000000a9' } }, 400, 'VALIDATION_FAILED'],
    ])('P19.28-T1 AC-6 refuses %s, writing nothing', async (_what, over, status, code) => {
      const bekasi = await office('Bekasi Barat Branch');
      const res = await add(rina(bekasi.kpmId, bekasi.aab.membershipId, over)).expect(status);
      expect(res.body.error.code).toBe(code);
      expect(await col('userInvitations').countDocuments({})).toBe(0);
    });

    it('P19.28-T1 AC-6 refuses a leader for an AB, and a leader of another KPM', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      expect((await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { role: 'AB' })).expect(400)).body.error.code)
        .toBe('VALIDATION_FAILED');
      expect((await add(rina(bekasi.kpmId, bsd.aab.membershipId)).expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
    });

    it('P19.28-T1 AC-6 one waiting invitation per number per KPM: a second is 409 ORG_INVITE_PENDING', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200);
      const res = await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { phone: '+62 812 7788 4410' })).expect(409);
      expect(res.body.error.code).toBe('ORG_INVITE_PENDING');
    });

    it('P19.28-T1 AC-6 a number of somebody already Aktif elsewhere is refused — named to the Super Admin alone', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      const taken = await member(bsd.kpmId, 'Joko Prasetyo', 'AGENT', bsd.aab.membershipId, { phone: '+6281277884410' });
      expect(taken).toBeDefined();
      const platform = await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(409);
      expect(platform.body.error).toMatchObject({ code: 'ORG_AGENT_ALREADY_TAGGED' });
      expect(platform.body.error.message).toContain('BSD City Branch');
      session.current = ownerOf(bekasi);
      const owner = await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(409);
      expect(owner.body.error.message).not.toContain('BSD City Branch');
    });

    it('P19.28-T1 AC-1 an email that names an existing account with no KPM binds the invitation to it', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const loose = await account('Dewi Lestari', prudential, { email: 'dewi@example.test' });
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { email: 'DEWI@example.test', fullName: 'Dewi' })).expect(200);
      expect((await col('userInvitations').findOne({}))?.userId).toBe(loose);
    });
  });

  describe('who may (AC-6)', () => {
    it('P19.28-T1 AC-6 declares member:add on the sheet, member:place on Masukkan, the link on its own grant', () => {
      expect(declaredPermissions(AddUserController)).toEqual({
        options: 'member:add', add: 'member:add', resend: 'member:add', cancel: 'member:add',
      });
      expect(declaredPermissions(PlacementController)).toEqual({ place: 'member:place' });
      expect(declaredPermissions(UserInviteLinkController)).toEqual({ banner: undefined, accept: 'join_via_code_link_qr' });
    });

    it('P19.28-T1 AC-6 an Owner and a KPM Admin add in their own KPM; another KPM is 404, like one that is not there', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      session.current = ownerOf(bekasi);
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200);
      await add({ ...rina(bekasi.kpmId, bekasi.aab.membershipId, { phone: '0813 0000 1111' }), kpmId: undefined }).expect(200);
      expect((await add(rina(bsd.kpmId, bsd.aab.membershipId)).expect(404)).body.error.code).toBe('NOT_FOUND');
      session.current = as(bekasi.aab.userId, bekasi.kpmId, bekasi.aab.membershipId, { isKpmAdmin: true });
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { phone: '0814 0000 2222' })).expect(200);
    });

    it('P19.28-T1 AC-6 a KPM Admin may not make an owner, nor a KPM; an Owner may make an owner, never a KPM', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      session.current = as(bekasi.aab.userId, bekasi.kpmId, bekasi.aab.membershipId, { isKpmAdmin: true });
      expect((await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { makeOwner: true })).expect(403)).body.error.code)
        .toBe('PERM_DENIED');
      const newKpm = { fullName: 'Rina', phone: '0812 7788 4410', newKpm: { branchName: 'Bintaro Branch', companyId: prudential } };
      expect((await add(newKpm).expect(403)).body.error.code).toBe('PERM_DENIED');
      session.current = ownerOf(bekasi);
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { makeOwner: true })).expect(200);
      expect((await add(newKpm).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await col('kpms').countDocuments({ branchName: 'Bintaro Branch' })).toBe(0);
    });

    it.each([['an AB', 'ab'], ['an AAB', 'aab'], ['an Agent', 'agent']])(
      'P19.28-T1 AC-6 %s is refused every route of the sheet and Masukkan, 403', async (_who, role) => {
        const bekasi = await office('Bekasi Barat Branch');
        session.current = as(bekasi.aab.userId, bekasi.kpmId, bekasi.aab.membershipId, { hierarchyRole: role });
        await api().get(`/api/user-invitations/options?kpmId=${bekasi.kpmId}`).expect(403);
        await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(403);
        await api().post(`/api/admin/accounts/${bekasi.aab.userId}/placement`).send({ kpmId: bekasi.kpmId, role: 'AB' }).expect(403);
      },
    );

    it('P19.28-T1 AC-6 Masukkan is the Super Admin’s alone: an Owner is 403', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const fajar = await account('Fajar Nugroho', prudential);
      session.current = ownerOf(bekasi);
      await api().post(`/api/admin/accounts/${fajar}/placement`).send({ kpmId: bekasi.kpmId, role: 'AB' }).expect(403);
    });

    it('P19.28 T1 Masukkan is refused a KPM Admin and a support session over HTTP, 403, nothing written', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const fajar = await account('Fajar Nugroho', prudential);
      session.current = as(bekasi.aab.userId, bekasi.kpmId, bekasi.aab.membershipId, { isKpmAdmin: true });
      await api().post(`/api/admin/accounts/${fajar}/placement`).send({ kpmId: bekasi.kpmId, role: 'AB' }).expect(403);
      // The Super Admin looking as the KPM's Owner: a session only looks, and holds no platform grant.
      session.current = new RequestContext(
        bekasi.owner.userId, 'none', ownerOf(bekasi).membership, 'root', null, false, true,
      );
      await api().post(`/api/admin/accounts/${fajar}/placement`).send({ kpmId: bekasi.kpmId, role: 'AB' }).expect(403);
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(403);
      expect(await col('memberships').countDocuments({ userId: fajar })).toBe(0);
      expect(await col('userInvitations').countDocuments({})).toBe(0);
    });

    it.each([['the Owner', 'owner'], ['a KPM Admin', 'admin'], ['an AB', 'ab'], ['an AAB', 'aab'], ['an Agent', 'agent']] as const)(
      'P19.28 T1 GET /admin/waiting-members is refused %s over HTTP, 403; the Super Admin reads it', async (_who, who) => {
        const bekasi = await office('Bekasi Barat Branch');
        const roles = {
          owner: { isKpmOwner: true }, admin: { isKpmAdmin: true }, ab: {}, aab: { hierarchyRole: 'aab', orgLevelCode: 'AAB' },
          agent: { hierarchyRole: 'agent', orgLevelCode: 'AGENT', directCount: 0 },
        } as const;
        session.current = as(bekasi.aab.userId, bekasi.kpmId, bekasi.aab.membershipId, roles[who]);
        await api().get('/api/admin/waiting-members').expect(403);
        session.current = SUPER_ADMIN;
        const res = await api().get('/api/admin/waiting-members').expect(200);
        expect(res.body).toMatchObject({ page: 1, pageSize: 50, chips: { active: 2 } });
      },
    );
  });

  describe('the sheet’s choices', () => {
    it('P19.28-T2 AC-2 answers the ladder junior first, the ABs and AABs, and what the reader may switch', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const res = await api().get(`/api/user-invitations/options?kpmId=${bekasi.kpmId}`).expect(200);
      expect(res.body.roles.map((r: { code: string }) => r.code)).toEqual(['AGENT', 'AAB', 'AB']);
      expect(res.body.seniorCode).toBe('AB');
      expect(res.body.leaders.map((l: { fullName: string; isOwner: boolean }) => [l.fullName, l.isOwner])).toEqual([
        ['Owner of Bekasi Barat Branch', true], ['Sinta Bekasi Barat Branch', false],
      ]);
      expect(res.body).toMatchObject({ mayMakeOwner: true, mayMakeKpm: true });
      session.current = as(bekasi.aab.userId, bekasi.kpmId, bekasi.aab.membershipId, { isKpmAdmin: true });
      expect((await api().get('/api/user-invitations/options').expect(200)).body).toMatchObject({ mayMakeOwner: false, mayMakeKpm: false });
    });

    it('P19.28-T1 AC-6 another KPM’s choices are 404 to an Owner', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      session.current = ownerOf(bekasi);
      await api().get(`/api/user-invitations/options?kpmId=${bsd.kpmId}`).expect(404);
    });
  });

  describe('Kirim ulang · Batalkan (AC-4)', () => {
    it('P19.28 T1 another KPM’s Admin: Kirim ulang and Batalkan are 404, as an invitation that is not there', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      session.current = as(bsd.aab.userId, bsd.kpmId, bsd.aab.membershipId, { isKpmAdmin: true });
      await api().post(`/api/user-invitations/${made.invitation.id}/resend`).expect(404);
      await api().delete(`/api/user-invitations/${made.invitation.id}`).expect(404);
      expect(await col('userInvitations').findOne({})).toMatchObject({ status: 'pending', resentAt: null });
    });

    it('P19.28 S1 a KPM Admin may neither send again nor cancel an Owner’s owner-making invitation: 403; an ordinary one, yes', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      session.current = ownerOf(bekasi);
      const owning = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { makeOwner: true })).expect(200)).body;
      const plain = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { phone: '0813 0000 1111' })).expect(200)).body;
      session.current = as(bekasi.aab.userId, bekasi.kpmId, bekasi.aab.membershipId, { isKpmAdmin: true });
      expect((await api().post(`/api/user-invitations/${owning.invitation.id}/resend`).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await api().delete(`/api/user-invitations/${owning.invitation.id}`).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(await col('userInvitations').findOne({ _id: oid(owning.invitation.id) })).toMatchObject({ status: 'pending', resentAt: null });
      await api().post(`/api/user-invitations/${plain.invitation.id}/resend`).expect(200);
      await api().delete(`/api/user-invitations/${plain.invitation.id}`).expect(200);
      session.current = ownerOf(bekasi);
      await api().post(`/api/user-invitations/${owning.invitation.id}/resend`).expect(200);
    });

    it('P19.28-T1 AC-4 a new link replaces the old, the row reads hari ini; cancelled, the row stays and the link dies', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      clock.set(new Date(NOW.getTime() + 3 * DAY));
      const again = (await api().post(`/api/user-invitations/${made.invitation.id}/resend`).expect(200)).body;
      expect(again.invitation.invitedAt).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
      expect(tokenOf(again.link)).not.toBe(tokenOf(made.link));
      await api().get(`/api/user-invites/${tokenOf(made.link)}`).expect(404);
      await api().get(`/api/user-invites/${tokenOf(again.link)}`).expect(200);

      const cancelled = (await api().delete(`/api/user-invitations/${made.invitation.id}`).expect(200)).body;
      expect(cancelled.invitation.state).toBe('cancelled');
      expect(await col('userInvitations').findOne({})).toMatchObject({ status: 'cancelled', cancelledByUserId: 'root' });
      expect((await api().get(`/api/user-invites/${tokenOf(again.link)}`).expect(404)).body.error.message).toContain('cancelled');
      expect((await api().post(`/api/user-invitations/${made.invitation.id}/resend`).expect(409)).body.error.code)
        .toBe('ORG_REQUEST_ALREADY_DECIDED');
      const actions = (await col('auditLog').find({ action: /^user_invitation\./ }).toArray()).map((a) => a.action).sort();
      expect(actions).toEqual(['user_invitation.cancelled', 'user_invitation.created', 'user_invitation.resent']);
    });

    it('P19.28-T1 AC-6 another KPM’s invitation is 404 to an Owner, for both', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      session.current = ownerOf(bsd);
      await api().post(`/api/user-invitations/${made.invitation.id}/resend`).expect(404);
      await api().delete(`/api/user-invitations/${made.invitation.id}`).expect(404);
      session.current = ownerOf(bekasi);
      await api().delete(`/api/user-invitations/${made.invitation.id}`).expect(200);
    });

    it('P19.28-T1 AC-4 an expired link says so, and a resend revives it', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      clock.set(new Date(NOW.getTime() + INVITES.EXPIRY_DAYS * DAY));
      expect((await api().get(`/api/user-invites/${tokenOf(made.link)}`).expect(404)).body.error.message).toContain('expired');
      const again = (await api().post(`/api/user-invitations/${made.invitation.id}/resend`).expect(200)).body;
      await api().get(`/api/user-invites/${tokenOf(again.link)}`).expect(200);
    });
  });

  describe('the link (AC-4)', () => {
    it('P19.28-T1 AC-4 the banner is public; accepted signed in, the person is Aktif at once, and the link is spent', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      const token = tokenOf(made.link);
      session.current = new RequestContext('job:nobody', 'none', null);
      expect((await api().get(`/api/user-invites/${token}`).expect(200)).body).toEqual({
        kpmName: 'Bekasi Barat Branch', kpmCode: expect.any(String), companyName: 'Prudential', fullName: 'Rina Kartika',
        roleLabel: 'Agent', makeOwner: false, expiresAt: made.invitation.expiresAt,
      });
      const rinaId = await account('Rina Kartika', prudential);
      session.current = new RequestContext(rinaId, 'none', null);
      const accepted = (await api().post(`/api/user-invites/${token}/accept`).expect(200)).body;
      expect(accepted).toMatchObject({ kpmId: bekasi.kpmId, kpmName: 'Bekasi Barat Branch' });
      const m = await col('memberships').findOne({ _id: oid(accepted.membershipId) });
      expect(m).toMatchObject({
        userId: rinaId, status: 'active', orgLevelCode: 'AGENT', leaderId: bekasi.aab.membershipId, joinedAs: 'existing_agent',
      });
      expect(await col('userInvitations').findOne({})).toMatchObject({ status: 'accepted', acceptedMembershipId: accepted.membershipId });
      expect((await col('users').findOne({ _id: oid(rinaId) }))?.phone).toBe('+6281277884410');
      expect((await api().post(`/api/user-invites/${token}/accept`).expect(404)).body.error.message).toContain('already used');
    });

    it('P19.28-T1 AC-4 refused before the link is spent: another company’s account; an account already Aktif', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      const token = tokenOf(made.link);
      session.current = new RequestContext(await account('Other', manulife), 'none', null);
      expect((await api().post(`/api/user-invites/${token}/accept`).expect(409)).body.error.code).toBe('TENANT_COMPANY_MISMATCH');
      session.current = new RequestContext(bekasi.aab.userId, 'none', null);
      expect((await api().post(`/api/user-invites/${token}/accept`).expect(409)).body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
      expect(await col('userInvitations').findOne({})).toMatchObject({ status: 'pending' });
    });

    it('P19.28-T1 AC-1 Jadikan KPM Owner: accepting makes them an owner too, granted by the inviter (S3)', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const root = await account('Root', null, { platformRole: 'super_admin' });
      session.current = RequestContext.platform(root);
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { makeOwner: true })).expect(200)).body;
      clock.set(new Date(NOW.getTime() + 60_000));
      const rinaId = await account('Rina Kartika', prudential);
      session.current = new RequestContext(rinaId, 'none', null);
      await api().post(`/api/user-invites/${tokenOf(made.link)}/accept`).expect(200);
      const kpm = await col('kpms').findOne({ _id: oid(bekasi.kpmId) });
      expect(kpm?.owners.map((o: { userId: string }) => o.userId)).toEqual([bekasi.owner.userId, rinaId]);
      // The grant is the inviter's, never a self-grant (the 19.28 permission review, S3).
      expect(kpm?.owners.find((o: { userId: string }) => o.userId === rinaId)?.addedByUserId).toBe(root);
      expect((await col('auditLog').findOne({ action: 'kpm.owner_added', 'after.userId': rinaId }))?.after)
        .toMatchObject({ via: 'user_invitation', invitationId: made.invitation.id, invitedByUserId: root });
    });

    it('P19.28 S2 an owner-making link with no account bound: another existing account is refused; the invited number passes', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const root = await account('Root', null, { platformRole: 'super_admin' });
      const stranger = await account('Orang Lain', prudential, { phone: '+6281299990000' });
      session.current = RequestContext.platform(root);
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { makeOwner: true })).expect(200)).body;
      session.current = new RequestContext(stranger, 'none', null);
      expect((await api().post(`/api/user-invites/${tokenOf(made.link)}/accept`).expect(404)).body.error.message)
        .toContain('another account');
      // An account made before the invitation, holding the invited number: it is theirs.
      await col('users').updateOne({ _id: oid(stranger) }, { $set: { phone: '+6281277884410' } });
      await api().post(`/api/user-invites/${tokenOf(made.link)}/accept`).expect(200);
      expect((await col('kpms').findOne({ _id: oid(bekasi.kpmId) }))?.owners.map((o: { userId: string }) => o.userId))
        .toContain(stranger);
    });

    it('P19.28 S2 an ordinary link stays a bearer link: an existing account of the company accepts it', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const holder = await account('Pemegang Tautan', prudential, { phone: '+6281299990000' });
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      session.current = new RequestContext(holder, 'none', null);
      await api().post(`/api/user-invites/${tokenOf(made.link)}/accept`).expect(200);
    });

    it('P19.28 S2 an inviter who can no longer make owners: the person joins as a member, not an owner, and the audit says why', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      session.current = ownerOf(bekasi);
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { makeOwner: true })).expect(200)).body;
      // The inviter is no longer an owner.
      await col('kpms').updateOne({ _id: oid(bekasi.kpmId) }, { $set: { owners: [] } });
      clock.set(new Date(NOW.getTime() + 60_000));
      const rinaId = await account('Rina Kartika', prudential);
      session.current = new RequestContext(rinaId, 'none', null);
      const accepted = (await api().post(`/api/user-invites/${tokenOf(made.link)}/accept`).expect(200)).body;
      expect(await col('memberships').findOne({ _id: oid(accepted.membershipId) })).toMatchObject({ status: 'active' });
      expect((await col('kpms').findOne({ _id: oid(bekasi.kpmId) }))?.owners).toEqual([]);
      expect((await col('auditLog').findOne({ action: 'user_invitation.accepted' }))?.after)
        .toMatchObject({ makeOwner: false, ownerDropped: 'inviter_may_not_make_owner' });
    });

    it('P19.28 T1 a token with a valid secret and another KPM’s id is 404 — a link opens its own KPM alone', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      const [, secret] = tokenOf(made.link).split('.');
      session.current = new RequestContext('job:nobody', 'none', null);
      const res = await api().get(`/api/user-invites/${bsd.kpmId}.${secret}`).expect(404);
      expect(res.body.error.message).toContain('not valid');
      await api().get(`/api/user-invites/${tokenOf(made.link)}`).expect(200);
    });
  });

  describe('a new KPM inline (AC-3)', () => {
    it('P19.28-T1 AC-3 Tambah user with KPM baru: the KPM from its template, code automatic, an owner invitation to its AB', async () => {
      const res = await add({
        fullName: 'Rina Kartika', phone: '081277884410', newKpm: { branchName: 'Bintaro Branch', companyId: prudential },
        role: 'AGENT', makeOwner: false,
      }).expect(200);
      expect(res.body.kpm).toMatchObject({ branch: 'Bintaro Branch', created: true, code: expect.stringMatching(/^\d{4}$/) });
      expect(res.body.invitation).toMatchObject({ role: { code: 'AB', class: 'ab' }, makeOwner: true, leaderMembershipId: null });
      expect(await col('auditLog').countDocuments({ action: 'kpm.created', targetId: res.body.kpm.id })).toBe(1);
      expect(await col('activityTypes').countDocuments({ kpmId: res.body.kpm.id })).toBeGreaterThan(0);
    });
  });

  describe('Masukkan (AC-2, AC-3)', () => {
    /** Fajar, registered to `kpmId` and placed by nobody: a pending membership with no leader. */
    async function unplaced(kpmId: string) {
      const userId = await account('Fajar Nugroho', prudential, { email: 'untagged@example.test' });
      const m = await hierarchy.create(RequestContext.joiningTenant(new RequestContext(userId, 'none', null), kpmId), {
        userId, role: 'AGENT', leaderId: null, status: 'pending',
      });
      return { userId, pendingId: String(m._id) };
    }

    it('P19.28-T1 AC-2 places somebody waiting in a KPM: Aktif at once, the waiting row retired, told in the app, audited', async () => {
      const bsd = await office('BSD City Branch');
      const fajar = await unplaced(bsd.kpmId);
      const res = await api().post(`/api/admin/accounts/${fajar.userId}/placement`)
        .send({ kpmId: bsd.kpmId, role: 'AGENT', leaderMembershipId: bsd.owner.membershipId }).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'placed', kpm: { id: bsd.kpmId, created: false },
        person: { userId: fajar.userId, fullName: 'Fajar Nugroho', email: 'untagged@example.test' }, appLink: APP,
      });
      expect(await col('memberships').findOne({ _id: oid(res.body.membershipId) }))
        .toMatchObject({ status: 'active', leaderId: bsd.owner.membershipId, joinedAs: 'existing_agent' });
      expect(await col('memberships').findOne({ _id: oid(fajar.pendingId) }))
        .toMatchObject({ status: 'removed', deletedAt: expect.any(Date) });
      expect(sent).toEqual([expect.objectContaining({ userId: fajar.userId, templateId: 'member.placed' })]);
      const audit = await col('auditLog').findOne({ action: 'member.placed' });
      expect(audit).toMatchObject({ kpmId: bsd.kpmId });
      expect(audit?.before).toMatchObject({ kpmId: bsd.kpmId, membershipId: fajar.pendingId, status: 'pending' });
      expect(audit?.after).toMatchObject({ kpmId: bsd.kpmId, role: 'AGENT', status: 'active', newKpm: false });
    });

    it('P19.28-T1 AC-3 KPM baru: made, the person its AB and first owner, in one step', async () => {
      const bsd = await office('BSD City Branch');
      const fajar = await unplaced(bsd.kpmId);
      const res = await api().post(`/api/admin/accounts/${fajar.userId}/placement`)
        .send({ newKpm: { branchName: 'Bintaro Branch', companyId: prudential } }).expect(200);
      expect(res.body.kpm).toMatchObject({ branch: 'Bintaro Branch', created: true });
      const kpm = await col('kpms').findOne({ _id: oid(res.body.kpm.id) });
      expect(kpm?.owners.map((o: { userId: string }) => o.userId)).toEqual([fajar.userId]);
      expect(await col('memberships').findOne({ _id: oid(res.body.membershipId) }))
        .toMatchObject({ kpmId: res.body.kpm.id, orgLevelCode: 'AB', leaderId: null, status: 'active' });
    });

    /*
     * **The 2026-11-22 walk** (OD-475): Fajar Nugroho, registered with his own password and never signed in since, placed
     * as Bintaro Branch's first owner, read *Owner belum diundang* — a red pill, one more *Perlu tindakan*, and *Kirim
     * undangan* on his ⋯. His account is his: he reads *Aktif* wherever an owner's state is shown.
     */
    it('OD-475 KPM baru by Masukkan: an account already theirs is an Aktif owner, on the same 30-day trial as the form’s', async () => {
      const bsd = await office('BSD City Branch');
      const fajar = await unplaced(bsd.kpmId);
      await col('users').updateOne({ _id: oid(fajar.userId) }, { $set: { lastLoginAt: null, emailVerifiedAt: NOW } });
      const res = await api().post(`/api/admin/accounts/${fajar.userId}/placement`)
        .send({ newKpm: { branchName: 'Bintaro Branch', companyId: prudential } }).expect(200);
      const bintaro = await tenants.readProfile(SUPER_ADMIN, res.body.kpm.id) as KpmAdminView;
      expect(bintaro.ownerState).toBe('active');
      expect((await owners.list(SUPER_ADMIN, res.body.kpm.id)).owners).toEqual([
        expect.objectContaining({ userId: fajar.userId, state: 'active' }),
      ]);
      // The same subscription a KPM made by the *KPM baru* form starts on (P19.23-T5 AC-3).
      const form = await tenants.readProfile(
        SUPER_ADMIN, (await tenants.createKpm(SUPER_ADMIN, { companyId: prudential, branchName: 'Form Branch' }))._id,
      ) as KpmAdminView;
      expect(bintaro.subscription).toEqual(form.subscription);
      expect(bintaro.subscriptionState).toBe(form.subscriptionState);
      expect(bintaro.subscription).toMatchObject({ startDate: '2026-11-22' });
    });

    it('OD-475 an account somebody else made, never opened, still reads Belum diundang as a new KPM’s owner', async () => {
      const bsd = await office('BSD City Branch');
      const fajar = await unplaced(bsd.kpmId);
      await col('users').updateOne({ _id: oid(fajar.userId) }, { $set: { lastLoginAt: null, emailVerifiedAt: null } });
      const res = await api().post(`/api/admin/accounts/${fajar.userId}/placement`)
        .send({ newKpm: { branchName: 'Bintaro Branch', companyId: prudential } }).expect(200);
      expect((await tenants.readProfile(SUPER_ADMIN, res.body.kpm.id) as KpmAdminView).ownerState).toBe('not_invited');
    });

    it('P19.28-T1 AC-6 the owner step fails: nothing is left — no KPM, no membership, the waiting row put back', async () => {
      const bsd = await office('BSD City Branch');
      const fajar = await unplaced(bsd.kpmId);
      const add = jest.spyOn(owners, 'add').mockRejectedValueOnce(new Error('owners down'));
      await api().post(`/api/admin/accounts/${fajar.userId}/placement`)
        .send({ newKpm: { branchName: 'Bintaro Branch', companyId: prudential } }).expect(500);
      add.mockRestore();
      expect(await col('kpms').countDocuments({ branchName: 'Bintaro Branch', deletedAt: null })).toBe(0);
      expect(await col('memberships').countDocuments({ userId: fajar.userId, deletedAt: null, status: 'active' })).toBe(0);
      expect(await col('memberships').findOne({ _id: oid(fajar.pendingId) })).toMatchObject({ status: 'pending', deletedAt: null });
      expect(await col('auditLog').countDocuments({ action: 'kpm.discarded' })).toBe(1);
      expect(await col('auditLog').countDocuments({ action: 'member.placed' })).toBe(0);
      expect(sent).toEqual([]);
    });

    it('P19.28-T1 AC-6 refuses an account of another company, and one already Aktif', async () => {
      const bsd = await office('BSD City Branch');
      const other = await account('Lain', manulife);
      expect((await api().post(`/api/admin/accounts/${other}/placement`).send({ kpmId: bsd.kpmId, role: 'AB' }).expect(409))
        .body.error.code).toBe('TENANT_COMPANY_MISMATCH');
      expect((await api().post(`/api/admin/accounts/${bsd.aab.userId}/placement`).send({ kpmId: bsd.kpmId, role: 'AB' })
        .expect(409)).body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
    });
  });

  describe('Menunggu and the chips (AC-5)', () => {
    it('P19.28-T1 AC-5 Menunggu lists Diundang with its day and Belum ada KPM with its email and its KPM; chips count apart', async () => {
      const bsd = await office('BSD City Branch');
      await add(rina(bsd.kpmId, bsd.aab.membershipId)).expect(200);
      const fajar = await account('Fajar Nugroho', prudential, { email: 'untagged@example.test' });
      await hierarchy.create(RequestContext.joiningTenant(new RequestContext(fajar, 'none', null), bsd.kpmId), {
        userId: fajar, role: 'AGENT', leaderId: null, status: 'pending',
      });
      await account('Nobody Yet', prudential, { email: 'loose@example.test' });
      const gone = await member(bsd.kpmId, 'Dimas Pratama', 'AGENT', bsd.aab.membershipId);
      await col('memberships').updateOne({ _id: oid(gone.membershipId) }, { $set: { status: 'removed', removedAt: NOW } });
      await member(bsd.kpmId, 'Tes Akun', 'AGENT', bsd.aab.membershipId, { testAccount: true });
      await col('memberships').updateOne({ userId: (await col('users').findOne({ fullName: 'Tes Akun' }))?._id.toString() }, { $set: { testAccount: true } });

      const page = await waiting.page(SUPER_ADMIN, {});
      expect(page.rows.map((r) => [r.kind, r.fullName, r.kpm?.branch ?? null, r.email, r.since])).toEqual([
        ['unplaced', 'Fajar Nugroho', 'BSD City Branch', 'untagged@example.test', '2026-11-22'],
        ['unplaced', 'Nobody Yet', null, 'loose@example.test', '2026-11-22'],
        ['invited', 'Rina Kartika', 'BSD City Branch', null, '2026-11-22'],
      ]);
      // A test account waiting, and one that left: in no chip and no row of Menunggu (ADR-0267 §1).
      const tesWaiting = await account('Tes Menunggu', prudential, { testAccount: true });
      await hierarchy.create(RequestContext.joiningTenant(new RequestContext(tesWaiting, 'none', null), bsd.kpmId), {
        userId: tesWaiting, role: 'AGENT', leaderId: null, status: 'pending',
      });
      await col('memberships').updateOne({ userId: tesWaiting }, { $set: { testAccount: true } });
      const tesLeft = await member(bsd.kpmId, 'Tes Keluar', 'AGENT', bsd.aab.membershipId, { testAccount: true });
      await col('memberships').updateOne({ _id: oid(tesLeft.membershipId) }, { $set: { status: 'removed', removedAt: NOW, testAccount: true } });

      // Two leaders active (the owner and the AAB); Dimas left; the test accounts count nowhere.
      expect(page.chips).toEqual({ active: 2, pending: 3, removed: 1 });
      const again = await waiting.page(SUPER_ADMIN, {});
      expect(again.chips).toEqual({ active: 2, pending: 3, removed: 1 });
      expect(again.rows.map((r) => r.fullName)).not.toContain('Tes Menunggu');
      // *Aktif* is 19.26's counted member, never recounted (ADR-0284 §1): the same number `countedMembers()` gives.
      expect(again.chips.active).toBe(await col('memberships').countDocuments(countedMembers({ kpmId: bsd.kpmId })));
      expect(await col('auditLog').countDocuments({ action: 'platform_read.members_waiting' })).toBeGreaterThan(0);
      expect((await waiting.page(SUPER_ADMIN, { kpmId: bsd.kpmId })).rows.map((r) => r.fullName))
        .toEqual(['Fajar Nugroho', 'Rina Kartika']);
    });

    it('P19.28-T1 AC-5 the read is the Super Admin’s: an Owner is refused', async () => {
      const bsd = await office('BSD City Branch');
      await expect(waiting.page(ownerOf(bsd), {})).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });
  });

  /*
   * **Menunggu's filters, search and pages** (ADR-0286 §5): the scope narrows the three sources alike — invitations,
   * pending memberships and accounts in no KPM — and a search finds an invitation by its typed name, its number or its
   * email, or by the account it is bound to.
   */
  describe('Menunggu — filters, search and pages (AC-5)', () => {
    async function scene() {
      const bsd = await office('BSD City Branch');
      const kuningan = (await tenants.createKpm(SUPER_ADMIN, { companyId: manulife, branchName: 'Kuningan Branch' }))._id;
      await add(rina(bsd.kpmId, bsd.aab.membershipId)).expect(200);
      await add({ fullName: 'Budi Santoso', phone: '0813 1111 2222', email: 'budi@example.test', kpmId: kuningan, role: 'AB' })
        .expect(200);
      // Dewi registered to BSD and waits there; an invitation to her email binds to her account and is the row she reads.
      const dewi = await account('Dewi Lestari', prudential, { email: 'dewi@example.test' });
      await hierarchy.create(RequestContext.joiningTenant(new RequestContext(dewi, 'none', null), bsd.kpmId), {
        userId: dewi, role: 'AGENT', leaderId: null, status: 'pending',
      });
      await add(rina(bsd.kpmId, bsd.aab.membershipId, { fullName: 'Dewi', phone: '0815 3333 4444', email: 'dewi@example.test' }))
        .expect(200);
      const fajar = await account('Fajar Nugroho', prudential, { email: 'fajar@example.test' });
      await hierarchy.create(RequestContext.joiningTenant(new RequestContext(fajar, 'none', null), bsd.kpmId), {
        userId: fajar, role: 'AGENT', leaderId: null, status: 'pending',
      });
      await account('Nobody Yet', prudential, { email: 'loose@example.test', avatarUrl: 'avatars/nobody.jpg' });
      await account('Tes Loose', prudential, { testAccount: true });
      const tes = await account('Tes Pending', prudential, { testAccount: true });
      await hierarchy.create(RequestContext.joiningTenant(new RequestContext(tes, 'none', null), bsd.kpmId), {
        userId: tes, role: 'AGENT', leaderId: null, status: 'pending',
      });
      await col('memberships').updateOne({ userId: tes }, { $set: { testAccount: true } });
      return { bsd, kuningan, dewi };
    }
    const names = async (scope: Parameters<AnggotaWaiting['page']>[1]) =>
      (await waiting.page(SUPER_ADMIN, scope)).rows.map((r) => r.fullName);

    it('ADR-0286 §5 one person once, by name: a bound invitation reads as its account, test accounts in no row', async () => {
      const { dewi } = await scene();
      const page = await waiting.page(SUPER_ADMIN, {});
      expect(page.rows.map((r) => [r.kind, r.fullName])).toEqual([
        ['invited', 'Budi Santoso'], ['invited', 'Dewi Lestari'], ['unplaced', 'Fajar Nugroho'], ['unplaced', 'Nobody Yet'],
        ['invited', 'Rina Kartika'],
      ]);
      expect(page.rows.find((r) => r.fullName === 'Dewi Lestari')).toMatchObject({ userId: dewi, membershipId: null });
      expect(page.rows.find((r) => r.fullName === 'Budi Santoso')).toMatchObject({
        company: { name: 'Manulife' }, role: { code: 'AB', class: 'ab' }, expired: false,
      });
      expect(page.total).toBe(5);
      expect((await waiting.page(SUPER_ADMIN, { page: 2 })).rows).toEqual([]);
    });

    it('ADR-0286 §5 narrows by company, by KPM — a malformed id finds nothing — and by role', async () => {
      const { bsd } = await scene();
      expect(await names({ companyId: manulife })).toEqual(['Budi Santoso']);
      expect(await names({ kpmId: bsd.kpmId })).toEqual(['Dewi Lestari', 'Fajar Nugroho', 'Rina Kartika']);
      expect(await names({ kpmId: 'not-an-office' })).toEqual([]);
      expect(await names({ role: 'ab' })).toEqual(['Budi Santoso']);
      expect(await names({ role: 'agent' })).toEqual(['Dewi Lestari', 'Rina Kartika']);
    });

    it('ADR-0286 §5 searches a name, a number however typed, an invitation’s email, or its account’s', async () => {
      await scene();
      expect(await names({ q: 'Rina' })).toEqual(['Rina Kartika']);
      expect(await names({ q: '0812-7788' })).toEqual(['Rina Kartika']);
      expect(await names({ q: 'budi@example' })).toEqual(['Budi Santoso']);
      expect(await names({ q: 'dewi@example' })).toEqual(['Dewi Lestari']);
      expect(await names({ q: 'loose@' })).toEqual(['Nobody Yet']);
      expect(await names({ q: 'zz' })).toEqual([]);
      await expect(waiting.page(SUPER_ADMIN, { q: ' a ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('ADR-0267 §1 test accounts: `only` lists them alone, `include` beside the others, each tagged', async () => {
      await scene();
      const only = (await waiting.page(SUPER_ADMIN, { testAccount: 'only' })).rows;
      expect(only.map((r) => [r.fullName, r.testAccount])).toEqual([['Tes Loose', true], ['Tes Pending', true]]);
      const all = (await waiting.page(SUPER_ADMIN, { testAccount: 'include' })).rows;
      expect(all.map((r) => r.fullName)).toEqual([
        'Budi Santoso', 'Dewi Lestari', 'Fajar Nugroho', 'Nobody Yet', 'Rina Kartika', 'Tes Loose', 'Tes Pending',
      ]);
      // The chips never count them, whichever is asked.
      expect((await waiting.page(SUPER_ADMIN, { testAccount: 'include' })).chips.pending).toBe(5);
    });

    it('ADR-0286 §5 the chips alone — what Anggota’s own read shows — over the same scope and search', async () => {
      await scene();
      expect(await waiting.chips(SUPER_ADMIN, {})).toEqual({ active: 2, pending: 5, removed: 0 });
      expect(await waiting.chips(SUPER_ADMIN, { role: 'agent' })).toEqual({ active: 0, pending: 2, removed: 0 });
      expect(await waiting.chips(SUPER_ADMIN, { q: 'Rina' })).toEqual({ active: 0, pending: 1, removed: 0 });
      expect(await waiting.chips(SUPER_ADMIN, { companyId: manulife })).toEqual({ active: 0, pending: 1, removed: 0 });
      await expect(waiting.chips(ownerOf((await office('Bekasi Barat Branch'))), {})).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('ADR-0286 §5 two people of one name keep one order, page after page: by name, then by id', async () => {
      const bsd = await office('BSD City Branch');
      await add(rina(bsd.kpmId, bsd.aab.membershipId, { fullName: 'Sama Nama' })).expect(200);
      await add(rina(bsd.kpmId, bsd.aab.membershipId, { fullName: 'Sama Nama', phone: '0813 1111 2222' })).expect(200);
      const waitingId = await account('Sama Nama', prudential);
      await hierarchy.create(RequestContext.joiningTenant(new RequestContext(waitingId, 'none', null), bsd.kpmId), {
        userId: waitingId, role: 'AGENT', leaderId: null, status: 'pending',
      });
      await account('Sama Nama', prudential);
      const ids = (await waiting.page(SUPER_ADMIN, {})).rows.map((r) => r.invitationId ?? r.membershipId ?? r.userId);
      expect(ids).toHaveLength(4);
      expect(ids).toEqual([...ids].sort());
      expect((await waiting.page(SUPER_ADMIN, {})).rows.map((r) => r.invitationId ?? r.membershipId ?? r.userId)).toEqual(ids);
    });

    it('ADR-0286 §5 hasPhone says whether WhatsApp has a number to write to — and the number is never on the row', async () => {
      await scene();
      await col('users').updateOne({ fullName: 'Fajar Nugroho' }, { $set: { phone: '0812-9999-0000' } });
      await col('users').updateOne({ fullName: 'Nobody Yet' }, { $set: { phone: '12' } });
      const rows = (await waiting.page(SUPER_ADMIN, {})).rows;
      expect(rows.map((r) => [r.fullName, r.hasPhone])).toEqual([
        ['Budi Santoso', true], ['Dewi Lestari', true], ['Fajar Nugroho', true], ['Nobody Yet', false], ['Rina Kartika', true],
      ]);
      // An account with no number at all.
      await col('users').updateOne({ fullName: 'Fajar Nugroho' }, { $set: { phone: null } });
      expect((await waiting.page(SUPER_ADMIN, { q: 'Fajar' })).rows).toEqual([expect.objectContaining({ hasPhone: false })]);
      expect(JSON.stringify(rows)).not.toMatch(/8129999|8127788|phone/);
    });

    it('ADR-0206 §4 a support session only looks, and is refused this read', async () => {
      const support = new RequestContext('root', 'super_admin', null, 'another-admin');
      await expect(waiting.page(support, {})).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('INVITES.EXPIRY_DAYS an invitation past its days still reads Diundang, marked expired', async () => {
      await scene();
      clock.set(new Date(NOW.getTime() + INVITES.EXPIRY_DAYS * DAY));
      const rows = (await waiting.page(SUPER_ADMIN, { q: 'Rina' })).rows;
      expect(rows).toEqual([expect.objectContaining({ kind: 'invited', expired: true, since: '2026-11-22' })]);
    });

    it('each row’s photo is a signed link, signed once per key; none, the initials', async () => {
      await scene();
      const linksFor = jest.fn(async (keys: (string | null | undefined)[]) =>
        new Map(keys.flatMap((k) => (k ? [[k, `https://signed.example/${k}`] as [string, string]] : []))));
      const withPhotos = new AnggotaWaiting(
        wired.kpms as never, wired.companies as never, wired.users as never, wired.memberships,
        new UserInvitationRepository(mongoose.model(UserInvitation.name, UserInvitationSchema) as never), wired.orgLevels,
        wired.audit, clock, { linksFor } as never,
      );
      const rows = (await withPhotos.page(SUPER_ADMIN, {})).rows;
      expect(rows.find((r) => r.fullName === 'Nobody Yet')?.avatarUrl).toBe('https://signed.example/avatars/nobody.jpg');
      expect(rows.find((r) => r.fullName === 'Fajar Nugroho')?.avatarUrl).toBeNull();
      expect(rows.find((r) => r.fullName === 'Rina Kartika')?.avatarUrl).toBeNull();
      expect(linksFor).toHaveBeenCalledTimes(1);
    });
  });

  /*
   * **What each route refuses, and what a failure leaves** (ADR-0286 §3, §4): the reach of the sheet and of *Masukkan*,
   * the accounts that cannot be added, a link that opens nothing, and the two writes that undo themselves.
   */
  describe('refusals and undo (AC-6)', () => {
    const invitationRepo = UserInvitationRepository.prototype;
    const place = (userId: string, body: Record<string, unknown>) => api().post(`/api/admin/accounts/${userId}/placement`).send(body);
    const accept = (token: string) => api().post(`/api/user-invites/${token}/accept`);

    afterEach(() => jest.restoreAllMocks());

    it('ADR-0286 §4 the choices for KPM baru are the Super Admin’s: the company’s ladder, senior first named', async () => {
      const res = await api().get(`/api/user-invitations/options?companyId=${prudential}`).expect(200);
      expect(res.body).toMatchObject({
        kpm: null, company: { id: prudential, name: 'Prudential' }, seniorCode: 'AB', leaders: [], mayMakeOwner: true,
        mayMakeKpm: true,
      });
      expect(res.body.roles.map((r: { code: string }) => r.code)).toContain('AGENT');
      expect((await api().get('/api/user-invitations/options?companyId=66f0000000000000000000a9').expect(404)).body.error.code)
        .toBe('NOT_FOUND');
      // Outside a KPM, with no KPM named, the Super Admin is asked to name one.
      expect((await api().get('/api/user-invitations/options').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      const bekasi = await office('Bekasi Barat Branch');
      session.current = ownerOf(bekasi);
      expect((await api().get(`/api/user-invitations/options?companyId=${prudential}`).expect(403)).body.error.code)
        .toBe('PERM_DENIED');
      // The Owner's own KPM, named or not.
      expect((await api().get('/api/user-invitations/options').expect(200)).body.kpm.id).toBe(bekasi.kpmId);
    });

    it('ADR-0286 §4 an archived KPM, or one that is not there, takes nobody: 404', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      await col('kpms').updateOne({ _id: oid(bekasi.kpmId) }, { $set: { status: 'archived' } });
      await api().get(`/api/user-invitations/options?kpmId=${bekasi.kpmId}`).expect(404);
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(404);
      await add(rina('66f0000000000000000000a9', bekasi.aab.membershipId)).expect(404);
      await add({ fullName: 'Rina', phone: '0812 7788 4410', newKpm: { branchName: 'X', companyId: '66f0000000000000000000a9' } })
        .expect(404);
      expect(await col('userInvitations').countDocuments({})).toBe(0);
    });

    it('ADR-0286 §3 the AgencyBoost team, and somebody Aktif here already, are never added', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      await account('Tim AgencyBoost', null, { platformRole: 'super_admin', phone: '+6281277884410' });
      const team = await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(409);
      expect(team.body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
      await col('users').updateOne({ fullName: 'Tim AgencyBoost' }, { $set: { phone: null } });
      await col('users').updateOne({ _id: oid(bekasi.aab.userId) }, { $set: { phone: '+6281277884410' } });
      const here = await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(409);
      expect(here.body.error).toMatchObject({ code: 'ORG_AGENT_ALREADY_TAGGED', details: { reason: 'member_here' } });
    });

    it('ADR-0286 §4 two adds of one number at once: the index stops the second, as the same 409', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200);
      jest.spyOn(invitationRepo, 'exists').mockResolvedValueOnce(false);
      expect((await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(409)).body.error.code).toBe('ORG_INVITE_PENDING');
      expect(await col('userInvitations').countDocuments({})).toBe(1);
    });

    it('ADR-0286 §2 KPM baru: an invitation that cannot be written discards the KPM made for it', async () => {
      jest.spyOn(invitationRepo, 'create').mockRejectedValueOnce(new Error('invitations down'));
      await add({ fullName: 'Rina', phone: '0812 7788 4410', newKpm: { branchName: 'Bintaro Branch', companyId: prudential } })
        .expect(500);
      expect(await col('kpms').countDocuments({ branchName: 'Bintaro Branch', deletedAt: null })).toBe(0);
      expect(await col('auditLog').countDocuments({ action: 'kpm.discarded' })).toBe(1);
    });

    it('ADR-0286 §3 Masukkan refuses a KPM and a new one together, no such account, and no agent code', async () => {
      const bsd = await office('BSD City Branch');
      const fajar = await account('Fajar Nugroho', prudential);
      expect((await place(fajar, { kpmId: bsd.kpmId, role: 'AB', newKpm: { branchName: 'X', companyId: prudential } })
        .expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      await place('66f0000000000000000000a9', { kpmId: bsd.kpmId, role: 'AB' }).expect(404);
      await place('not-an-account', { kpmId: bsd.kpmId, role: 'AB' }).expect(404);
      const codeless = await account('Tanpa Kode', prudential, { agentCode: null });
      expect((await place(codeless, { kpmId: bsd.kpmId, role: 'AB' }).expect(409)).body.error.code).toBe('TENANT_COMPANY_MISMATCH');
      expect((await place(fajar, { kpmId: bsd.kpmId, role: 'AGENT', leaderMembershipId: '66f0000000000000000000a9' })
        .expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
      expect(await col('memberships').countDocuments({ userId: fajar })).toBe(0);
    });

    it('ADR-0286 §3 Masukkan an account in no KPM, as an owner: Aktif, owner, audited from no KPM', async () => {
      const bsd = await office('BSD City Branch');
      const fajar = await account('Fajar Nugroho', prudential);
      const res = await place(fajar, { kpmId: bsd.kpmId, role: 'AB', makeOwner: true }).expect(200);
      expect(await col('memberships').findOne({ _id: oid(res.body.membershipId) })).toMatchObject({ status: 'active', role: 'ab' });
      const kpm = await col('kpms').findOne({ _id: oid(bsd.kpmId) });
      expect(kpm?.owners.map((o: { userId: string }) => o.userId)).toEqual([bsd.owner.userId, fajar]);
      expect((await col('auditLog').findOne({ action: 'member.placed' }))?.before).toEqual({ kpmId: null });
    });

    it('ADR-0286 §4 Kirim ulang and Batalkan: no such invitation is 404; an accepted one 409; a write that lost the race 409', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      await api().post('/api/user-invitations/66f0000000000000000000a9/resend').expect(404);
      await api().delete('/api/user-invitations/66f0000000000000000000a9').expect(404);
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      jest.spyOn(invitationRepo, 'updateIfWaiting').mockResolvedValueOnce(false);
      expect((await api().post(`/api/user-invitations/${made.invitation.id}/resend`).expect(409)).body.error.code)
        .toBe('ORG_REQUEST_ALREADY_DECIDED');
      jest.spyOn(invitationRepo, 'updateIfWaiting').mockResolvedValueOnce(false);
      expect((await api().delete(`/api/user-invitations/${made.invitation.id}`).expect(409)).body.error.code)
        .toBe('ORG_REQUEST_ALREADY_DECIDED');
      jest.restoreAllMocks();
      session.current = new RequestContext(await account('Rina Kartika', prudential), 'none', null);
      await accept(tokenOf(made.link)).expect(200);
      session.current = SUPER_ADMIN;
      const accepted = await api().post(`/api/user-invitations/${made.invitation.id}/resend`).expect(409);
      expect(accepted.body.error).toMatchObject({ code: 'ORG_REQUEST_ALREADY_DECIDED', details: { status: 'accepted' } });
      await api().delete(`/api/user-invitations/${made.invitation.id}`).expect(409);
    });

    it('ADR-0286 §4 a link opens nothing: malformed, a wrong secret, an archived KPM — each 404', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      session.current = new RequestContext('job:nobody', 'none', null);
      await api().get('/api/user-invites/nonsense').expect(404);
      await api().get(`/api/user-invites/${bekasi.kpmId}.not-the-secret`).expect(404);
      await api().get(`/api/user-invites/${tokenOf(made.link)}`).expect(200);
      await col('kpms').updateOne({ _id: oid(bekasi.kpmId) }, { $set: { status: 'archived' } });
      await api().get(`/api/user-invites/${tokenOf(made.link)}`).expect(404);
    });

    it('ADR-0286 §4 accept refuses the Super Admin, another account than the one invited, and no agent code', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      await account('Dewi Lestari', prudential, { email: 'dewi@example.test' });
      const open = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { phone: '0813 5555 6666', fullName: 'Wulan' }))
        .expect(200)).body;
      const bound = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { email: 'dewi@example.test' })).expect(200)).body;
      const token = tokenOf(bound.link);
      expect((await accept(token).expect(409)).body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
      session.current = new RequestContext(await account('Someone Else', prudential), 'none', null);
      expect((await accept(token).expect(404)).body.error.code).toBe('NOT_FOUND');
      session.current = new RequestContext(await account('Wulan', prudential, { agentCode: null }), 'none', null);
      expect((await accept(tokenOf(open.link)).expect(409)).body.error.code).toBe('TENANT_COMPANY_MISMATCH');
      expect(await col('userInvitations').countDocuments({ status: 'pending' })).toBe(2);
    });

    it('ADR-0286 §4 accept: a leader gone since is 422 and the link still works', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      await col('memberships').updateOne({ _id: oid(bekasi.aab.membershipId) }, { $set: { status: 'removed' } });
      session.current = new RequestContext(await account('Rina Kartika', prudential), 'none', null);
      expect((await accept(tokenOf(made.link)).expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
      expect(await col('userInvitations').findOne({})).toMatchObject({ status: 'pending' });
    });

    it('ADR-0286 §3 accept by somebody waiting in another KPM: the waiting row ends, their own number kept', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      const rinaId = await account('Rina Kartika', prudential, { phone: '+6281299990000' });
      const pending = await hierarchy.create(RequestContext.joiningTenant(new RequestContext(rinaId, 'none', null), bsd.kpmId), {
        userId: rinaId, role: 'AGENT', leaderId: null, status: 'pending',
      });
      session.current = new RequestContext(rinaId, 'none', null);
      await accept(tokenOf(made.link)).expect(200);
      expect(await col('memberships').findOne({ _id: pending._id })).toMatchObject({ status: 'removed', deletedAt: expect.any(Date) });
      expect((await col('users').findOne({ _id: oid(rinaId) }))?.phone).toBe('+6281299990000');
    });

    /*
     * **Defence in depth** (`docs-and-tests-required.md`: the API refuses what the screen would): the guard and the DTO
     * stop each of these before the service is reached over HTTP, so the service is asked directly — a caller that is
     * not this controller meets the same refusal.
     */
    it('the service refuses on its own: a support session places nobody; no KPM to act in; a number that is none', async () => {
      const service = app.get(AddUserService);
      const fajar = await account('Fajar Nugroho', prudential);
      const support = new RequestContext('root', 'super_admin', null, 'another-admin');
      await expect(service.place(support, fajar, { kpmId: '66f0000000000000000000a9', role: 'AB' }, APP))
        .rejects.toMatchObject({ code: 'PERM_DENIED' });
      const nowhere = new RequestContext(fajar, 'none', null);
      await expect(service.options(nowhere, {})).rejects.toMatchObject({ status: 403 });
      await expect(service.options(SUPER_ADMIN, { kpmId: 'not-an-office' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.options(SUPER_ADMIN, { companyId: 'not-a-company' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.add(SUPER_ADMIN, { fullName: 'Rina', phone: '12', kpmId: '66f0000000000000000000a9' }, APP))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('ADR-0286 §3 KPM baru for somebody already Aktif is refused before any KPM is made', async () => {
      const bsd = await office('BSD City Branch');
      await col('users').updateOne({ _id: oid(bsd.aab.userId) }, { $set: { phone: '+6281277884410' } });
      const res = await add({ fullName: 'Rina', phone: '0812 7788 4410', newKpm: { branchName: 'Bintaro Branch', companyId: prudential } })
        .expect(409);
      expect(res.body.error).toMatchObject({ code: 'ORG_AGENT_ALREADY_TAGGED', details: { reason: 'member_elsewhere' } });
      expect(await col('kpms').countDocuments({ branchName: 'Bintaro Branch' })).toBe(0);
    });

    it('ADR-0286 §4 accept by an account that is not there is 404; a link spent meanwhile reads as used', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId)).expect(200)).body;
      session.current = new RequestContext('66f0000000000000000000a9', 'none', null);
      await accept(tokenOf(made.link)).expect(404);
      session.current = new RequestContext(await account('Rina Kartika', prudential), 'none', null);
      jest.spyOn(invitationRepo, 'updateIfWaiting').mockResolvedValueOnce(false);
      expect((await accept(tokenOf(made.link)).expect(404)).body.error.message).toContain('already used');
      expect(await col('memberships').countDocuments({ kpmId: bekasi.kpmId, status: 'active' })).toBe(2);
    });

    it('P19.28-T2 AC-2 Leader: the ABs first, then the AABs, each by name', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      await member(bekasi.kpmId, 'Ahmad Bekasi', 'AAB', bekasi.owner.membershipId);
      const res = await api().get(`/api/user-invitations/options?kpmId=${bekasi.kpmId}`).expect(200);
      expect(res.body.leaders.map((l: { fullName: string }) => l.fullName))
        .toEqual(['Owner of Bekasi Barat Branch', 'Ahmad Bekasi', 'Sinta Bekasi Barat Branch']);
    });

    it('ADR-0286 §4 accept whose owner step fails: the link is given back and the waiting row put back', async () => {
      const bekasi = await office('Bekasi Barat Branch');
      const bsd = await office('BSD City Branch');
      // A Super Admin who still is one at acceptance: else no owner step is taken (ADR-0286 §2).
      session.current = RequestContext.platform(await account('Root', null, { platformRole: 'super_admin' }));
      const made = (await add(rina(bekasi.kpmId, bekasi.aab.membershipId, { makeOwner: true })).expect(200)).body;
      const rinaId = await account('Rina Kartika', prudential);
      const pending = await hierarchy.create(RequestContext.joiningTenant(new RequestContext(rinaId, 'none', null), bsd.kpmId), {
        userId: rinaId, role: 'AGENT', leaderId: null, status: 'pending',
      });
      jest.spyOn(owners, 'add').mockRejectedValueOnce(new Error('owners down'));
      session.current = new RequestContext(rinaId, 'none', null);
      await accept(tokenOf(made.link)).expect(500);
      expect(await col('userInvitations').findOne({})).toMatchObject({ status: 'pending', acceptedAt: null });
      expect(await col('memberships').findOne({ _id: pending._id })).toMatchObject({ status: 'pending', deletedAt: null });
      expect(await col('memberships').countDocuments({ userId: rinaId, status: 'active', deletedAt: null })).toBe(0);
    });
  });
});
