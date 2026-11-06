import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AdminDelegationService } from '@/modules/org/admin-delegation.service';
import { DirectoryService } from '@/modules/org/directory.service';
import { GroupService } from '@/modules/org/group.service';
import { LeaderLimitRequestService } from '@/modules/org/leader-limit-request.service';
import { OrgController } from '@/modules/org/org.controller';
import { OrgTreeService } from '@/modules/org/org-tree.service';
import { RemovalService } from '@/modules/org/removal.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { byKode } from '@/modules/production/upload-columns';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { UnitDashboardController } from '@/modules/unit-dashboard/unit-dashboard.controller';
import { UnitDashboardService } from '@/modules/unit-dashboard/unit-dashboard.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { KPM_A, KPM_B, ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../test/reporting-office';
import { DirectoryColumns } from './directory-columns';
import type { AnalyticsLeader, KpmAnalyticsView } from './kpm-analytics.service';
import { needsAttentionFirst } from './kpm-analytics.service';
import { KpmAnalyticsService } from './kpm-analytics.service';
import { KpmAnalyticsController } from './reporting.controller';

const M = 1_000_000 * 100;

/**
 * **KPM Analytics' every leader, the read-only views and the group filter** (P19.3-T3; UI-152 and its Appendix D row,
 * the KPM Overview flow report's R5 and cases 11 to 13, OWN R1 and R2, UI-091, UI-094), over HTTP with the real
 * `PermissionsGuard`, the production pipe and the real services over `test/reporting-office.ts`:
 *
 * ```
 * OWNER Wilson (AB, the root) ─┬─ ADMIN Maya (AB, leading nobody)
 *                              ├─ AGUS (AB) ─┬─ INDAH, DIMAS (his direct agents), LUKAS (an agent leading TARI)
 *                              │             ├─ SARI (AAB) ─┬─ RINA, BUDI
 *                              │             │              └─ NINA (AAB) ── DODI
 *                              │             └─ DEWI (AAB, leading nobody)
 *                              └─ PEER_AB (AB) ── PEER_AAB (AAB) ── PEER_AGENT
 * Office B: B_AB ── B_AGENT
 * ```
 *
 * Eight leaders, four AB and four AAB. Agus's Group is eleven — him and everybody below him — and his Unit three: him,
 * Indah and Dimas (Lukas leads Tari). The Owner's Group is the office's sixteen.
 */
