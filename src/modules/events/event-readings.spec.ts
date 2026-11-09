import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildEventsOffice, KPM_A, type EventKey, type EventsOffice, type EventsWho } from '../../../test/events-office';
import { ROSTER_NOW } from '../../../test/coaching-office';

/**
 * **`EventReadings.attendanceOfMany`** (P18.3-T1 AC-3, P18.3-T2 AC-2): the roll call's reading for many events at
 * once — what `attendance` answers for each, keyed by event id, in a fixed number of queries. Over the events office
 * (`test/events-office.ts`): 10:00 on Monday 14 September 2026 in Jakarta, an event in every state.
 */
describe('the events port for many events (P18.3-T1 AC-3)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: EventsOffice;
  const db = () => mongoose.connection.db!;
  const idOf = (key: EventKey) => office.event[key].id;
  const owner = () => office.as('OWNER');
  const rsvp = (key: EventKey, who: EventsWho, over: Record<string, unknown> = {}) => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], rsvpStatus: 'going', rsvpAt: new Date('2026-08-01T02:00:00Z'),
    cancelledAt: null, claimedAt: null, confirmedAttended: null, confirmedByMembershipId: null, confirmedAt: null, deletedAt: null,
    ...over,
  });
  const answer = (key: EventKey, who: EventsWho) => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], score: 9, why: 'Good', improve: '',
    submittedAt: new Date('2026-08-25T02:00:00Z'), deletedAt: null,
  });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildEventsOffice(wired);
    // Every model's indexes built before anything is counted: under a loaded run a lazy `createIndex` otherwise
    // lands inside the first count, and the query lists differ by that alone.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    await db().collection('eventRsvps').insertMany([
      rsvp('PAST_ALL', 'RINA', { confirmedAttended: true, confirmedByMembershipId: office.id.ADMIN, confirmedAt: ROSTER_NOW }),
      rsvp('PAST_ALL', 'BUDI'),
      rsvp('PAST_ALL', 'DIMAS', { rsvpStatus: null, rsvpAt: null, claimedAt: new Date('2026-08-24T06:00:00Z') }),
      rsvp('PAST_ALL', 'SARI', { confirmedAttended: false, confirmedByMembershipId: office.id.ADMIN, confirmedAt: ROSTER_NOW }),
      rsvp('PAST_CHOSEN', 'RINA', { confirmedAttended: true, confirmedByMembershipId: office.id.ADMIN, confirmedAt: ROSTER_NOW }),
      rsvp('UPCOMING', 'INDAH'),
    ]);
    await db().collection('eventFeedback').insertMany([answer('PAST_ALL', 'RINA'), answer('PAST_ALL', 'BUDI'), answer('PAST_CHOSEN', 'RINA')]);
  }, 120_000);
  afterAll(stopMongo);

  const EVERY: EventKey[] = ['UPCOMING', 'RUNNING_LEADERS', 'PAST_ALL', 'PAST_CHOSEN', 'PAST_LEADERS', 'ENDS_NOW', 'ARCHIVED'];

  it('P18.3-T1 AC-3 answers, for every event asked, exactly what `attendance` answers for it', async () => {
    const many = await wired.eventReadings.attendanceOfMany(owner(), EVERY.map(idOf));
    expect([...many.keys()].sort()).toEqual(EVERY.map(idOf).sort());
    for (const key of EVERY) {
      expect([key, many.get(idOf(key))]).toEqual([key, await wired.eventReadings.attendance(owner(), idOf(key))]);
    }
  });

  it('P18.3-T1 AC-3 pins the shape: the event, the audience as at the start with each row’s status, the rate, the counts', async () => {
    const reading = (await wired.eventReadings.attendanceOfMany(owner(), [idOf('PAST_ALL')])).get(idOf('PAST_ALL'))!;
    expect(Object.keys(reading).sort()).toEqual(['counts', 'event', 'rate', 'rows']);
    expect(Object.keys(reading.event).sort()).toEqual([
      'audience', 'code', 'ended', 'endsAt', 'id', 'phase', 'startsAt', 'startsOn', 'status', 'title', 'typeCode',
    ]);
    expect(Object.keys(reading.rows[0]).sort()).toEqual([
      'claimed', 'confirmed', 'confirmedAt', 'confirmedByMembershipId', 'gaveFeedback', 'membershipId', 'orgLevelCode',
      'rowId', 'rsvp', 'status',
    ]);
    const row = (who: EventsWho) => reading.rows.find((r) => r.membershipId === office.id[who]);
    expect(row('RINA')).toMatchObject({ status: 'attended', gaveFeedback: true });
    expect(row('BUDI')).toMatchObject({ status: 'unconfirmed', gaveFeedback: true });
    expect(row('DIMAS')).toMatchObject({ status: 'unconfirmed', claimed: true, gaveFeedback: false });
    expect(row('SARI')).toMatchObject({ status: 'no_show' });
    expect(row('AGUS')).toMatchObject({ status: 'not_registered', rowId: null });
    // Joined on 1 September, after the event: not in its audience as at the start.
    expect(row('LATE')).toBeUndefined();
    expect(reading.counts).toMatchObject({ attended: 1, unconfirmed: 2, no_show: 1, audience: reading.rows.length });
  });

  it('P18.3-T1 AC-3 leaves out an event the office does not hold, and an id that is no id — archived ones are answered', async () => {
    const many = await wired.eventReadings.attendanceOfMany(owner(), [idOf('B_PAST'), 'not-an-id', idOf('ARCHIVED'), idOf('ARCHIVED')]);
    expect([...many.keys()]).toEqual([idOf('ARCHIVED')]);
    expect(await wired.eventReadings.attendanceOfMany(owner(), [])).toEqual(new Map());
    expect(await wired.eventReadings.attendance(owner(), 'not-an-id')).toBeNull();
    expect(await wired.eventReadings.attendance(owner(), idOf('B_PAST'))).toBeNull();
  });

  it('round 1 L2: an id typed in upper case is the same event — `attendance` finds it, and the map keys it once, as stored', async () => {
    const id = idOf('PAST_ALL');
    const upper = id.toUpperCase();
    expect(upper).not.toBe(id);
    expect(await wired.eventReadings.attendance(owner(), upper)).toEqual(await wired.eventReadings.attendance(owner(), id));
    expect((await wired.eventReadings.attendance(owner(), upper))!.event.id).toBe(id);
    expect([...(await wired.eventReadings.attendanceOfMany(owner(), [id, upper])).keys()]).toEqual([id]);
  });

  it('P18.3-T1 AC-3 refuses to read without an office, whatever the ids', async () => {
    await expect(wired.eventReadings.attendanceOfMany(RequestContext.platform('root'), ['not-an-id'])).rejects.toThrow();
  });

  it('P18.3-T1 AC-3 reads one event and seven in the same queries: none per event, none per member', async () => {
    const counted = async (ids: string[]) => {
      const queries: string[] = [];
      mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
      try {
        await wired.eventReadings.attendanceOfMany(owner(), ids);
      } finally {
        mongoose.set('debug', false);
      }
      return queries.sort();
    };
    // Both include a started *Leaders* event, so both read the leader edges once.
    const one = await counted([idOf('PAST_LEADERS')]);
    const seven = await counted(EVERY.map(idOf));
    expect(seven).toEqual(one);
    expect(seven.length).toBeLessThanOrEqual(6);
  });
});
