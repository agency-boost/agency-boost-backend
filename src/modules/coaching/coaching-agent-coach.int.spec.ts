import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { ActivityController } from '@/modules/activity/activity.controller';
import { ActivityService } from '@/modules/activity/activity.service';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { GoalController } from '@/modules/goals/goal.controller';
import { GoalService } from '@/modules/goals/goal.service';
import { LeadController } from '@/modules/leads/lead.controller';
import { LeadService } from '@/modules/leads/lead.service';
import { SummaryController } from '@/modules/summary/summary.controller';
import { SummaryService } from '@/modules/summary/summary.service';
import { CoachingSurveyController } from '@/modules/surveys/coaching-survey.controller';
import { CoachingSurveyService } from '@/modules/surveys/coaching-survey.service';
import { startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { NO_CLASS, productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, type CoachingOffice, type Who,
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
/** Somebody the office fixture holds, or Wawan, whom this spec adds below Tari. */
type Person = Who | 'WAWAN';

const M = 1_000_000 * 100;

/**
 * **Every upline coaches, an Agent who leads included** (P19.9-T6 AC-1 to AC-4; ADR-0234, OD-287; the owner's R13,
 * *"semua downline seharusnya bisa dicoaching oleh semua uplinenya"*; roles §3.8, §7.2's
 * `agent_upline_coaches_their_downline`).
 *
 * Over `test/coaching-office.ts`'s office, through the real `PermissionsGuard`, the production pipe and the real
 * services, with one member added: **Wawan, Tari's agent**, so Lukas — an agent who leads Tari — stands two levels above
 * somebody. The coaching routes over HTTP, the person tabs' reads through their services (their routes' guards are the
 * same `can()`, which `permissions.spec.ts` pins cell by cell) — and, since the Phase 19.9 exit review (M2), the widened
 * Agent grants' own routes over HTTP too: leads, goals, the Summary and the activity reads, with their §3.5 entries:
 *
 * ```
 * AGUS (AB) ── LUKAS (Agent) ── TARI (Agent) ── WAWAN (Agent)      this spec's line
 * AGUS (AB) ── INDAH, DIMAS                                          Lukas's colleagues: outside his downline
 * ```
 */
describe('P19.9-T6 — every upline coaches: an Agent who leads, over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let wawan: string;
  const kept: Record<string, Doc[]> = {};
  const RESTORED = ['coachingSessions', 'coachingProfiles', 'leaderNotes', 'auditLog', 'leads', 'goals'];

  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);
  const http = () => request(app.getHttpServer());
  const id = (who: Person) => (who === 'WAWAN' ? wawan : office.id[who]);
  const as = (who: Who) => { session.current = office.as(who); };

  const coachee = (who: Person) => http().get(`/coaching/coachees/${id(who)}`);
  const start = (who: Person) => http().post(`/coaching/coachees/${id(who)}/sessions`);
  const save = (sessionId: string, version: number) => http().put(`/coaching/sessions/${sessionId}`)
    .send({ version, lastWeekItems: [], actionItems: [{ text: 'Book two presentations', dueDate: '2026-09-20' }], tips: [] });
  const finalize = (sessionId: string, version: number) => http().post(`/coaching/sessions/${sessionId}/finalize`).send({ version });
  const reopen = (sessionId: string, version: number) =>
    http().post(`/coaching/sessions/${sessionId}/reopen`).send({ version, reason: 'A date was wrong.' });
  const print = (sessionId: string) => http().get(`/coaching/sessions/${sessionId}/print`);
  const profile = (who: Person) => http().get(`/coaching/coachees/${id(who)}/profile`);
  const tick = (who: Person) => http().put(`/coaching/coachees/${id(who)}/profile`)
    .send({ version: 0, milestoneCodes: ['SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN'] });
  const note = (who: Person, text = 'LUKAS-NOTE: ask for referrals.') =>
    http().put(`/coaching/coachees/${id(who)}/leader-notes`).send({ version: 0, text });
  const survey = (who: Person) => http().get(`/coaching/${id(who)}/survey`);
  const history = (who: Person) => http().get(`/coaching/coachees/${id(who)}/sessions`);
  const readSession = (sessionId: string) => http().get(`/coaching/sessions/${sessionId}`);

  /** The §3.5 entries a reader's reads wrote, as `[target, surface]` (roles §3.5; `subject-read-audit.ts`). */
  const readsBy = async (who: Person) => (await col('auditLog').find({ action: SUBJECT_READ_ACTION, actorMembershipId: id(who) })
    .toArray()).map((e) => [e.targetMembershipId, e.targetCollection, (e.after as Doc).surface]);

  /** One open sales lead in `who`'s pipeline, written as the leads module stores one. */
  async function leadOf(who: Person, name: string): Promise<string> {
    const leadId = new mongoose.Types.ObjectId();
    await col('leads').insertOne({
      _id: leadId, kpmId: KPM_A, ownerMembershipId: id(who), type: 'sales', name,
      contact: { phone: null, email: null }, lawfulBasis: null, consentAt: null, statusCode: 'FOLLOW_UP', statusId: null,
      commitments: [], remarks: null, nextActionDate: '2026-09-17', nextActionNote: null, outcome: null, outcomeAt: null,
      dateRegistered: new Date('2026-09-01T02:00:00Z'), source: null, version: 1, transitions: [], deletedAt: null,
      createdBy: id(who), updatedBy: id(who),
    });
    return String(leadId);
  }
  const storedLead = (leadId: string) => col('leads').findOne({ _id: new mongoose.Types.ObjectId(leadId) });

  /** A plan for 2026, as Goal Settings saves one (`goal-session.int.spec.ts`'s). */
  const plan = (annualApeTargetMinor: number) => ({
    mode: 'direct', annualApeTargetMinor, savingsTargetMinor: 0, commissionRatePct: 0, monthsLeft: 4,
    apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
  });

  /**
   * **An Owner or an Admin standing on the Agent rung** (the Phase 19.9 exit review, L1): the real case behind *an Owner
   * or an Admin on no rung*, which a membership cannot be — `memberships.role` is `ab | aab | agent`. `who`'s membership,
   * signed in with the office role as well: the Agent class's grants and the office's, nothing else.
   */
  const officeOnAgentRung = (who: Who, role: 'owner' | 'admin') => {
    const base = office.as(who);
    return new RequestContext(base.userId, 'none', {
      ...base.membership!, isKpmOwner: role === 'owner', isKpmAdmin: role === 'admin',
    });
  };

  /**
   * An Owner or an Admin on no rung: the office role, and no hierarchy grant (§1.1). **A synthetic context** — every
   * membership stands on a rung (`memberships.role` is `ab | aab | agent`) — kept as the guard's floor: the office role
   * alone opens no coaching write. The real case is `officeOnAgentRung`, below (the Phase 19.9 exit review, L1).
   */
  const officeOnly = (role: 'owner' | 'admin') => new RequestContext(`u-${role}-office`, 'none', {
    membershipId: new mongoose.Types.ObjectId().toString(), kpmId: KPM_A, orgLevelCode: 'NO_RUNG', hierarchyRole: NO_CLASS,
    status: 'active', isKpmOwner: role === 'owner', isKpmAdmin: role === 'admin', directCount: 0,
  });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    office = await buildCoachingOffice(wired);

    // Wawan, Tari's agent: the membership cache the org services write — `leaderId`, `ancestorIds`, `depth`.
    const tari = (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.TARI) }))!;
    const userId = new mongoose.Types.ObjectId();
    await col('users').insertOne({
      _id: userId, email: 'wawan@coaching.test', passwordHash: 'x', fullName: 'Wawan Setiawan', status: 'active',
      platformRole: 'none', agentCode: 'PRU-79901', deletedAt: null,
    });
    const membershipId = new mongoose.Types.ObjectId();
    await col('memberships').insertOne({
      _id: membershipId, kpmId: KPM_A, userId: String(userId), agentCode: 'PRU-79901', agentSeq: 99, leaderCode: 'LWAWAN',
      orgLevelId: new mongoose.Types.ObjectId().toString(), orgLevelCode: 'AGENT', role: 'agent',
      leaderId: office.id.TARI, ancestorIds: [...(tari.ancestorIds as string[]), office.id.TARI],
      depth: (tari.ancestorIds as string[]).length + 1, directCounts: { total: 0 }, subtreeCount: 0,
      status: 'active', joinedAt: new Date('2026-03-02T02:00:00Z'), deletedAt: null,
    });
    wawan = String(membershipId);

    await syncIndexes();
    for (const name of RESTORED) kept[name] = await col(name).find().toArray();

    const moduleRef = await Test.createTestingModule({
      controllers: [
        CoachingController, CoachingProfileController, CoachingRecordController, CoachingSurveyController,
        SummaryController, ActivityController, LeadController, GoalController,
      ],
      providers: [
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
        { provide: CoachingProfileService, useValue: wired.coachingProfile },
        { provide: LeaderNoteService, useValue: wired.leaderNotes },
        { provide: CoachingRecordService, useValue: wired.coachingRecord },
        { provide: CoachingSurveyService, useValue: wired.surveys.coaching },
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
    for (const name of RESTORED) {
      await col(name).deleteMany({});
      if (kept[name].length) await col(name).insertMany(kept[name].map((doc) => ({ ...doc })));
    }
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  describe('AC-1 the coaching routes: an Agent who leads coaches their whole downline', () => {
    it('P19.9-T6 AC-1 the roster answers Lukas his downline at depth 1 and 2, and nobody else', async () => {
      as('LUKAS');
      const res = await http().get('/coaching/coachees').expect(200);
      const rows = [...res.body.directAgents, ...res.body.units.flatMap((u: { head: Doc; members: Doc[] }) => [u.head, ...u.members])];
      expect(rows.map((r: Doc) => [r.membershipId, r.depth])).toEqual([[id('TARI'), 1], [id('WAWAN'), 2]]);
    });

    it.each([
      ['a direct report, depth 1', 'TARI', true],
      ['his report’s report, depth 2', 'WAWAN', false],
    ] as [string, Person, boolean][])('P19.9-T6 AC-1 Lukas coaches %s: the person, start, save, finalize, print and reopen', async (_name, who, direct) => {
      as('LUKAS');
      expect((await coachee(who).expect(200)).body).toMatchObject({ membershipId: id(who), direct });
      const started = (await start(who).expect(201)).body;
      expect(started).toMatchObject({ status: 'draft', coach: { membershipId: id('LUKAS') } });
      const saved = (await save(started.sessionId, started.version).expect(200)).body;
      const done = (await finalize(started.sessionId, saved.version).expect(200)).body;
      expect(done).toMatchObject({ status: 'finalized' });
      await print(started.sessionId).expect(200);
      await reopen(started.sessionId, done.version).expect(200);
      // The history reads it, his as any coach's.
      expect((await http().get(`/coaching/coachees/${id(who)}/sessions`).expect(200)).body.sessions[0])
        .toMatchObject({ coach: { membershipId: id('LUKAS') } });
    });

    it('P19.9-T6 AC-1 Lukas ticks the capability profile and writes a note at depth 2, and reads the Survei tab', async () => {
      as('LUKAS');
      await profile('WAWAN').expect(200);
      await tick('WAWAN').expect(200);
      await note('WAWAN').expect(200);
      expect((await http().get(`/coaching/coachees/${id('WAWAN')}/leader-notes`).expect(200)).body.mine)
        .toMatchObject({ text: 'LUKAS-NOTE: ask for referrals.' });
      expect((await survey('WAWAN').expect(200)).body).toMatchObject({ state: 'none' });
    });

    it.each([
      ['a colleague, outside his downline', 'INDAH'],
      ['his own leader', 'AGUS'],
      ['a peer’s agent', 'PEER_AGENT'],
      ['himself (his own coaching is /coaching/me)', 'LUKAS'],
      ['a member who has left', 'LEFT'],
      ['a member of another office', 'B_AGENT'],
    ] as [string, Who][])('P19.9-T6 AC-1 Lukas is answered 404 on %s, and nothing is written', async (_name, who) => {
      as('LUKAS');
      const before = await col('coachingSessions').countDocuments();
      for (const call of [coachee(who), start(who), profile(who), tick(who), note(who), survey(who)]) {
        const res = await call;
        expect([who, res.status, res.body.error?.code]).toEqual([who, 404, 'NOT_FOUND']);
      }
      expect(await col('coachingSessions').countDocuments()).toBe(before);
      expect(await col('coachingProfiles').countDocuments({ membershipId: id(who) })).toBe(0);
      expect(await col('leaderNotes').countDocuments({ subjectMembershipId: id(who) })).toBe(0);
    });

    it('P19.9-T6 AC-1 an Agent who leads nobody holds the grants and coaches nobody: an empty roster, 404 on anybody', async () => {
      as('INDAH');
      expect((await http().get('/coaching/coachees').expect(200)).body).toMatchObject({ directAgents: [], units: [] });
      for (const call of [coachee('DIMAS'), start('DIMAS'), profile('DIMAS'), note('DIMAS')]) {
        expect((await call).status).toBe(404);
      }
      expect(await col('coachingSessions').countDocuments({ coachMembershipId: id('INDAH') })).toBe(0);
    });

    it('P19.9-T6 AC-1 a session about somebody outside his downline is not his: 404 on reading, printing, the history, finalizing and reopening it — nothing written, no read recorded', async () => {
      // Agus's finalized 1:1 with Indah (the office fixture's), and a draft of his with her.
      const done = (await col('coachingSessions').findOne({ coacheeMembershipId: id('INDAH'), status: 'finalized' }))!;
      as('AGUS');
      const draft = (await start('INDAH').expect(201)).body;
      const before = await col('coachingSessions').find().sort({ _id: 1 }).toArray();

      as('LUKAS');
      for (const [route, call] of [
        ['GET /coaching/sessions/:id, a finalized one', readSession(String(done._id))],
        ['GET /coaching/sessions/:id, a draft', readSession(draft.sessionId)],
        ['GET /coaching/sessions/:id/print', print(String(done._id))],
        ['GET /coaching/coachees/:id/sessions', history('INDAH')],
        ['POST /coaching/sessions/:id/finalize', finalize(draft.sessionId, draft.version)],
        ['POST /coaching/sessions/:id/reopen', reopen(String(done._id), done.version as number)],
      ] as [string, request.Test][]) {
        const res = await call;
        expect([route, res.status, res.body.error?.code]).toEqual([route, 404, 'NOT_FOUND']);
      }
      expect(await col('coachingSessions').find().sort({ _id: 1 }).toArray()).toEqual(before);
      expect(await readsBy('LUKAS')).toEqual([]);
    });

    it('P19.9-T6 AC-1 the coachee is not their own coach: Tari, an Agent who leads Wawan, is 404 on herself and coaches Wawan', async () => {
      as('TARI');
      await coachee('TARI').expect(404);
      await profile('TARI').expect(404);
      await http().get(`/coaching/coachees/${id('TARI')}/leader-notes`).expect(404);
      await start('WAWAN').expect(201);
    });
  });

  describe('AC-2 the person’s tabs read their subject for an Agent coach', () => {
    /**
     * Every read a tab makes about the person, through its service — the subject resolved on its own grant. Each is
     * called when it is asked, one at a time, so a refusal is caught where it is awaited.
     */
    const reads = (ctx: RequestContext, member: string): [string, () => Promise<unknown>][] => [
      ['the Personal Summary tab, GET /summary?for=', () => wired.summary.read(ctx, member)],
      ['the ratios, GET /activity/ratios?for=', () => wired.activityLogs.ratios(ctx, member)],
      ['the Activity tab, GET /activity/dashboard?for=', () => wired.activityLogs.dashboard(ctx, { for: member })],
      ['the Activity tab’s Log, GET /activity/log?membershipId=', () => wired.activityLogs.readDay(ctx, { membershipId: member })],
      ['the Goal Setting tab, GET /goals/:period?for=', () => wired.goals.readOrDefaults(ctx, '2026', member)],
      ['the Leads tab, GET /leads?owner=', () => wired.leadRecords.list(ctx, { owner: member })],
      ['the Training tab, GET /training/progress?for=', () => wired.trainingProgress.progress(ctx, member)],
      ['the Summary tab’s chases, GET /campaigns/chasing?for=', () => wired.campaignAgent.chasing(ctx, member)],
    ];
    const outcome = (read: () => Promise<unknown>) => read().then(() => 'answered', (err: { code?: string }) => err.code);

    it.each([['depth 1', 'TARI'], ['depth 2', 'WAWAN']] as [string, Person][])(
      'P19.9-T6 AC-2 every tab answers Lukas about his report at %s — no permission error on any',
      async (_depth, who) => {
        for (const [tab, read] of reads(office.as('LUKAS'), id(who))) {
          expect([tab, await outcome(read)]).toEqual([tab, 'answered']);
        }
      },
    );

    it('P19.9-T6 AC-2 and none answers him about a colleague outside his downline: 404 on each', async () => {
      for (const [tab, read] of reads(office.as('LUKAS'), id('INDAH'))) {
        expect([tab, await outcome(read)]).toEqual([tab, 'NOT_FOUND']);
      }
    });

    it('P19.9-T6 AC-2 nor anybody else about Lukas’s people: a colleague Agent is 404 on each', async () => {
      for (const [tab, read] of reads(office.as('INDAH'), id('TARI'))) {
        expect([tab, await outcome(read)]).toEqual([tab, 'NOT_FOUND']);
      }
    });
  });

  /*
   * **The widened Agent grants, over HTTP** (the Phase 19.9 exit review, M2): P19.9-T6 gave the Agent rung `own-downline`
   * beside `own` on the leads, goal, Summary and activity grants, so an Agent who leads reaches their downline there as an
   * AB does — at any depth — and nobody else, with the read recorded as any leader's is.
   */
  describe('AC-2 the widened Agent grants’ own routes, over HTTP', () => {
    it.each([
      ['his report Tari, depth 1', 'TARI', 200],
      ['Wawan, his report’s report, depth 2', 'WAWAN', 200],
      ['Indah, a colleague outside his downline', 'INDAH', 404],
      ['Agus, his own leader', 'AGUS', 404],
    ] as [string, Person, number][])('P19.9-T6 AC-2 lead:mark_outcome — Lukas closes the lead of %s (%s): %i', async (_name, who, status) => {
      const lead = await leadOf(who, `${who}’s lead`);
      as('LUKAS');
      const res = await http().patch(`/leads/${lead}/outcome`).send({ outcome: 'lost', version: 1 });

      expect([who, res.status]).toEqual([who, status]);
      if (status === 200) {
        expect(await storedLead(lead)).toMatchObject({ outcome: 'lost', version: 2, updatedBy: id('LUKAS') });
      } else {
        expect(res.body.error.code).toBe('NOT_FOUND');
        // Nothing written: the lead as it was, and no closing on the log.
        expect(await storedLead(lead)).toMatchObject({ outcome: null, outcomeAt: null, version: 1, updatedBy: id(who) });
        expect(await col('auditLog').countDocuments({ action: 'lead.closed', targetId: lead })).toBe(0);
      }
    });

    it('P19.9-T6 AC-2 GET /leads?scope=team — his downline at depth 1 and 2, never a colleague’s, his leader’s or his own; one §3.5 entry per owner shown (ADR-0089)', async () => {
      for (const who of ['TARI', 'WAWAN', 'INDAH', 'AGUS', 'LUKAS', 'PEER_AGENT'] as Person[]) await leadOf(who, `Lead of ${who}`);
      as('LUKAS');

      const team = (await http().get('/leads').query({ scope: 'team' }).expect(200)).body.rows as { name: string; owner: Doc }[];
      expect(team.map((r) => [r.name, r.owner.membershipId]).sort()).toEqual([
        ['Lead of TARI', id('TARI')], ['Lead of WAWAN', id('WAWAN')],
      ]);
      expect((await readsBy('LUKAS')).sort()).toEqual([
        [id('TARI'), 'memberships', 'leads'], [id('WAWAN'), 'memberships', 'leads'],
      ].sort());

      // His own list (*Saya*, the default) is his own lead alone, and writes nothing more.
      const own = (await http().get('/leads').expect(200)).body.rows as { name: string }[];
      expect(own.map((r) => r.name)).toEqual(['Lead of LUKAS']);
      expect(await readsBy('LUKAS')).toHaveLength(2);
    });

    it('P19.9-T6 AC-2 at depth 2 — Lukas saves Wawan’s goal, adds a lead to his pipeline and edits it pinned, under his own name', async () => {
      as('LUKAS');
      await http().put('/goals/2026').query({ for: id('WAWAN') }).send(plan(600 * M)).expect(200);
      expect(await col('goals').findOne({ membershipId: id('WAWAN'), period: '2026', deletedAt: null }))
        .toMatchObject({ annualApeTargetMinor: 600 * M, savedByMembershipId: id('LUKAS') });

      const added = (await http().post('/leads').query({ owner: id('WAWAN') }).send({ name: 'Ibu Ratna' }).expect(201)).body;
      await http().patch(`/leads/${added.id}`).send({ remarks: 'Coached by Lukas.', version: added.version }).expect(200);
      expect(await storedLead(added.id)).toMatchObject({
        ownerMembershipId: id('WAWAN'), createdBy: id('LUKAS'), updatedBy: id('LUKAS'), remarks: 'Coached by Lukas.',
      });
    });

    const SUBJECT_READS: [string, string, (member: string) => request.Test][] = [
      ['GET /summary?for=', 'personal_summary', (member) => http().get('/summary').query({ for: member })],
      ['GET /activity/ratios?for=', 'ratios', (member) => http().get('/activity/ratios').query({ for: member })],
      ['GET /activity/log?membershipId=, the raw log', 'log', (member) => http().get('/activity/log').query({ membershipId: member })],
    ];

    it.each(SUBJECT_READS.flatMap(([route, surface, call]) => (['TARI', 'WAWAN'] as Person[]).map((who) => [route, who, surface, call] as const)))(
      'P19.9-T6 AC-2 §3.5 %s about %s writes exactly one entry, Lukas the actor, on the inventory’s surface',
      async (route, who, surface, call) => {
        as('LUKAS');
        const res = await call(id(who));
        expect([route, res.status]).toEqual([route, 200]);
        expect(await readsBy('LUKAS')).toEqual([[id(who), 'memberships', surface]]);
      },
    );

    it.each(SUBJECT_READS)('P19.9-T6 AC-2 §3.5 %s about a colleague outside his downline is 404, and records nothing', async (route, _surface, call) => {
      as('LUKAS');
      const res = await call(id('INDAH'));
      expect([route, res.status, res.body.error?.code]).toEqual([route, 404, 'NOT_FOUND']);
      expect(await readsBy('LUKAS')).toEqual([]);
    });
  });

  describe('AC-4 the office and the leader rungs, unchanged', () => {
    it.each([['the Owner', 'owner'], ['an Admin', 'admin']] as const)(
      'P19.9-T6 AC-4 %s on no rung (synthetic) holds no coaching write: 403 at the guard, and nothing is written', async (_who, role) => {
        session.current = officeOnly(role);
        for (const call of [start('TARI'), tick('TARI'), note('TARI')]) {
          const res = await call;
          expect([res.status, res.body.error.code]).toEqual([403, 'PERM_DENIED']);
        }
        expect(await col('coachingSessions').countDocuments({ coacheeMembershipId: id('TARI') })).toBe(0);
      },
    );

    /*
     * The real case behind *on no rung* (the Phase 19.9 exit review, L1): a membership always stands on a rung, so an Owner
     * or an Admin coaches exactly as the member on theirs does — here the Agent's — and the office role adds nothing.
     */
    it.each([['the Owner', 'owner'], ['an Admin', 'admin']] as const)(
      'P19.9-T6 AC-4 %s on the Agent rung who leads nobody coaches nobody: an empty roster, 404 on every write, nothing written',
      async (_who, role) => {
        session.current = officeOnAgentRung('INDAH', role);
        expect((await http().get('/coaching/coachees').expect(200)).body).toMatchObject({ directAgents: [], units: [] });
        for (const call of [start('DIMAS'), tick('DIMAS'), note('DIMAS'), start('TARI')]) {
          const res = await call;
          expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
        }
        expect(await col('coachingSessions').countDocuments({ coachMembershipId: id('INDAH') })).toBe(0);
        expect(await col('coachingProfiles').countDocuments({ membershipId: { $in: [id('DIMAS'), id('TARI')] } })).toBe(0);
        expect(await col('leaderNotes').countDocuments({ subjectMembershipId: { $in: [id('DIMAS'), id('TARI')] } })).toBe(0);
      },
    );

    it.each([['the Owner', 'owner'], ['an Admin', 'admin']] as const)(
      'P19.9-T6 AC-4 %s on the Agent rung who leads somebody coaches them as that Agent — and nobody else in the office',
      async (_who, role) => {
        session.current = officeOnAgentRung('LUKAS', role);
        const rows = (await http().get('/coaching/coachees').expect(200)).body;
        expect([...rows.directAgents, ...rows.units.flatMap((u: { head: Doc; members: Doc[] }) => [u.head, ...u.members])]
          .map((r: Doc) => r.membershipId)).toEqual([id('TARI'), id('WAWAN')]);
        const started = (await start('WAWAN').expect(201)).body;
        expect(started).toMatchObject({ coach: { membershipId: id('LUKAS') } });
        await tick('TARI').expect(200);
        // The office role reaches nobody the Agent rung does not: a colleague is 404, as for Lukas alone.
        for (const call of [start('INDAH'), tick('INDAH'), note('INDAH')]) expect((await call).status).toBe(404);
        expect(await col('coachingSessions').countDocuments({ coacheeMembershipId: id('INDAH'), coachMembershipId: id('LUKAS') })).toBe(0);
      },
    );

    it('P19.9-T6 AC-4 every upline at once: Agus, two levels above Lukas, still coaches Wawan, beside Lukas’s own draft', async () => {
      as('LUKAS');
      const lukas = (await start('WAWAN').expect(201)).body;
      as('AGUS');
      const agus = (await start('WAWAN').expect(201)).body;
      expect(agus.sessionId).not.toBe(lukas.sessionId);
      // A draft is its coach's alone (ADR-0081): Agus does not read Lukas's.
      await http().get(`/coaching/sessions/${lukas.sessionId}`).expect(404);
    });
  });
});
