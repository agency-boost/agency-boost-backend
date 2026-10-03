import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { declaredPermissions, SUPER_ADMIN } from '../../../test/http-permissions';
import { ROSTER_TODAY, type Who } from '../../../test/coaching-office';
import {
  startCalendar, stopCalendar, timed, WEEK, type CalendarHarness,
} from '../../../test/calendar-office';
import { CalendarController } from './calendar.controller';

/** Every route, and the permission it must declare (roles §3.15). */
const ROUTES: Record<string, string> = {
  read: 'calendar_entry:read',
  searchPeople: 'calendar_invitee:search',
  downline: 'calendar_entry:read',
  block: 'calendar_entry:block',
  create: 'calendar_entry:create',
  readOne: 'calendar_entry:read',
  update: 'calendar_entry:update',
  remove: 'calendar_entry:delete',
  answer: 'calendar_entry:answer',
};

/** The keys an entry is answered with, in full (`functional/calendar.md`, *An entry*). */
const ENTRY_KEYS = [
  'allDay', 'date', 'end', 'endsAt', 'endsOn', 'entryId', 'invitees', 'myAnswer', 'notes', 'organiser',
  'readerIs', 'start', 'startsAt', 'startsOn', 'title', 'type', 'version',
];

/**
 * **My calendar over HTTP** (P12-T2, P12-T3; `functional/calendar.md`, the Data contract): every route's
 * permission, a positive and a negative per role, the period read's shape on the office's clock, and the
 * entry's life — created, read, edited, deleted — with each refusal the contract names.
 */
