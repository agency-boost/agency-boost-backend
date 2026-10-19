import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { GuestEvent } from '@/modules/events/event-guest.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo, type SeedResult } from '../demo';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's membership in an office — the live one unless `removed` — as a signed-in context. */
async function as(
  code: string, email: string, flags: { owner?: boolean; admin?: boolean; removed?: boolean } = {},
): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({
    kpmId: String(kpm!._id), userId: String(account!._id), status: flags.removed ? 'removed' : 'active',
  }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false, directCount: 0,
  } as never);
}

/** The card's foot pill, as the screen derives it from the reader's own part (`Overall.html:8514-8524`). */
function pill(event: GuestEvent): string {
  if (!event.ended) return event.me.rsvp === 'going' ? 'Going' : 'Not joined';
  if (event.me.feedback) return 'Feedback sent';
  return event.me.rsvp === 'going' || event.me.claimed ? 'Feedback pending' : "Didn't join";
}

/**
 * **Phase 18.5 — events, seeded** (P18.5-T5 AC-11, P18.5-T6 AC-8; `events-fixture.ts`, whose header says which account
 * shows what). The seed run as the command runs it, at 10:00 on Saturday 10 October 2026 in Jakarta, then read back
 * through the events module's own services — what is asserted is what each account sees on a fresh seed — and run a
 * second time to prove it writes nothing.
 */
