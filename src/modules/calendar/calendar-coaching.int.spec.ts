import { coachingCoverage } from '@/domain/metrics/coaching-coverage';
import { ROSTER_TODAY, type Who } from '../../../test/coaching-office';
import { startCalendar, stopCalendar, timed, type CalendarHarness } from '../../../test/calendar-office';

type Doc = Record<string, unknown>;
type Invitee = { membershipId: string; readerCoaches: boolean };

/**
 * **A *1:1 coaching* entry, and what it is not** (P12-T6; ADR-0099, OD-84's answer, ADR-0081).
 *
 * The entry stores no session. In its detail, the chip of each invitee the reader coaches —
 * `COACH(reader, invitee)`, decided when the entry is read — opens that person's *Coaching Session* tab;
 * every other chip is plain. Nothing in the calendar creates a session, and no entry moves any coaching
 * metric: those read finalized sessions only.
 */
describe('1:1 coaching entries (P12-T6)', () => {
  let h: CalendarHarness;
  const create = async (who: Who, body: Doc) => {
    h.as(who);
    return (await h.http().post('/calendar/entries').send(body).expect(201)).body;
  };
  const chips = (entry: { invitees: Invitee[] }) =>
    Object.fromEntries(entry.invitees.map((i) => [i.membershipId, i.readerCoaches]));
  const oneToOne = (day: number, over: Doc = {}) => timed(day, '11:00', '12:00', { type: 'coaching', title: '1:1 coaching', ...over });

  beforeAll(async () => { h = await startCalendar(); }, 120_000);
  afterAll(() => stopCalendar(h));
  beforeEach(() => h.reset());

  describe('the chip (P12-T6 AC-1, AC-4, AC-6)', () => {
    it('P12-T6 AC-1 on the organiser’s 1:1, the chip of each invitee they coach is a link; anybody else’s is plain', async () => {
      const entry = await create('AGUS', oneToOne(1, { inviteeIds: [h.id('INDAH'), h.id('NINA'), h.id('OWNER')] }));
      expect(chips(entry)).toEqual({ [h.id('INDAH')]: true, [h.id('NINA')]: true, [h.id('OWNER')]: false });
    });

    it('P12-T6 AC-1 a coachee’s own detail links nowhere', async () => {
      const entry = await create('SARI', oneToOne(1, { inviteeIds: [h.id('RINA')] }));
      h.as('RINA');
      const read = (await h.http().get(`/calendar/entries/${entry.entryId}`).expect(200)).body;
      expect(read.invitees.map((i: Invitee) => i.readerCoaches)).toEqual([false]);
      expect(chips(entry)).toEqual({ [h.id('RINA')]: true });
    });

    it('P12-T6 AC-1 an invitee who coaches another invitee sees that chip as a link: COACH is the reader’s, not the organiser’s', async () => {
      const entry = await create('OWNER', oneToOne(2, { inviteeIds: [h.id('AGUS'), h.id('SARI'), h.id('PEER_AGENT')] }));
      h.as('AGUS');
      const read = (await h.http().get(`/calendar/entries/${entry.entryId}`).expect(200)).body;
      expect(chips(read)).toEqual({ [h.id('AGUS')]: false, [h.id('SARI')]: true, [h.id('PEER_AGENT')]: false });
    });

    it('P12-T6 AC-1 a leader comparing a downline reads the chips of the people they coach as links', async () => {
      await create('SARI', oneToOne(3, { inviteeIds: [h.id('RINA')] }));
      h.as('AGUS');
      const pane = (await h.http().get('/calendar/entries').query({ for: h.id('SARI') }).expect(200)).body;
      expect(chips(pane.entries[0])).toEqual({ [h.id('RINA')]: true });
    });

    it('P12-T6 AC-1 only a 1:1 coaching entry links: the same people on a meeting are plain', async () => {
      const entry = await create('AGUS', timed(1, '09:00', '10:00', { inviteeIds: [h.id('INDAH')] }));
      expect(chips(entry)).toEqual({ [h.id('INDAH')]: false });
    });

    it('P12-T6 AC-4 any field role makes a 1:1 entry with anybody the picker reaches; an Agent’s links nowhere', async () => {
      const byAgent = await create('INDAH', oneToOne(2, { inviteeIds: [h.id('AGUS'), h.id('PEER_AGENT')] }));
      expect(chips(byAgent)).toEqual({ [h.id('AGUS')]: false, [h.id('PEER_AGENT')]: false });
      // An Agent who leads somebody coaches nobody on the calendar, as in coaching.
      const byLukas = await create('LUKAS', oneToOne(2, { inviteeIds: [h.id('TARI')] }));
      expect(chips(byLukas)).toEqual({ [h.id('TARI')]: false });
    });

    it('P12-T6 AC-6 another office reads none of it', async () => {
      const entry = await create('SARI', oneToOne(1, { inviteeIds: [h.id('RINA')] }));
      h.as('B_AB');
      await h.http().get(`/calendar/entries/${entry.entryId}`).expect(404);
    });
  });

  describe('it counts for nothing (P12-T6 AC-2, AC-3; OD-84)', () => {
    it('calendar_entry_never_counts_as_coaching P12-T6 AC-2 creating, editing and deleting a 1:1 entry writes no coaching session, and opens no draft', async () => {
      const before = await h.col('coachingSessions').find({}).toArray();
      const entry = await create('AGUS', oneToOne(0, { start: '10:30', end: '11:30', inviteeIds: [h.id('DIMAS'), h.id('INDAH')] }));
      h.as('AGUS');
      await h.http().patch(`/calendar/entries/${entry.entryId}`).send({ version: 1, start: '13:00', end: '14:00' }).expect(200);
      await h.http().post('/calendar/blocks').send({ ...oneToOne(1), membershipId: h.id('SARI') }).expect(201);
      await h.http().delete(`/calendar/entries/${entry.entryId}`).query({ version: 2 }).expect(200);
      expect(await h.col('coachingSessions').find({}).toArray()).toEqual(before);
      // And no entry stores a session: the record has no field for one.
      for (const stored of await h.col('calendarEvents').find({}).toArray()) {
        expect(Object.keys(stored).filter((key) => /session/i.test(key))).toEqual([]);
      }
    });

    it('calendar_entry_never_counts_as_coaching P12-T6 AC-3 Last 1:1, DAYS_SINCE_LAST_COACHING, COACHED_7D, COACHED_30D and COACHING_COVERAGE are unchanged by 1:1 entries', async () => {
      const office = { today: ROSTER_TODAY, timezone: 'Asia/Jakarta' };
      const coachees = ['INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI'] as const;
      const ids = coachees.map((who) => h.id(who));
      const measure = async () => {
        const recency = await h.wired.coachingReadings.recencyOf(h.office.as('AGUS'), ids, office);
        const sessions = await h.col('coachingSessions').find({}).toArray();
        return {
          roster: await h.wired.coachingRoster.read(h.office.as('AGUS')),
          sariRoster: await h.wired.coachingRoster.read(h.office.as('SARI')),
          recency: [...recency.entries()],
          coverage: coachingCoverage({
            scope: ids, leaderMembershipId: h.id('AGUS'),
            sessions: sessions.map((s) => ({ coacheeMembershipId: s.coacheeMembershipId, status: s.status, date: s.date })),
            today: ROSTER_TODAY, daysBetween: (from, to) => h.clock.daysBetween('Asia/Jakarta', from, to),
          }),
        };
      };
      const before = await measure();
      // 1:1 entries today, yesterday and a fortnight ago, for people with and without a 1:1 on record.
      for (const who of ['DIMAS', 'BUDI', 'DEWI', 'INDAH'] as const) {
        await create('AGUS', oneToOne(0, { start: '07:00', end: '07:30', inviteeIds: [h.id(who)] }));
        await create('AGUS', oneToOne(0, { date: '2026-09-13', inviteeIds: [h.id(who)] }));
        await create('AGUS', oneToOne(0, { date: '2026-08-31', inviteeIds: [h.id(who)] }));
      }
      await create('SARI', oneToOne(0, { start: '08:00', end: '08:30', inviteeIds: [h.id('BUDI'), h.id('NINA')] }));
      h.as('AGUS');
      await h.http().post('/calendar/blocks').send({ ...oneToOne(0, { start: '08:00', end: '08:30' }), membershipId: h.id('DODI') }).expect(201);

      expect(await measure()).toEqual(before);
      // Sanity: the roster really reads *No 1:1 yet* for Dimas, who has only calendar entries.
      expect(before.roster.directAgents.find((r) => r.membershipId === h.id('DIMAS'))!.lastOneOnOne).toBeNull();
    });
  });
});
