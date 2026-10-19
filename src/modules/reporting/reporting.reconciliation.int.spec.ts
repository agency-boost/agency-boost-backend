import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { coachingCoverage } from '@/domain/metrics/coaching-coverage';
import { monthlyActiveAgent } from '@/domain/metrics/monthly-active-agent';
import { CoachingController } from '@/modules/coaching/coaching.controller';
import { CoachingRosterService } from '@/modules/coaching/coaching-roster.service';
import { CoacheeService } from '@/modules/coaching/coachee.service';
import { CoachingSessionService } from '@/modules/coaching/coaching-session.service';
import { OrgController } from '@/modules/org/org.controller';
import { DirectoryService } from '@/modules/org/directory.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { RemovalService } from '@/modules/org/removal.service';
import { OrgTreeService } from '@/modules/org/org-tree.service';
import { GroupService } from '@/modules/org/group.service';
import { AdminDelegationService } from '@/modules/org/admin-delegation.service';
import { ProductionController } from '@/modules/production/production.controller';
import { ProductionService } from '@/modules/production/production.service';
import { ProductionImportService } from '@/modules/production/production-import.service';
import { ProductionMonths } from '@/modules/production/production-months.service';
import { ProductionCorrections } from '@/modules/production/production-correction.service';
import { VALUE_COLUMNS } from '@/modules/production/production-preview';
import { TEMPLATE_HEADER_V1 } from '@/modules/production/production-template';
import { UnitDashboardController } from '@/modules/unit-dashboard/unit-dashboard.controller';
import { UnitDashboardService } from '@/modules/unit-dashboard/unit-dashboard.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { KPM_A, ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../test/reporting-office';
import { DirectoryColumns } from './directory-columns';
import { KpmAnalyticsService } from './kpm-analytics.service';
import { KpmOverviewService } from './kpm-overview.service';
import { KpmAnalyticsController, KpmOverviewController } from './reporting.controller';

const M = 1_000_000 * 100;
const MONTH = '2026-09';
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => `2026-${m}`);

interface Money { achievedMinor: number | null; targetMinor: number | null; pct: number | null }
interface Rate { count: number; of: number; pct: number | null }
interface Figures {
  apeMonth: Money; apeAnnual: Money; coached7d: Rate; activeAgents: number | null;
  leads: { sales: number; salesPotential: number; recruit: number; recruitPotential: number };
  manpower: { aab: number; agents: number; total: number };
}
interface Row extends Figures { head: { membershipId: string } }
interface Agency extends Row { direct: Row; aabUnits: Row[]; members: { membershipId: string }[] }
interface Analytics { agencies: Agency[]; total: Figures & { leaversExcludedMinor: number | null }; monthly: { month: string; apeMinor: number | null }[] }
interface TableRow {
  membershipId: string;
  metrics: { ape: { monthly: { value: number | null }; ytd: { value: number | null } } };
  monthlyActiveAgent: boolean | null;
}

/**
 * **Exit tests 1, 2 and 3** (P18-T6 AC-2, AC-3, AC-4, AC-5; P18-T2 AC-8): every figure on the Overview and the
 * analytics equals its owner's own read **over HTTP** — production and MAA the month table's
 * (`GET /kpm/data-upload/:month`), coverage `coachingCoverage`'s over the same members from coaching's own sessions,
 * the pipeline `LeadService.summary`'s, composition the directory's — and **one metric shows one value** across
 * the Overview, the analytics, the directory, the month table, the coaching roster and the Unit Dashboard: over the
 * office as it stands, and through an import, a correction, a leader's correction and a revert (exit test 1's
 * sequence), and a member joining, a member removed mid-month (OD-74), a session finalized and reopened, a lead
 * moved to a late stage and closed won, a goal saved by a leader, and a month's file arriving (exit test 2's).
 */
