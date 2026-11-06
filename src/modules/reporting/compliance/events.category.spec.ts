import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { EventFacts } from '@/modules/events/event-readings';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { configModule } from '../../../../test/config-module';
import {
  buildEventsOffice, KPM_A, KPM_B, type EventKey, type EventsOffice, type EventsWho,
} from '../../../../test/events-office';
import { ROSTER_NOW } from '../../../../test/coaching-office';
import type { ComplianceScope } from './compliance-category';
import { eventCell, eventOrder, EventsComplianceCategory } from './events.category';

/**
 * **Events in the Owner's compliance tree** (P18.3-T1 AC-3, P18.3-T2 AC-1, AC-2): the picker's catalog over
 * D-window, the chip over D-chips, and each member's cell — **equal to the roll call's status** for the same event.
 * Over the events office (`test/events-office.ts`): 10:00 on Monday 14 September 2026 in Jakarta.
 */
describe('the compliance tree’s Events category (P18.3-T2)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: EventsOffice;
  let category: EventsComplianceCategory;
  const db = () => mongoose.connection.db!;
  const idOf = (key: EventKey) => office.event[key].id;
  const YEAR = {
    from: '2026-01-01', to: '2026-12-31',
    start: new Date('2026-01-01T00:00:00+07:00'), end: new Date('2027-01-01T00:00:00+07:00'),
  };
  /** The tree's members: the office's active ones (Fajar, who left, is in no row). */
  const ACTIVE: EventsWho[] = [
    'OWNER', 'ADMIN', 'AGUS', 'INDAH', 'DIMAS', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'LUKAS', 'TARI',
    'PEER_AB', 'PEER_AAB', 'PEER_AGENT', 'LATE',
  ];
  const scopeOf = (ctx: RequestContext, memberIds: string[], year = YEAR): ComplianceScope => ({
    ctx, office: {} as never, today: '2026-09-14', year, memberIds,
  });
  const ownerScope = (who: EventsWho[] = ACTIVE) => scopeOf(office.as('OWNER'), who.map((w) => office.id[w]));
  const read = (scope: ComplianceScope, item: string | null = null, selected = true) => category.read(scope, { selected, item });
  const rsvp = (key: EventKey, who: EventsWho, over: Record<string, unknown> = {}) => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], rsvpStatus: 'going', rsvpAt: new Date('2026-08-01T02:00:00Z'),
    cancelledAt: null, claimedAt: null, confirmedAttended: null, confirmedByMembershipId: null, confirmedAt: null, deletedAt: null,
    ...over,
  });
  const confirmed = (attended: boolean) => ({ confirmedAttended: attended, confirmedByMembershipId: 'admin', confirmedAt: ROSTER_NOW });
  const answer = (key: EventKey, who: EventsWho) => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], score: 8, why: 'Useful', improve: '',
    submittedAt: new Date('2026-08-25T02:00:00Z'), deletedAt: null,
  });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    category = new EventsComplianceCategory(wired.eventReadings);
    await clearCollections();
    office = await buildEventsOffice(wired);
    // Last year's event: outside D-window.
    await wired.events.create(office.as('OWNER'), {
      code: 'LAST_YEAR', typeCode: 'TRAINING', title: 'LAST YEAR', startsAt: '2025-11-03T02:00:00Z', endsAt: '2025-11-03T05:00:00Z',
      audience: { issuer: 'kpm', scope: 'all_agents' },
    });
    await db().collection('eventRsvps').insertMany([
      rsvp('PAST_ALL', 'RINA', confirmed(true)),
      rsvp('PAST_ALL', 'BUDI', confirmed(true)),
      rsvp('PAST_ALL', 'INDAH'),
      rsvp('PAST_ALL', 'DIMAS', { rsvpStatus: null, rsvpAt: null, claimedAt: new Date('2026-08-24T06:00:00Z') }),
      rsvp('PAST_ALL', 'SARI', confirmed(false)),
      rsvp('PAST_CHOSEN', 'BUDI', confirmed(false)),
      rsvp('UPCOMING', 'TARI'),
      rsvp('UPCOMING', 'NINA', { rsvpStatus: 'cancelled', cancelledAt: new Date('2026-09-10T02:00:00Z') }),
    ]);
    await db().collection('eventFeedback').insertMany([
      answer('PAST_ALL', 'RINA'), answer('PAST_ALL', 'INDAH'), answer('PAST_ALL', 'SARI'),
    ]);
  }, 120_000);
  afterAll(stopMongo);

  describe('the picker (P18.3-T2 AC-1, D-window)', () => {
    it('P18.3-T2 AC-1 lists this year’s events, archived and other offices’ never, not past soonest first then past latest first', async () => {
      const { catalog } = await read(ownerScope(), null, false);
      expect(catalog.map((e) => e.id)).toEqual([
        // Not past: the running one, started an hour ago, then the one in five days.
        idOf('RUNNING_LEADERS'), idOf('UPCOMING'),
        // Past, the latest first: ended exactly now, then 24, 20 and 10 August.
        idOf('ENDS_NOW'), idOf('PAST_ALL'), idOf('PAST_CHOSEN'), idOf('PAST_LEADERS'),
      ]);
      expect(catalog[0]).toEqual({
        id: idOf('RUNNING_LEADERS'), title: 'RUNNING LEADERS', startsAt: office.event.RUNNING_LEADERS.startsAt,
        endsAt: office.event.RUNNING_LEADERS.endsAt, startsOn: '2026-09-14', phase: 'running',
      });
      expect(catalog.find((e) => e.id === idOf('PAST_ALL'))).toMatchObject({ phase: 'past', startsOn: '2026-08-24' });
      expect(catalog.find((e) => e.id === idOf('UPCOMING'))).toMatchObject({ phase: 'upcoming', startsOn: '2026-09-19' });
    });

    it('P18.3-T2 AC-1 opens on the picker’s first event without an item, as the prototype does (Owner:3497)', async () => {
      const result = await read(ownerScope());
      expect(result.item).toBe(idOf('RUNNING_LEADERS'));
      expect(result.cells!.size).toBe(ACTIVE.length);
    });

    it('P18.3-T2 AC-1 answers 404 for an event it does not list: another office’s, archived, last year’s, or no id at all', async () => {
      const lastYear = (await wired.events.list(office.as('OWNER'))).find((e) => e.code === 'LAST_YEAR')!.id;
      for (const item of [idOf('B_PAST'), idOf('ARCHIVED'), lastYear, 'not-an-id', '66f0000000000000000000ff']) {
        await expect(read(ownerScope(), item)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
    });

    it('P18.3-T2 AC-1 KPM A never reads KPM B: 0555’s Owner lists 0555’s event alone, and A’s is 404', async () => {
      const b = scopeOf(office.as('B_OWNER'), [office.id.B_AB, office.id.B_AGENT]);
      const result = await read(b);
      expect(result.catalog.map((e) => e.id)).toEqual([idOf('B_PAST')]);
      expect(result.item).toBe(idOf('B_PAST'));
      await expect(read(b, idOf('PAST_ALL'))).rejects.toMatchObject({ status: 404 });
    });

    it('P18.3-T2 AC-1 an office with no event this year: no item, an empty tree, the chip over nobody', async () => {
      const nothing = {
        from: '2030-01-01', to: '2030-12-31', start: new Date('2030-01-01T00:00:00+07:00'), end: new Date('2031-01-01T00:00:00+07:00'),
      };
      const empty = await read(scopeOf(office.as('OWNER'), ACTIVE.map((w) => office.id[w]), nothing));
      expect(empty).toEqual({ catalog: [], chip: { count: 0, of: 0 }, item: null, cells: new Map() });
      const unselected = await category.read(scopeOf(office.as('OWNER'), [], nothing), { selected: false, item: null });
      expect(unselected.cells).toBeNull();
      await expect(read(scopeOf(office.as('OWNER'), [], nothing), idOf('PAST_ALL'))).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the rows (P18.3-T2 AC-2)', () => {
    const cellsOf = async (key: EventKey) => (await read(ownerScope(), idOf(key))).cells!;
    const cellOf = async (key: EventKey, who: EventsWho) => (await cellsOf(key)).get(office.id[who]);

    it('P18.3-T2 AC-2 a past event: Attended with its day, Not shared or Shared; — awaiting confirmation; No-show; Not registered', async () => {
      const cells = await cellsOf('PAST_ALL');
      const of = (who: EventsWho) => cells.get(office.id[who]);
      expect(of('RINA')).toEqual({ status: 'attended', done: true, on: '2026-08-24', second: 'shared' });
      expect(of('BUDI')).toEqual({ status: 'attended', done: true, on: '2026-08-24', second: 'not_shared' });
      // In the audience, said they came or RSVP'd, nobody has confirmed: not done, and not "not applicable" either.
      expect(of('INDAH')).toEqual({ status: 'unconfirmed', done: false, on: null, second: 'shared' });
      expect(of('DIMAS')).toEqual({ status: 'unconfirmed', done: false, on: null, second: 'not_shared' });
      // Marked absent: no feedback column, even with an answer on file — feedback is asked of those who attended.
      expect(of('SARI')).toEqual({ status: 'no_show', done: false, on: null, second: null });
      expect(of('AGUS')).toEqual({ status: 'not_registered', done: false, on: null, second: null });
      // Joined after it: outside its audience as at the start — — in both, out of the count.
      expect(of('LATE')).toEqual({ status: null, done: null, on: null, second: null });
    });

    it('P18.3-T2 AC-2 an upcoming event: Registered with its day, or Not registered (a cancelled RSVP included); no feedback yet', async () => {
      expect(await cellOf('UPCOMING', 'TARI')).toEqual({ status: 'registered', done: true, on: '2026-09-19', second: null });
      expect(await cellOf('UPCOMING', 'NINA')).toEqual({ status: 'not_registered', done: false, on: null, second: null });
      expect(await cellOf('UPCOMING', 'LATE')).toEqual({ status: 'not_registered', done: false, on: null, second: null });
    });

    it('P18.3-T2 AC-2 a running event reads as an upcoming one, and its audience is the leaders’', async () => {
      expect(await cellOf('RUNNING_LEADERS', 'AGUS')).toEqual({ status: 'not_registered', done: false, on: null, second: null });
      expect(await cellOf('RUNNING_LEADERS', 'RINA')).toEqual({ status: null, done: null, on: null, second: null });
    });

    it('P18.3-T2 AC-2 a chosen-people event: — in both for everybody not chosen', async () => {
      const cells = await cellsOf('PAST_CHOSEN');
      expect(cells.get(office.id.BUDI)).toEqual({ status: 'no_show', done: false, on: null, second: null });
      expect(cells.get(office.id.RINA)).toEqual({ status: 'not_registered', done: false, on: null, second: null });
      expect(cells.get(office.id.INDAH)).toEqual({ status: null, done: null, on: null, second: null });
    });

    it('P18.3-T2 AC-2 serves a cell for the tree’s members only', async () => {
      const result = await read(ownerScope(['RINA', 'BUDI']), idOf('PAST_ALL'));
      expect([...result.cells!.keys()].sort()).toEqual([office.id.RINA, office.id.BUDI].sort());
    });

    it.each(['UPCOMING', 'RUNNING_LEADERS', 'PAST_ALL', 'PAST_CHOSEN', 'PAST_LEADERS', 'ENDS_NOW'] as EventKey[])(
      'P18.3-T2 AC-2 reconciliation: every status of %s equals the roll call’s, and nobody it does not list has one',
      async (key) => {
        const [cells, call] = await Promise.all([cellsOf(key), wired.eventRollCalls.rollCall(office.as('ADMIN'), idOf(key))]);
        const fromCall = new Map(call.people.map((p) => [p.membershipId, p.status]));
        for (const who of ACTIVE) {
          const id = office.id[who];
          expect([who, cells.get(id)!.status]).toEqual([who, fromCall.get(id) ?? null]);
        }
      },
    );
  });

  describe('the chip (P18.3-T1 AC-3, D-chips)', () => {
    it('P18.3-T1 AC-3 attended (confirmed) at or registered for one listed event, over those in one listed audience', async () => {
      const { chip } = await read(ownerScope(), null, false);
      // RINA and BUDI attended PAST_ALL; TARI is registered for UPCOMING. INDAH and DIMAS await confirmation: not counted.
      // Everybody is in UPCOMING's audience (the office as it is now), LATE included.
      expect(chip).toEqual({ count: 3, of: ACTIVE.length });
    });

    it('P18.3-T1 AC-3 counts the tree’s members only', async () => {
      const { chip } = await read(ownerScope(['RINA', 'INDAH', 'AGUS']), null, false);
      expect(chip).toEqual({ count: 1, of: 3 });
    });
  });

  describe('pure rules', () => {
    const event = (over: Partial<EventFacts>): EventFacts => ({
      id: 'e1', code: 'E', title: 'E', typeCode: 'T', startsAt: new Date('2026-09-01T02:00:00Z'), endsAt: new Date('2026-09-01T04:00:00Z'),
      startsOn: '2026-09-01', phase: 'past', ended: true, audience: { issuer: 'kpm', scope: 'all_agents' }, status: 'active', ...over,
    });
    const row = (status: 'attended' | 'registered' | 'unconfirmed' | 'no_show' | 'not_registered', gaveFeedback = false) => ({
      membershipId: 'm', orgLevelCode: 'AGENT', rowId: null, rsvp: null, claimed: false, confirmed: null,
      confirmedByMembershipId: null, confirmedAt: null, status, gaveFeedback,
    });

    it('P18.3-T2 AC-2 the done rule is the roll call’s status: attended once ended, registered before', () => {
      expect(eventCell(row('attended', true), event({}))).toEqual({ status: 'attended', done: true, on: '2026-09-01', second: 'shared' });
      expect(eventCell(row('unconfirmed'), event({}))).toEqual({ status: 'unconfirmed', done: false, on: null, second: 'not_shared' });
      expect(eventCell(row('no_show', true), event({}))).toEqual({ status: 'no_show', done: false, on: null, second: null });
      expect(eventCell(row('registered'), event({ ended: false, phase: 'upcoming' })))
        .toEqual({ status: 'registered', done: true, on: '2026-09-01', second: null });
      expect(eventCell(row('not_registered'), event({ ended: false, phase: 'running' })))
        .toEqual({ status: 'not_registered', done: false, on: null, second: null });
      expect(eventCell(undefined, event({}))).toEqual({ status: null, done: null, on: null, second: null });
    });

    it('P18.3-T2 AC-1 the order: not past before past; ties by id', () => {
      const at = (iso: string) => new Date(iso);
      const a = { id: 'a', phase: 'past' as const, startsAt: at('2026-08-01T00:00:00Z') };
      const b = { id: 'b', phase: 'past' as const, startsAt: at('2026-08-01T00:00:00Z') };
      const c = { id: 'c', phase: 'upcoming' as const, startsAt: at('2026-10-01T00:00:00Z') };
      expect([b, a, c].sort(eventOrder).map((e) => e.id)).toEqual(['c', 'a', 'b']);
      const d = { id: 'd', phase: 'upcoming' as const, startsAt: at('2026-10-01T00:00:00Z') };
      expect([d, c].sort(eventOrder).map((e) => e.id)).toEqual(['c', 'd']);
      expect(eventOrder(a, c)).toBe(1);
      expect(eventOrder(c, a)).toBe(-1);
    });

    it('round 1 L3: at the end instant, a cell reads `ended` from the attendance’s own event, with its rows’ statuses', async () => {
      // Listed a moment before its end (running), read a moment after (ended, the confirmer's mark counting).
      const listed = event({ id: '66f00000000000000000e002', phase: 'running', ended: false });
      const read = { ...listed, phase: 'past' as const, ended: true };
      const stub = new EventsComplianceCategory({
        eventsBetween: async () => [listed],
        attendanceOfMany: async () => new Map([[listed.id, {
          event: read, rows: [{ ...row('attended', true), membershipId: office.id.RINA }], rate: 100,
          counts: { audience: 1, attended: 1, registered: 0, unconfirmed: 0, no_show: 0, not_registered: 0 },
        }]]),
      } as never);
      const result = await stub.read(scopeOf(office.as('OWNER'), [office.id.RINA]), { selected: true, item: null });
      expect(result.cells!.get(office.id.RINA)).toEqual({ status: 'attended', done: true, on: '2026-09-01', second: 'shared' });
      expect(result.chip).toEqual({ count: 1, of: 1 });
    });

    it('P18.3-T2 AC-2 an event listed but gone by the time its attendance is read draws nobody in it', async () => {
      const listed = event({ id: '66f00000000000000000e001' });
      const stub = new EventsComplianceCategory({
        eventsBetween: async () => [listed],
        attendanceOfMany: async () => new Map(),
      } as never);
      const result = await stub.read(scopeOf(office.as('OWNER'), [office.id.RINA]), { selected: true, item: null });
      expect(result).toEqual({
        catalog: [expect.objectContaining({ id: listed.id })], chip: { count: 0, of: 0 }, item: listed.id,
        cells: new Map([[office.id.RINA, { status: null, done: null, on: null, second: null }]]),
      });
    });
  });

  it('P18.3-T2 AC-2 refuses to read without an office', async () => {
    await expect(read(scopeOf(RequestContext.platform('root'), []))).rejects.toThrow();
    expect(KPM_B).not.toBe(KPM_A);
  });

  /*
   * **Round 2** (the exit review's parity check): every event not started yet is listed, whatever its year — members
   * RSVP before it starts, so the Owner sees it from then. Read in mid-November, with one in January.
   */
  describe('round 2 — an upcoming event next year, read in mid-November', () => {
    const NOVEMBER = new Date('2026-11-16T03:00:00Z');
    let january: string;

    beforeAll(async () => {
      const o = office.as('OWNER');
      const make = (code: string, startsAt: string, endsAt: string) => wired.events.create(o, {
        code, typeCode: 'TRAINING', title: code.replace(/_/g, ' '), startsAt, endsAt, audience: { issuer: 'kpm', scope: 'all_agents' },
      });
      january = (await make('JAN_KICKOFF', '2027-01-11T02:00:00Z', '2027-01-11T05:00:00Z')).id;
      const archived = await make('ARCHIVED_JAN', '2027-01-20T02:00:00Z', '2027-01-20T05:00:00Z');
      await wired.events.archive(o, archived.id);
      (wired.clock as FixedClock).set(NOVEMBER);
      await wired.eventGuests.rsvp(office.as('DODI'), january);
    }, 60_000);
    afterAll(() => (wired.clock as FixedClock).set(ROSTER_NOW));

    const november = () => scopeOf(office.as('OWNER'), ACTIVE.map((w) => office.id[w]));

    it('round 2 lists next January’s event under Upcoming, first; last year’s past event and an archived upcoming one never', async () => {
      const result = await read(november());
      expect(result.catalog.map((e) => e.id)).toEqual([
        january, idOf('UPCOMING'), idOf('RUNNING_LEADERS'), idOf('ENDS_NOW'), idOf('PAST_ALL'), idOf('PAST_CHOSEN'), idOf('PAST_LEADERS'),
      ]);
      expect(result.catalog[0]).toMatchObject({ title: 'JAN KICKOFF', phase: 'upcoming', startsOn: '2027-01-11' });
      expect(result.item).toBe(january);
      const lastYear = (await wired.events.list(office.as('OWNER'))).find((e) => e.code === 'LAST_YEAR')!.id;
      await expect(read(november(), lastYear)).rejects.toMatchObject({ status: 404 });
      const archived = (await wired.events.list(office.as('OWNER'), true)).find((e) => e.code === 'ARCHIVED_JAN')!.id;
      await expect(read(november(), archived)).rejects.toMatchObject({ status: 404 });
    });

    it('round 2 its rows and the chip follow: Dodi registered for it counts', async () => {
      const result = await read(november(), january);
      expect(result.cells!.get(office.id.DODI)).toEqual({ status: 'registered', done: true, on: '2027-01-11', second: null });
      expect(result.cells!.get(office.id.LATE)).toMatchObject({ status: 'not_registered', done: false });
      // Rina and Budi attended 24 August's; Dodi is registered for January's. Tari's September RSVP awaits confirmation.
      expect(result.chip).toEqual({ count: 3, of: ACTIVE.length });
    });
  });
});
