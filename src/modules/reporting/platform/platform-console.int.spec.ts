import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { NotFoundException } from '@/common/errors/domain.exception';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { ActivityLogRepository } from '@/modules/activity/activity-log.repository';
import { ActivityLog, ActivityLogSchema } from '@/modules/activity/activity-log.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { GroupRepository } from '@/modules/org/org.repositories';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import type { KpmAdminView } from '@/modules/tenants/tenant.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, OWNER, productionPipe, session, StubAuth,
} from '../../../../test/http-permissions';
import { listenOnLoopback } from '../../../../test/listen';
import { startMongo, stopMongo } from '../../../../test/mongo';
import { OfficeGroups } from '../office-groups';
import { PlatformConsoleController } from './platform-console.controller';
import { issuesOf, monthBefore, PlatformConsole } from './platform-console.service';

const NOW = new Date('2026-11-20T05:00:00Z');
const PRU = '66f0000000000000000002c1';
const SBL = '66f0000000000000000002c2';
const ALZ = '66f0000000000000000002c3';
const BSD = '66f0000000000000000002a1';
const MAGNI = '66f0000000000000000002a2';
const CEMPAKA = '66f0000000000000000002a3';
const GADING = '66f0000000000000000002a4';
const HOLD = '66f0000000000000000002a5';

const U = {
  WILSON: '66f00000000000000000bb01', AGUS: '66f00000000000000000bb02', SARI: '66f00000000000000000bb03',
  RINA: '66f00000000000000000bb04', BUDI: '66f00000000000000000bb05', TES: '66f00000000000000000bb06',
  NADIA: '66f00000000000000000bb07', HADI: '66f00000000000000000bb08', ROOT: '66f00000000000000000bb90',
} as const;
const M = {
  WILSON: '66f00000000000000000bc01', AGUS: '66f00000000000000000bc02', SARI: '66f00000000000000000bc03',
  RINA: '66f00000000000000000bc04', BUDI: '66f00000000000000000bc05', TES: '66f00000000000000000bc06',
  NADIA: '66f00000000000000000bc07', HADI: '66f00000000000000000bc08',
} as const;

