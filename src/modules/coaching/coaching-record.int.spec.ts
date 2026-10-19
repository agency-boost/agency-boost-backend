import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { CoachingController } from './coaching.controller';
import { CoachingRecordController } from './coaching-record.controller';
import { CoachingRecordService } from './coaching-record.service';
import { CoachingRosterService } from './coaching-roster.service';
import { CoacheeService } from './coachee.service';
import { CoachingSessionService } from './coaching-session.service';

type Doc = Record<string, unknown>;

/** The print's fields, as the Data contract lists them: no ratios, no activity, no leads table, no note. */
const PRINT_FIELDS = [
  'actionItems', 'coach', 'coachee', 'date', 'goal', 'lastWeekItems', 'leadActions', 'sessionId', 'tips', 'version',
];

/**
 * **The record after the meeting, over HTTP, per role** (P11-T10 AC-3, AC-4, AC-9, AC-10; ADR-0077,
 * ADR-0078, ADR-0088; `functional/coaching.md`, *Archive*, *`/coaching/me`*, *Exports*, the Data contract).
 *
 * `GET /coaching/sessions/:sessionId/print` and `GET /coaching/me/sessions` through the real
 * `PermissionsGuard`, the production pipe and the real services over `test/coaching-office.ts`'s office,
 * beside the session routes that make the sessions they read. Every test starts from the office's fixture
 * sessions again — Agus's with Indah on 10 September and with Sari on 2 September, Sari's with Rina,
 * Budi's with a coach who is gone, and Agus's open draft with Dimas — at 10:00 on 14 September in Jakarta.
 *
 * A former coach whose edge the org services closed is `coaching-session-former-coach.tenancy.spec.ts`'s;
 * the audit of every coaching route, table-driven, is `coaching-audit.int.spec.ts`'s.
 */