describe('Phase 18.5 the events seed — a run at 10:00 on 10 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;
  const list = async (email: string, flags: { removed?: boolean } = {}) =>
    (await wired.eventGuests.list(await as('0417', email, flags))).events;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.5-T5 AC-11 writes four events, eighteen member rows and twelve answers in 0417, nothing elsewhere', async () => {
    const kpm0417 = String((await col('kpms').findOne({ code: '0417' }))!._id);
    expect(Object.keys(seeded.events.events).sort()).toEqual([
      'KICKOFF', 'LEADERS_HUDDLE', 'NEW_AGENT_BOOTCAMP', 'PRODUCT_REFRESH', 'PRULINK_BRIEFING', 'SALES_CLINIC', 'TOWN_HALL',
    ]);
    expect(await col('events').countDocuments({ kpmId: kpm0417 })).toBe(7);
    expect(await col('eventRsvps').countDocuments({ kpmId: kpm0417 })).toBe(18);
    expect(await col('eventFeedback').countDocuments({ kpmId: kpm0417 })).toBe(12);
    expect(await col('eventRsvps').countDocuments({ kpmId: { $ne: kpm0417 } })).toBe(0);
    expect(await col('eventFeedback').countDocuments({ kpmId: { $ne: kpm0417 } })).toBe(0);
    expect(seeded.events.written).toBe(4 + 18 + 12);
    expect((await col('events').findOne({ _id: new mongoose.Types.ObjectId(seeded.events.events.TOWN_HALL) }))!.title)
      .toBe('September Town Hall');
  });

  it('P18.5-T5 AC-11 Rina’s /events shows all five card states, and no Leaders’ huddle', async () => {
    const events = await list('rina@kpm0417.test');
    expect(events.map((e) => [e.title, pill(e)])).toEqual([
      ['New Agent Bootcamp', 'Feedback sent'],
      ['September Town Hall', "Didn't join"],
      ['PRULink briefing', 'Feedback pending'],
      ['Sales clinic', "Didn't join"],
      ['Product refresh briefing', 'Going'],
      ['Kickoff 2026', 'Not joined'],
    ]);
    expect(events[0].me.feedback).toMatchObject({ score: 9, why: 'Clear and practical — I left with a plan for my first 30 days.' });
  });

  it('P18.5-T5 AC-11 every seeded event starts at a plausible hour of the office’s day; only the huddle is the run’s', async () => {
    const start = async (code: string) => ((await col('events').findOne({ _id: new mongoose.Types.ObjectId(seeded.events.events[code]) }))!
      .startsAt as Date).toISOString();
    expect({
      KICKOFF: await start('KICKOFF'), PRULINK_BRIEFING: await start('PRULINK_BRIEFING'),
      PRODUCT_REFRESH: await start('PRODUCT_REFRESH'), TOWN_HALL: await start('TOWN_HALL'),
      NEW_AGENT_BOOTCAMP: await start('NEW_AGENT_BOOTCAMP'), SALES_CLINIC: await start('SALES_CLINIC'),
    }).toEqual({
      KICKOFF: '2026-10-24T02:00:00.000Z', // 09:00 in Jakarta, in fourteen days
      PRULINK_BRIEFING: '2026-09-19T03:00:00.000Z', // 10:00, three weeks ago
      PRODUCT_REFRESH: '2026-10-15T07:00:00.000Z', // 14:00
      TOWN_HALL: '2026-09-05T08:00:00.000Z', // 15:00
      NEW_AGENT_BOOTCAMP: '2026-08-21T01:00:00.000Z', // 08:00
      SALES_CLINIC: '2026-09-30T06:00:00.000Z', // 13:00
    });
    const raw = await col('eventRsvps').findOne({});
    expect(raw).not.toHaveProperty('version');
    expect(await col('eventFeedback').findOne({})).not.toHaveProperty('version');
  });

  it('P18.5-T5 AC-11 the Leaders’ huddle is running at the run, from an hour before it to six hours after', async () => {
    const huddle = (await col('events').findOne({ _id: new mongoose.Types.ObjectId(seeded.events.events.LEADERS_HUDDLE) }))!;
    expect([huddle.startsAt.toISOString(), huddle.endsAt.toISOString()]).toEqual(['2026-10-10T02:00:00.000Z', '2026-10-10T09:00:00.000Z']);
    // Still running three hours into the walk.
    const later = configModule(new Date('2026-10-10T06:00:00Z'));
    const agus = await as('0417', 'agus@kpm0417.test');
    expect((await later.eventGuests.list(agus)).events.find((e) => e.code === 'LEADERS_HUDDLE')).toMatchObject({ phase: 'running', ended: false });
  });

  it('P18.5-T5 AC-11 Budi’s cancelled RSVP; Agus and Sari going to the huddle; Dewi, who leads nobody, does not see it', async () => {
    expect((await list('budi@kpm0417.test')).find((e) => e.code === 'PRODUCT_REFRESH')!.me.rsvp).toBe('cancelled');
    for (const email of ['agus@kpm0417.test', 'sari@kpm0417.test']) {
      const huddle = (await list(email)).find((e) => e.code === 'LEADERS_HUDDLE');
      expect([email, huddle?.phase, huddle?.me.rsvp]).toEqual([email, 'running', 'going']);
    }
    expect((await list('dewi@kpm0417.test')).map((e) => e.code)).not.toContain('LEADERS_HUDDLE');
  });

  it('P18.5-T5 AC-11 Yanti’s current membership does not see the Bootcamp; her first membership’s answer stays with it', async () => {
    expect((await list('removed@kpm0417.test')).map((e) => e.code)).not.toContain('NEW_AGENT_BOOTCAMP');
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const first = await as('0417', 'removed@kpm0417.test', { removed: true });
    const summary = await wired.eventRollCalls.feedbackSummary(owner, seeded.events.events.NEW_AGENT_BOOTCAMP);
    expect(summary.rows.map((r) => [r.membershipId === first.membershipId, r.score, r.attendance])).toEqual([
      [false, 9, 'unconfirmed'], [true, 8, 'confirmed'],
    ]);
  });

  it('P18.5-T6 AC-8 the Town Hall reads NPS 0 · 8 responses, as drawn; the Owner’s own row is the Admin’s to confirm', async () => {
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const admin = await as('0417', 'admin@kpm0417.test', { admin: true });
    const summary = await wired.eventRollCalls.feedbackSummary(owner, seeded.events.events.TOWN_HALL);
    expect(summary).toMatchObject({ nps: 0, counted: 8, responses: 8, awaitingConfirmation: 0, promoters: 3, passives: 2, detractors: 3 });
    expect(summary.rows[0]).toMatchObject({
      name: 'Wilson Tanoto', score: 10, why: 'Great energy — the recognition segment really landed.',
      improve: 'Keep leaning into recognition moments — repeat this format.',
    });
    const asOwner = await wired.eventRollCalls.rollCall(owner, seeded.events.events.TOWN_HALL);
    const ownRow = asOwner.people.find((p) => p.membershipId === owner.membershipId)!;
    expect(ownRow).toMatchObject({ self: true, attended: true, confirmedBy: 'Maya Halim' });
    const asAdmin = await wired.eventRollCalls.rollCall(admin, seeded.events.events.TOWN_HALL);
    expect(asAdmin.people.find((p) => p.membershipId === owner.membershipId)!.self).toBe(false);
    expect(asOwner.people.find((p) => p.name === 'Rina Wijaya')).toMatchObject({ said: null, status: 'not_registered' });
  });

  it('P18.5-T6 AC-8 PRULink: one confirmed answer, one awaiting, one absent; Sales clinic empty', async () => {
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const prulink = await wired.eventRollCalls.feedbackSummary(owner, seeded.events.events.PRULINK_BRIEFING);
    expect(prulink).toMatchObject({ nps: 100, counted: 1, responses: 2, awaitingConfirmation: 1 });
    const call = await wired.eventRollCalls.rollCall(owner, seeded.events.events.PRULINK_BRIEFING);
    const by = (name: string) => call.people.find((p) => p.name === name)!;
    expect([by('Rina Wijaya').status, by('Budi Santoso').status, by('Indah Permatasari').status, by('Dimas Pratama').status, by('Siti Rahmawati').status])
      .toEqual(['unconfirmed', 'attended', 'unconfirmed', 'no_show', 'not_registered']);
    expect(by('Indah Permatasari').said).toBe('claimed');
    const clinic = await wired.eventRollCalls.feedbackSummary(owner, seeded.events.events.SALES_CLINIC);
    expect(clinic).toMatchObject({ nps: null, counted: 0, responses: 0, rows: [] });
    const clinicCall = await wired.eventRollCalls.rollCall(owner, seeded.events.events.SALES_CLINIC);
    expect(clinicCall.counts).toMatchObject({ attended: 0, unconfirmed: 0, noShow: 0 });
    expect(clinicCall.attendanceRate).toBe(0);
  });

  it('P18.5-T5 AC-11 0555’s agent sees only 0555’s events — not its leaders’ huddle — and nobody there has answered', async () => {
    const lina = await as('0555', 'agent@kpm0555.test');
    const events = (await wired.eventGuests.list(lina)).events;
    expect(events.map((e) => e.code).sort()).toEqual(['KICKOFF', 'PRULINK_BRIEFING']);
    expect(events.every((e) => e.me.rsvp === null && e.me.feedback === null)).toBe(true);
  });

  it('P18.5-T5 AC-11 a second run writes nothing', async () => {
    const again = await seedDemo({ clock, log: quiet });
    expect(again.events.written).toBe(0);
    expect(again.written.eventRsvps ?? 0).toBe(0);
    expect(again.written.eventFeedback ?? 0).toBe(0);
    expect(again.written.events ?? 0).toBe(0);
  }, RUN_MS);

  it('P18.5-T5 AC-11 a re-run in another month writes no event and prints the Town Hall’s stored title', async () => {
    const printed: string[] = [];
    const later = await seedDemo({ clock: new FixedClock(new Date('2026-11-20T03:00:00Z')), log: (text) => printed.push(text) });
    expect(later.events.written).toBe(0);
    expect(later.events.guide).toContain('September Town Hall');
    expect(printed.join('\n')).toContain('September Town Hall');
    expect(later.events.guide).not.toContain('October Town Hall');
  }, RUN_MS);
});
