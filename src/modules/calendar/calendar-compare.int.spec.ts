import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { readerIn } from '@/common/i18n/reader';
import { SUBJECT_READ_ACTION } from '@/modules/audit/subject-read-audit';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { type Who } from '../../../test/coaching-office';
import { startCalendar, stopCalendar, timed, WEEK, type CalendarHarness } from '../../../test/calendar-office';

type Doc = Record<string, unknown>;

/** A busy block's keys, and nothing else (`functional/calendar.md`, *A busy block*). */
const BUSY_KEYS = ['allDay', 'busy', 'date', 'end', 'endsAt', 'endsOn', 'start', 'startsAt', 'startsOn'];

/**
 * **Compare and *Block time*** (P12-T5; ADR-0093, ADR-0098, D-reach, D-audit; `functional/calendar.md`,
 * *Who reads what*), over HTTP with the real `NotificationService`: the compare list, what a compared pane
 * answers and the record each read leaves, and a block — placed, told once, refused outside `COACH`.
 */
describe('compare and Block time (P12-T5)', () => {
  let h: CalendarHarness;
  const create = async (who: Who, body: Doc) => {
    h.as(who);
    return (await h.http().post('/calendar/entries').send(body).expect(201)).body;
  };
  const compare = (who: Who, member: string, date: string = WEEK.monday) => {
    h.as(who);
    return h.http().get('/calendar/entries').query({ for: member, date });
  };
  const block = (who: Who | RequestContext, member: string, over: Doc = {}) => {
    h.as(who);
    return h.http().post('/calendar/blocks').send({ ...timed(2, '11:00', '11:30', { type: 'coaching', title: '1:1 with Indah Permatasari' }), membershipId: member, ...over });
  };
  const reads = () => h.col('auditLog').find({ action: SUBJECT_READ_ACTION }).toArray();
  const userOf = async (who: Who) =>
    (await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(h.id(who)) }))!.userId as string;
  const inbox = async (who: Who) => h.col('notifications').find({ userId: await userOf(who) }).toArray();
  /** A notice's email is sent after the write has answered (P12.1-T1): read its outcome once it has one. */
  const emailsSettle = async () => {
    for (let i = 0; i < 100; i += 1) {
      if (await h.col('notifications').countDocuments({ 'delivery.email.status': { $in: ['held', 'pending'] } }) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('An email never settled');
  };

  beforeAll(async () => { h = await startCalendar({ realNotifications: true }); }, 120_000);
  afterAll(() => stopCalendar(h));
  beforeEach(() => h.reset());

  // ------------------------------------------------------------------ the compare list

  describe('who may be compared (P12-T5 AC-2, D-reach)', () => {
    it('P12-T5 AC-2 an AB is listed everyone COACH reaches: direct agents, then each leader with their team after them', async () => {
      h.as('AGUS');
      const { people } = (await h.http().get('/calendar/downline').expect(200)).body;
      expect(people.map((p: Doc) => [p.group, p.name, p.depth])).toEqual([
        ['direct_unit', 'Dimas Pratama', 1], ['direct_unit', 'Indah Permatasari', 1],
        ['group', 'Dewi Lestari', 1], ['group', 'Lukas Hartono', 1], ['group', 'Tari Anggraini', 2],
        ['group', 'Sari Puspita', 1], ['group', 'Budi Santoso', 2], ['group', 'Nina Lestari', 2], ['group', 'Dodi Kurniawan', 3],
        ['group', 'Rina Wijaya', 2],
      ]);
      expect(people.find((p: Doc) => p.name === 'Dodi Kurniawan')).toEqual({
        membershipId: h.id('DODI'), name: 'Dodi Kurniawan', rung: { code: 'AGENT', label: 'Agent' },
        leaderName: 'Nina Lestari', direct: false, depth: 3, group: 'group',
      });
      expect(people.filter((p: Doc) => p.direct).map((p: Doc) => p.depth)).toEqual([1, 1, 1, 1, 1]);
      // Never the peer's people, nor the member who left.
      expect(JSON.stringify(people)).not.toContain(h.id('PEER_AGENT'));
      expect(JSON.stringify(people)).not.toContain(h.id('LEFT'));
    });

    it('P12-T5 AC-2 an AAB is listed their subtree, a nested unit included', async () => {
      h.as('SARI');
      const { people } = (await h.http().get('/calendar/downline').expect(200)).body;
      expect(people.map((p: Doc) => [p.group, p.name])).toEqual([
        ['direct_unit', 'Budi Santoso'], ['direct_unit', 'Rina Wijaya'], ['group', 'Nina Lestari'], ['group', 'Dodi Kurniawan'],
      ]);
    });

    it('P12-T5 AC-1 somebody who leads nobody, and an Agent who leads somebody, compare nobody', async () => {
      for (const who of ['INDAH', 'DEWI', 'LUKAS'] as const) {
        h.as(who);
        expect([who, (await h.http().get('/calendar/downline').expect(200)).body]).toEqual([who, { people: [] }]);
      }
    });

    it('P12-T5 the list takes no parameter, and reading it is not recorded', async () => {
      h.as('AGUS');
      expect((await h.http().get('/calendar/downline').query({ for: h.id('SARI') }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      await h.http().get('/calendar/downline').expect(200);
      expect(await reads()).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ a compared pane

  describe('what a compared pane answers (P12-T5 AC-4, ADR-0093)', () => {
    it('P12-T5 AC-4 everything the member organised in full — a client meeting’s notes and invitees included', async () => {
      const visit = await create('SARI', timed(2, '10:00', '11:00', {
        type: 'client', title: 'Client visit — Kusuma', notes: 'Client site — Kusuma residence, Jl. Melati 4', inviteeIds: [h.id('RINA')],
      }));
      const pane = (await compare('AGUS', h.id('SARI')).expect(200)).body;
      expect(pane.subject).toEqual({ membershipId: h.id('SARI'), name: 'Sari Puspita', rung: { code: 'AAB', label: 'AAB' } });
      expect(pane.entries).toEqual([{
        ...visit,
        readerIs: 'ancestor', myAnswer: null,
        // An ancestor reads names and `placed`; the answers are the organiser's alone.
        invitees: [{ membershipId: h.id('RINA'), name: 'Rina Wijaya', placed: false, readerCoaches: false }],
      }]);
    });

    it('calendar_attended_entry_is_busy_to_an_ancestor P12-T5 AC-4 an entry the member only attends is in full only where the reader could read it in their own right', async () => {
      // Organised by Agus's own leader, by his peer, by somebody he coaches, and one he is on himself.
      const byOwner = await create('OWNER', timed(1, '09:00', '10:00', { title: 'Branch review', inviteeIds: [h.id('SARI')] }));
      await create('PEER_AB', timed(1, '13:00', '14:00', { title: 'Peer planning', inviteeIds: [h.id('SARI')] }));
      const byRina = await create('RINA', timed(3, '09:00', '10:00', { title: 'Joint call', inviteeIds: [h.id('SARI')] }));
      const withAgus = await create('OWNER', timed(4, '09:00', '10:00', { title: 'Leaders lunch', inviteeIds: [h.id('SARI'), h.id('AGUS')] }));
      const byAgus = await create('AGUS', timed(4, '13:00', '14:00', { title: 'Goal review — Q4 planning', inviteeIds: [h.id('SARI')] }));

      const { entries } = (await compare('AGUS', h.id('SARI')).expect(200)).body;
      expect(entries).toHaveLength(5);
      const [owner, peer, rina, lunch, mine] = entries;
      expect(Object.keys(owner).sort()).toEqual(BUSY_KEYS);
      expect(owner).toEqual({
        busy: true, allDay: false, date: '2026-09-15', start: '09:00', end: '10:00', startsOn: null, endsOn: null,
        startsAt: byOwner.startsAt, endsAt: byOwner.endsAt,
      });
      expect(Object.keys(peer).sort()).toEqual(BUSY_KEYS);
      expect(rina).toMatchObject({ entryId: byRina.entryId, title: 'Joint call', readerIs: 'ancestor' });
      expect(lunch).toMatchObject({ entryId: withAgus.entryId, title: 'Leaders lunch', readerIs: 'invitee', myAnswer: 'pending' });
      expect(mine).toMatchObject({ entryId: byAgus.entryId, readerIs: 'organiser' });
      expect(mine.invitees[0]).toMatchObject({ answer: 'pending' });
      // The payload, not the screen: nothing of the busy two is on the wire. (The Owner is named, as the
      // organiser of the lunch Agus is on himself.)
      const wire = JSON.stringify(entries);
      for (const text of ['Branch review', 'Peer planning', byOwner.entryId, h.id('PEER_AB')]) {
        expect([text, wire.includes(text)]).toEqual([text, false]);
      }
    });

    it('P12-T5 AC-4 an invitation the member declined is not on their calendar, and not in the pane', async () => {
      const entry = await create('RINA', timed(1, '09:00', '10:00', { inviteeIds: [h.id('SARI')] }));
      h.as('SARI');
      await h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'declined' }).expect(200);
      expect((await compare('AGUS', h.id('SARI')).expect(200)).body.entries).toEqual([]);
    });

    it('calendar_compare_read_is_audited P12-T5 AC-5 each compared read writes one §3.5 entry, surface calendar, with the week; a self-read none', async () => {
      await compare('AGUS', h.id('SARI')).expect(200);
      await compare('AGUS', h.id('SARI'), '2026-09-23').expect(200);
      expect((await reads()).map((e) => [e.actorMembershipId, e.targetMembershipId, e.targetCollection, e.after])).toEqual([
        [h.id('AGUS'), h.id('SARI'), 'memberships', { surface: 'calendar', from: '2026-09-14', to: '2026-09-20' }],
        [h.id('AGUS'), h.id('SARI'), 'memberships', { surface: 'calendar', from: '2026-09-21', to: '2026-09-27' }],
      ]);
      await h.col('auditLog').deleteMany({});
      h.as('AGUS');
      await h.http().get('/calendar/entries').expect(200);
      await h.http().get('/calendar/entries').query({ view: 'month' }).expect(200);
      expect(await reads()).toEqual([]);
    });

    it('P18.95-T8 AC-2 a compared month answers in the same projection, and writes one record with the month’s span', async () => {
      const visit = await create('SARI', timed(2, '10:00', '11:00', { type: 'client', title: 'Client visit — Kusuma', notes: 'Kusuma residence' }));
      await create('PEER_AB', timed(3, '13:00', '14:00', { title: 'Peer planning', inviteeIds: [h.id('SARI')] }));
      h.as('AGUS');
      const res = await h.http().get('/calendar/entries').query({ view: 'month', date: WEEK.monday, for: h.id('SARI') }).expect(200);
      expect(res.body).toMatchObject({ view: 'month', month: '2026-09', from: '2026-08-31', to: '2026-10-04' });
      expect(res.body.subject).toMatchObject({ membershipId: h.id('SARI'), name: 'Sari Puspita' });
      const [own, attended] = res.body.entries;
      // What she organised, in full (ADR-0093); what she only attends, from a peer, as a busy block.
      expect(own).toMatchObject({ entryId: visit.entryId, title: 'Client visit — Kusuma', notes: 'Kusuma residence', readerIs: 'ancestor' });
      expect(Object.keys(attended).sort()).toEqual(BUSY_KEYS);
      expect(JSON.stringify(res.body.entries)).not.toContain('Peer planning');
      expect((await reads()).map((e) => [e.actorMembershipId, e.targetMembershipId, e.after])).toEqual([
        [h.id('AGUS'), h.id('SARI'), { surface: 'calendar', from: '2026-08-31', to: '2026-10-04' }],
      ]);
      // Outside COACH, a month is refused as a week is, and writes nothing.
      await h.col('auditLog').deleteMany({});
      h.as('SARI');
      const up = await h.http().get('/calendar/entries').query({ view: 'month', for: h.id('AGUS') }).expect(404);
      expect(up.body.error.code).toBe('NOT_FOUND');
      expect(await reads()).toEqual([]);
    });

    it('calendar_compare_outside_coach P12-T5 AC-5 an AAB reaches a nested unit; outside COACH is 404 and writes no record', async () => {
      await compare('SARI', h.id('DODI')).expect(200);
      await h.col('auditLog').deleteMany({});
      const refused: [Who, string][] = [
        ['SARI', h.id('PEER_AGENT')], // a peer AAB's agent
        ['SARI', h.id('INDAH')], // her own peer
        ['SARI', h.id('AGUS')], // her leader: compare never reads up
        ['AGUS', h.id('AGUS')], // the reader themselves
        ['AGUS', h.id('LEFT')], // a member who left
        ['AGUS', h.id('B_AGENT')], // another office
        ['AGUS', '66f00000000000000000ffff'], // nobody
        ['AGUS', 'not-an-id'],
        ['INDAH', h.id('DIMAS')], // an Agent compares nobody
        ['LUKAS', h.id('TARI')], // not even somebody they lead
      ];
      for (const [who, member] of refused) {
        const res = await compare(who, member);
        expect([who, member, res.status, res.body.error?.code]).toEqual([who, member, 404, 'NOT_FOUND']);
      }
      expect(await reads()).toEqual([]);
    });

    it('P18.95-T8 AC-2, the permission review: a month answers every reader exactly as a week does, refusals writing nothing', async () => {
      const readers: [Who, string][] = [
        ['AGUS', h.id('SARI')], ['SARI', h.id('DODI')], // within COACH
        ['OWNER', h.id('SARI')], ['ADMIN', h.id('SARI')], ['OWNER', h.id('B_AGENT')], ['ADMIN', h.id('B_AGENT')],
        ['SARI', h.id('PEER_AGENT')], ['SARI', h.id('AGUS')], ['AGUS', h.id('B_AGENT')], ['INDAH', h.id('DIMAS')],
        ['LUKAS', h.id('TARI')], ['B_AB', h.id('SARI')],
      ];
      for (const [who, member] of readers) {
        await h.col('auditLog').deleteMany({});
        const week = await compare(who, member);
        const weekReads = (await reads()).length;
        await h.col('auditLog').deleteMany({});
        h.as(who);
        const month = await h.http().get('/calendar/entries').query({ for: member, date: WEEK.monday, view: 'month' });
        const monthReads = (await reads()).length;
        expect([who, member, month.status, month.body.error?.code ?? null, monthReads])
          .toEqual([who, member, week.status, week.body.error?.code ?? null, weekReads]);
        if (month.status !== 200) expect([who, member, monthReads]).toEqual([who, member, 0]);
      }
    });

    it('m2 an empty `for` names nobody: 400 VALIDATION_FAILED, never the reader’s own calendar, and no record', async () => {
      await create('AGUS', timed(1, '09:00', '10:00', { title: 'Pipeline check', type: 'task' }));
      const res = await compare('AGUS', '').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain('for should not be empty');
      expect(JSON.stringify(res.body)).not.toContain('Pipeline check');
      expect(await reads()).toEqual([]);
    });

    it('N4 P12-T5 AC-8 a read-only support session reads a pane as its member would, both people on the record of the read', async () => {
      await create('SARI', timed(2, '10:00', '11:00', { type: 'client', title: 'Client visit — Kusuma' }));
      h.as(h.supporting('AGUS'));
      const res = await h.http().get('/calendar/entries').query({ for: h.id('SARI') }).expect(200);
      expect(res.body.entries[0]).toMatchObject({ title: 'Client visit — Kusuma', readerIs: 'ancestor' });
      // The disclosure names the support user who read it and the member it was read as (§3.5, §3.13).
      expect((await reads()).map((e) => [e.actorUserId, e.effectiveUserId, e.actorMembershipId, e.targetMembershipId, e.after])).toEqual([
        ['u-support', h.office.as('AGUS').userId, h.id('AGUS'), h.id('SARI'), { surface: 'calendar', from: WEEK.monday, to: WEEK.sunday }],
      ]);
    });
  });

  // ------------------------------------------------------------------ Block time

  describe('Block time (P12-T5 AC-6 to AC-8, ADR-0098; exit criterion 3)', () => {
    it('P12-T5 AC-6 the leader’s own entry, the member a fixed attendee recorded as placed, on both calendars', async () => {
      const placed = (await block('AGUS', h.id('INDAH')).expect(201)).body;
      expect(placed).toMatchObject({
        type: 'coaching', title: '1:1 with Indah Permatasari', version: 1, readerIs: 'organiser',
        organiser: { membershipId: h.id('AGUS'), name: 'Agus Salim' },
        // A placed member has no answer, even to the organiser.
        invitees: [{ membershipId: h.id('INDAH'), name: 'Indah Permatasari', placed: true, readerCoaches: true }],
      });
      expect(await h.col('calendarEvents').findOne({})).toMatchObject({
        organiserMembershipId: h.id('AGUS'), attendees: [{ membershipId: h.id('INDAH'), placed: true, answer: null }],
      });
      // On the member's calendar, read with Close alone; nothing to answer.
      h.as('INDAH');
      const [onIndah] = (await h.http().get('/calendar/entries').expect(200)).body.entries;
      expect(onIndah).toMatchObject({ entryId: placed.entryId, readerIs: 'placed', myAnswer: null });
      const answered = await h.http().post(`/calendar/entries/${placed.entryId}/answer`).send({ answer: 'declined' }).expect(409);
      expect(answered.body.error).toMatchObject({ code: 'CALENDAR_BLOCK_NOT_ANSWERABLE', details: { entryId: placed.entryId } });
      await h.http().patch(`/calendar/entries/${placed.entryId}`).send({ version: 1, title: 'Mine' }).expect(404);
      // Nor does the member delete it: only its organiser writes it (calendar_only_the_organiser_writes).
      expect((await h.http().delete(`/calendar/entries/${placed.entryId}`).query({ version: 1 }).expect(404)).body.error.code)
        .toBe('NOT_FOUND');
      expect(await h.col('calendarEvents').findOne({})).toMatchObject({ version: 1, deletedAt: null });
      // The leader edits and deletes it as any organiser does.
      h.as('AGUS');
      await h.http().patch(`/calendar/entries/${placed.entryId}`).send({ version: 1, end: '12:00' }).expect(200);
      expect((await h.col('calendarEvents').findOne({}))!.attendees).toEqual([
        expect.objectContaining({ membershipId: h.id('INDAH'), placed: true }),
      ]);
    });

    it('exit criterion 3: a block writes exactly one inbox row to the member, opening the entry, and an email; none to the leader', async () => {
      const placed = (await block('AGUS', h.id('INDAH')).expect(201)).body;
      await emailsSettle();
      const rows = await inbox('INDAH');
      expect(rows.map((r) => [r.templateId, r.payload])).toEqual([
        [NotificationTemplate.CALENDAR_BLOCK_PLACED, { entryId: placed.entryId, date: '2026-09-16' }],
      ]);
      expect(rows[0].delivery).toMatchObject({ in_app: { status: 'sent' }, email: { status: 'sent' } });
      expect(h.email!.sent.filter((s) => s.to.templateId === NotificationTemplate.CALENDAR_BLOCK_PLACED)).toHaveLength(1);
      expect(await inbox('AGUS')).toEqual([]);
      const indah = new RequestContext(await userOf('INDAH'), 'none', h.office.as('INDAH').membership).withReader(readerIn('en'));
      expect((await h.notifications!.inbox(indah)).items[0]).toMatchObject({
        title: 'Time was blocked on your calendar', detail: 'A leader above you placed it. Open it to see when.',
        href: `/calendar?entry=${placed.entryId}&date=2026-09-16`,
      });
    });

    it('calendar_block_outside_coach exit criterion 3: a block refused outside COACH writes nothing and notifies nobody', async () => {
      const refused: [Who, string][] = [
        ['AGUS', h.id('PEER_AGENT')], ['SARI', h.id('PEER_AGENT')], ['SARI', h.id('INDAH')], ['AGUS', h.id('AGUS')],
        ['AGUS', h.id('LEFT')], ['AGUS', h.id('B_AGENT')], ['AGUS', '66f00000000000000000ffff'],
      ];
      for (const [who, member] of refused) {
        const res = await block(who, member);
        expect([who, member, res.status, res.body.error?.code]).toEqual([who, member, 404, 'NOT_FOUND']);
      }
      // An Agent holds no block at all: the guard's refusal.
      expect((await block('INDAH', h.id('DIMAS'))).status).toBe(403);
      expect((await block('LUKAS', h.id('TARI'))).status).toBe(403);
      expect(await h.col('calendarEvents').countDocuments()).toBe(0);
      expect(await h.col('notifications').countDocuments()).toBe(0);
      expect(await h.col('auditLog').countDocuments({ targetCollection: 'calendarEvents' })).toBe(0);
      expect(h.email!.sent).toEqual([]);
    });

    it('exit criterion 3: a block on a slot that has already ended still tells its member, once; an invitee beside them is told nothing', async () => {
      // Monday the 14th, 08:00 to 08:30 — over before the clock's 10:00.
      const placed = (await block('AGUS', h.id('INDAH'), { date: WEEK.monday, start: '08:00', end: '08:30', inviteeIds: [h.id('DIMAS')] }).expect(201)).body;
      expect((await inbox('INDAH')).map((r) => [r.templateId, r.payload])).toEqual([
        [NotificationTemplate.CALENDAR_BLOCK_PLACED, { entryId: placed.entryId, date: WEEK.monday }],
      ]);
      expect(h.email!.sent.filter((s) => s.to.templateId === NotificationTemplate.CALENDAR_BLOCK_PLACED)).toHaveLength(1);
      // The past-entry rule still covers an invitation, and the leader is told nothing.
      expect(await inbox('DIMAS')).toEqual([]);
      expect(await inbox('AGUS')).toEqual([]);
    });

    it('P12-T5 AC-6 an AAB blocks time on a nested unit’s agent; others may be invited beside the member, and are invited', async () => {
      const placed = (await block('SARI', h.id('DODI'), { inviteeIds: [h.id('NINA')] }).expect(201)).body;
      expect(placed.invitees.map((i: Doc) => [i.name, i.placed, i.answer])).toEqual([
        ['Dodi Kurniawan', true, undefined], ['Nina Lestari', false, 'pending'],
      ]);
      expect((await inbox('DODI')).map((r) => r.templateId)).toEqual([NotificationTemplate.CALENDAR_BLOCK_PLACED]);
      expect((await inbox('NINA')).map((r) => r.templateId)).toEqual([NotificationTemplate.CALENDAR_INVITATION]);
    });

    it('P12-T5 AC-6 the member and the reader are never in the invitation list: 400, before reach', async () => {
      for (const ids of [[h.id('INDAH')], [h.id('AGUS')]]) {
        const res = await block('AGUS', h.id('INDAH'), { inviteeIds: ids });
        expect(res.status).toBe(400);
      }
      expect(await h.col('calendarEvents').countDocuments()).toBe(0);
    });

    it('P12-T5 AC-6 a block is validated as an entry is', async () => {
      const res = await block('AGUS', h.id('INDAH'), { end: '10:00' });
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { violations: ['end must be after start on the same date.'] } });
      expect((await block('AGUS', h.id('INDAH'), { membershipId: undefined })).status).toBe(400);
    });

    it('B1 P12-T5 AC-8 a read-only support session cannot block; an elevated one blocks as its leader, both people on the record', async () => {
      expect((await block(h.supporting('AGUS'), h.id('INDAH'))).status).toBe(403);
      expect(await h.col('calendarEvents').countDocuments()).toBe(0);
      expect(await h.col('auditLog').countDocuments()).toBe(0);
      const placed = (await block(h.supporting('AGUS', false), h.id('INDAH')).expect(201)).body;
      expect(placed.organiser.membershipId).toBe(h.id('AGUS'));
      const rows = await h.col('auditLog').find({ targetCollection: 'calendarEvents' }).toArray();
      expect(rows.map((r) => [
        r.action, r.actorUserId, r.effectiveUserId, r.actorMembershipId, r.targetId, r.targetMembershipId, r.onBehalfOf, r.after,
      ])).toEqual([[
        'calendar_entry.block_placed', 'u-support', h.office.as('AGUS').userId, h.id('AGUS'), placed.entryId, h.id('INDAH'), true,
        { version: 1 },
      ]]);
    });
  });
});
