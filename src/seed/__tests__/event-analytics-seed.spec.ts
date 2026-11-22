import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { DECLINE_REASONS, seedEventAnalyticsFixture } from '../event-analytics-fixture';

/**
 * **The Event tab's demo data** (P19.25-T1, T2; the phase file's *Seed*): 15+ past events need their roll call and answers,
 * and the planned ones their invitation's answers — on a small office of its own, so the fixture's rules are read
 * directly: every real member in each past event they were a member for, test accounts nowhere, a few answers on two
 * events, declines with reasons, and a re-run that writes nothing.
 */
describe('P19.25 the Event tab’s seed (event-analytics-fixture)', () => {
  const NOW = new Date('2026-11-20T03:00:00Z');
  const KPM = '66f00000000000000000e0a1';
  const db = () => mongoose.connection.db!;
  const ids = Array.from({ length: 12 }, () => new mongoose.Types.ObjectId());
  const TEST = new mongoose.Types.ObjectId();
  const LATE = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    const member = (_id: mongoose.Types.ObjectId, over: Record<string, unknown> = {}) => ({
      _id, kpmId: KPM, status: 'active', deletedAt: null, agentSeq: 1, joinedAt: new Date('2025-06-01T00:00:00Z'), ...over,
    });
    await db().collection('memberships').insertMany([
      ...ids.map((id) => member(id)),
      member(TEST, { testAccount: true }),
      member(LATE, { joinedAt: new Date('2026-10-01T00:00:00Z') }),
    ]);
  }, 120_000);
  afterAll(stopMongo);

  it('writes twelve past events with every real member’s roll call, and two planned ones', async () => {
    const run = await seedEventAnalyticsFixture({ clock: new FixedClock(NOW), kpmId: KPM, ownerId: String(ids[0]), adminId: String(ids[1]) });
    expect(run.written).toBeGreaterThan(14);
    const events = await db().collection('events').find({ kpmId: KPM }).toArray();
    const past = events.filter((e) => (e.endsAt as Date) <= NOW);
    expect(past).toHaveLength(12);
    expect(events.filter((e) => (e.startsAt as Date) > NOW)).toHaveLength(2);
    for (const e of past) {
      const rows = await db().collection('eventRsvps').find({ kpmId: KPM, eventId: String(e._id) }).toArray();
      // Every real member who was one then, each marked one way or the other; LATE joined after; the test account never.
      expect([e.title, rows.length]).toEqual([e.title, 12]);
      expect(rows.every((r) => r.confirmedAttended === true || r.confirmedAttended === false)).toBe(true);
      expect(rows.some((r) => r.membershipId === String(TEST))).toBe(false);
      // Nobody confirms their own: the Admin confirms the Owner.
      const owner = rows.find((r) => r.membershipId === String(ids[0]))!;
      expect(owner.confirmedByMembershipId).toBe(String(ids[1]));
    }
  });

  it('Recruitment Day and Briefing PRUWell draw only a few answers; every answer is from somebody hadir', async () => {
    const titled = async (title: string) => {
      const e = await db().collection('events').findOne({ kpmId: KPM, title });
      return db().collection('eventFeedback').countDocuments({ kpmId: KPM, eventId: String(e!._id) });
    };
    expect(await titled('Recruitment Day')).toBeLessThanOrEqual(2);
    expect(await titled('Briefing PRUWell')).toBeLessThanOrEqual(1);
    const answers = await db().collection('eventFeedback').find({ kpmId: KPM }).toArray();
    for (const a of answers) {
      const row = await db().collection('eventRsvps').findOne({ kpmId: KPM, eventId: a.eventId, membershipId: a.membershipId });
      expect(row?.confirmedAttended).toBe(true);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(10);
    }
  });

  it('the planned events: going, declines each with a reason, the rest unanswered; the test account never asked', async () => {
    const planned = await db().collection('events').find({ kpmId: KPM, startsAt: { $gt: NOW } }).toArray();
    for (const e of planned) {
      const rows = await db().collection('eventRsvps').find({ kpmId: KPM, eventId: String(e._id) }).toArray();
      const declined = rows.filter((r) => r.rsvpStatus === 'cancelled');
      expect(declined.length).toBeLessThanOrEqual(DECLINE_REASONS.length);
      expect(declined.every((r) => (DECLINE_REASONS as readonly string[]).includes(r.declineReason))).toBe(true);
      expect(rows.some((r) => r.membershipId === String(TEST))).toBe(false);
    }
  });

  it('a re-run writes nothing', async () => {
    const again = await seedEventAnalyticsFixture({ clock: new FixedClock(NOW), kpmId: KPM, ownerId: String(ids[0]), adminId: String(ids[1]) });
    expect(again.written).toBe(0);
  });
});
