import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { ActivityLog, ActivityLogSchema } from '@/modules/activity/activity-log.schema';
import { ActivityLogRepository } from '@/modules/activity/activity-log.repository';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { DirectoryColumns } from '@/modules/reporting/directory-columns';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, seedLadder, startMongo, stopMongo } from '../../../test/mongo';
import { AdminDelegationService } from './admin-delegation.service';
import { CoachResolver } from './coach-resolver';
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

/**
 * 30 October 2026, 23:30 in Jakarta (16:30 UTC): late enough that the server's own UTC day is still the 30th, and
 * the office's is too — and `LATE` below is 00:30 on the 31st in Jakarta while UTC still says the 30th, which is the
 * boundary invariant §9 is about.
 */
const NOW = new Date('2026-10-30T16:30:00Z');
const LATE = new Date('2026-10-30T17:30:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

type Rung = 'AB' | 'AAB' | 'AGENT';

const as = (membershipId: string, rung: Rung, over: Record<string, unknown> = {}) => new RequestContext(
  `u-${membershipId}`, 'none', {
    membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1, ...over,
  } as never,
);

/**
 * **The Group Tree's *Hari ini*, over HTTP** (UI V1, Phase 18.11 T9; UI-059, O-5): `GET /members/tree` carries each
 * person's activity count for the office's today — the total Activity Management saved — and their photo.
 *
 * ```
 * WILSON (AB, root) ── AGUS (AB) ─┬── INDAH (agent)        5 today
 *                                 └── ARIEF (AAB) ── NOVI   nothing today, 4 yesterday
 * office B: B_AB, 9 today against Indah's id
 * ```
 */
describe('UI-059 GET /members/tree carries today’s activity count and the photo', () => {
  let app: INestApplication;
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let users: mongoose.Model<User>;
  let clock: FixedClock;
  let companyId: string;
  let seq = 0;
  let m: Record<'WILSON' | 'AGUS' | 'INDAH' | 'ARIEF' | 'NOVI' | 'B_AB', string>;

  beforeAll(async () => {
    await startMongo();
    clock = new FixedClock(NOW);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    users = mongoose.model(User.name, UserSchema) as never;
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      kpms as never,
      audit,
      clock,
    );
    hierarchy = new HierarchyService(
      members,
      kpms as never,
      users as never,
      new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
      clock,
      orgLevels,
    );
    const logs = new ActivityLogRepository(mongoose.model(ActivityLog.name, ActivityLogSchema) as never);
    // Only `perPersonPerDay` is read: the categories and types repositories stay unused.
    const readings = new ActivityReadings(logs, {} as never, {} as never);

    const moduleRef = await Test.createTestingModule({
      controllers: [OrgController],
      providers: [
        {
          provide: OrgTreeService,
          useValue: new OrgTreeService(
            members, users as never, readings, new TenantDay(kpms as never, clock),
            // UI-111: the stored photo is a storage key, signed into a link per read; here a link the test can read.
            { linksFor: async (keys: (string | null | undefined)[]) =>
              new Map(keys.filter((k): k is string => !!k).map((k) => [k, `https://signed.test/${k}`])) } as never,
          ),
        },
        { provide: getModelToken(User.name), useValue: users },
        { provide: MembershipRepository, useValue: members },
        { provide: AuditService, useValue: audit },
        ...[
          DirectoryService, CoachResolver, RoleChangeService, RemovalService, GroupService, AdminDelegationService,
          DirectoryColumns, LeaderLimitRequestService,
        ].map((provide) => ({ provide, useValue: {} })),
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

  beforeEach(async () => {
    clock.set(NOW);
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [id, code] of [[KPM_A, '0417'], [KPM_B, '0555']]) {
      await mongoose.model(Kpm.name).create({
        _id: id, companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
    }
    const wilson = await join(KPM_A, 'ab', null, 'Wilson Tanoto', 'https://cdn.test/wilson.jpg');
    const agus = await join(KPM_A, 'ab', wilson, 'Agus Prasetyo');
    const arief = await join(KPM_A, 'aab', agus, 'Arief Hidayat');
    m = {
      WILSON: wilson,
      AGUS: agus,
      INDAH: await join(KPM_A, 'agent', agus, 'Indah Permatasari', 'https://cdn.test/indah.jpg'),
      ARIEF: arief,
      NOVI: await join(KPM_A, 'agent', arief, 'Novi Andriani'),
      B_AB: await join(KPM_B, 'ab', null, 'Budi Hartono'),
    };
    for (const id of [m.AGUS, m.ARIEF]) await hierarchy.refreshCounts(as(m.WILSON, 'AB', { isKpmOwner: true }), id);
    await mongoose.connection.db!.collection('activityLogs').insertMany([
      day(KPM_A, m.INDAH, '2026-10-30', 5),
      day(KPM_A, m.NOVI, '2026-10-29', 4),
      day(KPM_A, m.ARIEF, '2026-10-31', 2),
      // Another office's row against Indah's id: never hers.
      day(KPM_B, m.INDAH, '2026-10-30', 9),
    ] as never);
  });

  async function join(kpmId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null, fullName: string, avatarUrl: string | null = null) {
    seq += 1;
    const user = await users.create({
      email: `t${seq}@kpm.test`, passwordHash: 'x', fullName, status: 'active', platformRole: 'none', companyId,
      agentCode: `${77_000 + seq}`, avatarUrl,
    });
    const placed = await hierarchy.create(as('mem-placer', 'AB', { kpmId, isKpmOwner: true }), {
      userId: String(user._id), role, leaderId, status: 'active',
    });
    return String(placed._id);
  }

  function day(kpmId: string, membershipId: string, localDate: string, total: number) {
    return {
      kpmId, membershipId, localDate, deletedAt: null, source: 'self', enteredByMembershipId: membershipId, version: 1,
      frozenAt: null, corrections: [], entries: [{ activityTypeId: 't-1', activityTypeCode: 'LEADS_CONTACTED', count: total }],
      totalCount: total,
    };
  }

  const tree = () => request(app.getHttpServer()).get('/members/tree').expect(200);
  const nodeOf = (body: { nodes: { membershipId: string; todayActivityCount: number; photoUrl: string | null }[] }, id: string) =>
    body.nodes.find((n) => n.membershipId === id)!;

  it('UI-059 each person in the tree carries their count for the office’s today, and 0 where nothing was logged', async () => {
    session.current = as(m.AGUS, 'AB');
    const { body } = await tree();

    expect(nodeOf(body, m.INDAH).todayActivityCount).toBe(5);
    // Novi logged yesterday, not today; Agus logged nothing.
    expect(nodeOf(body, m.NOVI).todayActivityCount).toBe(0);
    expect(nodeOf(body, m.AGUS).todayActivityCount).toBe(0);
  });

  it('UI-059 “today” is the office’s day: past midnight in Jakarta the 31st counts, while UTC still says the 30th', async () => {
    clock.set(LATE);
    session.current = as(m.AGUS, 'AB');
    const { body } = await tree();

    expect(nodeOf(body, m.ARIEF).todayActivityCount).toBe(2);
    expect(nodeOf(body, m.INDAH).todayActivityCount).toBe(0);
  });

  it('UI-059 carries each photo in the tree; the upline’s card stays at its four fields, no photo and no count', async () => {
    session.current = as(m.AGUS, 'AB');
    const { body } = await tree();

    // UI-111: the stored key, signed into a link — never the key itself.
    expect(nodeOf(body, m.INDAH).photoUrl).toBe('https://signed.test/https://cdn.test/indah.jpg');
    expect(nodeOf(body, m.NOVI).photoUrl).toBeNull();
    // The registered exception to "your downline only" is bounded (`multi-tenancy-and-scoping.md`): Wilson has a
    // photo, and the card does not carry it.
    expect(body.leader).toEqual({ membershipId: m.WILSON, fullName: 'Wilson Tanoto', initials: 'WT', role: 'ab' });
  });

  it('UI-059 never counts another office’s log, and an AAB reads only their own unit’s counts', async () => {
    session.current = as(m.ARIEF, 'AAB');
    const { body } = await tree();

    expect(body.nodes.map((n: { membershipId: string }) => n.membershipId).sort()).toEqual([m.ARIEF, m.NOVI].sort());
    expect(nodeOf(body, m.NOVI).todayActivityCount).toBe(0);

    session.current = as(m.B_AB, 'AB', { kpmId: KPM_B });
    const other = await tree();
    // Office B's tree holds B's root alone; Indah's id with B's 9 is not a member there.
    expect(other.body.nodes.map((n: { membershipId: string }) => n.membershipId)).toEqual([m.B_AB]);
    expect(nodeOf(other.body, m.B_AB).todayActivityCount).toBe(0);
  });
});
