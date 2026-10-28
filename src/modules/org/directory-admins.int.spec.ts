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
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { ADMIN, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { AdminDelegationService } from './admin-delegation.service';
import { DirectoryService } from './directory.service';
import { GroupService } from './group.service';
import { HierarchyService } from './hierarchy.service';
import { LeaderLimitRequestService } from './leader-limit-request.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OrgController } from './org.controller';
import { MembershipHistoryRepository } from './org.repositories';
import { OrgTreeService } from './org-tree.service';
import { RemovalService } from './removal.service';
import { RoleChangeService } from './role-change.service';

const NOW = new Date('2026-10-28T03:00:00Z');
/** A second office, whose members the first one's Owner must never reach. */
const KPM_B = '66f0000000000000000000b1';
/** That office's Owner. */
const OWNER_B = new RequestContext('u-owner-b', 'none', {
  membershipId: 'mem-b', kpmId: KPM_B, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
});

/**
 * **The roster's *Rejoined* and the admin grant's refusals, over HTTP** (P18.97-T4 AC-3, AC-5; ADR-0176 §5; the
 * client's UI-024 and UI-026).
 *
 * `org.tenancy.spec.ts` proves what `DirectoryService` and `AdminDelegationService` answer by calling them; a service
 * test cannot see a pipe, a guard or the error filter. What only a request can prove lives here: that `GET /members`
 * carries `rejoinedOn` through the controller, and that `POST /members/:membershipId/admin` refuses a removed
 * membership with `404` and a pending one with `422 ORG_ADMIN_TARGET_NOT_ACTIVE` — the refusals `/people/admins`
 * relies on when it offers only the office's active members.
 */
describe('the roster’s Rejoined and the admin grant, over HTTP (P18.97-T4)', () => {
  let app: INestApplication;
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let removals: RemovalService;
  let users: mongoose.Model<User>;
  let companyId: string;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const kpmModel = mongoose.model(Kpm.name, KpmSchema);
    users = mongoose.model(User.name, UserSchema);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const history = new MembershipHistoryRepository(
      mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never,
    );
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      kpmModel as never,
      audit,
      clock,
    );
    hierarchy = new HierarchyService(members, kpmModel as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined };
    const roles = new RoleChangeService(members, hierarchy, history, users as never, audit, notifications as never, clock);
    removals = new RemovalService(members, hierarchy, roles, history, audit, notifications as never, clock);

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController],
      providers: [
        { provide: DirectoryService, useValue: new DirectoryService(members, users as never, kpmModel as never) },
        {
          provide: AdminDelegationService,
          useValue: new AdminDelegationService(members, history, users as never, audit, notifications as never, clock),
        },
        // The roster's *Last activity* and *Last coached* are `directory-columns`' own spec's: passed through here.
        { provide: DirectoryColumns, useValue: { decorate: async (_ctx: unknown, page: unknown) => page } },
        // Routes this spec never calls.
        ...[RoleChangeService, RemovalService, OrgTreeService, GroupService, LeaderLimitRequestService]
          .map((provide) => ({ provide, useValue: {} })),
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

  async function person(fullName: string) {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: `${88000 + seq}`,
    });
    return String(u._id);
  }

  async function place(
    kpmId: string, userId: string, role: 'ab' | 'agent', leaderId: string | null, status: 'active' | 'pending' = 'active',
    joinDate?: string,
  ) {
    const ctx = kpmId === FIXTURE_KPM ? OWNER : OWNER_B;
    const m = await hierarchy.create(ctx, {
      userId, role, leaderId, status, ...(joinDate ? { joining: { joinDate } } : {}),
    });
    return String(m._id);
  }

  let root: string;
  let yantiFirst: string;
  let yantiBack: string;

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `prudential-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [id, code] of [[FIXTURE_KPM, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name).create({
        _id: id, companyId, code, branchName: `Branch ${code}`, counters: { nextMemberSeq: 1 }, status: 'active',
        timezone: 'Asia/Jakarta',
      });
    }
    root = await place(FIXTURE_KPM, await person('Wilson Tanoto'), 'ab', null);
    // Yanti, as 0417's seed holds her: joined, removed, and back a month later.
    const yanti = await person('Yanti Kusuma');
    yantiFirst = await place(FIXTURE_KPM, yanti, 'agent', root, 'active', '2026-08-29');
    await removals.remove(OWNER, yantiFirst, { confirmation: 'REMOVE' });
    yantiBack = await place(FIXTURE_KPM, yanti, 'agent', root, 'active', '2026-09-30');
  });

  describe('GET /members (P18.97-T4 AC-3)', () => {
    it('P18.97-T4 AC-3 marks the live membership that came back, and nobody else, in the Directory', async () => {
      const res = await request(app.getHttpServer()).get('/members').expect(200);
      const byId = new Map(res.body.members.map((m: { membershipId: string; rejoinedOn: string | null }) => [m.membershipId, m.rejoinedOn]));
      expect(byId.get(yantiBack)).toBe('2026-09-30');
      expect(byId.get(root)).toBeNull();
      expect(byId.has(yantiFirst)).toBe(false);
    });

    it('P18.97-T4 AC-3 gives the removed membership the day she came back, under Removed', async () => {
      const res = await request(app.getHttpServer()).get('/members?status=removed').expect(200);
      expect(res.body.members.map((m: { membershipId: string; rejoinedOn: string | null }) => [m.membershipId, m.rejoinedOn]))
        .toEqual([[yantiFirst, '2026-09-30']]);
      expect(res.body.counts).toMatchObject({ directory: 2, removed: 1 });
    });

    it('P18.97-T4 AC-3 answers another office’s Owner with none of it', async () => {
      session.current = OWNER_B;
      const res = await request(app.getHttpServer()).get('/members?status=removed').expect(200);
      expect(res.body.members).toEqual([]);
      await request(app.getHttpServer()).get(`/members/${yantiFirst}`).expect(404);
    });
  });

  describe('POST /members/:membershipId/admin (P18.97-T4 AC-5)', () => {
    it('P18.97-T4 AC-5 grants the active membership of a member who came back', async () => {
      // The Owner as a real person, since a grant records who made it by their account.
      const ownerRow = await members.findById(OWNER, root);
      session.current = new RequestContext(ownerRow!.userId, 'none', {
        membershipId: root, kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: 1,
      });
      const res = await request(app.getHttpServer()).post(`/members/${yantiBack}/admin`).expect(201);
      expect(res.body.map((a: { membershipId: string }) => a.membershipId)).toEqual([yantiBack]);
    });

    it('P18.97-T4 AC-5 refuses a removed membership with 404, and grants nothing', async () => {
      const res = await request(app.getHttpServer()).post(`/members/${yantiFirst}/admin`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect((await members.findById(OWNER, yantiFirst))!.adminAccess?.isKpmAdmin ?? false).toBe(false);
    });

    it('P18.97-T4 AC-5 refuses a pending membership with 422 ORG_ADMIN_TARGET_NOT_ACTIVE, and grants nothing', async () => {
      const waiting = await place(FIXTURE_KPM, await person('Fajar Nugroho'), 'agent', null, 'pending');
      const res = await request(app.getHttpServer()).post(`/members/${waiting}/admin`).expect(422);
      expect(res.body.error).toMatchObject({ code: 'ORG_ADMIN_TARGET_NOT_ACTIVE', details: { status: 'pending' } });
      expect((await members.findById(OWNER, waiting))!.adminAccess?.isKpmAdmin ?? false).toBe(false);
    });

    it('P18.97-T4 AC-5 refuses another office’s member with 404, never 403', async () => {
      const theirs = await place(KPM_B, await person('Dewi Lestari'), 'ab', null);
      const res = await request(app.getHttpServer()).post(`/members/${theirs}/admin`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('P18.97-T4 AC-5 refuses an Admin the grant itself: managing admins is the Owner’s', async () => {
      session.current = ADMIN;
      const res = await request(app.getHttpServer()).post(`/members/${yantiBack}/admin`).expect(403);
      expect(res.body.error.code).toBe('PERM_OWNER_ONLY');
    });
  });
});
