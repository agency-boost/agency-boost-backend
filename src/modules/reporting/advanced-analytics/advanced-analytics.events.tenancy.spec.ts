import mongoose from 'mongoose';
import { DomainException } from '@/common/errors/domain.exception';
import { ROSTER_NOW } from '../../../../test/coaching-office';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { configModule } from '../../../../test/config-module';
import { buildEventsOffice, KPM_A, type EventKey, type EventsOffice, type EventsWho } from '../../../../test/events-office';

/**
 * ***Event* — the events' NPS on the *Advanced analytics* page** (P19.5-T3 AC-3; ADR-0215 §4; OD-256; OWN Case 7), on the
 * events office (`test/events-office.ts`): August's *PAST_ALL* and *PAST_LEADERS*, answers from confirmed attendees, an
 * unconfirmed one and an absent one. Standard NPS over the confirmed answers, its average and count, the KPM's figure for
 * the period beside them, the AB filter, and nobody named.
 */
describe('P19.5-T3 AC-3 the events’ NPS, on real rows', () => {
  let wired: ReturnType<typeof configModule>;
  let office: EventsOffice;
  const db = () => mongoose.connection.db!;
  const idOf = (key: EventKey) => office.event[key].id;
  const rsvp = (key: EventKey, who: EventsWho, attended: boolean | null) => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], rsvpStatus: 'going', rsvpAt: new Date('2026-08-01T02:00:00Z'),
    cancelledAt: null, claimedAt: null, confirmedAttended: attended, confirmedByMembershipId: attended === null ? null : office.id.ADMIN,
    confirmedAt: attended === null ? null : ROSTER_NOW, deletedAt: null,
  });
  const answer = (key: EventKey, who: EventsWho, score: number) => ({
    kpmId: KPM_A, eventId: idOf(key), membershipId: office.id[who], score, why: `${who} why`, improve: '',
    submittedAt: new Date('2026-08-25T02:00:00Z'), deletedAt: null,
  });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildEventsOffice(wired);
    await db().collection('eventRsvps').insertMany([
      rsvp('PAST_ALL', 'RINA', true), rsvp('PAST_ALL', 'BUDI', true), rsvp('PAST_ALL', 'PEER_AGENT', true),
      rsvp('PAST_ALL', 'INDAH', null), rsvp('PAST_ALL', 'DIMAS', false),
      rsvp('PAST_LEADERS', 'SARI', true),
    ]);
    await db().collection('eventFeedback').insertMany([
      answer('PAST_ALL', 'RINA', 10), answer('PAST_ALL', 'BUDI', 6), answer('PAST_ALL', 'PEER_AGENT', 9),
      // Not counted: awaiting confirmation, and marked absent (OD-31).
      answer('PAST_ALL', 'INDAH', 0), answer('PAST_ALL', 'DIMAS', 0),
      answer('PAST_LEADERS', 'SARI', 8),
    ]);
  }, 120_000);
  afterAll(stopMongo);

  it('P19.5-T3 AC-3 OWN Case 7 each event with feedback: its NPS over confirmed attendees, average and n; the KPM’s beside them', async () => {
    const view = await wired.advancedAnalytics.eventsNps(office.as('OWNER'), {});
    expect(view.period).toEqual({ kind: 'ytd', from: '2026-01-01', to: '2026-09-14' });
    const byTitle = Object.fromEntries(view.events.map((e) => [e.title, e]));
    expect(byTitle['PAST ALL']).toMatchObject({ nps: 33, average: 8.3, n: 3 });
    expect(byTitle['PAST LEADERS']).toMatchObject({ nps: 0, average: 8, n: 1 });
    expect(Object.keys(byTitle)).toHaveLength(2);
    // Pooled: 10, 6, 9, 8 → two promoters, one detractor, of four.
    expect(view.kpm).toEqual({ nps: 25, average: 8.3, n: 4 });
  });

  it('P19.5-T3 AC-3 the AB filter keeps the answers of that AB’s Group', async () => {
    const agus = await wired.advancedAnalytics.eventsNps(office.as('OWNER'), { ab: office.id.AGUS });
    expect(agus.kpm).toMatchObject({ n: 3 });
    const hendra = await wired.advancedAnalytics.eventsNps(office.as('OWNER'), { ab: office.id.PEER_AB });
    expect(hendra.kpm).toEqual({ nps: 100, average: 9, n: 1 });
  });

  it('P19.5-T3 AC-3 a month narrows the period; no respondent is named anywhere in the answer', async () => {
    const august = await wired.advancedAnalytics.eventsNps(office.as('OWNER'), { month: '2026-08' });
    expect(august.period).toEqual({ kind: 'month', from: '2026-08-01', to: '2026-08-31' });
    expect(august.kpm.n).toBe(4);
    const july = await wired.advancedAnalytics.eventsNps(office.as('OWNER'), { month: '2026-07' });
    expect(july).toMatchObject({ kpm: { nps: null, average: null, n: 0 }, events: [] });
    const wire = JSON.stringify(august);
    for (const who of ['RINA', 'BUDI', 'PEER_AGENT', 'INDAH', 'SARI'] as const) {
      expect([who, wire.includes(office.id[who]) || wire.includes(`${who} why`)]).toEqual([who, false]);
    }
  });

  it('P19.5-T3 AC-3 this month runs from its first day to today, and August’s answers are not in it', async () => {
    const september = await wired.advancedAnalytics.eventsNps(office.as('OWNER'), { month: '2026-09' });
    expect(september.period).toEqual({ kind: 'month', from: '2026-09-01', to: '2026-09-14' });
    expect(september.events.map((e) => e.title)).not.toContain('PAST ALL');
  });

  it('P19.5-T3 AC-13 cross-tenant: KPM B reads none of KPM A’s answers, and KPM A’s AB is 404 there', async () => {
    const b = await wired.advancedAnalytics.eventsNps(office.as('B_OWNER'), {});
    expect(b.kpm.n).toBe(0);
    try {
      await wired.advancedAnalytics.eventsNps(office.as('B_OWNER'), { ab: office.id.AGUS });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as DomainException).getStatus()).toBe(404);
    }
  });
});