const ROOT = RequestContext.platform(U.ROOT);
/** A support session: a Super Admin acting as the Owner. */
const SUPPORT = new RequestContext(OWNER.userId, 'none', OWNER.membership, U.ROOT, null, false, true);
const TENANT_ROLES = [['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]] as const;

/** A KPM as `TenantService.listAll` answers it: only the fields the console reads matter here. */
const office = (over: Partial<KpmAdminView> & Pick<KpmAdminView, '_id' | 'companyId' | 'companyName' | 'code' | 'branchName'>) => ({
  address: null, contactPhone: null, ownerUserId: null, ownerName: null, ownerEmail: null, timezone: 'Asia/Jakarta',
  locale: 'id', currency: 'IDR', fiscalYearStartMonth: 1, settings: {}, status: 'active', suspendedAt: null,
  suspendedReason: null, createdAt: '2026-01-05T00:00:00.000Z', subscription: null, leadersUsed: 0,
  subscriptionState: 'active', ownerState: 'active', ownerPhone: null, ownerInvitedAt: null, pendingOwner: null,
  memberCount: 1, membersBesidesOwner: 3, ...over,
}) as KpmAdminView;

const OFFICES: KpmAdminView[] = [
  office({ _id: BSD, companyId: PRU, companyName: 'Prudential', code: '0417', branchName: 'BSD City Branch',
    ownerUserId: U.WILSON, ownerName: 'Wilson Tanoto' }),
  office({ _id: MAGNI, companyId: PRU, companyName: 'Prudential', code: '1234', branchName: 'Magni',
    ownerUserId: U.NADIA, ownerName: 'Nadia Safitri', membersBesidesOwner: 0, createdAt: '2026-11-03T03:00:00.000Z' }),
  office({ _id: CEMPAKA, companyId: SBL, companyName: 'Sejahtera Baru Life', code: '0701', branchName: 'Cempaka Putih Branch',
    ownerUserId: U.HADI, ownerName: 'Hadi Gunawan', ownerState: 'not_invited' }),
  office({ _id: GADING, companyId: PRU, companyName: 'Prudential', code: '0555', branchName: 'Kelapa Gading Branch',
    subscriptionState: 'ended', ownerState: 'none' }),
  office({ _id: HOLD, companyId: PRU, companyName: 'Prudential', code: '0999', branchName: 'Suspended Branch', status: 'suspended' }),
];

/**
 * ***The console's Dashboard and a KPM's page* over HTTP** (P19.23-T1 AC-2 to AC-4, T2 AC-1, AC-4, AC-7; the Super
 * Admin spec of 20 November 2026 §3, §5; ADR-0277): the real guard, pipe, memberships, activity and groups over a
 * database of three companies and five KPMs — the summary, the funnel against last month, the tree's counts by class
 * (test accounts never), each KPM's issues, and one KPM's people. The Super Admin's alone.
 */
describe('P19.23-T1 the console’s Dashboard and a KPM’s page (ADR-0277)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const db = () => mongoose.connection.db!;
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const asSuperAdmin = () => { session.current = ROOT; };

  beforeAll(async () => {
    await startMongo();
    const model = <T>(name: string, schema: mongoose.Schema<T>) => mongoose.models[name] ?? mongoose.model(name, schema);
    const users = model(User.name, UserSchema);
    const companies = model(Company.name, CompanySchema);
    const requests = model(KpmRequest.name, KpmRequestSchema);
    const memberships = model(Membership.name, MembershipSchema);
    const logs = model(ActivityLog.name, ActivityLogSchema);
    const groups = model(Group.name, GroupSchema);

    await db().collection('companies').insertMany([
      { _id: oid(PRU), name: 'Prudential', slug: 'pru-console', deletedAt: null },
      { _id: oid(SBL), name: 'Sejahtera Baru Life', slug: 'sbl-console', deletedAt: null },
      { _id: oid(ALZ), name: 'Allianz Life', slug: 'alz-console', deletedAt: null },
    ]);
    const account = (id: string, fullName: string) => ({
      _id: oid(id), email: `${id}@contoh.test`, fullName, passwordHash: 'x', platformRole: 'none', status: 'active',
      createdAt: NOW, updatedAt: NOW, deletedAt: null,
    });
    await db().collection('users').insertMany([
      account(U.WILSON, 'Wilson Tanoto'), account(U.AGUS, 'Agus Prasetyo'), account(U.SARI, 'Sari Puspita'),
      account(U.RINA, 'Rina Wijaya'), account(U.BUDI, 'Budi Santoso'), account(U.TES, 'Tes Impor'),
      account(U.NADIA, 'Nadia Safitri'), account(U.HADI, 'Hadi Gunawan'),
    ]);
    const membership = (id: string, userId: string, kpmId: string, role: 'ab' | 'aab' | 'agent', over: Record<string, unknown> = {}) => ({
      _id: oid(id), kpmId, userId, agentCode: `A-${id.slice(-4)}`, leaderCode: `L-${id.slice(-4)}`, role,
      orgLevelCode: role.toUpperCase(), status: 'active', leaderId: null, ancestorIds: [], depth: 0, groupIds: [],
      testAccount: false, isCoreLeader: false, deletedAt: null, ...over,
    });
    await db().collection('memberships').insertMany([
      membership(M.WILSON, U.WILSON, BSD, 'ab'),
      membership(M.AGUS, U.AGUS, BSD, 'ab', { leaderId: M.WILSON, ancestorIds: [M.WILSON], depth: 1, isCoreLeader: true,
        adminAccess: { isKpmAdmin: true } }),
      membership(M.SARI, U.SARI, BSD, 'aab', { leaderId: M.AGUS, ancestorIds: [M.WILSON, M.AGUS], depth: 2 }),
      membership(M.RINA, U.RINA, BSD, 'agent', { leaderId: M.SARI, ancestorIds: [M.WILSON, M.AGUS, M.SARI], depth: 3 }),
      membership(M.BUDI, U.BUDI, BSD, 'agent', { leaderId: M.SARI, ancestorIds: [M.WILSON, M.AGUS, M.SARI], depth: 3 }),
      // A test account: never counted, never offered (ADR-0267 §1).
      membership(M.TES, U.TES, BSD, 'agent', { leaderId: M.SARI, testAccount: true }),
      membership(M.NADIA, U.NADIA, MAGNI, 'ab'),
      membership(M.HADI, U.HADI, CEMPAKA, 'ab'),
    ]);
    const day = (membershipId: string, kpmId: string, localDate: string) => ({
      kpmId, membershipId, localDate, entries: [], deletedAt: null, createdAt: NOW, updatedAt: NOW,
    });
    // Wilson: a power user (12 of the last 30 days). Sari: used 3 days ago. Rina: used 40 days ago. Budi: never.
    // Hadi: used 2 days ago. The test account: every day, never counted.
    const recent = Array.from({ length: 12 }, (_, i) => `2026-11-${String(20 - i).padStart(2, '0')}`);
    await db().collection('activityLogs').insertMany([
      ...recent.map((d) => day(M.WILSON, BSD, d)),
      day(M.SARI, BSD, '2026-11-17'),
      day(M.RINA, BSD, '2026-10-11'),
      day(M.HADI, CEMPAKA, '2026-11-18'),
      ...recent.map((d) => day(M.TES, BSD, d)),
    ]);
    await db().collection('kpmRequests').insertMany([
      { _id: new mongoose.Types.ObjectId(), status: 'pending', deletedAt: null, branchName: 'Surabaya Barat Branch' },
      { _id: new mongoose.Types.ObjectId(), status: 'approved', deletedAt: null, branchName: 'Bekasi Barat Branch' },
    ]);

    const tenants = {
      listAll: async () => OFFICES,
      readProfile: async (_ctx: unknown, id: string) => {
        const found = OFFICES.find((k) => k._id === id);
        if (!found) throw new NotFoundException('KPM');
        return found;
      },
    };
    const reads = {
      dataStatusAcrossTenants: async () => new Map([[CEMPAKA, { latestMonth: '2026-09', missingMonth: '2026-10' }]]),
    };
    const leaderLimit = { queue: async () => [{ status: 'pending' }, { status: 'approved' }] };
    const repo = new MembershipRepository(memberships as never);
    const activity = new ActivityReadings(new ActivityLogRepository(logs as never), null as never, null as never);
    const officeGroups = new OfficeGroups(new GroupRepository(groups as never), repo);
    const service = new PlatformConsole(
      companies as never, users as never, requests as never, tenants as never, reads as never, repo, activity,
      leaderLimit as never, officeGroups, new FixedClock(NOW),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformConsoleController],
      providers: [{ provide: PlatformConsole, useValue: service }],
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

  it('P19.23-T1 the routes declare the platform’s grants', () => {
    expect(declaredPermissions(PlatformConsoleController)).toEqual({
      dashboard: 'platform_metrics:read', people: 'kpm:read_profile',
    });
  });

  describe('P19.23-T1 AC-2 Keseluruhan and the funnel', () => {
    it('P19.23-T1 AC-2 counts KPMs, this month’s, the insurers, the active KPMs and their members by class', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/dashboard').expect(200);
      expect(res.body.asOf).toBe('2026-11-20');
      expect(res.body.comparedWith).toBe('2026-10-20');
      expect(res.body.scale).toEqual({ greenFromPct: 80, yellowFromPct: 50 });
      // Five live KPMs; Magni made this month; three insurers; BSD, Magni and Cempaka active (Gading ended, one
      // suspended); their members — BSD 5 (the test account left out), Magni 1, Cempaka 1 — 4 leaders, 3 agents.
      expect(res.body.overall).toEqual({ kpms: 5, kpmsNewThisMonth: 1, companies: 3, activeKpms: 3, leaders: 5, agents: 2 });
    });

    it('P19.23-T1 AC-2 Pernah pakai, Pakai 14 hari terakhir and Power user, now and a month ago — test accounts never', async () => {
      asSuperAdmin();
      const { funnel } = (await http().get('/admin/dashboard').expect(200)).body;
      expect(funnel.members).toBe(7);
      // Ever: Wilson, Sari, Rina, Hadi. A month ago (20 Oct): Wilson? no — Rina's 11 Oct only.
      expect(funnel.everUsed).toEqual({ count: 4, pct: 57, previousCount: 1, previousPct: 14 });
      // Within 14 days: Wilson, Sari, Hadi. On 20 Oct: Rina (9 days before).
      expect(funnel.used14).toEqual({ count: 3, pct: 43, previousCount: 1, previousPct: 14 });
      expect(funnel.powerUsers).toEqual({ count: 1, pct: 14, previousCount: 0, previousPct: 0 });
    });

    it('P19.23-T1 AC-3 counts the approvals waiting: KPM registrations and leaders past the limit', async () => {
      asSuperAdmin();
      expect((await http().get('/admin/dashboard').expect(200)).body.approvalsPending).toBe(2);
    });
  });

  describe('P19.23-T1 AC-4 Adopsi per KPM, and T2 AC-1 the KPM cards', () => {
    it('P19.23-T1 AC-4 lists every insurer, KPMs by company then name, each with its counts by class', async () => {
      asSuperAdmin();
      const res = await http().get('/admin/dashboard').expect(200);
      expect(res.body.companies.map((c: { name: string }) => c.name)).toEqual(['Allianz Life', 'Prudential', 'Sejahtera Baru Life']);
      expect(res.body.kpms.map((k: { name: string }) => k.name)).toEqual([
        'BSD City Branch', 'Kelapa Gading Branch', 'Magni', 'Suspended Branch', 'Cempaka Putih Branch',
      ]);
      const bsd = res.body.kpms.find((k: { kpmId: string }) => k.kpmId === BSD);
      expect(bsd).toMatchObject({ code: '0417', companyName: 'Prudential', active: true, ownerName: 'Wilson Tanoto', issues: [] });
      expect(bsd.usage).toEqual({
        leader: { members: 3, everUsed: 2, used14: 2, powerUsers: 1 },
        agent: { members: 2, everUsed: 1, used14: 0, powerUsers: 0 },
      });
    });

    it('P19.23-T2 AC-1 each KPM’s issues, in their order; a suspended KPM says only that', async () => {
      asSuperAdmin();
      const byId = new Map((await http().get('/admin/dashboard').expect(200)).body.kpms
        .map((k: { kpmId: string; issues: string[]; active: boolean }) => [k.kpmId, k]));
      expect(byId.get(MAGNI)).toMatchObject({ issues: ['no_members'], active: true });
      expect(byId.get(CEMPAKA)).toMatchObject({ issues: ['owner_not_invited', 'data_missing'], missingMonth: '2026-10' });
      expect(byId.get(GADING)).toMatchObject({ issues: ['subscription_ended', 'owner_not_invited'], active: false });
      expect(byId.get(HOLD)).toMatchObject({ issues: ['suspended'], active: false });
    });
  });

  describe('P19.23-T2 AC-4 a KPM’s page', () => {
    it('P19.23-T2 AC-4 the Owner, the Admins, the core leaders and the first members — test accounts never', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/tenants/${BSD}/people`).expect(200);
      expect(res.body.kpm).toEqual({
        kpmId: BSD, name: 'BSD City Branch', code: '0417', companyId: PRU, companyName: 'Prudential', status: 'active',
      });
      expect(res.body.owner).toMatchObject({ state: 'active', person: { userId: U.WILSON, fullName: 'Wilson Tanoto', class: 'ab' } });
      expect(res.body.admins.map((p: { fullName: string }) => p.fullName)).toEqual(['Agus Prasetyo']);
      expect(res.body.coreLeaders.map((p: { fullName: string }) => p.fullName)).toEqual(['Agus Prasetyo']);
      expect(res.body.members).toMatchObject({ total: 5, leaders: 3, agents: 2 });
      expect(res.body.members.first.map((p: { fullName: string; lastUsedDays: number | null; lastUsedStatus: string }) =>
        [p.fullName, p.lastUsedDays, p.lastUsedStatus])).toEqual([
        ['Agus Prasetyo', null, 'never'], ['Wilson Tanoto', 0, 'recent'], ['Sari Puspita', 3, 'recent'],
        ['Budi Santoso', null, 'never'], ['Rina Wijaya', 40, 'lapsed'],
      ]);
    });

    it('P19.23-T2 AC-7 Lihat sebagai offers the real people of each role, with their account ids', async () => {
      asSuperAdmin();
      const { viewAs } = (await http().get(`/admin/tenants/${BSD}/people`).expect(200)).body;
      const names = (list: { fullName: string }[]) => list.map((p) => p.fullName);
      expect(names(viewAs.owner)).toEqual(['Wilson Tanoto']);
      expect(names(viewAs.admin)).toEqual(['Agus Prasetyo']);
      expect(names(viewAs.ab)).toEqual(['Agus Prasetyo', 'Wilson Tanoto']);
      expect(names(viewAs.agent)).toEqual(['Budi Santoso', 'Rina Wijaya']);
      expect(viewAs.agent[0]).toEqual({ membershipId: M.BUDI, userId: U.BUDI, fullName: 'Budi Santoso', class: 'agent' });
    });

    it('P19.23-T2 AC-4 a KPM with no Owner and nobody in it: no Owner, no member, nobody to view as', async () => {
      asSuperAdmin();
      const res = await http().get(`/admin/tenants/${GADING}/people`).expect(200);
      expect(res.body.owner).toEqual({ state: 'none', person: null, pendingName: null });
      expect(res.body).toMatchObject({ admins: [], coreLeaders: [], members: { total: 0, leaders: 0, agents: 0, first: [] } });
      expect(res.body.viewAs).toEqual({ owner: [], admin: [], ab: [], agent: [] });
    });

    it('P19.23-T2 AC-4 an Owner whose only membership is a test account is no person on the page, and nobody to view as', async () => {
      asSuperAdmin();
      await db().collection('memberships').updateOne({ _id: oid(M.NADIA) }, { $set: { testAccount: true } });
      try {
        const res = await http().get(`/admin/tenants/${MAGNI}/people`).expect(200);
        expect(res.body.owner).toMatchObject({ state: 'active', person: null });
        expect(res.body.viewAs.owner).toEqual([]);
        expect(res.body.members.total).toBe(0);
      } finally {
        await db().collection('memberships').updateOne({ _id: oid(M.NADIA) }, { $set: { testAccount: false } });
      }
    });

    it('P19.23-T2 AC-4 the first members carry their informal group — an AB’s AB group follows them (ADR-0270 §1)', async () => {
      asSuperAdmin();
      const groupId = new mongoose.Types.ObjectId();
      await db().collection('groups').insertOne({
        _id: groupId, kpmId: BSD, name: 'Top Producers', leaderMembershipIds: [M.AGUS], status: 'active', archivedAt: null, deletedAt: null,
      });
      await db().collection('memberships').updateOne({ _id: oid(M.AGUS) }, { $set: { groupIds: [String(groupId)] } });
      try {
        const { first } = (await http().get(`/admin/tenants/${BSD}/people`).expect(200)).body.members;
        expect(first.map((p: { fullName: string; groupName: string | null }) => [p.fullName, p.groupName])).toEqual([
          ['Agus Prasetyo', 'Top Producers'], ['Wilson Tanoto', null], ['Sari Puspita', 'Top Producers'],
          ['Budi Santoso', 'Top Producers'], ['Rina Wijaya', 'Top Producers'],
        ]);
      } finally {
        await db().collection('memberships').updateOne({ _id: oid(M.AGUS) }, { $set: { groupIds: [] } });
        await db().collection('groups').deleteOne({ _id: groupId });
      }
    });

    it('P19.23-T2 AC-4 a member whose account is gone is still counted, with no name', async () => {
      asSuperAdmin();
      await db().collection('memberships').updateOne({ _id: oid(M.BUDI) }, { $set: { userId: '66f00000000000000000bbff' } });
      try {
        const { members } = (await http().get(`/admin/tenants/${BSD}/people`).expect(200)).body;
        expect(members.total).toBe(5);
        expect(members.first.find((p: { membershipId: string }) => p.membershipId === M.BUDI)).toMatchObject({ fullName: '', class: 'agent' });
      } finally {
        await db().collection('memberships').updateOne({ _id: oid(M.BUDI) }, { $set: { userId: U.BUDI } });
      }
    });

    it('P19.23-T2 AC-4 404 for a KPM that is not there, and for an id that is not one', async () => {
      asSuperAdmin();
      await http().get('/admin/tenants/66f0000000000000000002ff/people').expect(404);
      await http().get('/admin/tenants/not-an-id/people').expect(404);
    });
  });

  describe('P19.23-T1 the Super Admin’s alone', () => {
    it.each(TENANT_ROLES)('P19.23-T1 negative: %s is refused both reads', async (_who, ctx) => {
      session.current = ctx;
      await http().get('/admin/dashboard').expect(403);
      await http().get(`/admin/tenants/${BSD}/people`).expect(403);
    });

    it('P19.23-T1 negative: a support session is refused, its context being the member’s', async () => {
      session.current = SUPPORT;
      await http().get('/admin/dashboard').expect(403);
      await http().get(`/admin/tenants/${BSD}/people`).expect(403);
    });
  });
});

describe('P19.23-T1 the console’s rules', () => {
  it('P19.23-T1 AC-2 a month before is the same day, clamped to the month’s end', () => {
    expect(monthBefore('2026-11-20')).toBe('2026-10-20');
    expect(monthBefore('2026-03-31')).toBe('2026-02-28');
    expect(monthBefore('2026-01-15')).toBe('2025-12-15');
  });

  it('P19.23-T2 AC-1 issues: ended, owner, members, data — and a suspended or archived KPM only its state', () => {
    const kpm = { status: 'active' as const, ownerState: 'active' as const, membersBesidesOwner: 2 };
    expect(issuesOf(kpm, false, null)).toEqual([]);
    expect(issuesOf({ ...kpm, ownerState: 'none', membersBesidesOwner: 0 }, true, '2026-10'))
      .toEqual(['subscription_ended', 'owner_not_invited', 'no_members', 'data_missing']);
    expect(issuesOf({ ...kpm, ownerState: 'invited' }, false, null)).toEqual([]);
    expect(issuesOf({ ...kpm, status: 'suspended', ownerState: 'none' }, true, '2026-10')).toEqual(['suspended']);
    expect(issuesOf({ ...kpm, status: 'archived' }, false, null)).toEqual(['archived']);
  });
});
