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
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { CoachingController } from './coaching.controller';
import { CoachingRosterService } from './coaching-roster.service';
import { CoacheeService } from './coachee.service';
import { CoachingSessionService } from './coaching-session.service';

type Doc = Record<string, unknown>;

/**
 * **The coaching session's lifecycle over HTTP, per role** (P11-T5; `functional/coaching.md`, *The
 * session*, *The snapshot*, *Who reads a session*, the Data contract).
 *
 * Through the real `PermissionsGuard`, the production pipe and the real services over
 * `test/coaching-office.ts`'s office — goals, production and a fortnight of activity behind them — so
 * the snapshot a finalize freezes is the one the Summary, the ratios and the 7-day read compute. The
 * office's fixture sessions: Indah's with Agus on 10 September, Sari's with Agus on 2 September, Rina's
 * with Sari on 7 and 14 September, Budi's with a coach who is gone, and Agus's open draft with Dimas.
 * Every test starts from them again; the clock is 10:00 on 14 September in Jakarta unless it says.
 *
 * A former coach — the edge closed by the org services themselves — is
 * `coaching-session-former-coach.tenancy.spec.ts`'s.
 */
describe('the coaching session over HTTP (P11-T5)', () => {
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
  const reopen = (sessionId: string, version: number, reason: unknown = 'Two dates were wrong.') =>
    http().post(`/coaching/sessions/${sessionId}/reopen`).send({ version, reason });
  const history = (coachee: Who) => http().get(`/coaching/coachees/${id(coachee)}/sessions`);
  const audits = (filter: Doc) => col('auditLog').find(filter).toArray();
  const fixtureSession = async (coach: Who, coachee: Who) =>
    (await col('coachingSessions').findOne({ coachMembershipId: id(coach), coacheeMembershipId: id(coachee), status: 'finalized' }))!;

  /** A dated item, so the session passes finalize's checks. */
  const dated = (text = 'Book two presentations', dueDate = '2026-09-20') => ({ text, dueDate });

  /** Start, save one dated item, finalize: the session as its coach reads it. */
  async function finalized(coach: Who, coachee: Who, items = [dated()]): Promise<Doc & { sessionId: string; version: number }> {
    const started = (await start(coach, coachee).expect((r) => expect([200, 201]).toContain(r.status))).body;
    const saved = (await save(started.sessionId, { version: started.version, lastWeekItems: [], actionItems: items, tips: [] })
      .expect(200)).body;
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

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    clock = wired.clock as FixedClock;
    office = await buildCoachingOffice(wired);
    await syncIndexes();
    for (const name of RESTORED) kept[name] = await col(name).find().toArray();

    const moduleRef = await Test.createTestingModule({
      controllers: [CoachingController],
      providers: [
        { provide: CoachingRosterService, useValue: wired.coachingRoster },
        { provide: CoacheeService, useValue: wired.coachee },
        { provide: CoachingSessionService, useValue: wired.coachingSession },
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
    wired.sentNotifications.splice(0);
    wired.releasedNotifications.splice(0);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  // ------------------------------------------------------------------ Start

  describe('Start (AC-1)', () => {
    it('P11-T5 AC-1 opens a draft on last week, and a second Start resumes it from any device', async () => {
      const lastWeek = await fixtureSession('AGUS', 'INDAH');
      const first = await start('AGUS', 'INDAH').expect(201);

      expect(first.body).toMatchObject({
        coachee: { membershipId: id('INDAH'), name: 'Indah Permatasari' },
        coach: { membershipId: id('AGUS'), name: 'Agus Salim' },
        status: 'draft', version: 1, date: null, finalizedAt: null, finalizedBy: null, reopenableUntil: null,
        lastWeek: { sessionId: String(lastWeek._id), date: '2026-09-10' },
        lastWeekItems: [{ itemId: 'INDAH-1', text: 'Book two presentations', dueDate: '2026-09-10', lead: null, done: false }],
        // Carried, with its date cleared: set fresh in this session (`Overall.html:10671-10674`).
        actionItems: [{ text: 'Book two presentations', dueDate: null }],
        tips: [], leadActions: [], snapshot: null, earlier: [],
      });

      const again = await start('AGUS', 'INDAH').expect(200);
      expect(again.body.sessionId).toBe(first.body.sessionId);
      expect(await col('coachingSessions').countDocuments({ coacheeMembershipId: id('INDAH'), status: 'draft' })).toBe(1);

      // Each answer is the session as `GET` answers it, and each is recorded as a read of Indah's data.
      const entries = await audits({ action: SUBJECT_READ_ACTION, targetMembershipId: id('INDAH') });
      expect(entries.map((e) => e.after)).toEqual([
        { surface: 'coaching_session', from: null, to: ROSTER_TODAY },
        { surface: 'coaching_session', from: null, to: ROSTER_TODAY },
      ]);
    });

    it('P11-T5 AC-1 last week is the coachee’s, whoever led it: a dated lead’s item is listed live, not carried; tips carry as written', async () => {
      const datedLead = await lead('DODI', { name: 'Ibu Wulan Sari', nextActionDate: '2026-09-18', nextActionNote: 'Bring the illustration.' });
      const undatedLead = await lead('DODI', { name: 'Pak Surya' });
      const { _id } = await wired.coachingSessions.create(office.as('NINA'), {
        coachMembershipId: id('NINA'), coacheeMembershipId: id('DODI'), status: 'finalized', date: '2026-09-11',
        frozenAt: new Date('2026-09-11T04:00:00Z'), finalizedAt: new Date('2026-09-11T04:00:00Z'),
        finalizedByMembershipId: id('NINA'), version: 3,
        actionItems: [{ itemId: 'typed', text: 'Practise the close', dueDate: '2026-09-13', carriedFromItemId: null }],
        leadActions: [
          { leadId: datedLead, leadName: 'Ibu Wulan Sari', dueDate: '2026-09-12', text: 'Call her' },
          { leadId: undatedLead, leadName: 'Pak Surya', dueDate: '2026-09-12', text: 'Send the brochure' },
        ],
        tips: [{ tipId: 'tip', text: 'Ask for the referral before you leave.', carriedFromTipId: null }],
      } as never);

      // Sari, the AAB above Nina, starts from Nina's session: the commitments follow the agent (ADR-0081).
      const res = await start('SARI', 'DODI').expect(201);

      expect(res.body.lastWeek).toEqual({ sessionId: String(_id), date: '2026-09-11' });
      expect(res.body.lastWeekItems).toEqual([
        { itemId: 'typed', text: 'Practise the close', dueDate: '2026-09-13', lead: null, done: false },
        { itemId: `lead-${datedLead}`, text: 'Call her', dueDate: '2026-09-12', lead: { leadId: datedLead, name: 'Ibu Wulan Sari' }, done: false },
        { itemId: `lead-${undatedLead}`, text: 'Send the brochure', dueDate: '2026-09-12', lead: { leadId: undatedLead, name: 'Pak Surya' }, done: false },
      ]);
      expect(res.body.actionItems.map((i: Doc) => [i.text, i.dueDate])).toEqual([
        ['Practise the close', null], ['Send the brochure', null],
      ]);
      expect(res.body.tips.map((t: Doc) => t.text)).toEqual(['Ask for the referral before you leave.']);
      // *From leads (automatic)* lists the dated lead, live.
      expect(res.body.leadActions).toEqual([
        { leadId: datedLead, leadName: 'Ibu Wulan Sari', dueDate: '2026-09-18', text: 'Bring the illustration.' },
      ]);
      const stored = await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(res.body.sessionId) });
      expect(stored!.actionItems.map((i: Doc) => i.carriedFromItemId)).toEqual(['typed', `lead-${undatedLead}`]);
      expect(stored!.lastWeek).toEqual({ sessionId: String(_id), version: 3, date: '2026-09-11' });
    });

    it('P11-T5 AC-1 for a session under correction, last week is its latest finalized version', async () => {
      const kept = (version: number, text: string) => ({
        version, lastWeekItems: [], actionItems: [{ itemId: `v${version}`, text, dueDate: '2026-09-12', carriedFromItemId: null }],
        tips: [], leadActions: [], finalizedAt: new Date('2026-09-12T04:00:00Z'), finalizedByMembershipId: id('AGUS'),
        at: new Date('2026-09-13T04:00:00Z'), byMembershipId: id('AGUS'), reason: 'A date was wrong.',
      });
      await wired.coachingSessions.create(office.as('AGUS'), {
        coachMembershipId: id('AGUS'), coacheeMembershipId: id('INDAH'), status: 'reopened', date: '2026-09-12',
        frozenAt: new Date('2026-09-12T04:00:00Z'), finalizedAt: new Date('2026-09-12T04:00:00Z'),
        finalizedByMembershipId: id('AGUS'), version: 7,
        actionItems: [{ itemId: 'w', text: 'Being corrected', dueDate: null, carriedFromItemId: null }],
        corrections: [kept(3, 'First agreed'), kept(5, 'Agreed last')],
      } as never);

      // A reopened session is not the pair's open draft: it holds up no Start.
      const res = await start('AGUS', 'INDAH').expect(201);
      expect(res.body.lastWeek.date).toBe('2026-09-12');
      expect(res.body.lastWeekItems.map((i: Doc) => i.text)).toEqual(['Agreed last']);
    });

    it('P11-T5 AC-1 a coachee with no finalized session starts with no last week and nothing carried', async () => {
      const res = await start('AGUS', 'LUKAS').expect(201);
      expect(res.body).toMatchObject({ lastWeek: null, lastWeekItems: [], actionItems: [], tips: [] });
    });

    it('P11-T5 AC-1 two racing Starts write one draft, and the second resumes it', async () => {
      as('AGUS');
      const [a, b] = await Promise.all([
        http().post(`/coaching/coachees/${id('TARI')}/sessions`),
        http().post(`/coaching/coachees/${id('TARI')}/sessions`),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.sessionId).toBe(b.body.sessionId);
      expect(await col('coachingSessions').countDocuments({ coacheeMembershipId: id('TARI') })).toBe(1);
    });

    it('P11-T5 AC-1 the rule is per pair: an AAB and the AB above them each have a draft with the same agent', async () => {
      const sari = await start('SARI', 'BUDI').expect(201);
      const agus = await start('AGUS', 'BUDI').expect(201);
      expect(sari.body.sessionId).not.toBe(agus.body.sessionId);
    });

    it('P11-T5 AC-1 the Owner, standing at the root as the office’s AB, starts as that AB', async () => {
      const res = await start('OWNER', 'INDAH').expect(201);
      expect(res.body.coach.membershipId).toBe(id('OWNER'));
    });

    it.each([
      ['SARI', 'INDAH', 'an agent of the AB above them'],
      ['PEER_AAB', 'RINA', 'a peer AAB’s agent'],
      ['AGUS', 'PEER_AGENT', 'a peer AB’s person'],
      ['AGUS', 'B_AGENT', 'a member of another office'],
      ['B_AB', 'INDAH', 'this office’s member, to another office’s AB'],
      ['AGUS', 'LEFT', 'a member who has left'],
      ['AGUS', 'AGUS', 'themselves'],
      ['AGUS', 'OWNER', 'the leader above them'],
      ['ADMIN', 'INDAH', 'anybody, to an Admin who stands above nobody'],
    ] as [Who, Who, string][])('P11-T5 AC-9 %s starting with %s, %s, is 404', async (coach, coachee) => {
      const res = await start(coach, coachee).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(await col('coachingSessions').countDocuments({ coacheeMembershipId: id(coachee), status: 'draft', coachMembershipId: id(coach) })).toBe(0);
    });

    it('P11-T5 an Agent, a Super Admin and a read-only support session hold no grant to start one', async () => {
      expect((await start('INDAH', 'DIMAS').expect(403)).body.error.code).toBe('PERM_DENIED');
      session.current = SUPER_ADMIN;
      await http().post(`/coaching/coachees/${id('INDAH')}/sessions`).expect(403);
      const agus = office.as('AGUS');
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      await http().post(`/coaching/coachees/${id('INDAH')}/sessions`).expect(403);
    });
  });

  // ------------------------------------------------------------------ the draft

  describe('the draft (AC-2, AC-3)', () => {
    it('P11-T5 AC-2 a tick on last week’s item is written on this session; the session it came from never changes', async () => {
      const before = await fixtureSession('AGUS', 'INDAH');
      const started = (await start('AGUS', 'INDAH').expect(201)).body;
      const carried = started.actionItems[0];

      const saved = await save(started.sessionId, {
        version: 1,
        lastWeekItems: [{ itemId: 'INDAH-1', done: true, dueDate: '2026-09-11' }],
        actionItems: [{ itemId: carried.itemId, ...dated() }, { text: '', dueDate: null }],
        tips: [{ text: 'Lead with the family’s goal, then the product.' }],
      }).expect(200);

      expect(saved.body).toMatchObject({ sessionId: started.sessionId, version: 2 });
      expect(Object.keys(saved.body).sort()).toEqual(['actionItems', 'sessionId', 'tips', 'version']);
      expect(saved.body.actionItems[0]).toEqual({ itemId: carried.itemId, text: 'Book two presentations', dueDate: '2026-09-20' });
      // A blank row may be saved while editing; it is given an id.
      expect(saved.body.actionItems[1]).toMatchObject({ text: '', dueDate: null, itemId: expect.any(String) });
      expect(saved.body.tips).toEqual([{ tipId: expect.any(String), text: 'Lead with the family’s goal, then the product.' }]);

      const reread = (await read(started.sessionId).expect(200)).body;
      expect(reread.lastWeekItems[0]).toMatchObject({ itemId: 'INDAH-1', done: true, dueDate: '2026-09-11' });
      const stored = await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(started.sessionId) });
      // A carried row keeps where it came from across a save.
      expect(stored!.actionItems[0].carriedFromItemId).toBe('INDAH-1');
      expect(stored!.updatedBy).toBe(id('AGUS'));
      // Frozen: the session the item came from is exactly as it was.
      expect(await col('coachingSessions').findOne({ _id: before._id })).toEqual(before);
    });

    it('P11-T5 AC-2 the save answers actionItems and tips in the request’s order, each new row’s id at its own position', async () => {
      const started = (await start('AGUS', 'INDAH').expect(201)).body;
      const carried = started.actionItems[0];

      // New rows around a carried one: the browser matches the ids it did not have by position.
      const first = (await save(started.sessionId, {
        version: 1, lastWeekItems: [],
        actionItems: [dated('A, new'), { itemId: carried.itemId, text: carried.text, dueDate: null }, dated('B, new')],
        tips: [{ text: 'Tip one' }, { text: 'Tip two' }],
      }).expect(200)).body;
      expect(first.actionItems.map((i: Doc) => i.text)).toEqual(['A, new', carried.text, 'B, new']);
      expect(first.actionItems[1].itemId).toBe(carried.itemId);
      expect(first.tips.map((t: Doc) => t.text)).toEqual(['Tip one', 'Tip two']);
      const [a, x, b] = first.actionItems.map((i: Doc) => i.itemId as string);
      const [t1, t2] = first.tips.map((t: Doc) => t.tipId as string);
      expect(new Set([a, x, b]).size).toBe(3);

      // Reordered, with a new row in the middle of each list: the answer keeps the order sent, not the stored one.
      const second = (await save(started.sessionId, {
        version: first.version, lastWeekItems: [],
        actionItems: [
          { itemId: b, ...dated('B, new') }, dated('C, new'), { itemId: a, ...dated('A, new') },
          { itemId: x, text: carried.text, dueDate: null },
        ],
        tips: [{ tipId: t2, text: 'Tip two' }, { text: 'Tip three' }, { tipId: t1, text: 'Tip one' }],
      }).expect(200)).body;
      expect(second.actionItems.map((i: Doc) => [i.itemId, i.text])).toEqual([
        [b, 'B, new'], [expect.any(String), 'C, new'], [a, 'A, new'], [x, carried.text],
      ]);
      expect([a, b, x]).not.toContain(second.actionItems[1].itemId);
      expect(second.tips.map((t: Doc) => [t.tipId, t.text])).toEqual([
        [t2, 'Tip two'], [expect.any(String), 'Tip three'], [t1, 'Tip one'],
      ]);
      expect([t1, t2]).not.toContain(second.tips[1].tipId);

      // And stored as answered: a re-read gives the same order and the same ids.
      const reread = (await read(started.sessionId).expect(200)).body;
      expect(reread.actionItems.map((i: Doc) => i.itemId)).toEqual(second.actionItems.map((i: Doc) => i.itemId));
      expect(reread.tips.map((t: Doc) => t.tipId)).toEqual(second.tips.map((t: Doc) => t.tipId));
    });

    it('P11-T5 AC-3 a stale version is VERSION_CONFLICT, and of two devices saving at once one wins', async () => {
      const started = (await start('AGUS', 'INDAH').expect(201)).body;
      const body = (version: number, text: string) => ({ version, lastWeekItems: [], actionItems: [dated(text)], tips: [] });
      await save(started.sessionId, body(1, 'first')).expect(200);

      const stale = await save(started.sessionId, body(1, 'from the other device')).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });

      const raced = await Promise.all([save(started.sessionId, body(2, 'phone')), save(started.sessionId, body(2, 'laptop'))]);
      expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(raced.find((r) => r.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
      expect((await read(started.sessionId).expect(200)).body.version).toBe(3);
    });

    it.each([
      ['an item of last week the session does not hold', { lastWeekItems: [{ itemId: 'nobody', done: true }] }],
      ['an action item id the session does not hold', { actionItems: [{ itemId: 'nobody', text: 'x', dueDate: null }] }],
      ['one action item sent twice', 'twice'],
      ['a tip id the session does not hold', { tips: [{ tipId: 'nobody', text: 'x' }] }],
      ['a date that is not a day', { actionItems: [{ text: 'x', dueDate: '2026-02-31' }] }],
      ['a date that is not a date', { actionItems: [{ text: 'x', dueDate: 'tomorrow' }] }],
      ['last week’s date that is not a day', { lastWeekItems: [{ itemId: 'INDAH-1', done: false, dueDate: '2026-13-01' }] }],
      ['51 action items', { actionItems: Array.from({ length: 51 }, () => dated()) }],
      ['51 tips', { tips: Array.from({ length: 51 }, () => ({ text: 'x' })) }],
      ['a text of 501 characters', { actionItems: [{ text: 'x'.repeat(501), dueDate: null }] }],
      ['a field the contract does not have', { notes: 'a leader note' }],
      ['no version', { version: undefined }],
    ] as [string, Doc | 'twice'][])('P11-T5 AC-3 refuses %s with VALIDATION_FAILED, and saves nothing', async (_what, change) => {
      const started = (await start('AGUS', 'INDAH').expect(201)).body;
      const carried = started.actionItems[0].itemId;
      const extra = change === 'twice'
        ? { actionItems: [{ itemId: carried, text: 'a', dueDate: null }, { itemId: carried, text: 'b', dueDate: null }] }
        : change;
      const res = await save(started.sessionId, { version: 1, lastWeekItems: [], actionItems: [], tips: [], ...extra }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect((await read(started.sessionId).expect(200)).body.version).toBe(1);
    });

    it('P11-T5 writes are its coach’s, while they coach the coachee: anybody else is 404, and an Agent 403', async () => {
      const started = (await start('AGUS', 'INDAH').expect(201)).body;
      const body = { version: 1, lastWeekItems: [], actionItems: [dated()], tips: [] };
      // Another current coach — the Owner as the root AB — a peer, another office: none of them writes it.
      for (const who of ['OWNER', 'SARI', 'PEER_AB', 'B_AB'] as Who[]) {
        as(who);
        expect([who, (await save(started.sessionId, body)).status]).toEqual([who, 404]);
      }
      as('INDAH');
      await save(started.sessionId, body).expect(403);
      const agus = office.as('AGUS');
      session.current = new RequestContext(agus.userId, 'none', agus.membership, 'u-support', null, false, true);
      await save(started.sessionId, body).expect(403);
      as('AGUS');
      expect((await read(started.sessionId).expect(200)).body.version).toBe(1);
    });
  });

  // ------------------------------------------------------------------ finalize

  describe('finalize (AC-4, AC-5, AC-7)', () => {
    it('P11-T5 AC-4 refuses in the prototype’s order, each with its rule and the prototype’s sentence', async () => {
      const started = (await start('AGUS', 'LUKAS').expect(201)).body;
      let version = 1;
      const attempt = async (body: Doc | null) => {
        if (body) version = (await save(started.sessionId, { version, lastWeekItems: [], ...body }).expect(200)).body.version;
        return (await finalize(started.sessionId, version).expect(422)).body.error;
      };

      expect(await attempt(null)).toMatchObject({
        code: 'COACHING_SESSION_INCOMPLETE', message: 'Add at least one action item before finalizing.',
        details: { rule: 'NO_ACTION_ITEM' },
      });
      expect(await attempt({ actionItems: [{ text: '', dueDate: null }], tips: [{ text: ' ' }] })).toMatchObject({
        message: 'Fill in or remove the empty coaching tip before finalizing.', details: { rule: 'EMPTY_TIP' },
      });
      expect(await attempt({ actionItems: [{ text: '', dueDate: null }], tips: [{ text: 'Slow down.' }] })).toMatchObject({
        message: 'Fill in or remove the empty action item before finalizing.', details: { rule: 'EMPTY_ACTION_ITEM' },
      });
      expect(await attempt({ actionItems: [{ text: 'Call the bank', dueDate: null }], tips: [] })).toMatchObject({
        message: 'Every action item needs a date before finalizing.', details: { rule: 'UNDATED_ACTION_ITEM' },
      });

      // Promised for this month with no date — closed, and it still counts.
      const promised = await lead('LUKAS', {
        name: 'Pak Fauzan Akbar', outcome: 'won', outcomeAt: new Date('2026-09-12T02:00:00Z'),
        commitments: [{ month: '2026-09', at: new Date('2026-09-02T02:00:00Z'), byMembershipId: id('LUKAS') }],
      });
      expect(await attempt({ actionItems: [dated()], tips: [] })).toMatchObject({
        message: 'Pak Fauzan Akbar is tagged "this month" but has no next action date set — add one before finalizing.',
        details: { rule: 'LEAD_THIS_MONTH_UNDATED', leadId: promised, leadName: 'Pak Fauzan Akbar' },
      });
      // Nothing was written by any refusal.
      expect((await read(started.sessionId).expect(200)).body).toMatchObject({ status: 'draft', version });

      await col('leads').updateOne({ _id: new mongoose.Types.ObjectId(promised) }, { $set: { nextActionDate: '2026-09-16' } });
      const done = (await finalize(started.sessionId, version).expect(200)).body;
      // A closed lead with a date is one of *From leads (automatic)* too.
      expect(done.leadActions).toEqual([{ leadId: promised, leadName: 'Pak Fauzan Akbar', dueDate: '2026-09-16', text: 'Follow up with Pak Fauzan Akbar' }]);
    });

    it('P11-T5 AC-4 freezes the snapshot from the live reads, dates the session in the office’s calendar, and takes the lead actions', async () => {
      const hendro = await lead('INDAH', { nextActionDate: '2026-09-17', nextActionNote: 'Collect the signed SPAJ.' });
      const indah = { membershipId: id('INDAH'), orgLevelCode: 'AGENT', self: false };
      const ctx = office.as('AGUS');
      const [summary, ratios, week] = await Promise.all([
        wired.summary.of(ctx, indah), wired.activityLogs.ratiosOf(ctx, indah), wired.activityLogs.weekOf(ctx, indah),
      ]);
      await col('auditLog').deleteMany({});

      const done = await finalized('AGUS', 'INDAH');

      expect(done).toMatchObject({
        status: 'finalized', date: ROSTER_TODAY, finalizedAt: ROSTER_NOW.toISOString(),
        finalizedBy: { membershipId: id('AGUS'), name: 'Agus Salim' },
        reopenableUntil: '2026-09-21',
        leadActions: [{ leadId: hendro, leadName: 'Pak Hendro Gunawan', dueDate: '2026-09-17', text: 'Collect the signed SPAJ.' }],
      });
      const snapshot = done.snapshot as Doc & { goal: Doc; ratios: Doc; activity: Doc };
      expect(snapshot.takenAt).toBe(ROSTER_NOW.toISOString());
      const five = (p: Doc) => ({
        targetMinor: p.targetMinor, actualMinor: p.actualMinor, attainmentPct: p.attainmentPct, gapMinor: p.gapMinor, targetMet: p.targetMet,
      });
      // The goal the Summary shows that day, with whose APE it is and which goal version.
      expect(snapshot.goal).toEqual({
        period: '2026', month: '2026-09', currency: 'IDR',
        monthly: five(summary.monthly as unknown as Doc), yearly: five(summary.yearly as unknown as Doc),
        source: { provenance: 'imported', month: '2026-09' },
        savedAt: '2026-01-05T02:00:00.000Z', savedByMembershipId: id('INDAH'), goalVersion: 1,
      });
      expect((snapshot.goal.yearly as Doc).actualMinor).toBe(240 * 1_000_000 * 100);
      // The ratios on Indah's rung over the 30 days, labels beside the codes.
      expect(snapshot.ratios).toMatchObject({ from: ratios.from, to: ratios.to, days: 30 });
      expect((snapshot.ratios.rows as Doc[]).map((r) => [r.code, r.label, r.value, r.sides])).toEqual(
        ratios.ratios.map((r) => [r.code, r.label, r.value, null]),
      );
      // The last 7 days against the pro-rated targets, with the sections.
      expect(snapshot.activity).toEqual({
        from: '2026-09-08', to: ROSTER_TODAY,
        targets: week.targets.map((t) => ({ key: t.key, code: t.code, logged: t.logged, target: t.target })),
        sections: week.sections.map((s) => ({ code: s.code, label: s.label, total: s.total, rows: s.rows })),
      });
      expect((snapshot.activity.targets as Doc[]).find((t) => t.code === 'LEADS_CONTACTED')!.logged).toBe(6);

      const stored = await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(done.sessionId as string) });
      expect(stored!.frozenAt).toEqual(ROSTER_NOW);
      expect(Object.keys(stored!.snapshot).sort()).toEqual(['activity', 'goal', 'ratios', 'takenAt']);
      // Nothing in it is a leader note, at any depth.
      expect(JSON.stringify(stored)).not.toMatch(/leaderNote|"notes?"/);

      // Its own entries — the finalize, and the answer's read — and none per figure it froze.
      const entries = await audits({});
      expect(entries.map((e) => [e.action, e.after?.surface ?? null]).sort()).toEqual([
        // Start's answer, the save's none, finalize's answer.
        [SUBJECT_READ_ACTION, 'coaching_session'], [SUBJECT_READ_ACTION, 'coaching_session'],
        ['coaching_session.finalized', null],
      ].sort());
      expect(entries.find((e) => e.action === 'coaching_session.finalized')).toMatchObject({
        targetCollection: 'coachingSessions', targetId: done.sessionId, targetMembershipId: id('INDAH'),
        after: { version: done.version, date: ROSTER_TODAY, correction: false },
      });
    });

    it('P11-T5 AC-4 a balance ratio keeps the two sides the Ratios card named, so the record can say which way it leaned', async () => {
      // Sari is an AAB: *Selling vs Recruitment* is a question about her rung, and the rates are too.
      const sari = { membershipId: id('SARI'), orgLevelCode: 'AAB', self: false };
      const live = await wired.activityLogs.ratiosOf(office.as('AGUS'), sari);
      expect(live.ratios.find((r) => r.code === 'SELLING_VS_RECRUITMENT')!.sides)
        .toEqual({ numerator: 'Penjualan', denominator: 'Recruitment' });

      const done = await finalized('AGUS', 'SARI');
      const rows = (done.snapshot as { ratios: { rows: Doc[] } }).ratios.rows;

      // Each row's sides are the live answer's, the balance's named and every rate's `null`.
      expect(rows.map((r) => [r.code, r.sides])).toEqual(live.ratios.map((r) => [r.code, r.sides]));
      expect(rows.find((r) => r.code === 'SELLING_VS_RECRUITMENT')!.sides).toEqual({ numerator: 'Penjualan', denominator: 'Recruitment' });
      expect(rows.filter((r) => r.comparison === 'gte').every((r) => r.sides === null)).toBe(true);
      // Stored as answered, and read back the same.
      const stored = await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(done.sessionId) });
      expect(stored!.snapshot.ratios.rows).toEqual(rows);
      expect((await read(done.sessionId).expect(200)).body.snapshot.ratios.rows).toEqual(rows);
    });

    it('P11-T5 AC-4 a snapshot taken before the sides existed still reads, without them and without a guess', async () => {
      const older = await fixtureSession('AGUS', 'SARI');
      const row = {
        code: 'SELLING_VS_RECRUITMENT', label: 'Selling vs Recruitment', comparison: 'band', displayUnit: 'points',
        benchmark: 0.3, value: 12, share: 56, status: 'success',
      };
      await col('coachingSessions').updateOne({ _id: older._id }, { $set: {
        snapshot: {
          takenAt: new Date('2026-09-02T04:00:00Z'), goal: null, activity: null,
          ratios: { from: '2026-08-04', to: '2026-09-02', days: 30, rows: [row] },
        },
      } });

      as('AGUS');
      const res = await read(String(older._id)).expect(200);

      expect(res.body.snapshot.ratios.rows).toEqual([row]);
      expect(res.body.snapshot.ratios.rows[0]).not.toHaveProperty('sides');
    });

    it('P11-T5 AC-7 tells the coachee — `{ sessionId }`, nothing a leader typed — and sends the round’s held goal email', async () => {
      const done = await finalized('AGUS', 'INDAH', [dated('A private-sounding item the coachee must not get in a payload')]);
      const indahUser = (await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id('INDAH')) }))!.userId;

      expect(wired.sentNotifications).toEqual([{
        userId: String(indahUser), kpmId: KPM_A, membershipId: id('INDAH'),
        templateId: NotificationTemplate.COACHING_SESSION_FINALIZED, payload: { sessionId: done.sessionId },
      }]);
      expect(wired.releasedNotifications).toEqual([
        { kpmId: KPM_A, coalesceKey: `${done.sessionId}:0`, templateId: NotificationTemplate.GOAL_SET_BY_LEADER },
      ]);
    });

    it('P11-T5 AC-7 a notice that fails does not fail the finalize, which is already written', async () => {
      const notifier = (wired.coachingSession as unknown as { notifications: Record<string, (...a: unknown[]) => Promise<void>> }).notifications;
      const send = jest.spyOn(notifier, 'send').mockRejectedValueOnce(new Error('preferences unavailable'));
      const release = jest.spyOn(notifier, 'releaseHeld').mockRejectedValueOnce(new Error('smtp down'));
      try {
        const done = await finalized('AGUS', 'INDAH');
        expect(done.status).toBe('finalized');
        expect(send).toHaveBeenCalled();
        expect(release).toHaveBeenCalled();
      } finally {
        send.mockRestore();
        release.mockRestore();
      }
    });

    it('P11-T5 AC-5 a finalized session is immutable: a save and a finalize answer COACHING_SESSION_FINALIZED', async () => {
      const done = await finalized('AGUS', 'INDAH');
      const body = { version: done.version, lastWeekItems: [], actionItems: [dated('changed')], tips: [] };
      expect((await save(done.sessionId, body).expect(409)).body.error.code).toBe('COACHING_SESSION_FINALIZED');
      expect((await finalize(done.sessionId, done.version).expect(409)).body.error.code).toBe('COACHING_SESSION_FINALIZED');
      // Even at a stale version: the state is the answer before the version.
      expect((await save(done.sessionId, { ...body, version: 1 }).expect(409)).body.error.code).toBe('COACHING_SESSION_FINALIZED');
    });

    it('P11-T5 AC-8 a session’s date is the office’s day of its first finalize: 23:59 and 00:01 in Jakarta', async () => {
      clock.set(new Date('2026-09-14T16:59:00Z'));
      expect((await finalized('AGUS', 'INDAH')).date).toBe('2026-09-14');
      clock.set(new Date('2026-09-14T17:01:00Z'));
      expect((await finalized('AGUS', 'DIMAS')).date).toBe('2026-09-15');
    });

    it('P11-T5 AC-3 a save racing a finalize: exactly one lands, and the other is told why', async () => {
      const started = (await start('AGUS', 'INDAH').expect(201)).body;
      const saved = (await save(started.sessionId, { version: 1, lastWeekItems: [], actionItems: [dated()], tips: [] }).expect(200)).body;
      const raced = await Promise.all([
        finalize(started.sessionId, saved.version),
        save(started.sessionId, { version: saved.version, lastWeekItems: [], actionItems: [dated('late')], tips: [] }),
      ]);
      const codes = raced.map((r) => (r.status === 200 ? 'OK' : r.body.error.code));
      expect(codes.filter((code) => code === 'OK')).toHaveLength(1);
      expect(['COACHING_SESSION_FINALIZED', 'VERSION_CONFLICT']).toContain(codes.find((code) => code !== 'OK'));
    });
  });

  // ------------------------------------------------------------------ reopen

  describe('reopen (AC-6, ADR-0079)', () => {
    it('P11-T5 AC-6 keeps the finalized state whole with who, when and why; the earlier version stays readable; date, freeze and snapshot never move', async () => {
      const done = await finalized('AGUS', 'INDAH', [dated('As agreed')]);
      const before = await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(done.sessionId as string) });
      clock.set(new Date('2026-09-16T03:00:00Z'));
      await col('auditLog').deleteMany({});

      as('AGUS');
      const reopened = (await reopen(done.sessionId, done.version, '  Two dates were wrong.  ').expect(200)).body;

      expect(reopened).toMatchObject({ status: 'reopened', version: done.version + 1, date: ROSTER_TODAY, reopenableUntil: null });
      expect(reopened.earlier).toEqual([{
        finalizedAt: ROSTER_NOW.toISOString(), finalizedBy: { membershipId: id('AGUS'), name: 'Agus Salim' },
        reopenedAt: '2026-09-16T03:00:00.000Z', reopenedBy: { membershipId: id('AGUS'), name: 'Agus Salim' },
        reason: 'Two dates were wrong.',
        lastWeekItems: done.lastWeekItems, leadActions: done.leadActions, actionItems: done.actionItems, tips: done.tips,
      }]);
      const after = await col('coachingSessions').findOne({ _id: before!._id });
      expect(after!.corrections[0]).toMatchObject({ version: done.version, byMembershipId: id('AGUS'), reason: 'Two dates were wrong.' });
      for (const field of ['date', 'frozenAt', 'snapshot'] as const) expect([field, after![field]]).toEqual([field, before![field]]);

      const [entry] = await audits({ action: 'coaching_session.reopened' });
      expect(entry).toMatchObject({ targetId: done.sessionId, targetMembershipId: id('INDAH'), after: { reason: 'Two dates were wrong.' } });

      // Meanwhile the latest finalized version counts, and the correction is shown to its coach alone.
      as('OWNER');
      const owner = (await read(done.sessionId).expect(200)).body;
      expect(owner).toMatchObject({ status: 'finalized', version: done.version, actionItems: done.actionItems, earlier: [] });
      as('INDAH');
      expect((await read(done.sessionId).expect(200)).body).toMatchObject({ status: 'finalized', actionItems: done.actionItems });

      // A second reopen is refused: it is not finalized.
      as('AGUS');
      const again = await reopen(done.sessionId, reopened.version).expect(409);
      expect(again.body.error).toMatchObject({ code: 'COACHING_SESSION_NOT_FINALIZED', details: { status: 'reopened' } });

      // Its coach corrects and finalizes it again: a new version, the window not restarted.
      const corrected = (await save(done.sessionId, {
        version: reopened.version, lastWeekItems: [], actionItems: [dated('As corrected', '2026-09-22')], tips: [],
      }).expect(200)).body;
      const refinal = (await finalize(done.sessionId, corrected.version).expect(200)).body;
      expect(refinal).toMatchObject({
        status: 'finalized', date: ROSTER_TODAY, reopenableUntil: '2026-09-21', snapshot: done.snapshot,
        finalizedAt: '2026-09-16T03:00:00.000Z', actionItems: [{ text: 'As corrected', dueDate: '2026-09-22' }],
      });
      expect(refinal.earlier).toHaveLength(1);
      expect(refinal.earlier[0].actionItems).toEqual(done.actionItems);
      const [final] = await audits({ action: 'coaching_session.finalized' });
      expect(final.after).toMatchObject({ date: ROSTER_TODAY, correction: true });
      // The correction's own round of goal notices is released, not the first round's again.
      expect(wired.releasedNotifications.map((r) => r.coalesceKey)).toEqual([`${done.sessionId}:0`, `${done.sessionId}:1`]);
    });

    it('P11-T5 AC-6 a session under correction is the next draft’s last week as its latest finalized version, and holds up no Start', async () => {
      const done = await finalized('AGUS', 'INDAH', [dated('As agreed')]);
      as('AGUS');
      await reopen(done.sessionId, done.version).expect(200);
      await save(done.sessionId, { version: done.version + 1, lastWeekItems: [], actionItems: [dated('Being corrected')], tips: [] }).expect(200);

      const next = (await start('AGUS', 'INDAH').expect(201)).body;
      expect(next.lastWeek).toEqual({ sessionId: done.sessionId, date: ROSTER_TODAY });
      expect(next.lastWeekItems.map((i: Doc) => i.text)).toEqual(['As agreed']);
    });

    it('P11-T5 AC-6 the window: the seventh day after the session’s date is the last, then COACHING_REOPEN_WINDOW_CLOSED', async () => {
      const lastDay = await finalized('AGUS', 'INDAH');
      const closed = await finalized('AGUS', 'DIMAS');
      as('AGUS');
      clock.set(new Date('2026-09-21T16:00:00Z')); // 23:00 on the 21st in Jakarta: the last day.
      await reopen(lastDay.sessionId, lastDay.version).expect(200);
      clock.set(new Date('2026-09-21T17:00:00Z')); // 00:00 on the 22nd.
      const res = await reopen(closed.sessionId, closed.version).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'COACHING_REOPEN_WINDOW_CLOSED',
        message: 'This session could be reopened until 21 Sep 2026, 7 days after it was held.',
        details: { date: ROSTER_TODAY, reopenableUntil: '2026-09-21', windowDays: 7 },
      });
      // *Edit again* says until when, past the window too.
      expect((await read(closed.sessionId).expect(200)).body.reopenableUntil).toBe('2026-09-21');
    });

    it('P11-T5 AC-6 the refusals, in the contract’s order', async () => {
      const done = await finalized('AGUS', 'INDAH');
      const draft = (await start('AGUS', 'DIMAS').expect(200)).body; // the fixture's open draft

      // The reason first: blank, absent or too long is refused before anything is looked up.
      as('AGUS');
      const nobody = new mongoose.Types.ObjectId().toString();
      for (const body of [{ reason: '   ' }, {}, { reason: 'x'.repeat(501) }, { reason: 7 }]) {
        const res = await http().post(`/coaching/sessions/${nobody}/reopen`).send({ version: 1, ...body }).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      // Reach: anybody but its coach while they coach, and the Owner and the Admin, is 404.
      for (const who of ['SARI', 'PEER_AB', 'B_AB'] as Who[]) {
        as(who);
        expect([who, (await reopen(done.sessionId, done.version)).status]).toEqual([who, 404]);
      }
      as('INDAH');
      await reopen(done.sessionId, done.version).expect(403);
      // A draft: its coach is told it is not finalized; the Owner, who cannot read a draft, is not told it exists.
      as('AGUS');
      expect((await reopen(draft.sessionId, draft.version).expect(409)).body.error)
        .toMatchObject({ code: 'COACHING_SESSION_NOT_FINALIZED', details: { status: 'draft' } });
      as('OWNER');
      await reopen(draft.sessionId, draft.version).expect(404);
      // The version last.
      as('AGUS');
      expect((await reopen(done.sessionId, done.version - 1).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
    });

    it('P11-T5 AC-6 the Owner and the Admin reopen while its coach still coaches; only the coach finalizes the correction', async () => {
      const done = await finalized('AGUS', 'INDAH');
      as('ADMIN');
      expect((await read(done.sessionId).expect(200)).body.reopenableUntil).toBe('2026-09-21');
      const reopened = (await reopen(done.sessionId, done.version, 'The coachee asked for a change.').expect(200)).body;
      // The Admin reads the latest finalized version: the correction is the coach's until finalized.
      expect(reopened).toMatchObject({ status: 'finalized', version: done.version, earlier: [] });
      const [entry] = await audits({ action: 'coaching_session.reopened' });
      expect(entry.actorMembershipId).toBe(id('ADMIN'));

      // The Admin cannot finalize it; its coach can.
      await finalize(done.sessionId, done.version + 1).expect(404);
      as('AGUS');
      expect((await finalize(done.sessionId, done.version + 1).expect(200)).body.earlier[0]).toMatchObject({
        reopenedBy: { membershipId: id('ADMIN'), name: 'Maya Kusuma' }, reason: 'The coachee asked for a change.',
      });
    });

    it('P11-T5 AC-6 an Owner’s reopen of a session whose coach no longer coaches the coachee is COACHING_REOPEN_COACH_NOT_CURRENT', async () => {
      const done = await finalized('AGUS', 'INDAH');
      await move('INDAH', 'PEER_AB');

      as('OWNER');
      const res = await reopen(done.sessionId, done.version).expect(409);
      expect(res.body.error.code).toBe('COACHING_REOPEN_COACH_NOT_CURRENT');
      // Nor does the Owner read a reopen it could not make.
      expect((await read(done.sessionId).expect(200)).body.reopenableUntil).toBeNull();
      // Its coach, whose edge closed, is not told anything about it: 404.
      as('AGUS');
      await reopen(done.sessionId, done.version).expect(404);
      // The new leader reads it, and reopens none of it.
      as('PEER_AB');
      expect((await read(done.sessionId).expect(200)).body).toMatchObject({ status: 'finalized', reopenableUntil: null });
      await reopen(done.sessionId, done.version).expect(404);
    });
  });

  // ------------------------------------------------------------------ who reads a session

  /*
   * **The session in Indonesian** (P18.98-T5 AC-4, AC-6, AC-7): a refusal's words follow the request's
   * `Accept-Language`, its code and details the same in both; *From leads (automatic)*'s *Follow up with {name}* is
   * written for the reader while the session is open, and stored at finalize in the language of the leader finalizing.
   */
  describe('P18.98-T5 AC-7 in Indonesian', () => {
    it('P18.98-T5 AC-7 refuses finalize in Indonesian, with the same rule', async () => {
      const started = (await start('AGUS', 'LUKAS').expect(201)).body;
      const res = await finalize(started.sessionId, started.version).set('Accept-Language', 'id').expect(422);
      expect(res.body.error).toMatchObject({
        code: 'COACHING_SESSION_INCOMPLETE',
        message: 'Tambahkan paling tidak satu action item sebelum memfinalkan.',
        details: { rule: 'NO_ACTION_ITEM' },
      });
    });

    it('P18.98-T5 AC-4, AC-6 writes *Follow up with* for the reader while open, and stores it as the leader finalized it', async () => {
      const promised = await lead('LUKAS', { name: 'Pak Fauzan Akbar', nextActionDate: '2026-09-16' });
      const started = (await start('AGUS', 'LUKAS').expect(201)).body;
      const line = (text: string) => [{ leadId: promised, leadName: 'Pak Fauzan Akbar', dueDate: '2026-09-16', text }];

      // Open: written live, for whoever reads it.
      expect((await read(started.sessionId).set('Accept-Language', 'id').expect(200)).body.leadActions)
        .toEqual(line('Follow up dengan Pak Fauzan Akbar'));
      expect((await read(started.sessionId).expect(200)).body.leadActions).toEqual(line('Follow up with Pak Fauzan Akbar'));

      // Finalized by a leader reading Indonesian: stored in their words, and shown as stored to every reader.
      const saved = (await save(started.sessionId, { version: started.version, lastWeekItems: [], actionItems: [dated()], tips: [] })
        .expect(200)).body;
      const done = (await finalize(started.sessionId, saved.version).set('Accept-Language', 'id').expect(200)).body;
      expect(done.leadActions).toEqual(line('Follow up dengan Pak Fauzan Akbar'));
      expect((await read(started.sessionId).expect(200)).body.leadActions).toEqual(line('Follow up dengan Pak Fauzan Akbar'));
    });

    it('P18.98-T5 AC-7 refuses a reopen past its window in Indonesian, the day in it; and a blank reason by the DTO’s sentence', async () => {
      const closed = await finalized('AGUS', 'DIMAS');
      as('AGUS');
      clock.set(new Date('2026-09-21T17:00:00Z')); // 00:00 on the 22nd in Jakarta.
      const res = await reopen(closed.sessionId, closed.version).set('Accept-Language', 'id').expect(409);
      expect(res.body.error).toMatchObject({
        code: 'COACHING_REOPEN_WINDOW_CLOSED',
        message: 'Sesi ini hanya dapat dibuka kembali sampai 21 Sep 2026, 7 hari setelah diadakan.',
        details: { date: ROSTER_TODAY, reopenableUntil: '2026-09-21', windowDays: 7 },
      });

      const blank = await reopen(closed.sessionId, closed.version, '   ').set('Accept-Language', 'id').expect(400);
      expect(blank.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', message: 'reason tidak boleh kosong', details: { violations: ['reason tidak boleh kosong'] },
      });
    });
  });

  describe('who reads a session', () => {
    it.each([
      ['AGUS', 'its coach'],
      ['OWNER', 'another current coach: the root AB'],
      ['ADMIN', 'the Admin, own-kpm'],
      ['INDAH', 'the coachee'],
    ] as [Who, string][])('P11-T5 %s, %s, reads a finalized session', async (who) => {
      const done = await finalized('AGUS', 'INDAH');
      await col('auditLog').deleteMany({});
      as(who);
      const res = await read(done.sessionId).expect(200);
      expect(res.body).toMatchObject({ status: 'finalized', actionItems: done.actionItems, snapshot: done.snapshot });
      // A read of Indah's data, recorded — except Indah's own.
      expect(await col('auditLog').countDocuments({ action: SUBJECT_READ_ACTION })).toBe(who === 'INDAH' ? 0 : 1);
    });

    it.each([
      ['SARI', 'an AAB beside the coach'],
      ['PEER_AB', 'a peer AB'],
      ['PEER_AAB', 'a peer AAB'],
      ['DIMAS', 'another agent'],
      ['B_AB', 'another office'],
    ] as [Who, string][])('P11-T5 AC-9 %s, %s, is 404', async (who) => {
      const done = await finalized('AGUS', 'INDAH');
      as(who);
      expect((await read(done.sessionId).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P11-T5 a draft is its coach’s alone, while they coach the coachee', async () => {
      const draft = (await start('AGUS', 'INDAH').expect(201)).body;
      for (const who of ['OWNER', 'ADMIN', 'INDAH', 'SARI'] as Who[]) {
        as(who);
        expect([who, (await read(draft.sessionId)).status]).toEqual([who, 404]);
      }
      as('AGUS');
      expect((await read(draft.sessionId).expect(200)).body.status).toBe('draft');
    });

    it('P11-T5 From leads (automatic) is read live by its coach on an open session, and as taken by everybody else', async () => {
      const hendro = await lead('INDAH', { nextActionDate: '2026-09-17' });
      const done = await finalized('AGUS', 'INDAH');
      as('AGUS');
      await reopen(done.sessionId, done.version).expect(200);
      await col('leads').updateOne({ _id: new mongoose.Types.ObjectId(hendro) }, { $set: { nextActionDate: '2026-09-19' } });

      expect((await read(done.sessionId).expect(200)).body.leadActions[0].dueDate).toBe('2026-09-19');
      as('OWNER');
      expect((await read(done.sessionId).expect(200)).body.leadActions[0].dueDate).toBe('2026-09-17');
    });

    it('P11-T5 a Super Admin, who has no membership to read from, is refused by name; an id that is nobody’s is 404', async () => {
      const done = await finalized('AGUS', 'INDAH');
      session.current = SUPER_ADMIN;
      expect((await read(done.sessionId).expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      as('AGUS');
      await read(new mongoose.Types.ObjectId().toString()).expect(404);
      await read('not-a-session').expect(404);
    });
  });

  // ------------------------------------------------------------------ B1: lead rows, roles §3.7

  /*
   * Phase 11 exit review, B1 (roles §3.7: lead records are not admin-readable, "never the lead rows"). The
   * Owner and the Admin read every finalized session in the office (`own-kpm`), but `lead:read` does not
   * reach the office for them: one who does not coach the coachee reads no lead name and none of the
   * agent's lead-note text — the rule `GET /summary?for=` applies. Maya (ADMIN) leads nobody; Wilson
   * (OWNER) is the root AB, above everybody, and reads them as a coach.
   */
  describe('B1 lead names and lead-note text, only to a reader who may read the coachee’s leads', () => {
    const HENDRO = 'Pak Hendro Gunawan';
    const LEAD_TEXTS = [HENDRO, 'Collect the signed SPAJ.', 'Ask Pak Hendro for the referral.', 'Follow up with Pak Hendro Gunawan'];

    /** A session of Agus's with Indah holding lead rows everywhere a session holds them, a correction included. */
    async function withLeads(): Promise<string> {
      const hendro = await lead('INDAH', { nextActionDate: '2026-09-17', nextActionNote: 'Ask Pak Hendro for the referral.' });
      const lastWeekItems = [
        { itemId: 'INDAH-1', text: 'Book two presentations', dueDate: '2026-09-10', leadId: null, leadName: null, done: true },
        { itemId: `lead-${hendro}`, text: 'Collect the signed SPAJ.', dueDate: '2026-09-11', leadId: hendro, leadName: HENDRO, done: true },
      ];
      const actionItems = [
        { itemId: 'a1', text: 'Shadow Sari on one presentation', dueDate: '2026-09-18', carriedFromItemId: null },
        // Carried forward by Start from a lead-derived item: its text is the lead's note.
        { itemId: 'a2', text: 'Ask Pak Hendro for the referral.', dueDate: null, carriedFromItemId: `lead-${hendro}` },
      ];
      const tips = [{ tipId: 't1', text: 'Listen first.', carriedFromTipId: null }];
      const at = new Date('2026-09-12T04:00:00Z');
      const { _id } = await wired.coachingSessions.create(office.as('AGUS'), {
        coachMembershipId: id('AGUS'), coacheeMembershipId: id('INDAH'), status: 'finalized', date: '2026-09-12',
        frozenAt: at, finalizedAt: new Date('2026-09-13T04:00:00Z'), finalizedByMembershipId: id('AGUS'), version: 5,
        lastWeek: null, lastWeekItems, actionItems, tips,
        leadActions: [{ leadId: hendro, leadName: HENDRO, dueDate: '2026-09-17', text: 'Ask Pak Hendro for the referral.' }],
        snapshot: null,
        corrections: [{
          version: 3, lastWeekItems, actionItems, tips, finalizedAt: at, finalizedByMembershipId: id('AGUS'),
          leadActions: [{ leadId: hendro, leadName: HENDRO, dueDate: '2026-09-16', text: 'Follow up with Pak Hendro Gunawan' }],
          at: new Date('2026-09-13T02:00:00Z'), byMembershipId: id('AGUS'), reason: 'A date was wrong.',
        }],
      } as never);
      return String(_id);
    }

    const mentionsALead = (body: unknown) => LEAD_TEXTS.filter((text) => JSON.stringify(body).includes(text));

    it('B1 GET /coaching/sessions/:sessionId — the Admin who is not above Indah reads it without its lead rows, here and in earlier[]', async () => {
      const sessionId = await withLeads();
      as('ADMIN');
      const res = (await read(sessionId).expect(200)).body;

      expect(res.leadActions).toEqual([]);
      expect(res.lastWeekItems).toEqual([
        { itemId: 'INDAH-1', text: 'Book two presentations', dueDate: '2026-09-10', lead: null, done: true },
      ]);
      expect(res.earlier).toHaveLength(1);
      expect(res.earlier[0]).toMatchObject({ reason: 'A date was wrong.', leadActions: [], lastWeekItems: [{ itemId: 'INDAH-1', lead: null }] });
      expect(res.earlier[0].lastWeekItems).toHaveLength(1);
      // The rest of the session is the office's to read: the typed items, the tips.
      expect(res).toMatchObject({ actionItems: [{ text: 'Shadow Sari on one presentation' }], tips: [{ text: 'Listen first.' }] });
      // The B1 residue: an item carried from a lead is the lead's note, and goes with the lead rows.
      expect(res.actionItems).toHaveLength(1);
      expect(res.earlier[0].actionItems).toHaveLength(1);
      expect(mentionsALead(res)).toEqual([]);
      // A read of Indah's data all the same: the session's own entry.
      expect(await col('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, 'after.surface': 'coaching_session' })).toBe(1);
    });

    it.each([
      ['AGUS', 'its coach'],
      ['OWNER', 'the Owner, who is above her and reads it as a coach'],
      ['INDAH', 'the coachee'],
    ] as [Who, string][])('B1 GET /coaching/sessions/:sessionId — %s, %s, keeps every lead row', async (who) => {
      const sessionId = await withLeads();
      as(who);
      const res = (await read(sessionId).expect(200)).body;

      expect(res.leadActions).toEqual([expect.objectContaining({ leadName: HENDRO, text: 'Ask Pak Hendro for the referral.' })]);
      expect(res.lastWeekItems.map((i: Doc) => i.lead && (i.lead as Doc).name)).toEqual([null, HENDRO]);
      expect(res.earlier[0].leadActions).toEqual([expect.objectContaining({ text: 'Follow up with Pak Hendro Gunawan' })]);
      expect(mentionsALead(res).sort()).toEqual([...LEAD_TEXTS].sort());
    });

    it('B1 the Admin who comes to stand above Indah reads them as a coach', async () => {
      const sessionId = await withLeads();
      await move('INDAH', 'ADMIN');
      as('ADMIN');
      expect((await read(sessionId).expect(200)).body.leadActions).toEqual([expect.objectContaining({ leadName: HENDRO })]);
    });

    it('B1 POST /coaching/sessions/:sessionId/reopen — the Admin’s answer holds no lead row either', async () => {
      const sessionId = await withLeads();
      as('ADMIN');
      const reopened = (await reopen(sessionId, 5, 'The coachee asked for a change.').expect(200)).body;
      expect(reopened).toMatchObject({ status: 'finalized', version: 5, leadActions: [] });
      expect(mentionsALead(reopened)).toEqual([]);
      // Its coach, correcting it, reads them all.
      as('AGUS');
      expect(mentionsALead((await read(sessionId).expect(200)).body)).toEqual(expect.arrayContaining([HENDRO]));
    });

    it('B1 GET /coaching/coachees/:membershipId/sessions — the counts are kept: the Admin counts what the coach counts', async () => {
      const sessionId = await withLeads();
      as('AGUS');
      const coach = (await history('INDAH').expect(200)).body.sessions.find((r: Doc) => r.sessionId === sessionId);
      as('ADMIN');
      const admin = (await history('INDAH').expect(200)).body.sessions.find((r: Doc) => r.sessionId === sessionId);
      expect(admin).toEqual({ ...coach });
      expect(admin.actionItemCount).toBe(3);
    });
  });

  // ------------------------------------------------------------------ history

  describe('a coachee’s history, and what the workspace opens on', () => {
    it('P11-T5 newest first with its counts; current follows the coach’s own draft, correction and today’s session', async () => {
      const lastWeek = String((await fixtureSession('AGUS', 'INDAH'))._id);
      as('AGUS');
      let res = (await history('INDAH').expect(200)).body;
      expect(res).toEqual({
        today: ROSTER_TODAY, current: null,
        sessions: [{ sessionId: lastWeek, date: '2026-09-10', coach: { membershipId: id('AGUS'), name: 'Agus Salim' }, actionItemCount: 1, completedCount: 0 }],
      });

      const draft = (await start('AGUS', 'INDAH').expect(201)).body;
      const ticked = (await save(draft.sessionId, {
        version: 1, lastWeekItems: [{ itemId: 'INDAH-1', done: true }], actionItems: [dated(), dated('Second')], tips: [],
      }).expect(200)).body;
      res = (await history('INDAH').expect(200)).body;
      expect(res.current).toEqual({ sessionId: draft.sessionId, status: 'draft' });
      // Ticked done by the reader's own open draft, which reviews it.
      expect(res.sessions[0].completedCount).toBe(1);

      const done = (await finalize(draft.sessionId, ticked.version).expect(200)).body;
      res = (await history('INDAH').expect(200)).body;
      expect(res.current).toEqual({ sessionId: done.sessionId, status: 'finalized' });
      expect(res.sessions.map((s: Doc) => [s.sessionId, s.date, s.actionItemCount, s.completedCount])).toEqual([
        [done.sessionId, ROSTER_TODAY, 2, 0], [lastWeek, '2026-09-10', 1, 1],
      ]);

      await reopen(done.sessionId, done.version).expect(200);
      expect((await history('INDAH').expect(200)).body.current).toEqual({ sessionId: done.sessionId, status: 'reopened' });

      // The next day nothing is current: the workspace opens before Start.
      clock.set(new Date('2026-09-15T03:00:00Z'));
      await finalize(done.sessionId, done.version + 1).expect(200);
      clock.set(new Date('2026-09-16T03:00:00Z'));
      expect((await history('INDAH').expect(200)).body.current).toBeNull();
      // Nothing about any of this was recorded as a read: dates, coaches and counts.
      expect(await col('auditLog').countDocuments({ action: SUBJECT_READ_ACTION, 'after.surface': { $ne: 'coaching_session' } })).toBe(0);
    });

    it('P11-T5 another current coach and the Owner and the Admin read every finalized one; current is their own', async () => {
      await finalized('AGUS', 'RINA');
      for (const who of ['SARI', 'OWNER', 'ADMIN'] as Who[]) {
        as(who);
        const res = (await history('RINA').expect(200)).body;
        // Newest first by date, then by when each was first finalized: Sari's 1:1 today came after Agus's.
        expect([who, res.sessions.map((s: Doc) => [s.date, s.coach])]).toEqual([who, [
          [ROSTER_TODAY, { membershipId: id('SARI'), name: 'Sari Puspita' }],
          [ROSTER_TODAY, { membershipId: id('AGUS'), name: 'Agus Salim' }],
          ['2026-09-07', { membershipId: id('SARI'), name: 'Sari Puspita' }],
        ]]);
        expect([who, res.current?.sessionId ?? null]).toEqual([who, who === 'SARI'
          ? String((await col('coachingSessions').findOne({ coachMembershipId: id('SARI'), date: ROSTER_TODAY }))!._id)
          : null]);
      }
    });

    it('P11-T5 a coachee with no finalized session has an empty history, and the coach’s draft is what opens', async () => {
      as('AGUS');
      expect((await history('LUKAS').expect(200)).body).toEqual({ today: ROSTER_TODAY, current: null, sessions: [] });
      const dimas = String((await col('coachingSessions').findOne({ coacheeMembershipId: id('DIMAS'), status: 'draft' }))!._id);
      expect((await history('DIMAS').expect(200)).body).toEqual({
        today: ROSTER_TODAY, current: { sessionId: dimas, status: 'draft' }, sessions: [],
      });
    });

    it('P11-T5 completedCount is the reviewing session the reader may count: their own open draft, never somebody else’s', async () => {
      // Budi's last 1:1 is reviewed by two drafts at once: Sari's, and Agus's above her.
      const sari = (await start('SARI', 'BUDI').expect(201)).body;
      const agus = (await start('AGUS', 'BUDI').expect(201)).body;
      const tickAll = (draft: Doc & { lastWeekItems: { itemId: string }[] }, n: number) => save(draft.sessionId as string, {
        version: 1, lastWeekItems: draft.lastWeekItems.slice(0, n).map((i) => ({ itemId: i.itemId, done: true })),
        actionItems: [], tips: [],
      }).expect(200);
      as('SARI');
      await tickAll(sari, 1);
      as('AGUS');
      await tickAll(agus, 0);

      as('SARI');
      expect((await history('BUDI').expect(200)).body.sessions[0].completedCount).toBe(1);
      as('AGUS');
      expect((await history('BUDI').expect(200)).body.sessions[0].completedCount).toBe(0);
      // The Owner has no draft of their own reviewing it, and reads nobody else's.
      as('OWNER');
      expect((await history('BUDI').expect(200)).body.sessions[0].completedCount).toBe(0);
    });

    it('P11-T5 a coach whose membership is gone is a session the history still lists, its name empty', async () => {
      as('SARI');
      expect((await history('BUDI').expect(200)).body.sessions[0].coach.name).toBe('');
    });

    it.each([
      ['PEER_AB', 'INDAH', 'a peer AB'],
      ['B_AB', 'INDAH', 'another office'],
      ['INDAH', 'INDAH', 'the coachee, whose own coaching is elsewhere'],
      ['SARI', 'INDAH', 'an AAB who never led a session with them'],
      ['ADMIN', 'B_AGENT', 'the Admin, on another office’s member'],
    ] as [Who, Who, string][])('P11-T5 AC-9 %s reading %s’s history, %s, is 404', async (who, coachee) => {
      as(who);
      expect((await history(coachee).expect(404)).body.error.code).toBe('NOT_FOUND');
    });
  });

  // ------------------------------------------------------------------ exit criterion 1

  it('P11-T5 exit criterion 1: a goal, a lead and a logged day changed after finalize leave the session as it was agreed', async () => {
    const hendro = await lead('INDAH', { nextActionDate: '2026-09-17', nextActionNote: 'Collect the signed SPAJ.' });
    const done = await finalized('AGUS', 'INDAH');
    as('AGUS');
    const agreed = (await read(done.sessionId).expect(200)).body;
    const listed = (await history('INDAH').expect(200)).body.sessions;

    // A new target for the year, saved by her leader; a lead renamed and moved; a day logged.
    const plan = await wired.goals.readOrDefaults(office.as('AGUS'), '2026', id('INDAH'));
    await wired.goals.save(office.as('AGUS'), {
      period: '2026', mode: plan.mode, annualApeTargetMinor: 900_000_000_00, savingsTargetMinor: plan.savingsTargetMinor,
      commissionRatePct: plan.commissionRatePct, monthsLeft: plan.monthsLeft, apeAchievedMinor: plan.apeAchievedMinor,
      caseSizeMinor: plan.caseSizeMinor, leadsToApptPct: plan.leadsToApptPct, closingRatePct: plan.closingRatePct,
    }, id('INDAH'));
    expect((await col('goals').findOne({ membershipId: id('INDAH') }))!.annualApeTargetMinor).toBe(900_000_000_00);
    await col('leads').updateOne(
      { _id: new mongoose.Types.ObjectId(hendro) },
      { $set: { name: 'Pak Hendro (renamed)', nextActionDate: '2026-09-25', nextActionNote: 'Something else' } },
    );
    await col('activityLogs').updateOne(
      { membershipId: id('INDAH'), localDate: '2026-09-10' },
      { $set: { entries: [{ activityTypeId: 't', activityTypeCode: 'SELL_SUBMISSION', count: 9 }], totalCount: 9 } },
    );
    clock.set(new Date('2026-09-15T03:00:00Z'));

    expect((await read(done.sessionId).expect(200)).body).toEqual(agreed);
    expect((await history('INDAH').expect(200)).body.sessions).toEqual(listed);
  });

  // ------------------------------------------------------------------ the tenant boundary

  describe('the tenant boundary (AC-9)', () => {
    it('P11-T5 AC-9 another office’s AB is 404 on every route for this office’s session and member', async () => {
      const done = await finalized('AGUS', 'INDAH');
      as('B_AB');
      await read(done.sessionId).expect(404);
      await save(done.sessionId, { version: done.version, lastWeekItems: [], actionItems: [], tips: [] }).expect(404);
      await finalize(done.sessionId, done.version).expect(404);
      await reopen(done.sessionId, done.version).expect(404);
      await history('INDAH').expect(404);
      await http().post(`/coaching/coachees/${id('INDAH')}/sessions`).expect(404);
      expect(await col('coachingSessions').countDocuments({ kpmId: { $ne: KPM_A } })).toBe(0);
    });

    it('P11-T5 AC-9 an office runs its own sessions, and this office reads none of them', async () => {
      const b = await finalized('B_AB', 'B_AGENT');
      expect((await col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(b.sessionId as string) }))!.kpmId)
        .not.toBe(KPM_A);
      for (const who of ['AGUS', 'OWNER', 'ADMIN'] as Who[]) {
        as(who);
        expect([who, (await read(b.sessionId as string)).status]).toEqual([who, 404]);
      }
      as('OWNER');
      await history('B_AGENT').expect(404);
    });

    it('P11-T5 AC-9 a peer AAB reaches none of an AAB’s sessions: read, save, finalize, reopen, history', async () => {
      const rina = String((await col('coachingSessions').findOne({ coacheeMembershipId: id('RINA'), date: ROSTER_TODAY }))!._id);
      as('PEER_AAB');
      await read(rina).expect(404);
      await save(rina, { version: 3, lastWeekItems: [], actionItems: [], tips: [] }).expect(404);
      await finalize(rina, 3).expect(404);
      await reopen(rina, 3).expect(404);
      await history('RINA').expect(404);
    });
  });
});
