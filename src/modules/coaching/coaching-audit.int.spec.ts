import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION, type SubjectReadSurface } from '@/modules/audit/subject-read-audit';
import { ActivityController } from '@/modules/activity/activity.controller';
import { ActivityService } from '@/modules/activity/activity.service';
import { GoalController } from '@/modules/goals/goal.controller';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadController } from '@/modules/leads/lead.controller';
import { LeadService } from '@/modules/leads/lead.service';
import { SummaryController } from '@/modules/summary/summary.controller';
import { SummaryService } from '@/modules/summary/summary.service';
import { startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { CoachingController } from './coaching.controller';
import { CoachingProfileController } from './coaching-profile.controller';
import { CoachingProfileService } from './coaching-profile.service';
import { CoachingRecordController } from './coaching-record.controller';
import { CoachingRecordService } from './coaching-record.service';
import { CoachingRosterService } from './coaching-roster.service';
import { CoacheeService } from './coachee.service';
import { CoachingSessionService } from './coaching-session.service';
import { LeaderNoteService } from './leader-note.service';

type Doc = Record<string, unknown>;

/** What each route is given: the reader's coachee, and a session finalized with them before the route runs. */
interface Given {
  coachee: string;
  sessionId: string;
  version: number;
  /** The coachee's one lead. */
  leadId: string;
}

/**
 * One route, called by `who` about `given.coachee`. `setup` runs before the log is cleared, for a route
 * that needs a state its own call would otherwise record — a draft to finalize, a session to reopen.
 */
interface Route {
  route: string;
  call: (http: () => ReturnType<typeof request>, given: Given) => request.Test;
  setup?: (given: Given) => Promise<Given>;
  /** The §3.5 entry a coach's call writes, or `null` for none, as `functional/coaching.md`'s inventory says. */
  surface: SubjectReadSurface | null;
}

/**
 * **Exit criterion 2: every route that answers a coachee's data to a coach writes the §3.5 entry, and a
 * self-read writes none — asserted per route, not per module** (the phase file's *Exit criteria*;
 * `functional/coaching.md`, *Every coach read of a coachee's data writes the §3.5 entry*, the inventory).
 *
 * One table of routes, through the real `PermissionsGuard`, the production pipe and the real services over
 * `test/coaching-office.ts`'s office, run for two coaches — an AB reading a direct agent, and an AAB reading
 * hers — and for each coachee reading their own. Each route either writes **exactly one** entry, with the
 * coach as actor, the coachee as `targetMembershipId` and the inventory's surface, or — where the
 * inventory says *None* — writes no `activity_log.read_raw` entry at all. A route added to coaching joins
 * this table, or the criterion stops holding as written.
 */
describe('exit criterion 2: the §3.5 entry, per route (P11-T10 AC-7)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let clock: FixedClock;
  const kept: Record<string, Doc[]> = {};
  const RESTORED = ['coachingSessions', 'goals', 'activityLogs', 'leads', 'monthlyAgentData', 'memberships'];

  const col = (name: string) => mongoose.connection.db!.collection(name);
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };

  /** A finalized session of `coach`'s with `coachee`, over the routes a coach uses. */
  async function finalized(coach: Who, coachee: string): Promise<{ sessionId: string; version: number }> {
    as(coach);
    const started = (await http().post(`/coaching/coachees/${coachee}/sessions`).expect(201)).body;
    const saved = (await http().put(`/coaching/sessions/${started.sessionId}`).send({
      version: started.version, lastWeekItems: [], actionItems: [{ text: 'Book two presentations', dueDate: '2026-09-20' }], tips: [],
    }).expect(200)).body;
    const done = (await http().post(`/coaching/sessions/${started.sessionId}/finalize`).send({ version: saved.version }).expect(200)).body;
    return { sessionId: done.sessionId, version: done.version };
  }

  const subjectReads = () => col('auditLog').find({ action: SUBJECT_READ_ACTION }).toArray();

  /** Every route in the inventory that a coach calls about a coachee. */
  const COACH_ROUTES: Route[] = [
    { route: 'GET /summary?for=', surface: 'personal_summary', call: (h, g) => h().get('/summary').query({ for: g.coachee }) },
    { route: 'GET /activity/ratios?for=', surface: 'ratios', call: (h, g) => h().get('/activity/ratios').query({ for: g.coachee }) },
    { route: 'GET /activity/summary?membershipId=', surface: 'summary', call: (h, g) => h().get('/activity/summary').query({ membershipId: g.coachee }) },
    { route: 'GET /activity/log?membershipId=', surface: 'log', call: (h, g) => h().get('/activity/log').query({ membershipId: g.coachee }) },
    // P13.1-T9: the *Activity* tab, a coachee's Dashboard.
    { route: 'GET /activity/dashboard?for=', surface: 'activity_dashboard', call: (h, g) => h().get('/activity/dashboard').query({ for: g.coachee }) },
    { route: 'GET /leads?owner=', surface: 'leads', call: (h, g) => h().get('/leads').query({ owner: g.coachee }) },
    // The downline's rows are *Leads milik: Tim* since P19.9-T1 (ADR-0232 §3); the entry is as it was.
    { route: 'GET /leads?scope=team, a leader’s list (ADR-0089)', surface: 'leads', call: (h) => h().get('/leads').query({ scope: 'team' }) },
    // Phase 11 exit review, N2: one lead of the coachee's, opened by its id.
    { route: 'GET /leads/:id (N2), a lead the reader does not own', surface: 'leads', call: (h, g) => h().get(`/leads/${g.leadId}`) },
    { route: 'GET /coaching/sessions/:sessionId', surface: 'coaching_session', call: (h, g) => h().get(`/coaching/sessions/${g.sessionId}`) },
    {
      route: 'POST /coaching/coachees/:membershipId/sessions (Start)', surface: 'coaching_session',
      // The coach's 1:1 with them is finalized, so *Start* opens a new draft.
      call: (h, g) => h().post(`/coaching/coachees/${g.coachee}/sessions`),
    },
    {
      route: 'POST /coaching/sessions/:sessionId/finalize', surface: 'coaching_session',
      setup: async (g) => {
        const started = (await http().post(`/coaching/coachees/${g.coachee}/sessions`).expect(201)).body;
        const saved = (await http().put(`/coaching/sessions/${started.sessionId}`).send({
          version: started.version, lastWeekItems: [], actionItems: [{ text: 'Call two leads', dueDate: '2026-09-21' }], tips: [],
        }).expect(200)).body;
        return { ...g, sessionId: started.sessionId, version: saved.version };
      },
      call: (h, g) => h().post(`/coaching/sessions/${g.sessionId}/finalize`).send({ version: g.version }),
    },
    {
      route: 'POST /coaching/sessions/:sessionId/reopen', surface: 'coaching_session',
      call: (h, g) => h().post(`/coaching/sessions/${g.sessionId}/reopen`).send({ version: g.version, reason: 'A date was wrong.' }),
    },
    { route: 'GET /coaching/sessions/:sessionId/print', surface: 'coaching_session_print', call: (h, g) => h().get(`/coaching/sessions/${g.sessionId}/print`) },
    // **None**, each for the inventory's reason.
    { route: 'GET /coaching/coachees — verdicts, no figure', surface: null, call: (h) => h().get('/coaching/coachees') },
    { route: 'GET /coaching/coachees/:membershipId — directory facts', surface: null, call: (h, g) => h().get(`/coaching/coachees/${g.coachee}`) },
    { route: 'GET /coaching/coachees/:membershipId/sessions — dates, coaches, counts', surface: null, call: (h, g) => h().get(`/coaching/coachees/${g.coachee}/sessions`) },
    { route: 'GET /coaching/coachees/:membershipId/profile — the coaches’ own assessment', surface: null, call: (h, g) => h().get(`/coaching/coachees/${g.coachee}/profile`) },
    { route: 'GET /coaching/coachees/:membershipId/leader-notes — the note entry, never this one', surface: null, call: (h, g) => h().get(`/coaching/coachees/${g.coachee}/leader-notes`) },
    { route: 'GET /goals/:period?for= — no activity left in it', surface: null, call: (h, g) => h().get('/goals/2026').query({ for: g.coachee }) },
    {
      route: 'PUT /coaching/sessions/:sessionId — a draft save answers only what the coach wrote', surface: null,
      setup: async (g) => {
        const started = (await http().post(`/coaching/coachees/${g.coachee}/sessions`).expect(201)).body;
        return { ...g, sessionId: started.sessionId, version: started.version };
      },
      call: (h, g) => h().put(`/coaching/sessions/${g.sessionId}`).send({ version: g.version, lastWeekItems: [], actionItems: [], tips: [] }),
    },
    { route: 'GET /coaching/me/sessions — the reader’s own', surface: null, call: (h) => h().get('/coaching/me/sessions') },
  ];

  /** The same reads, by the coachee about themselves: a self-read writes none on any of them. */
  const SELF_ROUTES: Route[] = [
    { route: 'GET /summary', surface: null, call: (h) => h().get('/summary') },
    { route: 'GET /summary?for= themselves', surface: null, call: (h, g) => h().get('/summary').query({ for: g.coachee }) },
    { route: 'GET /activity/ratios?for= themselves', surface: null, call: (h, g) => h().get('/activity/ratios').query({ for: g.coachee }) },
    { route: 'GET /activity/summary?membershipId= themselves', surface: null, call: (h, g) => h().get('/activity/summary').query({ membershipId: g.coachee }) },
    { route: 'GET /activity/log', surface: null, call: (h) => h().get('/activity/log') },
    { route: 'GET /activity/dashboard?for= themselves', surface: null, call: (h, g) => h().get('/activity/dashboard').query({ for: g.coachee }) },
    { route: 'GET /leads?owner= themselves', surface: null, call: (h, g) => h().get('/leads').query({ owner: g.coachee }) },
    { route: 'GET /leads', surface: null, call: (h) => h().get('/leads') },
    { route: 'GET /leads/:id (N2), their own', surface: null, call: (h, g) => h().get(`/leads/${g.leadId}`) },
    { route: 'GET /coaching/sessions/:sessionId, their own', surface: null, call: (h, g) => h().get(`/coaching/sessions/${g.sessionId}`) },
    { route: 'GET /coaching/sessions/:sessionId/print, their own', surface: null, call: (h, g) => h().get(`/coaching/sessions/${g.sessionId}/print`) },
    { route: 'GET /coaching/me/sessions', surface: null, call: (h) => h().get('/coaching/me/sessions') },
    { route: 'GET /goals/:period', surface: null, call: (h) => h().get('/goals/2026') },
  ];

  /** A coach and the agent they read: an AB's direct agent, and an AAB's. */
  const PAIRS: [coach: Who, coachee: Who][] = [['AGUS', 'INDAH'], ['SARI', 'RINA']];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    clock = wired.clock as FixedClock;
    office = await buildCoachingOffice(wired);
    await syncIndexes();
    for (const name of RESTORED) kept[name] = await col(name).find().toArray();

    const moduleRef = await Test.createTestingModule({
      controllers: [
        CoachingController, CoachingRecordController, CoachingProfileController,
        SummaryController, ActivityController, LeadController, GoalController,
      ],
      providers: [
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
        { provide: CoachingRecordService, useValue: wired.coachingRecord },
        { provide: CoachingProfileService, useValue: wired.coachingProfile },
        { provide: LeaderNoteService, useValue: wired.leaderNotes },
        { provide: SummaryService, useValue: wired.summary },
        { provide: ActivityService, useValue: wired.activityLogs },
        { provide: LeadService, useValue: wired.leadRecords },
        { provide: GoalService, useValue: wired.goals },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  beforeEach(async () => {
    clock.set(ROSTER_NOW);
    for (const name of RESTORED) {
      await col(name).deleteMany({});
      if (kept[name].length) await col(name).insertMany(kept[name].map((doc) => ({ ...doc })));
    }
    await col('auditLog').deleteMany({});
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  /** The coachee's one lead, so their leads and a leader's list hold a row of theirs; a session finalized with them. */
  async function given(coach: Who, coachee: Who): Promise<Given> {
    const membershipId = office.id[coachee];
    const leadId = new mongoose.Types.ObjectId();
    await col('leads').insertOne({
      _id: leadId, kpmId: KPM_A, ownerMembershipId: membershipId, type: 'sales', name: 'Pak Hendro Gunawan',
      contact: { phone: null, email: null }, lawfulBasis: null, consentAt: null, statusCode: 'FOLLOW_UP', statusId: null,
      commitments: [], remarks: null, nextActionDate: '2026-09-17', nextActionNote: null, outcome: null, outcomeAt: null,
      dateRegistered: new Date('2026-09-01T02:00:00Z'), source: null, version: 1, transitions: [], deletedAt: null,
      createdBy: membershipId, updatedBy: membershipId,
    });
    return { coachee: membershipId, leadId: String(leadId), ...(await finalized(coach, membershipId)) };
  }

  describe.each(PAIRS)('%s reading %s', (coach, coachee) => {
    it.each(COACH_ROUTES.map((r) => [r.route, r] as const))('P11-T10 AC-7 %s', async (_route, row) => {
      let g = await given(coach, coachee);
      as(coach);
      if (row.setup) g = await row.setup(g);
      await col('auditLog').deleteMany({});

      const res = await row.call(http, g);

      // *Start* answers 201 for the draft it opens; every other route 200.
      const expected = row.route.startsWith('POST /coaching/coachees/') ? 201 : 200;
      expect([row.route, res.status, res.status === expected ? null : res.body]).toEqual([row.route, expected, null]);
      const entries = await subjectReads();
      if (row.surface === null) {
        expect(entries).toEqual([]);
      } else {
        // Exactly one: the coach read this coachee's data once, on the inventory's surface.
        expect(entries.map((e) => [e.actorMembershipId, e.targetMembershipId, e.targetCollection, (e.after as Doc).surface]))
          .toEqual([[office.id[coach], g.coachee, 'memberships', row.surface]]);
      }
    });
  });

  describe.each(PAIRS)('%s’s coachee %s reading their own', (coach, coachee) => {
    it.each(SELF_ROUTES.map((r) => [r.route, r] as const))('P11-T10 AC-7 a self-read writes none: %s', async (_route, row) => {
      const g = await given(coach, coachee);
      as(coachee);
      await col('auditLog').deleteMany({});

      const res = await row.call(http, g);

      expect([row.route, res.status, res.status === 200 ? null : res.body]).toEqual([row.route, 200, null]);
      expect(await subjectReads()).toEqual([]);
    });
  });

  it('P11-T10 AC-7 the inventory’s ranges: a session’s entries run to its date, the Summary’s and the leads’ from no date', async () => {
    const g = await given('AGUS', 'INDAH');
    as('AGUS');
    await col('auditLog').deleteMany({});
    await http().get(`/coaching/sessions/${g.sessionId}`).expect(200);
    await http().get(`/coaching/sessions/${g.sessionId}/print`).expect(200);
    await http().get('/summary').query({ for: g.coachee }).expect(200);
    await http().get('/leads').query({ owner: g.coachee }).expect(200);
    await http().get(`/leads/${g.leadId}`).expect(200);

    expect((await subjectReads()).map((e) => e.after)).toEqual([
      { surface: 'coaching_session', from: null, to: ROSTER_TODAY },
      { surface: 'coaching_session_print', from: null, to: ROSTER_TODAY },
      { surface: 'personal_summary', from: null, to: ROSTER_TODAY },
      { surface: 'leads', from: null, to: ROSTER_TODAY },
      { surface: 'leads', from: null, to: ROSTER_TODAY },
    ]);
  });
});
