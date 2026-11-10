import mongoose from 'mongoose';
import { declaredPermissions, SUPER_ADMIN } from '../../../test/http-permissions';
import { ROSTER_TODAY, type Who } from '../../../test/coaching-office';
import { startCalendar, stopCalendar, timed, WEEK, type CalendarHarness } from '../../../test/calendar-office';
import { CoachingActionDoneController } from '@/modules/coaching/coaching-action-done.controller';
import { LeadController } from '@/modules/leads/lead.controller';
import type { CalendarTodayItem } from './calendar.service';

type Doc = Record<string, unknown>;
type Task = {
  taskId: string; source: 'lead' | 'coaching'; date: string; name: string; note: string; phone: string | null;
  lead: { leadId: string; version: number } | null; coaching: { sessionId: string; itemId: string; coachMembershipId: string } | null;
  done: boolean;
};

/**
 * **What other features put on a calendar** (UI V1, 2026-10-30, UI-104; ADR-0180 §11; `functional/calendar.md`,
 * *UI V1*): a lead's next action, an open coaching action item and a joined event, merged at query time for the right
 * person, read-only, following their source; ticking a task at its source with *Urungkan*; the Agenda's and 3 Hari's
 * periods; a trip with times; the privacy rule on a compared member's tasks; and today's counts Home reads.
 *
 * The office is `test/coaching-office.ts`'s, on Monday 14 September 2026 in Jakarta: Rina's newest 1:1 is Sari's,
 * finalized that day, with one typed item due that day (`RINA-1`).
 */
