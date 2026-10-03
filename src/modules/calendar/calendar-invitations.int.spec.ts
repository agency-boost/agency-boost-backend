import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { type Who } from '../../../test/coaching-office';
import { startCalendar, stopCalendar, timed, type CalendarHarness } from '../../../test/calendar-office';

type Doc = Record<string, unknown>;
type Row = { membershipId: string; name: string; group: string; leaderName: string | null; direct: boolean; rung: { code: string; label: string } };

/**
 * **Invitations, the people picker and the notices** (P12-T4; ADR-0094, ADR-0095, ADR-0097;
 * `functional/calendar.md`), over HTTP with the real `NotificationService` on the real collection and a
 * recording adapter on each channel — so what is counted is what reached an inbox and an email.
 */
describe('invitations, the picker and the notices (P12-T4)', () => {
  let h: CalendarHarness;
  const userOf = async (who: Who) =>
    (await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(h.id(who)) }))!.userId as string;
  const inbox = async (who: Who, templateId?: string) => h.col('notifications')
    .find({ userId: await userOf(who), ...(templateId ? { templateId } : {}) }).toArray();
  const create = async (who: Who, body: Doc) => {
    h.as(who);
    return (await h.http().post('/calendar/entries').send(body).expect(201)).body;
  };
  const answer = (who: Who, entryId: string, value: string) => {
    h.as(who);
    return h.http().post(`/calendar/entries/${entryId}/answer`).send({ answer: value });
  };
  const ownGrid = async (who: Who, date = '2026-09-14') => {
    h.as(who);
    return (await h.http().get('/calendar/entries').query({ date }).expect(200)).body.entries as Doc[];
  };
  const people = async (who: Who, query: Doc = {}) => {
    h.as(who);
    return (await h.http().get('/calendar/people').query(query).expect(200)).body as { items: Row[]; page: Doc };
  };
  /** The held email of a change is released without being awaited: read it once it has gone. */
  const emailsSettle = async () => {
    for (let i = 0; i < 50; i += 1) {
      const held = await h.col('notifications').countDocuments({ 'delivery.email.status': { $in: ['held', 'pending'] } });
      if (held === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const emailsTo = async (who: Who, templateId: string) => {
    await emailsSettle();
    const userId = await userOf(who);
    return h.email!.sent.filter((s) => s.to.userId === userId && s.to.templateId === templateId);
  };

  beforeAll(async () => { h = await startCalendar({ realNotifications: true }); }, 120_000);
  afterAll(() => stopCalendar(h));
  beforeEach(() => h.reset());

  // ------------------------------------------------------------------ the picker

  describe('the people picker (P12-T4 AC-1 to AC-3, D-picker)', () => {
    it('P12-T4 AC-3 an AB sees the office in the picker’s groups and order, never themselves', async () => {
      const { items, page } = await people('AGUS');
      expect(items.map((r) => [r.group, r.name])).toEqual([
        ['direct_unit', 'Dimas Pratama'], ['direct_unit', 'Indah Permatasari'],
        // Every other direct report, each followed by everyone below them; names A to Z within a level.
        ['group', 'Dewi Lestari'], ['group', 'Lukas Hartono'], ['group', 'Tari Anggraini'],
        ['group', 'Sari Puspita'], ['group', 'Budi Santoso'], ['group', 'Nina Lestari'], ['group', 'Dodi Kurniawan'],
        ['group', 'Rina Wijaya'],
        // Everybody else who is not above him, in the office's tree order.
        ['other', 'Hendra Gunawan'], ['other', 'Putu Ayu'], ['other', 'Yusuf Ramadhan'], ['other', 'Maya Kusuma'],
        ['leadership', 'Wilson Tanoto'],
      ]);
      expect(page).toEqual({ cursor: null, nextCursor: null, limit: 50, hasMore: false });
    });

    it('P12-T4 AC-2 four fields and the group, the rung’s ladder label and the leader’s full name', async () => {
      const { items } = await people('AGUS');
      const tari = items.find((r) => r.name === 'Tari Anggraini')!;
      expect(tari).toEqual({
        membershipId: h.id('TARI'), name: 'Tari Anggraini', rung: { code: 'AGENT', label: 'Agent' },
        leaderName: 'Lukas Hartono', direct: false, group: 'group',
      });
      expect(items.find((r) => r.name === 'Wilson Tanoto')).toMatchObject({ leaderName: null, direct: false, group: 'leadership' });
      // A direct report is marked by the server, never inferred from a name: Lukas, Dewi, Sari, Dimas and Indah.
      expect(items.filter((r) => r.direct).map((r) => r.name).sort()).toEqual([
        'Dewi Lestari', 'Dimas Pratama', 'Indah Permatasari', 'Lukas Hartono', 'Sari Puspita',
      ]);
    });

    it('P12-T4 AC-3 an Agent sees the last two groups only: other units, and their upline, their leader first', async () => {
      const { items } = await people('INDAH');
      expect(new Set(items.map((r) => r.group))).toEqual(new Set(['other', 'leadership']));
      expect(items.filter((r) => r.group === 'leadership').map((r) => r.name)).toEqual(['Agus Salim', 'Wilson Tanoto']);
      expect(items.map((r) => r.membershipId)).not.toContain(h.id('INDAH'));
    });

    it('P12-T4 AC-3 an AAB sees their direct agents, their nested unit, and their upline', async () => {
      const { items } = await people('SARI');
      expect(items.filter((r) => r.group === 'direct_unit').map((r) => r.name)).toEqual(['Budi Santoso', 'Rina Wijaya']);
      expect(items.filter((r) => r.group === 'group').map((r) => r.name)).toEqual(['Nina Lestari', 'Dodi Kurniawan']);
      expect(items.filter((r) => r.group === 'leadership').map((r) => r.name)).toEqual(['Agus Salim', 'Wilson Tanoto']);
    });

    it('P12-T4 AC-1 searched on the server, by a part of the full name, in any case', async () => {
      expect((await people('AGUS', { q: 'LESTARI' })).items.map((r) => r.name)).toEqual(['Dewi Lestari', 'Nina Lestari']);
      expect((await people('AGUS', { q: '  wijaya ' })).items.map((r) => r.name)).toEqual(['Rina Wijaya']);
      expect((await people('AGUS', { q: 'nobody here' })).items).toEqual([]);
    });

    it('P12-T4 AC-1 paged by a cursor on the picker’s order, at most 50 a page', async () => {
      const first = await people('AGUS', { limit: 6 });
      expect(first.items).toHaveLength(6);
      expect(first.page).toMatchObject({ limit: 6, hasMore: true });
      const second = await people('AGUS', { limit: 6, cursor: first.page.nextCursor });
      const third = await people('AGUS', { limit: 6, cursor: second.page.nextCursor });
      expect(third.page).toMatchObject({ hasMore: false, nextCursor: null });
      const all = (await people('AGUS')).items.map((r) => r.name);
      expect([...first.items, ...second.items, ...third.items].map((r) => r.name)).toEqual(all);
      h.as('AGUS');
      await h.http().get('/calendar/people').query({ limit: 51 }).expect(400);
      await h.http().get('/calendar/people').query({ limit: 0 }).expect(400);
      await h.http().get('/calendar/people').query({ q: 'x'.repeat(101) }).expect(400);
      expect((await h.http().get('/calendar/people').query({ cursor: 'not-ours' }).expect(400)).body.error.details.violations)
        .toEqual(['cursor is not one this list wrote: start again without it.']);
    });

    it('calendar_picker_stays_in_the_office P12-T4 AC-2 never another office, a member who left, a pending member, or an Owner or Admin on no rung', async () => {
      const kpmId = (await h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(h.id('AGUS')) }))!.kpmId;
      const extra = async (status: string, orgLevelCode: string) => {
        const _id = new mongoose.Types.ObjectId();
        await h.col('memberships').insertOne({
          _id, kpmId, userId: String(new mongoose.Types.ObjectId()), agentCode: 'X', agentSeq: 99, leaderCode: `L${status}`,
          orgLevelId: 'x', orgLevelCode, role: 'agent', leaderId: h.id('AGUS'), ancestorIds: [h.id('OWNER'), h.id('AGUS')],
          depth: 2, status, deletedAt: null,
        });
        return String(_id);
      };
      const pending = await extra('pending', 'AGENT');
      const noRung = await extra('active', 'NO_RUNG');
      try {
        const ids = (await people('AGUS')).items.map((r) => r.membershipId);
        for (const who of ['LEFT', 'B_AB', 'B_AGENT'] as const) expect([who, ids.includes(h.id(who))]).toEqual([who, false]);
        expect(ids).not.toContain(pending);
        expect(ids).not.toContain(noRung);
        // And none of them can be invited: one answer for all, naming each, confirming nobody.
        h.as('AGUS');
        const refused = await h.http().post('/calendar/entries').send(timed(2, '09:00', '10:00', {
          inviteeIds: [h.id('LEFT'), h.id('B_AGENT'), pending, noRung, '66f00000000000000000ffff', 'not-an-id', h.id('RINA')],
        })).expect(404);
        expect(refused.body.error).toMatchObject({
          code: 'NOT_FOUND',
          details: { inviteeIds: [h.id('LEFT'), h.id('B_AGENT'), pending, noRung, '66f00000000000000000ffff', 'not-an-id'] },
        });
        expect(await h.col('calendarEvents').countDocuments()).toBe(0);
      } finally {
        await h.col('memberships').deleteMany({ _id: { $in: [pending, noRung].map((id) => new mongoose.Types.ObjectId(id)) } });
      }
    });

    it('P12-T4 AC-9 an Owner or Admin with no field role and a Super Admin are refused the picker', async () => {
      for (const ctx of [h.officeOnly('OWNER'), h.officeOnly('ADMIN'), RequestContext.platform('root')]) {
        h.as(ctx);
        expect((await h.http().get('/calendar/people').expect(403)).body.error.code).toBe('PERM_DENIED');
      }
    });
  });

  // ------------------------------------------------------------------ answering

  describe('an invitation, and its answer (P12-T4 AC-4 to AC-6, ADR-0097)', () => {
    it('P12-T4 AC-4 an invitation is on the invitee’s grid at once, drawn like any entry, awaiting their answer', async () => {
      const entry = await create('SARI', timed(1, '13:00', '14:00', { inviteeIds: [h.id('RINA'), h.id('BUDI')] }));
      const [onRina] = await ownGrid('RINA');
      expect(onRina).toMatchObject({ entryId: entry.entryId, readerIs: 'invitee', myAnswer: 'pending' });
      // An invitee is answered names and `placed`, never anybody's answer.
      expect(onRina.invitees).toEqual([
        { membershipId: h.id('RINA'), name: 'Rina Wijaya', placed: false, readerCoaches: false },
        { membershipId: h.id('BUDI'), name: 'Budi Santoso', placed: false, readerCoaches: false },
      ]);
      expect(entry.invitees.map((i: Doc) => i.answer)).toEqual(['pending', 'pending']);
    });

    it('calendar_answer_writes_only_ones_own P12-T4 AC-5 an invitee accepts, then declines: their own answer, no version moved; a declined one leaves their grid', async () => {
      const entry = await create('SARI', timed(1, '13:00', '14:00', { inviteeIds: [h.id('RINA'), h.id('BUDI')] }));
      const accepted = (await answer('RINA', entry.entryId, 'accepted').expect(200)).body;
      expect(accepted).toMatchObject({ myAnswer: 'accepted', readerIs: 'invitee', version: 1 });
      expect(await ownGrid('RINA')).toHaveLength(1);

      await answer('RINA', entry.entryId, 'declined').expect(200);
      expect(await ownGrid('RINA')).toEqual([]);
      // Still readable from its notice, whatever the answer.
      h.as('RINA');
      expect((await h.http().get(`/calendar/entries/${entry.entryId}`).expect(200)).body).toMatchObject({ myAnswer: 'declined' });
      // Changed again from the same dialog: back on the grid.
      await answer('RINA', entry.entryId, 'accepted').expect(200);
      expect(await ownGrid('RINA')).toHaveLength(1);

      // The organiser reads each invitee's answer; nobody else does.
      h.as('SARI');
      const organised = (await h.http().get(`/calendar/entries/${entry.entryId}`).expect(200)).body;
      expect(organised.invitees.map((i: Doc) => [i.name, i.answer])).toEqual([['Rina Wijaya', 'accepted'], ['Budi Santoso', 'pending']]);
      expect(organised.version).toBe(1);
      const stored = await h.col('calendarEvents').findOne({});
      expect(stored!.attendees[0]).toMatchObject({ answer: 'accepted', answeredAt: new Date('2026-09-14T03:00:00Z') });
      expect(stored!.updatedBy).toBe(h.id('SARI'));
    });

    it('P12-T4 AC-5 answering reads the invitation’s notice: it stops counting on the invitee’s bell, and nobody else’s changes', async () => {
      const entry = await create('SARI', timed(1, '13:00', '14:00', { inviteeIds: [h.id('RINA'), h.id('BUDI')] }));
      const other = await create('SARI', timed(2, '13:00', '14:00', { inviteeIds: [h.id('RINA')] }));
      const notices = async (who: 'RINA' | 'BUDI', entryId: string) => h.col('notifications').find({
        userId: await userOf(who), templateId: NotificationTemplate.CALENDAR_INVITATION, 'payload.entryId': entryId,
      }).toArray();
      expect((await notices('RINA', entry.entryId)).map((n) => n.readAt)).toEqual([null]);

      await answer('RINA', entry.entryId, 'accepted').expect(200);

      expect((await notices('RINA', entry.entryId)).map((n) => n.readAt)).toEqual([new Date('2026-09-14T03:00:00Z')]);
      // Her invitation to another entry, and Budi's to this one, are untouched.
      expect((await notices('RINA', other.entryId)).map((n) => n.readAt)).toEqual([null]);
      expect((await notices('BUDI', entry.entryId)).map((n) => n.readAt)).toEqual([null]);
      // Answering again marks nothing more and refuses nothing.
      await answer('RINA', entry.entryId, 'declined').expect(200);
      expect(await notices('RINA', entry.entryId)).toHaveLength(1);
    });

    it('calendar_block_is_not_answered P12-T4 AC-5 nobody answers for somebody else: the organiser, a member not on it, and nobody’s entry are 404', async () => {
      const entry = await create('SARI', timed(1, '13:00', '14:00', { inviteeIds: [h.id('RINA')] }));
      for (const who of ['SARI', 'BUDI', 'AGUS'] as const) {
        expect([who, (await answer(who, entry.entryId, 'accepted')).status]).toEqual([who, 404]);
      }
      expect((await answer('RINA', '66f00000000000000000ffff', 'accepted')).status).toBe(404);
      expect((await answer('RINA', entry.entryId, 'pending')).status).toBe(400);
      expect((await answer('RINA', entry.entryId, 'maybe')).status).toBe(400);
    });

    it('calendar_answer_writes_only_ones_own P12-T4 AC-5 an answer given between the organiser’s read and save survives the save, and a kept invitee keeps it', async () => {
      const entry = await create('AGUS', timed(3, '09:00', '10:00', { inviteeIds: [h.id('INDAH'), h.id('DIMAS')] }));
      // Agus has v1 open; Indah accepts; Agus saves v1, adding Sari and dropping Dimas.
      await answer('INDAH', entry.entryId, 'accepted').expect(200);
      h.as('AGUS');
      const saved = (await h.http().patch(`/calendar/entries/${entry.entryId}`)
        .send({ version: 1, inviteeIds: [h.id('INDAH'), h.id('SARI')] }).expect(200)).body;
      expect(saved.invitees.map((i: Doc) => [i.name, i.answer])).toEqual([['Indah Permatasari', 'accepted'], ['Sari Puspita', 'pending']]);
    });

    it('P12-T4 AC-6 taken off the list, an invitee is answered 404 at once, and the entry leaves their grid', async () => {
      const entry = await create('AGUS', timed(3, '09:00', '10:00', { inviteeIds: [h.id('INDAH')] }));
      h.as('AGUS');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, inviteeIds: [] }).expect(200);
      h.as('INDAH');
      await h.http().get(`/calendar/entries/${entry.entryId}`).expect(404);
      expect((await answer('INDAH', entry.entryId, 'accepted')).status).toBe(404);
      expect(await ownGrid('INDAH')).toEqual([]);
    });

    it('P12-T4 AC-6 an attendee never edits or deletes the entry they are on', async () => {
      const entry = await create('AGUS', timed(3, '09:00', '10:00', { inviteeIds: [h.id('INDAH')] }));
      h.as('INDAH');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, title: 'Mine' }).expect(404);
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 1 }).expect(404);
    });

    it('P12-T4 an organiser may not invite the placed member of their own block through the list', async () => {
      h.as('AGUS');
      const block = (await h.http().post('/calendar/blocks').send({ ...timed(2, '11:00', '12:00'), membershipId: h.id('INDAH') }).expect(201)).body;
      const res = await h.http().patch(`/calendar/entries/${block.entryId}`).send({ version: 1, inviteeIds: [h.id('INDAH')] }).expect(400);
      expect(res.body.error.details.violations).toEqual([
        'inviteeIds must not include the member the time is placed on: they are on it already.',
      ]);
      // Sending the list without them keeps them: the placed member is in no invitation list.
      const kept = (await h.http().patch(`/calendar/entries/${block.entryId}`).send({ version: 1, inviteeIds: [h.id('DIMAS')] }).expect(200)).body;
      expect(kept.invitees.map((i: Doc) => [i.name, i.placed])).toEqual([['Indah Permatasari', true], ['Dimas Pratama', false]]);
    });
  });

  // ------------------------------------------------------------------ notices

  describe('the notices (P12-T4 AC-7, ADR-0095)', () => {
    it('P12-T4 AC-7 an invitation is one inbox row and one email to each invitee, opening the entry, and nothing to the actor', async () => {
      const entry = await create('SARI', timed(1, '13:00', '14:00', { inviteeIds: [h.id('RINA'), h.id('BUDI')], title: 'Client visit — Kusuma' }));
      for (const who of ['RINA', 'BUDI'] as const) {
        const rows = await inbox(who);
        expect([who, rows.map((r) => [r.templateId, r.payload, r.readAt])]).toEqual([who, [[
          NotificationTemplate.CALENDAR_INVITATION, { entryId: entry.entryId, date: '2026-09-15' }, null,
        ]]]);
        expect(await emailsTo(who, NotificationTemplate.CALENDAR_INVITATION)).toHaveLength(1);
      }
      expect(await inbox('SARI')).toEqual([]);
      // The payload is ids and a date: nothing anybody typed.
      expect(JSON.stringify(await h.col('notifications').find({}).toArray())).not.toContain('Kusuma');

      const rina = new RequestContext(await userOf('RINA'), 'none', h.office.as('RINA').membership);
      const [row] = (await h.notifications!.inbox(rina)).items;
      expect(row).toMatchObject({
        title: 'You have a new invitation', detail: 'Open it on your calendar to accept or decline.',
        href: `/calendar?entry=${entry.entryId}&date=2026-09-15`,
      });
    });

    it('P12-T4 AC-7 no notice for an entry that has already ended', async () => {
      await create('SARI', timed(0, '08:00', '09:00', { inviteeIds: [h.id('RINA')] })); // Monday 08:00, before 10:00
      expect(await inbox('RINA')).toEqual([]);
    });

    it('P12-T4 AC-7 an edit invites only the members it adds; one dropped is told nothing', async () => {
      const entry = await create('SARI', timed(1, '13:00', '14:00', { inviteeIds: [h.id('RINA')] }));
      h.as('SARI');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, inviteeIds: [h.id('BUDI')] }).expect(200);
      expect((await inbox('RINA')).map((r) => r.templateId)).toEqual([NotificationTemplate.CALENDAR_INVITATION]);
      expect((await inbox('BUDI')).map((r) => r.templateId)).toEqual([NotificationTemplate.CALENDAR_INVITATION]);
    });

    it('P12-T4 AC-7 a move reaches each attendee who has not declined as one notice, emailed once, however many moves', async () => {
      const entry = await create('AGUS', timed(2, '09:00', '10:00', { inviteeIds: [h.id('INDAH'), h.id('DIMAS'), h.id('SARI')] }));
      await answer('DIMAS', entry.entryId, 'declined').expect(200);
      await answer('INDAH', entry.entryId, 'accepted').expect(200);
      h.as('AGUS');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, start: '11:00', end: '12:00' }).expect(200);
      // Indah reads it, then it moves again: the same row, refreshed and unread.
      await h.col('notifications').updateMany({ templateId: NotificationTemplate.CALENDAR_ENTRY_CHANGED }, { $set: { readAt: new Date() } });
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 2, date: '2026-09-17' }).expect(200);

      for (const who of ['INDAH', 'SARI'] as const) {
        const changed = await inbox(who, NotificationTemplate.CALENDAR_ENTRY_CHANGED);
        expect([who, changed.map((r) => [r.payload, r.readAt, r.coalesceKey])]).toEqual([who, [[
          { entryId: entry.entryId, date: '2026-09-17', change: 'moved' }, null,
          `calendar:${entry.entryId}:${h.id(who)}:moved`,
        ]]]);
        expect(await emailsTo(who, NotificationTemplate.CALENDAR_ENTRY_CHANGED)).toHaveLength(1);
      }
      // Dimas declined; Agus acted.
      expect(await inbox('DIMAS', NotificationTemplate.CALENDAR_ENTRY_CHANGED)).toEqual([]);
      expect(await inbox('AGUS')).toEqual([]);
    });

    it('P12-T4 AC-7 a change of title, notes, type or invitees alone is not a move', async () => {
      const entry = await create('AGUS', timed(2, '09:00', '10:00', { inviteeIds: [h.id('INDAH')] }));
      h.as('AGUS');
      await h.http().patch(`/calendar/entries/${entry.entryId}`)
        .send({ version: 1, title: 'Renamed', notes: 'Room 3', type: 'client', inviteeIds: [h.id('INDAH'), h.id('SARI')] }).expect(200);
      expect(await inbox('INDAH', NotificationTemplate.CALENDAR_ENTRY_CHANGED)).toEqual([]);
      // The member added is invited, and is not also told it moved.
      expect((await inbox('SARI')).map((r) => r.templateId)).toEqual([NotificationTemplate.CALENDAR_INVITATION]);
    });

    it('P12-T4 AC-7 a past entry moved within the past tells nobody; moved into the future, it does', async () => {
      const entry = await create('AGUS', timed(0, '07:00', '08:00', { inviteeIds: [h.id('INDAH')] }));
      h.as('AGUS');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, start: '08:00', end: '09:00' }).expect(200);
      expect(await inbox('INDAH')).toEqual([]);
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 2, start: '15:00', end: '16:00' }).expect(200);
      expect((await inbox('INDAH')).map((r) => (r.payload as Doc).change)).toEqual(['moved']);
    });

    it('P12-T4 AC-7, P12-T2 AC-9 a delete of a future entry tells each attendee who has not declined, in a row and an email of its own', async () => {
      const entry = await create('AGUS', timed(2, '09:00', '10:00', { inviteeIds: [h.id('INDAH'), h.id('DIMAS')] }));
      await answer('DIMAS', entry.entryId, 'declined').expect(200);
      h.as('AGUS');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, start: '10:00', end: '11:00' }).expect(200);
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 2 }).expect(200);

      const changed = await inbox('INDAH', NotificationTemplate.CALENDAR_ENTRY_CHANGED);
      expect(changed.map((r) => (r.payload as Doc).change).sort()).toEqual(['cancelled', 'moved']);
      expect(await emailsTo('INDAH', NotificationTemplate.CALENDAR_ENTRY_CHANGED)).toHaveLength(2);
      expect(await inbox('DIMAS', NotificationTemplate.CALENDAR_ENTRY_CHANGED)).toEqual([]);

      const indah = new RequestContext(await userOf('INDAH'), 'none', h.office.as('INDAH').membership);
      const cancelled = (await h.notifications!.inbox(indah)).items.find((i) => i.title.includes('cancelled'));
      expect(cancelled).toMatchObject({ detail: 'It is no longer on your calendar.', href: '/calendar?date=2026-09-16' });
    });

    it('P12-T4 AC-7 deleting an entry that has ended tells nobody', async () => {
      const entry = await create('AGUS', timed(0, '07:00', '08:00', { inviteeIds: [h.id('INDAH')] }));
      h.as('AGUS');
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 1 }).expect(200);
      expect(await inbox('INDAH')).toEqual([]);
    });

    it('P12-T4 AC-7 email follows the member’s preferences: muted, the template writes nothing; opted out, the inbox only', async () => {
      await h.col('notificationPreferences').insertMany([
        { userId: await userOf('INDAH'), optedOutChannels: ['email'], mutedTemplates: [] },
        { userId: await userOf('DIMAS'), optedOutChannels: [], mutedTemplates: [NotificationTemplate.CALENDAR_INVITATION] },
      ]);
      try {
        await create('AGUS', timed(2, '09:00', '10:00', { inviteeIds: [h.id('INDAH'), h.id('DIMAS')] }));
        expect((await inbox('INDAH'))[0].delivery).toMatchObject({ in_app: { status: 'sent' }, email: { status: 'suppressed' } });
        expect(await emailsTo('INDAH', NotificationTemplate.CALENDAR_INVITATION)).toEqual([]);
        expect(await inbox('DIMAS')).toEqual([]);
      } finally {
        await h.col('notificationPreferences').deleteMany({});
      }
    });
  });
});