describe('the print and /coaching/me over HTTP (P11-T10)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let clock: FixedClock;
  const kept: Record<string, Doc[]> = {};
  const RESTORED = ['coachingSessions', 'goals', 'activityLogs', 'leads', 'monthlyAgentData', 'memberships'];

  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const id = (who: Who) => office.id[who];

  const start = (who: Who, coachee: Who) => { as(who); return http().post(`/coaching/coachees/${id(coachee)}/sessions`); };
  const read = (sessionId: string) => http().get(`/coaching/sessions/${sessionId}`);
  const save = (sessionId: string, body: Doc) => http().put(`/coaching/sessions/${sessionId}`).send(body);
  const finalize = (sessionId: string, version: number) => http().post(`/coaching/sessions/${sessionId}/finalize`).send({ version });
  const reopen = (sessionId: string, version: number) =>
    http().post(`/coaching/sessions/${sessionId}/reopen`).send({ version, reason: 'Two dates were wrong.' });
  const print = (sessionId: string) => http().get(`/coaching/sessions/${sessionId}/print`);
  const mine = () => http().get('/coaching/me/sessions');
  const fixtureSession = async (coach: Who, coachee: Who) =>
    String((await col('coachingSessions').findOne({ coachMembershipId: id(coach), coacheeMembershipId: id(coachee), status: 'finalized' }))!._id);
  const dated = (text = 'Book two presentations', dueDate = '2026-09-20') => ({ text, dueDate });

  /** Start, save the lists, finalize: the session as its coach reads it. */
  async function finalized(
    coach: Who, coachee: Who, lists: { actionItems?: Doc[]; tips?: Doc[]; lastWeekItems?: Doc[] } = {},
  ): Promise<Doc & { sessionId: string; version: number }> {
    const started = (await start(coach, coachee).expect((r) => expect([200, 201]).toContain(r.status))).body;
    const saved = (await save(started.sessionId, {
      version: started.version, lastWeekItems: lists.lastWeekItems ?? [], actionItems: lists.actionItems ?? [dated()],
      tips: lists.tips ?? [],
    }).expect(200)).body;
    return (await finalize(started.sessionId, saved.version).expect(200)).body;
  }

  /** A lead of `owner`'s, as the leads module stores one. */
  async function lead(owner: Who, over: Doc = {}): Promise<string> {
    const _id = new mongoose.Types.ObjectId();
    await col('leads').insertOne({
      _id, kpmId: KPM_A, ownerMembershipId: id(owner), type: 'sales', name: 'Pak Hendro Gunawan',
      contact: { phone: null, email: null }, lawfulBasis: null, consentAt: null, statusCode: 'FOLLOW_UP', statusId: null,
      commitments: [], remarks: null, nextActionDate: null, nextActionNote: null, outcome: null, outcomeAt: null,
      dateRegistered: new Date('2026-09-01T02:00:00Z'), source: null, version: 1, transitions: [], deletedAt: null,
      createdBy: id(owner), updatedBy: id(owner), ...over,
    });
    return String(_id);
  }

  /** Move a member under somebody else in the membership cache, as a re-parent leaves it. */
  async function move(who: Who, under: Who): Promise<void> {
    const leader = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id(under)) });
    await col('memberships').updateOne(
      { _id: new mongoose.Types.ObjectId(id(who)) },
      { $set: { leaderId: id(under), ancestorIds: [...(leader!.ancestorIds as string[]), id(under)] } },
    );
  }

  const exported = () => col('auditLog').find({ action: 'coaching_session.exported' }).toArray();
  const printReads = () => col('auditLog').find({ action: SUBJECT_READ_ACTION, 'after.surface': 'coaching_session_print' }).toArray();

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    clock = wired.clock as FixedClock;
    office = await buildCoachingOffice(wired);
    await syncIndexes();
    for (const name of RESTORED) kept[name] = await col(name).find().toArray();

    const moduleRef = await Test.createTestingModule({
      controllers: [CoachingController, CoachingRecordController],
      providers: [
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
        { provide: CoachingRecordService, useValue: wired.coachingRecord },
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

  it('P11-T10 each route declares the permission the Data contract names', () => {
    expect(declaredPermissions(CoachingRecordController)).toEqual({
      mine: 'coaching_session:read',
      print: 'coaching_session:export_pdf',
    });
  });

  // ------------------------------------------------------------------ the print

  describe('the print (AC-3, ADR-0077)', () => {
    it('P11-T10 AC-3 prints the latest finalized version from its snapshot: what the prototype’s export holds, and nothing else', async () => {
      await lead('INDAH', { nextActionDate: '2026-09-17', nextActionNote: 'Collect the signed SPAJ.' });
      const done = await finalized('AGUS', 'INDAH', {
        lastWeekItems: [{ itemId: 'INDAH-1', done: true }],
        actionItems: [dated('Shadow Sari on one presentation', '2026-09-18')],
        tips: [{ text: 'Ask for the referral before you leave.' }],
      });
      const snapshot = (done.snapshot as { goal: { monthly: Doc; yearly: Doc } }).goal;

      const res = await print(done.sessionId).expect(200);

      expect(res.body).toEqual({
        sessionId: done.sessionId,
        version: done.version,
        // The day it was held, never today's: a Fix of the prototype's date line.
        date: ROSTER_TODAY,
        coachee: { name: 'Indah Permatasari' },
        coach: { name: 'Agus Salim' },
        lastWeekItems: [{ text: 'Book two presentations', done: true }],
        goal: {
          currency: 'IDR',
          monthly: { targetMinor: snapshot.monthly.targetMinor, actualMinor: snapshot.monthly.actualMinor },
          yearly: { targetMinor: snapshot.yearly.targetMinor, actualMinor: snapshot.yearly.actualMinor },
        },
        tips: [{ text: 'Ask for the referral before you leave.' }],
        leadActions: [{ dueDate: '2026-09-17', text: 'Collect the signed SPAJ.', leadName: 'Pak Hendro Gunawan' }],
        actionItems: [{ dueDate: '2026-09-18', text: 'Shadow Sari on one presentation' }],
      });
      expect(Object.keys(res.body).sort()).toEqual(PRINT_FIELDS);
      // Indah has a goal, so the print carries its figures.
      expect(res.body.goal.yearly.targetMinor).toBeGreaterThan(0);
      expect(res.body.goal.monthly.actualMinor).toBeGreaterThan(0);
    });

    it('P11-T10 AC-3 a coachee with no goal prints its targets as null, never 0', async () => {
      const done = await finalized('AGUS', 'LUKAS');
      const res = await print(done.sessionId).expect(200);
      expect(res.body.goal).toMatchObject({ monthly: { targetMinor: null }, yearly: { targetMinor: null } });
    });

    it('P11-T10 AC-3 a session that holds no snapshot prints no goal rather than an invented one', async () => {
      as('AGUS');
      const res = await print(await fixtureSession('AGUS', 'INDAH')).expect(200);
      expect(res.body).toMatchObject({
        date: '2026-09-10', goal: null, lastWeekItems: [], tips: [], leadActions: [],
        actionItems: [{ dueDate: '2026-09-10', text: 'Book two presentations' }],
      });
    });

    it.each([
      ['AGUS', 'its coach'],
      ['OWNER', 'another current coach: the root AB'],
      ['ADMIN', 'the Admin, own-kpm, who leads nobody'],
      ['INDAH', 'the coachee'],
    ] as [Who, string][])('P11-T10 AC-3 %s, %s, prints it: the export is recorded always, the read of her data unless it is hers', async (who) => {
      const done = await finalized('AGUS', 'INDAH');
      await col('auditLog').deleteMany({});
      as(who);

      const res = await print(done.sessionId).expect(200);

      expect(res.body).toMatchObject({ sessionId: done.sessionId, version: done.version, coachee: { name: 'Indah Permatasari' } });
      const exports = await exported();
      expect(exports).toHaveLength(1);
      expect(exports[0]).toMatchObject({
        kpmId: KPM_A, actorMembershipId: id(who), targetCollection: 'coachingSessions', targetId: done.sessionId,
        targetMembershipId: id('INDAH'), after: { version: done.version, date: ROSTER_TODAY, rowCount: 1 },
      });
      const reads = await printReads();
      if (who === 'INDAH') {
        expect(reads).toEqual([]);
      } else {
        expect(reads.map((e) => [e.actorMembershipId, e.targetMembershipId, e.after])).toEqual([
          [id(who), id('INDAH'), { surface: 'coaching_session_print', from: null, to: ROSTER_TODAY }],
        ]);
      }
      // Nothing else: the print is its own read, not the session read's.
      expect(await col('auditLog').countDocuments({ 'after.surface': 'coaching_session' })).toBe(0);
    });

    it.each([
      ['SARI', 'an AAB beside the coach'],
      ['PEER_AB', 'a peer AB'],
      ['PEER_AAB', 'a peer AAB'],
      ['DIMAS', 'another agent'],
      ['B_AB', 'another office'],
    ] as [Who, string][])('P11-T10 AC-9 %s, %s, is 404, and nothing is recorded', async (who) => {
      const done = await finalized('AGUS', 'INDAH');
      await col('auditLog').deleteMany({});
      as(who);
      expect((await print(done.sessionId).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect(await col('auditLog').countDocuments({})).toBe(0);
    });

    it('P11-T10 AC-3 a session never finalized: its coach is told so, anybody else is answered as though it did not exist', async () => {
      const draft = String((await col('coachingSessions').findOne({ coacheeMembershipId: id('DIMAS'), status: 'draft' }))!._id);
      as('AGUS');
      const refused = await print(draft).expect(409);
      expect(refused.body.error).toMatchObject({ code: 'COACHING_SESSION_NOT_FINALIZED', details: { status: 'draft' } });
      for (const who of ['OWNER', 'ADMIN', 'DIMAS', 'SARI'] as Who[]) {
        as(who);
        expect([who, (await print(draft)).status]).toEqual([who, 404]);
      }
      expect(await col('auditLog').countDocuments({})).toBe(0);
    });

    it('P11-T10 AC-9 a session under correction prints the version the correction will replace, until it is finalized', async () => {
      const done = await finalized('AGUS', 'INDAH');
      as('AGUS');
      const reopened = (await reopen(done.sessionId, done.version).expect(200)).body;
      const corrected = (await save(done.sessionId, {
        version: reopened.version, lastWeekItems: [], actionItems: [dated('Book three presentations', '2026-09-21')], tips: [],
      }).expect(200)).body;

      for (const who of ['AGUS', 'INDAH', 'OWNER'] as Who[]) {
        as(who);
        expect([who, (await print(done.sessionId).expect(200)).body]).toMatchObject([who, {
          version: done.version, actionItems: [{ text: 'Book two presentations', dueDate: '2026-09-20' }],
        }]);
      }

      as('AGUS');
      const refinalized = (await finalize(done.sessionId, corrected.version).expect(200)).body;
      clock.set(new Date('2026-09-16T03:00:00Z'));
      as('INDAH');
      expect((await print(done.sessionId).expect(200)).body).toMatchObject({
        version: refinalized.version, date: ROSTER_TODAY, actionItems: [{ text: 'Book three presentations', dueDate: '2026-09-21' }],
      });
    });

    it('P11-T10 a Super Admin holds no grant to print; a read-only support session may, as it is a read; an id that is nobody’s is 404', async () => {
      const done = await finalized('AGUS', 'INDAH');
      session.current = SUPER_ADMIN;
      expect((await print(done.sessionId).expect(403)).body.error.code).toBe('PERM_DENIED');

      const agus = office.as('AGUS');
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      await print(done.sessionId).expect(200);

      as('AGUS');
      await print(new mongoose.Types.ObjectId().toString()).expect(404);
      await print('not-a-session').expect(404);
    });

    it('P11-T10 AC-3 the print fails open (D-failopen): an audit write that throws still answers the print', async () => {
      const done = await finalized('AGUS', 'INDAH');
      const failing = jest.spyOn(wired.audit, 'record').mockRejectedValue(new Error('the audit store is down'));
      try {
        as('AGUS');
        expect((await print(done.sessionId).expect(200)).body.sessionId).toBe(done.sessionId);
        // Both entries were attempted: the export, and the read of Indah's data.
        expect(failing.mock.calls.map(([, entry]) => entry.action)).toEqual(['coaching_session.exported', SUBJECT_READ_ACTION]);
      } finally {
        failing.mockRestore();
      }
    });
  });

  // ------------------------------------------------------------------ B1: lead rows, roles §3.7

  /*
   * Phase 11 exit review, B1: the print answers who may read the session's lead rows as the session read
   * does (`showsLeadsTo`). Maya (ADMIN) leads nobody and prints Indah's session with none of them; Wilson
   * (OWNER), the root AB above her, prints them as a coach.
   */
  describe('B1 the print holds lead names and lead-note text only for a reader who may read the coachee’s leads', () => {
    const HENDRO = 'Pak Hendro Gunawan';
    const LEAD_TEXTS = [HENDRO, 'Collect the signed SPAJ.', 'Ask Pak Hendro for the referral.'];
    const mentionsALead = (body: unknown) => LEAD_TEXTS.filter((text) => JSON.stringify(body).includes(text));

    /** A finalized session of Agus's with Indah, with a lead-derived item last week and a lead action. */
    async function withLeads(): Promise<string> {
      const hendro = await lead('INDAH', { nextActionDate: '2026-09-17', nextActionNote: 'Ask Pak Hendro for the referral.' });
      const { _id } = await wired.coachingSessions.create(office.as('AGUS'), {
        coachMembershipId: id('AGUS'), coacheeMembershipId: id('INDAH'), status: 'finalized', date: '2026-09-12',
        frozenAt: new Date('2026-09-12T04:00:00Z'), finalizedAt: new Date('2026-09-12T04:00:00Z'),
        finalizedByMembershipId: id('AGUS'), version: 3, lastWeek: null, snapshot: null, corrections: [],
        lastWeekItems: [
          { itemId: 'INDAH-1', text: 'Book two presentations', dueDate: '2026-09-10', leadId: null, leadName: null, done: true },
          { itemId: `lead-${hendro}`, text: 'Collect the signed SPAJ.', dueDate: '2026-09-11', leadId: hendro, leadName: HENDRO, done: false },
        ],
        actionItems: [{ itemId: 'a1', text: 'Shadow Sari on one presentation', dueDate: '2026-09-18', carriedFromItemId: null }],
        tips: [{ tipId: 't1', text: 'Listen first.', carriedFromTipId: null }],
        leadActions: [{ leadId: hendro, leadName: HENDRO, dueDate: '2026-09-17', text: 'Ask Pak Hendro for the referral.' }],
      } as never);
      return String(_id);
    }

    it('B1 GET /coaching/sessions/:sessionId/print — the Admin who is not above Indah prints it without its lead rows', async () => {
      const sessionId = await withLeads();
      as('ADMIN');
      const res = (await print(sessionId).expect(200)).body;

      expect(res).toMatchObject({
        lastWeekItems: [{ text: 'Book two presentations', done: true }],
        leadActions: [],
        actionItems: [{ dueDate: '2026-09-18', text: 'Shadow Sari on one presentation' }],
        tips: [{ text: 'Listen first.' }],
      });
      expect(res.lastWeekItems).toHaveLength(1);
      expect(Object.keys(res).sort()).toEqual(PRINT_FIELDS);
      expect(mentionsALead(res)).toEqual([]);
      // Printed all the same, and recorded as every print is.
      expect(await exported()).toHaveLength(1);
      expect(await printReads()).toHaveLength(1);
    });

    it.each([
      ['AGUS', 'its coach'],
      ['OWNER', 'the Owner, who is above her and prints it as a coach'],
      ['INDAH', 'the coachee'],
    ] as [Who, string][])('B1 GET /coaching/sessions/:sessionId/print — %s, %s, keeps every lead row', async (who) => {
      const sessionId = await withLeads();
      as(who);
      const res = (await print(sessionId).expect(200)).body;

      expect(res.lastWeekItems).toEqual([
        { text: 'Book two presentations', done: true }, { text: 'Collect the signed SPAJ.', done: false },
      ]);
      expect(res.leadActions).toEqual([{ dueDate: '2026-09-17', text: 'Ask Pak Hendro for the referral.', leadName: HENDRO }]);
      expect(mentionsALead(res).sort()).toEqual([...LEAD_TEXTS].sort());
    });

    it('B1 a former coach prints what they led with its lead rows: the session is theirs', async () => {
      const sessionId = await withLeads();
      await move('INDAH', 'PEER_AB');
      as('AGUS');
      expect((await print(sessionId).expect(200)).body.leadActions).toEqual([expect.objectContaining({ leadName: HENDRO })]);
    });

    it('B1 /coaching/me/sessions counts are kept as they are', async () => {
      const sessionId = await withLeads();
      as('INDAH');
      expect((await mine().expect(200)).body.sessions.find((r: Doc) => r.sessionId === sessionId))
        .toMatchObject({ actionItemCount: 2, completedCount: 0 });
    });
  });

  // ------------------------------------------------------------------ /coaching/me

  describe('/coaching/me/sessions (AC-4, AC-10, ADR-0078, ADR-0088)', () => {
    it('P11-T10 AC-4 the coachee’s finalized sessions, newest first, each Coached by its leader — the counts from finalized sessions only', async () => {
      const fixture = await fixtureSession('AGUS', 'INDAH');
      // This 1:1 ticks the 10 September item done, and is then the last week of a draft that ticks its own.
      const done = await finalized('AGUS', 'INDAH', { lastWeekItems: [{ itemId: 'INDAH-1', done: true }] });
      const draft = (await start('AGUS', 'INDAH').expect(201)).body;
      await save(draft.sessionId, {
        version: draft.version, lastWeekItems: draft.lastWeekItems.map((i: Doc) => ({ itemId: i.itemId, done: true })),
        actionItems: [], tips: [],
      }).expect(200);
      await col('auditLog').deleteMany({});

      as('INDAH');
      const res = await mine().expect(200);

      const agus = { membershipId: id('AGUS'), name: 'Agus Salim' };
      expect(res.body).toEqual({
        sessions: [
          // The draft's tick is Agus's working copy: it counts for nobody else.
          { sessionId: done.sessionId, date: ROSTER_TODAY, coach: agus, actionItemCount: 1, completedCount: 0 },
          { sessionId: fixture, date: '2026-09-10', coach: agus, actionItemCount: 1, completedCount: 1 },
        ],
        ledFormerly: [],
      });
      // A self-read: nothing recorded.
      expect(await col('auditLog').countDocuments({})).toBe(0);
    });

    it('P11-T10 AC-4 a session under correction is listed, and read, as its latest finalized version — read-only, with no reopen offered', async () => {
      const done = await finalized('AGUS', 'INDAH');
      as('AGUS');
      const reopened = (await reopen(done.sessionId, done.version).expect(200)).body;
      const corrected = (await save(done.sessionId, {
        version: reopened.version, lastWeekItems: [], actionItems: [dated('One'), dated('Two')], tips: [],
      }).expect(200)).body;

      as('INDAH');
      expect((await mine().expect(200)).body.sessions[0]).toMatchObject({ sessionId: done.sessionId, actionItemCount: 1 });
      const read1 = (await read(done.sessionId).expect(200)).body;
      // The correction and the reason it was opened are not shown until it is finalized.
      expect(read1).toMatchObject({
        status: 'finalized', version: done.version, actionItems: [{ text: 'Book two presentations' }], earlier: [],
        reopenableUntil: null,
      });

      as('AGUS');
      await finalize(done.sessionId, corrected.version).expect(200);
      as('INDAH');
      expect((await mine().expect(200)).body.sessions[0]).toMatchObject({ sessionId: done.sessionId, actionItemCount: 2 });
      const read2 = (await read(done.sessionId).expect(200)).body;
      expect(read2.earlier).toEqual([expect.objectContaining({ reason: 'Two dates were wrong.' })]);
      expect(read2.reopenableUntil).toBeNull();
      // Nothing in either answer is a field a leader note could be in.
      for (const body of [read1, read2, (await mine()).body, (await print(done.sessionId)).body]) {
        expect(JSON.stringify(body)).not.toMatch(/"(note|notes|leaderNote\w*)"/i);
      }
    });

    it('P11-T10 AC-4 an Admin who is the coachee reads her session read-only: no reopen offered, and a reopen refused', async () => {
      // Maya is the office's Admin and an AB under Wilson: `own-kpm` reopens sessions, but not one about her.
      const done = await finalized('OWNER', 'ADMIN');
      as('ADMIN');
      expect((await mine().expect(200)).body.sessions.map((r: Doc) => r.sessionId)).toEqual([done.sessionId]);
      expect((await read(done.sessionId).expect(200)).body).toMatchObject({ status: 'finalized', reopenableUntil: null });
      expect((await reopen(done.sessionId, done.version).expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(done.sessionId) }))!.status).toBe('finalized');

      // Its coach still may, inside the window.
      as('OWNER');
      expect((await read(done.sessionId).expect(200)).body.reopenableUntil).toBe('2026-09-21');
      await reopen(done.sessionId, done.version).expect(200);
    });

    it('P11-T10 AC-4 the coachee never reads a draft: neither listed, nor read, nor printed', async () => {
      const draft = (await start('AGUS', 'INDAH').expect(201)).body;
      as('INDAH');
      expect((await mine().expect(200)).body.sessions.map((r: Doc) => r.sessionId)).not.toContain(draft.sessionId);
      await read(draft.sessionId).expect(404);
      await print(draft.sessionId).expect(404);
    });

    it.each([
      ['INDAH', 'an Agent', ['2026-09-10']],
      ['SARI', 'an AAB coached by her AB', ['2026-09-02']],
      ['RINA', 'an Agent coached twice', [ROSTER_TODAY, '2026-09-07']],
      ['AGUS', 'an AB nobody has coached', []],
    ] as [Who, string, string[]][])('P11-T10 AC-4 %s, %s, reads their own, and nothing is recorded', async (who, _what, dates) => {
      as(who);
      const res = await mine().expect(200);
      expect(res.body.sessions.map((r: Doc) => r.date)).toEqual(dates);
      // Each leads who they led now, or nobody: nothing was led with somebody they no longer coach.
      expect(res.body.ledFormerly).toEqual([]);
      expect(await col('auditLog').countDocuments({})).toBe(0);
    });

    it('P11-T10 AC-4 a session whose coach’s membership is gone stays the coachee’s, listed and printed with the name empty', async () => {
      const budi = await col('coachingSessions').findOne({ coacheeMembershipId: id('BUDI') });
      as('BUDI');
      expect((await mine().expect(200)).body.sessions).toEqual([{
        sessionId: String(budi!._id), date: '2026-09-12', coach: { membershipId: budi!.coachMembershipId, name: '' },
        actionItemCount: 1, completedCount: 0,
      }]);
      expect((await print(String(budi!._id)).expect(200)).body).toMatchObject({ coach: { name: '' }, coachee: { name: 'Budi Santoso' } });
    });

    it('P11-T10 a Super Admin has no membership to read from, and is refused by name', async () => {
      session.current = SUPER_ADMIN;
      expect((await mine().expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('P11-T10 AC-10 a former coach finds the sessions they led with somebody they no longer coach, and each opens and prints', async () => {
      const fixture = await fixtureSession('AGUS', 'INDAH');
      const later = await finalized('AGUS', 'INDAH');
      // Indah moves to Hendra's unit: Agus coaches her no longer, and Wilson, at the root, still does.
      await move('INDAH', 'PEER_AB');
      await col('auditLog').deleteMany({});

      as('AGUS');
      const res = await mine().expect(200);
      const indah = { membershipId: id('INDAH'), name: 'Indah Permatasari' };
      expect(res.body.ledFormerly).toEqual([
        { sessionId: later.sessionId, date: ROSTER_TODAY, coachee: indah, actionItemCount: 1, completedCount: 0 },
        { sessionId: fixture, date: '2026-09-10', coachee: indah, actionItemCount: 1, completedCount: 0 },
      ]);
      // A list of dates, names and counts: nothing recorded until one is opened.
      expect(await col('auditLog').countDocuments({})).toBe(0);
      for (const row of res.body.ledFormerly as Doc[]) {
        await read(row.sessionId as string).expect(200);
        await print(row.sessionId as string).expect(200);
      }
      expect(await col('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, targetMembershipId: id('INDAH') })).toBe(4);

      // Her new leader led none of them, and the root AB coaches her still: neither lists them.
      for (const who of ['PEER_AB', 'OWNER'] as Who[]) {
        as(who);
        expect([who, (await mine().expect(200)).body.ledFormerly]).toEqual([who, []]);
      }
    });
  });

  // ------------------------------------------------------------------ exit criterion 1

  it('P11-T10 AC-1 exit criterion 1: a goal, a lead and a logged day changed after finalize leave the print and /coaching/me as agreed', async () => {
    const hendro = await lead('INDAH', { nextActionDate: '2026-09-17', nextActionNote: 'Collect the signed SPAJ.' });
    const done = await finalized('AGUS', 'INDAH', { tips: [{ text: 'Ask for the referral.' }] });
    as('AGUS');
    const printed = (await print(done.sessionId).expect(200)).body;
    const archived = (await read(done.sessionId).expect(200)).body;
    as('INDAH');
    const listed = (await mine().expect(200)).body;
    const ownPrint = (await print(done.sessionId).expect(200)).body;

    // A new target for the year, saved by her leader; a lead renamed and moved; a day logged.
    const plan = await wired.goals.readOrDefaults(office.as('AGUS'), '2026', id('INDAH'));
    await wired.goals.save(office.as('AGUS'), {
      period: '2026', mode: plan.mode, annualApeTargetMinor: 900_000_000_00, savingsTargetMinor: plan.savingsTargetMinor,
      commissionRatePct: plan.commissionRatePct, monthsLeft: plan.monthsLeft, apeAchievedMinor: plan.apeAchievedMinor,
      caseSizeMinor: plan.caseSizeMinor, leadsToApptPct: plan.leadsToApptPct, closingRatePct: plan.closingRatePct,
    }, id('INDAH'));
    await col('leads').updateOne(
      { _id: new mongoose.Types.ObjectId(hendro) },
      { $set: { name: 'Pak Hendro (renamed)', nextActionDate: '2026-09-25', nextActionNote: 'Something else' } },
    );
    await col('activityLogs').updateOne(
      { membershipId: id('INDAH'), localDate: '2026-09-10' },
      { $set: { entries: [{ activityTypeId: 't', activityTypeCode: 'SELL_SUBMISSION', count: 9 }], totalCount: 9 } },
    );
    clock.set(new Date('2026-09-15T03:00:00Z'));

    as('AGUS');
    expect((await print(done.sessionId).expect(200)).body).toEqual(printed);
    expect((await read(done.sessionId).expect(200)).body).toEqual(archived);
    as('INDAH');
    expect((await mine().expect(200)).body).toEqual(listed);
    expect((await print(done.sessionId).expect(200)).body).toEqual(ownPrint);
    // What was agreed is what the print holds: the lead as it read that day.
    expect(printed.leadActions).toEqual([{ dueDate: '2026-09-17', text: 'Collect the signed SPAJ.', leadName: 'Pak Hendro Gunawan' }]);
  });
});