describe('the Owner’s reporting reconciles with every surface that owns a figure (exit tests 1 to 3)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const owner = () => office.as('OWNER');
  const asOwner = () => { session.current = owner(); };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildReportingOffice(wired);
    const moduleRef = await Test.createTestingModule({
      controllers: [
        KpmOverviewController, KpmAnalyticsController, ProductionController, OrgController, UnitDashboardController, CoachingController,
      ],
      providers: [
        { provide: KpmOverviewService, useValue: wired.kpmOverview },
        { provide: KpmAnalyticsService, useValue: wired.kpmAnalytics },
        { provide: DirectoryColumns, useValue: wired.directoryColumns },
        { provide: DirectoryService, useValue: new DirectoryService(wired.memberships, wired.users as never, wired.kpms as never) },
        { provide: ProductionService, useValue: wired.production },
        { provide: ProductionImportService, useValue: wired.productionImport },
        { provide: ProductionMonths, useValue: wired.productionMonths },
        { provide: ProductionCorrections, useValue: wired.productionCorrections },
        { provide: UnitDashboardService, useValue: wired.unitDashboard },
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
        ...[RoleChangeService, RemovalService, OrgTreeService, GroupService, AdminDelegationService]
          .map((provide) => ({ provide, useValue: {} })),
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

  /** The month table, month by month, as `GET /kpm/data-upload/:month` serves it. */
  async function tables(): Promise<Map<string, TableRow[]>> {
    asOwner();
    const out = new Map<string, TableRow[]>();
    for (const month of MONTHS) out.set(month, (await http().get(`/kpm/data-upload/${month}`).expect(200)).body.rows);
    return out;
  }

  /** Every member's latest year-to-date figure from the month table: the year's production as the table holds it. */
  function ytdFrom(table: Map<string, TableRow[]>, ids: readonly string[]): number | null {
    const figures = ids.map((id) => {
      for (const month of [...MONTHS].reverse()) {
        const value = table.get(month)!.find((r) => r.membershipId === id)?.metrics.ape.ytd.value ?? null;
        if (value !== null) return value;
      }
      return null;
    }).filter((v): v is number => v !== null);
    return figures.length === 0 ? null : figures.reduce((a, b) => a + b, 0);
  }

  /** Coaching's own function over the members given, from coaching's own sessions, read straight from the collection. */
  async function coverageOf(ids: readonly string[]) {
    const sessions = await db().collection('coachingSessions')
      .find({ kpmId: KPM_A, deletedAt: null }, { projection: { coacheeMembershipId: 1, status: 1, date: 1 } }).toArray();
    return coachingCoverage({
      scope: ids, leaderMembershipId: null,
      sessions: sessions.map((s) => ({ coacheeMembershipId: s.coacheeMembershipId, status: s.status, date: s.date ?? null })),
      today: wired.clock.localDateFor('Asia/Jakarta'),
      daysBetween: (from, to) => wired.clock.daysBetween('Asia/Jakarta', from, to),
    });
  }

  /** Every check, over the office as it stands now. */
  async function reconciles(label: string) {
    asOwner();
    const overview = (await http().get('/kpm/overview').expect(200)).body;
    const now = (await http().get('/kpm/analytics').query({ period: 'this_month' }).expect(200)).body as Analytics;
    const then = (await http().get('/kpm/analytics').query({ period: 'previous_month' }).expect(200)).body as Analytics;
    const directory = (await http().get('/members').query({ limit: 100 }).expect(200)).body;
    const unitMonth = (await http().get('/unit/dashboard').query({ period: 'month' }).expect(200)).body;
    const roster = (await http().get('/coaching/coachees').expect(200)).body;
    const table = await tables();
    const summary = await wired.leadRecords.summary(owner());
    const memberIds: string[] = directory.members.map((m: { membershipId: string }) => m.membershipId);
    const at = (what: string) => `${label}: ${what}`;

    // ---- Exit test 1: every figure equals its owner's own read.
    const sep = table.get(MONTH)!;
    const aug = table.get('2026-08')!;
    const sum = (rows: TableRow[], cadence: 'monthly' | 'ytd') => {
      const held = rows.map((r) => r.metrics.ape[cadence].value).filter((v): v is number => v !== null);
      return held.length === 0 ? null : held.reduce((a, b) => a + b, 0);
    };
    const leaversYtd = now.total.leaversExcludedMinor ?? 0;
    expect([at('ytd = the table, leavers included'), overview.production.ytd.achievedMinor])
      .toEqual([at('ytd = the table, leavers included'), (ytdFrom(table, memberIds) ?? 0) + leaversYtd || null]);
    expect([at('this month’s APE = the table'), now.total.apeMonth.achievedMinor]).toEqual([at('this month’s APE = the table'), sum(sep, 'monthly')]);
    expect([at('MAA = the table'), now.total.activeAgents]).toEqual([at('MAA = the table'), sep.filter((r) => r.monthlyActiveAgent === true).length]);
    // The month table lists today's members; the office's file holds a leaver's rows too (OD-74).
    const leavers = await db().collection('memberships').find({ kpmId: KPM_A, status: 'removed' }).toArray();
    const leaverRows = await db().collection('monthlyAgentData')
      .find({ kpmId: KPM_A, month: '2026-08', membershipId: { $in: leavers.map((l) => String(l._id)) } }).toArray();
    const leftInAugust = leaverRows.reduce((n, r) => n + (r.apeMonthly?.value ?? 0), 0);
    // Item 1: last month's figures are over the members it had on 31 August — a leaver since included, their
    // August APE and their MAA flag with them. 1 September, 00:00 in Jakarta, is the end of August.
    const endOfAugust = new Date('2026-08-31T17:00:00Z');
    const augustLeavers = new Set(leavers.filter((l) => l.removedAt && l.removedAt.getTime() >= endOfAugust.getTime()).map((l) => String(l._id)));
    const augustLeaverRows = leaverRows.filter((r) => augustLeavers.has(r.membershipId));
    const augustLeaverApe = augustLeaverRows.reduce((n, r) => n + (r.apeMonthly?.value ?? 0), 0);
    const augustLeaverMaa = augustLeaverRows
      .filter((r) => monthlyActiveAgent(r.apeMonthly?.value ?? null, r.policyCountMonthly?.value ?? null) === true).length;
    expect([at('last month’s APE = the table, and its leavers since'), then.total.apeMonth.achievedMinor])
      .toEqual([at('last month’s APE = the table, and its leavers since'), ((sum(aug, 'monthly') ?? 0) + augustLeaverApe) || null]);
    expect([at('last month’s MAA = the table, and its leavers since'), then.total.activeAgents])
      .toEqual([at('last month’s MAA = the table, and its leavers since'), aug.filter((r) => r.monthlyActiveAgent === true).length + augustLeaverMaa]);
    expect([at('chart = the table, and leavers'), now.monthly.at(-1)!.apeMinor])
      .toEqual([at('chart = the table, and leavers'), (sum(aug, 'monthly') ?? 0) + leftInAugust || null]);
    expect([at('pipeline = LeadService.summary'), overview.recruitment.pipelineNow, overview.recruitment.expectedToClose])
      .toEqual([at('pipeline = LeadService.summary'), summary.recruitmentPipelineNow, summary.recruitmentExpectedToClose]);
    expect([at('headcount = the directory'), overview.composition.total]).toEqual([at('headcount = the directory'), directory.counts.directory]);
    const byRole = (role: string) => directory.members.filter((m: { role: string }) => m.role === role).length;
    expect(overview.composition.rungs.map((r: { count: number }) => r.count)).toEqual([byRole('ab'), byRole('aab'), byRole('agent')]);

    // ---- Exit test 3: coverage is coaching's function, over the office and over each row.
    const [cov7, cov30] = await coverageOf(memberIds);
    expect([at('coverage'), overview.coaching.coverage7d, overview.coaching.coverage30d]).toEqual([
      at('coverage'), { count: cov7.coached, of: cov7.members, pct: cov7.pct }, { count: cov30.coached, of: cov30.members, pct: cov30.pct },
    ]);
    for (const agency of now.agencies) {
      for (const row of [agency, agency.direct, ...agency.aabUnits]) {
        const ids = row === agency
          ? [agency.head.membershipId, ...agency.members.map((m) => m.membershipId)]
          : undefined;
        if (ids) {
          const [c] = await coverageOf(ids);
          expect([at('row coverage'), row.coached7d]).toEqual([at('row coverage'), { count: c.coached, of: c.members, pct: c.pct }]);
        }
      }
    }
    // *Coached in last 7 days* is the complement of the roster's overdue at the office's setting (the Owner is in no roster of theirs).
    const coached = [...roster.directAgents, ...roster.units.flatMap((u: { head: unknown; members: unknown[] }) => [u.head, ...u.members])]
      .filter((r: { lastOneOnOne: { overdue: boolean } | null }) => r.lastOneOnOne !== null && !r.lastOneOnOne.overdue).length;
    expect([at('roster complement'), overview.coaching.coverage7d.count]).toEqual([at('roster complement'), coached]);

    // ---- Exit test 2: one value, across surfaces.
    const sumRows = (key: (f: Figures) => number | null) => now.agencies.reduce((n, a) => n + (key(a) ?? 0), 0);
    expect([at('total = rows'), now.total.manpower.total, now.total.coached7d.count, now.total.apeAnnual.achievedMinor ?? 0, now.total.leads.recruit])
      .toEqual([at('total = rows'), sumRows((f) => f.manpower.total), sumRows((f) => f.coached7d.count),
        sumRows((f) => f.apeAnnual.achievedMinor), sumRows((f) => f.leads.recruit)]);
    expect([at('manpower = headcount'), now.total.manpower.total]).toEqual([at('manpower = headcount'), overview.composition.total]);
    expect([at('coached = coverage'), now.total.coached7d]).toEqual([at('coached = coverage'), overview.coaching.coverage7d]);
    expect([at('annual target'), now.total.apeAnnual.targetMinor]).toEqual([at('annual target'), overview.production.ytd.targetMinor]);
    expect([at('annual APE + leavers = the Overview'), (now.total.apeAnnual.achievedMinor ?? 0) + leaversYtd])
      .toEqual([at('annual APE + leavers = the Overview'), overview.production.ytd.achievedMinor ?? 0]);
    for (const key of ['apeAnnual', 'coached7d', 'manpower'] as const) {
      expect([at(`${key} ignores the period`), then.total[key]]).toEqual([at(`${key} ignores the period`), now.total[key]]);
    }
    // The Owner is the root AB: their Unit Dashboard is the office.
    const tile = unitMonth.tiles.directGroupProduction;
    expect([at('the month = the Unit Dashboard'), now.total.apeMonth.achievedMinor, now.total.apeMonth.targetMinor])
      .toEqual([at('the month = the Unit Dashboard'), tile.actualMinor, tile.targetMinor]);
    const unitRows = [...unitMonth.yourUnit.rows, ...unitMonth.units.flatMap(function rows(g: { head: unknown; members: unknown[]; units: unknown[] }): unknown[] {
      return [g.head, ...g.members, ...(g.units as typeof g[]).flatMap(rows)];
    })] as { leadsCounts: { salesOpen: number; salesClosing: number; recruitOpen: number; recruitNominated: number } }[];
    const leads = unitRows.reduce((n, r) => ({
      sales: n.sales + r.leadsCounts.salesOpen, salesPotential: n.salesPotential + r.leadsCounts.salesClosing,
      recruit: n.recruit + r.leadsCounts.recruitOpen, recruitPotential: n.recruitPotential + r.leadsCounts.recruitNominated,
    }), { sales: 0, salesPotential: 0, recruit: 0, recruitPotential: 0 });
    expect([at('leads = the Unit Dashboard'), now.total.leads]).toEqual([at('leads = the Unit Dashboard'), leads]);
    // The directory's *Last activity* is the not-logged list.
    asOwner();
    const silent = (await http().get('/kpm/overview/not-logged').expect(200)).body;
    const quiet = directory.members.filter((m: { lastActivityDays: number | null }) => m.lastActivityDays === null || m.lastActivityDays > 6);
    expect([at('not logged = the directory'), silent.total]).toEqual([at('not logged = the directory'), quiet.length]);
    expect([at('week card'), overview.engagement.loggedThisWeek.notLogged]).toEqual([at('week card'), quiet.length]);
    // *Last coached* is the roster's.
    for (const row of [...roster.directAgents, ...roster.units.flatMap((u: { head: unknown; members: unknown[] }) => [u.head, ...u.members])] as
      { membershipId: string; lastOneOnOne: { days: number } | null }[]) {
      const listed = directory.members.find((m: { membershipId: string }) => m.membershipId === row.membershipId);
      expect([at('last coached'), listed.lastCoachedDays]).toEqual([at('last coached'), row.lastOneOnOne?.days ?? null]);
    }
  }

  const agentCodeOf = async (who: Who) =>
    (await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))!.agentCode as string;
  const file = async (...rows: [Who, Record<string, string>][]) => ({
    buffer: Buffer.from([
      TEMPLATE_HEADER_V1.join(','),
      ...(await Promise.all(rows.map(async ([who, cells]) =>
        [await agentCodeOf(who), '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')))),
    ].join('\n')),
    originalname: 'f.csv',
    size: 0,
  });
  const importFile = async (month: string, f: Awaited<ReturnType<typeof file>>, replace?: string) => {
    const preview = await wired.production.preview(owner(), month, f);
    return wired.productionImport.commit(owner(), month, String(preview.revision), f, replace);
  };
  const revision = async (month = MONTH) => (await wired.productionMonths.state(owner(), month)).revision;

  it('P18-T6 AC-2, AC-3, AC-4 as the office stands', async () => {
    await reconciles('as it stands');
  }, 60_000);

  it('P18-T6 AC-2 exit test 1 through an import, a correction, a leader’s correction and a revert', async () => {
    const batch = await importFile(MONTH, await file(
      ['NINA', { 'ape.monthly': '12', 'ape.ytd': '40', 'policyCount.monthly': '1' }], ['DODI', { 'ape.monthly': '5', 'ape.ytd': '5' }],
      ['TARI', { 'ape.monthly': '0', 'ape.ytd': '0', 'policyCount.monthly': '0' }],
    ));
    await reconciles('after an import');

    asOwner();
    await http().patch('/kpm/data-upload/cell').send({
      month: MONTH, membershipId: office.id.DODI, metric: 'ape', cadence: 'ytd', value: 9 * M, revision: await revision(),
      reason: 'The carrier restated it by email',
    }).expect(200);
    await reconciles('after a correction');

    session.current = office.as('SARI');
    await http().patch('/unit/dashboard/production').send({
      month: MONTH, revision: await revision(), rows: [{ membershipId: office.id.RINA, apeMonthlyMinor: 75 * M }],
    }).expect(200);
    await reconciles('after a leader’s correction');

    await wired.productionImport.revert(owner(), batch.batch.id);
    await reconciles('after a revert');
  }, 120_000);

  it('P18-T6 AC-3, AC-5 exit test 2 through a join, a removal mid-month, a session finalized and reopened, a lead won, a goal and a file', async () => {
    // A member joins this month, under Sari.
    const sari = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.SARI) });
    const userId = new mongoose.Types.ObjectId();
    await db().collection('users').insertOne({ _id: userId, email: 'new@reporting.test', passwordHash: 'x', fullName: 'Nadia Putri', status: 'active', deletedAt: null });
    const joined = new mongoose.Types.ObjectId();
    await db().collection('memberships').insertOne({
      _id: joined, kpmId: KPM_A, userId: String(userId), agentCode: 'PRU-79999', agentSeq: 99, leaderCode: 'NEWJOIN1', orgLevelId: 'x',
      orgLevelCode: 'AGENT', role: 'agent', leaderId: office.id.SARI, ancestorIds: [...sari!.ancestorIds, office.id.SARI], depth: 3,
      status: 'active', joinedAt: new Date('2026-09-08T03:00:00Z'), removedAt: null, deletedAt: null,
    });
    asOwner();
    expect((await http().get('/kpm/overview').expect(200)).body.composition).toMatchObject({ total: 17, newThisMonth: 1 });
    await reconciles('after a join');

    // A member with production leaves mid-month (OD-74): out of every count of people, their production the Overview's.
    await db().collection('memberships').updateOne(
      { _id: new mongoose.Types.ObjectId(office.id.DIMAS) }, { $set: { status: 'removed', removedAt: new Date('2026-09-11T03:00:00Z') } },
    );
    asOwner();
    const after = (await http().get('/kpm/overview').expect(200)).body;
    expect(after.composition.total).toBe(16);
    const analytics = (await http().get('/kpm/analytics').expect(200)).body as Analytics;
    expect(analytics.total.leaversExcludedMinor).toBe(180 * M);
    expect(after.production.ytd.achievedMinor).toBe((analytics.total.apeAnnual.achievedMinor ?? 0) + 180 * M);
    // Last month's figures still count Dimas, a member on 31 August (item 1): his August APE and his MAA flag are
    // in its total and in his agency's (Direct) row; Manpower is today's people, without him.
    const previous = (await http().get('/kpm/analytics').query({ period: 'previous_month' }).expect(200)).body as Analytics;
    expect(previous.total.manpower.total).toBe(16);
    const dimasAugust = await db().collection('monthlyAgentData').findOne({ membershipId: office.id.DIMAS, month: '2026-08' });
    expect(dimasAugust!.apeMonthly.value).toBe(20 * M);
    expect(monthlyActiveAgent(dimasAugust!.apeMonthly.value, dimasAugust!.policyCountMonthly.value)).toBe(true);
    const augustTable = (await http().get('/kpm/data-upload/2026-08').expect(200)).body.rows as TableRow[];
    expect(augustTable.map((r) => r.membershipId)).not.toContain(office.id.DIMAS);
    expect(previous.total.apeMonth.achievedMinor)
      .toBe(augustTable.reduce((n, r) => n + (r.metrics.ape.monthly.value ?? 0), 0) + 20 * M);
    expect(previous.total.activeAgents).toBe(augustTable.filter((r) => r.monthlyActiveAgent === true).length + 1);
    // Placed by the edge he left with: Agus's (Direct) row holds his August — Agus 30 + Indah 20 + Dimas 20.
    const agus = previous.agencies.find((a) => a.head.membershipId === office.id.AGUS)!;
    expect(agus.direct.apeMonth.achievedMinor).toBe(70 * M);
    expect(agus.members.map((m) => m.membershipId)).not.toContain(office.id.DIMAS);
    await reconciles('after a removal mid-month');

    // A session finalized, then reopened: it keeps counting from its date (ADR-0079).
    const ctx = (who: Who) => office.as(who);
    const { session: started } = await wired.coachingSession.start(ctx('SARI'), office.id.BUDI);
    const saved = await wired.coachingSession.save(ctx('SARI'), started.sessionId, {
      version: started.version, lastWeekItems: [], actionItems: [{ text: 'Book two presentations', dueDate: '2026-09-20' }], tips: [],
    });
    const finalized = await wired.coachingSession.finalize(ctx('SARI'), started.sessionId, saved.version);
    await reconciles('after a session finalized');
    await wired.coachingSession.reopen(ctx('SARI'), finalized.sessionId, { version: finalized.version, reason: 'A date was wrong.' });
    await reconciles('after the session reopened');

    // A lead moved to a late stage, then closed won.
    const lead = await wired.leadRecords.create(ctx('BUDI'), { type: 'recruitment', name: 'Calon Baru' } as never);
    await wired.leadRecords.setStatus(ctx('BUDI'), lead.id, 'AGENT_CODE_CREATED');
    await reconciles('after a lead moved to a late stage');
    const moved = await wired.leadRecords.setStatus(ctx('BUDI'), lead.id, 'NEW_ACTIVE_AGENT');
    await wired.leadRecords.setOutcome(ctx('BUDI'), lead.id, 'won', moved.version);
    await reconciles('after the lead closed won');

    // A goal saved by a leader, in their downline's name.
    await wired.goals.save(ctx('SARI'), {
      period: '2026', mode: 'direct', annualApeTargetMinor: 400 * M, savingsTargetMinor: 0, commissionRatePct: 10, monthsLeft: 4,
      apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
    }, office.id.BUDI);
    await reconciles('after a goal saved by a leader');

    // A month's file arriving: July, where there was none — reopened first, its window long closed.
    await wired.productionMonths.reopen(owner(), '2026-07');
    await importFile('2026-07', await file(['INDAH', { 'ape.monthly': '30', 'ape.ytd': '140' }], ['RINA', { 'ape.monthly': '10', 'ape.ytd': '150' }]));
    asOwner();
    const july = (await http().get('/kpm/analytics').expect(200)).body as Analytics;
    expect(july.monthly.find((m) => m.month === '2026-07')!.apeMinor).toBe(40 * M);
    await reconciles('after a month’s file arrived');
  }, 180_000);

  it('P18-T6 AC-5 in October, September is the previous month: its active count is its own people’s, the leaver out', async () => {
    (wired.clock as FixedClock).set(new Date('2026-10-02T03:00:00Z'));
    try {
      asOwner();
      const previous = (await http().get('/kpm/analytics').query({ period: 'previous_month' }).expect(200)).body as Analytics;
      const september = (await http().get(`/kpm/data-upload/${MONTH}`).expect(200)).body.rows as TableRow[];
      expect(previous.total.activeAgents).toBe(september.filter((r) => r.monthlyActiveAgent === true).length);
      expect(previous.total.apeMonth.achievedMinor).toBe(september.reduce((n, r) => n + (r.metrics.ape.monthly.value ?? 0), 0));
    } finally {
      (wired.clock as FixedClock).set(ROSTER_NOW);
    }
  });

  it('P18-T2 AC-8 an office’s Owner reads the total equal to the Overview, the rows summing to both', async () => {
    const ctx = new RequestContext(owner().userId, 'none', owner().membership);
    const view = await wired.kpmAnalytics.read(ctx);
    const overview = await wired.kpmOverview.read(ctx);
    expect(view.total.manpower.total).toBe(overview.composition.total);
    expect(view.total.coached7d).toEqual(overview.coaching.coverage7d);
  });
});