describe('the calendar over HTTP (P12-T2, P12-T3)', () => {
  let h: CalendarHarness;
  const create = async (who: Who, body: Record<string, unknown>) => {
    h.as(who);
    return (await h.http().post('/calendar/entries').send(body).expect(201)).body;
  };

  /** The calendar's rows on the record, in the order they were written. */
  const calendarRows = () => h.col('auditLog').find({ targetCollection: 'calendarEvents' }).sort({ _id: 1 }).toArray();

  beforeAll(async () => { h = await startCalendar(); }, 120_000);
  afterAll(() => stopCalendar(h));
  beforeEach(() => h.reset());

  it('P12-T2 AC-15 declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(CalendarController)).toEqual(ROUTES);
  });

  // ------------------------------------------------------------------ the period read

  describe('the period read (P12-T2 AC-3, P12-T3 AC-1)', () => {
    it('P12-T2 AC-3 answers the office’s week of today, its now, and whose calendar it is', async () => {
      h.as('AGUS');
      const res = await h.http().get('/calendar/entries').expect(200);
      expect(res.body).toEqual({
        view: 'week', from: WEEK.monday, to: WEEK.sunday, month: null,
        days: ['14', '15', '16', '17', '18', '19', '20'].map((d) => ({ date: `2026-09-${d}`, inPeriod: true })),
        previous: '2026-09-07', next: '2026-09-21',
        today: ROSTER_TODAY,
        // 10:00 in Jakarta is the office's 600th minute, whatever the server's clock says.
        now: { at: '2026-09-14T03:00:00.000Z', minute: 600 },
        subject: { membershipId: h.id('AGUS'), name: 'Agus Salim', rung: { code: 'AB', label: 'AB' } },
        entries: [],
      });
    });

    it('P12-T3 AC-1 Month answers the office’s month padded to whole weeks, the padding marked', async () => {
      h.as('INDAH');
      const res = await h.http().get('/calendar/entries').query({ view: 'month', date: '2026-09-30' }).expect(200);
      expect(res.body).toMatchObject({
        view: 'month', month: '2026-09', from: '2026-08-31', to: '2026-10-04', previous: '2026-08-01', next: '2026-10-01',
      });
      expect(res.body.days).toHaveLength(35);
      expect(res.body.days[0]).toEqual({ date: '2026-08-31', inPeriod: false });
      expect(res.body.days[1]).toEqual({ date: '2026-09-01', inPeriod: true });
      expect(res.body.subject.rung).toEqual({ code: 'AGENT', label: 'Agent' });
    });

    it('P12-T3 AC-2 one read feeds both views: an entry on a padding day is in the month, and in its week', async () => {
      const entry = await create('INDAH', timed(0, '09:00', '10:00', { title: 'Client review', date: '2026-10-01' }));
      h.as('INDAH');
      const month = (await h.http().get('/calendar/entries').query({ view: 'month', date: '2026-09-02' }).expect(200)).body;
      const week = (await h.http().get('/calendar/entries').query({ date: '2026-10-01' }).expect(200)).body;
      expect(month.entries.map((e: { entryId: string }) => e.entryId)).toEqual([entry.entryId]);
      expect(week.entries).toEqual(month.entries);
      expect(week).toMatchObject({ from: '2026-09-28', to: '2026-10-04' });
    });

    it('P12-T2 AC-3 an entry at 00:30 WIB on a Monday is that Monday’s week, not the Sunday’s before', async () => {
      const early = await create('SARI', timed(7, '00:30', '01:00')); // Monday 21 September
      h.as('SARI');
      const thisWeek = (await h.http().get('/calendar/entries').query({ date: WEEK.sunday }).expect(200)).body;
      const nextWeek = (await h.http().get('/calendar/entries').query({ date: '2026-09-21' }).expect(200)).body;
      expect(thisWeek.entries).toEqual([]);
      expect(nextWeek.entries.map((e: { entryId: string }) => e.entryId)).toEqual([early.entryId]);
      expect(nextWeek.entries[0]).toMatchObject({ date: '2026-09-21', start: '00:30', end: '01:00', startsAt: '2026-09-20T17:30:00.000Z' });
    });

    it('P12-T2 AC-3 a week across a year end is read whole, and a trip across a week’s edge is in both', async () => {
      const trip = await create('AGUS', {
        type: 'travel', title: 'Client trip — Surabaya', startsOn: '2026-12-31', endsOn: '2027-01-04',
      });
      h.as('AGUS');
      const yearEnd = (await h.http().get('/calendar/entries').query({ date: '2027-01-01' }).expect(200)).body;
      const after = (await h.http().get('/calendar/entries').query({ date: '2027-01-04' }).expect(200)).body;
      expect(yearEnd).toMatchObject({ from: '2026-12-28', to: '2027-01-03' });
      expect(yearEnd.entries.map((e: { entryId: string }) => e.entryId)).toEqual([trip.entryId]);
      expect(after.entries.map((e: { entryId: string }) => e.entryId)).toEqual([trip.entryId]);
    });

    it('P12-T2 AC-3 entries come by start, then id', async () => {
      const late = await create('AGUS', timed(1, '14:00', '15:00'));
      const early = await create('AGUS', timed(1, '09:00', '09:30'));
      const twin = await create('AGUS', timed(1, '09:00', '10:00'));
      h.as('AGUS');
      const ids = (await h.http().get('/calendar/entries').expect(200)).body.entries.map((e: { entryId: string }) => e.entryId);
      expect(ids).toEqual([...[early.entryId, twin.entryId].sort(), late.entryId]);
    });

    it('P12-T2 AC-15 refuses a parameter it does not know, a date that is no day, and `for` with Month', async () => {
      h.as('AGUS');
      const unknown = await h.http().get('/calendar/entries').query({ page: 2 }).expect(400);
      expect(JSON.stringify(unknown.body.error.details)).toContain('page');
      expect((await h.http().get('/calendar/entries').query({ date: '2026-02-30' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await h.http().get('/calendar/entries').query({ date: '14 Sep' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await h.http().get('/calendar/entries').query({ view: 'day' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      const month = await h.http().get('/calendar/entries').query({ view: 'month', for: h.id('SARI') }).expect(400);
      expect(month.body.error.details.violations).toEqual(['for is read with view=week only.']);
    });
  });

  // ------------------------------------------------------------------ creating

  describe('creating (P12-T2 AC-4, AC-5)', () => {
    it('P12-T2 AC-4 answers the entry as its organiser reads it, at version 1, in the office’s terms', async () => {
      const body = await create('RINA', timed(1, '09:00', '09:30', { title: '  Client review — Hartono family  ', notes: 'Office — Meeting Room 2' }));
      expect(Object.keys(body).sort()).toEqual(ENTRY_KEYS);
      expect(body).toMatchObject({
        version: 1, type: 'meeting', title: 'Client review — Hartono family', notes: 'Office — Meeting Room 2',
        allDay: false, date: '2026-09-15', start: '09:00', end: '09:30', startsOn: null, endsOn: null,
        startsAt: '2026-09-15T02:00:00.000Z', endsAt: '2026-09-15T02:30:00.000Z',
        organiser: { membershipId: h.id('RINA'), name: 'Rina Wijaya' }, invitees: [], readerIs: 'organiser', myAnswer: null,
      });
    });

    it('P12-T2 AC-4 a title is optional and answered empty; any field role may choose any type, 1:1 coaching included', async () => {
      for (const who of ['AGUS', 'SARI', 'INDAH'] as const) {
        const body = await create(who, timed(2, '10:00', '10:30', { type: 'coaching', title: undefined }));
        expect([who, body.title, body.type]).toEqual([who, '', 'coaching']);
      }
    });

    it('P12-T2 AC-7 Travel is two office dates and no times', async () => {
      const trip = await create('AGUS', { type: 'travel', title: 'Client trip — Surabaya', startsOn: '2026-09-17', endsOn: '2026-09-18' });
      expect(trip).toMatchObject({
        allDay: true, date: null, start: null, end: null, startsOn: '2026-09-17', endsOn: '2026-09-18',
        startsAt: '2026-09-16T17:00:00.000Z', endsAt: '2026-09-18T17:00:00.000Z',
      });
    });

    it.each([
      ['an end before its start', timed(1, '10:00', '09:00'), 'end must be after start on the same date.'],
      ['a trip longer than 31 days', { type: 'travel', startsOn: '2026-09-01', endsOn: '2026-10-02' }, 'endsOn must be at most 31 days from startsOn, inclusive.'],
      ['a return before the departure', { type: 'travel', startsOn: '2026-09-18', endsOn: '2026-09-17' }, 'endsOn must be on or after startsOn.'],
      ['a timed entry with no date', { type: 'task', start: '09:00', end: '10:00' }, 'date is required.'],
      ['the other kind’s field', timed(1, '09:00', '10:00', { endsOn: '2026-09-16' }), 'endsOn is not part of a timed entry.'],
      ['a date that is no day', timed(1, '09:00', '10:00', { date: '2026-09-31' }), 'date must be a day, written YYYY-MM-DD.'],
      ['yourself as an invitee', timed(1, '09:00', '10:00', { inviteeIds: ['SELF'] }), 'inviteeIds must not include you: you are on your own entry already.'],
    ])('P12-T2 AC-5 refuses %s with 400 VALIDATION_FAILED, naming the field', async (_case, raw, violation) => {
      h.as('AGUS');
      const body = JSON.parse(JSON.stringify(raw).replace('SELF', h.id('AGUS')));
      const res = await h.http().post('/calendar/entries').send(body).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { violations: [violation] } });
      expect(await h.col('calendarEvents').countDocuments()).toBe(0);
    });

    it('P12-T2 AC-5 the limits are the contract’s: a title of 121, notes of 1,001, 51 invitees, a type not of the five, an unknown field', async () => {
      h.as('AGUS');
      const refuse = async (body: Record<string, unknown>, needle: string) => {
        const res = await h.http().post('/calendar/entries').send(body).expect(400);
        expect([needle, res.body.error.code, JSON.stringify(res.body.error.details).includes(needle)]).toEqual([needle, 'VALIDATION_FAILED', true]);
      };
      await refuse(timed(1, '09:00', '10:00', { title: 'x'.repeat(121) }), 'title');
      await refuse(timed(1, '09:00', '10:00', { notes: 'x'.repeat(1001) }), 'notes');
      await refuse(timed(1, '09:00', '10:00', { inviteeIds: Array.from({ length: 51 }, (_, i) => `id${i}`) }), 'inviteeIds');
      await refuse(timed(1, '09:00', '10:00', { inviteeIds: [h.id('SARI'), h.id('SARI')] }), 'inviteeIds');
      await refuse(timed(1, '09:00', '10:00', { type: 'training' }), 'type');
      await refuse(timed(1, '09:00', '10:00', { start: '24:00' }), 'start');
      await refuse(timed(1, '09:00', '10:00', { colour: 'teal' }), 'colour');
      // At the limit is fine.
      await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00', { title: 'x'.repeat(120), notes: 'y'.repeat(1000) })).expect(201);
    });
  });

  // ------------------------------------------------------------------ reading one, editing, deleting

  describe('one entry: read, edit, delete (P12-T2 AC-7 to AC-9)', () => {
    it('calendar_entry_read_only_by_its_people P12-T2 AC-7 its organiser reads it; anybody not on it — an ancestor included — is 404, and so is nobody’s id', async () => {
      const entry = await create('RINA', timed(2, '11:00', '12:00'));
      h.as('RINA');
      expect((await h.http().get(`/calendar/entries/${entry.entryId}`).expect(200)).body).toEqual(entry);
      for (const who of ['SARI', 'AGUS', 'BUDI', 'OWNER'] as const) {
        h.as(who);
        const res = await h.http().get(`/calendar/entries/${entry.entryId}`).expect(404);
        expect([who, res.body.error.code]).toEqual([who, 'NOT_FOUND']);
      }
      h.as('RINA');
      await h.http().get('/calendar/entries/66f00000000000000000ffff').expect(404);
      await h.http().get('/calendar/entries/not-an-id').expect(404);
    });

    it('P12-T2 AC-8 an edit carries its version, replaces what it sends, and moves the version on', async () => {
      const entry = await create('INDAH', timed(1, '09:00', '09:30', { title: 'Prospecting call block', type: 'task' }));
      h.as('INDAH');
      const edited = (await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, end: '10:30', notes: 'Desk' }).expect(200)).body;
      expect(edited).toMatchObject({ version: 2, title: 'Prospecting call block', notes: 'Desk', start: '09:00', end: '10:30', type: 'task' });
      // A stale version is 409, and says which it is now.
      const stale = await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, title: 'Late' }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });
    });

    it('P12-T2 AC-8 a change between Travel and a timed type sends the other kind’s fields', async () => {
      const entry = await create('AGUS', timed(3, '09:00', '10:00'));
      h.as('AGUS');
      const refused = await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, type: 'travel' }).expect(400);
      expect(refused.body.error.details.violations).toEqual(['startsOn is required.', 'endsOn is required.']);
      const trip = (await h.http().patch(`/calendar/entries/${entry.entryId}`)
        .send({ version: 1, type: 'travel', startsOn: '2026-09-17', endsOn: '2026-09-19', date: null, start: null, end: null }).expect(200)).body;
      expect(trip).toMatchObject({ type: 'travel', allDay: true, startsOn: '2026-09-17', endsOn: '2026-09-19', date: null, version: 2 });
      const back = (await h.http().patch(`/calendar/entries/${entry.entryId}`)
        .send({ version: 2, type: 'client', date: '2026-09-18', start: '13:00', end: '14:00', startsOn: null, endsOn: null }).expect(200)).body;
      expect(back).toMatchObject({ type: 'client', allDay: false, date: '2026-09-18', start: '13:00', end: '14:00', startsOn: null });
      // Within a kind, a date sent alone keeps the times.
      const moved = (await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 3, date: '2026-09-19' }).expect(200)).body;
      expect(moved).toMatchObject({ date: '2026-09-19', start: '13:00', end: '14:00' });
    });

    it('P12-T2 AC-8 a trip’s return date sent alone keeps its departure; a title sent as null clears it', async () => {
      const trip = await create('AGUS', { type: 'travel', title: 'Client trip — Surabaya', startsOn: '2026-09-17', endsOn: '2026-09-18' });
      h.as('AGUS');
      const longer = (await h.http().patch(`/calendar/entries/${trip.entryId}`).send({ version: 1, endsOn: '2026-09-20', title: null }).expect(200)).body;
      expect(longer).toMatchObject({ startsOn: '2026-09-17', endsOn: '2026-09-20', title: '', notes: '', version: 2 });
      const untitled = await create('AGUS', timed(1, '09:00', '10:00', { title: null, notes: null }));
      expect(untitled).toMatchObject({ title: '', notes: '' });
    });

    it('calendar_only_the_organiser_writes P12-T2 AC-8 only the organiser edits: an attendee and an ancestor are 404, a stale pin included', async () => {
      const entry = await create('SARI', timed(2, '09:00', '10:00', { inviteeIds: [] }));
      h.as('SARI');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, inviteeIds: [h.id('RINA')] }).expect(200);
      for (const who of ['RINA', 'AGUS'] as const) {
        h.as(who);
        expect((await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 2, title: 'Mine now' }).expect(404)).body.error.code)
          .toBe('NOT_FOUND');
        // The version is checked after reach, so a stale one tells them nothing either.
        await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, title: 'Mine now' }).expect(404);
        await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 2 }).expect(404);
      }
      expect((await h.col('calendarEvents').findOne({}))!.title).toBe('Weekly unit standup');
    });

    it('P12-T2 AC-9 a delete is soft, pinned, and takes the entry off every calendar', async () => {
      const entry = await create('AGUS', timed(4, '09:00', '09:30', { inviteeIds: [] }));
      h.as('AGUS');
      expect((await h.http().delete(`/calendar/entries/${entry.entryId}`).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 7 }).expect(409)).body.error.code)
        .toBe('VERSION_CONFLICT');
      const deleted = (await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 1 }).expect(200)).body;
      expect(deleted).toEqual({ entryId: entry.entryId, deletedAt: '2026-09-14T03:00:00.000Z' });
      // The row stays, with `deletedAt` (invariant §6); the entry reads nowhere.
      expect(await h.col('calendarEvents').findOne({})).toMatchObject({ deletedAt: new Date('2026-09-14T03:00:00Z') });
      expect((await h.http().get('/calendar/entries').expect(200)).body.entries).toEqual([]);
      await h.http().get(`/calendar/entries/${entry.entryId}`).expect(404);
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 1 }).expect(404);
    });
  });

  // ------------------------------------------------------------------ who is answered, per role

  describe('per role (P12-T2 AC-15; roles §3.15)', () => {
    it.each(['AGUS', 'SARI', 'INDAH'] as const)('P12-T2 AC-15 %s reads, creates, edits and deletes their own', async (who) => {
      const entry = await create(who, timed(1, '15:00', '16:00'));
      h.as(who);
      expect((await h.http().get('/calendar/entries').expect(200)).body.entries).toHaveLength(1);
      await h.http().get(`/calendar/entries/${entry.entryId}`).expect(200);
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, title: 'Renamed' }).expect(200);
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 2 }).expect(200);
      await h.http().get('/calendar/people').expect(200);
      await h.http().get('/calendar/downline').expect(200);
    });

    /** Every route, called with a body the validation pipe accepts. */
    const everyRoute = (entryId: string, member: string) => [
      (http: CalendarHarness['http']) => http().get('/calendar/entries'),
      (http: CalendarHarness['http']) => http().get(`/calendar/entries/${entryId}`),
      (http: CalendarHarness['http']) => http().post('/calendar/entries').send(timed(1, '09:00', '10:00')),
      (http: CalendarHarness['http']) => http().patch(`/calendar/entries/${entryId}`).send({ version: 1, title: 'x' }),
      (http: CalendarHarness['http']) => http().delete(`/calendar/entries/${entryId}`).query({ version: 1 }),
      (http: CalendarHarness['http']) => http().post(`/calendar/entries/${entryId}/answer`).send({ answer: 'accepted' }),
      (http: CalendarHarness['http']) => http().get('/calendar/people'),
      (http: CalendarHarness['http']) => http().get('/calendar/downline'),
      (http: CalendarHarness['http']) => http().post('/calendar/blocks').send({ ...timed(1, '11:00', '12:00'), membershipId: member }),
    ];

    it('calendar_office_roles_have_no_calendar P12-T2 AC-15 an Owner and an Admin with no field role, and a Super Admin, are refused every route by the guard', async () => {
      const entry = await create('AGUS', timed(1, '09:00', '10:00'));
      const refused: [string, RequestContext][] = [
        ['an Owner with no field role', h.officeOnly('OWNER')],
        ['an Admin with no field role', h.officeOnly('ADMIN')],
        ['a Super Admin', SUPER_ADMIN],
      ];
      for (const [who, ctx] of refused) {
        h.as(ctx);
        for (const [i, call] of everyRoute(entry.entryId, h.id('INDAH')).entries()) {
          const res = await call(h.http);
          expect([who, i, res.status, res.body.error?.code]).toEqual([who, i, 403, 'PERM_DENIED']);
        }
      }
      expect(await h.col('calendarEvents').countDocuments()).toBe(1);
    });

    it('calendar_office_roles_have_no_calendar P12-T2 AC-15 a member who is pending or has left holds no calendar grant', async () => {
      for (const status of ['pending', 'removed'] as const) {
        const indah = h.office.as('INDAH');
        h.as(new RequestContext(indah.userId, 'none', { ...indah.membership!, status }));
        expect((await h.http().get('/calendar/entries').expect(403)).body.error.code).toBe('PERM_DENIED');
        await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00')).expect(403);
      }
    });

    it('P12-T2 AC-15 an Owner or Admin who stands on a rung reads and writes as that member (§1.1)', async () => {
      for (const who of ['OWNER', 'ADMIN'] as const) {
        const entry = await create(who, timed(1, '09:00', '10:00'));
        expect(entry.organiser.membershipId).toBe(h.id(who));
      }
    });

    it('support_session_cannot_write_calendar P12-T2 AC-15 a read-only support session reads its member’s calendar and writes nothing (§3.13)', async () => {
      const entry = await create('SARI', timed(1, '09:00', '10:00', { inviteeIds: [h.id('RINA')] }));
      h.as(h.supporting('SARI'));
      expect((await h.http().get('/calendar/entries').expect(200)).body.entries).toHaveLength(1);
      await h.http().get(`/calendar/entries/${entry.entryId}`).expect(200);
      await h.http().get('/calendar/people').expect(200);
      await h.http().get('/calendar/downline').expect(200);
      for (const call of everyRoute(entry.entryId, h.id('RINA')).slice(2, 6).concat(everyRoute(entry.entryId, h.id('RINA')).slice(8))) {
        expect((await call(h.http)).status).toBe(403);
      }
      h.as(h.supporting('RINA'));
      await h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'declined' }).expect(403);
      const stored = await h.col('calendarEvents').find({}).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ version: 1, deletedAt: null, attendees: [{ answer: 'pending' }] });
      // A refused write records nothing: Sari's own create is the only calendar row on the record.
      expect((await calendarRows()).map((r) => r.action)).toEqual(['calendar_entry.created']);
    });

    it('B1 P12-T2 AC-15 an elevated support session writes as its member, both actors on the record', async () => {
      const entry = await create('AGUS', timed(1, '13:00', '14:00', { inviteeIds: [h.id('INDAH')] }));
      await h.col('auditLog').deleteMany({});
      h.as(h.supporting('INDAH', false));
      const own = (await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00')).expect(201)).body;
      expect(own.organiser.membershipId).toBe(h.id('INDAH'));
      expect(await h.col('calendarEvents').findOne({ _id: new mongoose.Types.ObjectId(own.entryId) })).toMatchObject({ createdBy: h.id('INDAH') });
      await h.http().patch(`/calendar/entries/${own.entryId}`).send({ version: 1, end: '10:30' }).expect(200);
      await h.http().delete(`/calendar/entries/${own.entryId}`).query({ version: 2 }).expect(200);
      await h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'accepted' }).expect(200);

      // Every write names the support user who made it and the member it was made as (§3.13).
      expect((await calendarRows()).map((r) => [r.action, r.actorUserId, r.effectiveUserId, r.actorMembershipId, r.targetId])).toEqual([
        ['calendar_entry.created', 'u-support', h.office.as('INDAH').userId, h.id('INDAH'), own.entryId],
        ['calendar_entry.updated', 'u-support', h.office.as('INDAH').userId, h.id('INDAH'), own.entryId],
        ['calendar_entry.deleted', 'u-support', h.office.as('INDAH').userId, h.id('INDAH'), own.entryId],
        ['calendar_entry.answered', 'u-support', h.office.as('INDAH').userId, h.id('INDAH'), entry.entryId],
      ]);
    });

    it('P12-T2 AC-15 an AB answers an invitation made to them: Agus, invited by the Owner, accepts and then declines', async () => {
      const entry = await create('OWNER', timed(1, '13:00', '14:00', { title: 'Branch review', inviteeIds: [h.id('AGUS')] }));
      h.as('AGUS');
      const accepted = (await h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'accepted' }).expect(200)).body;
      expect(accepted).toMatchObject({ entryId: entry.entryId, readerIs: 'invitee', myAnswer: 'accepted', version: 1 });
      const declined = (await h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'declined' }).expect(200)).body;
      expect(declined).toMatchObject({ myAnswer: 'declined', version: 1 });
      expect((await h.col('calendarEvents').findOne({}))!.attendees).toEqual([
        expect.objectContaining({ membershipId: h.id('AGUS'), placed: false, answer: 'declined' }),
      ]);
    });

    it('calendar_block_is_not_answered P12-T2 AC-15 an AB a block is placed on is answered 409: the Owner, the AB above Agus, blocks his time', async () => {
      h.as('OWNER');
      const placed = (await h.http().post('/calendar/blocks')
        .send({ ...timed(2, '11:00', '11:30', { type: 'coaching', title: '1:1 with Agus Salim' }), membershipId: h.id('AGUS') })
        .expect(201)).body;
      h.as('AGUS');
      for (const answer of ['accepted', 'declined']) {
        const res = await h.http().post(`/calendar/entries/${placed.entryId}/answer`).send({ answer }).expect(409);
        expect([answer, res.body.error]).toEqual([answer, expect.objectContaining({
          code: 'CALENDAR_BLOCK_NOT_ANSWERABLE', details: { entryId: placed.entryId },
        })]);
      }
      expect((await h.col('calendarEvents').findOne({}))!.attendees).toEqual([
        expect.objectContaining({ membershipId: h.id('AGUS'), placed: true, answer: null, answeredAt: null }),
      ]);
      expect((await calendarRows()).map((r) => r.action)).toEqual(['calendar_entry.block_placed']);
    });
  });

  // ------------------------------------------------------------------ the record of each write

  describe('the record each write leaves (B1, the Phase 12 exit permission review)', () => {
    it('B1 each of the five writes leaves one auditLog row: the entry, its version, the member a block is placed on', async () => {
      const entry = await create('SARI', timed(1, '09:00', '10:00', {
        type: 'client', title: 'Client visit — Kusuma', notes: 'Kusuma residence, Jl. Melati 4', inviteeIds: [h.id('RINA')],
      }));
      h.as('RINA');
      await h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'accepted' }).expect(200);
      h.as('SARI');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, title: 'Client visit — Hartono' }).expect(200);
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 2 }).expect(200);
      const block = (await h.http().post('/calendar/blocks')
        .send({ ...timed(2, '11:00', '11:30', { type: 'coaching', title: '1:1 with Rina Wijaya' }), membershipId: h.id('RINA') })
        .expect(201)).body;
      await h.http().patch(`/calendar/entries/${block.entryId}`).send({ version: 1, end: '12:00' }).expect(200);
      await h.http().delete(`/calendar/entries/${block.entryId}`).query({ version: 2 }).expect(200);

      const rows = await calendarRows();
      const kpmId = h.office.as('SARI').kpmId;
      expect(rows.map((r) => ({
        kpmId: r.kpmId, action: r.action, actorUserId: r.actorUserId, effectiveUserId: r.effectiveUserId,
        actorMembershipId: r.actorMembershipId, targetCollection: r.targetCollection, targetId: r.targetId,
        targetMembershipId: r.targetMembershipId, onBehalfOf: r.onBehalfOf, before: r.before, after: r.after,
      }))).toEqual([
        ['calendar_entry.created', 'SARI', entry.entryId, null, 1],
        ['calendar_entry.answered', 'RINA', entry.entryId, null, 1],
        ['calendar_entry.updated', 'SARI', entry.entryId, null, 2],
        ['calendar_entry.deleted', 'SARI', entry.entryId, null, 2],
        // The leader's write on somebody else's calendar names them, and is on their behalf.
        ['calendar_entry.block_placed', 'SARI', block.entryId, 'RINA', 1],
        ['calendar_entry.updated', 'SARI', block.entryId, 'RINA', 2],
        ['calendar_entry.deleted', 'SARI', block.entryId, 'RINA', 2],
      ].map(([action, by, targetId, on, version]) => ({
        kpmId, action, actorUserId: `u-${by}`, effectiveUserId: null, actorMembershipId: h.id(by as Who),
        targetCollection: 'calendarEvents', targetId, targetMembershipId: on === null ? null : h.id(on as Who),
        onBehalfOf: on !== null, before: null, after: { version },
      })));
      // Ids and the version only: nothing anybody typed, and nobody's name.
      const wire = JSON.stringify(rows);
      for (const text of ['Kusuma', 'Hartono', 'Melati', 'Rina Wijaya', 'Sari Puspita', 'client', 'coaching']) {
        expect([text, wire.includes(text)]).toEqual([text, false]);
      }
    });

    it('B1 a refused write records nothing: a stale version, somebody else’s entry, an invitee who is not invitable, a placed member’s answer', async () => {
      const entry = await create('AGUS', timed(1, '09:00', '10:00', { inviteeIds: [h.id('INDAH')] }));
      h.as('AGUS');
      const placed = (await h.http().post('/calendar/blocks').send({ ...timed(2, '11:00', '11:30'), membershipId: h.id('DIMAS') }).expect(201)).body;
      await h.col('auditLog').deleteMany({});

      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 7, title: 'Late' }).expect(409);
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 7 }).expect(409);
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, inviteeIds: [h.id('LEFT')] }).expect(404);
      await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00', { inviteeIds: [h.id('B_AGENT')] })).expect(404);
      await h.http().post('/calendar/blocks').send({ ...timed(2, '11:00', '11:30'), membershipId: h.id('PEER_AGENT') }).expect(404);
      await h.http().post(`/calendar/entries/${entry.entryId}/answer`).send({ answer: 'accepted' }).expect(404);
      h.as('INDAH');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, title: 'Mine' }).expect(404);
      h.as('DIMAS');
      await h.http().post(`/calendar/entries/${placed.entryId}/answer`).send({ answer: 'declined' }).expect(409);

      expect(await calendarRows()).toEqual([]);
    });
  });
});
