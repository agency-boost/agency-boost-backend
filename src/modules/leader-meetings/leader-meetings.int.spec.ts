import { INestApplication } from '@nestjs/common';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, session, SUPER_ADMIN } from '../../../test/http-permissions';
import { indonesian, IN_INDONESIAN } from '../../../test/i18n';
import { ROSTER_NOW, type Who } from '../../../test/coaching-office';
import { buildForumOffice, forumApp, KPM_A, type ForumOffice } from '../../../test/forum-office';
import { LeaderMeetingsController } from './leader-meetings.controller';
import { LEADER_MEETINGS_MESSAGES as SAY } from './leader-meetings.messages';
import { ownersOf } from '../../../test/owners';

/**
 * **The forum over HTTP, per role** (P19.22-T8 AC-1, AC-2; ADR-0276, ADR-0268), with the real `PermissionsGuard`, the
 * production pipe and the real services over `test/forum-office.ts`: who reads and writes — the Owner, an Admin, a core
 * leader and the Super Admin inside the KPM, positive; an AB, an AAB, an Agent and a tagged Agent, negative — the list
 * with *Forum berikutnya*, making a forum (its number, time, first agenda and the carried action items), moving and
 * deleting it. The agenda's and action items' writes are `leader-meeting-minutes.int.spec.ts`'s; the links
 * `leader-meeting-sharing.int.spec.ts`'s; isolation `leader-meetings.tenancy.spec.ts`'s.
 *
 * Today is 10:00 on Monday 14 September 2026 in Jakarta.
 */
