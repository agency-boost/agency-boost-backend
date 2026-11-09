import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { MemberPerformanceController } from './member-performance.controller';
import { MemberPerformanceService } from './member-performance.service';

const M = 1_000_000 * 100;

/**
 * **P19.3-T4 — a member's four tiles over HTTP** (ADR-0205 §1–§2; OWN UI-020, OWN R4, OD-256's OQ3): `GET
 * /members/:membershipId/performance` through the real `PermissionsGuard`, the production pipe and the real services over
 * `test/coaching-office.ts`'s office, on Monday 14 September 2026 in Jakarta.
 *
 * - **AC-1**: each figure is the one another screen shows for the same person, through the same function — the
 *   coaching session's Activity card (`ActivityService.weekOf`), the Unit Dashboard's goal cell for the year and its
 *   *Leads penjualan* and *Closing* for the month — **the office's figure only, never an estimate**.
 * - **AC-2**: an agent (Indah Permatasari), an AAB (Sari Puspita) and an AB (Agus) are each answered.
 * - **AC-3**: the Owner, an Admin and the member's uplines are answered; anybody else in the office, another office's
 *   member and a malformed id are 404; an Agent is 403, whether or not they lead somebody. Every read of somebody else
 *   writes one §3.5 entry, surface `member_performance`; a self-read writes none.
 */
