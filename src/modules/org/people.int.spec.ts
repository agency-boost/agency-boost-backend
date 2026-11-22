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
import { OfficeGroups } from '@/modules/reporting/office-groups';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import {
  RosterImportRecord, RosterImportRecordRepository, RosterImportRecordSchema,
} from '@/modules/tenants/roster-import-record.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { declaredPermissions, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { ApprovalsService } from './approvals.service';
import { DirectoryService } from './directory.service';
import { Group, GroupSchema } from './group.schema';
import { HierarchyService } from './hierarchy.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { GroupRepository, JoinRequestRepository, MembershipHistoryRepository } from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';

/** 10:00 on Friday 20 November 2026 in Jakarta. */
const NOW = new Date('2026-11-20T03:00:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();
const SA_USER = new mongoose.Types.ObjectId().toString();

type Who =
  | 'OWNER' | 'AGUS' | 'SARI' | 'RINA' | 'MAYA' | 'PEER' | 'PEER_AGENT' | 'ADMIN' | 'TEST' | 'NEW' | 'B_OWNER' | 'B_NEW';

/**
 * **People — All members, *Riwayat*, the Org tree, *KPM admins*' tiles, *Pilih leader* and *Riwayat unggah*, over HTTP
 * and through the services** (P19.20-T1 to T5; ADR-0273; `PERMISSIONS.md` of 19 November).
 *
 * ```
 * Office A (0417):  OWNER (AB, the Owner) ─┬── AGUS (AB, ★ core leader, Top Producers) ─┬── SARI (AAB) ── RINA (Agent)
 *                                          │                                            └── MAYA (AB, Group Leader)
 *                                          ├── PEER (AB, Tanpa group) ── PEER_AGENT (Agent)
 *                                          ├── ADMIN (Agent, KPM Admin)
 *                                          └── TEST (Agent, a test account)
 *                   NEW (registered, pending, in no unit)
 * Office B (0555):  B_OWNER (AB, its Owner)   B_NEW (pending, in no unit)
 * ```
 */
describe('P19.20 People over HTTP and through the services', () => {
  let app: INestApplication;
  let clock: FixedClock;
  let hierarchy: HierarchyService;
  let directory: DirectoryService;
  let tree: OrgTreeService;
  let companyId: string;
  let groupId: string;
  let id: Record<Who, string>;
  let userOf: Record<Who, string>;
  let approvals: ApprovalsService;
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const http = () => request(app.getHttpServer());
  const job = (kpmId: string) => RequestContext.forJob(kpmId, 'people-spec');
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
    const groups = new GroupRepository(mongoose.model(Group.name, GroupSchema) as never);
    const requests = new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never);
    const records = new RosterImportRecordRepository(
      mongoose.model(RosterImportRecord.name, RosterImportRecordSchema) as never,
    );
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never, companies as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined } as never;
    directory = new DirectoryService(
      members, users as never, kpms as never, companies as never, orgLevels, null, new OfficeGroups(groups, members),
    );
    tree = new OrgTreeService(members, users as never);
    approvals = new ApprovalsService(members, hierarchy, requests, history, users as never, audit, notifications, clock);
    const people = new PeopleService(members, history, users as never, kpms as never, directory, approvals, records, null);

    const moduleRef = await Test.createTestingModule({
      controllers: [PeopleController],
      providers: [{ provide: PeopleService, useValue: people }],
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
  async function account(fullName: string, extra: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const u = await mongoose.model(User.name).create({
      email: `pp${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: String(30000 + seq), ...extra,
    });
    return String(u._id);
  }

  async function place(kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null, status = 'active') {
    const m = await hierarchy.create(job(kpmId), {
      userId, role, leaderId, status: status as 'active', ...(status === 'active' ? { joining: { joinDate: '2025-01-02' } } : {}),
    });
    return String(m._id);
  }

  async function as(who: Who, flags: { owner?: boolean; admin?: boolean; coreLeader?: boolean } = {}): Promise<RequestContext> {
    const row = (await col('memberships').findOne({ _id: oid(id[who]) }))!;
    return new RequestContext(String(row.userId), 'none', {
      membershipId: id[who], kpmId: row.kpmId, orgLevelCode: String(row.orgLevelCode), hierarchyRole: row.role, status: row.status,
      isKpmOwner: flags.owner ?? (who === 'OWNER' || who === 'B_OWNER'), isKpmAdmin: flags.admin ?? who === 'ADMIN',
      directCount: row.directCounts?.total ?? 0, isCoreLeader: flags.coreLeader ?? who === 'AGUS',
    } as never);
  }
  const signIn = async (who: Who, flags: { owner?: boolean; admin?: boolean; coreLeader?: boolean } = {}) => {
    session.current = await as(who, flags);
  };
  const SA_IN_A = () => RequestContext.superAdminInKpm(RequestContext.platform(SA_USER), KPM_A);

  beforeEach(async () => {
    clock.set(NOW);
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-pp-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    const names: [Who, string][] = [
      ['OWNER', 'Wilson Tanoto'], ['AGUS', 'Agus Prasetyo'], ['SARI', 'Sari Puspita'], ['RINA', 'Rina Kurnia'],
      ['MAYA', 'Maya Halim'], ['PEER', 'Yosef Tambunan'], ['PEER_AGENT', 'Winda Anggraeni'], ['ADMIN', 'Dewi Admin'],
      ['TEST', 'FMT Akun Tes'], ['NEW', 'Fajar Nugroho'], ['B_OWNER', 'Bagus Santoso'], ['B_NEW', 'Dian Lestari'],
    ];
    const u = {} as Record<Who, string>;
    for (const [who, name] of names) u[who] = await account(name, who === 'TEST' ? { testAccount: true } : {});
    userOf = u;
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
    i.PEER = await place(KPM_A, u.PEER, 'ab', i.OWNER);
    i.PEER_AGENT = await place(KPM_A, u.PEER_AGENT, 'agent', i.PEER);
    i.ADMIN = await place(KPM_A, u.ADMIN, 'agent', i.OWNER);
    i.TEST = await place(KPM_A, u.TEST, 'agent', i.OWNER);
    i.NEW = await place(KPM_A, u.NEW, 'agent', null, 'pending');
    i.B_OWNER = await place(KPM_B, u.B_OWNER, 'ab', null);
    i.B_NEW = await place(KPM_B, u.B_NEW, 'agent', null, 'pending');
    id = i;
    await col('memberships').updateOne({ _id: oid(i.AGUS) }, { $set: { isCoreLeader: true } });
    await col('memberships').updateOne({ _id: oid(i.TEST) }, { $set: { testAccount: true, isCoreLeader: false } });
    await col('memberships').updateOne({ _id: oid(i.ADMIN) }, { $set: { 'adminAccess.isKpmAdmin': true } });
    const group = await col('groups').insertOne({
      kpmId: KPM_A, name: 'Top Producers 2026', leaderMembershipIds: [i.MAYA], status: 'active', archivedAt: null,
      createdByMembershipId: i.OWNER, deletedAt: null, createdAt: NOW, updatedAt: NOW,
    });
    groupId = String(group.insertedId);
    await col('memberships').updateMany({ _id: { $in: [oid(i.AGUS), oid(i.MAYA)] } }, { $set: { groupIds: [groupId] } });
  });

  it('P19.20 declares each route’s permission', () => {
    expect(declaredPermissions(PeopleController)).toEqual({
      history: 'member:read_role_change_log',
      stewards: 'kpm_admin:list',
      imports: 'kpm:import_roster',
      place: 'member:add_untagged_to_unit',
    });
  });

  describe('T1 All members (the roster’s rows)', () => {
    it('P19.20-T1 AC-2 a test account is never listed nor counted on any tab', async () => {
      const page = await directory.list(await as('OWNER'), { limit: 100 });

      expect(page.members.map((m) => m.membershipId)).not.toContain(id.TEST);
      expect(page.counts.directory).toBe(page.members.length);
      expect(page.counts.directory).toBe(8);
      expect(page.counts.pending).toBe(1);
    });

    it('P19.20-T1 AC-2 *★ Core leader* lists the core leaders only', async () => {
      const page = await directory.list(await as('OWNER'), { coreLeader: true });

      expect(page.members.map((m) => m.membershipId)).toEqual([id.AGUS]);
    });

    it('P19.20-T1 AC-2 each active row carries its group: an AB’s own, an AAB’s and an agent’s their AB’s, and Group Leader', async () => {
      const page = await directory.list(await as('OWNER'), { limit: 100 });
      const place = new Map(page.members.map((m) => [m.membershipId, m.groupPlace]));

      expect(place.get(id.AGUS)).toEqual({
        group: { groupId, name: 'Top Producers 2026' }, ab: { membershipId: id.AGUS, name: 'Agus Prasetyo' }, isGroupLeader: false,
      });
      expect(place.get(id.MAYA)).toMatchObject({ group: { groupId }, isGroupLeader: true });
      expect(place.get(id.SARI)).toEqual({
        group: { groupId, name: 'Top Producers 2026' }, ab: { membershipId: id.AGUS, name: 'Agus Prasetyo' }, isGroupLeader: false,
      });
      expect(place.get(id.PEER_AGENT)).toEqual({ group: null, ab: { membershipId: id.PEER, name: 'Yosef Tambunan' }, isGroupLeader: false });
      // Under no AB: the Owner's own direct agent follows the Owner, an AB.
      expect(place.get(id.ADMIN)?.ab?.membershipId).toBe(id.OWNER);
    });

    it('P19.20-T1 AC-2 a leader who is no steward reads their unit with no groups', async () => {
      const page = await directory.list(await as('PEER'), { limit: 100 });

      expect(page.members.length).toBeGreaterThan(0);
      expect(page.members.every((m) => m.groupPlace === undefined)).toBe(true);
    });

    it('P19.20-T1 AC-5 a core leader sees every row, openable only in their downline', async () => {
      const page = await directory.list(await as('AGUS'), { limit: 100 });
      const openable = new Map(page.members.map((m) => [m.membershipId, m.openable]));

      expect(openable.get(id.RINA)).toBe(true);
      expect(openable.get(id.PEER_AGENT)).toBe(false);
      expect(openable.has(id.TEST)).toBe(false);
    });
  });

  describe('T3 Org tree', () => {
    it('P19.20-T3 AC-1 the whole KPM, test accounts neither drawn nor counted', async () => {
      const read = await tree.read(await as('OWNER'), undefined, 'kpm');

      expect(read.nodes.map((n) => n.membershipId)).not.toContain(id.TEST);
      expect(read.counts).toEqual({ ab: 3, aab: 1, agent: 3, total: 7 });
    });

    it('P19.20-T3 AC-1 a test account reading its own tree still has its own row', async () => {
      const read = await tree.read(await as('TEST'));

      expect(read.nodes.map((n) => n.membershipId)).toEqual([id.TEST]);
    });

    it('P19.20-T3 AC-3 a core leader’s Org tree is the whole KPM, rows outside their downline not openable', async () => {
      const read = await tree.read(await as('AGUS'), undefined, 'kpm');
      const openable = new Map(read.nodes.map((n) => [n.membershipId, n.openable]));

      expect(openable.get(id.MAYA)).toBe(true);
      expect(openable.get(id.PEER)).toBe(false);
      expect(openable.get(id.OWNER)).toBe(false);
    });
  });

  describe('T1 AC-4 Riwayat — GET /people/history', () => {
    async function event(who: Who, eventType: string, at: string, extra: Record<string, unknown> = {}, kpmId = KPM_A) {
      await col('membershipHistory').insertOne({
        kpmId, membershipId: id[who], eventType, fromRole: null, toRole: null, fromOrgLevelId: null, toOrgLevelId: null,
        fromLeaderId: null, toLeaderId: null, validFrom: new Date(at), validTo: new Date(at), actorMembershipId: id.OWNER,
        actorUserId: null, reason: null, deletedAt: null, ...extra,
      });
    }

    beforeEach(async () => {
      await event('SARI', 'role_changed', '2026-10-07T02:00:00Z', { fromRole: 'agent', toRole: 'aab', reason: 'Took the AAB track' });
      await event('PEER_AGENT', 're_parented', '2026-10-20T02:00:00Z', { fromLeaderId: id.MAYA, toLeaderId: id.PEER });
      await event('RINA', 'removed', '2026-10-29T02:00:00Z');
      await col('memberships').updateOne({ _id: oid(id.RINA) }, { $set: { status: 'removed' } });
      await event('TEST', 'role_changed', '2026-11-01T02:00:00Z', { fromRole: 'agent', toRole: 'aab' });
      await event('B_OWNER', 'role_changed', '2026-11-02T02:00:00Z', { fromRole: 'agent', toRole: 'ab' }, KPM_B);
    });

    it('P19.20-T1 AC-4 Semua: every kind, newest first, named; no test account; nothing of another KPM', async () => {
      await signIn('OWNER');

      const res = await http().get('/people/history').expect(200);

      expect(res.body.map((e: { kind: string; fullName: string }) => [e.kind, e.fullName])).toEqual([
        ['removed', 'Rina Kurnia'],
        ['moved', 'Winda Anggraeni'],
        ['role', 'Sari Puspita'],
      ]);
      expect(res.body[1]).toMatchObject({ fromLeaderName: 'Maya Halim', toLeaderName: 'Yosef Tambunan', actorName: 'Wilson Tanoto' });
      expect(res.body[2]).toMatchObject({ fromRole: 'agent', toRole: 'aab', reason: 'Took the AAB track' });
    });

    it.each([
      ['role', ['Sari Puspita']],
      ['removed', ['Rina Kurnia']],
      ['moved', ['Winda Anggraeni']],
    ])('P19.20-T1 AC-4 the filter %s narrows it to one kind', async (kind, expected) => {
      await signIn('OWNER');

      const res = await http().get(`/people/history?kind=${kind}`).expect(200);

      expect(res.body.map((e: { fullName: string }) => e.fullName)).toEqual(expected);
    });

    it('P19.20-T1 AC-4 a filter it does not know is 400 VALIDATION_FAILED', async () => {
      await signIn('OWNER');

      expect((await http().get('/people/history?kind=groups').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['an Admin', () => as('ADMIN')],
      ['a core leader', () => as('AGUS')],
      ['the Super Admin inside the KPM', async () => SA_IN_A()],
    ])('P19.20-T1 AC-4 %s reads it', async (_, who) => {
      session.current = await who();

      expect((await http().get('/people/history').expect(200)).body).toHaveLength(3);
    });

    it('P19.20-T1 AC-5 a core leader’s line about somebody outside their downline does not open', async () => {
      await signIn('AGUS');

      const res = await http().get('/people/history').expect(200);
      const open = new Map(res.body.map((e: { fullName: string; openable: boolean }) => [e.fullName, e.openable]));

      expect(open.get('Sari Puspita')).toBe(true);
      expect(open.get('Winda Anggraeni')).toBe(false);
      // Removed: their sheet is history, never opened from here.
      expect(open.get('Rina Kurnia')).toBe(false);
    });

    it.each([
      ['an AB who is no core leader', () => as('PEER', { coreLeader: false })],
      ['an AAB', () => as('SARI')],
      ['an Agent', () => as('RINA')],
    ])('P19.20-T1 AC-4 %s is refused 403 PERM_DENIED', async (_, who) => {
      session.current = await who();

      expect((await http().get('/people/history').expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P19.20-T1 AC-4 another KPM’s Owner reads only their own (cross-tenant)', async () => {
      await signIn('B_OWNER');

      const res = await http().get('/people/history').expect(200);

      expect(res.body.map((e: { fullName: string }) => e.fullName)).toEqual(['Bagus Santoso']);
    });
  });

  describe('T4 AC-1 KPM admins’ tiles — GET /people/stewards', () => {
    it('P19.20-T4 AC-1 the Owner by name, the Admins and the core leaders counted, test accounts not', async () => {
      await col('memberships').updateOne({ _id: oid(id.TEST) }, { $set: { 'adminAccess.isKpmAdmin': true, isCoreLeader: true, role: 'ab' } });
      await signIn('OWNER');

      const res = await http().get('/people/stewards').expect(200);

      expect(res.body).toEqual({
        owner: { membershipId: id.OWNER, fullName: 'Wilson Tanoto', agentCode: expect.any(String), role: 'ab', photoUrl: null },
        admins: 1,
        coreLeaders: 1,
      });
    });

    it.each([
      ['an Admin', () => as('ADMIN')],
      ['the Super Admin inside the KPM', async () => SA_IN_A()],
    ])('P19.20-T4 AC-3 %s reads it', async (_, who) => {
      session.current = await who();

      expect((await http().get('/people/stewards').expect(200)).body.owner.fullName).toBe('Wilson Tanoto');
    });

    it.each([
      ['a core leader, who has no KPM admins page', () => as('AGUS')],
      ['an AB', () => as('PEER', { coreLeader: false })],
      ['an Agent', () => as('RINA')],
    ])('P19.20-T4 AC-3 %s is refused 403', async (_, who) => {
      session.current = await who();

      await http().get('/people/stewards').expect(403);
    });

    it('P19.20-T4 AC-1 another KPM’s Owner reads their own office (cross-tenant)', async () => {
      await signIn('B_OWNER');

      expect((await http().get('/people/stewards').expect(200)).body).toMatchObject({
        owner: { fullName: 'Bagus Santoso' }, admins: 0, coreLeaders: 0,
      });
    });
  });

  describe('T5 AC-3 Riwayat unggah — GET /people/imports', () => {
    beforeEach(async () => {
      const base = { invited: 0, skipped: 0, actorUserId: null, deletedAt: null };
      await col('rosterImports').insertMany([
        { ...base, kpmId: KPM_A, fileName: 'anggota_okt.xlsx', created: 2, updated: 1, actorMembershipId: id.OWNER, importedAt: new Date('2026-10-02T02:00:00Z') },
        { ...base, kpmId: KPM_A, fileName: 'anggota_nov.xlsx', created: 3, updated: 1, actorMembershipId: null, actorUserId: userOf.ADMIN, importedAt: new Date('2026-11-19T02:00:00Z') },
        { ...base, kpmId: KPM_B, fileName: 'lain.xlsx', created: 9, updated: 0, actorMembershipId: id.B_OWNER, importedAt: new Date('2026-11-18T02:00:00Z') },
      ]);
    });

    it('P19.20-T5 AC-3 this KPM’s files, newest first, by whom, n baru and n diperbarui (cross-tenant: nothing of B)', async () => {
      await signIn('OWNER');

      const res = await http().get('/people/imports').expect(200);

      expect(res.body.map((r: { fileName: string; byName: string; created: number; updated: number }) =>
        [r.fileName, r.byName, r.created, r.updated])).toEqual([
        ['anggota_nov.xlsx', 'Dewi Admin', 3, 1],
        ['anggota_okt.xlsx', 'Wilson Tanoto', 2, 1],
      ]);
    });

    it.each([
      ['an Admin', () => as('ADMIN')],
      ['a core leader', () => as('AGUS')],
      ['the Super Admin inside the KPM', async () => SA_IN_A()],
    ])('P19.20-T5 AC-4 %s reads it', async (_, who) => {
      session.current = await who();

      expect((await http().get('/people/imports').expect(200)).body).toHaveLength(2);
    });

    it.each([
      ['an AB who is no core leader', () => as('PEER', { coreLeader: false })],
      ['an Agent', () => as('RINA')],
    ])('P19.20-T5 AC-4 %s is refused 403', async (_, who) => {
      session.current = await who();

      await http().get('/people/imports').expect(403);
    });
  });

  describe('T6 AC-1 User Management’s Pending Requests: the Owner’s own unit', () => {
    beforeEach(async () => {
      const extra = await place(KPM_A, await account('Raka Aditama'), 'agent', null, 'pending');
      await col('joinRequests').insertMany([
        { kpmId: KPM_A, membershipId: id.NEW, leaderMembershipId: id.OWNER, routedToMembershipId: null, status: 'pending', deletedAt: null, createdAt: NOW },
        { kpmId: KPM_A, membershipId: extra, leaderMembershipId: id.AGUS, routedToMembershipId: null, status: 'pending', deletedAt: null, createdAt: NOW },
      ]);
    });

    it('P19.20-T6 AC-1 scope mine: only the requests to join the Owner’s own unit, listed and counted', async () => {
      const owner = await as('OWNER');

      expect((await approvals.inbox(owner, 'mine')).map((r) => r.membershipId)).toEqual([id.NEW]);
      expect(await approvals.waitingCount(owner, 'mine')).toEqual({ count: 1 });
    });

    it('P19.20-T6 AC-1 the office’s queue (All members › Menunggu) still holds every request', async () => {
      const owner = await as('OWNER');

      expect(await approvals.inbox(owner)).toHaveLength(2);
      expect(await approvals.waitingCount(owner, 'office')).toEqual({ count: 2 });
    });

    it('P19.20-T6 AC-1 a leader’s is theirs either way', async () => {
      const agus = await as('AGUS', { coreLeader: false });

      expect(await approvals.waitingCount(agus, 'office')).toEqual({ count: 1 });
      expect(await approvals.waitingCount(agus, 'mine')).toEqual({ count: 1 });
    });
  });

  describe('T1 AC-4 Pilih leader — PUT /people/:membershipId/placement', () => {
    const placeUnder = (who: Who, leader: string) =>
      http().put(`/people/${id[who]}/placement`).send({ leaderMembershipId: leader });

    it('P19.20-T1 AC-4 the Owner puts somebody who registered under a leader, now: active, in that unit', async () => {
      await signIn('OWNER');

      const res = await placeUnder('NEW', id.PEER).expect(200);

      expect(res.body).toMatchObject({ membershipId: id.NEW, status: 'active', leaderId: id.PEER });
    });

    it('P19.20-T1 AC-4 a core leader places under somebody in their downline', async () => {
      await signIn('AGUS');

      expect((await placeUnder('NEW', id.MAYA).expect(200)).body.leaderId).toBe(id.MAYA);
    });

    it('P19.20-T1 AC-4 a core leader is answered 404 for a leader outside their downline, and nothing moves', async () => {
      await signIn('AGUS');

      expect((await placeUnder('NEW', id.PEER).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await col('memberships').findOne({ _id: oid(id.NEW) }))?.leaderId).toBeNull();
    });

    it('P19.20-T1 AC-4 an AB who is no steward is answered 404; an Agent 403', async () => {
      await signIn('PEER', { coreLeader: false });
      await placeUnder('NEW', id.PEER).expect(404);

      await signIn('RINA');
      await placeUnder('NEW', id.PEER).expect(403);
    });

    it('P19.20-T1 AC-4 somebody already in a unit is 409 ORG_AGENT_ALREADY_TAGGED', async () => {
      await signIn('OWNER');

      expect((await placeUnder('RINA', id.PEER).expect(409)).body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
    });

    it('P19.20-T1 AC-4 a leader id that is no id is 400 VALIDATION_FAILED', async () => {
      await signIn('OWNER');

      await http().put(`/people/${id.NEW}/placement`).send({ leaderMembershipId: 'agus' }).expect(400);
    });

    it('P19.20-T1 AC-4 another KPM’s waiting person, or a leader there, is 404 (cross-tenant)', async () => {
      await signIn('OWNER');

      await placeUnder('B_NEW', id.PEER).expect(404);
      await placeUnder('NEW', id.B_OWNER).expect(404);
      expect((await col('memberships').findOne({ _id: oid(id.B_NEW) }))?.status).toBe('pending');
    });
  });
});