describe('the Strategic Leader Forum over HTTP (P19.22-T8)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let office: ForumOffice;
  const db = () => mongoose.connection.db!;
  const http = () => request(app.getHttpServer());
  const clock = () => wired.clock as FixedClock;
  const audits = (action: string) => db().collection('auditLog').find({ action }).toArray();

  /** Every steward, by how a request carries them. */
  const STEWARDS: [string, () => RequestContext][] = [
    ['the Owner', () => office.as('OWNER')],
    ['an Admin', () => office.as('ADMIN')],
    ['a core leader AB', () => office.coreLeader('AGUS')],
    ['a core leader AAB', () => office.coreLeader('SARI')],
    ['the Super Admin inside the KPM', () => office.superAdminIn()],
  ];
  /** An AB, an AAB and an Agent, none tagged; INDAH, an Agent **tagged** — no core leader off a leader rung (ADR-0159 §1). */
  const NOT_STEWARDS: Who[] = ['PEER_AB', 'DEWI', 'RINA', 'INDAH'];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildForumOffice(wired);
    await office.tag('INDAH', true);
    app = await forumApp(office);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  afterEach(() => clock().set(ROSTER_NOW));

  it('P19.22-T8 AC-1 declares a permission on every route, and the right one; reorder, targets and stop-sharing are gone', () => {
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
      saveActionItem: 'leader_meeting:edit',
      removeActionItem: 'leader_meeting:edit',
      share: 'leader_meeting:share_link',
    });
  });

  describe('P19.22-T8 AC-1, AC-2 who reads and writes — a positive and a negative per role, on every route', () => {
    let meetingId: string;

    beforeAll(async () => {
      meetingId = (await office.forum.create(office.as('OWNER'), { date: '2026-09-28', time: '14:00' })).id;
    });

    /** Every route a steward reaches by the address, each answered as `ok` says. */
    const routes = (id: string) => [
      { name: 'the list', call: () => http().get('/leader-meetings'), ok: 200 },
      { name: 'a forum', call: () => http().get(`/leader-meetings/${id}`), ok: 200 },
      { name: 'add an agenda line', call: () => http().post(`/leader-meetings/${id}/agenda-items`).send({ text: 'Strategi rekrut Q4' }), ok: 201 },
      { name: 'add an action item', call: () => http().post(`/leader-meetings/${id}/action-items`).send({ text: 'Aktifkan 3 agent' }), ok: 201 },
      { name: 'share', call: () => http().post(`/leader-meetings/${id}/share-links`), ok: 201 },
    ];

    it.each(STEWARDS)('P19.22-T8 AC-1 positive: %s reads the list and the forum, and writes every field route', async (_, who) => {
      session.current = who();
      for (const route of routes(meetingId)) {
        const res = await route.call();
        expect([route.name, res.status]).toEqual([route.name, route.ok]);
      }
    });

    it.each(STEWARDS)('P19.22-T8 AC-1 positive: %s makes, moves and deletes a forum', async (_, who) => {
      session.current = who();
      const made = (await http().post('/leader-meetings').send({ date: '2026-10-05', time: '14:00' }).expect(201)).body;
      expect(made.time).toBe('14:00');
      const moved = (await http().patch(`/leader-meetings/${made.id}`).send({ time: '15:30', version: 1 }).expect(200)).body;
      expect([moved.date, moved.time]).toEqual(['2026-10-05', '15:30']);
      await http().delete(`/leader-meetings/${made.id}`).query({ version: 2 }).expect(204);
    });

    it.each(NOT_STEWARDS)('P19.22-T8 AC-1 negative: %s, a field member who is no core leader, is answered 404 on every route and writes nothing', async (who) => {
      session.current = office.as(who);
      const before = await db().collection('auditLog').countDocuments();
      for (const route of routes(meetingId)) {
        const res = await route.call();
        expect([route.name, res.status, res.body.error?.code]).toEqual([route.name, 404, 'NOT_FOUND']);
      }
      const view = await office.forum.read(office.as('OWNER'), meetingId);
      session.current = office.as(who);
      for (const res of [
        await http().patch(`/leader-meetings/${meetingId}/agenda-items/${view.agenda[0].id}`).send({ done: true, version: view.agenda[0].version }),
        await http().patch(`/leader-meetings/${meetingId}/action-items/${view.actionItems[0].id}`).send({ status: 'done', version: view.actionItems[0].version }),
        await http().delete(`/leader-meetings/${meetingId}/action-items/${view.actionItems[0].id}`).query({ version: view.actionItems[0].version }),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      }
      // Making, moving and deleting are refused by the guard: their grant is the stewards' alone.
      for (const [res, permission] of [
        [await http().post('/leader-meetings').send({ date: '2026-10-05', time: '14:00' }), 'leader_meeting:create'],
        [await http().patch(`/leader-meetings/${meetingId}`).send({ time: '09:00', version: 1 }), 'leader_meeting:reschedule'],
        [await http().delete(`/leader-meetings/${meetingId}`).query({ version: 1 }), 'leader_meeting:delete'],
      ] as const) {
        expect([res.status, res.body.error.code, res.body.error.details]).toEqual([403, 'PERM_DENIED', { permission }]);
      }
      expect(await db().collection('auditLog').countDocuments()).toBe(before);
    });

    it('P19.22-T8 AC-1 the 404 a field member meets is the one a forum that is not there gives', async () => {
      session.current = office.as('RINA');
      const theirs = (await http().get(`/leader-meetings/${meetingId}`).expect(404)).body.error;
      session.current = office.as('OWNER');
      const nothing = (await http().get(`/leader-meetings/${new mongoose.Types.ObjectId()}`).expect(404)).body.error;
      const strip = (e: { requestId?: string }) => ({ ...e, requestId: undefined });
      expect(strip(theirs)).toEqual(strip(nothing));
    });

    it('P19.22-T8 AC-1 a Super Admin who has entered no KPM has no office: the reads TENANT_NO_MEMBERSHIP, the writes not theirs', async () => {
      session.current = SUPER_ADMIN;
      expect((await http().get('/leader-meetings').expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().get(`/leader-meetings/${meetingId}`).expect(403)).body.error.code).toBe('TENANT_NO_MEMBERSHIP');
      expect((await http().post(`/leader-meetings/${meetingId}/action-items`).send({ text: 'x' }).expect(403)).body.error.code).toBe('PERM_DENIED');
    });

    it('P19.22-T8 AC-1 the Super Admin inside the KPM writes as its Owner: no membership on the row, the audit names them', async () => {
      session.current = office.superAdminIn();
      const made = (await http().post('/leader-meetings').send({ date: '2026-10-12', time: '10:00' }).expect(201)).body;
      const row = await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(made.id) });
      expect(row!.createdBy).toBeNull();
      const [audit] = (await audits('leader_meeting.created')).filter((a) => a.targetId === made.id);
      expect(audit.actorUserId).toBe('u-root');
      const view = (await http().get(`/leader-meetings/${made.id}`).expect(200)).body;
      expect(view.can).toEqual({ edit: true, share: true, reschedule: true, delete: true, print: true });
      await http().delete(`/leader-meetings/${made.id}`).query({ version: 1 }).expect(204);
    });

    it('P19.22-T8 AC-1 tagged, then untagged: the tag is read from the membership on every request', async () => {
      await office.tag('PEER_AB', true);
      session.current = office.as('PEER_AB');
      await http().get(`/leader-meetings/${meetingId}`).expect(200);
      await office.tag('PEER_AB', false);
      expect((await http().get(`/leader-meetings/${meetingId}`).expect(404)).body.error.code).toBe('NOT_FOUND');
    });

    it('P19.22-T8 AC-1 a read-only support session reads as its member, draws no write, is refused every write', async () => {
      session.current = office.supported('OWNER');
      const list = (await http().get('/leader-meetings').expect(200)).body;
      expect(list.can).toEqual({ create: false });
      const view = (await http().get(`/leader-meetings/${meetingId}`).expect(200)).body;
      expect(view.can).toEqual({ edit: false, share: false, reschedule: false, delete: false, print: true });
      expect((await http().post(`/leader-meetings/${meetingId}/action-items`).send({ text: 'x' }).expect(403)).body.error.code).toBe('PERM_DENIED');
    });
  });

  describe('P19.22-T8 AC-1 the list and Forum berikutnya', () => {
    beforeAll(async () => {
      await db().collection('leaderMeetings').deleteMany({});
    });

    it('P19.22-T8 AC-1 newest first by date then time; the nearest upcoming is next; days to go in the office calendar', async () => {
      const owner = office.as('OWNER');
      const past = await office.forum.create(owner, { date: '2026-08-31', time: '14:00' });
      const soon = await office.forum.create(owner, { date: '2026-09-22', time: '14:00' });
      const later = await office.forum.create(owner, { date: '2026-10-06', time: '14:00' });
      const today = await office.forum.create(owner, { date: '2026-09-14', time: '16:00' });
      session.current = owner;
      const list = (await http().get('/leader-meetings').expect(200)).body;
      expect(list.today).toBe('2026-09-14');
      expect(list.meetings.map((m: { id: string }) => m.id)).toEqual([later.id, soon.id, today.id, past.id]);
      expect(list.nextId).toBe(today.id);
      const byId = Object.fromEntries(list.meetings.map((m: { id: string }) => [m.id, m]));
      expect(byId[today.id]).toMatchObject({ state: 'upcoming', daysUntil: 0 });
      expect(byId[soon.id]).toMatchObject({ state: 'upcoming', daysUntil: 8, time: '14:00' });
      expect(byId[past.id]).toMatchObject({ state: 'completed', daysUntil: -14 });
      expect(list.coreLeaders.map((p: { firstName: string }) => p.firstName)).toEqual(['Agus', 'Sari']);
      expect(list.limits).toEqual({ textMax: 500 });
    });

    it('P19.22-T8 AC-1 a forum is Akan datang through the whole of its date, Selesai from 00:00 after, in Jakarta', async () => {
      const owner = office.as('OWNER');
      const card = await office.forum.create(owner, { date: '2026-09-15', time: '14:00' });
      clock().set(new Date('2026-09-15T16:59:59Z'));
      expect((await office.forum.read(owner, card.id)).state).toBe('upcoming');
      clock().set(new Date('2026-09-15T17:00:00Z'));
      expect((await office.forum.read(owner, card.id)).state).toBe('completed');
    });
  });

  describe('P19.22-T8 AC-1, AC-3, AC-4 + Forum baru: its number, time, agenda and the action items it carries', () => {
    beforeEach(async () => {
      await db().collection('leaderMeetings').deleteMany({});
    });

    it('P19.22-T8 AC-3 an office’s first forum starts with the three lines, in the maker’s language, Update action items for Semua', async () => {
      session.current = office.as('OWNER');
      const made = (await http().post('/leader-meetings').set(...IN_INDONESIAN).send({ date: '2026-09-28', time: '14:00' }).expect(201)).body;
      expect(made).toMatchObject({ number: 1, date: '2026-09-28', time: '14:00', agendaCount: 3, actionProgress: { done: 0, total: 0 } });
      const view = (await http().get(`/leader-meetings/${made.id}`).expect(200)).body;
      expect(view.agenda.map((i: { text: string; picAll: boolean; done: boolean }) => [i.text, i.picAll, i.done])).toEqual([
        [indonesian(SAY.reviewNumbers), false, false],
        [indonesian(SAY.updateActionItems), true, false],
        [indonesian(SAY.agreeNewItems), false, false],
      ]);
      const row = await db().collection('leaderMeetings').findOne({ _id: new mongoose.Types.ObjectId(made.id) });
      expect(row!.title).toBe('');
    });

    it('P19.22-T8 AC-4 the next forum copies the agenda unticked and carries the items not Selesai, dari forum #n, same lineage', async () => {
      const owner = office.as('OWNER');
      const first = await office.forum.create(owner, { date: '2026-08-31', time: '14:00' });
      const view = await office.forum.read(owner, first.id);
      await office.minutes.saveAgendaItem(owner, first.id, view.agenda[0].id, { done: true, version: 1 });
      await office.minutes.saveAgendaItem(owner, first.id, view.agenda[0].id, { pic: office.id.AGUS, version: 2 });
      const open = await office.minutes.addActionItem(owner, first.id, { text: 'Aktifkan 3 agent', pic: office.id.SARI, dueOn: '2026-09-20' });
      const doing = await office.minutes.addActionItem(owner, first.id, { text: '1 presentasi rekrut per AB' });
      await office.minutes.saveActionItem(owner, first.id, doing.id, { status: 'doing', version: 1 });
      const finished = await office.minutes.addActionItem(owner, first.id, { text: 'Closing clinic' });
      await office.minutes.saveActionItem(owner, first.id, finished.id, { status: 'done', version: 1 });

      session.current = owner;
      const second = (await http().post('/leader-meetings').send({ date: '2026-09-14', time: '14:00' }).expect(201)).body;
      expect(second).toMatchObject({ number: 2, agendaCount: 3, actionProgress: { done: 0, total: 2 } });
      const next = (await http().get(`/leader-meetings/${second.id}`).expect(200)).body;
      expect(next.agenda[0]).toMatchObject({ text: view.agenda[0].text, picMembershipId: office.id.AGUS, done: false });
      expect(next.agenda[0].id).not.toBe(view.agenda[0].id);
      expect(next.actionItems.map((i: Record<string, unknown>) => [i.text, i.status, i.fromNumber, i.picMembershipId, i.dueOn, i.lineageId])).toEqual([
        ['Aktifkan 3 agent', 'todo', 1, office.id.SARI, '2026-09-20', open.lineageId],
        ['1 presentasi rekrut per AB', 'doing', 1, null, null, doing.lineageId],
      ]);
      expect(next.actionItems[0].id).not.toBe(open.id);
      // Carried copies are not writing: the new forum can still be deleted.
      expect(next.writtenIn).toBe(false);
      // A third forum carries #2's still open, keeping the forum the lineage began in.
      const third = await office.forum.create(owner, { date: '2026-09-28', time: '14:00' });
      expect((await office.forum.read(owner, third.id)).actionItems.map((i) => i.fromNumber)).toEqual([1, 1]);
      const [audit] = (await audits('leader_meeting.created')).filter((a) => a.targetId === second.id);
      expect(audit.after).toMatchObject({ number: 2, time: '14:00', carriedActionItems: 2 });
    });

    it.each<[Record<string, unknown>, string]>([
      [{ date: '2026-09-28' }, 'time missing'],
      [{ date: '2026-09-28', time: '24:00' }, 'a time that is not one'],
      [{ date: '2026-09-28', time: '9:00' }, 'a time not HH:MM'],
      [{ date: '2026-02-31', time: '14:00' }, 'a date that is not a day'],
      [{ date: '2026-09-28', time: '14:00', title: 'Mine' }, 'a title, which a forum no longer has'],
    ])('P19.22-T8 AC-1 validation: %j is refused 400 (%s), nothing made', async (body) => {
      session.current = office.as('OWNER');
      const res = await http().post('/leader-meetings').send(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await db().collection('leaderMeetings').countDocuments()).toBe(0);
    });
  });

  describe('P19.22-T8 AC-1 moving and deleting a forum', () => {
    it('P19.22-T8 AC-1 a move needs a date or a time; a stale version is 409; a past forum keeps its date', async () => {
      const owner = office.as('OWNER');
      session.current = owner;
      const card = await office.forum.create(owner, { date: '2026-09-29', time: '14:00' });
      expect((await http().patch(`/leader-meetings/${card.id}`).send({ version: 1 }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      await http().patch(`/leader-meetings/${card.id}`).send({ date: '2026-09-30', version: 1 }).expect(200);
      expect((await http().patch(`/leader-meetings/${card.id}`).send({ time: '08:00', version: 1 }).expect(409)).body.error.code).toBe('VERSION_CONFLICT');
      const past = await office.forum.create(owner, { date: '2026-09-01', time: '14:00' });
      expect((await http().patch(`/leader-meetings/${past.id}`).send({ time: '08:00', version: 1 }).expect(409)).body.error.code)
        .toBe('LEADER_MEETING_COMPLETED');
      const [audit] = (await audits('leader_meeting.rescheduled')).filter((a) => a.targetId === card.id);
      expect(audit.before).toEqual({ date: '2026-09-29', time: '14:00' });
    });

    it('P19.22-T8 AC-1 a forum somebody has written in is kept: 409 LEADER_MEETING_HAS_MINUTES', async () => {
      const owner = office.as('OWNER');
      session.current = owner;
      const card = await office.forum.create(owner, { date: '2026-10-20', time: '14:00' });
      await office.minutes.addAgendaItem(owner, card.id, { text: 'Rencana Closing Clinic Desember' });
      expect((await http().delete(`/leader-meetings/${card.id}`).query({ version: 1 }).expect(409)).body.error.code)
        .toBe('LEADER_MEETING_HAS_MINUTES');
    });
  });

  it('P19.22-T8 AC-2 an office with no Owner assigned: its core leaders still edit, and the Owner is nobody', async () => {
    await db().collection('kpms').updateOne({ _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { owners: ownersOf(null) } });
    try {
      const card = await office.forum.create(office.coreLeader('AGUS'), { date: '2026-11-02', time: '14:00' });
      const view = await office.forum.read(office.coreLeader('AGUS'), card.id);
      expect(view.people.filter((p) => p.pickable).map((p) => p.firstName)).toEqual(['Maya', 'Agus', 'Sari']);
    } finally {
      await db().collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { owners: ownersOf(await office.userIdOf('OWNER')) } },
      );
    }
  });
});