describe('Calendar auto items, Tugas and the new views (UI-104)', () => {
  let h: CalendarHarness;
  const kpm = () => h.office.as('AGUS').kpmId as string;
  const kpmB = () => h.office.as('B_AB').kpmId as string;

  const read = async (who: Who, query: Doc = {}) => {
    h.as(who);
    return (await h.http().get('/calendar/entries').query(query).expect(200)).body;
  };
  const tasksOf = (period: { tasks: Task[] }) => period.tasks;
  const lead = async (who: Who, body: Doc) => {
    h.as(who);
    return (await h.http().post('/leads').send({ type: 'sales', ...body }).expect(201)).body;
  };
  const event = async (over: Doc = {}, kpmId = kpm()) => {
    const id = new mongoose.Types.ObjectId();
    await h.col('events').insertOne({
      _id: id, kpmId, code: `EV-${id.toString().slice(-6)}`, typeCode: 'BOP', title: 'BOP Surabaya', blurb: '', description: '',
      startsAt: new Date('2026-09-16T02:00:00Z'), endsAt: new Date('2026-09-16T04:00:00Z'), location: 'Kantor KPM',
      locationUrl: null, audience: { issuer: 'kpm', scope: 'all' }, version: 1, status: 'active', archivedAt: null,
      deletedAt: null, ...over,
    });
    return id.toString();
  };
  const rsvp = (eventId: string, who: Who, rsvpStatus: string | null, kpmId = kpm()) => h.col('eventRsvps').insertOne({
    kpmId, eventId, membershipId: h.id(who), rsvpStatus, rsvpAt: null, cancelledAt: null, claimedAt: null,
    confirmedAttended: null, deletedAt: null,
  });

  beforeAll(async () => {
    h = await startCalendar();
    await h.col('eventTypes').insertOne({
      kpmId: kpm(), code: 'BOP', label: 'Business Opportunity Presentation', displayOrder: 1, version: 1, status: 'active', deletedAt: null,
    });
  }, 120_000);
  afterAll(() => stopCalendar(h));
  beforeEach(async () => {
    await h.reset();
    await h.col('leads').deleteMany({});
    await h.col('events').deleteMany({});
    await h.col('eventRsvps').deleteMany({});
    await h.col('coachingSessions').updateMany({}, { $set: { actionItemsDone: [] } });
    await h.col('memberships').updateMany({}, { $unset: { calendarHideDetails: '' } });
  });

  it('UI-104 declares the tick routes’ permissions: a lead’s next action on lead:update, a coaching item on calendar_entry:update', () => {
    expect(declaredPermissions(LeadController).setNextActionDone).toBe('lead:update');
    expect(declaredPermissions(CoachingActionDoneController)).toEqual({ set: 'calendar_entry:update' });
  });

  // ------------------------------------------------------------------ the sources

  describe('auto items appear for the right person, read-only, and follow their source (UI-104 point 1)', () => {
    it('UI-104 a lead’s next action is a Tugas for its owner on its date, with its name, note and number; a closed lead’s is not', async () => {
      const wiwik = await lead('INDAH', {
        name: 'Ibu Wiwik', nextActionDate: '2026-09-15', nextActionNote: 'Invite BOP', contact: { phone: '+6281234567890', email: null },
      });
      const closed = await lead('INDAH', { name: 'Pak Closed', nextActionDate: '2026-09-15' });
      await h.col('leads').updateOne({ _id: new mongoose.Types.ObjectId(closed.id) }, { $set: { outcome: 'lost' } });
      await lead('INDAH', { name: 'Pak Later', nextActionDate: '2026-09-25' });

      const week = await read('INDAH');
      expect(tasksOf(week)).toEqual([{
        taskId: `lead:${wiwik.id}`, source: 'lead', date: '2026-09-15', ownerMembershipId: h.id('INDAH'),
        name: 'Ibu Wiwik', note: 'Invite BOP', phone: '+6281234567890',
        lead: { leadId: wiwik.id, version: wiwik.version }, coaching: null, done: false,
      }]);
      // Nobody else's calendar holds it: not a peer's, not the leader's own.
      expect(tasksOf(await read('DIMAS'))).toEqual([]);
      expect(tasksOf(await read('AGUS'))).toEqual([]);
    });

    it('UI-104 a moved next action moves on the calendar at once: the source is read on every read', async () => {
      const wiwik = await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: '2026-09-15' });
      h.as('INDAH');
      await h.http().patch(`/leads/${wiwik.id}`).send({ nextActionDate: '2026-09-18', version: wiwik.version }).expect(200);
      expect(tasksOf(await read('INDAH')).map((t) => t.date)).toEqual(['2026-09-18']);
    });

    it('UI-104 an open coaching action item is a Tugas for the coachee, from the coach (Dari: NAME); never the coach’s', async () => {
      const [rina] = tasksOf(await read('RINA'));
      expect(rina).toMatchObject({
        source: 'coaching', date: ROSTER_TODAY, name: h.office.name.SARI, note: 'Book two presentations', lead: null,
        coaching: { itemId: 'RINA-1', coachMembershipId: h.id('SARI') },
      });
      expect(tasksOf(await read('SARI'))).toEqual([]);
    });

    it('UI-104 several Tugas come in the checklist’s order: coaching first, then leads A to Z and by id, then the next day', async () => {
      const zul = await lead('RINA', { name: 'Pak Zul', nextActionDate: ROSTER_TODAY });
      const ani = await lead('RINA', { name: 'Ibu Ani', nextActionDate: ROSTER_TODAY });
      const namesake = await lead('RINA', { name: 'Ibu Ani', nextActionDate: ROSTER_TODAY });
      const tomorrow = await lead('RINA', { name: 'Ibu Ani', nextActionDate: '2026-09-15' });
      const [coaching, ...leads] = tasksOf(await read('RINA'));
      expect(coaching).toMatchObject({ source: 'coaching', date: ROSTER_TODAY, coaching: { itemId: 'RINA-1' } });
      expect(leads.map((t) => t.taskId)).toEqual([
        ...[`lead:${ani.id}`, `lead:${namesake.id}`].sort(), `lead:${zul.id}`, `lead:${tomorrow.id}`,
      ]);
      // Home's today reads the same order, the next day left out.
      const today = await h.wired.calendar.today(h.office.as('RINA'));
      expect(today.taskItems.map((t) => t.taskId)).toEqual([coaching.taskId, ...leads.slice(0, 3).map((t) => t.taskId)]);
    });

    it('UI-104 a coach whose name is not on file still sets the item: its Dari is empty, nothing else changes', async () => {
      const membership = await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(h.id('SARI')) });
      const sari = { _id: new mongoose.Types.ObjectId(String(membership!.userId)) };
      await h.col('users').updateOne(sari, { $set: { fullName: '' } });
      try {
        const [task] = tasksOf(await read('RINA'));
        expect(task).toMatchObject({
          source: 'coaching', name: '', note: 'Book two presentations', coaching: { itemId: 'RINA-1', coachMembershipId: h.id('SARI') },
        });
      } finally {
        await h.col('users').updateOne(sari, { $set: { fullName: h.office.name.SARI } });
      }
    });

    it('L1 a coach who has left keeps their name on the item (Dari: NAME) and serves no number', async () => {
      const sari = new mongoose.Types.ObjectId(h.id('SARI'));
      await h.col('users').updateOne({ fullName: 'Sari Puspita' }, { $set: { phone: '+6281277778888' } });
      try {
        expect(tasksOf(await read('RINA'))[0]).toMatchObject({ name: 'Sari Puspita', phone: '+6281277778888' });
        await h.col('memberships').updateOne({ _id: sari }, { $set: { status: 'removed' } });
        const [item] = tasksOf(await read('RINA'));
        expect(item).toMatchObject({ source: 'coaching', name: 'Sari Puspita', phone: null });
        expect(item.coaching!.coachMembershipId).toBe(h.id('SARI'));
      } finally {
        await h.col('memberships').updateOne({ _id: sari }, { $set: { status: 'active' } });
        await h.col('users').updateOne({ fullName: 'Sari Puspita' }, { $set: { phone: null } });
      }
    });

    it('UI-104 a 1:1 stored before items could be ticked lists its open items all the same', async () => {
      await h.col('coachingSessions').updateMany({ coacheeMembershipId: h.id('RINA') }, { $unset: { actionItemsDone: '' } });
      expect(tasksOf(await read('RINA')).map((t) => t.coaching?.itemId)).toEqual(['RINA-1']);
    });

    it('UI-104 only the newest 1:1 counts: an item of a session the next one reviewed is not open any more', async () => {
      // Rina's older session (7 September) agreed RINA-1 too, due then; the newest is today's.
      expect(tasksOf(await read('RINA', { date: '2026-09-07' }))).toEqual([]);
    });

    it('UI-104 an event joined (going) is on the calendar at its time with its type; withdrawn, cancelled or archived it is not', async () => {
      const going = await event();
      await rsvp(going, 'INDAH', 'going');
      const cancelled = await event({ title: 'Cancelled one' });
      await rsvp(cancelled, 'INDAH', 'cancelled');
      const withdrawn = await event({ title: 'Withdrawn one' });
      await rsvp(withdrawn, 'INDAH', null);
      const archived = await event({ title: 'Archived one', status: 'archived' });
      await rsvp(archived, 'INDAH', 'going');

      const week = await read('INDAH');
      expect(week.events).toEqual([{
        eventId: going, title: 'BOP Surabaya', type: { code: 'BOP', label: 'Business Opportunity Presentation' },
        location: 'Kantor KPM', allDay: false, date: '2026-09-16', start: '09:00', end: '11:00', startsOn: null, endsOn: null,
        startsAt: '2026-09-16T02:00:00.000Z', endsAt: '2026-09-16T04:00:00.000Z',
      }]);
      // Leaving it (the new withdraw sets the RSVP back to none) takes it off at once.
      await h.col('eventRsvps').updateOne({ eventId: going }, { $set: { rsvpStatus: null } });
      expect((await read('INDAH')).events).toEqual([]);
      // Nobody who did not join it sees it.
      expect((await read('DIMAS')).events).toEqual([]);
    });

    it('UI-104 a joined event reads on the office’s clock: to midnight is one day, over days it carries its dates', async () => {
      // 20:00 to 24:00 on Thursday the 17th in Jakarta; 09:00 on Friday the 18th to 17:00 on Saturday the 19th.
      const evening = await event({ title: 'Malam Apresiasi', startsAt: new Date('2026-09-17T13:00:00Z'), endsAt: new Date('2026-09-17T17:00:00Z') });
      const retreat = await event({ title: 'Leaders retreat', startsAt: new Date('2026-09-18T02:00:00Z'), endsAt: new Date('2026-09-19T10:00:00Z') });
      for (const id of [evening, retreat]) await rsvp(id, 'INDAH', 'going');

      const timing = (e: Doc) => [e.title, e.date, e.start, e.end, e.startsOn, e.endsOn];
      expect((await read('INDAH')).events.map(timing)).toEqual([
        ['Malam Apresiasi', '2026-09-17', '20:00', '00:00', null, null],
        ['Leaders retreat', '2026-09-18', '09:00', '17:00', '2026-09-18', '2026-09-19'],
      ]);
    });

    it('UI-104 an event of a type the office does not hold is shown with its code for its type', async () => {
      const id = await event({ typeCode: 'ROADSHOW', title: 'Roadshow Jatim' });
      await rsvp(id, 'INDAH', 'going');
      expect((await read('INDAH')).events.map((e: Doc) => e.type)).toEqual([{ code: 'ROADSHOW', label: 'ROADSHOW' }]);
    });
  });

  // ------------------------------------------------------------------ ticking

  describe('ticking a task completes it at its source, and Urungkan restores it (UI-104 point 4)', () => {
    /*
     * *Rewritten 2026-11-10 (P19.11-T1 AC-1, UX-1):* a ticked task left the calendar, so it vanished on a refresh. It now
     * stays on its due date, `done: true`, read back from `nextActionDone`; the lead still asks for a new next action.
     */
    it('P19.11-T1 AC-1 the owner ticks a lead’s next action: it stays on its date done, with its note and the lead’s new version; Urungkan makes it open again', async () => {
      const wiwik = await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: '2026-09-15', nextActionNote: 'Invite BOP' });
      h.as('INDAH');
      const ticked = (await h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: true, version: wiwik.version }).expect(200)).body;
      expect(ticked).toMatchObject({ nextActionDate: null, nextActionNote: null, version: wiwik.version + 1 });
      // A refresh — a new read — still holds it, on the day it was due, done, pinned to the version the untick needs.
      expect(tasksOf(await read('INDAH'))).toEqual([expect.objectContaining({
        taskId: `lead:${wiwik.id}`, source: 'lead', date: '2026-09-15', name: 'Ibu Wiwik', note: 'Invite BOP',
        lead: { leadId: wiwik.id, version: ticked.version }, done: true,
      })]);
      const stored = await h.col('leads').findOne({ _id: new mongoose.Types.ObjectId(wiwik.id) });
      expect(stored!.nextActionDone).toMatchObject({ date: '2026-09-15', note: 'Invite BOP', byMembershipId: h.id('INDAH') });
      // The Agenda's other periods hold it the same way: 3 Hari from its day, the Month around it.
      expect(tasksOf(await read('INDAH', { view: 'three_days', date: '2026-09-15' })).map((t) => [t.taskId, t.done])).toEqual([[`lead:${wiwik.id}`, true]]);
      expect(tasksOf(await read('INDAH', { view: 'month' })).filter((t) => t.source === 'lead').map((t) => [t.taskId, t.date, t.done]))
        .toEqual([[`lead:${wiwik.id}`, '2026-09-15', true]]);

      h.as('INDAH');
      const undone = (await h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: false, version: ticked.version }).expect(200)).body;
      expect(undone).toMatchObject({ nextActionDate: '2026-09-15', nextActionNote: 'Invite BOP' });
      expect(tasksOf(await read('INDAH')).map((t) => [t.taskId, t.date, t.done])).toEqual([[`lead:${wiwik.id}`, '2026-09-15', false]]);
      const audit = await h.col('auditLog').find({ targetCollection: 'leads', targetId: wiwik.id }).toArray();
      expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(['lead.next_action_done', 'lead.next_action_undone']));
    });

    it('P19.11-T1 AC-1 known limit: a new next action written over a ticked one takes the ticked one off its day; a closed lead’s ticked task leaves too', async () => {
      const wiwik = await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: '2026-09-15', nextActionNote: 'Invite BOP' });
      h.as('INDAH');
      const ticked = (await h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: true, version: wiwik.version }).expect(200)).body;
      await h.http().patch(`/leads/${wiwik.id}`).send({ nextActionDate: '2026-09-18', nextActionNote: 'Call back', version: ticked.version }).expect(200);
      expect(tasksOf(await read('INDAH')).map((t) => [t.date, t.note, t.done])).toEqual([['2026-09-18', 'Call back', false]]);

      const melati = await lead('INDAH', { name: 'Ibu Melati', nextActionDate: '2026-09-16' });
      await h.http().put(`/leads/${melati.id}/next-action/done`).send({ done: true, version: melati.version }).expect(200);
      await h.col('leads').updateOne({ _id: new mongoose.Types.ObjectId(melati.id) }, { $set: { outcome: 'won' } });
      expect(tasksOf(await read('INDAH')).map((t) => t.name)).toEqual(['Ibu Wiwik']);
    });

    /*
     * The staging review of 2026-10-31 (*di calendar tidak bisa hapus*): the lead sheet's *Hapus tugas* clears the
     * owner's next action through the lead's own `PATCH /leads/:id` — no new route. The task leaves the calendar and
     * Home's count, the lead stays, and nothing records it done: it was removed, not completed.
     */
    it('staging review 2026-10-31: Hapus tugas clears the next action through PATCH /leads/:id; the task leaves the calendar and Home, the lead stays', async () => {
      const wiwik = await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: ROSTER_TODAY, nextActionNote: 'Invite BOP' });
      expect(await h.wired.calendar.today(h.office.as('INDAH'))).toMatchObject({ tasks: 1 });
      h.as('INDAH');
      const cleared = (await h.http().patch(`/leads/${wiwik.id}`)
        .send({ nextActionDate: null, nextActionNote: null, version: wiwik.version }).expect(200)).body;
      expect(cleared).toMatchObject({ nextActionDate: null, nextActionNote: null, outcome: null, version: wiwik.version + 1 });
      expect(tasksOf(await read('INDAH'))).toEqual([]);
      expect(await h.wired.calendar.today(h.office.as('INDAH'))).toMatchObject({ tasks: 0, taskItems: [] });
      const stored = await h.col('leads').findOne({ _id: new mongoose.Types.ObjectId(wiwik.id) });
      expect(stored).toMatchObject({ deletedAt: null, nextActionDate: null, nextActionNote: null, nextActionDone: null });
      // A stale clear is VERSION_CONFLICT, and leaves the lead as it is.
      await h.http().patch(`/leads/${wiwik.id}`).send({ nextActionDate: null, nextActionNote: null, version: wiwik.version }).expect(409);
    });

    it('UI-104 a stale tick is VERSION_CONFLICT; a new next action written since leaves nothing for Urungkan', async () => {
      const wiwik = await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: '2026-09-15' });
      h.as('INDAH');
      const ticked = (await h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: true, version: wiwik.version }).expect(200)).body;
      await h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: false, version: wiwik.version }).expect(409);
      const rewritten = (await h.http().patch(`/leads/${wiwik.id}`).send({ nextActionDate: '2026-09-19', version: ticked.version }).expect(200)).body;
      const after = (await h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: false, version: rewritten.version }).expect(200)).body;
      expect(after).toMatchObject({ nextActionDate: '2026-09-19', version: rewritten.version });
    });

    it('UI-104 nobody but the owner ticks a lead’s next action: the leader, a peer and another office are 404', async () => {
      const wiwik = await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: '2026-09-15' });
      for (const who of ['AGUS', 'DIMAS', 'B_AB'] as Who[]) {
        h.as(who);
        await h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: true, version: wiwik.version }).expect(404);
      }
      expect((await h.col('leads').findOne({ _id: new mongoose.Types.ObjectId(wiwik.id) }))!.nextActionDate).toBe('2026-09-15');
    });

    // *Rewritten 2026-11-10 (P19.11-T1 AC-1, UX-1):* a ticked item stays on its due date, done, where it left the calendar.
    it('P19.11-T1 AC-1 the coachee ticks a coaching item: it stays on its due date done, Urungkan makes it open again, and nothing agreed moves', async () => {
      const [task] = tasksOf(await read('RINA'));
      expect(task.done).toBe(false);
      const path = `/coaching/sessions/${task.coaching!.sessionId}/action-items/${task.coaching!.itemId}/done`;
      const before = await h.col('coachingSessions').findOne({ _id: new mongoose.Types.ObjectId(task.coaching!.sessionId) });

      h.as('RINA');
      expect((await h.http().put(path).send({ done: true }).expect(200)).body).toEqual({
        sessionId: task.coaching!.sessionId, itemId: 'RINA-1', done: true,
      });
      expect(tasksOf(await read('RINA'))).toEqual([{ ...task, done: true }]);
      const after = await h.col('coachingSessions').findOne({ _id: before!._id });
      expect(after!.version).toBe(before!.version);
      expect(after!.actionItems).toEqual(before!.actionItems);
      expect(after!.updatedBy ?? null).toBe(before!.updatedBy ?? null);

      h.as('RINA');
      await h.http().put(path).send({ done: false }).expect(200);
      expect(tasksOf(await read('RINA'))).toEqual([{ ...task, done: false }]);
    });

    it('UI-104 nobody but the coachee ticks their item: the coach, a leader above, another office and a read-only support session are refused', async () => {
      const [task] = tasksOf(await read('RINA'));
      const path = `/coaching/sessions/${task.coaching!.sessionId}/action-items/${task.coaching!.itemId}/done`;
      for (const who of ['SARI', 'AGUS', 'BUDI', 'B_AGENT'] as Who[]) {
        h.as(who);
        await h.http().put(path).send({ done: true }).expect(404);
      }
      h.as(h.supporting('RINA'));
      await h.http().put(path).send({ done: true }).expect(403);
      // An item the session does not hold is the same 404.
      h.as('RINA');
      await h.http().put(`/coaching/sessions/${task.coaching!.sessionId}/action-items/nope/done`).send({ done: true }).expect(404);
      expect(tasksOf(await read('RINA')).map((t) => t.done)).toEqual([false]);
    });

    it('T1 a lead’s next action per role: an AB and an AAB tick their own; the Owner and the Admin are 403; a Super Admin outside a session and a read-only support session are refused', async () => {
      for (const who of ['AGUS', 'SARI'] as Who[]) {
        const own = await lead(who, { name: `Lead of ${who}`, nextActionDate: '2026-09-15' });
        h.as(who);
        const ticked = (await h.http().put(`/leads/${own.id}/next-action/done`).send({ done: true, version: own.version }).expect(200)).body;
        expect(ticked).toMatchObject({ nextActionDate: null, version: own.version + 1 });
      }

      const wiwik = await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: '2026-09-15' });
      const tick = () => h.http().put(`/leads/${wiwik.id}/next-action/done`).send({ done: true, version: wiwik.version });
      for (const who of ['OWNER', 'ADMIN'] as Who[]) {
        h.as(h.officeOnly(who));
        expect((await tick().expect(403)).body.error.code).toBe('PERM_DENIED');
      }
      // A Super Admin holds `lead:update` at `all`, for the support session it is granted for; outside one they are in
      // no office, and the lead's service refuses before it reads a row.
      h.as(SUPER_ADMIN);
      const outside = await tick();
      expect([outside.status, outside.body.error.code]).toEqual([403, 'TENANT_NO_MEMBERSHIP']);
      h.as(h.supporting('INDAH'));
      expect((await tick().expect(403)).body.error.code).toBe('PERM_DENIED');
      expect((await h.col('leads').findOne({ _id: new mongoose.Types.ObjectId(wiwik.id) }))!.nextActionDate).toBe('2026-09-15');
    });

    it('T1 a coaching item per role: an AB and an AAB tick their own as the coachee; the Owner, the Admin and a Super Admin are refused', async () => {
      // Agus (an AB) coached by the Owner, with an item open; Sari (an AAB) coached by Agus (the office's seed).
      const agusSession = await h.wired.coachingSessions.create(h.office.as('OWNER'), {
        coachMembershipId: h.id('OWNER'), coacheeMembershipId: h.id('AGUS'), status: 'finalized', date: '2026-09-11',
        frozenAt: new Date('2026-09-11T04:00:00Z'), finalizedAt: new Date('2026-09-11T04:00:00Z'),
        finalizedByMembershipId: h.id('OWNER'), version: 3,
        actionItems: [{ itemId: 'AGUS-1', text: 'Recruit two', dueDate: '2026-09-15', carriedFromItemId: null }],
      } as never);
      const sari = await h.col('coachingSessions').findOne({ coacheeMembershipId: h.id('SARI'), status: 'finalized' });
      const pathOf = (sessionId: string, itemId: string) => `/coaching/sessions/${sessionId}/action-items/${itemId}/done`;
      try {
        h.as('AGUS');
        expect((await h.http().put(pathOf(String(agusSession._id), 'AGUS-1')).send({ done: true }).expect(200)).body)
          .toEqual({ sessionId: String(agusSession._id), itemId: 'AGUS-1', done: true });
        h.as('SARI');
        expect((await h.http().put(pathOf(String(sari!._id), 'SARI-1')).send({ done: true }).expect(200)).body)
          .toEqual({ sessionId: String(sari!._id), itemId: 'SARI-1', done: true });

        const [task] = tasksOf(await read('RINA'));
        const rina = pathOf(task.coaching!.sessionId, task.coaching!.itemId);
        for (const who of ['OWNER', 'ADMIN'] as Who[]) {
          h.as(h.officeOnly(who));
          expect((await h.http().put(rina).send({ done: true }).expect(403)).body.error.code).toBe('PERM_DENIED');
        }
        h.as(SUPER_ADMIN);
        expect((await h.http().put(rina).send({ done: true }).expect(403)).body.error.code).toBe('PERM_DENIED');
        expect(tasksOf(await read('RINA'))).toHaveLength(1);
      } finally {
        await h.col('coachingSessions').deleteOne({ _id: agusSession._id });
      }
    });

    it('L3 an elevated support session is refused the tick as well: it is the coachee’s own declaration', async () => {
      const [task] = tasksOf(await read('RINA'));
      const path = `/coaching/sessions/${task.coaching!.sessionId}/action-items/${task.coaching!.itemId}/done`;
      h.as(h.supporting('RINA', false));
      expect((await h.http().put(path).send({ done: true }).expect(403)).body.error.code).toBe('PERM_DENIED');
      expect(tasksOf(await read('RINA'))).toHaveLength(1);
    });

    it('UI-104 the next Start with the coachee reviews a ticked item ticked, and does not carry it', async () => {
      const [task] = tasksOf(await read('RINA'));
      h.as('RINA');
      await h.http().put(`/coaching/sessions/${task.coaching!.sessionId}/action-items/RINA-1/done`).send({ done: true }).expect(200);
      const started = await h.wired.coachingSession.start(h.office.as('SARI'), h.id('RINA'));
      expect(started.session.lastWeekItems.find((i) => i.itemId === 'RINA-1')).toMatchObject({ done: true });
      expect(started.session.actionItems.some((i) => i.text === 'Book two presentations')).toBe(false);
      await h.col('coachingSessions').deleteMany({ status: 'draft', coacheeMembershipId: h.id('RINA') });
    });
  });

  // ------------------------------------------------------------------ team view and privacy

  describe('a leader’s compared calendar, and a hidden person (UI-104 point 9)', () => {
    it('UI-104 a leader comparing reads the person’s tasks and joined events; one who hides their details as a count and Sibuk', async () => {
      await lead('INDAH', { name: 'Ibu Melati', nextActionDate: '2026-09-15', nextActionNote: 'Collect the signed SPAJ.' });
      const bop = await event();
      await rsvp(bop, 'INDAH', 'going');

      const open = await read('AGUS', { for: h.id('INDAH') });
      expect(tasksOf(open).map((t) => [t.name, t.note])).toEqual([['Ibu Melati', 'Collect the signed SPAJ.']]);
      expect(open.events.map((e: Doc) => e.title)).toEqual(['BOP Surabaya']);

      await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(h.id('INDAH')) }, { $set: { calendarHideDetails: true } });
      const hidden = await read('AGUS', { for: h.id('INDAH') });
      expect(hidden.tasks).toEqual([{ busy: true, date: '2026-09-15' }]);
      expect(hidden.events).toEqual([expect.objectContaining({ busy: true, start: '09:00', end: '11:00' })]);
      expect(JSON.stringify(hidden)).not.toMatch(/Melati|SPAJ|BOP Surabaya/);
      // Her own calendar is hers in full.
      expect(tasksOf(await read('INDAH'))[0].name).toBe('Ibu Melati');
    });

    it('P19.11-T1 AC-1 AC-2 a leader comparing reads a ticked task done; one who hides their details is counted by open tasks alone', async () => {
      await lead('INDAH', { name: 'Ibu Melati', nextActionDate: '2026-09-15', nextActionNote: 'Collect the signed SPAJ.' });
      const done = await lead('INDAH', { name: 'Pak Done', nextActionDate: '2026-09-16', nextActionNote: 'Sent the brochure.' });
      h.as('INDAH');
      await h.http().put(`/leads/${done.id}/next-action/done`).send({ done: true, version: done.version }).expect(200);

      expect(tasksOf(await read('AGUS', { for: h.id('INDAH') })).map((t) => [t.name, t.date, t.done])).toEqual([
        ['Ibu Melati', '2026-09-15', false], ['Pak Done', '2026-09-16', true],
      ]);
      await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(h.id('INDAH')) }, { $set: { calendarHideDetails: true } });
      expect((await read('AGUS', { for: h.id('INDAH') })).tasks).toEqual([{ busy: true, date: '2026-09-15' }]);
    });

    it('L2 a compared person’s WhatsApp number is served beside their tasks, and is null when they hide their details', async () => {
      await h.col('users').updateOne({ fullName: 'Indah Permatasari' }, { $set: { phone: '+6281211112222' } });
      try {
        expect((await read('AGUS', { for: h.id('INDAH') })).subject.phone).toBe('+6281211112222');
        await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(h.id('INDAH')) }, { $set: { calendarHideDetails: true } });
        const hidden = await read('AGUS', { for: h.id('INDAH') });
        expect(hidden.subject).toMatchObject({ name: 'Indah Permatasari', phone: null });
        expect(JSON.stringify(hidden)).not.toContain('81211112222');
      } finally {
        await h.col('users').updateOne({ fullName: 'Indah Permatasari' }, { $set: { phone: null } });
      }
    });

    it('UI-104 a compared read reaches nobody outside the leader’s line, nor another office', async () => {
      h.as('AGUS');
      await h.http().get('/calendar/entries').query({ for: h.id('PEER_AGENT') }).expect(404);
      await h.http().get('/calendar/entries').query({ for: h.id('B_AGENT') }).expect(404);
    });

    it('UI-104 another office’s leads, sessions and RSVPs never reach this office’s calendar', async () => {
      const theirs = await event({ title: 'Office B event' }, kpmB());
      await rsvp(theirs, 'INDAH', 'going', kpmB());
      await h.col('leads').insertOne({
        kpmId: kpmB(), ownerMembershipId: h.id('INDAH'), name: 'Office B lead', nextActionDate: '2026-09-15', outcome: null,
        version: 1, deletedAt: null, commitments: [], transitions: [], contact: { phone: null, email: null },
      });
      // P19.11-T1 AC-1: a ticked one filed in office B under her id never reaches her calendar, nor Home's today.
      await h.col('leads').insertOne({
        kpmId: kpmB(), ownerMembershipId: h.id('INDAH'), name: 'Office B ticked lead', nextActionDate: null, outcome: null,
        nextActionDone: { date: ROSTER_TODAY, note: 'Done in B', at: new Date(), byMembershipId: h.id('INDAH') },
        version: 2, deletedAt: null, commitments: [], transitions: [], contact: { phone: null, email: null },
      });
      const week = await read('INDAH');
      expect(week.tasks).toEqual([]);
      expect(week.events).toEqual([]);
      expect(await h.wired.calendar.today(h.office.as('INDAH'))).toMatchObject({ tasks: 0, taskItems: [], upcoming: [] });
    });
  });

  // ------------------------------------------------------------------ the periods

  describe('the Agenda and 3 Hari periods (UI-104 points 5 and 10)', () => {
    it('UI-104 the Agenda starts on the day asked for — today by default — and runs 7 days; ‹ and › move by 7', async () => {
      const agenda = await read('AGUS', { view: 'agenda' });
      expect(agenda).toMatchObject({ view: 'agenda', from: ROSTER_TODAY, to: '2026-09-20', previous: '2026-09-07', next: '2026-09-21' });
      expect(agenda.days).toHaveLength(7);
      const midweek = await read('AGUS', { view: 'agenda', date: '2026-09-17' });
      expect(midweek).toMatchObject({ from: '2026-09-17', to: '2026-09-23' });
    });

    it('UI-104 3 Hari is three days from the day asked for; one step moves exactly three', async () => {
      const three = await read('AGUS', { view: 'three_days', date: '2026-09-18' });
      expect(three).toMatchObject({ view: 'three_days', from: '2026-09-18', to: '2026-09-20', previous: '2026-09-15', next: '2026-09-21' });
      expect(three.days.map((d: { date: string }) => d.date)).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
    });

    it('UI-104 any other view is refused by name', async () => {
      h.as('AGUS');
      await h.http().get('/calendar/entries').query({ view: 'day' }).expect(400);
    });
  });

  // ------------------------------------------------------------------ travel

  describe('a trip with or without times (UI-104 point 8)', () => {
    const trip = (over: Doc = {}) => ({ type: 'travel', title: 'Client trip — Surabaya', startsOn: '2026-09-18', endsOn: '2026-09-19', ...over });

    it('UI-104 Sepanjang hari on by default: a trip is two dates and all-day', async () => {
      h.as('AGUS');
      const made = (await h.http().post('/calendar/entries').send(trip()).expect(201)).body;
      expect(made).toMatchObject({ allDay: true, startsOn: '2026-09-18', endsOn: '2026-09-19', start: null, end: null });
      expect((await h.col('calendarEvents').findOne({}))!.allDay).toBe(true);
    });

    it('UI-104 Sepanjang hari off: a start date and time and an end date and time, on the grid like other types', async () => {
      h.as('AGUS');
      const made = (await h.http().post('/calendar/entries')
        .send(trip({ allDay: false, start: '07:30', end: '18:00' })).expect(201)).body;
      expect(made).toMatchObject({
        allDay: false, date: '2026-09-18', start: '07:30', end: '18:00', startsOn: '2026-09-18', endsOn: '2026-09-19',
        startsAt: '2026-09-18T00:30:00.000Z', endsAt: '2026-09-19T11:00:00.000Z',
      });
      // Back to all-day by the switch alone: its two dates kept.
      const back = (await h.http().patch(`/calendar/entries/${made.entryId}`)
        .send({ version: made.version, allDay: true, startsOn: '2026-09-18', endsOn: '2026-09-19' }).expect(200)).body;
      expect(back).toMatchObject({ allDay: true, start: null, end: null });
    });

    it('UI-104 a trip with times edited keeps its dates and times: only what was sent changes', async () => {
      h.as('AGUS');
      const made = (await h.http().post('/calendar/entries')
        .send(trip({ allDay: false, start: '07:30', end: '18:00' })).expect(201)).body;
      const later = (await h.http().patch(`/calendar/entries/${made.entryId}`)
        .send({ version: made.version, end: '20:00' }).expect(200)).body;
      expect(later).toMatchObject({
        allDay: false, date: '2026-09-18', start: '07:30', end: '20:00', startsOn: '2026-09-18', endsOn: '2026-09-19',
        startsAt: '2026-09-18T00:30:00.000Z', endsAt: '2026-09-19T13:00:00.000Z',
      });
      const renamed = (await h.http().patch(`/calendar/entries/${made.entryId}`)
        .send({ version: later.version, title: 'Client trip — Malang' }).expect(200)).body;
      expect(renamed).toMatchObject({ title: 'Client trip — Malang', allDay: false, start: '07:30', end: '20:00', endsOn: '2026-09-19' });
    });

    it('UI-104 a trip with times ending before it starts, without its times, or a timed type sent all-day, is refused', async () => {
      h.as('AGUS');
      const end = (await h.http().post('/calendar/entries')
        .send(trip({ allDay: false, endsOn: '2026-09-18', start: '18:00', end: '07:00' })).expect(400)).body;
      expect(end.error.details.violations).toEqual(['endsOn and end must come after startsOn and start.']);
      const missing = (await h.http().post('/calendar/entries').send(trip({ allDay: false })).expect(400)).body;
      expect(missing.error.details.violations).toEqual(['start is required.', 'end is required.']);
      const meeting = (await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00', { allDay: true })).expect(400)).body;
      expect(meeting.error.details.violations).toEqual(['allDay is not part of a timed entry.']);
    });
  });

  // ------------------------------------------------------------------ Home's counts

  describe('today’s counts for Home’s Jadwal hari ini (UI-104 point 7)', () => {
    /** A timed thing of today's, as `today().upcoming` holds it: its kind, title, type and times. */
    const row = (u: CalendarTodayItem) => (u.kind === 'entry'
      ? ['entry', u.entry.title, u.entry.type, u.entry.date, u.entry.start, u.entry.end]
      : ['event', u.event.title, u.event.type.label, u.event.date, u.event.start, u.event.end]);

    // *Rewritten 2026-11-10 (P19.11-T1 AC-1 to AC-3):* the ticked task is listed, done, and not counted; each timed thing
    // comes in the Calendar's own shape, with its end.
    it('P19.11-T1 AC-2 AC-3 counts timed things and open Tugas today — a trip left out, a ticked task listed done and not counted — and lists what is still to come in the Calendar’s shapes', async () => {
      await lead('INDAH', { name: 'Ibu Wiwik', nextActionDate: ROSTER_TODAY });
      const done = await lead('INDAH', { name: 'Pak Done', nextActionDate: ROSTER_TODAY });
      h.as('INDAH');
      await h.http().put(`/leads/${done.id}/next-action/done`).send({ done: true, version: done.version }).expect(200);
      await h.http().post('/calendar/entries').send(timed(0, '09:00', '09:30', { title: 'Already over' })).expect(201);
      const review = (await h.http().post('/calendar/entries').send(timed(0, '13:00', '14:00', { title: 'Client review', type: 'client' })).expect(201)).body;
      await h.http().post('/calendar/entries').send({ type: 'travel', startsOn: ROSTER_TODAY, endsOn: '2026-09-15' }).expect(201);
      const bop = await event({ startsAt: new Date('2026-09-14T08:00:00Z'), endsAt: new Date('2026-09-14T09:00:00Z') });
      await rsvp(bop, 'INDAH', 'going');

      const today = await h.wired.calendar.today(h.office.as('INDAH'));
      expect(today).toMatchObject({ today: ROSTER_TODAY, meetings: 3, tasks: 1 });
      expect(today.taskItems.map((t) => [t.name, t.done])).toEqual([['Ibu Wiwik', false], ['Pak Done', true]]);
      expect(today.upcoming.map(row)).toEqual([
        ['entry', 'Client review', 'client', ROSTER_TODAY, '13:00', '14:00'],
        ['event', 'BOP Surabaya', 'Business Opportunity Presentation', ROSTER_TODAY, '15:00', '16:00'],
      ]);
      // The entry is the Calendar's own reading of it — what `GET /calendar/entries/:id` answers its organiser.
      const [entry] = today.upcoming;
      expect(entry.kind === 'entry' && entry.entry).toMatchObject({ entryId: review.entryId, readerIs: 'organiser', version: 1, myAnswer: null });
    });

    it('P19.11-T1 AC-3 today alone: nothing of the days after, and a joined event that began yesterday and runs into today is today’s, with its two dates', async () => {
      h.as('INDAH');
      await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00', { title: 'Tomorrow' })).expect(201);
      const tomorrow = await event({ title: 'Tomorrow’s BOP', startsAt: new Date('2026-09-15T02:00:00Z'), endsAt: new Date('2026-09-15T04:00:00Z') });
      await rsvp(tomorrow, 'INDAH', 'going');
      // 13 September 20:00 to 15 September 12:00 in Jakarta.
      const retreat = await event({ title: 'Leaders retreat', startsAt: new Date('2026-09-13T13:00:00Z'), endsAt: new Date('2026-09-15T05:00:00Z') });
      await rsvp(retreat, 'INDAH', 'going');
      await lead('INDAH', { name: 'Pak Besok', nextActionDate: '2026-09-15' });

      const today = await h.wired.calendar.today(h.office.as('INDAH'));
      expect(today.taskItems).toEqual([]);
      expect(today.upcoming.map(row)).toEqual([['event', 'Leaders retreat', 'Business Opportunity Presentation', '2026-09-13', '20:00', '12:00']]);
      expect(today.upcoming[0].kind === 'event' && today.upcoming[0].event).toMatchObject({ startsOn: '2026-09-13', endsOn: '2026-09-15' });
    });

    it('UI-104 counts nothing of anybody else’s, nor another office’s', async () => {
      await lead('DIMAS', { name: 'Not hers', nextActionDate: ROSTER_TODAY });
      expect(await h.wired.calendar.today(h.office.as('INDAH'))).toMatchObject({ meetings: 0, tasks: 0 });
      expect(await h.wired.calendar.today(h.office.as('B_AGENT'))).toMatchObject({ meetings: 0, tasks: 0 });
    });

    it('UI-104 today’s timed things starting together are listed by id, so two reads never shuffle them', async () => {
      h.as('INDAH');
      const entry = (await h.http().post('/calendar/entries').send(timed(0, '15:00', '16:00', { title: 'Client call' })).expect(201)).body;
      const bop = await event({ startsAt: new Date('2026-09-14T08:00:00Z'), endsAt: new Date('2026-09-14T09:00:00Z') });
      await rsvp(bop, 'INDAH', 'going');
      const { upcoming } = await h.wired.calendar.today(h.office.as('INDAH'));
      expect(upcoming.map((u) => (u.kind === 'entry' ? u.entry.entryId : u.event.eventId))).toEqual([entry.entryId, bop].sort());
      expect(upcoming.map((u) => row(u).slice(4))).toEqual([['15:00', '16:00'], ['15:00', '16:00']]);
    });
  });

  // ------------------------------------------------------------------ Home's today, and nothing after it

  /*
   * *Rewritten 2026-11-10 (P19.11-T1 AC-3, UX-2):* `nextAfterToday` filled Home's *Aksi hari ini* up with the days after
   * today — 10 and 11 November on the 9th. It is gone, and these hold the list Home reads to today.
   */
  describe('P19.11-T1 AC-3 today’s timed things for Home’s Aksi hari ini, and nothing after today', () => {
    const row = (u: CalendarTodayItem) => (u.kind === 'entry'
      ? ['entry', u.entry.title, u.entry.date, u.entry.start, u.entry.end]
      : ['event', u.event.title, u.event.date, u.event.start, u.event.end]);
    const upcomingOf = async (who: Who) => (await h.wired.calendar.today(h.office.as(who))).upcoming;

    it('P19.11-T1 AC-3 the reader’s entries and joined events today, not yet ended — a pending invitation included; a declined one, a trip and the days after never', async () => {
      h.as('INDAH');
      const post = async (body: Doc) => (await h.http().post('/calendar/entries').send(body).expect(201)).body;
      await post(timed(0, '13:00', '14:00', { title: 'Later today' }));
      await post(timed(1, '06:30', '07:00', { title: 'Early Tuesday' }));
      await post({ type: 'travel', title: 'Trip with times', allDay: false, startsOn: ROSTER_TODAY, start: '11:00', endsOn: '2026-09-15', end: '18:00' });
      await post({ type: 'travel', title: 'Trip all day', startsOn: ROSTER_TODAY, endsOn: '2026-09-15' });
      const sunday = await event({ title: 'Sunday gathering', startsAt: new Date('2026-09-20T03:00:00Z'), endsAt: new Date('2026-09-20T05:00:00Z') });
      await rsvp(sunday, 'INDAH', 'going');
      // Agus's invitations today: one she declined, one still pending.
      h.as('AGUS');
      const declined = await post(timed(0, '16:00', '17:00', { title: 'Declined one', inviteeIds: [h.id('INDAH')] }));
      await post(timed(0, '11:00', '12:00', { title: 'Pending invite', inviteeIds: [h.id('INDAH')] }));
      h.as('INDAH');
      await h.http().post(`/calendar/entries/${declined.entryId}/answer`).send({ answer: 'declined' }).expect(200);

      const upcoming = await upcomingOf('INDAH');
      expect(upcoming.map(row)).toEqual([
        ['entry', 'Pending invite', ROSTER_TODAY, '11:00', '12:00'],
        ['entry', 'Later today', ROSTER_TODAY, '13:00', '14:00'],
      ]);
      // What she owes it rides along, as the Agenda names it.
      expect(upcoming[0].kind === 'entry' && upcoming[0].entry).toMatchObject({ readerIs: 'invitee', myAnswer: 'pending' });
    });

    it('P19.11-T1 AC-3 holds nothing of anybody else’s: a peer’s entries and events today stay theirs', async () => {
      h.as('DIMAS');
      await h.http().post('/calendar/entries').send(timed(0, '13:00', '14:00', { title: 'Dimas only' })).expect(201);
      const bop = await event({ startsAt: new Date('2026-09-14T08:00:00Z'), endsAt: new Date('2026-09-14T09:00:00Z') });
      await rsvp(bop, 'DIMAS', 'going');
      expect(await upcomingOf('INDAH')).toEqual([]);
      expect((await upcomingOf('DIMAS')).map((u) => row(u)[1])).toEqual(['Dimas only', 'BOP Surabaya']);
    });
  });

  it('UI-104 the week read still answers its week, with its tasks beside its entries', async () => {
    const week = await read('RINA');
    expect(week).toMatchObject({ view: 'week', from: WEEK.monday, to: WEEK.sunday });
    expect(Object.keys(week)).toEqual(expect.arrayContaining(['entries', 'tasks', 'events']));
  });
});
