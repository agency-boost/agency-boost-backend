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
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { AdminDelegationService } from './admin-delegation.service';
import { DirectoryService } from './directory.service';
import { HierarchyService } from './hierarchy.service';
import { TransferRequestsController } from './invites.controller';
import { LeaderChangeController } from './leader-change.controller';
import { LeaderChangeService } from './leader-change.service';
import { MemberNames } from './member-names.service';
import { MemberPersonalService } from './member-personal.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { MembershipHistoryRepository, TransferRequestRepository } from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { TransferRequest, TransferRequestSchema } from './transfer-request.schema';
import { TransfersService } from './transfers.service';

/** 10:00 on Friday 20 November 2026 in Jakarta. */
const NOW = new Date('2026-11-20T03:00:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();
const SA_USER = new mongoose.Types.ObjectId().toString();

type Who = 'OWNER' | 'AGUS' | 'SARI' | 'RINA' | 'MAYA' | 'DEDI' | 'EKO' | 'PEER' | 'PEER_AGENT' | 'B_OWNER' | 'B_AGENT';

/**
 * **The KPM's stewards in People, over HTTP and through the services** (ADR-0268 §1, §3; P19.17 F2; the client's
 * `PERMISSIONS.md` of 19 November). A **core leader** sees the whole KPM in *All members* and the Org tree, opens and
 * changes only their own downline — moving anybody below them at once, as the office would, and deciding the move requests
 * about them — and nobody else; the **Super Admin inside the KPM** is its Owner, audited as themselves.
 *
 * ```
 * Office A (0417):  OWNER (AB, the Owner) ─┬── AGUS (AB, ★ core leader) ─┬── SARI (AAB) ── RINA (Agent)
 *                                          │                              └── MAYA (AB) ── DEDI (Agent) ── EKO (Agent)
 *                                          └── PEER (AB) ── PEER_AGENT (Agent)
 * Office B (0555):  B_OWNER (AB, its Owner) ── B_AGENT
 * ```
 */
describe('ADR-0268 the KPM’s stewards in People (P19.17 F2)', () => {
  let app: INestApplication;
  let clock: FixedClock;
  let hierarchy: HierarchyService;
  let directory: DirectoryService;
  let tree: OrgTreeService;
  let personal: MemberPersonalService;
  let transfers: TransfersService;
  let delegation: AdminDelegationService;
  let companyId: string;
  let id: Record<Who, string>;
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const http = () => request(app.getHttpServer());
  const job = (kpmId: string) => RequestContext.forJob(kpmId, 'office-stewards-spec');
  const oid = (value: string) => new mongoose.Types.ObjectId(value);

  beforeAll(async () => {
    await startMongo();
    clock = new FixedClock(NOW);
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    const transferRows = new TransferRequestRepository(mongoose.model(TransferRequest.name, TransferRequestSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, companies as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined } as never;
    const names = new MemberNames(members, users as never);
    transfers = new TransfersService(transferRows, members, hierarchy, names, kpms as never, audit, notifications, clock);
    directory = new DirectoryService(members, users as never, kpms as never, companies as never, orgLevels);
    tree = new OrgTreeService(members, users as never);
    personal = new MemberPersonalService(members, users as never, directory, new TenantDay(kpms as never, clock), audit);
    delegation = new AdminDelegationService(members, history, users as never, audit, notifications, clock);
    const leaders = new LeaderChangeService(
      members, hierarchy, transfers, directory, names, kpms as never, users as never, audit, notifications, clock,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [LeaderChangeController, TransferRequestsController],
      providers: [
        { provide: LeaderChangeService, useValue: leaders },
        { provide: TransfersService, useValue: transfers },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
    await syncIndexes();
  });

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  let seq = 0;
  async function account(fullName: string): Promise<string> {
    seq += 1;
    const u = await mongoose.model(User.name).create({
      email: `st${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: String(20000 + seq),
    });
    return String(u._id);
  }

  async function place(kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null) {
    const m = await hierarchy.create(job(kpmId), { userId, role, leaderId, status: 'active', joining: { joinDate: '2025-01-02' } });
    return String(m._id);
  }

  /** The session a member's own token would carry: their row, read back, the core leader tag as the resolver reads it. */
  async function as(who: Who, flags: { owner?: boolean; coreLeader?: boolean } = {}): Promise<RequestContext> {
    const membershipId = id[who];
    const row = (await col('memberships').findOne({ _id: oid(membershipId) }))!;
    return new RequestContext(String(row.userId), 'none', {
      membershipId, kpmId: row.kpmId, orgLevelCode: String(row.orgLevelCode), hierarchyRole: row.role, status: row.status,
      isKpmOwner: flags.owner ?? (who === 'OWNER' || who === 'B_OWNER'), isKpmAdmin: false,
      directCount: row.directCounts?.total ?? 0, isCoreLeader: flags.coreLeader ?? who === 'AGUS',
    } as never);
  }
  const signIn = async (who: Who, flags: { owner?: boolean; coreLeader?: boolean } = {}) => {
    session.current = await as(who, flags);
  };
  const SA_IN_A = () => RequestContext.superAdminInKpm(RequestContext.platform(SA_USER), KPM_A);
  const move = (who: Who, to: string) => http().put(`/members/${id[who]}/leader`).send({ leaderMembershipId: to });
  const ask = (who: Who, to: string) => http().post(`/members/${id[who]}/transfer-request`).send({ leaderMembershipId: to });

  beforeEach(async () => {
    clock.set(NOW);
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-st-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    const people: [Who, string][] = [
      ['OWNER', 'Wilson Tan'], ['AGUS', 'Agus Prasetyo'], ['SARI', 'Sari Puspita'], ['RINA', 'Rina Wijaya'],
      ['MAYA', 'Maya Anggraini'], ['DEDI', 'Dedi Kurniawan'], ['EKO', 'Eko Saputra'], ['PEER', 'Hendra Gunawan'],
      ['PEER_AGENT', 'Lina Marlina'], ['B_OWNER', 'Bagus Santoso'], ['B_AGENT', 'Dian Lestari'],
    ];
    const u = {} as Record<Who, string>;
    for (const [who, name] of people) u[who] = await account(name);
    await mongoose.model(Kpm.name).create({
      _id: KPM_A, companyId, code: '0417', branchName: 'BSD City', counters: { nextMemberSeq: 1 }, status: 'active',
      timezone: 'Asia/Jakarta', ownerUserId: u.OWNER,
    });
    await mongoose.model(Kpm.name).create({
      _id: KPM_B, companyId, code: '0555', branchName: 'Kelapa Gading', counters: { nextMemberSeq: 1 }, status: 'active',
      timezone: 'Asia/Jakarta', ownerUserId: u.B_OWNER,
    });
    const i = {} as Record<Who, string>;
    i.OWNER = await place(KPM_A, u.OWNER, 'ab', null);
    i.AGUS = await place(KPM_A, u.AGUS, 'ab', i.OWNER);
    i.SARI = await place(KPM_A, u.SARI, 'aab', i.AGUS);
    i.RINA = await place(KPM_A, u.RINA, 'agent', i.SARI);
    i.MAYA = await place(KPM_A, u.MAYA, 'ab', i.AGUS);
    i.DEDI = await place(KPM_A, u.DEDI, 'agent', i.MAYA);
    i.EKO = await place(KPM_A, u.EKO, 'agent', i.DEDI);
    i.PEER = await place(KPM_A, u.PEER, 'ab', i.OWNER);
    i.PEER_AGENT = await place(KPM_A, u.PEER_AGENT, 'agent', i.PEER);
    i.B_OWNER = await place(KPM_B, u.B_OWNER, 'ab', null);
    i.B_AGENT = await place(KPM_B, u.B_AGENT, 'agent', i.B_OWNER);
    id = i;
    await col('memberships').updateOne({ _id: oid(i.AGUS) }, { $set: { isCoreLeader: true } });
  });

  describe('§1 a core leader in All members and the Org tree', () => {
    it('sees the whole KPM in All members, each row saying whether it opens: their downline and themselves only', async () => {
      const page = await directory.list(await as('AGUS'));
      const byId = new Map(page.members.map((m) => [m.membershipId, m.openable]));
      expect(byId.size).toBe(9);
      for (const who of ['AGUS', 'SARI', 'RINA', 'MAYA', 'DEDI', 'EKO'] as const) expect([who, byId.get(id[who])]).toEqual([who, true]);
      for (const who of ['OWNER', 'PEER', 'PEER_AGENT'] as const) expect([who, byId.get(id[who])]).toEqual([who, false]);
      // Nothing of another KPM.
      expect(byId.has(id.B_AGENT)).toBe(false);
    });

    it('opens somebody below them, with their personal data, and is answered 404 for anybody else', async () => {
      const cl = await as('AGUS');
      const eko = await directory.read(cl, id.EKO);
      expect(eko).toMatchObject({ membershipId: id.EKO, openable: true });
      expect(eko).toHaveProperty('personal');
      for (const who of ['PEER', 'PEER_AGENT', 'OWNER', 'B_AGENT'] as const) {
        await expect(directory.read(cl, id[who])).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      await expect(directory.reportsOf(cl, id.PEER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('untagged, the same AB sees and opens only their downline, as before', async () => {
      const plain = await as('AGUS', { coreLeader: false });
      const page = await directory.list(plain);
      expect(page.members.map((m) => m.membershipId)).not.toContain(id.PEER);
      expect(page.members.every((m) => m.openable)).toBe(true);
    });

    it('the Org tree (view=kpm) is the whole KPM with the rest muted; their Group Tree stays their team', async () => {
      const cl = await as('AGUS');
      const kpm = await tree.read(cl, undefined, 'kpm');
      const openable = new Map(kpm.nodes.map((n) => [n.membershipId, n.openable]));
      expect(openable.size).toBe(9);
      expect(openable.get(id.EKO)).toBe(true);
      expect(openable.get(id.PEER_AGENT)).toBe(false);
      const team = await tree.read(cl);
      expect(team.nodes.map((n) => n.membershipId).sort()).toEqual(
        [id.AGUS, id.SARI, id.RINA, id.MAYA, id.DEDI, id.EKO].sort(),
      );
      // A tree read *for* somebody outside their downline is not theirs to open.
      await expect(tree.read(cl, id.PEER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await tree.read(cl, id.MAYA)).nodes.map((n) => n.membershipId).sort()).toEqual([id.MAYA, id.DEDI, id.EKO].sort());
    });

    it('the Owner’s tree and roster open everybody', async () => {
      const owner = await as('OWNER');
      expect((await tree.read(owner, undefined, 'kpm')).nodes.every((n) => n.openable)).toBe(true);
      expect((await directory.list(owner)).members.every((m) => m.openable)).toBe(true);
    });

    it('fills the blanks of somebody below them only — 404 beside them, and never their own through the KPM', async () => {
      const cl = await as('AGUS');
      await expect(personal.complete(cl, id.EKO, { gender: 'female' } as never)).resolves.toBeDefined();
      for (const who of ['PEER_AGENT', 'AGUS', 'B_AGENT'] as const) {
        await expect(personal.complete(cl, id[who], { gender: 'female' } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
    });
  });

  describe('§1 a core leader moves their downline as the office would (amending ADR-0247 §2, ADR-0170 §4)', () => {
    it('moves somebody three levels below them to a leader outside their tree, at once, audited as the office', async () => {
      await signIn('AGUS');
      const res = await move('EKO', id.PEER).expect(200);
      // Out of their downline now: answered as the roster shows them, no longer theirs to open.
      expect(res.body).toMatchObject({ membershipId: id.EKO, leaderId: id.PEER, openable: false });
      expect(res.body).not.toHaveProperty('personal');
      expect((await col('memberships').findOne({ _id: oid(id.EKO) }))!.leaderId).toBe(id.PEER);
      // Inside their downline, the answer is the opened member, as before.
      expect((await move('DEDI', id.SARI).expect(200)).body).toMatchObject({ membershipId: id.DEDI, openable: true });
      expect(await col('auditLog').findOne({ action: 'member.leader_changed' })).toMatchObject({ kpmId: KPM_A });
    });

    it('untagged, the same AB moves only a direct report, inside their tree', async () => {
      await signIn('AGUS', { coreLeader: false });
      await move('EKO', id.PEER).expect(403);
    });

    it('anybody outside their downline, themselves and another KPM are 404', async () => {
      await signIn('AGUS');
      await move('PEER_AGENT', id.MAYA).expect(404);
      await move('AGUS', id.PEER).expect(404);
      await http().put(`/members/${id.B_AGENT}/leader`).send({ leaderMembershipId: id.MAYA }).expect(404);
    });

    it('asks for nothing: a request about somebody below them is answered "move them directly"', async () => {
      await signIn('AGUS');
      await ask('MAYA', id.PEER).expect(400);
    });

    it('decides the move requests about their downline, and sees no other', async () => {
      await signIn('SARI', { coreLeader: false });
      const rina = (await ask('RINA', id.PEER).expect(201)).body.transferId as string;
      await signIn('PEER', { coreLeader: false });
      const lina = (await ask('PEER_AGENT', id.SARI).expect(201)).body.transferId as string;

      await signIn('AGUS');
      const queue = (await http().get('/transfer-requests').expect(200)).body as { transferId: string }[];
      expect(queue.map((t) => t.transferId)).toEqual([rina]);
      await http().post(`/transfer-requests/${lina}/approve`).expect(404);
      await http().post(`/transfer-requests/${lina}/decline`).send({}).expect(404);
      await http().post(`/transfer-requests/${rina}/approve`).expect(200);
      expect((await col('memberships').findOne({ _id: oid(id.RINA) }))!.leaderId).toBe(id.PEER);

      // The Owner's queue is every request.
      await signIn('OWNER');
      expect(((await http().get('/transfer-requests').expect(200)).body as unknown[]).length).toBe(1);
      // An AB untagged holds no queue at all.
      await signIn('MAYA', { coreLeader: false });
      await http().get('/transfer-requests').expect(403);
    });
  });

  describe('§3 the Super Admin inside the KPM is its Owner, audited as themselves', () => {
    it('moves anybody at once; the audit row is the KPM’s, the Super Admin the actor and no member', async () => {
      session.current = SA_IN_A();
      await move('PEER_AGENT', id.MAYA).expect(200);
      const row = await col('auditLog').findOne({ action: 'member.leader_changed' });
      expect(row).toMatchObject({ kpmId: KPM_A, actorUserId: SA_USER, actorMembershipId: null, effectiveUserId: null });
    });

    it('decides any request, and reads the whole roster and tree as the Owner does', async () => {
      await signIn('SARI', { coreLeader: false });
      const rina = (await ask('RINA', id.PEER).expect(201)).body.transferId as string;
      session.current = SA_IN_A();
      expect(((await http().get('/transfer-requests').expect(200)).body as unknown[]).length).toBe(1);
      await http().post(`/transfer-requests/${rina}/approve`).expect(200);
      const inside = SA_IN_A();
      expect((await directory.list(inside)).members).toHaveLength(9);
      expect((await tree.read(inside, undefined, 'kpm')).nodes.every((n) => n.openable)).toBe(true);
      expect(await directory.read(inside, id.EKO)).toHaveProperty('personal');
    });

    it('§2, §3 grants and revokes a KPM Admin as the Owner, and is on no list of the KPM’s admins itself', async () => {
      const inside = SA_IN_A();
      const granted = await delegation.grant(inside, id.PEER);
      expect(granted.map((a) => a.membershipId)).toEqual([id.PEER]);
      expect(granted[0]).toMatchObject({ canRevoke: true });
      expect(await col('auditLog').findOne({ action: 'kpm_admin.granted' })).toMatchObject({ kpmId: KPM_A, actorUserId: SA_USER });
      // An Admin reads the list and may revoke nobody; a core leader is refused it by the guard (`kpm_admin:list`).
      const admin = await as('PEER');
      const asAdmin = new RequestContext(admin.userId, 'none', { ...admin.membership!, isKpmAdmin: true });
      expect((await delegation.list(asAdmin)).every((a) => !a.canRevoke)).toBe(true);
      expect(await delegation.revoke(inside, id.PEER)).toEqual([]);
    });

    it('reaches nothing of another KPM: 404', async () => {
      session.current = SA_IN_A();
      await http().put(`/members/${id.B_AGENT}/leader`).send({ leaderMembershipId: id.B_OWNER }).expect(404);
      await expect(directory.read(SA_IN_A(), id.B_AGENT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('outside a KPM, and in a support session, the same routes are refused', async () => {
      session.current = RequestContext.platform(SA_USER);
      await move('PEER_AGENT', id.MAYA).expect(403);
      await http().get('/transfer-requests').expect(403);
      const owner = await as('OWNER');
      session.current = new RequestContext(owner.userId, 'none', owner.membership, SA_USER, null, false, true);
      await move('PEER_AGENT', id.MAYA).expect(403);
    });
  });
});
