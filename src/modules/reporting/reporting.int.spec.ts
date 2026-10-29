import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { rateOver } from '@/domain/metrics/rate';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { OrgController } from '@/modules/org/org.controller';
import { DirectoryService } from '@/modules/org/directory.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { RemovalService } from '@/modules/org/removal.service';
import { OrgTreeService } from '@/modules/org/org-tree.service';
import { GroupService } from '@/modules/org/group.service';
import { AdminDelegationService } from '@/modules/org/admin-delegation.service';
import { LeaderLimitRequestService } from '@/modules/org/leader-limit-request.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { KPM_A, KPM_B, ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildReportingOffice, type ReportingOffice } from '../../../test/reporting-office';
import { DirectoryColumns } from './directory-columns';
import { KpmAnalyticsService } from './kpm-analytics.service';
import { KpmOverviewService } from './kpm-overview.service';
import { PlatformAnalyticsService } from './platform-analytics.service';
import { KpmAnalyticsController, KpmOverviewController, PlatformAnalyticsController } from './reporting.controller';

const M = 1_000_000 * 100;

/**
 * **The Owner's reporting over HTTP, per role** (P18-T1 AC-1, AC-4, AC-6, AC-8, AC-11; P18-T2 AC-2 to AC-5,
 * AC-10; P18-T8 AC-1 to AC-3), with the real `PermissionsGuard`, the production pipe and the real services over
 * `test/reporting-office.ts`. The reconciliation — exit tests 1 to 3 through events — is
 * `reporting.reconciliation.int.spec.ts`; isolation, `reporting.tenancy.spec.ts`.
 */
