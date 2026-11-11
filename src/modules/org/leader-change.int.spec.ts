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
import { User, UserSchema } from '@/modules/users/user.schema';
import { declaredPermissions, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { DirectoryService } from './directory.service';
import { HierarchyService } from './hierarchy.service';
import { TransferRequestsController } from './invites.controller';
import { LeaderChangeController } from './leader-change.controller';
import { LeaderChangeService } from './leader-change.service';
import { MemberNames } from './member-names.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { MembershipHistoryRepository, TransferRequestRepository } from './org.repositories';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';
import { TransferRequest, TransferRequestSchema } from './transfer-request.schema';
import { TransfersService } from './transfers.service';

/** 10:00 on Wednesday 11 November 2026 in Jakarta. */
const NOW = new Date('2026-11-11T03:00:00Z');
const MINUTE = 60_000;
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

type Who =
  | 'OWNER' | 'ADMIN' | 'AGUS' | 'SARI' | 'RINA' | 'FINA' | 'GITA' | 'MAYA' | 'DEDI' | 'EKO' | 'TONI' | 'PEER'
  | 'PEER_AGENT' | 'WAITING' | 'B_OWNER' | 'B_AGENT';

/**
 * **Changing who somebody reports to, over HTTP** (P19.12-T4; ADR-0247; the client's message of 11 November 2026,
 * items 4 and 8). The real services behind the real `PermissionsGuard` and the production pipe, on an office built
 * through `HierarchyService`, so every `ancestorIds` is the one the product writes:
 *
 * ```
 * Office A (0417):  OWNER (AB, the Owner) ─┬── ADMIN (AB, an Admin)
 *                                          ├── AGUS (AB) ─┬── SARI (AAB) ─┬── RINA (Agent)
 *                                          │              │               └── FINA (Agent) ── GITA (Agent)
 *                                          │              ├── MAYA (AB) ── DEDI (Agent) ── EKO (Agent)
 *                                          │              └── TONI (Agent, leads nobody)
 *                                          └── PEER (AB) ── PEER_AGENT (Agent)
 *                   WAITING (pending)
 * Office B (0555):  B_OWNER (AB, its Owner) ── B_AGENT
 * ```
 */
describe('P19.12-T4 a leader sets roles up to their own rung, and people change leader', () => {
  let app: INestApplication;
  let clock: FixedClock;
  let hierarchy: HierarchyService;
  let members: MembershipRepository;
  let roles: RoleChangeService;
  let directory: DirectoryService;
  let leaders: LeaderChangeService;
  let transfers: TransfersService;
  let removals: RemovalService;
  let companyId: string;
  let id: Record<Who, string>;
  let user: Record<Who, string>;
  let sent: { userId?: string; templateId: string; payload?: Record<string, unknown> }[];
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const http = () => request(app.getHttpServer());
  const job = (kpmId: string) => RequestContext.forJob(kpmId, 'leader-change-spec');
  const oid = (value: string) => new mongoose.Types.ObjectId(value);

  beforeAll(async () => {
    await startMongo();
    clock = new FixedClock(NOW);
    const users = mongoose.model(User.name, UserSchema);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    const transferRows = new TransferRequestRepository(mongoose.model(TransferRequest.name, TransferRequestSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, companies as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    sent = [];
    const notifications = {
      send: async (r: { userId?: string; templateId: string; payload?: Record<string, unknown> }) => { sent.push(r); },
    } as never;
    const names = new MemberNames(members, users as never);
    transfers = new TransfersService(transferRows, members, hierarchy, names, kpms as never, audit, notifications, clock);
    roles = new RoleChangeService(members, hierarchy, history, users as never, audit, notifications, clock, transfers);
    removals = new RemovalService(members, hierarchy, roles, history, audit, notifications, clock);
    directory = new DirectoryService(members, users as never, kpms as never, companies as never, orgLevels);
    leaders = new LeaderChangeService(
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
  async function account(fullName: string, agentCode: string): Promise<string> {
    seq += 1;
    const u = await mongoose.model(User.name).create({
      email: `lc${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId, agentCode,
    });
    return String(u._id);
  }

  async function place(kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null, status: 'active' | 'pending' = 'active') {
    const m = await hierarchy.create(job(kpmId), {
      userId, role, leaderId, status, ...(status === 'active' ? { joining: { joinDate: '2025-01-02' } } : {}),
    });
    return String(m._id);
  }

  /** The session a member's own token would carry: their row, read back. */
  async function as(who: Who, flags: { owner?: boolean; admin?: boolean; readOnly?: boolean } = {}): Promise<RequestContext> {
    const membershipId = id[who];
    const row = (await col('memberships').findOne({ _id: oid(membershipId) }))!;
    return new RequestContext(String(row.userId), 'none', {
      membershipId, kpmId: row.kpmId, orgLevelCode: String(row.orgLevelCode), hierarchyRole: row.role,
      status: row.status, isKpmOwner: flags.owner ?? (who === 'OWNER' || who === 'B_OWNER'), isKpmAdmin: flags.admin ?? who === 'ADMIN',
      directCount: row.directCounts?.total ?? 0,
    } as never, flags.readOnly ? 'sa-1' : null, null, false, flags.readOnly ?? false);
  }
  const signIn = async (who: Who, flags: { owner?: boolean; admin?: boolean; readOnly?: boolean } = {}) => {
    session.current = await as(who, flags);
  };

  beforeEach(async () => {
    clock.set(NOW);
    await clearCollections();
    sent.length = 0;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-lc-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    const people: [Who, string, string][] = [
      ['OWNER', 'Wilson Tan', '10001'], ['ADMIN', 'Siti Rahma', '10002'], ['AGUS', 'Agus Prasetyo', '10003'],
      ['SARI', 'Sari Puspita', '10004'], ['RINA', 'Rina Wijaya', '10005'], ['FINA', 'Fina Lestari', '10006'],
      ['GITA', 'Gita Ayu', '10007'], ['MAYA', 'Maya Anggraini', '10008'], ['DEDI', 'Dedi Kurniawan', '10009'],
      ['EKO', 'Eko Saputra', '10010'], ['TONI', 'Toni Wibowo', '10011'], ['PEER', 'Hendra Gunawan', '10012'],
      ['PEER_AGENT', 'Lina Marlina', '10013'], ['WAITING', 'Putri Anggraini', '10014'],
      ['B_OWNER', 'Bagus Santoso', '30001'], ['B_AGENT', 'Dian Lestari', '30002'],
    ];
    const u = {} as Record<Who, string>;
    for (const [who, name, code] of people) u[who] = await account(name, code);
    user = u;
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
    i.ADMIN = await place(KPM_A, u.ADMIN, 'ab', i.OWNER);
    i.AGUS = await place(KPM_A, u.AGUS, 'ab', i.OWNER);
    i.SARI = await place(KPM_A, u.SARI, 'aab', i.AGUS);
    i.RINA = await place(KPM_A, u.RINA, 'agent', i.SARI);
    i.FINA = await place(KPM_A, u.FINA, 'agent', i.SARI);
    i.GITA = await place(KPM_A, u.GITA, 'agent', i.FINA);
    i.MAYA = await place(KPM_A, u.MAYA, 'ab', i.AGUS);
    i.DEDI = await place(KPM_A, u.DEDI, 'agent', i.MAYA);
    i.EKO = await place(KPM_A, u.EKO, 'agent', i.DEDI);
    i.TONI = await place(KPM_A, u.TONI, 'agent', i.AGUS);
    i.PEER = await place(KPM_A, u.PEER, 'ab', i.OWNER);
    i.PEER_AGENT = await place(KPM_A, u.PEER_AGENT, 'agent', i.PEER);
    i.WAITING = await place(KPM_A, u.WAITING, 'agent', null, 'pending');
    i.B_OWNER = await place(KPM_B, u.B_OWNER, 'ab', null);
    i.B_AGENT = await place(KPM_B, u.B_AGENT, 'agent', i.B_OWNER);
    id = i;
    await col('memberships').updateOne({ _id: oid(i.ADMIN) }, { $set: { 'adminAccess.isKpmAdmin': true } });
    clock.set(new Date(NOW.getTime() + 10 * MINUTE));
    await signIn('OWNER');
  });

  const audits = (action: string) => col('auditLog').find({ action }).toArray();
  const notices = (templateId: string) => sent.filter((n) => n.templateId === templateId);
  const row = (who: Who) => col('memberships').findOne({ _id: oid(id[who]) });
  const edges = (who: Who) => col('membershipHistory').find({ membershipId: id[who] }).sort({ validFrom: 1, _id: 1 }).toArray();
  const move = (who: Who, to: string, reason?: string) =>
    http().put(`/members/${id[who]}/leader`).send({ leaderMembershipId: to, ...(reason ? { reason } : {}) });
  const ask = (who: Who, to: string, reason?: string) =>
    http().post(`/members/${id[who]}/transfer-request`).send({ leaderMembershipId: to, ...(reason ? { reason } : {}) });
  /** Every leader's cached `subtreeCount` beside a fresh count of the active people below them. */
  async function countsDrift(): Promise<string[]> {
    const all = await col('memberships').find({ kpmId: KPM_A }).toArray();
    const drift: string[] = [];
    for (const m of all) {
      const actual = await col('memberships').countDocuments({ kpmId: KPM_A, ancestorIds: String(m._id), status: 'active', deletedAt: null });
      const directs = await col('memberships').countDocuments({ kpmId: KPM_A, leaderId: String(m._id), status: 'active', deletedAt: null });
      if ((m.subtreeCount ?? 0) !== actual || (m.directCounts?.total ?? 0) !== directs) {
        drift.push(`${String(m._id)}: subtree ${m.subtreeCount ?? 0}≠${actual} or direct ${m.directCounts?.total ?? 0}≠${directs}`);
      }
    }
    return drift;
  }

  it('P19.12-T4 AC-6 the routes name the permissions the matrix gives them', () => {
    expect(declaredPermissions(LeaderChangeController)).toEqual({
      choices: 'member:reassign_leader',
      move: 'member:reassign_leader',
      requestMove: 'member:transfer_request',
      cancel: 'member:transfer_request',
    });
  });

  // ------------------------------------------------------------------ PUT /members/:id/leader

  describe('PUT /members/:id/leader — moved at once', () => {
    it('P19.12-T4 AC-2 the Owner moves Maya under Peer: her three-level downline’s paths, one open edge, every count, the audit row and three notices', async () => {
      const before = (await edges('MAYA')).at(-1)!;
      const dediEdges = await edges('DEDI');
      const res = await move('MAYA', id.PEER, 'Closer to Hendra’s office').expect(200);
      expect(res.body).toMatchObject({ membershipId: id.MAYA, leaderId: id.PEER, leaderName: 'Hendra Gunawan' });

      expect(await row('MAYA')).toMatchObject({ leaderId: id.PEER, ancestorIds: [id.OWNER, id.PEER], depth: 2 });
      expect(await row('DEDI')).toMatchObject({ ancestorIds: [id.OWNER, id.PEER, id.MAYA], depth: 3 });
      expect(await row('EKO')).toMatchObject({ ancestorIds: [id.OWNER, id.PEER, id.MAYA, id.DEDI], depth: 4 });

      // One open edge, opened at the instant the old one closed, and the people below her untouched.
      const after = await edges('MAYA');
      expect(after.filter((e) => e.validTo === null)).toHaveLength(1);
      const opened = after.at(-1)!;
      expect(opened).toMatchObject({
        eventType: 're_parented', fromLeaderId: id.AGUS, toLeaderId: id.PEER, reason: 'Closer to Hendra’s office',
        actorMembershipId: id.OWNER,
      });
      expect(after.find((e) => String(e._id) === String(before._id))!.validTo).toEqual(opened.validFrom);
      expect(await edges('DEDI')).toEqual(dediEdges);

      // Every leader's counts — Agus's and Peer's, and the Owner's above both (ADR-0247 §4).
      expect((await row('AGUS'))!.subtreeCount).toBe(5);
      expect((await row('PEER'))!.subtreeCount).toBe(4);
      expect(await countsDrift()).toEqual([]);

      expect(await audits('member.leader_changed')).toEqual([expect.objectContaining({
        targetMembershipId: id.MAYA,
        before: { leaderId: id.AGUS },
        after: { leaderId: id.PEER, reason: 'Closer to Hendra’s office', subtreeSize: 2, via: 'office' },
      })]);
      expect(notices('member.leader_changed').map((n) => [n.userId, n.payload!.audience])).toEqual([
        [user.MAYA, 'member'], [user.AGUS, 'from_leader'], [user.PEER, 'to_leader'],
      ]);
      expect(notices('member.leader_changed')[0].payload).toMatchObject({ memberName: 'Maya Anggraini', toLeaderName: 'Hendra Gunawan' });
    });

    it('P19.12-T4 AC-4 a join under somebody deep recounts every leader above them, not only the direct one', async () => {
      const newcomer = await account('Yoga Pratama', '20001');
      await place(KPM_A, newcomer, 'agent', id.EKO);
      expect((await row('AGUS'))!.subtreeCount).toBe(9);
      expect((await row('OWNER'))!.subtreeCount).toBe(13);
      expect(await countsDrift()).toEqual([]);
    });

    it('P19.12-T4 AC-2 the same leader again writes nothing', async () => {
      const before = await edges('MAYA');
      await move('MAYA', id.AGUS).expect(200);
      expect(await edges('MAYA')).toEqual(before);
      expect(await audits('member.leader_changed')).toHaveLength(0);
      expect(notices('member.leader_changed')).toHaveLength(0);
    });

    it('P19.12-T4 AC-2 a loop is refused: the person themselves, or anybody below them', async () => {
      expect((await move('MAYA', id.MAYA).expect(409)).body.error.code).toBe('ORG_CYCLE_DETECTED');
      expect((await move('MAYA', id.DEDI).expect(409)).body.error.code).toBe('ORG_CYCLE_DETECTED');
      expect((await row('MAYA'))!.leaderId).toBe(id.AGUS);
    });

    it('P19.12-T4 AC-2 an Agent who leads nobody cannot hold a unit; one who leads somebody can', async () => {
      const refused = await move('MAYA', id.TONI).expect(422);
      expect(refused.body.error.code).toBe('ORG_LEADER_CANNOT_LEAD');
      await move('TONI', id.DEDI).expect(200);
      expect(await row('TONI')).toMatchObject({ leaderId: id.DEDI, ancestorIds: [id.OWNER, id.AGUS, id.MAYA, id.DEDI] });
    });

    it('P19.12-T4 AC-2 the office’s owner is the platform’s to move: 403, nothing written', async () => {
      await signIn('ADMIN');
      const res = await move('OWNER', id.AGUS).expect(403);
      expect(res.body.error.code).toBe('ORG_LEADER_CHANGE_NOT_PERMITTED');
      expect((await row('OWNER'))!.leaderId).toBeNull();
    });

    it('P19.12-T4 AC-2 a new leader not in the office is 422; a malformed one 400; a removed or pending person 409', async () => {
      expect((await move('MAYA', id.B_OWNER).expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
      expect((await move('MAYA', id.WAITING).expect(422)).body.error.code).toBe('ORG_LEADER_NOT_IN_KPM');
      expect((await move('MAYA', 'not-an-id').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await move('WAITING', id.PEER).expect(409)).body.error.code).toBe('ORG_MEMBER_NOT_ACTIVE');
      await removals.remove(await as('OWNER'), id.TONI, { confirmation: 'REMOVE' });
      expect((await move('TONI', id.PEER).expect(409)).body.error.code).toBe('ORG_ALREADY_REMOVED');
    });

    it('P19.12-T4 AC-5 another office’s member is 404, answered as nobody — and its leaders are not ours to name', async () => {
      await signIn('B_OWNER');
      expect((await move('MAYA', id.B_OWNER).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await http().get(`/members/${id.MAYA}/leader-choices`).expect(404)).body.error.code).toBe('NOT_FOUND');
      await signIn('OWNER');
      expect((await move('B_AGENT', id.PEER).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await row('MAYA'))!.leaderId).toBe(id.AGUS);
    });

    it('P19.12-T4 AC-2 an Admin moves anybody but the owner, as the Owner does', async () => {
      await signIn('ADMIN');
      await move('PEER_AGENT', id.SARI).expect(200);
      expect(await row('PEER_AGENT')).toMatchObject({ leaderId: id.SARI, ancestorIds: [id.OWNER, id.AGUS, id.SARI] });
      expect((await audits('member.leader_changed'))[0].after).toMatchObject({ via: 'office' });
    });

    it('P19.12-T4 AC-3 an AB leader moves a direct report inside their own tree at once, audited as theirs', async () => {
      await signIn('AGUS');
      await move('TONI', id.SARI, 'Sari will coach him').expect(200);
      expect(await row('TONI')).toMatchObject({ leaderId: id.SARI, ancestorIds: [id.OWNER, id.AGUS, id.SARI] });
      expect((await audits('member.leader_changed'))[0].after).toMatchObject({ via: 'leader', subtreeSize: 0 });
      // The leader made it, so the leader is not told: Toni and Sari are, Agus is not.
      expect(notices('member.leader_changed').map((n) => [n.userId, n.payload!.audience])).toEqual([
        [user.TONI, 'member'], [user.SARI, 'to_leader'],
      ]);
    });

    it('P19.12-T4 AC-3 an AAB leader moves a direct report under somebody in their tree', async () => {
      await signIn('SARI');
      await move('RINA', id.FINA).expect(200);
      expect(await row('RINA')).toMatchObject({ leaderId: id.FINA, ancestorIds: [id.OWNER, id.AGUS, id.SARI, id.FINA] });
    });

    it('P19.12-T4 AC-3 a leader’s move outside their tree is 403 with canRequest; two levels down 403; outside their downline 404', async () => {
      await signIn('AGUS');
      const outside = await move('TONI', id.PEER).expect(403);
      expect(outside.body.error).toMatchObject({
        code: 'ORG_LEADER_CHANGE_NOT_PERMITTED', details: expect.objectContaining({ canRequest: true }),
      });
      const deep = await move('RINA', id.MAYA).expect(403);
      expect(deep.body.error.code).toBe('ORG_LEADER_CHANGE_NOT_PERMITTED');
      expect(deep.body.error.details.canRequest).toBeUndefined();
      expect((await move('PEER_AGENT', id.SARI).expect(404)).body.error.code).toBe('NOT_FOUND');
      await signIn('SARI');
      expect((await move('RINA', id.AGUS).expect(403)).body.error.details.canRequest).toBe(true);
      expect((await row('TONI'))!.leaderId).toBe(id.AGUS);
      expect((await row('RINA'))!.leaderId).toBe(id.SARI);
    });

    it('P19.12-T4 AC-6 an Agent, the Super Admin and a read-only support session are refused, 403', async () => {
      await signIn('DEDI');
      expect((await move('EKO', id.MAYA).expect(403)).body.error.code).toBe('PERM_DENIED');
      session.current = RequestContext.platform('root');
      expect((await move('TONI', id.SARI).expect(403)).body.error.code).toBe('PERM_DENIED');
      await signIn('OWNER', { readOnly: true });
      expect((await move('TONI', id.SARI).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await http().get(`/members/${id.TONI}/leader-choices`).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await row('TONI'))!.leaderId).toBe(id.AGUS);
    });

    it('P19.12-T4 AC-2 a transfer request still waiting for them is closed, and whoever asked is told', async () => {
      await signIn('AGUS');
      const transferId = (await ask('TONI', id.PEER).expect(201)).body.transferId as string;
      sent.length = 0;
      await signIn('OWNER');
      await move('TONI', id.ADMIN).expect(200);
      expect(await col('transferRequests').findOne({ _id: oid(transferId) })).toMatchObject({ status: 'cancelled' });
      expect(notices('transfer_request.decided')).toEqual([expect.objectContaining({
        userId: user.AGUS, payload: expect.objectContaining({ decision: 'cancelled', audience: 'requester', memberName: 'Toni Wibowo' }),
      })]);
      expect(await audits('transfer_request.cancelled')).toHaveLength(1);
    });

    it('P19.12-T4 AC-4 two crossing moves take turns: one is made, the other meets the loop it would have closed', async () => {
      const owner = await as('OWNER');
      // Sari under Dedi (below Maya), and Maya under Fina (below Sari), at once.
      const results = await Promise.allSettled([
        leaders.move(owner, id.SARI, id.DEDI),
        leaders.move(owner, id.MAYA, id.FINA),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'ORG_CYCLE_DETECTED' });
      // Nobody is their own ancestor.
      for (const m of await col('memberships').find({ kpmId: KPM_A }).toArray()) {
        expect(m.ancestorIds).not.toContain(String(m._id));
      }
      expect(await countsDrift()).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ GET /members/:id/leader-choices

  describe('GET /members/:id/leader-choices — the picker', () => {
    const named = (body: { fullName: string; direct: boolean }[]) => body.map((c) => [c.fullName, c.direct]);

    it('P19.12-T4 AC-2 the office: everybody who can hold a unit, but the person, their downline and their leader — all at once', async () => {
      const res = await http().get(`/members/${id.MAYA}/leader-choices`).expect(200);
      expect(named(res.body)).toEqual([
        ['Fina Lestari', true], ['Hendra Gunawan', true], ['Sari Puspita', true], ['Siti Rahma', true], ['Wilson Tan', true],
      ]);
      expect(res.body.find((c: { fullName: string }) => c.fullName === 'Hendra Gunawan')).toMatchObject({
        membershipId: id.PEER, agentCode: '10012', orgLevelCode: 'AB', role: 'ab', unitSize: 1,
      });
    });

    it('P19.12-T4 AC-3 a leader: their own tree at once, the office’s ABs and AABs outside it to ask for, and a search', async () => {
      await signIn('AGUS');
      const res = await http().get(`/members/${id.TONI}/leader-choices`).expect(200);
      expect(named(res.body)).toEqual([
        ['Dedi Kurniawan', true], ['Fina Lestari', true], ['Maya Anggraini', true], ['Sari Puspita', true],
        ['Hendra Gunawan', false], ['Siti Rahma', false], ['Wilson Tan', false],
      ]);
      const searched = await http().get(`/members/${id.TONI}/leader-choices`).query({ q: 'hendra' }).expect(200);
      expect(named(searched.body)).toEqual([['Hendra Gunawan', false]]);
      const byCode = await http().get(`/members/${id.TONI}/leader-choices`).query({ q: '10008' }).expect(200);
      expect(named(byCode.body)).toEqual([['Maya Anggraini', true]]);
    });

    it('P19.12-T4 AC-3 a leader asking about somebody two levels down is 403; outside their downline 404', async () => {
      await signIn('AGUS');
      expect((await http().get(`/members/${id.RINA}/leader-choices`).expect(403)).body.error.code).toBe('ORG_LEADER_CHANGE_NOT_PERMITTED');
      expect((await http().get(`/members/${id.PEER_AGENT}/leader-choices`).expect(404)).body.error.code).toBe('NOT_FOUND');
    });
  });

  // ------------------------------------------------------------------ POST /members/:id/transfer-request

  describe('POST /members/:id/transfer-request — a move elsewhere, asked of the office', () => {
    it('P19.12-T4 AC-3 Agus asks to move Toni to Hendra: 201, waiting, the office told, Tim Anda shows it, + Add agent’s list does not', async () => {
      await signIn('AGUS');
      const res = await ask('TONI', id.PEER, 'He lives near Hendra').expect(201);
      expect(res.body).toEqual({ transferId: expect.any(String), toName: 'Hendra Gunawan', requestedAt: expect.any(String) });
      expect(await col('transferRequests').findOne({})).toMatchObject({
        kpmId: KPM_A, kind: 'move', membershipId: id.TONI, fromLeaderId: id.AGUS, toLeaderId: id.PEER,
        requestedByMembershipId: id.AGUS, note: 'He lives near Hendra', status: 'pending', requestedName: null,
      });
      expect((await row('TONI'))!.leaderId).toBe(id.AGUS);
      expect(notices('transfer_request.received').map((n) => n.userId).sort()).toEqual([user.ADMIN, user.OWNER].sort());
      expect(notices('transfer_request.received')[0].payload).toMatchObject({ kind: 'move', toLeaderName: 'Hendra Gunawan', memberName: 'Toni Wibowo' });
      expect(await audits('transfer_request.created')).toEqual([expect.objectContaining({
        after: expect.objectContaining({ kind: 'move', toLeaderId: id.PEER, note: 'He lives near Hendra' }),
      })]);

      const team = await roles.team(await as('AGUS'));
      expect(team.find((t) => t.membershipId === id.TONI)?.pendingTransfer).toEqual({
        transferId: res.body.transferId, toName: 'Hendra Gunawan', requestedAt: res.body.requestedAt,
      });
      expect(team.find((t) => t.membershipId === id.MAYA)?.pendingTransfer).toBeNull();
      expect(await transfers.mine(await as('AGUS'))).toEqual([]);
    });

    it('P19.12-T4 AC-3 the queue words it as a move, with the note; approving moves Toni and tells the new leader too', async () => {
      await signIn('AGUS');
      const transferId = (await ask('TONI', id.PEER, 'He lives near Hendra').expect(201)).body.transferId as string;
      sent.length = 0;
      await signIn('OWNER');
      const queue = await http().get('/transfer-requests').expect(200);
      expect(queue.body).toEqual([expect.objectContaining({
        transferId, kind: 'move', note: 'He lives near Hendra',
        member: expect.objectContaining({ name: 'Toni Wibowo' }), to: expect.objectContaining({ name: 'Hendra Gunawan' }),
        requestedBy: expect.objectContaining({ name: 'Agus Prasetyo' }),
      })]);
      await http().post(`/transfer-requests/${transferId}/approve`).expect(200, []);
      expect(await row('TONI')).toMatchObject({ leaderId: id.PEER, ancestorIds: [id.OWNER, id.PEER] });
      expect(notices('transfer_request.decided').map((n) => [n.userId, n.payload!.audience])).toEqual([
        [user.TONI, 'member'], [user.AGUS, 'requester'], [user.PEER, 'to_leader'],
      ]);
      expect(notices('transfer_request.decided')[1].payload).toMatchObject({ kind: 'move', memberName: 'Toni Wibowo' });
      expect(await countsDrift()).toEqual([]);
    });

    it('P19.12-T4 AC-3 refused: inside the tree 400, one already waiting 409, a loop 409, two levels down 403, outside the downline 404', async () => {
      await signIn('AGUS');
      expect((await ask('TONI', id.SARI).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      await ask('TONI', id.PEER).expect(201);
      expect((await ask('TONI', id.ADMIN).expect(409)).body.error.code).toBe('ORG_TRANSFER_PENDING');
      expect((await ask('MAYA', id.DEDI).expect(409)).body.error.code).toBe('ORG_CYCLE_DETECTED');
      expect((await ask('RINA', id.PEER).expect(403)).body.error.code).toBe('ORG_LEADER_CHANGE_NOT_PERMITTED');
      expect((await ask('PEER_AGENT', id.ADMIN).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.12-T4 AC-6 the Owner and an Admin move directly — 400 — an Agent never asks — 403 — nor does another office reach ours — 404', async () => {
      // An Owner or an Admin standing on AB holds AB's grant, and needs nobody's approval: told to move them directly.
      for (const who of ['OWNER', 'ADMIN'] as const) {
        await signIn(who);
        expect([who, (await ask('TONI', id.PEER).expect(400)).body.error.code]).toEqual([who, 'VALIDATION_FAILED']);
      }
      await signIn('DEDI');
      expect((await ask('EKO', id.PEER).expect(403)).body.error.code).toBe('PERM_DENIED');
      await signIn('AGUS', { readOnly: true });
      expect((await ask('TONI', id.PEER).expect(403)).body.error.code).toBe('PERM_DENIED');
      await signIn('B_OWNER', { owner: false });
      expect((await ask('MAYA', id.B_AGENT).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect(await col('transferRequests').countDocuments({})).toBe(0);
    });
  });

  // ------------------------------------------------------------------ DELETE /transfer-requests/:id

  describe('DELETE /transfer-requests/:id — withdrawn by whoever asked', () => {
    it('P19.12-T4 AC-3 Agus withdraws his own: cancelled, audited, nothing about Toni changes; twice is 409', async () => {
      await signIn('AGUS');
      const transferId = (await ask('TONI', id.PEER).expect(201)).body.transferId as string;
      await http().delete(`/transfer-requests/${transferId}`).expect(200, { transferId, status: 'cancelled' });
      expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'cancelled', decidedByMembershipId: id.AGUS });
      expect((await row('TONI'))!.leaderId).toBe(id.AGUS);
      expect(await audits('transfer_request.cancelled')).toHaveLength(1);
      expect((await http().delete(`/transfer-requests/${transferId}`).expect(409)).body.error.code).toBe('ORG_REQUEST_ALREADY_DECIDED');
      expect((await roles.team(await as('AGUS'))).find((t) => t.membershipId === id.TONI)?.pendingTransfer).toBeNull();
    });

    it('P19.12-T4 AC-5 anybody else’s, and another office’s, is 404', async () => {
      await signIn('AGUS');
      const transferId = (await ask('TONI', id.PEER).expect(201)).body.transferId as string;
      await signIn('SARI');
      expect((await http().delete(`/transfer-requests/${transferId}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      await signIn('B_OWNER', { owner: false });
      expect((await http().delete(`/transfer-requests/${transferId}`).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect(await col('transferRequests').findOne({})).toMatchObject({ status: 'pending' });
    });
  });

  // ------------------------------------------------------------------ the role rule

  describe('a leader sets roles up to their own rung (ADR-0247 §1)', () => {
    it('P19.12-T4 AC-1 Agus (AB) is offered every rung for Maya, an AB, hers checked; the directory says the same as Tim Anda; he makes Toni an AB and back', async () => {
      const agus = await as('AGUS');
      const team = await roles.team(agus);
      const maya = team.find((t) => t.membershipId === id.MAYA)!;
      expect(maya).toMatchObject({ orgLevelCode: 'AB', roleChoices: ['AGENT', 'AAB', 'AB'], canChangeRole: true, canChangeLeader: true });
      const read = await directory.read(agus, id.MAYA);
      expect(read).toMatchObject({ roleChoices: maya.roleChoices, canChangeRole: true, canPromoteToAb: true, canChangeLeader: true });

      await roles.change(agus, id.TONI, 'ab');
      expect(await row('TONI')).toMatchObject({ role: 'ab', orgLevelCode: 'AB', leaderId: id.AGUS });
      await roles.change(agus, id.TONI, 'agent');
      expect((await row('TONI'))!.role).toBe('agent');
    });

    it('P19.12-T4 AC-1 Sari (AAB) is offered Agent and AAB, and refused AB', async () => {
      const sari = await as('SARI');
      expect((await roles.team(sari)).find((t) => t.membershipId === id.RINA)?.roleChoices).toEqual(['AGENT', 'AAB']);
      expect((await directory.read(sari, id.RINA)).canPromoteToAb).toBe(false);
      await expect(roles.change(sari, id.RINA, 'ab')).rejects.toMatchObject({ code: 'ORG_ROLE_CHANGE_NOT_PERMITTED' });
    });

    it('P19.12-T4 AC-1 the leader limit still applies to a leader’s promotion, with the request ADR-0157 offers', async () => {
      const used = await col('memberships').countDocuments({ kpmId: KPM_A, status: 'active', role: { $in: ['ab', 'aab'] } });
      await mongoose.model(Kpm.name).updateOne({ _id: KPM_A }, {
        $set: {
          subscription: {
            startDate: null, endDate: null, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: used, keepActiveAfterEnd: false,
          },
        },
      });
      await expect(roles.change(await as('AGUS'), id.TONI, 'ab')).rejects.toMatchObject({
        code: 'LEADER_LIMIT_REACHED', details: expect.objectContaining({ canRequest: true }),
      });
      expect((await row('TONI'))!.role).toBe('agent');
    });

    it('P19.12-T4 AC-1 the office’s owner is offered nothing, to anybody', async () => {
      const read = await directory.read(await as('ADMIN'), id.OWNER);
      expect(read).toMatchObject({ roleChoices: ['AB'], canChangeRole: false, canChangeLeader: false });
    });
  });
});
