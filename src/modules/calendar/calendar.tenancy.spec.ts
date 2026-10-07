import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SUPER_ADMIN } from '../../../test/http-permissions';
import { KPM_B, type Who } from '../../../test/coaching-office';
import { startCalendar, stopCalendar, timed, WEEK, type CalendarHarness } from '../../../test/calendar-office';

type Doc = Record<string, unknown>;

/**
 * **`/calendar`'s isolation, and exit criterion 2** (P12-T2 AC-15, P12-T4 AC-9, P12-T5 AC-9; the phase
 * file's *Exit criteria*; `check-tenancy-coverage.py` asks for this file).
 *
 * > a member's entries are readable only by them, their invitees and their ancestors.
 *
 * Table-driven over every route that answers an entry. The organiser reads it; an attendee reads it; an
 * ancestor reads it through compare, in ADR-0093's projection — the whole entry; and everybody else is
 * refused without the entry: 404 for a peer, a peer AAB's agent, a member below the organiser who is not
 * on it and a member of another office, and the guard's 403 for a role that holds no calendar at all — a
 * member who has left, an Owner or Admin with no field role, a Super Admin outside a support session —
 * which says nothing about any entry. *OD-87 narrows what an ancestor reads, never who.*
 */
describe('a member’s entries are readable only by them, their invitees and their ancestors', () => {
  let h: CalendarHarness;
  let entry: Doc;
  const read = (who: Who | RequestContext) => {
    h.as(who);
    return h.http().get(`/calendar/entries/${entry.entryId}`);
  };

  beforeAll(async () => {
    h = await startCalendar();
    // Sari's client visit, with Rina on it.
    h.as('SARI');
    entry = (await h.http().post('/calendar/entries').send(timed(2, '10:00', '11:00', {
      type: 'client', title: 'Client visit — Kusuma', notes: 'Client site — Kusuma residence', inviteeIds: [h.id('RINA')],
    })).expect(201)).body;
  }, 120_000);
  afterAll(() => stopCalendar(h));

  describe('who reads it', () => {
    it('exit criterion 2: its organiser, on their own calendar and by its id', async () => {
      expect((await read('SARI').expect(200)).body).toMatchObject({ entryId: entry.entryId, readerIs: 'organiser' });
      h.as('SARI');
      expect((await h.http().get('/calendar/entries').expect(200)).body.entries.map((e: Doc) => e.entryId)).toEqual([entry.entryId]);
    });

    it('exit criterion 2: an attendee, on their own calendar and by its id', async () => {
      expect((await read('RINA').expect(200)).body).toMatchObject({ entryId: entry.entryId, readerIs: 'invitee' });
      h.as('RINA');
      expect((await h.http().get('/calendar/entries').expect(200)).body.entries.map((e: Doc) => e.entryId)).toEqual([entry.entryId]);
    });

    it.each(['AGUS', 'OWNER'] as const)('exit criterion 2: %s, an ancestor, through compare — the whole entry (ADR-0093)', async (who) => {
      h.as(who);
      const pane = (await h.http().get('/calendar/entries').query({ for: h.id('SARI') }).expect(200)).body;
      expect(pane.entries).toEqual([expect.objectContaining({
        entryId: entry.entryId, title: 'Client visit — Kusuma', notes: 'Client site — Kusuma residence', readerIs: 'ancestor',
      })]);
      // An ancestor reads through compare alone, the audited path: never by its id.
      await read(who).expect(404);
    });
  });

  describe('everybody else is refused, and never the entry', () => {
    const notFound: [string, Who][] = [
      ['a peer of the organiser', 'DEWI'],
      ['a peer AAB’s agent', 'PEER_AGENT'],
      ['a member below the organiser who is not on it', 'BUDI'],
      ['a member below the organiser’s nested unit', 'DODI'],
      ['a member of another office', 'B_AB'],
    ];

    it.each(notFound)('calendar_entry_read_only_by_its_people exit criterion 2: %s is answered 404 on every route that answers an entry', async (_case, who) => {
      const calls = [
        () => read(who),
        () => h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, title: 'x' }),
        () => h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 1 }),
        () => h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'accepted' }),
        () => h.http().get('/calendar/entries').query({ for: h.id('SARI') }),
      ];
      for (const [i, call] of calls.entries()) {
        h.as(who);
        const res = await call();
        expect([who, i, res.status, res.body.error?.code]).toEqual([who, i, 404, 'NOT_FOUND']);
        expect(JSON.stringify(res.body)).not.toContain('Kusuma');
      }
      h.as(who);
      expect(JSON.stringify((await h.http().get('/calendar/entries').query({ date: WEEK.monday }).expect(200)).body)).not.toContain(entry.entryId);
    });

    it('calendar_office_roles_have_no_calendar exit criterion 2: a role that holds no calendar — a member who left, an Owner or Admin with no field role, a Super Admin — meets the guard', async () => {
      const left = h.office.as('LEFT');
      const refused: [string, RequestContext][] = [
        ['a member who has left', new RequestContext(left.userId, 'none', { ...left.membership!, status: 'removed' })],
        ['an Owner with no field role', h.officeOnly('OWNER')],
        ['an Admin with no field role', h.officeOnly('ADMIN')],
        ['a Super Admin outside a support session', SUPER_ADMIN],
      ];
      for (const [who, ctx] of refused) {
        const res = await read(ctx);
        expect([who, res.status, res.body.error?.code]).toEqual([who, 403, 'PERM_DENIED']);
        expect(JSON.stringify(res.body)).not.toContain('Kusuma');
      }
    });

    it('exit criterion 2: a member who has left, were their context still active, is not on it and reaches nobody', async () => {
      // Their membership is `removed` in the office; a stale active context still finds nothing of Sari's.
      const left = h.office.as('LEFT');
      const res = await read(new RequestContext(left.userId, 'none', { ...left.membership!, status: 'active' }));
      expect(res.status).toBe(404);
    });
  });

  describe('the tenant boundary (P12-T2 AC-15, P12-T4 AC-9, P12-T5 AC-9)', () => {
    it('P12-T2 AC-15 an entry filed in another office under this office’s member ids never reaches this office', async () => {
      const _id = new mongoose.Types.ObjectId();
      await h.col('calendarEvents').insertOne({
        _id, kpmId: KPM_B, organiserMembershipId: h.id('SARI'), type: 'meeting', title: 'Office B only', notes: '',
        startsAt: new Date('2026-09-15T02:00:00Z'), endsAt: new Date('2026-09-15T03:00:00Z'), startsOn: null, endsOn: null,
        attendees: [{ membershipId: h.id('RINA'), placed: false, answer: 'pending', answeredAt: null, addedAt: new Date() }],
        version: 1, deletedAt: null,
      });
      try {
        for (const who of ['SARI', 'RINA'] as const) {
          h.as(who);
          const own = (await h.http().get('/calendar/entries').expect(200)).body;
          expect([who, JSON.stringify(own).includes('Office B only')]).toEqual([who, false]);
          await h.http().get(`/calendar/entries/${_id}`).expect(404);
          await h.http().post(`/calendar/entries/${_id}/answer`).send({ answer: 'accepted' }).expect(404);
        }
        h.as('SARI');
        await h.http().patch(`/calendar/entries/${_id}`).send({ version: 1, title: 'x' }).expect(404);
        await h.http().delete(`/calendar/entries/${_id}`).query({ version: 1 }).expect(404);
        h.as('AGUS');
        expect(JSON.stringify((await h.http().get('/calendar/entries').query({ for: h.id('SARI') }).expect(200)).body))
          .not.toContain('Office B only');
      } finally {
        await h.col('calendarEvents').deleteOne({ _id });
      }
    });

    it('P12-T5 AC-9 another office’s leader can neither compare nor block this office’s member, nor invite them', async () => {
      h.as('B_AB');
      await h.http().get('/calendar/entries').query({ for: h.id('SARI') }).expect(404);
      await h.http().post('/calendar/blocks').send({ ...timed(1, '09:00', '10:00'), membershipId: h.id('INDAH') }).expect(404);
      const invited = await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00', { inviteeIds: [h.id('RINA')] })).expect(404);
      expect(invited.body.error.details).toEqual({ inviteeIds: [h.id('RINA')] });
      // Their own office's agent is theirs to compare and block.
      await h.http().get('/calendar/entries').query({ for: h.id('B_AGENT') }).expect(200);
      expect((await h.http().get('/calendar/downline').expect(200)).body.people.map((p: Doc) => p.membershipId)).toEqual([h.id('B_AGENT')]);
    });

    it('P13.1-T8 AC-4 the settings reach one office: a context in another office naming this office’s member finds nobody, either way round', async () => {
      const mongoId = (who: Who) => new mongoose.Types.ObjectId(h.id(who));
      const forged: [string, RequestContext, Who][] = [
        ['office B’s AB holding Sari’s membership id', (() => {
          const b = h.office.as('B_AB');
          return new RequestContext(b.userId, 'none', { ...b.membership!, membershipId: h.id('SARI') });
        })(), 'SARI'],
        ['Sari holding office B’s agent’s membership id', (() => {
          const sari = h.office.as('SARI');
          return new RequestContext(sari.userId, 'none', { ...sari.membership!, membershipId: h.id('B_AGENT') });
        })(), 'B_AGENT'],
      ];
      try {
        for (const [who, ctx, named] of forged) {
          h.as(ctx);
          const read = await h.http().get('/calendar/settings');
          const write = await h.http().put('/calendar/settings').send({ hideDetails: true });
          expect([who, read.status, read.body.error?.code, write.status, write.body.error?.code])
            .toEqual([who, 404, 'NOT_FOUND', 404, 'NOT_FOUND']);
          expect([who, (await h.col('memberships').findOne({ _id: mongoId(named) }))!.calendarHideDetails]).toEqual([who, undefined]);
        }
        // Office B's own member switches theirs; this office's reads are none the wiser.
        h.as('B_AGENT');
        await h.http().put('/calendar/settings').send({ hideDetails: true }).expect(200);
        h.as('B_AB');
        const b = (await h.http().get('/calendar/entries').query({ for: h.id('B_AGENT') }).expect(200)).body;
        expect(b.entries).toEqual([]);
        h.as('SARI');
        expect((await h.http().get('/calendar/settings').expect(200)).body).toEqual({ hideDetails: false });
        h.as('AGUS');
        expect((await h.http().get('/calendar/entries').query({ for: h.id('SARI') }).expect(200)).body.entries).toEqual([
          expect.objectContaining({ entryId: entry.entryId, title: 'Client visit — Kusuma', readerIs: 'ancestor' }),
        ]);
      } finally {
        await h.col('memberships').updateMany({}, { $unset: { calendarHideDetails: '' } });
      }
    });

    it('P12-T4 AC-9 the picker answers one office: another office’s members are never in it, either way round', async () => {
      h.as('B_AB');
      const theirs = (await h.http().get('/calendar/people').expect(200)).body.items.map((p: Doc) => p.membershipId);
      expect(theirs).toEqual([h.id('B_AGENT')]);
      h.as('AGUS');
      const ours = JSON.stringify((await h.http().get('/calendar/people').expect(200)).body);
      expect(ours).not.toContain(h.id('B_AB'));
      expect(ours).not.toContain(h.id('B_AGENT'));
    });
  });
});
