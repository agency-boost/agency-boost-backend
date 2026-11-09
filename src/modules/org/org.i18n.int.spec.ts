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
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { FIXTURE_KPM, OWNER, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { IN_INDONESIAN } from '../../../test/i18n';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { AdminDelegationService } from './admin-delegation.service';
import { ApprovalsService } from './approvals.service';
import { DirectoryService } from './directory.service';
import { Group, GroupSchema } from './group.schema';
import { GroupService } from './group.service';
import { HierarchyService } from './hierarchy.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { LeaderLimitRequest, LeaderLimitRequestSchema } from './leader-limit-request.schema';
import { LeaderLimitRequestService } from './leader-limit-request.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OrgController } from './org.controller';
import {
  GroupRepository, JoinRequestRepository, LeaderLimitRequestRepository, MembershipHistoryRepository,
} from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

/** 10:00 on Thursday 29 October 2026 in Jakarta. */
const NOW = new Date('2026-10-29T03:00:00Z');

/**
 * **P18.10-T5 — the org module's words in the reader's language, over HTTP** (ADR-0179 §7; AC-3, AC-4, AC-6, AC-7).
 *
 * The members routes behind the real services, the production pipe, `PermissionsGuard` and the error filter, on one
 * office built through `HierarchyService`:
 *
 * ```
 * 0417:  ROOT (AB, the Owner) ── AAB (Sari) ── AGENT (Rina)
 *        PENDING (Fajar, registered, let in by nobody yet)
 * ```
 *
 * Each family the module refuses in — changing a role, removing somebody, groups, who administers the office, the
 * leader limit — is asked once as an Indonesian screen asks (`Accept-Language: id`): the same `code` and `details`,
 * the sentence in Indonesian. Every other suite reads English (`test/setup.ts`), so the English stands as it was. The
 * words the API composes into an answer — a name it has none for — and the ones it stores are pinned here too.
 */
describe('P18.10-T5 the org module’s words in the reader’s language, over HTTP', () => {
  let app: INestApplication;
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let users: mongoose.Model<User>;
  let history: mongoose.Model<MembershipHistory>;
  const sent: { templateId: string; payload?: Record<string, unknown> }[] = [];
  let companyId: string;
  let seq = 0;
  const http = () => request(app.getHttpServer());

  let root: string;
  let aab: string;
  let agent: string;
  let pending: string;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const kpmModel = mongoose.model(Kpm.name, KpmSchema);
    users = mongoose.model(User.name, UserSchema);
    history = mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never;
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const historyRepo = new MembershipHistoryRepository(history as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      kpmModel as never,
      audit,
      clock,
    );
    hierarchy = new HierarchyService(members, kpmModel as never, users as never, historyRepo, clock, orgLevels);
    const notifications = {
      send: async (r: { templateId: string; payload?: Record<string, unknown> }) => { sent.push(r); },
    } as never;
    const roles = new RoleChangeService(members, hierarchy, historyRepo, users as never, audit, notifications, clock);
    const approvals = new ApprovalsService(
      members, hierarchy, new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never),
      historyRepo, users as never, audit, notifications, clock,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController],
      providers: [
        { provide: DirectoryService, useValue: new DirectoryService(members, users as never, kpmModel as never) },
        { provide: RoleChangeService, useValue: roles },
        {
          provide: RemovalService,
          useValue: new RemovalService(members, hierarchy, roles, historyRepo, audit, notifications, clock),
        },
        { provide: OrgTreeService, useValue: new OrgTreeService(members, users as never) },
        {
          provide: GroupService,
          useValue: new GroupService(
            new GroupRepository(mongoose.model(Group.name, GroupSchema) as never), members, users as never, audit, clock,
          ),
        },
        {
          provide: AdminDelegationService,
          useValue: new AdminDelegationService(members, historyRepo, users as never, audit, notifications, clock),
        },
        {
          provide: LeaderLimitRequestService,
          useValue: new LeaderLimitRequestService(
            new LeaderLimitRequestRepository(mongoose.model(LeaderLimitRequest.name, LeaderLimitRequestSchema) as never),
            members, hierarchy, roles, approvals, users as never, kpmModel as never, audit, notifications, clock,
          ),
        },
        // The roster page's columns are `directory-columns`' own spec's; no route here reads them.
        { provide: DirectoryColumns, useValue: { decorate: async (_ctx: unknown, page: unknown) => page } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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

  async function place(
    role: 'ab' | 'aab' | 'agent', leaderId: string | null, fullName: string, status: 'active' | 'pending' = 'active',
  ): Promise<string> {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: `${77000 + seq}`,
    });
    return String((await hierarchy.create(OWNER, { userId: String(u._id), role, leaderId, status }))._id);
  }

  /** The session the Owner's own token would carry: their row, read back. */
  async function asOwner(): Promise<RequestContext> {
    const row = (await members.findById(OWNER, root))!;
    return new RequestContext(row.userId, 'none', {
      membershipId: root, kpmId: FIXTURE_KPM, orgLevelCode: row.orgLevelCode, hierarchyRole: row.role,
      status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: row.directCounts?.total ?? 0,
    });
  }

  /** The account behind a membership, gone — what a name the API has none for is written for. */
  const forget = async (membershipId: string) => {
    await users.deleteOne({ _id: (await members.findById(OWNER, membershipId))!.userId });
  };

  beforeEach(async () => {
    await clearCollections();
    sent.length = 0;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `prudential-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    await mongoose.model(Kpm.name).create({
      _id: FIXTURE_KPM, companyId, code: '0417', branchName: 'Branch 0417', counters: { nextMemberSeq: 1 },
      status: 'active', timezone: 'Asia/Jakarta',
    });
    root = await place('ab', null, 'Wilson Tanoto');
    await mongoose.model(Kpm.name).updateOne(
      { _id: FIXTURE_KPM }, { $set: { ownerUserId: (await members.findById(OWNER, root))!.userId } },
    );
    aab = await place('aab', root, 'Sari Puspita');
    agent = await place('agent', aab, 'Rina Wijaya');
    pending = await place('agent', null, 'Fajar Nugroho', 'pending');
    session.current = await asOwner();
  });

  describe('changing a role', () => {
    it('P18.10-T5 AC-7 refuses a rung that is no code with the DTO’s own sentence, in Indonesian', async () => {
      const res = await http().patch(`/members/${aab}/role`).set(...IN_INDONESIAN).send({ toRole: 'senior manager' })
        .expect(400);
      expect(res.body.error).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'toRole harus berupa kode jenjang',
        details: { violations: ['toRole harus berupa kode jenjang'] },
        requestId: expect.anything(),
      });
      const english = await http().patch(`/members/${aab}/role`).send({ toRole: 'senior manager' }).expect(400);
      expect(english.body.error.details.violations).toEqual(['toRole must be a rung code']);
    });

    it('P18.10-T5 AC-7 refuses demoting somebody who leads, with the count, in Indonesian', async () => {
      const res = await http().patch(`/members/${aab}/role`).set(...IN_INDONESIAN).send({ toRole: 'agent' }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'ORG_HAS_DIRECT_REPORTS',
        message: '1 orang melapor kepadanya. Pindahkan mereka ke leader lain terlebih dahulu.',
        details: { membershipId: aab, directCount: 1 },
      });
      const english = await http().patch(`/members/${aab}/role`).send({ toRole: 'agent' }).expect(409);
      expect(english.body.error.message).toBe('1 person reports to them. Move them to another leader first.');
    });

    it('P18.10-T5 AC-7 refuses a leader past the office’s limit, and asking without a rung, in Indonesian', async () => {
      // Two leaders used — the Owner and Sari — and two allowed.
      await mongoose.model(Kpm.name).updateOne({ _id: FIXTURE_KPM }, {
        $set: {
          subscription: {
            startDate: null, endDate: null, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: 2,
            keepActiveAfterEnd: false,
          },
        },
      });
      const res = await http().patch(`/members/${agent}/role`).set(...IN_INDONESIAN).send({ toRole: 'aab' }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'LEADER_LIMIT_REACHED',
        message: 'KPM ini sudah mencapai batas 2 leaders — AB dan AAB dihitung bersama, termasuk Owner. '
          + 'Minta AgencyBoost menyetujui yang satu ini melebihi batas, atau menaikkan batasnya.',
        details: { maxLeaders: 2, leadersUsed: 2, canRequest: true },
      });

      const noCode = await http().post(`/members/${agent}/leader-limit-request`).set(...IN_INDONESIAN)
        .send({ action: 'promote', orgLevelCode: 'not a rung' }).expect(400);
      expect(noCode.body.error.details.violations).toEqual(['orgLevelCode harus berupa kode jenjang']);
      const unnamed = await http().post(`/members/${agent}/leader-limit-request`).set(...IN_INDONESIAN)
        .send({ action: 'promote' }).expect(400);
      expect(unnamed.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', message: 'Sebutkan jenjang yang akan diberikan kepadanya.', details: { field: 'orgLevelCode' },
      });
    });
  });

  describe('removing somebody', () => {
    it('P18.10-T5 AC-7 refuses a removal nobody confirmed, then one that leaves reports nowhere, in Indonesian', async () => {
      const unconfirmed = await http().delete(`/members/${aab}`).set(...IN_INDONESIAN).send({ confirmation: 'yes' })
        .expect(400);
      expect(unconfirmed.body.error).toMatchObject({
        code: 'ORG_REMOVAL_NOT_CONFIRMED', message: 'Ketik REMOVE untuk mengonfirmasi.', details: { expected: 'REMOVE' },
      });
      const nowhere = await http().delete(`/members/${aab}`).set(...IN_INDONESIAN).send({ confirmation: 'REMOVE' })
        .expect(400);
      expect(nowhere.body.error).toMatchObject({
        code: 'ORG_SUBTREE_DISPOSITION_REQUIRED',
        message: '1 orang melapor kepadanya. Tentukan ke mana mereka dipindahkan sebelum mengeluarkan leader ini.',
        details: { membershipId: aab, directCount: 1 },
      });
      const english = await http().delete(`/members/${aab}`).send({ confirmation: 'REMOVE' }).expect(400);
      expect(english.body.error.message).toBe('1 person reports to them. Say where they go before removing this leader.');
    });

    it('P18.10-T5 AC-6 stores the moved reports’ reason and the removed member’s next step in the remover’s language', async () => {
      await http().delete(`/members/${aab}`).set(...IN_INDONESIAN).send({
        confirmation: 'remove', reason: 'Pindah ke kota lain', subtree: { action: 'reassign', toMembershipId: root },
      }).expect(200);
      // The reason the remover typed is kept as typed, inside our words.
      const edge = await history.findOne({ membershipId: agent, eventType: 're_parented', validTo: null }).lean().exec();
      expect(edge?.reason).toBe('Leader dikeluarkan dari KPM: Pindah ke kota lain');
      expect(sent.find((n) => n.templateId === NotificationTemplate.MEMBER_REMOVED)?.payload).toEqual({
        reason: 'Pindah ke kota lain', nextStep: 'Cari leader dan minta bergabung lagi jika Anda ingin kembali.',
      });
    });
  });

  describe('groups', () => {
    it('P18.10-T5 AC-7 refuses a second group of one name, and an owner outside the office, in Indonesian', async () => {
      await http().post('/members/groups').send({ name: 'Mentoring Circle', ownerMembershipId: aab }).expect(201);
      const taken = await http().post('/members/groups').set(...IN_INDONESIAN)
        .send({ name: 'Mentoring Circle', ownerMembershipId: aab }).expect(409);
      expect(taken.body.error).toMatchObject({
        code: 'ORG_GROUP_NAME_TAKEN',
        message: 'KPM ini sudah memiliki grup bernama “Mentoring Circle”.',
        details: { name: 'Mentoring Circle' },
      });
      const nobody = await http().post('/members/groups').set(...IN_INDONESIAN)
        .send({ name: 'Task Force', ownerMembershipId: new mongoose.Types.ObjectId().toString() }).expect(422);
      expect(nobody.body.error).toMatchObject({
        code: 'ORG_GROUP_OWNER_NOT_IN_KPM', message: 'Pilih pemilik grup dari anggota KPM ini.',
      });
    });

    it('P18.10-T5 AC-7 refuses the Core Leader tag on somebody who leads nobody by rung, in Indonesian', async () => {
      const res = await http().put(`/members/${agent}/core-leader`).set(...IN_INDONESIAN).send({ isCoreLeader: true })
        .expect(400);
      expect(res.body.error).toMatchObject({
        code: 'CORE_LEADER_NOT_A_LEADER',
        message: 'Hanya leader yang dapat menjadi Core Leader. Pindahkan dia ke jenjang leader terlebih dahulu.',
      });
    });
  });

  describe('who administers the office', () => {
    it('P18.10-T5 AC-7 refuses granting somebody not let in yet, granting twice and revoking nobody’s, in Indonesian', async () => {
      const waiting = await http().post(`/members/${pending}/admin`).set(...IN_INDONESIAN).expect(422);
      expect(waiting.body.error).toMatchObject({
        code: 'ORG_ADMIN_TARGET_NOT_ACTIVE', message: 'Dia belum bergabung dengan KPM ini.', details: { status: 'pending' },
      });
      await http().post(`/members/${aab}/admin`).expect(201);
      const twice = await http().post(`/members/${aab}/admin`).set(...IN_INDONESIAN).expect(409);
      expect(twice.body.error).toMatchObject({ code: 'ORG_ALREADY_ADMIN', message: 'Dia sudah mengelola KPM ini.' });
      const notOne = await http().delete(`/members/${agent}/admin`).set(...IN_INDONESIAN).expect(409);
      expect(notOne.body.error).toMatchObject({ code: 'ORG_NOT_AN_ADMIN', message: 'Dia tidak mengelola KPM ini.' });
    });
  });

  describe('a name the API has none for (AC-4)', () => {
    it('P18.10-T5 AC-4 writes it for the reader: one member, the tree, the role change log and a group’s owner', async () => {
      await http().post('/members/groups').send({ name: 'Mentoring Circle', ownerMembershipId: agent }).expect(201);
      await http().patch(`/members/${agent}/role`).send({ toRole: 'aab', reason: 'Siap memimpin' }).expect(200);
      await forget(agent);

      const one = (await http().get(`/members/${agent}`).set(...IN_INDONESIAN).expect(200)).body;
      expect([one.fullName, one.initials]).toEqual(['Tidak diketahui', 'TD']);
      const tree = (await http().get('/members/tree').set(...IN_INDONESIAN).expect(200)).body;
      expect(tree.nodes.find((n: { membershipId: string }) => n.membershipId === agent).fullName).toBe('Tidak diketahui');
      const log = (await http().get('/members/role-changes').set(...IN_INDONESIAN).expect(200)).body;
      expect(log[0]).toMatchObject({ membershipId: agent, fullName: 'Tidak diketahui', reason: 'Siap memimpin' });
      const groups = (await http().get('/members/groups').set(...IN_INDONESIAN).expect(200)).body;
      expect(groups[0].ownerName).toBe('Tidak diketahui');

      // An English screen reads the word it always read.
      expect((await http().get(`/members/${agent}`).expect(200)).body.fullName).toBe('Unknown');
      expect((await http().get('/members/groups').expect(200)).body[0].ownerName).toBe('Unknown');
    });
  });
});