describe('KPM Analytics — every leader, the read-only views, the group filter (P19.3-T3)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;
  const db = () => mongoose.connection.db!;
  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  /** `who` once tagged *Core Leader*, as `ContextResolver` resolves the effective flag (ADR-0159 §1). */
  const tagged = (who: Who): RequestContext => {
    const base = office.as(who);
    return new RequestContext(base.userId, 'none', { ...base.membership!, isCoreLeader: true });
  };
  const analytics = async (query: Record<string, string> = {}) =>
    (await http().get('/kpm/analytics').query(query).expect(200)).body as KpmAnalyticsView;
  const leaderOf = (view: KpmAnalyticsView, who: Who) => view.leaders.find((l) => l.head.membershipId === office.id[who])!;
  const auditCount = () => db().collection('auditLog').countDocuments({});
  let coreLeader: string;
  let archived: string;
  let ofB: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildReportingOffice(wired);

    // The office's custom groups (*All members → Groups*): *Core Leader* of three, an archived one, and 0555's.
    const group = async (kpmId: string, name: string, status: 'active' | 'archived', members: Who[]) => {
      const { insertedId } = await db().collection('groups').insertOne({
        kpmId, name, ownerMembershipId: office.id.OWNER, status, archivedAt: status === 'archived' ? ROSTER_NOW : null,
        createdByMembershipId: null, deletedAt: null, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
      const id = String(insertedId);
      await db().collection('memberships').updateMany(
        { _id: { $in: members.map((who) => new mongoose.Types.ObjectId(office.id[who])) } }, { $push: { groupIds: id } } as never,
      );
      return id;
    };
    coreLeader = await group(KPM_A, 'Core Leader', 'active', ['AGUS', 'SARI', 'INDAH']);
    archived = await group(KPM_A, 'Old circle', 'archived', ['DIMAS']);
    ofB = await group(KPM_B, 'Lina’s circle', 'active', ['B_AB']);
    // A leaver tagged with the group counts in none of its figures (ADR-0204 §4).
    await db().collection('memberships').updateOne(
      { _id: new mongoose.Types.ObjectId(office.id.LEFT) }, { $push: { groupIds: coreLeader } } as never,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [KpmAnalyticsController, OrgController, UnitDashboardController],
      providers: [
        { provide: KpmAnalyticsService, useValue: wired.kpmAnalytics },
        { provide: UnitDashboardService, useValue: wired.unitDashboard },
        { provide: OrgTreeService, useValue: new OrgTreeService(wired.memberships, wired.users as never) },
        // Routes this spec never calls; a bare object keeps Nest from building their graphs.
        ...[DirectoryService, RoleChangeService, RemovalService, GroupService, AdminDelegationService, DirectoryColumns,
          LeaderLimitRequestService].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  describe('P19.3-T3 AC-1 — the Leader list: every AB and AAB', () => {
    it('P19.3-T3 AC-1 lists the eight leaders, four AB and four AAB, an AAB who leads nobody included', async () => {
      as('OWNER');
      const view = await analytics();
      const names = (role: 'ab' | 'aab') => view.leaders.filter((l) => l.role === role).map((l) => l.head.name).sort();
      expect(names('ab')).toEqual(['Agus Salim', 'Hendra Gunawan', 'Maya Kusuma', 'Wilson Tanoto']);
      expect(names('aab')).toEqual(['Dewi Lestari', 'Nina Lestari', 'Putu Ayu', 'Sari Puspita']);
      // No agent is a leader of this list, Lukas who leads Tari included (Q2: the class, not the graph).
      expect(view.leaders.map((l) => l.head.membershipId)).not.toContain(office.id.LUKAS);
      expect(leaderOf(view, 'DEWI')).toMatchObject({ role: 'aab', group: 1, unit: 1, head: { leads: false } });
    });

    it('P19.3-T3 AC-1 sorts “↓ Perlu perhatian dulu”: the lowest APE % first, a leader with no % last, A to Z among them', async () => {
      as('OWNER');
      const { leaders } = await analytics();
      const pcts = leaders.map((l) => l.apeMonth.pct);
      const firstNull = pcts.indexOf(null);
      const held = pcts.slice(0, firstNull === -1 ? undefined : firstNull) as number[];
      expect(held.length).toBeGreaterThan(0);
      expect(held).toEqual([...held].sort((a, b) => a - b));
      if (firstNull !== -1) {
        expect(pcts.slice(firstNull).every((p) => p === null)).toBe(true);
        const tail = leaders.slice(firstNull).map((l) => l.head.name);
        expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)));
      }
    });

    it('P19.3-T3 AC-1 the order, as a rule: nulls last, ties by name', () => {
      const names = new Map([['a', 'Ani'], ['b', 'Budi'], ['c', 'Citra'], ['d', 'Dewi']]);
      const row = (id: string, pct: number | null) => ({ head: { membershipId: id }, apeMonth: { pct } }) as unknown as AnalyticsLeader;
      const sorted = [row('d', null), row('c', 50), row('b', null), row('a', 50), row('x', 4)].sort(needsAttentionFirst(names));
      expect(sorted.map((l) => l.head.membershipId)).toEqual(['x', 'a', 'c', 'b', 'd']);
    });
  });

  describe('P19.3-T3 AC-2 — each leader’s figures, over their Group', () => {
    it('P19.3-T3 AC-2 Agus: Group 11, Unit 3 (him, Indah, Dimas), the leader above, Active split Unit / AAB adding up', async () => {
      as('OWNER');
      const agus = leaderOf(await analytics(), 'AGUS');
      expect(agus).toMatchObject({
        role: 'ab', group: 11, unit: 3, above: { membershipId: office.id.OWNER, name: 'Wilson Tanoto' },
        manpower: { ab: 1, aab: 3, agents: 7, total: 11 }, coached7d: { of: 11 },
      });
      const { active } = agus;
      expect(active.of).toBe(11);
      expect([active.unit.of, active.aab.of]).toEqual([3, 8]);
      expect(active.count).not.toBeNull();
      expect(active.unit.count! + active.aab.count!).toBe(active.count);
    });

    it('P19.3-T3 AC-2 Sari, an AAB: above her Agus, no club, her MOC on her own rule, her Group of five and Unit of three', async () => {
      as('OWNER');
      const sari = leaderOf(await analytics(), 'SARI');
      expect(sari).toMatchObject({ role: 'aab', group: 5, unit: 3, club: null, above: { name: 'Agus Salim' } });
      expect(sari.moc).not.toBeNull();
      // An AB's club is their agency's (Q9); the Owner's row reads the same club the agency row does.
      const view = await analytics();
      for (const ab of view.leaders.filter((l) => l.role === 'ab')) {
        expect(ab.club).toEqual(view.agencies.find((a) => a.head.membershipId === ab.head.membershipId)!.club);
      }
    });

    it('P19.3-T3 AC-2 the root reads no leader above (—)', async () => {
      as('OWNER');
      expect(leaderOf(await analytics(), 'OWNER').above).toBeNull();
    });
  });

  describe('P19.3-T3 AC-4, AC-5, AC-6 — the totals, one production total, one team size', () => {
    it('P19.3-T3 AC-4 the Manpower tile’s “n leader · n agent”: its AB and AAB are the Leader list, the rest agents', async () => {
      as('OWNER');
      const { total, leaders } = await analytics();
      expect(total.manpower.ab + total.manpower.aab).toBe(leaders.length);
      expect(total.manpower).toEqual({ ab: 4, aab: 4, agents: 8, total: 16 });
      expect(Object.keys(total)).not.toContain('leaversExcludedMinor');
    });

    it('P19.3-T3 AC-5 one production total: a leaver’s year to date stays in the KPM’s total, the rows count today’s members', async () => {
      // Yanti's case (OWN case 10): somebody who left this year with production on file.
      const { insertedId } = await db().collection('memberships').insertOne({
        kpmId: KPM_A, userId: String(new mongoose.Types.ObjectId()), agentCode: 'PRU-79999', agentSeq: 999, leaderCode: 'GONE9999',
        orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: office.id.AGUS,
        ancestorIds: [office.id.OWNER, office.id.AGUS], depth: 2, status: 'removed', joinedAt: new Date('2026-01-05T03:00:00Z'),
        removedAt: new Date('2026-07-10T03:00:00Z'), deletedAt: null, groupIds: [],
      });
      const yanti = String(insertedId);
      // Her year to date is the sum of her months held (P19.5-T2): January's 262 M and June's 40 M, the 302 M the file's
      // year to date said.
      const imported = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
      await db().collection('monthlyAgentData').insertMany([
        { kpmId: KPM_A, membershipId: yanti, month: '2026-01', agentCode: 'PRU-79999', deletedAt: null, ...byKode({ apeMonthly: imported(262 * M) }) },
        {
          kpmId: KPM_A, membershipId: yanti, month: '2026-06', agentCode: 'PRU-79999', deletedAt: null,
          ...byKode({ apeMonthly: imported(40 * M), apeYtd: imported(302 * M) }),
        },
      ]);
      try {
        as('OWNER');
        const view = await analytics();
        const rows = view.agencies.reduce((n, a) => n + (a.apeAnnual.achievedMinor ?? 0), 0);
        expect(view.total.apeAnnual.achievedMinor).toBe(rows + 302 * M);
        // She counts in no count of people.
        expect(view.total.manpower.total).toBe(16);
        // Over a group, its members' alone — and she is in none.
        const inGroup = await analytics({ group: coreLeader });
        expect(inGroup.total.apeAnnual.achievedMinor).not.toBe(view.total.apeAnnual.achievedMinor);
      } finally {
        await db().collection('memberships').deleteOne({ _id: insertedId });
        await db().collection('monthlyAgentData').deleteMany({ membershipId: yanti });
      }
    });

    it('P19.3-T3 AC-6 Agus’s Group is the Unit Dashboard’s team for him; the Owner’s row counts the office', async () => {
      as('OWNER');
      const view = await analytics();
      const dashboard = (await http().get('/unit/dashboard').query({ for: office.id.AGUS }).expect(200)).body;
      expect(leaderOf(view, 'AGUS').group).toBe(dashboard.tiles.team.total);
      expect(leaderOf(view, 'AGUS').unit).toBe(dashboard.tiles.team.direct);
      expect(leaderOf(view, 'OWNER').group).toBe(view.total.manpower.total);
    });

    it('P19.3-T3 AC-10 every AAB counts in the split, Dewi who leads nobody included', async () => {
      as('OWNER');
      const view = await analytics();
      // Agus's Group: Sari, Nina and Dewi.
      expect(leaderOf(view, 'AGUS').manpower.aab).toBe(3);
      // And the agency's own (Direct) row, where Dewi stands: one AAB.
      const agency = view.agencies.find((a) => a.head.membershipId === office.id.AGUS)!;
      expect(agency.direct.manpower).toMatchObject({ aab: 1 });
    });
  });

  describe('P19.3-T3 AC-3 — the Unit Dashboard and the Group Tree, read-only, as the leader sees them', () => {
    it.each(['OWNER', 'ADMIN'] as const)('P19.3-T3 AC-3 %s reads Agus’s Unit Dashboard read-only: no save offered', async (who) => {
      as(who);
      const view = (await http().get('/unit/dashboard').query({ for: office.id.AGUS }).expect(200)).body;
      expect(view).toMatchObject({ readOnly: true, head: { membershipId: office.id.AGUS, isReader: false }, production: { canUpdate: false } });
    });

    it('P19.3-T3 AC-3 a leader reading a unit below their own keeps their writes; their own dashboard is never read-only', async () => {
      as('AGUS');
      const below = (await http().get('/unit/dashboard').query({ for: office.id.SARI }).expect(200)).body;
      expect(below).toMatchObject({ readOnly: false, production: { canUpdate: true } });
      as('OWNER');
      expect((await http().get('/unit/dashboard').expect(200)).body).toMatchObject({ readOnly: false });
    });

    it.each(['OWNER', 'ADMIN'] as const)('P19.3-T3 AC-3 the server refuses %s’s save naming that unit (403), and writes nothing', async (who) => {
      as(who);
      const state = (await http().get('/unit/dashboard').query({ for: office.id.AGUS }).expect(200)).body.production;
      const before = await db().collection('monthlyAgentData').find({ membershipId: office.id.INDAH }).toArray();
      const audit = await auditCount();
      const res = await http().patch('/unit/dashboard/production').send({
        month: state.month, revision: state.revision, for: office.id.AGUS,
        rows: [{ membershipId: office.id.INDAH, apeMonthlyMinor: 999 * M }],
      }).expect(403);
      expect(res.body.error).toMatchObject({
        code: 'PERM_DENIED', details: { permission: 'unit_dashboard:update_production', readOnly: true, for: office.id.AGUS },
      });
      expect(await db().collection('monthlyAgentData').find({ membershipId: office.id.INDAH }).toArray()).toEqual(before);
      expect(await auditCount()).toBe(audit);
    });

    it('P19.3-T3 AC-3 an AB’s save naming a unit below them passes that check, and is checked as before', async () => {
      as('AGUS');
      const state = (await http().get('/unit/dashboard').query({ for: office.id.SARI }).expect(200)).body.production;
      // Peer's agent: outside his unit — the reach check answers, never the read-only one.
      const res = await http().patch('/unit/dashboard/production').send({
        month: state.month, revision: state.revision, for: office.id.SARI,
        rows: [{ membershipId: office.id.PEER_AGENT, apeMonthlyMinor: 1 * M }],
      }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it.each(['OWNER', 'ADMIN'] as const)('P19.3-T3 AC-3 %s reads Sari’s Group Tree as she sees it: her, her unit, her leader above', async (who) => {
      as(who);
      const audit = await auditCount();
      const tree = (await http().get('/members/tree').query({ for: office.id.SARI }).expect(200)).body;
      expect(tree.nodes.map((n: { fullName: string }) => n.fullName).sort())
        .toEqual(['Budi Santoso', 'Dodi Kurniawan', 'Nina Lestari', 'Rina Wijaya', 'Sari Puspita']);
      expect(tree).toMatchObject({ selfId: office.id.SARI, rootIds: [office.id.SARI], leader: { membershipId: office.id.AGUS } });
      expect(tree.nodes.find((n: { isSelf: boolean }) => n.isSelf)).toMatchObject({ membershipId: office.id.SARI, layer: 1 });
      // The counts are below her, as her own read counts them.
      expect(tree.counts).toEqual({ ab: 0, aab: 1, agent: 3, total: 4 });
      expect(await auditCount()).toBe(audit);
    });

    it('P19.3-T3 AC-3 the leader’s own read and the office’s read of it are the same tree', async () => {
      as('SARI');
      const own = (await http().get('/members/tree').expect(200)).body;
      as('OWNER');
      const read = (await http().get('/members/tree').query({ for: office.id.SARI }).expect(200)).body;
      const shape = (t: { nodes: { membershipId: string; layer: number; isSelf: boolean }[]; leader: unknown; counts: unknown }) => ({
        nodes: t.nodes.map((n) => [n.membershipId, n.layer, n.isSelf]), leader: t.leader, counts: t.counts,
      });
      expect(shape(read)).toEqual(shape(own));
    });
  });

  describe('P19.3-T3 AC-16 — who reads what (positive and negative, per role)', () => {
    it.each(['OWNER', 'ADMIN'] as const)('P19.3-T3 AC-16 positive: %s reads the leaders', async (who) => {
      as(who);
      expect((await analytics()).leaders).toHaveLength(8);
    });

    it.each(['AGUS', 'SARI'] as const)('P19.3-T3 AC-16 positive: %s, a Core Leader, reads the same leaders', async (who) => {
      as('OWNER');
      const owners = await analytics();
      session.current = tagged(who);
      const theirs = await analytics();
      expect(theirs.leaders.map((l) => [l.head.membershipId, l.group, l.apeMonth])).toEqual(owners.leaders.map((l) => [l.head.membershipId, l.group, l.apeMonth]));
      expect(leaderOf(theirs, who).head.isReader).toBe(true);
    });

    it('P19.3-T3 AC-16 negative: an AB who is not a Core Leader is 404; an Agent 403; a Super Admin outside a session 403', async () => {
      as('PEER_AB');
      expect((await http().get('/kpm/analytics').expect(404)).body.error.code).toBe('NOT_FOUND');
      as('INDAH');
      expect((await http().get('/kpm/analytics').expect(403)).body.error.details).toEqual({ permission: 'kpm_analytics:read' });
      session.current = SUPER_ADMIN;
      expect((await http().get('/kpm/analytics').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P19.3-T3 AC-3 the list says whose views the reader may open: the Owner every leader’s, a Core Leader their own and below', async () => {
      as('OWNER');
      expect((await analytics()).leaders.every((l) => l.opens)).toBe(true);
      session.current = tagged('AGUS');
      const opened = (await analytics()).leaders.filter((l) => l.opens).map((l) => l.head.name).sort();
      expect(opened).toEqual(['Agus Salim', 'Dewi Lestari', 'Nina Lestari', 'Sari Puspita']);
    });

    it('P19.3-T3 AC-16 a Core Leader follows the views within their own reach, and gets 404 outside it', async () => {
      session.current = tagged('AGUS');
      expect((await http().get('/members/tree').query({ for: office.id.SARI }).expect(200)).body.selfId).toBe(office.id.SARI);
      expect((await http().get('/unit/dashboard').query({ for: office.id.SARI }).expect(200)).body.readOnly).toBe(false);
      for (const outside of [office.id.PEER_AB, office.id.PEER_AAB, office.id.OWNER]) {
        expect((await http().get('/members/tree').query({ for: outside }).expect(404)).body.error.code).toBe('NOT_FOUND');
        expect((await http().get('/unit/dashboard').query({ for: outside }).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      // An AAB reaches her own downline, never above her.
      session.current = tagged('SARI');
      expect((await http().get('/members/tree').query({ for: office.id.NINA }).expect(200)).body.selfId).toBe(office.id.NINA);
      expect((await http().get('/members/tree').query({ for: office.id.AGUS }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.3-T3 AC-16 negative: an Agent naming another tree is refused 403; their own tree is still theirs', async () => {
      as('INDAH');
      const res = await http().get('/members/tree').query({ for: office.id.AGUS }).expect(403);
      expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'org_tree:read' } });
      expect((await http().get('/members/tree').query({ for: office.id.INDAH }).expect(200)).body.selfId).toBe(office.id.INDAH);
    });

    it('P19.3-T3 AC-16 cross-tenant and gone: another office’s member, a leaver and a malformed id are 404 alike; another name is 400', async () => {
      as('OWNER');
      for (const id of [office.id.B_AB, office.id.LEFT, 'not-an-id', String(new mongoose.Types.ObjectId())]) {
        expect((await http().get('/members/tree').query({ for: id }).expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      expect((await http().get('/unit/dashboard').query({ for: office.id.B_AB }).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await http().get('/members/tree').query({ of: office.id.SARI }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19.3-T3 AC-16 0555’s Owner reads 0555’s leaders alone', async () => {
      session.current = office.ownerOfB();
      const view = await analytics();
      expect(view.leaders.map((l) => l.head.membershipId)).toEqual([office.id.B_AB]);
      expect(view.groups.map((g) => g.name)).toEqual(['Lina’s circle']);
    });
  });

  describe('P19.3-T3 AC-15 — Lihat untuk: a custom group (OD-258)', () => {
    it('P19.3-T3 AC-15 offers the office’s active groups with their members today, never an archived one', async () => {
      as('OWNER');
      const view = await analytics();
      expect(view.groups).toEqual([{ groupId: coreLeader, name: 'Core Leader', memberCount: 3 }]);
      expect(view.group).toBeNull();
      // *Seluruh KPM · 16 orang*, read the same over a group.
      expect(view.officePeople).toBe(16);
      expect((await analytics({ group: coreLeader })).officePeople).toBe(16);
    });

    it('P19.3-T3 AC-15 (Overview case 13) with Core Leader, only its three count: the tiles, the leaders, the chart', async () => {
      as('OWNER');
      const whole = await analytics();
      const view = await analytics({ group: coreLeader });
      expect(view.group).toEqual({ groupId: coreLeader, name: 'Core Leader', memberCount: 3 });
      expect(view.total.manpower).toEqual({ ab: 1, aab: 1, agents: 1, total: 3 });
      expect(view.total.coached7d.of).toBe(3);
      // The leaders in the group, each over the group's people below them.
      expect(view.leaders.map((l) => l.head.name).sort()).toEqual(['Agus Salim', 'Sari Puspita']);
      expect(leaderOf(view, 'AGUS')).toMatchObject({ group: 3, unit: 2, above: { name: 'Wilson Tanoto' } });
      expect(leaderOf(view, 'SARI')).toMatchObject({ group: 1, unit: 1 });
      // The chart is the group's own production, never the office's.
      const september = (v: KpmAnalyticsView) => v.monthly.at(-1)!.apeMinor;
      expect(september(view)).not.toBe(september(whole));
      const file = await db().collection('monthlyAgentData')
        .find({ month: '2026-09', membershipId: { $in: [office.id.AGUS, office.id.SARI, office.id.INDAH] } }).toArray();
      expect(september(view)).toBe(file.reduce((n, r) => n + (r.values?.APE?.value ?? 0), 0));
      // The period moves the group's month, as the office's.
      expect((await analytics({ group: coreLeader, period: 'previous_month' })).group!.name).toBe('Core Leader');
    });

    it('P19.3-T3 AC-15 a Core Leader may name a group too, and reads it within the whole office', async () => {
      session.current = tagged('SARI');
      expect((await analytics({ group: coreLeader })).total.manpower.total).toBe(3);
    });

    it('P19.3-T3 AC-15 another office’s group, an archived one, an unknown or malformed id are 404; an over-long one 400', async () => {
      as('OWNER');
      for (const id of [ofB, archived, String(new mongoose.Types.ObjectId()), 'nope']) {
        const res = await http().get('/kpm/analytics').query({ group: id }).expect(404);
        expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Group not found.' });
      }
      expect((await http().get('/kpm/analytics').query({ group: 'x'.repeat(65) }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      // And 0555's Owner cannot read 0417's.
      session.current = office.ownerOfB();
      expect((await http().get('/kpm/analytics').query({ group: coreLeader }).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.3-T3 AC-15 the filter records nothing and writes nothing', async () => {
      as('OWNER');
      const audit = await auditCount();
      await analytics({ group: coreLeader });
      expect(await auditCount()).toBe(audit);
    });

    it('P19.3-T3 AC-15 an active group whose only member has left is still offered, at 0 people', async () => {
      as('OWNER');
      const { insertedId } = await db().collection('groups').insertOne({
        kpmId: KPM_A, name: 'Kosong', ownerMembershipId: office.id.OWNER, status: 'active', archivedAt: null,
        createdByMembershipId: null, deletedAt: null, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
      const left = { _id: new mongoose.Types.ObjectId(office.id.LEFT) };
      await db().collection('memberships').updateOne(left, { $push: { groupIds: String(insertedId) } } as never);
      try {
        expect((await analytics()).groups).toEqual([
          { groupId: coreLeader, name: 'Core Leader', memberCount: 3 }, { groupId: String(insertedId), name: 'Kosong', memberCount: 0 },
        ]);
      } finally {
        await db().collection('memberships').updateOne(left, { $pull: { groupIds: String(insertedId) } } as never);
        await db().collection('groups').deleteOne({ _id: insertedId });
      }
    });

    it('P19.3-T3 AC-15 built without the groups reader — the comparison drawn alone — none is offered, and any group asked is 404', async () => {
      const bare = new KpmAnalyticsService(
        wired.officePeople, new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.coachingReadings, wired.leadReadings,
        wired.productionReadings, wired.goals, wired.carrierRules,
      );
      const view = await bare.read(office.as('OWNER'));
      expect(view).toMatchObject({ groups: [], group: null });
      expect(view.total.manpower).toEqual((await wired.kpmAnalytics.read(office.as('OWNER'))).total.manpower);
      await expect(bare.read(office.as('OWNER'), { group: coreLeader })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });
});