describe('the Owner’s reporting over HTTP (Phase 18)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ReportingOffice;
  const db = () => mongoose.connection.db!;
  const as = (who: Who) => { session.current = office.as(who); };
  const http = () => request(app.getHttpServer());
  const reads = (surface: string) => db().collection('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, 'after.surface': surface });
  /** The newest audit entry's id: what a read writes after it is `entriesSince(mark)`. */
  const mark = async (): Promise<mongoose.Types.ObjectId | null> =>
    (await db().collection('auditLog').find({}).sort({ _id: -1 }).limit(1).next())?._id ?? null;
  const entriesSince = async (since: mongoose.Types.ObjectId | null) => db().collection('auditLog')
    .find({ action: SUBJECT_READ_ACTION, ...(since === null ? {} : { _id: { $gt: since } }) })
    .project({ _id: 0, createdAt: 0, updatedAt: 0, __v: 0 }).toArray();
  /** One §3.5 entry, field by field (S2): who read whom, from which surface, over which range, and as whom. */
  const entry = (
    target: string, surface: string, range: { from: string | null; to: string },
    by: { membershipId: string; actorUserId: string; effectiveUserId?: string | null; kpmId?: string },
  ) => ({
    action: SUBJECT_READ_ACTION, kpmId: by.kpmId ?? KPM_A, targetCollection: 'memberships', targetId: target,
    targetMembershipId: target, actorMembershipId: by.membershipId, actorUserId: by.actorUserId,
    effectiveUserId: by.effectiveUserId ?? null, onBehalfOf: true, after: { surface, from: range.from, to: range.to },
  });
  const byTarget = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => String(a.targetMembershipId).localeCompare(String(b.targetMembershipId)));
  const expectEntries = (rows: Record<string, unknown>[], expected: ReturnType<typeof entry>[]) =>
    expect(byTarget(rows)).toEqual(byTarget(expected).map((e) => expect.objectContaining(e)));
  const TODAY = '2026-09-14';
  const asOwnerIn = (who: 'OWNER') => ({ membershipId: office.id[who], actorUserId: `u-${who}` });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildReportingOffice(wired);

    const moduleRef = await Test.createTestingModule({
      controllers: [KpmOverviewController, KpmAnalyticsController, PlatformAnalyticsController, OrgController],
      providers: [
        { provide: KpmOverviewService, useValue: wired.kpmOverview },
        { provide: KpmAnalyticsService, useValue: wired.kpmAnalytics },
        { provide: PlatformAnalyticsService, useValue: wired.platformAnalytics },
        { provide: DirectoryColumns, useValue: wired.directoryColumns },
        {
          provide: DirectoryService,
          useValue: new DirectoryService(wired.memberships, wired.users as never, wired.kpms as never),
        },
        // Routes this spec never calls; a bare object keeps Nest from building their graphs.
        ...[RoleChangeService, RemovalService, OrgTreeService, GroupService, AdminDelegationService, LeaderLimitRequestService]
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

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(KpmOverviewController)).toEqual({
      read: 'kpm_overview:read', notLogged: 'kpm_overview:read', setRecruitTarget: 'kpm_overview:set_recruit_target',
    });
    expect(declaredPermissions(KpmAnalyticsController)).toEqual({ read: 'kpm_analytics:read' });
    expect(declaredPermissions(PlatformAnalyticsController)).toEqual({ read: 'platform_analytics:read' });
  });

  describe('P18-T1 — the KPM Overview', () => {
    it('P18-T1 AC-1 positive: the Owner and the Admin read their office', async () => {
      for (const who of ['OWNER', 'ADMIN'] as const) {
        as(who);
        const res = await http().get('/kpm/overview').expect(200);
        expect(res.body).toMatchObject({
          office: { companyName: 'Prudential', code: '0417', branch: 'A' },
          today: '2026-09-14', month: '2026-09', year: '2026', thresholds: { statusSplitPct: 70 },
        });
      }
    });

    it.each(['AGUS', 'SARI', 'INDAH', 'LUKAS'] as const)('P18-T1 AC-1 negative: %s, a field member, is refused by the guard', async (who) => {
      as(who);
      for (const path of ['/kpm/overview', '/kpm/overview/not-logged']) {
        expect((await http().get(path).expect(403)).body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'kpm_overview:read' } });
      }
      const res = await http().put('/kpm/overview/recruit-target').send({ month: '2026-09', target: 3 }).expect(403);
      expect(res.body.error.details).toEqual({ permission: 'kpm_overview:set_recruit_target' });
    });

    it('P18-T1 AC-1 negative: a Super Admin outside a support session has no office; the write is not theirs at all', async () => {
      session.current = SUPER_ADMIN;
      expect((await http().get('/kpm/overview').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().get('/kpm/overview/not-logged').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().put('/kpm/overview/recruit-target').send({ month: '2026-09', target: 3 }).expect(403)).body.error.code)
        .toBe('PERM_DENIED');
    });

    it('P18-T1 AC-3 composition: the headcount, new this month, a tile per rung senior first, the tiles summing to it', async () => {
      as('OWNER');
      const { composition } = (await http().get('/kpm/overview').expect(200)).body;
      expect(composition).toEqual({
        total: 16, newThisMonth: 0,
        rungs: [{ code: 'AB', label: 'AB', count: 4 }, { code: 'AAB', label: 'AAB', count: 4 }, { code: 'AGENT', label: 'Agent', count: 8 }],
      });
      expect(composition.rungs.reduce((n: number, r: { count: number }) => n + r.count, 0)).toBe(composition.total);
    });

    it('P18-T1 AC-4 engagement: logged this month against last month to the same day, and the week card', async () => {
      as('OWNER');
      const { engagement } = (await http().get('/kpm/overview').expect(200)).body;
      // Indah and Dimas logged to the 10th, Rina to today; nobody in August.
      expect(engagement).toEqual({
        loggedThisMonth: { count: 3, of: 16, pct: 19, lastMonthToDate: 0 },
        loggedThisWeek: { logged: 3, notLogged: 13, pct: 19 },
      });
    });

    it('P18-T1 AC-5, P18.97-T3 AC-5 coaching coverage over the office, and every AB on the leaderboard: leaders lowest first, then No team', async () => {
      as('ADMIN');
      const before = await reads('kpm_overview');
      const { coaching, composition } = (await http().get('/kpm/overview').expect(200)).body;
      // 7 days: Indah (4 days ago), Rina (today), Budi (2 days ago); 30 days adds Sari (12 days ago).
      expect(coaching.coverage7d).toEqual({ count: 3, of: 16, pct: 19 });
      expect(coaching.coverage30d).toEqual({ count: 4, of: 16, pct: 25 });
      expect(coaching.leaderboard).toEqual([
        { membershipId: office.id.PEER_AB, name: 'Hendra Gunawan', teamSize: 2, coached: 0, pct: 0, leads: true },
        { membershipId: office.id.OWNER, name: 'Wilson Tanoto', teamSize: 15, coached: 0, pct: 0, leads: true },
        { membershipId: office.id.AGUS, name: 'Agus Salim', teamSize: 10, coached: 1, pct: 10, leads: true },
        // UI-017: the Admin, on the AB rung, leads nobody — listed last, no rate, never left out and never 0%.
        { membershipId: office.id.ADMIN, name: 'Maya Kusuma', teamSize: 0, coached: 0, pct: null, leads: false },
      ]);
      // Every member of the `ab` class is on the board: the composition's AB tile counts the same four.
      expect(coaching.leaderboard).toHaveLength(composition.rungs.find((r: { code: string }) => r.code === 'AB').count);
      // D-audit: one entry per leader on the board, in one insert; the card's figures — and a row of nobody's coaching —
      // write none.
      expect(await reads('kpm_overview')).toBe(before + 3);
    });

    it('P18.97-T3 AC-5 positive: the Owner and the Admin read the same board, every AB on it; negative: a field member is refused it', async () => {
      const boards: unknown[] = [];
      for (const who of ['OWNER', 'ADMIN'] as const) {
        as(who);
        boards.push((await http().get('/kpm/overview').expect(200)).body.coaching.leaderboard);
      }
      expect(boards[1]).toEqual(boards[0]);
      expect((boards[0] as { membershipId: string; leads: boolean }[]).map((row) => [row.membershipId, row.leads])).toEqual([
        [office.id.PEER_AB, true], [office.id.OWNER, true], [office.id.AGUS, true], [office.id.ADMIN, false],
      ]);
      for (const who of ['AGUS', 'SARI', 'INDAH', 'LUKAS'] as const) {
        as(who);
        const res = await http().get('/kpm/overview').expect(403);
        expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'kpm_overview:read' } });
        expect(JSON.stringify(res.body)).not.toContain('leaderboard');
      }
    });

    it('P18-T1 AC-5 S2 the leaderboard’s entries field by field: each leader, the reader as actor, ROLLING_7D as the range', async () => {
      as('ADMIN');
      const since = await mark();
      await http().get('/kpm/overview').expect(200);
      const by = { membershipId: office.id.ADMIN, actorUserId: 'u-ADMIN' };
      expectEntries(await entriesSince(since), (['PEER_AB', 'OWNER', 'AGUS'] as const)
        .map((who) => entry(office.id[who], 'kpm_overview', { from: '2026-09-08', to: TODAY }, by)));
    });

    it('P18.97-T3 AC-5 a No team row writes no entry: read by the Owner, the Admin who leads nobody is on the board and in no entry', async () => {
      // Read as the Admin, her row is left out as the reader's own either way; read as the Owner, only `leads` leaves it out.
      as('OWNER');
      const since = await mark();
      const { leaderboard } = (await http().get('/kpm/overview').expect(200)).body.coaching;
      expect(leaderboard).toContainEqual(expect.objectContaining({ membershipId: office.id.ADMIN, leads: false }));
      expectEntries(await entriesSince(since), (['PEER_AB', 'AGUS'] as const)
        .map((who) => entry(office.id[who], 'kpm_overview', { from: '2026-09-08', to: TODAY }, asOwnerIn('OWNER'))));
    });

    it('P18-T1 AC-6 recruitment: counts, never leads; no target until one is set', async () => {
      as('OWNER');
      const { recruitment } = (await http().get('/kpm/overview').expect(200)).body;
      expect(recruitment).toEqual({ expectedToClose: 1, pipelineNow: 5, closedLastMonth: 1, target: null, targetMonth: '2026-09' });
      expect(JSON.stringify(recruitment)).not.toContain('Late stage');
    });

    it('P18-T1 AC-7 production: the file’s year to date against the members’ goals, the months it leaves out, the agencies lowest first', async () => {
      as('OWNER');
      const { production } = (await http().get('/kpm/overview').expect(200)).body;
      // Indah 240 + Dimas 180 + Rina 240 + Sari 250 + Agus 270 = 1,180 M against three goals of 500 M.
      expect(production.ytd).toEqual({
        achievedMinor: 1180 * M, targetMinor: 1500 * M, pct: 79,
        // Item 3: September, the latest month held, is this month — nothing after it is waited on. January to July
        // hold no file, and are not listed: September's year to date already covers them.
        missingMonths: [], membersWithoutGoal: 13,
      });
      // January to July have no file; the year to date as of September covers nine months all the same.
      expect(production.projectionMinor).toBe(Math.round((1180 * M / 9) * 12));
      expect(production.agencies.map((a: { name: string; pct: number | null }) => [a.name, a.pct])).toEqual([
        ['Agus Salim', 79], ['Hendra Gunawan', null], ['Maya Kusuma', null], ['Wilson Tanoto', null],
      ]);
      const agus = production.agencies[0];
      expect(agus.aabUnits.map((u: { name: string }) => u.name)).toEqual(['Nina Lestari', 'Sari Puspita']);
      expect(agus.aabUnits[1]).toMatchObject({ achievedMinor: 490 * M, targetMinor: 500 * M });
    });

    it('P18-T1 AC-4 S1 the not-logged list: how many, and the first three — never-logged first, A to Z', async () => {
      as('OWNER');
      const since = await mark();
      const res = await http().get('/kpm/overview/not-logged').expect(200);
      // Thirteen silent; the reveal lists three (`KPM_REPORTING.NOT_LOGGED_SHOWN`) and says *"+ 10 more"*.
      expect(res.body.total).toBe(13);
      expect(res.body.members).toEqual([
        { membershipId: office.id.AGUS, name: 'Agus Salim', rung: { code: 'AB', label: 'AB' }, lastLoggedOn: null, daysSince: null },
        { membershipId: office.id.BUDI, name: 'Budi Santoso', rung: { code: 'AGENT', label: 'Agent' }, lastLoggedOn: null, daysSince: null },
        { membershipId: office.id.DEWI, name: 'Dewi Lestari', rung: { code: 'AAB', label: 'AAB' }, lastLoggedOn: null, daysSince: null },
      ]);
      // S1, S2: an entry for each of the three disclosed and for nobody counted — field by field, `from: null`
      // because the latest day logged is disclosed whenever it was.
      expectEntries(await entriesSince(since), (['AGUS', 'BUDI', 'DEWI'] as const)
        .map((who) => entry(office.id[who], 'kpm_overview', { from: null, to: TODAY }, asOwnerIn('OWNER'))));
    });

    it('P18-T1 AC-4 the list orders the longest silent next, A to Z within a day, once people stop', async () => {
      const log = (who: Who, localDate: string) => ({
        kpmId: KPM_A, membershipId: office.id[who], localDate, entries: [], totalCount: 0, source: 'self', note: 'P18 order',
        enteredByMembershipId: office.id[who], version: 1, frozenAt: null, corrections: [], deletedAt: null,
      });
      // Everybody silent logs today but Agus (never), Dewi (13 days ago), and Budi and Nina (9 days ago).
      await db().collection('activityLogs').insertMany([
        ...(['OWNER', 'ADMIN', 'SARI', 'DODI', 'LUKAS', 'TARI', 'PEER_AB', 'PEER_AAB', 'PEER_AGENT'] as const).map((who) => log(who, TODAY)),
        log('DEWI', '2026-09-01'), log('BUDI', '2026-09-05'), log('NINA', '2026-09-05'),
      ]);
      try {
        as('OWNER');
        const res = (await http().get('/kpm/overview/not-logged').expect(200)).body;
        expect(res.total).toBe(4);
        expect(res.members.map((m: { name: string; daysSince: number | null }) => [m.name, m.daysSince]))
          .toEqual([['Agus Salim', null], ['Dewi Lestari', 13], ['Budi Santoso', 9]]);
      } finally {
        await db().collection('activityLogs').deleteMany({ note: 'P18 order' });
      }
    });

    it('P18-T1 AC-1 S5 positive: the Admin reads the not-logged list; the entries name the Admin', async () => {
      as('ADMIN');
      const since = await mark();
      expect((await http().get('/kpm/overview/not-logged').expect(200)).body.members).toHaveLength(3);
      expectEntries(await entriesSince(since), (['AGUS', 'BUDI', 'DEWI'] as const)
        .map((who) => entry(office.id[who], 'kpm_overview', { from: null, to: TODAY }, { membershipId: office.id.ADMIN, actorUserId: 'u-ADMIN' })));
    });

    it('P18-T1 AC-1 S2, S5 a read-only support session reads the list and the analytics; its entries carry both people', async () => {
      const owner = office.as('OWNER');
      session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-support', null, false, true);
      const since = await mark();
      expect((await http().get('/kpm/overview/not-logged').expect(200)).body.total).toBe(13);
      expectEntries(await entriesSince(since), (['AGUS', 'BUDI', 'DEWI'] as const).map((who) => entry(
        office.id[who], 'kpm_overview', { from: null, to: TODAY },
        { membershipId: office.id.OWNER, actorUserId: 'u-support', effectiveUserId: owner.userId },
      )));
      expect((await http().get('/kpm/analytics').expect(200)).body).toMatchObject({ period: 'this_month', month: '2026-09' });
    });

    describe('P18-T1 AC-6 — the recruitment target', () => {
      const put = (body: unknown) => http().put('/kpm/overview/recruit-target').send(body as object);

      it('P18-T1 AC-6 the Owner sets this month’s; the Overview reads it; the change is audited before and after', async () => {
        as('OWNER');
        expect((await put({ month: '2026-09', target: 15 }).expect(200)).body).toEqual({ month: '2026-09', target: 15 });
        expect((await http().get('/kpm/overview').expect(200)).body.recruitment).toMatchObject({ target: 15, targetMonth: '2026-09' });
        as('ADMIN');
        await put({ month: '2026-09', target: 12 }).expect(200);
        const entries = await db().collection('auditLog').find({ action: 'kpm_overview.recruit_target_set' }).sort({ _id: 1 }).toArray();
        expect(entries.map((e) => [e.before, e.after])).toEqual([
          [null, { month: '2026-09', target: 15 }],
          [{ month: '2026-09', target: 15 }, { month: '2026-09', target: 12 }],
        ]);
        expect(entries[1]).toMatchObject({ actorMembershipId: office.id.ADMIN, targetCollection: 'kpmRecruitTargets' });
        // The same target again writes nothing.
        await put({ month: '2026-09', target: 12 }).expect(200);
        expect(await db().collection('auditLog').countDocuments({ action: 'kpm_overview.recruit_target_set' })).toBe(2);
        expect(await db().collection('kpmRecruitTargets').countDocuments({})).toBe(1);
      });

      it('P18-T1 AC-6 a month with none reads the latest earlier month’s', async () => {
        await db().collection('kpmRecruitTargets').insertOne({ kpmId: KPM_A, month: '2026-07', target: 9, deletedAt: null });
        await db().collection('kpmRecruitTargets').updateOne({ month: '2026-09' }, { $set: { deletedAt: new Date() } });
        as('OWNER');
        expect((await http().get('/kpm/overview').expect(200)).body.recruitment.target).toBe(9);
        await db().collection('kpmRecruitTargets').updateOne({ month: '2026-09' }, { $set: { deletedAt: null } });
      });

      it.each([
        ['another month', { month: '2026-08', target: 3 }, 'month'],
        ['a month that is not YYYY-MM', { month: 'September', target: 3 }, 'month'],
        ['a negative target', { month: '2026-09', target: -1 }, 'target'],
        ['a fraction', { month: '2026-09', target: 1.5 }, 'target'],
        ['a string', { month: '2026-09', target: '15' }, 'target'],
        ['no target', { month: '2026-09' }, 'target'],
        ['an unknown field', { month: '2026-09', target: 3, note: 'x' }, 'note'],
      ])('P18-T1 AC-11 %s is 400 VALIDATION_FAILED, named in details, nothing written', async (_, body, named) => {
        as('OWNER');
        const before = await db().collection('kpmRecruitTargets').find({}).toArray();
        const res = await put(body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(res.body.error.details)).toContain(named);
        expect(await db().collection('kpmRecruitTargets').find({}).toArray()).toEqual(before);
      });

      it('P18.95-T1 AC-4 another month is refused in a sentence naming the current one as ADR-0167 §1 writes a month', async () => {
        as('OWNER');
        expect((await put({ month: '2026-08', target: 3 }).expect(400)).body.error).toMatchObject({
          message: 'A recruitment target is set for Sep 2026, the agency\'s current month.',
          details: { field: 'month', month: '2026-09' },
        });
      });

      it('P18.98-T5 AC-7 refuses another month, and a month not written as one, in Indonesian', async () => {
        as('OWNER');
        expect((await put({ month: '2026-08', target: 3 }).set('Accept-Language', 'id').expect(400)).body.error).toMatchObject({
          code: 'VALIDATION_FAILED', message: 'Target recruitment ditetapkan untuk Sep 2026, bulan berjalan KPM.',
          details: { field: 'month', month: '2026-09' },
        });
        expect((await put({ month: 'September', target: 3 }).set('Accept-Language', 'id').expect(400)).body.error).toMatchObject({
          code: 'VALIDATION_FAILED', details: { violations: ['month harus dengan format YYYY-MM'] },
        });
        expect((await put({ month: 'September', target: 3 }).expect(400)).body.error.details.violations)
          .toEqual(['month must be YYYY-MM']);
      });

      it.each(['AGUS', 'SARI', 'INDAH', 'LUKAS'] as const)(
        'P18.97-T3 AC-7 negative: %s holds no kpm_overview:set_recruit_target, is refused 403, and nothing is written',
        async (who) => {
          const targets = await db().collection('kpmRecruitTargets').find({}).toArray();
          const entries = await db().collection('auditLog').countDocuments({ action: 'kpm_overview.recruit_target_set' });
          as(who);
          expect((await put({ month: '2026-09', target: 40 }).expect(403)).body.error)
            .toMatchObject({ code: 'PERM_DENIED', details: { permission: 'kpm_overview:set_recruit_target' } });
          expect(await db().collection('kpmRecruitTargets').find({}).toArray()).toEqual(targets);
          expect(await db().collection('auditLog').countDocuments({ action: 'kpm_overview.recruit_target_set' })).toBe(entries);
        },
      );

      it('P18.97-T3 AC-7 positive: the write is unchanged — the Owner and an Admin each save one, answered with what is kept', async () => {
        for (const [who, target] of [['OWNER', 14], ['ADMIN', 16]] as const) {
          as(who);
          expect((await put({ month: '2026-09', target }).expect(200)).body).toEqual({ month: '2026-09', target });
          expect((await http().get('/kpm/overview').expect(200)).body.recruitment.target).toBe(target);
        }
      });

      it('P18-T1 AC-1 a read-only support session reads the Overview and is refused the target; an elevated one writes as the member', async () => {
        const owner = office.as('OWNER');
        session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-support', null, false, true);
        await http().get('/kpm/overview').expect(200);
        expect((await put({ month: '2026-09', target: 20 }).expect(403)).body.error.code).toBe('PERM_DENIED');
        session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-support', null, false, false);
        await put({ month: '2026-09', target: 20 }).expect(200);
        const entry = await db().collection('auditLog').findOne({ action: 'kpm_overview.recruit_target_set', 'after.target': 20 });
        expect(entry).toMatchObject({ actorUserId: 'u-support', effectiveUserId: owner.userId });
      });
    });

    it.each([['/kpm/overview'], ['/kpm/overview/not-logged']])('P18-T1 AC-11 %s refuses any query parameter by name', async (path) => {
      as('OWNER');
      const res = await http().get(path).query({ period: 'this_month' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain('period');
    });
  });

  describe('P18-T1 AC-8 — the directory’s two columns', () => {
    it('P18-T1 AC-8 every row carries its last activity and last coached, in the office’s calendar; one entry per member', async () => {
      as('OWNER');
      const before = await reads('directory');
      const res = await http().get('/members').query({ limit: 50 }).expect(200);
      const row = (who: Who) => res.body.members.find((m: { membershipId: string }) => m.membershipId === office.id[who]);
      expect(row('RINA')).toMatchObject({ lastActivityOn: '2026-09-14', lastActivityDays: 0, lastCoachedDays: 0 });
      expect(row('INDAH')).toMatchObject({ lastActivityOn: '2026-09-10', lastActivityDays: 4, lastCoachedDays: 4 });
      expect(row('TARI')).toMatchObject({ lastActivityOn: null, lastActivityDays: null, lastCoachedDays: null });
      expect(res.body.members).toHaveLength(16);
      // Everybody on the page but the reader, in one insert.
      expect(await reads('directory')).toBe(before + 15);
    });

    it('P18-T1 AC-8 S2 the page’s entries field by field: each member but the reader, `from: null` to today', async () => {
      as('OWNER');
      const since = await mark();
      const res = await http().get('/members').query({ limit: 50 }).expect(200);
      const others = res.body.members.map((m: { membershipId: string }) => m.membershipId).filter((id: string) => id !== office.id.OWNER);
      expect(others).toHaveLength(15);
      expectEntries(await entriesSince(since), others.map((id: string) => entry(id, 'directory', { from: null, to: TODAY }, asOwnerIn('OWNER'))));
    });

    it('P18-T1 AC-8 S5 positive: the Admin’s page carries the columns on every row, and names the Admin in its entries', async () => {
      as('ADMIN');
      const since = await mark();
      const res = await http().get('/members').query({ limit: 50 }).expect(200);
      const row = (who: Who) => res.body.members.find((m: { membershipId: string }) => m.membershipId === office.id[who]);
      expect(row('RINA')).toMatchObject({ lastActivityOn: '2026-09-14', lastActivityDays: 0, lastCoachedDays: 0 });
      expect(row('OWNER')).toMatchObject({ lastActivityOn: null, lastCoachedDays: null });
      const written = await entriesSince(since);
      expect(written).toHaveLength(15);
      expect(written.every((e) => e.actorMembershipId === office.id.ADMIN && e.actorUserId === 'u-ADMIN')).toBe(true);
    });

    it('P18-T1 AC-8 S5 positive: an AB’s page is their downline, each row with its columns, an entry for each but the AB', async () => {
      as('AGUS');
      const since = await mark();
      const res = await http().get('/members').expect(200);
      const ids = res.body.members.map((m: { membershipId: string }) => m.membershipId);
      expect(ids.sort()).toEqual((['AGUS', 'INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI'] as const)
        .map((who) => office.id[who]).sort());
      expect(res.body.members.find((m: { membershipId: string }) => m.membershipId === office.id.INDAH))
        .toMatchObject({ lastActivityOn: '2026-09-10', lastActivityDays: 4, lastCoachedDays: 4 });
      const by = { membershipId: office.id.AGUS, actorUserId: 'u-AGUS' };
      expectEntries(await entriesSince(since), ids.filter((id: string) => id !== office.id.AGUS)
        .map((id: string) => entry(id, 'directory', { from: null, to: TODAY }, by)));
    });

    it('P18-T1 AC-8 B1 the Removed and Pending tabs draw neither column, read nothing of a member gone, and write no entry', async () => {
      // Fajar left Agus's agency: give the history something to leak — a day logged and a 1:1.
      await db().collection('activityLogs').insertOne({
        kpmId: KPM_A, membershipId: office.id.LEFT, localDate: '2026-09-13', entries: [], totalCount: 0, source: 'self', note: 'B1',
        enteredByMembershipId: office.id.LEFT, version: 1, frozenAt: null, corrections: [], deletedAt: null,
      });
      await db().collection('coachingSessions').insertOne({
        kpmId: KPM_A, coachMembershipId: office.id.AGUS, coacheeMembershipId: office.id.LEFT, status: 'finalized', date: '2026-09-12',
        frozenAt: new Date('2026-09-12T04:00:00Z'), version: 3, deletedAt: null, note: 'B1',
      });
      const pending = new mongoose.Types.ObjectId();
      await db().collection('memberships').insertOne({
        _id: pending, kpmId: KPM_A, userId: String(new mongoose.Types.ObjectId()), agentCode: 'PRU-7PEND', agentSeq: 300,
        leaderCode: 'PENDING1', orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: null, ancestorIds: [], depth: 0,
        status: 'pending', joinedAt: null, deletedAt: null,
      });
      try {
        const columns = ['lastActivityOn', 'lastActivityDays', 'lastCoachedDays'];
        for (const who of ['AGUS', 'OWNER'] as const) {
          as(who);
          const since = await mark();
          const removed = (await http().get('/members').query({ status: 'removed' }).expect(200)).body.members;
          expect(removed.map((m: { membershipId: string }) => m.membershipId)).toEqual([office.id.LEFT]);
          for (const column of columns) expect(removed[0]).not.toHaveProperty(column);
          expect(await entriesSince(since)).toEqual([]);
        }
        as('OWNER');
        const since = await mark();
        const waiting = (await http().get('/members').query({ status: 'pending' }).expect(200)).body.members;
        expect(waiting.map((m: { membershipId: string }) => m.membershipId)).toEqual([String(pending)]);
        for (const column of columns) expect(waiting[0]).not.toHaveProperty(column);
        expect(await entriesSince(since)).toEqual([]);
      } finally {
        await db().collection('activityLogs').deleteMany({ note: 'B1' });
        await db().collection('coachingSessions').deleteMany({ note: 'B1' });
        await db().collection('memberships').deleteOne({ _id: pending });
      }
    });

    it('P18-T1 AC-8 a leader’s page is their downline, and writes an entry per member on it other than them', async () => {
      as('SARI');
      const before = await reads('directory');
      const res = await http().get('/members').expect(200);
      expect(res.body.members.map((m: { fullName: string }) => m.fullName).sort())
        .toEqual(['Budi Santoso', 'Dodi Kurniawan', 'Nina Lestari', 'Rina Wijaya', 'Sari Puspita']);
      expect(await reads('directory')).toBe(before + 4);
    });

    it('P18-T1 AC-8 an agent’s page is their own row, and writes nothing', async () => {
      as('TARI');
      const before = await reads('directory');
      const res = await http().get('/members').expect(200);
      expect(res.body.members).toHaveLength(1);
      expect(await reads('directory')).toBe(before);
    });
  });

  describe('P18-T2 — KPM analytics', () => {
    type Figures = { manpower: { total: number; aab: number; agents: number }; apeAnnual: { achievedMinor: number | null } };
    type Head = { name: string; isReader: boolean; leads: boolean };
    type Agency = Figures & { head: Head; direct: Figures & { head: Head }; aabUnits: (Figures & { head: Head })[] };

    it('P18-T2 AC-10 positive: the Owner and the Admin; negative: every field member who is no Core Leader, and a Super Admin outside a session', async () => {
      for (const who of ['OWNER', 'ADMIN'] as const) {
        as(who);
        expect((await http().get('/kpm/analytics').expect(200)).body).toMatchObject({ period: 'this_month', month: '2026-09' });
      }
      // An AB and an AAB hold the grant since ADR-0159 (P18.8-T5 AC-4), and untagged are answered 404 by the service.
      for (const who of ['AGUS', 'SARI'] as const) {
        as(who);
        expect((await http().get('/kpm/analytics').expect(404)).body.error.code).toBe('NOT_FOUND');
      }
      // An Agent holds no grant: the guard.
      as('INDAH');
      expect((await http().get('/kpm/analytics').expect(403)).body.error.details).toEqual({ permission: 'kpm_analytics:read' });
      session.current = SUPER_ADMIN;
      expect((await http().get('/kpm/analytics').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    describe('P18.8-T5 AC-4, AC-6 — a Core Leader reads the office’s analytics (ADR-0159 §2)', () => {
      /** `who` as `ContextResolver` resolves them once tagged: the effective flag on the membership. */
      const tagged = (who: Who): RequestContext => {
        const base = office.as(who);
        return new RequestContext(base.userId, 'none', { ...base.membership!, isCoreLeader: true });
      };
      const owners = async () => {
        as('OWNER');
        return (await http().get('/kpm/analytics').expect(200)).body as { agencies: Agency[]; total: Figures & { abCount: number } };
      };

      it.each(['AGUS', 'SARI'] as const)('P18.8-T5 AC-4 positive: %s, tagged, reads the whole office — the Owner’s figures, nothing recorded', async (who) => {
        const theirs = await owners();
        session.current = tagged(who);
        const since = await mark();
        const read = (await http().get('/kpm/analytics').expect(200)).body as typeof theirs;
        // The office's every agency and total, not their own unit: only who is the reader differs.
        const heads = (v: typeof theirs) => v.agencies.map((a) => [a.head.name, a.manpower.total]);
        expect(heads(read)).toEqual(heads(theirs));
        expect(read.total).toEqual(theirs.total);
        expect(read.agencies.find((a) => a.head.name === 'Agus Salim')!.head.isReader).toBe(who === 'AGUS');
        expect(await entriesSince(since)).toEqual([]);
        // And the period, as the Owner's.
        expect((await http().get('/kpm/analytics').query({ period: 'previous_month' }).expect(200)).body.period).toBe('previous_month');
      });

      it.each(['PEER_AB', 'DEWI'] as const)('P18.8-T5 AC-6 negative: %s, a leader not tagged, is answered 404 — the forum’s rule', async (who) => {
        as(who);
        const res = await http().get('/kpm/analytics').expect(404);
        expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'KPM analytics not found.' });
      });

      it('P18.8-T5 AC-6 negative: a tagged Agent cannot exist, and a context claiming one holds no grant', async () => {
        session.current = tagged('INDAH');
        expect(session.current.isCoreLeader).toBe(false);
        expect((await http().get('/kpm/analytics').expect(403)).body.error.details).toEqual({ permission: 'kpm_analytics:read' });
      });

      it('P18.8-T5 AC-6 a support session reads as its member: a tagged AB’s reads, an untagged AAB’s is 404, and nothing is written', async () => {
        const supported = (base: RequestContext) => new RequestContext(base.userId, 'none', base.membership, 'u-support', null, false, true);
        session.current = supported(tagged('AGUS'));
        const before = await db().collection('auditLog').countDocuments();
        expect((await http().get('/kpm/analytics').expect(200)).body.total.abCount).toBe(4);
        session.current = supported(office.as('SARI'));
        expect((await http().get('/kpm/analytics').expect(404)).body.error.code).toBe('NOT_FOUND');
        expect(await db().collection('auditLog').countDocuments()).toBe(before);
      });

      it('P18.8-T5 AC-4 cross-tenant: a Core Leader of 0417 reads 0417 alone — no member of 0555 in any row', async () => {
        session.current = tagged('AGUS');
        const read = (await http().get('/kpm/analytics').expect(200)).body as { agencies: Agency[] };
        const names = read.agencies.flatMap((a) => [a.head.name, a.direct.head.name, ...a.aabUnits.map((u) => u.head.name)]);
        expect(names).not.toContain('Lina Marlina');
        expect(names).not.toContain('Bayu Saputra');
      });
    });

    it.each([
      ['a period it does not know', { period: 'last_month' }, 'period'],
      ['a period in another case', { period: 'This_Month' }, 'period'],
      ['a parameter of any other name', { month: '2026-08' }, 'month'],
    ])('P18-T2 AC-10 %s is 400 VALIDATION_FAILED, named in details', async (_, query, named) => {
      as('OWNER');
      const res = await http().get('/kpm/analytics').query(query).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain(named);
    });

    it('P18-T2 AC-2 one row per AB agency, an AB under an AB its own; (Direct) and the AAB units partition each; the total sums the rows', async () => {
      as('OWNER');
      const view = (await http().get('/kpm/analytics').expect(200)).body as { agencies: Agency[]; total: Figures & { abCount: number } };
      expect(view.agencies.map((a) => [a.head.name, a.head.isReader, a.manpower.total])).toEqual([
        ['Agus Salim', false, 11], ['Hendra Gunawan', false, 3], ['Maya Kusuma', false, 1], ['Wilson Tanoto', true, 1],
      ]);
      const agus = view.agencies[0];
      expect(agus.direct.manpower).toEqual({ aab: 1, agents: 4, total: 6 });
      expect(agus.aabUnits.map((u) => [u.head.name, u.manpower.total])).toEqual([['Nina Lestari', 2], ['Sari Puspita', 3]]);
      expect(agus.direct.manpower.total + agus.aabUnits.reduce((n, u) => n + u.manpower.total, 0)).toBe(agus.manpower.total);
      expect(view.total.abCount).toBe(4);
      expect(view.total.manpower.total).toBe(view.agencies.reduce((n, a) => n + a.manpower.total, 0));
      expect(view.total.manpower.total).toBe(16);
      // Item 7: whether each head leads anybody — the Admin heads an agency of one and leads nobody.
      expect(view.agencies.map((a) => [a.head.name, a.head.leads, a.direct.head.leads])).toEqual([
        ['Agus Salim', true, true], ['Hendra Gunawan', true, true], ['Maya Kusuma', false, false], ['Wilson Tanoto', true, true],
      ]);
      expect(agus.aabUnits.map((u) => [u.head.name, u.head.leads])).toEqual([['Nina Lestari', true], ['Sari Puspita', true]]);
    });

    it('P18-T2 AC-3 the period moves the month’s APE, the active count and the leads; annual, coached and manpower stay', async () => {
      as('OWNER');
      const now = (await http().get('/kpm/analytics').query({ period: 'this_month' }).expect(200)).body;
      const then = (await http().get('/kpm/analytics').query({ period: 'previous_month' }).expect(200)).body;
      expect(then).toMatchObject({ period: 'previous_month', month: '2026-08' });
      for (const key of ['apeAnnual', 'coached7d', 'manpower']) expect([key, then.total[key]]).toEqual([key, now.total[key]]);
      // September: Indah 80, Dimas 20, Rina 80, Sari 90, Agus 30. August: 20 each, and Agus 30.
      expect(now.total.apeMonth.achievedMinor).toBe(300 * M);
      expect(then.total.apeMonth.achievedMinor).toBe(110 * M);
      expect(now.total.activeAgents).toBe(5);
      // P18.97-T3 AC-10: the share is served — 5 of 16, 31% — on the total and on every row, each over its own manpower.
      expect(now.total.activePct).toBe(31);
      type Row = { activeAgents: number | null; activePct: number | null; manpower: { total: number } };
      const rows = (view: { total: Row; agencies: (Row & { direct: Row; aabUnits: Row[] })[] }) =>
        [view.total, ...view.agencies.flatMap((a) => [a, a.direct, ...a.aabUnits])];
      for (const row of [...rows(now), ...rows(then)]) {
        expect(row.activePct).toBe(row.activeAgents === null ? null : rateOver(row.activeAgents, row.manpower.total).pct);
      }
      // Rina's lead moved to AAJI licensed on 20 August: it was open then. Indah's, won on 25 August, was not.
      expect(then.total.leads.recruit).toBeGreaterThanOrEqual(1);
    });

    it('P18-T2 AC-4 MOC against the company’s rules: each criterion with its period, null where not uploaded', async () => {
      as('OWNER');
      const { agencies } = (await http().get('/kpm/analytics').expect(200)).body;
      const agus = agencies.find((a: { head: { name: string } }) => a.head.name === 'Agus Salim');
      expect(agus.moc.status).toBe('not_met');
      expect(agus.moc.criteria.map((c: { code: string }) => c.code))
        .toEqual(['NET_APE', 'MONTHLY2_AA_DU', 'MONTHLY2_AA_DG', 'MOC_PERSISTENCY', 'DIRECT_AB_COUNT']);
      const net = agus.moc.criteria[0];
      // Agus and his Direct Group: Indah, Dimas (and Lukas, Tari: nothing held), Sari, Dewi, with their Direct Units.
      expect(net).toMatchObject({ label: 'Net APE', required: 600_000_000 * 100, period: 'Jan – Sep 2026' });
      expect(agus.moc.criteria[3]).toMatchObject({ current: 91, required: 75, met: true, period: 'Sep 2026' });
      expect(agus.moc.criteria[4]).toMatchObject({ label: '— OR — Direct AB (AB on AB)', current: 0, met: false, period: 'As of 14 Sep 2026' });
      const sari = agus.aabUnits.find((u: { head: { name: string } }) => u.head.name === 'Sari Puspita');
      expect(sari.moc.criteria.map((c: { label: string }) => c.label)).toEqual(['Net APE', 'Monthly2 AA', 'Rolling Persistency — DU']);
      // The Owner is evaluated as the AB they are.
      expect(agencies.find((a: { head: { isReader: boolean } }) => a.head.isReader).moc).not.toBeNull();
    });

    it('P18.98-T5 AC-4 MOC in Indonesian: each criterion’s period, the path, the OR — the criteria by their names', async () => {
      as('OWNER');
      const english = (await http().get('/kpm/analytics').expect(200)).body;
      const { agencies, mocRulesText } = (await http().get('/kpm/analytics').set('Accept-Language', 'id').expect(200)).body;
      const agus = agencies.find((a: { head: { name: string } }) => a.head.name === 'Agus Salim');
      expect(agus.moc.criteria.map((c: { label: string; period: string }) => [c.label, c.period])).toEqual([
        ['Net APE', 'Jan – Sep 2026'],
        ['Monthly2 AA — DU', 'Agu dan Sep 2026'],
        ['Monthly2 AA — DG', 'Agu dan Sep 2026'],
        ['Rolling Persistency — DU/DG', 'Sep 2026'],
        ['— ATAU — Direct AB (AB on AB)', 'Per 14 Sep 2026'],
      ]);
      expect(agus.moc).toMatchObject({
        status: 'not_met', missing: null, path: 'Perlu memenuhi ketiga kriteria standar sekaligus, atau mencapai 5 Direct ABs.',
      });
      const sari = agus.aabUnits.find((u: { head: { name: string } }) => u.head.name === 'Sari Puspita');
      expect(sari.moc.path).toBe('Syarat AAB tidak memiliki jalur alternatif — ketiganya harus terpenuhi.');
      expect(mocRulesText).toBe(
        'AAB: Net APE ≥ Rp 200 jt DAN Monthly2 AA ≥ 2 DAN Rolling Persistency DU ≥ 75%.\n'
        + 'AB: (Net APE ≥ Rp 600 jt DAN Monthly2 AA DU ≥ 4 / DG ≥ 6 DAN Rolling Persistency DU/DG ≥ 75%) ATAU Direct AB (AB on AB) ≥ 5.',
      );
      // English, as it always read; every figure the same in both.
      const englishAgus = english.agencies.find((a: { head: { name: string } }) => a.head.name === 'Agus Salim');
      expect(englishAgus.moc.path).toBe('Needs to clear either the three standard criteria together, or reach 5 Direct ABs.');
      expect(englishAgus.moc.criteria.map((c: { current: number | null }) => c.current))
        .toEqual(agus.moc.criteria.map((c: { current: number | null }) => c.current));
    });

    it('P18-T2 AC-4 item 8 the MOC column’s tooltip is the company’s rules in the prototype’s words, the AAB’s first', async () => {
      as('OWNER');
      const { mocRulesText } = (await http().get('/kpm/analytics').expect(200)).body;
      expect(mocRulesText).toBe(
        'AAB: Net APE ≥ Rp 200 jt AND Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75%.\n'
        + 'AB: (Net APE ≥ Rp 600 jt AND Monthly2 AA DU ≥ 4 / DG ≥ 6 AND Rolling Persistency DU/DG ≥ 75%) OR Direct AB (AB on AB) ≥ 5.',
      );
    });

    it('P18-T2 AC-4 item 2 Monthly2 AA counts only members active in both months held; a member the file says nothing of is not', async () => {
      as('OWNER');
      const { agencies } = (await http().get('/kpm/analytics').expect(200)).body;
      const agus = agencies.find((a: { head: { name: string } }) => a.head.name === 'Agus Salim');
      // Agus's Direct Unit: Indah and Dimas active in August and September; Lukas and Tari — nothing on file — are not.
      expect(agus.moc.criteria.find((c: { code: string }) => c.code === 'MONTHLY2_AA_DU'))
        .toMatchObject({ current: 2, required: 4, met: false, period: 'Agu and Sep 2026' });
      // Sari's Direct Unit: Rina active in both; Budi has no row in either held month — a count, not *perhaps*.
      const sari = agus.aabUnits.find((u: { head: { name: string } }) => u.head.name === 'Sari Puspita');
      expect(sari.moc.criteria.find((c: { code: string }) => c.code === 'MONTHLY2_AA')).toMatchObject({ current: 1, met: false });
      expect(sari.moc).toMatchObject({ status: 'not_met', missing: null });
    });

    it('P18-T2 AC-6 six months before this one, oldest first, a month with no file a gap', async () => {
      as('OWNER');
      const { monthly } = (await http().get('/kpm/analytics').expect(200)).body;
      expect(monthly).toEqual([
        { month: '2026-03', apeMinor: null }, { month: '2026-04', apeMinor: null }, { month: '2026-05', apeMinor: null },
        { month: '2026-06', apeMinor: null }, { month: '2026-07', apeMinor: null }, { month: '2026-08', apeMinor: 110 * M },
      ]);
    });

    it('P18-T2 AC-7 following a drill writes nothing: the analytics read records no entry', async () => {
      as('OWNER');
      const before = await db().collection('auditLog').countDocuments({});
      await http().get('/kpm/analytics').expect(200);
      expect(await db().collection('auditLog').countDocuments({})).toBe(before);
    });
  });

  describe('P18-T8 — cross-platform analytics', () => {
    it('P18-T8 AC-1 positive: the Super Admin; negative: every tenant role, and a support session of any kind', async () => {
      session.current = SUPER_ADMIN;
      expect((await http().get('/admin/analytics').expect(200)).body.month).toBe('2026-09');
      for (const who of ['OWNER', 'ADMIN', 'AGUS', 'SARI', 'INDAH'] as const) {
        as(who);
        expect((await http().get('/admin/analytics').expect(403)).body.error.details).toEqual({ permission: 'platform_analytics:read' });
      }
      // P18.98-T5 AC-7: the same refusal in Indonesian.
      expect((await http().get('/admin/analytics').set('Accept-Language', 'id').expect(403)).body.error).toMatchObject({
        code: 'PERM_DENIED', message: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
        details: { permission: 'platform_analytics:read' },
      });
      const owner = office.as('OWNER');
      for (const readOnly of [true, false]) {
        session.current = new RequestContext(owner.userId, 'none', owner.membership, 'u-support', null, false, readOnly);
        await http().get('/admin/analytics').expect(403);
      }
      session.current = SUPER_ADMIN;
      expect((await http().get('/admin/analytics').query({ kpmId: 'x' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18-T8 AC-2 adoption per office, per company and for the platform; the office’s state as All KPMs shows it', async () => {
      session.current = SUPER_ADMIN;
      const view = (await http().get('/admin/analytics').expect(200)).body;
      const a = view.offices.find((o: { code: string }) => o.code === '0417');
      expect(a).toMatchObject({
        branch: 'A', company: { name: 'Prudential' }, state: 'active', members: 16, joinedThisMonth: 0, leftThisMonth: 0,
        signedIn7d: 13, signedIn30d: 14,
        byRung: [{ code: 'AB', label: 'AB', count: 4 }, { code: 'AAB', label: 'AAB', count: 4 }, { code: 'AGENT', label: 'Agent', count: 8 }],
      });
      const b = view.offices.find((o: { code: string }) => o.code === '0555');
      expect(b).toMatchObject({ members: 2, signedIn7d: 0, signedIn30d: 0 });
      expect(view.companies).toEqual([expect.objectContaining({ name: 'Prudential', offices: 2, members: 18 })]);
      expect(view.platform).toMatchObject({ offices: 2, companies: 1, members: 18, signedIn7d: 13, signedIn30d: 14 });
    });

    /*
     * **Exit test 4** (P18-T8 AC-3): field by field, the payload carries no membership id, no name, no lead, activity,
     * coaching or production figure — only the keys of adoption, an office's and a company's identity, and counts.
     */
    it('P18-T8 AC-3 exit test 4: the payload names no member and carries no business figure', async () => {
      session.current = SUPER_ADMIN;
      const view = (await http().get('/admin/analytics').expect(200)).body;
      const ADOPTION = ['members', 'byRung', 'joinedThisMonth', 'leftThisMonth', 'signedIn7d', 'signedIn30d'];
      expect(Object.keys(view).sort()).toEqual(['companies', 'month', 'offices', 'platform']);
      for (const o of view.offices) expect(Object.keys(o).sort()).toEqual([...ADOPTION, 'branch', 'code', 'company', 'kpmId', 'state'].sort());
      for (const c of view.companies) expect(Object.keys(c).sort()).toEqual([...ADOPTION, 'id', 'name', 'offices'].sort());
      expect(Object.keys(view.platform).sort()).toEqual([...ADOPTION, 'companies', 'offices'].sort());
      for (const r of [...view.offices, ...view.companies, view.platform].flatMap((x: { byRung: unknown[] }) => x.byRung)) {
        expect(Object.keys(r as object).sort()).toEqual(['code', 'count', 'label']);
      }
      const text = JSON.stringify(view);
      for (const id of Object.values(office.id)) expect(text).not.toContain(id);
      for (const name of Object.values(office.name)) expect(text).not.toContain(name);
    });

    it('P18-T8 AC-2 item 6 a company’s and the platform’s members and sign-ins are people: one account in two offices counts once', async () => {
      // Agus (signed in two days ago) also holds a membership in 0555, and in an office of a second company.
      const agusUser = await office.userIdOf('AGUS');
      const other = '66f0000000000000000000c2';
      const elsewhere = '66f0000000000000000000d1';
      await db().collection('companies').insertOne({ _id: new mongoose.Types.ObjectId(other), name: 'Allianz Life', slug: 'allianz-p18', deletedAt: null });
      await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
        _id: elsewhere, companyId: other, code: '0901', branchName: 'Elsewhere', timezone: 'Asia/Jakarta',
      });
      const membership = (kpmId: string, seq: number) => ({
        _id: new mongoose.Types.ObjectId(), kpmId, userId: agusUser, agentCode: `PRU-8${seq}`, agentSeq: seq, leaderCode: `TWICE${seq}`,
        orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: null, ancestorIds: [], depth: 0, status: 'active',
        joinedAt: new Date('2026-02-02T02:00:00Z'), deletedAt: null, note: 'item 6',
      });
      await db().collection('memberships').insertMany([membership(KPM_B, 401), membership(elsewhere, 402)]);
      try {
        session.current = SUPER_ADMIN;
        const view = (await http().get('/admin/analytics').expect(200)).body;
        // Each office row counts its memberships: 0555 has three now, 0901 one.
        expect(view.offices.find((o: { code: string }) => o.code === '0555')).toMatchObject({ members: 3, signedIn7d: 1, signedIn30d: 1 });
        expect(view.offices.find((o: { code: string }) => o.code === '0901')).toMatchObject({ members: 1, signedIn7d: 1 });
        // Prudential's 19 memberships are 18 people, 13 of them signed in this week — Agus once.
        expect(view.companies.find((c: { name: string }) => c.name === 'Prudential'))
          .toMatchObject({ offices: 2, members: 18, signedIn7d: 13, signedIn30d: 14 });
        expect(view.companies.find((c: { name: string }) => c.name === 'Allianz Life')).toMatchObject({ offices: 1, members: 1, signedIn7d: 1 });
        // The platform: twenty memberships, eighteen people.
        expect(view.platform).toMatchObject({ offices: 3, companies: 2, members: 18, signedIn7d: 13, signedIn30d: 14 });
        // Rungs, joins and leaves stay the offices' sums: Prudential's rungs hold 19 memberships.
        const prudential = view.companies.find((c: { name: string }) => c.name === 'Prudential');
        expect(prudential.byRung.reduce((n: number, r: { count: number }) => n + r.count, 0)).toBe(19);
      } finally {
        await db().collection('memberships').deleteMany({ note: 'item 6' });
        await db().collection('kpms').deleteOne({ _id: new mongoose.Types.ObjectId(elsewhere) });
        await db().collection('companies').deleteOne({ _id: new mongoose.Types.ObjectId(other) });
      }
    });
  });

  /*
   * **S3: a person who left 0555 and joined 0417** — one account, two memberships (invariant §2): 0555's history is
   * 0555's. 0417's directory and not-logged list read nothing of it, and no 0555 page writes an entry in 0417.
   */
  describe('P18-T1 AC-12 S3 — a person who rejoined in another office', () => {
    it('P18-T1 AC-12 0417 sees none of the 0555 membership’s days or 1:1s; 0555’s pages write nothing in 0417', async () => {
      const userId = new mongoose.Types.ObjectId();
      await db().collection('users').insertOne({
        _id: userId, email: 'rejoined@reporting.test', passwordHash: 'x', fullName: 'Aan Kurnia', status: 'active', deletedAt: null,
      });
      const before = new mongoose.Types.ObjectId();
      const now = new mongoose.Types.ObjectId();
      const shape = { userId: String(userId), orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', depth: 1, deletedAt: null, note: 'S3' };
      await db().collection('memberships').insertMany([
        {
          ...shape, _id: before, kpmId: KPM_B, agentCode: 'PRU-80555', agentSeq: 500, leaderCode: 'REJOIN01', leaderId: office.id.B_AB,
          ancestorIds: [office.id.B_AB], status: 'removed', joinedAt: new Date('2026-01-05T02:00:00Z'), removedAt: new Date('2026-08-01T02:00:00Z'),
        },
        {
          ...shape, _id: now, kpmId: KPM_A, agentCode: 'PRU-80417', agentSeq: 501, leaderCode: 'REJOIN02', leaderId: office.id.OWNER,
          ancestorIds: [office.id.OWNER], status: 'active', joinedAt: new Date('2026-08-15T02:00:00Z'), removedAt: null,
        },
      ]);
      // 0555's history of the person: days logged and a 1:1, recent enough that any leak would show.
      await db().collection('activityLogs').insertMany(['2026-07-30', '2026-07-31'].map((localDate) => ({
        kpmId: KPM_B, membershipId: String(before), localDate, entries: [], totalCount: 0, source: 'self', note: 'S3',
        enteredByMembershipId: String(before), version: 1, frozenAt: null, corrections: [], deletedAt: null,
      })));
      await db().collection('coachingSessions').insertOne({
        kpmId: KPM_B, coachMembershipId: office.id.B_AB, coacheeMembershipId: String(before), status: 'finalized', date: '2026-07-28',
        frozenAt: new Date('2026-07-28T04:00:00Z'), version: 3, deletedAt: null, note: 'S3',
      });
      try {
        // 0417's Owner: the new membership has never logged and never had a 1:1 — here.
        as('OWNER');
        const page = (await http().get('/members').query({ limit: 100 }).expect(200)).body.members;
        expect(page.find((m: { membershipId: string }) => m.membershipId === String(now)))
          .toMatchObject({ fullName: 'Aan Kurnia', lastActivityOn: null, lastActivityDays: null, lastCoachedDays: null });
        expect(JSON.stringify(page)).not.toContain(String(before));
        const silent = (await http().get('/kpm/overview/not-logged').expect(200)).body;
        expect(silent.members[0]).toMatchObject({ membershipId: String(now), name: 'Aan Kurnia', lastLoggedOn: null, daysSince: null });

        // 0555's Owner, through every page that writes an entry: none lands in 0417, none names the 0417 membership.
        session.current = office.ownerOfB();
        const since = await mark();
        const removed = (await http().get('/members').query({ status: 'removed' }).expect(200)).body.members;
        expect(removed.map((m: { membershipId: string }) => m.membershipId)).toEqual([String(before)]);
        for (const path of ['/members', '/kpm/overview', '/kpm/overview/not-logged']) await http().get(path).expect(200);
        const written = await entriesSince(since);
        expect(written.length).toBeGreaterThan(0);
        expect(written.filter((e) => e.kpmId !== KPM_B)).toEqual([]);
        expect(written.map((e) => e.targetMembershipId)).not.toContain(String(now));
        expect(written.map((e) => e.targetMembershipId)).not.toContain(String(before));
        expect(await db().collection('auditLog').countDocuments({ _id: { $gt: since! }, kpmId: KPM_A })).toBe(0);
      } finally {
        await db().collection('memberships').deleteMany({ note: 'S3' });
        await db().collection('activityLogs').deleteMany({ note: 'S3' });
        await db().collection('coachingSessions').deleteMany({ note: 'S3' });
        await db().collection('users').deleteOne({ _id: userId });
      }
    });
  });
});