describe('P19.3-T4 a member’s four tiles over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const as = (who: Who) => { session.current = office.as(who); };
  const tiles = (membershipId: string) => request(app.getHttpServer()).get(`/members/${membershipId}/performance`);
  const db = () => mongoose.connection.db!;
  const entries = () => db().collection('auditLog')
    .find({ action: SUBJECT_READ_ACTION, 'after.surface': 'member_performance' }).toArray();

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);

    // Indah's leads: two open sales leads, one of them reaching *Paid and issued* this month, and one closed last
    // month — so *Leads* is 2 and *n closing* 1. A recruitment lead counts in neither.
    const lead = (name: string, extra: Record<string, unknown>) => ({
      kpmId: KPM_A, ownerMembershipId: office.id.INDAH, name, type: 'sales', outcome: null, statusCode: 'CONTACTED',
      transitions: [], commitments: [], deletedAt: null, ...extra,
    });
    const paid = (at: string) => ({ toStatusCode: 'PAID_AND_ISSUED', at: new Date(at), byMembershipId: office.id.INDAH });
    await db().collection('leads').insertMany([
      lead('Bu Ratna', {}),
      lead('Pak Joko', { statusCode: 'PAID_AND_ISSUED', transitions: [paid('2026-09-03T03:00:00Z')] }),
      lead('Bu Wati', { outcome: 'won', statusCode: 'PAID_AND_ISSUED', transitions: [paid('2026-08-20T03:00:00Z')] }),
      lead('Kandidat', { type: 'recruitment', statusCode: 'PROSPECT' }),
    ]);
    // Budi's own estimate (ADR-0183): typed on his plan, with nothing on the office's file for him.
    await db().collection('goals').insertOne({
      kpmId: KPM_A, membershipId: office.id.BUDI, period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M,
      savingsTargetMinor: 0, commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 120 * M,
      apeAchievedTypedBy: office.id.BUDI, apeAchievedTypedAt: new Date('2026-09-01T02:00:00Z'),
      caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
      snapshot: { monthlyApeTargetMinor: 100 * M, policiesPerMonth: 6, appointmentsPerMonth: 20, leadsPerMonth: 67 },
      cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
      savedAt: new Date('2026-01-05T02:00:00Z'), savedByMembershipId: office.id.BUDI, revisions: [], version: 1,
      deletedAt: null, createdAt: new Date('2026-01-05T02:00:00Z'), updatedAt: new Date('2026-01-05T02:00:00Z'),
      createdBy: office.id.BUDI, updatedBy: office.id.BUDI,
    });

    const performance = new MemberPerformanceService(
      wired.coach, new TenantDay(wired.kpms as never, wired.clock), wired.activityLogs, wired.productionReadings,
      wired.goals, wired.coachingReadings, wired.leadReadings, wired.subjectReads,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [MemberPerformanceController],
      providers: [{ provide: MemberPerformanceService, useValue: performance }],
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

  beforeEach(async () => {
    await db().collection('auditLog').deleteMany({});
  });

  it('P19.3-T4 AC-3 declares the new grant on the route', () => {
    expect(declaredPermissions(MemberPerformanceController)).toEqual({ read: 'member:read_performance' });
  });

  describe('AC-1, AC-2 the four tiles, each the figure another screen shows', () => {
    it('P19.3-T4 AC-1 an agent (Indah Permatasari): 7 days of activity, production against her goal, her last 1:1, her leads', async () => {
      as('OWNER');
      const res = await tiles(office.id.INDAH).expect(200);
      expect(res.body).toEqual({
        membershipId: office.id.INDAH,
        today: ROSTER_TODAY,
        // 8, 9 and 10 September logged, 39 a day (2 leads contacted, 37 recruiting follow-ups); nothing since.
        activity: { from: '2026-09-08', to: ROSTER_TODAY, count: 117 },
        // Rp 240 M of Rp 500 M on the office's file: 48 %.
        production: { year: '2026', actualMinor: 240 * M, targetMinor: 500 * M, attainmentPct: 48, goalSet: true },
        lastOneOnOne: { date: '2026-09-10' },
        leads: { month: '2026-09', open: 2, closing: 1 },
      });
    });

    it('P19.3-T4 AC-1 each figure is the one the coaching session and the Unit Dashboard read for her, by their own functions', async () => {
      as('AGUS');
      const res = await tiles(office.id.INDAH).expect(200);
      const ctx = office.as('AGUS');
      const week = await wired.activityLogs.weekOf(ctx, { membershipId: office.id.INDAH, orgLevelCode: 'AGENT' });
      expect(res.body.activity).toEqual({ from: week.from, to: week.to, count: week.totalCount });

      const row = async (period: 'month' | 'year') => {
        const view = await wired.unitDashboard.read(ctx, { period });
        if (view.empty) throw new Error('Agus leads people');
        return view.yourUnit.rows.find((r) => r.membershipId === office.id.INDAH)!;
      };
      const month = await row('month');
      expect(res.body.leads).toMatchObject({ open: month.leadsCounts.salesOpen, closing: month.closings });
      const year = await row('year');
      expect(res.body.production).toMatchObject({
        actualMinor: year.goal.actualMinor, targetMinor: year.goal.targetMinor, attainmentPct: year.goal.attainmentPct,
      });
    });

    it('P19.3-T4 AC-1 production is the office’s figure only: a member’s own estimate reads as nothing uploaded', async () => {
      as('OWNER');
      const res = await tiles(office.id.BUDI).expect(200);
      // Budi typed Rp 120 M as his own estimate; the office holds nothing for him.
      expect(res.body.production).toEqual({
        year: '2026', actualMinor: null, targetMinor: 500 * M, attainmentPct: null, goalSet: true,
      });
      // His last 1:1 was with a coach whose membership has gone: still his (ADR-0082).
      expect(res.body.lastOneOnOne).toEqual({ date: '2026-09-12' });
    });

    it('P19.3-T4 AC-2 an AAB (Sari Puspita): production with no goal saved reads no goal, and her 1:1 with Agus', async () => {
      as('OWNER');
      const res = await tiles(office.id.SARI).expect(200);
      expect(res.body.production).toEqual({
        year: '2026', actualMinor: 250 * M, targetMinor: null, attainmentPct: null, goalSet: false,
      });
      expect(res.body.lastOneOnOne).toEqual({ date: '2026-09-02' });
      expect(res.body.leads).toEqual({ month: '2026-09', open: 0, closing: 0 });
    });

    it('P19.3-T4 AC-2 an AB (Agus): never coached, nothing logged, nothing on file', async () => {
      as('OWNER');
      const res = await tiles(office.id.AGUS).expect(200);
      expect(res.body).toMatchObject({
        activity: { count: 0 },
        production: { actualMinor: null, goalSet: false, attainmentPct: null },
        lastOneOnOne: null,
        leads: { open: 0, closing: 0 },
      });
    });
  });

  describe('AC-3 who reads them — a positive and a negative per role', () => {
    it.each([
      ['the Owner', 'OWNER', 'INDAH'],
      ['an Admin, who is above nobody', 'ADMIN', 'INDAH'],
      ['an AB, for a direct agent', 'AGUS', 'INDAH'],
      ['an AB, for an agent two levels down', 'AGUS', 'RINA'],
      ['an AAB, for her agent', 'SARI', 'RINA'],
      ['an AAB, for an agent in a nested unit', 'SARI', 'DODI'],
      ['the Owner, for somebody who has left (the office’s history)', 'OWNER', 'LEFT'],
    ] as const)('P19.3-T4 AC-3 positive: %s', async (_, reader, member) => {
      as(reader);
      expect((await tiles(office.id[member]).expect(200)).body.membershipId).toBe(office.id[member]);
    });

    it('P19.3-T4 AC-3 positive: a leader reads their own', async () => {
      as('AGUS');
      await tiles(office.id.AGUS).expect(200);
    });

    it.each([
      ['an AAB, for a peer’s agent', 'SARI', 'INDAH'],
      ['an AAB who leads nobody', 'DEWI', 'INDAH'],
      ['a peer AB', 'PEER_AB', 'INDAH'],
      ['an AB, for their own leader', 'AGUS', 'OWNER'],
      ['an AB, for somebody who has left', 'AGUS', 'LEFT'],
    ] as const)('P19.3-T4 AC-3 negative: anybody else in the office is 404 — %s', async (_, reader, member) => {
      as(reader);
      expect((await tiles(office.id[member]).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it.each(['INDAH', 'LUKAS'] as const)(
      'P19.3-T4 AC-3 negative: an Agent (%s) is 403, whether or not they lead somebody, their own included',
      async (who) => {
        as(who);
        const res = await tiles(office.id[who === 'LUKAS' ? 'TARI' : 'INDAH']).expect(403);
        expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'member:read_performance' } });
      },
    );

    it('P19.3-T4 AC-3 negative: a Super Admin holds no grant here', async () => {
      session.current = SUPER_ADMIN;
      expect((await tiles(office.id.INDAH).expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P19.3-T4 AC-3 cross-tenant: another office’s member is 404, read from either side', async () => {
      for (const [reader, member] of [['OWNER', 'B_AGENT'], ['ADMIN', 'B_AB'], ['AGUS', 'B_AGENT'], ['B_AB', 'INDAH']] as const) {
        as(reader);
        expect([reader, member, (await tiles(office.id[member])).status]).toEqual([reader, member, 404]);
      }
    });

    it('P19.3-T4 AC-3 negative: a malformed id is 404, never 500', async () => {
      as('OWNER');
      expect((await tiles('not-an-id').expect(404)).body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('AC-3 the §3.5 entry', () => {
    it('P19.3-T4 AC-3 a read of somebody else writes one entry, surface `member_performance`, over the year to date', async () => {
      as('OWNER');
      await tiles(office.id.INDAH).expect(200);
      const written = await entries();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        targetMembershipId: office.id.INDAH, after: { surface: 'member_performance', from: '2026-01-01', to: ROSTER_TODAY },
      });
    });

    it('P19.3-T4 AC-3 a self-read writes none, and a refused read writes none', async () => {
      as('AGUS');
      await tiles(office.id.AGUS).expect(200);
      as('SARI');
      await tiles(office.id.INDAH).expect(404);
      expect(await entries()).toHaveLength(0);
    });
  });
});
