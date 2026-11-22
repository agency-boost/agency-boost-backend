import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { Kpm, KpmSchema } from './kpm.schema';
import { ownerEntry, ownerUserIdsOf } from './kpm-owners';
import { KpmOwnersController } from './kpm-owners.controller';
import { KpmOwnersService } from './kpm-owners.service';

const NOW = new Date('2026-11-22T03:00:00Z');
const KPM_B = '66f0000000000000000000b1';
const oid = () => String(new mongoose.Types.ObjectId());

/**
 * **A KPM's owners: the model, the service and the routes** (P19.27-T1 AC-1, AC-4, T5 AC-2; ADR-0285; F-2 (21 Nov)).
 *
 * The fixture: KPM A with its first owner (the `OWNER` session's account), a second member (`ADMIN`'s account, a KPM
 * Admin), an agent and an invited member; KPM B with an owner and a member of its own. Each route over HTTP: the Super
 * Admin inside the KPM and an owner may add and remove; a KPM Admin is `403 PERM_OWNER_ONLY`; an agent `403`; a member of
 * KPM B is `404` from KPM A; the last owner `409 KPM_LAST_OWNER`.
 */
describe('a KPM’s owners (P19.27, ADR-0285)', () => {
  let app: INestApplication;
  let service: KpmOwnersService;
  let kpms: mongoose.Model<Kpm>;
  let users: mongoose.Model<User>;
  let memberships: mongoose.Model<Membership>;
  let audit: mongoose.Model<AuditLog>;
  const clock = new FixedClock(NOW);
  /** The Super Admin inside KPM A (ADR-0268 §3), as `X-Kpm-Id` makes them. */
  const SUPER_ADMIN_IN_A = RequestContext.superAdminInKpm(SUPER_ADMIN, FIXTURE_KPM);

  beforeAll(async () => {
    await startMongo();
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    users = mongoose.model(User.name, UserSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    service = new KpmOwnersService(
      kpms as never, users as never, new MembershipRepository(memberships as never), new AuditService(audit as never), clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [KpmOwnersController],
      providers: [{ provide: KpmOwnersService, useValue: service }],
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

  let seq = 0;
  async function account(fullName: string, id?: string, over: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const u = await users.create({
      ...(id ? { _id: id } : {}),
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', ...over,
    });
    return String(u._id);
  }
  async function member(kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent', status: 'active' | 'pending' | 'removed' = 'active') {
    seq += 1;
    const [row] = await memberships.insertMany([{
      kpmId, userId, role, status, agentCode: `${70000 + seq}`, agentSeq: seq, leaderCode: `L${seq}`, orgLevelId: 'lvl',
      orgLevelCode: role.toUpperCase(), leaderId: null, ancestorIds: [], depth: 0, deletedAt: null,
    }]);
    return String(row._id);
  }

  /** The session ids as accounts (`OWNER` is `u-owner`, and so on) — ObjectIds the users collection can hold. */
  const ids: Record<'owner' | 'admin' | 'agent' | 'invited' | 'ownerB' | 'memberB', string> = {
    owner: '', admin: '', agent: '', invited: '', ownerB: '', memberB: '',
  };
  const m: Record<keyof typeof ids, string> = { owner: '', admin: '', agent: '', invited: '', ownerB: '', memberB: '' };
  /** The `OWNER` session, with its account the fixture's owner. */
  let ownerSession: RequestContext;
  let adminSession: RequestContext;
  let agentSession: RequestContext;

  beforeEach(async () => {
    await clearCollections();
    ids.owner = await account('Yohanes Saputra');
    ids.admin = await account('Sinta Maharani');
    ids.agent = await account('Joko Prasetyo');
    ids.invited = await account('Rina Kartika');
    ids.ownerB = await account('Hendra Wijaya');
    ids.memberB = await account('Lina Marlina');
    await kpms.create([
      { _id: FIXTURE_KPM, companyId: 'c1', code: '0602', branchName: 'Bekasi Barat Branch', status: 'active', owners: [ownerEntry(ids.owner, new Date('2026-08-01T00:00:00Z'))], deletedAt: null },
      { _id: KPM_B, companyId: 'c1', code: '0555', branchName: 'Kelapa Gading Branch', status: 'active', owners: [ownerEntry(ids.ownerB, new Date('2026-08-01T00:00:00Z'))], deletedAt: null },
    ] as never);
    m.owner = await member(FIXTURE_KPM, ids.owner, 'ab');
    m.admin = await member(FIXTURE_KPM, ids.admin, 'aab');
    m.agent = await member(FIXTURE_KPM, ids.agent, 'agent');
    m.invited = await member(FIXTURE_KPM, ids.invited, 'agent', 'pending');
    m.ownerB = await member(KPM_B, ids.ownerB, 'ab');
    m.memberB = await member(KPM_B, ids.memberB, 'agent');
    const as = (base: RequestContext, userId: string, membershipId: string) => new RequestContext(
      userId, 'none', { ...base.membership!, membershipId },
    );
    ownerSession = as(OWNER, ids.owner, m.owner);
    adminSession = as(ADMIN, ids.admin, m.admin);
    agentSession = as(AGENT, ids.agent, m.agent);
    session.current = ownerSession;
  });

  const owners = async (kpmId = FIXTURE_KPM) => ownerUserIdsOf(await kpms.findById(kpmId).lean().exec() as never);
  const api = () => request(app.getHttpServer());

  it('P19.27-T1 AC-4 declares kpm_owner:grant on adding and kpm_owner:revoke on removing', () => {
    expect(declaredPermissions(KpmOwnersController)).toEqual({ add: 'kpm_owner:grant', remove: 'kpm_owner:revoke' });
  });

  describe('POST /members/:membershipId/owner — Jadikan owner', () => {
    it('P19.27-T1 AC-4 an owner makes a member of their KPM an owner: listed in order of since, audited kpm.owner_added', async () => {
      clock.set(new Date('2026-11-22T04:00:00Z'));
      const res = await api().post(`/api/members/${m.admin}/owner`).expect(201);
      expect(res.body.canManage).toBe(true);
      expect(res.body.owners.map((o: { fullName: string }) => o.fullName)).toEqual(['Yohanes Saputra', 'Sinta Maharani']);
      expect(res.body.owners[1]).toMatchObject({ membershipId: m.admin, role: 'aab', since: '2026-11-22T04:00:00.000Z', state: 'not_invited' });
      expect(await owners()).toEqual([ids.owner, ids.admin]);
      const row = await kpms.findById(FIXTURE_KPM).lean().exec() as unknown as { owners: { addedByUserId: string }[] };
      expect(row.owners[1].addedByUserId).toBe(ids.owner);
      const entry = await audit.findOne({ action: 'kpm.owner_added' }).lean().exec() as unknown as Record<string, unknown>;
      expect(entry).toMatchObject({
        kpmId: FIXTURE_KPM, actorUserId: ids.owner, targetId: FIXTURE_KPM, targetMembershipId: m.admin,
        before: { owners: [ids.owner] }, after: { owners: [ids.owner, ids.admin], userId: ids.admin },
      });
      clock.set(NOW);
    });

    it('P19.27-T1 AC-4 the Super Admin inside the KPM adds an owner', async () => {
      session.current = SUPER_ADMIN_IN_A;
      await api().post(`/api/members/${m.agent}/owner`).expect(201);
      expect(await owners()).toEqual([ids.owner, ids.agent]);
    });

    it('P19.27-T1 AC-1 an invited (pending) member can be made an owner — the person reads Diundang until they sign in', async () => {
      await memberships.updateOne({ _id: m.invited }, { $set: { invitedAt: NOW } });
      const res = await api().post(`/api/members/${m.invited}/owner`).expect(201);
      expect(res.body.owners[1]).toMatchObject({ userId: ids.invited, state: 'invited' });
    });

    it('OD-475 Jadikan owner on a member whose account is theirs — address proven, never signed in — lists them Aktif', async () => {
      await users.updateOne({ _id: ids.agent }, { $set: { emailVerifiedAt: NOW, lastLoginAt: null } });
      await memberships.updateOne({ _id: m.agent }, { $set: { invitedAt: null } });
      const res = await api().post(`/api/members/${m.agent}/owner`).expect(201);
      expect(res.body.owners[1]).toMatchObject({ userId: ids.agent, state: 'active' });
    });

    it('P19.27-T1 AC-1 is idempotent: an owner already is answered as one, nothing written, nothing audited', async () => {
      await api().post(`/api/members/${m.owner}/owner`).expect(201);
      expect(await owners()).toEqual([ids.owner]);
      expect(await audit.countDocuments({ action: 'kpm.owner_added' })).toBe(0);
    });

    it('P19.27-T1 AC-4 a KPM Admin is refused 403 PERM_OWNER_ONLY, and nothing is written', async () => {
      session.current = adminSession;
      const res = await api().post(`/api/members/${m.agent}/owner`).expect(403);
      expect(res.body.error.code).toBe('PERM_OWNER_ONLY');
      expect(await owners()).toEqual([ids.owner]);
    });

    it('P19.27-T1 AC-4 an agent is refused 403', async () => {
      session.current = agentSession;
      await api().post(`/api/members/${m.admin}/owner`).expect(403);
    });

    it('P19.27-T1 AC-4 another KPM’s member is 404 — KPM A’s owner cannot reach KPM B', async () => {
      const res = await api().post(`/api/members/${m.memberB}/owner`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await owners(KPM_B)).toEqual([ids.ownerB]);
    });

    it('P19.27-T1 AC-4 a removed membership is 404, and a malformed id too', async () => {
      const gone = await member(FIXTURE_KPM, await account('Gone'), 'agent', 'removed');
      await api().post(`/api/members/${gone}/owner`).expect(404);
      await api().post('/api/members/not-an-id/owner').expect(404);
    });
  });

  describe('DELETE /members/:membershipId/owner — Hapus sebagai owner', () => {
    beforeEach(async () => {
      await kpms.updateOne({ _id: FIXTURE_KPM }, { $push: { owners: ownerEntry(ids.admin, NOW, ids.owner) } });
    });

    it('P19.27-T1 AC-4 an owner removes another owner: the person stays a member; audited kpm.owner_removed', async () => {
      const res = await api().delete(`/api/members/${m.admin}/owner`).expect(200);
      expect(res.body.owners.map((o: { userId: string }) => o.userId)).toEqual([ids.owner]);
      expect(await owners()).toEqual([ids.owner]);
      expect(await memberships.findById(m.admin).lean().exec()).toMatchObject({ status: 'active', role: 'aab' });
      expect(await audit.findOne({ action: 'kpm.owner_removed' }).lean().exec()).toMatchObject({
        kpmId: FIXTURE_KPM, targetMembershipId: m.admin,
        before: { owners: [ids.owner, ids.admin] }, after: { owners: [ids.owner], userId: ids.admin },
      });
    });

    it('P19.27-T1 AC-4 the Super Admin inside the KPM removes an owner — the first one included', async () => {
      session.current = SUPER_ADMIN_IN_A;
      await api().delete(`/api/members/${m.owner}/owner`).expect(200);
      expect(await owners()).toEqual([ids.admin]);
    });

    it('P19.27-T1 AC-4 the last owner is refused 409 KPM_LAST_OWNER, and stays', async () => {
      session.current = SUPER_ADMIN_IN_A;
      await api().delete(`/api/members/${m.admin}/owner`).expect(200);
      const res = await api().delete(`/api/members/${m.owner}/owner`).expect(409);
      expect(res.body.error).toMatchObject({ code: 'KPM_LAST_OWNER', details: { kpmId: FIXTURE_KPM, userId: ids.owner } });
      expect(res.body.error.message).toContain('Yohanes Saputra');
      expect(await owners()).toEqual([ids.owner]);
    });

    it('P19.27-T1 AC-4 two owners removing each other at once leave one (the write is one conditional update)', async () => {
      const results = await Promise.allSettled([
        service.remove(RequestContext.superAdminInTenant('root', FIXTURE_KPM), FIXTURE_KPM, ids.owner),
        service.remove(RequestContext.superAdminInTenant('root', FIXTURE_KPM), FIXTURE_KPM, ids.admin),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await owners()).toHaveLength(1);
    });

    it('P19.27-T1 AC-4 an owner never removes themselves: 403 PERM_OWNER_ONLY (OD-452)', async () => {
      const res = await api().delete(`/api/members/${m.owner}/owner`).expect(403);
      expect(res.body.error.code).toBe('PERM_OWNER_ONLY');
      expect(await owners()).toEqual([ids.owner, ids.admin]);
    });

    it('P19.27-T1 AC-4 a KPM Admin is refused 403 PERM_OWNER_ONLY', async () => {
      session.current = adminSession;
      const res = await api().delete(`/api/members/${m.owner}/owner`).expect(403);
      expect(res.body.error.code).toBe('PERM_OWNER_ONLY');
    });

    it('P19.27-T1 AC-4 a member who is not an owner is 404; another KPM’s owner is 404', async () => {
      await api().delete(`/api/members/${m.agent}/owner`).expect(404);
      await api().delete(`/api/members/${m.ownerB}/owner`).expect(404);
      expect(await owners(KPM_B)).toEqual([ids.ownerB]);
    });
  });

  describe('KpmOwnersService.add — the contract provisioning and Tambah user build on', () => {
    it('P19.27-T1 AC-1 pushes its undo onto a caller’s stack, which takes the owner off again', async () => {
      const undo: Array<() => Promise<unknown>> = [];
      const ctx = RequestContext.superAdminInTenant('root', FIXTURE_KPM);
      await expect(service.add(ctx, FIXTURE_KPM, ids.agent, { undo })).resolves.toEqual({ added: true });
      expect(undo).toHaveLength(1);
      expect(await owners()).toEqual([ids.owner, ids.agent]);
      for (const step of undo.reverse()) await step();
      expect(await owners()).toEqual([ids.owner]);
    });

    it('P19.27-T1 AC-1 pushes nothing when nothing was written', async () => {
      const undo: Array<() => Promise<unknown>> = [];
      await service.add(RequestContext.superAdminInTenant('root', FIXTURE_KPM), FIXTURE_KPM, ids.owner, { undo });
      expect(undo).toHaveLength(0);
    });

    it('P19.27-T1 AC-1 refuses somebody who is not a member (404), and an unknown KPM (404)', async () => {
      const ctx = RequestContext.superAdminInTenant('root', FIXTURE_KPM);
      await expect(service.add(ctx, FIXTURE_KPM, ids.memberB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.add(ctx, oid(), ids.owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.remove(ctx, oid(), ids.owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // A KPM id that is no id at all reads as no KPM, never a cast error.
      await expect(service.add(ctx, 'not-an-office', ids.owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('ADR-0285 §4 the tenant routes act inside a KPM: the Super Admin outside every KPM reaches none, 404', async () => {
      await expect(service.addMember(SUPER_ADMIN, oid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.removeMember(SUPER_ADMIN, oid())).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await owners(FIXTURE_KPM)).toContain(ids.owner);
    });

    it('ADR-0285 §4 two removals at once: the one that finds the owner gone already is 404, not 409', async () => {
      const ctx = RequestContext.superAdminInTenant('root', FIXTURE_KPM);
      await kpms.updateOne({ _id: FIXTURE_KPM }, { $set: { owners: [ownerEntry(ids.owner, NOW), ownerEntry(ids.admin, NOW)] } });
      // The row the service read still lists the admin; the write finds them gone.
      const findOne = kpms.findOne.bind(kpms);
      const spy = jest.spyOn(kpms, 'findOne').mockImplementationOnce(((...args: Parameters<typeof kpms.findOne>) => ({
        exec: async () => {
          const row = await findOne(...args).exec();
          await kpms.updateOne({ _id: FIXTURE_KPM }, { $pull: { owners: { userId: ids.admin } } }).exec();
          return row;
        },
      })) as never);
      await expect(service.remove(ctx, FIXTURE_KPM, ids.admin)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      spy.mockRestore();
      expect(await owners(FIXTURE_KPM)).toEqual([ids.owner]);
    });

    it('P19.27-T1 AC-1 the first owner of a KPM with none clears its pending owner; onlyWhileNone writes nothing once it has one', async () => {
      await kpms.updateOne({ _id: KPM_B }, { $set: { owners: [], pendingOwner: { fullName: 'BUDI', phone: '+62811', agentCode: null } } });
      const ctx = RequestContext.superAdminInTenant('root', KPM_B);
      await expect(service.add(ctx, KPM_B, ids.memberB, { onlyWhileNone: true, auditAfter: { via: 'whatsapp_claim' } }))
        .resolves.toEqual({ added: true });
      expect(await kpms.findById(KPM_B).lean().exec()).toMatchObject({ pendingOwner: null });
      expect(await audit.findOne({ action: 'kpm.owner_added', targetId: KPM_B }).lean().exec())
        .toMatchObject({ after: { via: 'whatsapp_claim', userId: ids.memberB } });
      await expect(service.add(ctx, KPM_B, ids.ownerB, { onlyWhileNone: true })).resolves.toEqual({ added: false });
      expect(await owners(KPM_B)).toEqual([ids.memberB]);
    });

    it('P19.27-T2 AC-1 list: owners in order of since, a missing account named Unknown, canManage false for an Admin', async () => {
      await kpms.updateOne({ _id: FIXTURE_KPM }, { $set: { owners: [ownerEntry(ids.admin, NOW), ownerEntry(ids.owner, new Date('2026-01-01T00:00:00Z'))] } });
      const read = await service.list(adminSession, FIXTURE_KPM);
      expect(read.owners.map((o) => o.userId)).toEqual([ids.owner, ids.admin]);
      expect(read.canManage).toBe(false);
      expect((await service.list(SUPER_ADMIN, FIXTURE_KPM)).canManage).toBe(true);
    });

    it('P19.28 (ADR-0286 §2) addedByUserId names who granted it when the caller is not — an invitation accepted by its invitee', async () => {
      const ctx = new RequestContext(ids.agent, 'none', { ...AGENT.membership!, membershipId: m.agent });
      await service.add(ctx, FIXTURE_KPM, ids.agent, {
        addedByUserId: ids.owner, auditAfter: { via: 'user_invitation', invitationId: 'inv-1', invitedByUserId: ids.owner },
      });
      const kpm = await kpms.findById(FIXTURE_KPM).lean().exec() as unknown as { owners: { userId: string; addedByUserId: string | null }[] };
      expect(kpm.owners.find((o) => o.userId === ids.agent)?.addedByUserId).toBe(ids.owner);
      expect((await audit.findOne({ action: 'kpm.owner_added' }).lean().exec())?.after)
        .toMatchObject({ userId: ids.agent, via: 'user_invitation', invitationId: 'inv-1', invitedByUserId: ids.owner });
    });
  });

  /*
   * The 19.28 permission review's T1: the routes' negatives over HTTP for every field role, a support session, and a
   * steward of another KPM — none of them writes anything.
   */
  describe('who is refused, over HTTP (the 19.28 permission review, T1)', () => {
    const session$ = (base: RequestContext, userId: string, membershipId: string) =>
      new RequestContext(userId, 'none', { ...base.membership!, membershipId });

    beforeEach(async () => {
      await kpms.updateOne({ _id: FIXTURE_KPM }, { $push: { owners: ownerEntry(ids.admin, NOW, ids.owner) } });
    });

    it.each([['an AB', 'ab'], ['an AAB', 'aab']] as const)('POST is refused for %s, 403, nothing written', async (_who, role) => {
      session.current = session$(role === 'ab' ? AB : AAB, ids.agent, m.agent);
      await api().post(`/api/members/${m.invited}/owner`).expect(403);
      expect(await owners()).toEqual([ids.owner, ids.admin]);
    });

    it.each([['an Agent', 'agent'], ['an AB', 'ab'], ['an AAB', 'aab']] as const)('DELETE is refused for %s, 403, nothing written', async (_who, role) => {
      session.current = session$(role === 'agent' ? AGENT : role === 'ab' ? AB : AAB, ids.agent, m.agent);
      await api().delete(`/api/members/${m.admin}/owner`).expect(403);
      expect(await owners()).toEqual([ids.owner, ids.admin]);
    });

    it('a support session — the Super Admin looking as an owner — is refused both, 403, nothing written', async () => {
      session.current = new RequestContext(
        ids.owner, 'none', { ...OWNER.membership!, membershipId: m.owner }, 'sa-1', null, false, true,
      );
      await api().post(`/api/members/${m.agent}/owner`).expect(403);
      await api().delete(`/api/members/${m.admin}/owner`).expect(403);
      expect(await owners()).toEqual([ids.owner, ids.admin]);
    });

    it('another KPM’s steward: its KPM Admin is refused (403, the same answer whatever the id), its owner 404 — nothing written', async () => {
      const adminB = await account('Admin B');
      const mAdminB = await member(KPM_B, adminB, 'aab');
      session.current = new RequestContext(adminB, 'none', { ...ADMIN.membership!, kpmId: KPM_B, membershipId: mAdminB });
      expect((await api().post(`/api/members/${m.agent}/owner`).expect(403)).body.error.code).toBe('PERM_OWNER_ONLY');
      expect((await api().delete(`/api/members/${m.admin}/owner`).expect(403)).body.error.code).toBe('PERM_OWNER_ONLY');
      session.current = new RequestContext(ids.ownerB, 'none', { ...OWNER.membership!, kpmId: KPM_B, membershipId: m.ownerB });
      await api().post(`/api/members/${m.agent}/owner`).expect(404);
      await api().delete(`/api/members/${m.admin}/owner`).expect(404);
      expect(await owners()).toEqual([ids.owner, ids.admin]);
    });
  });
});
