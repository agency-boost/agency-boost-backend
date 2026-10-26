import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, session, SUPER_ADMIN } from '../../../test/http-permissions';
import { ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildForumOffice, forumApp, KPM_A, type ForumOffice } from '../../../test/forum-office';
import { LeaderMeetingsController } from './leader-meetings.controller';

/**
 * **The forum over HTTP, per role** (P18.1-T2 AC-1, AC-2, AC-3, AC-7, AC-9; P18.1-T3 AC-1), with the real
 * `PermissionsGuard`, the production pipe and the real services over `test/forum-office.ts`: who reads and writes
 * (the tag is the list), the refusals, making, moving and deleting a meeting, and *Upcoming* / *Completed* at the
 * boundary. The minutes' writes are `leader-meeting-minutes.int.spec.ts`'s; the freeze `leader-meetings.freeze.int.spec.ts`;
 * the links `leader-meeting-sharing.int.spec.ts`; isolation `leader-meetings.tenancy.spec.ts`.
 *
 * Today is 10:00 on Monday 14 September 2026 in Jakarta.
 */
describe('the Strategic Leader Forum over HTTP (P18.1-T2)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const as = (who: Who) => { session.current = office.as(who); };
  const clock = () => wired.clock as FixedClock;
  const make = async (title: string, date: string) => office.forum.create(office.as('OWNER'), { title, date });
  const audits = (action: string) => db().collection('auditLog').find({ action }).toArray();

  /** Every editor by the address — the Owner, the Admin, and a tagged AB and AAB. */
  const EDITORS: Who[] = ['OWNER', 'ADMIN', 'AGUS', 'SARI'];
  /** The Core Leaders — tagged, on a leader rung (ADR-0159 §1): editors who make, move and delete nothing. */
  const CORE_LEADERS: Who[] = ['AGUS', 'SARI'];
  /**
   * An AB, an AAB and an Agent of the office, none tagged; and INDAH, an Agent **tagged** — a tag written before
   * ADR-0159 made it a leader's, which stays on her row and makes her no Core Leader (P18.8-T5).
   */
  const NOT_TAGGED: Who[] = ['PEER_AB', 'DEWI', 'RINA', 'INDAH'];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
    // An Agent tagged before ADR-0159: the flag stays on her row and does nothing (P18.8-T5 AC-1).
    await office.tag('INDAH', true);
    app = await forumApp(office);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  afterEach(() => clock().set(ROSTER_NOW));

  it('P18.1-T2 AC-1 declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(LeaderMeetingsController)).toEqual({
      list: 'leader_meeting:read',
      create: 'leader_meeting:create',
      openShared: 'leader_meeting:read_shared_link',
      read: 'leader_meeting:read',
      reschedule: 'leader_meeting:reschedule',
      remove: 'leader_meeting:delete',
      addAgendaItem: 'leader_meeting:edit',
      saveAgendaItem: 'leader_meeting:edit',
      addActionItem: 'leader_meeting:edit',
      reorderActionItems: 'leader_meeting:edit',
      saveActionItem: 'leader_meeting:edit',
      removeActionItem: 'leader_meeting:edit',
      saveMonthlyTarget: 'leader_meeting:edit',
      share: 'leader_meeting:share_link',
      stopSharing: 'leader_meeting:share_link',
    });
  });

  describe('P18.1-T2 AC-1 who reads and writes — a positive and a negative per role, on every route', () => {
    let meetingId: string;

    beforeAll(async () => {
      meetingId = (await make('Strategic Check-in — #1', '2026-09-28')).id;
    });

    /** Every route an editor reaches by the address, each answered for a reader as `ok` says. */
    const routes = (id: string) => [
      { name: 'the list', call: () => http().get('/leader-meetings'), ok: 200 },
      { name: 'a meeting', call: () => http().get(`/leader-meetings/${id}`), ok: 200 },
      { name: 'add an agenda item', call: () => http().post(`/leader-meetings/${id}/agenda-items`).send({ section: 'post' }), ok: 201 },
      { name: 'add an action item', call: () => http().post(`/leader-meetings/${id}/action-items`), ok: 201 },
      { name: 'a Monthly Target', call: async () => {
        const cell = (await office.meetings.findById(office.as('OWNER'), id))!.monthlyTargets?.ape;
        return http().put(`/leader-meetings/${id}/monthly-targets/ape`).send({ value: 'TBD', version: cell?.version ?? 0 });
      }, ok: 200 },
      { name: 'share', call: () => http().post(`/leader-meetings/${id}/share-links`), ok: 201 },
      { name: 'stop sharing', call: () => http().delete(`/leader-meetings/${id}/share-links`), ok: 200 },
    ];

    it.each(EDITORS)('P18.1-T2 AC-1 positive: %s reads the list and the meeting, and writes every field route', async (who) => {
      as(who);
      for (const route of routes(meetingId)) {
        const res = await route.call();
        expect([route.name, res.status]).toEqual([route.name, route.ok]);
      }
    });

    it.each(NOT_TAGGED)('P18.1-T2 AC-1, P18.8-T5 AC-1 negative: %s, a field member who is no Core Leader, is answered 404 on every route, the list included', async (who) => {
      as(who);
      const before = await db().collection('auditLog').countDocuments();
      for (const route of routes(meetingId)) {
        const res = await route.call();
        expect([route.name, res.status, res.body.error?.code]).toEqual([route.name, 404, 'NOT_FOUND']);
      }
      // And an item's write — an agenda item, a row — a delete of a row, the order: the same answer, nothing written.
      as('OWNER');
      const row = (await http().post(`/leader-meetings/${meetingId}/action-items`).expect(201)).body;
      const [item] = (await http().get(`/leader-meetings/${meetingId}`).expect(200)).body.agenda.during;
      const countAfterOwnerWrite = await db().collection('auditLog').countDocuments();
      as(who);
      for (const res of [
        await http().patch(`/leader-meetings/${meetingId}/agenda-items/${item.id}`).send({ text: 'Mine', version: item.version }),
        await http().patch(`/leader-meetings/${meetingId}/action-items/${row.id}`).send({ pic: 'Me', version: 1 }),
        await http().delete(`/leader-meetings/${meetingId}/action-items/${row.id}`).query({ version: 1 }),
        await http().put(`/leader-meetings/${meetingId}/action-items/order`).send({ itemIds: [] }),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      }
      expect(await db().collection('auditLog').countDocuments()).toBe(countAfterOwnerWrite);
      expect(countAfterOwnerWrite).toBeGreaterThan(before);
    });

    it('P18.1-T2 AC-1 the 404 a field member not tagged meets is the one a meeting that is not there gives', async () => {
      as('RINA');
      const theirs = (await http().get(`/leader-meetings/${meetingId}`).expect(404)).body.error;
      as('OWNER');
      const nothing = (await http().get(`/leader-meetings/${new mongoose.Types.ObjectId()}`).expect(404)).body.error;
      const malformed = (await http().get('/leader-meetings/not-an-id').expect(404)).body.error;
      const strip = (e: { requestId?: string }) => ({ ...e, requestId: undefined });
      expect(strip(theirs)).toEqual(strip(nothing));
      expect(strip(malformed)).toEqual(strip(nothing));
    });

    it.each(['OWNER', 'ADMIN'] as Who[])('P18.1-T2 AC-1 positive: %s makes, moves and deletes a meeting', async (who) => {
      as(who);
      const made = (await http().post('/leader-meetings').send({ title: 'Made', date: '2026-10-05' }).expect(201)).body;
      const moved = (await http().patch(`/leader-meetings/${made.id}`).send({ date: '2026-10-06', version: 1 }).expect(200)).body;
      expect(moved.date).toBe('2026-10-06');
      await http().delete(`/leader-meetings/${made.id}`).query({ version: 2 }).expect(204);
    });

    it.each([...CORE_LEADERS, ...NOT_TAGGED])('P18.1-T2 AC-1 negative: %s is refused making, moving and deleting by the guard', async (who) => {
      as(who);
      for (const [res, permission] of [
        [await http().post('/leader-meetings').send({ title: 'Mine', date: '2026-10-05' }), 'leader_meeting:create'],
        [await http().patch(`/leader-meetings/${meetingId}`).send({ title: 'Mine', version: 1 }), 'leader_meeting:reschedule'],
        [await http().delete(`/leader-meetings/${meetingId}`).query({ version: 1 }), 'leader_meeting:delete'],
      ] as const) {
        expect([res.status, res.body.error.code, res.body.error.details]).toEqual([403, 'PERM_DENIED', { permission }]);
      }
    });

    it('P18.1-T2 AC-1 a Super Admin outside a support session has no office: the reads TENANT_NO_MEMBERSHIP, the writes not theirs', async () => {
      session.current = SUPER_ADMIN;
      expect((await http().get('/leader-meetings').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().get(`/leader-meetings/${meetingId}`).expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().get('/leader-meetings/shared/anything').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().post(`/leader-meetings/${meetingId}/action-items`).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await http().post('/leader-meetings').send({ title: 'x', date: '2026-10-05' }).expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P18.1-T2 AC-1 tagged, then untagged, then tagged again: the tag is read on every request', async () => {
      await office.tag('PEER_AB', true);
      as('PEER_AB');
      await http().get('/leader-meetings').expect(200);
      await http().get(`/leader-meetings/${meetingId}`).expect(200);
      await office.tag('PEER_AB', false);
      expect((await http().get('/leader-meetings').expect(404)).body.error.code).toBe('NOT_FOUND');
      expect((await http().post(`/leader-meetings/${meetingId}/action-items`).expect(404)).body.error.code).toBe('NOT_FOUND');
      await office.tag('PEER_AB', true);
      await http().get(`/leader-meetings/${meetingId}`).expect(200);
      await office.tag('PEER_AB', false);
    });

    it('P18.1-T2 AC-1 an Owner or Admin edits whatever their tag', async () => {
      const owner = await db().collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id.OWNER) });
      expect(owner!.isCoreLeader ?? false).toBe(false);
      as('OWNER');
      await http().post(`/leader-meetings/${meetingId}/agenda-items`).send({ section: 'during' }).expect(201);
    });

    it('P18.1-T2 AC-1 a read-only support session reads as its member, draws no write, is refused every write and writes nothing', async () => {
      for (const who of ['OWNER', 'AGUS'] as Who[]) {
        session.current = office.supported(who);
        const list = (await http().get('/leader-meetings').expect(200)).body;
        expect(list.can).toEqual({ create: false });
        const view = (await http().get(`/leader-meetings/${meetingId}`).expect(200)).body;
        expect(view.can).toEqual({ edit: false, share: false, reschedule: false, delete: false, manageTags: false, print: true });
        const before = { audit: await db().collection('auditLog').countDocuments(), meeting: await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(meetingId) }) };
        for (const res of [
          await http().post('/leader-meetings').send({ title: 'x', date: '2026-10-05' }),
          await http().patch(`/leader-meetings/${meetingId}`).send({ title: 'x', version: 1 }),
          await http().delete(`/leader-meetings/${meetingId}`).query({ version: 1 }),
          await http().post(`/leader-meetings/${meetingId}/agenda-items`).send({ section: 'post' }),
          await http().post(`/leader-meetings/${meetingId}/action-items`),
          await http().put(`/leader-meetings/${meetingId}/monthly-targets/flc`).send({ value: 'x', version: 0 }),
          await http().put(`/leader-meetings/${meetingId}/action-items/order`).send({ itemIds: [] }),
          await http().post(`/leader-meetings/${meetingId}/share-links`),
          await http().delete(`/leader-meetings/${meetingId}/share-links`),
        ]) {
          expect([res.status, res.body.error.code]).toEqual([403, 'PERM_DENIED']);
        }
        expect(await db().collection('auditLog').countDocuments()).toBe(before.audit);
        expect(await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(meetingId) })).toEqual(before.meeting);
      }
    });

    it('P18.1-T2 AC-1 an elevated support session writes as its member, both actors on the audit row', async () => {
      session.current = office.supported('OWNER', false);
      const row = (await http().post(`/leader-meetings/${meetingId}/action-items`).expect(201)).body;
      const [entry] = (await audits('leader_meeting.action_item_added')).filter((e) => (e.after as { item: { id: string } }).item.id === row.id);
      expect(entry).toMatchObject({ actorUserId: 'u-support', effectiveUserId: office.as('OWNER').userId, actorMembershipId: office.id.OWNER, kpmId: KPM_A });
    });
  });

  describe('P18.1-T2 AC-2 the list', () => {
    it('P18.1-T2 AC-2 newest first by date, each card’s state, editors, open items; whether the reader may make one; the bounds', async () => {
      const older = await make('Strategic Check-in — older', '2026-09-01');
      const newer = await make('Strategic Check-in — newer', '2026-09-21');
      as('OWNER');
      const list = (await http().get('/leader-meetings').expect(200)).body;
      const ids = list.meetings.map((m: { id: string }) => m.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      const dates = list.meetings.map((m: { date: string }) => m.date);
      expect(dates).toEqual([...dates].sort().reverse());
      const card = list.meetings.find((m: { id: string }) => m.id === newer.id);
      expect(card).toMatchObject({ title: 'Strategic Check-in — newer', date: '2026-09-21', state: 'upcoming', openItems: 0 });
      expect(list.meetings.find((m: { id: string }) => m.id === older.id).state).toBe('completed');
      expect(card.editors.owner).toMatchObject({ membershipId: office.id.OWNER, name: 'Wilson Tanoto', isReader: true, rung: { code: 'AB', label: 'AB' } });
      expect(card.editors.admins.map((p: { name: string }) => p.name)).toEqual(['Maya Kusuma']);
      // The Core Leaders: Indah's tag, an Agent's, makes her none (ADR-0159 §1).
      expect(card.editors.coreLeaders.map((p: { name: string }) => p.name)).toEqual(['Agus Salim', 'Sari Puspita']);
      // Every editor tagged but the Owner: the two Core Leaders; the Admin is not tagged.
      expect(card.editors).toMatchObject({ coreLeaderCount: 2, frozen: false });
      expect(list.can).toEqual({ create: true });
      expect(list.limits).toEqual(LEADER_MEETING_LIMITS);
      as('AGUS');
      expect((await http().get('/leader-meetings').expect(200)).body.can).toEqual({ create: false });
    });

    it('P18.1-T2 AC-9 any query parameter is refused 400 by name', async () => {
      as('OWNER');
      const res = await http().get('/leader-meetings').query({ filter: 'upcoming' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/filter/);
    });

    it('P18.1-T2 AC-2 an Admin who is also tagged is listed once, as an Admin, marked tagged and counted', async () => {
      await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.ADMIN) }, { $set: { isCoreLeader: true } });
      try {
        as('OWNER');
        const [card] = (await http().get('/leader-meetings').expect(200)).body.meetings;
        expect(card.editors.admins.map((p: { name: string }) => p.name)).toEqual(['Maya Kusuma']);
        expect(card.editors.coreLeaders.map((p: { name: string }) => p.name)).not.toContain('Maya Kusuma');
        expect(card.editors.coreLeaderCount).toBe(3);
        // Each editor says whether they are tagged, so the card draws exactly the three it counts.
        const drawn = [card.editors.owner, ...card.editors.admins, ...card.editors.coreLeaders];
        expect(drawn.filter((p: { tagged: boolean }, i: number) => i > 0 && p.tagged)).toHaveLength(card.editors.coreLeaderCount);
        expect(card.editors.admins[0].tagged).toBe(true);
        expect(card.editors.owner.tagged).toBe(false);
      } finally {
        await db().collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.ADMIN) }, { $set: { isCoreLeader: false } });
      }
    });
  });

  describe('P18.1-T2 AC-2, ADR-0130 making a meeting', () => {
    it('P18.1-T2 AC-9 an empty title, a title that is not text or over its bound, a date that is not a day, an unknown field: 400', async () => {
      as('OWNER');
      for (const body of [
        { title: '   ', date: '2026-10-05' },
        { title: 42, date: '2026-10-05' },
        { title: 'x'.repeat(LEADER_MEETING_LIMITS.titleMax + 1), date: '2026-10-05' },
        { title: 'Fine', date: '2026-02-31' },
        { title: 'Fine', date: '5 October' },
        { title: 'Fine' },
        { title: 'Fine', date: '2026-10-05', attendees: ['x'] },
      ]) {
        const res = await http().post('/leader-meetings').send(body);
        expect([body, res.status, res.body.error.code]).toEqual([body, 400, 'VALIDATION_FAILED']);
      }
    });

    it('P18.1-T2 AC-2 the title is trimmed; the answer is the card', async () => {
      as('ADMIN');
      const card = (await http().post('/leader-meetings').send({ title: '  Spaced  ', date: '2026-10-07' }).expect(201)).body;
      expect(card).toMatchObject({ title: 'Spaced', date: '2026-10-07', state: 'upcoming', openItems: 0 });
      expect(Object.keys(card).sort()).toEqual(['date', 'editors', 'id', 'number', 'openItems', 'state', 'title']);
    });

    it('P18.1-T2 AC-2 two meetings made at once are numbered apart: the second is refused its number and given the next', async () => {
      const owner = office.as('OWNER');
      const made = await Promise.all([1, 2, 3].map((n) => office.forum.create(owner, { title: `At once ${n}`, date: '2026-10-09' })));
      const numbers = made.map((m) => m.number).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(3);
      expect(numbers[2] - numbers[0]).toBe(2);
      for (const m of made) await office.forum.remove(owner, m.id, 1);
    });

    it('P18.1-T2 AC-2 #15 after #14, and a deleted meeting’s number given again', async () => {
      const top = await db().collection('leaderMeetings').find({ kpmId: KPM_A, deletedAt: null }).sort({ number: -1 }).limit(1).next();
      await db().collection('leaderMeetings').insertOne({
        kpmId: KPM_A, number: (top?.number ?? 0) + 100, title: 'Strategic Check-in — #14', date: '2026-08-01',
        agenda: { preparation: [], during: [], post: [] }, actionItems: [], monthlyTargets: {}, writtenAt: null,
        frozenScorecard: null, frozenAt: null, frozenCoeditors: null, version: 1, deletedAt: null,
      });
      const fourteen = (top?.number ?? 0) + 100;
      as('OWNER');
      const next = (await http().post('/leader-meetings').send({ title: 'Next', date: '2026-10-08' }).expect(201)).body;
      expect(next.number).toBe(fourteen + 1);
      await http().delete(`/leader-meetings/${next.id}`).query({ version: 1 }).expect(204);
      const again = (await http().post('/leader-meetings').send({ title: 'Again', date: '2026-10-08' }).expect(201)).body;
      expect(again.number).toBe(fourteen + 1);
      const audit = (await audits('leader_meeting.created')).find((e) => e.targetId === again.id)!;
      expect(audit).toMatchObject({ before: null, after: { title: 'Again', date: '2026-10-08', number: fourteen + 1 } });
    });
  });

  describe('P18.1-T2 AC-7 Upcoming and Completed, from the date in the office’s calendar', () => {
    it('P18.1-T2 AC-7 a meeting on 20 September is Upcoming at 23:59 that day in Jakarta and Completed at 00:01 the next', async () => {
      const meeting = await make('Boundary', '2026-09-20');
      as('OWNER');
      clock().set(new Date('2026-09-20T16:59:00Z'));
      expect((await http().get(`/leader-meetings/${meeting.id}`).expect(200)).body.state).toBe('upcoming');
      clock().set(new Date('2026-09-20T17:01:00Z'));
      expect((await http().get(`/leader-meetings/${meeting.id}`).expect(200)).body.state).toBe('completed');
    });
  });

  describe('P18.1-T2 ADR-0130 moving and deleting a meeting', () => {
    it('P18.1-T2 AC-7 an upcoming meeting is moved, title and date, audited with before and after; the version moves on', async () => {
      const meeting = await make('Before', '2026-10-01');
      as('ADMIN');
      const moved = (await http().patch(`/leader-meetings/${meeting.id}`).send({ title: 'After', date: '2026-10-02', version: 1 }).expect(200)).body;
      expect(moved).toMatchObject({ title: 'After', date: '2026-10-02' });
      const [entry] = (await audits('leader_meeting.rescheduled')).filter((e) => e.targetId === meeting.id);
      expect(entry).toMatchObject({
        targetCollection: 'leaderMeetings', before: { title: 'Before', date: '2026-10-01' }, after: { title: 'After', date: '2026-10-02' },
        actorMembershipId: office.id.ADMIN,
      });
      // The version read before the move is spent.
      const stale = await http().patch(`/leader-meetings/${meeting.id}`).send({ title: 'Again', version: 1 }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });
    });

    it('P18.1-T2 AC-7 a move of a Completed meeting is LEADER_MEETING_COMPLETED, nothing written; neither field is 400', async () => {
      const meeting = await make('Past', '2026-09-10');
      as('OWNER');
      const res = await http().patch(`/leader-meetings/${meeting.id}`).send({ date: '2026-09-30', version: 1 }).expect(409);
      expect(res.body.error.code).toBe('LEADER_MEETING_COMPLETED');
      expect((await office.meetings.findById(office.as('OWNER'), meeting.id))!.date).toBe('2026-09-10');
      const upcoming = await make('Upcoming', '2026-10-10');
      expect((await http().patch(`/leader-meetings/${upcoming.id}`).send({ version: 1 }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await http().patch(`/leader-meetings/${upcoming.id}`).send({ date: 'soon', version: 1 }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.1-T2 AC-9 a null date or title is refused 400, never stored: absent leaves a field, null is no value', async () => {
      const meeting = await make('Not null', '2026-10-11');
      as('OWNER');
      for (const body of [{ date: null, version: 1 }, { title: null, version: 1 }, { title: 'Fine', date: null, version: 1 }]) {
        const res = await http().patch(`/leader-meetings/${meeting.id}`).send(body);
        expect([body, res.status, res.body.error.code]).toEqual([body, 400, 'VALIDATION_FAILED']);
      }
      expect(await office.meetings.findById(office.as('OWNER'), meeting.id)).toMatchObject({ title: 'Not null', date: '2026-10-11', version: 1 });
      // Behind the DTO, the schema refuses it too: the update runs the validators.
      await expect(office.meetings.updateHead(office.as('OWNER'), meeting.id, 1, { date: null as never })).rejects.toThrow(/date/);
      await http().get(`/leader-meetings/${meeting.id}`).expect(200);
      await http().get('/leader-meetings').expect(200);
    });

    it('P18.1-T2 AC-7 a delete is served before anybody writes in it — even once it is past — and refused after', async () => {
      const unwritten = await make('Nobody wrote', '2026-09-02');
      as('OWNER');
      await http().delete(`/leader-meetings/${unwritten.id}`).query({ version: 1 }).expect(204);
      await http().get(`/leader-meetings/${unwritten.id}`).expect(404);
      const list = (await http().get('/leader-meetings').expect(200)).body.meetings.map((m: { id: string }) => m.id);
      expect(list).not.toContain(unwritten.id);
      const [entry] = (await audits('leader_meeting.deleted')).filter((e) => e.targetId === unwritten.id);
      expect(entry.before).toMatchObject({ title: 'Nobody wrote', date: '2026-09-02' });
      expect(entry.after.deletedAt).toEqual(expect.any(String));

      const written = await make('Somebody wrote', '2026-10-03');
      const view = (await http().get(`/leader-meetings/${written.id}`).expect(200)).body;
      expect([view.writtenIn, view.can.delete]).toEqual([false, true]);
      // A move or a share is not writing.
      await http().patch(`/leader-meetings/${written.id}`).send({ title: 'Moved', version: 1 }).expect(200);
      await http().post(`/leader-meetings/${written.id}/share-links`).expect(201);
      expect((await http().get(`/leader-meetings/${written.id}`).expect(200)).body.writtenIn).toBe(false);
      await http().put(`/leader-meetings/${written.id}/monthly-targets/flc`).send({ value: '8 (1 @ unit)', version: 0 }).expect(200);
      const after = (await http().get(`/leader-meetings/${written.id}`).expect(200)).body;
      expect([after.writtenIn, after.can.delete]).toEqual([true, false]);
      const refused = await http().delete(`/leader-meetings/${written.id}`).query({ version: 2 }).expect(409);
      expect(refused.body.error.code).toBe('LEADER_MEETING_HAS_MINUTES');
      await http().get(`/leader-meetings/${written.id}`).expect(200);
    });

    it('P18.1-T2 AC-7 a delete pinned to a version the meeting has moved past is VERSION_CONFLICT; ?version is required', async () => {
      const meeting = await make('Pinned', '2026-10-04');
      as('OWNER');
      await http().patch(`/leader-meetings/${meeting.id}`).send({ title: 'Pinned again', version: 1 }).expect(200);
      expect((await http().delete(`/leader-meetings/${meeting.id}`).query({ version: 1 }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
      expect((await http().delete(`/leader-meetings/${meeting.id}`).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      await http().delete(`/leader-meetings/${meeting.id}`).query({ version: 2 }).expect(204);
      // Gone: a second delete, a move, a write — the meeting's 404.
      await http().delete(`/leader-meetings/${meeting.id}`).query({ version: 2 }).expect(404);
      await http().patch(`/leader-meetings/${meeting.id}`).send({ title: 'x', version: 2 }).expect(404);
      await http().post(`/leader-meetings/${meeting.id}/action-items`).expect(404);
    });
  });

  describe('P18.1-T2 AC-3 the head', () => {
    it('P18.1-T2 AC-3 by the address: the branch, the version, who may edit now, and what the reader may do', async () => {
      const meeting = await make('Head', '2026-10-09');
      as('OWNER');
      const view = (await http().get(`/leader-meetings/${meeting.id}`).expect(200)).body;
      expect(view).toMatchObject({
        id: meeting.id, title: 'Head', date: '2026-10-09', state: 'upcoming', version: 1, branch: 'BSD City Branch', via: 'address',
        writtenIn: false, accessNote: { ownerName: 'Wilson Tanoto', adminNames: ['Maya Kusuma'] }, limits: LEADER_MEETING_LIMITS,
        can: { edit: true, share: true, reschedule: true, delete: true, manageTags: true, print: true },
      });
      expect(view.scorecard.frozenAt).toBeNull();
      expect(view.scorecard.rows.map((r: { key: string }) => r.key)).toEqual([
        'ape', 'manpower', 'flc', 'producing_agents', 'new_aa', 'new_agent_3m', 'avg_monthly_aa', 'case_submission', 'average_case_size',
      ]);
      expect(view.scorecard.rows.find((r: { key: string }) => r.key === 'producing_agents').monthlyTarget).toBeNull();
      expect(view.scorecard.rows.find((r: { key: string }) => r.key === 'ape').monthlyTarget).toEqual({ value: '', version: 0 });
      as('SARI');
      const sari = (await http().get(`/leader-meetings/${meeting.id}`).expect(200)).body;
      expect(sari.can).toEqual({ edit: true, share: true, reschedule: false, delete: false, manageTags: false, print: true });
      expect(sari.editors.coreLeaders.find((p: { name: string }) => p.name === 'Sari Puspita')).toMatchObject({ isReader: true, rung: { code: 'AAB' } });
    });
  });
});
