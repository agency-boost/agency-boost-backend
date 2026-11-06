import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

/** 10:00 on 14 September in Jakarta. */
const NOW = new Date('2026-09-14T03:00:00Z');
const BIG = '66f0000000000000000000a1';
const SMALL = '66f0000000000000000000a2';
const COMPANY = '66f0000000000000000000c1';
const H = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * H).toISOString();

interface Office {
  kpmId: string;
  owner: RequestContext;
  agent: RequestContext;
  /** The event the Owner's *View feedback* is measured on: the past, office-wide one with the most answers. */
  biggest: string;
}

/**
 * **Events at the 500-member ceiling** (P18.2-T11 AC-3; `performance-and-scale.md`): a member's `GET /events` and the
 * Owner's *View feedback* reads — the roll call and the *Feedback Summary* — over an office of 501 (one AB, ten AABs,
 * forty-nine agents each) and an office of 51 beside it, each with a dozen events of every audience kind — office-wide,
 * leaders only, chosen people and chosen leaders; upcoming, running and past — and, on the past ones, RSVPs, claims,
 * confirmations and answers. **The same queries for fifty as for five hundred: none per member, none per event.**
 */
describe('events, measured (P18.2-T11 AC-3)', () => {
  let wired: ReturnType<typeof configModule>;
  const offices: Record<'big' | 'small', Office> = {} as never;

  const context = (kpmId: string, membershipId: string, rung: 'AB' | 'AAB' | 'AGENT', owner = false) =>
    new RequestContext(`u-${membershipId}`, 'none', {
      membershipId, kpmId, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(), status: 'active',
      isKpmOwner: owner, isKpmAdmin: false, directCount: rung === 'AGENT' ? 0 : 10,
    } as never);

  const build = async (kpmId: string, code: string, units: number, perUnit: number): Promise<Office> => {
    const db = mongoose.connection.db!;
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create(
      { _id: kpmId, companyId: COMPANY, code, branchName: code, timezone: 'Asia/Jakarta' },
    );
    await provisionOffice(wired, kpmId, COMPANY);

    const members: Record<string, unknown>[] = [];
    const users: Record<string, unknown>[] = [];
    const edges: Record<string, unknown>[] = [];
    const joined = new Date('2026-01-02T02:00:00Z');
    let seq = 0;
    const place = (role: 'ab' | 'aab' | 'agent', leader: string | null, ancestors: string[]) => {
      seq += 1;
      const id = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();
      users.push({ _id: userId, email: `${code}-${seq}@events.test`, passwordHash: 'x', fullName: `${code} Person ${seq}`, status: 'active', platformRole: 'none', deletedAt: null });
      members.push({
        _id: id, kpmId, userId: String(userId), agentCode: `${code}-${seq}`, agentSeq: seq, leaderCode: `${code}${seq}`,
        orgLevelId: 'x', orgLevelCode: role.toUpperCase(), role, leaderId: leader, ancestorIds: ancestors,
        depth: ancestors.length, directCounts: { total: 0 }, status: 'active', joinedAt: joined, removedAt: null, deletedAt: null,
      });
      // Written from the first day, as the org module writes it (invariant §5): the leaders' audience reads these.
      edges.push({ kpmId, membershipId: String(id), eventType: 'joined', toLeaderId: leader, validFrom: joined, validTo: null, deletedAt: null });
      return String(id);
    };
    const ab = place('ab', null, []);
    const aabs: string[] = [];
    const agents: string[] = [];
    for (let u = 0; u < units; u += 1) {
      const aab = place('aab', ab, [ab]);
      aabs.push(aab);
      for (let a = 0; a < perUnit; a += 1) agents.push(place('agent', aab, [ab, aab]));
    }
    await db.collection('users').insertMany(users);
    await db.collection('memberships').insertMany(members);
    await db.collection('membershipHistory').insertMany(edges);
    const everyone = [ab, ...aabs, ...agents];

    // A dozen events of every audience kind; the chosen lists are twenty agents and every AAB.
    const owner = context(kpmId, ab, 'AB', true);
    const make = async (eventCode: string, startsAt: string, endsAt: string, scope: string, invitees: string[] = []) =>
      (await wired.events.create(owner, {
        code: eventCode, typeCode: 'TRAINING', title: eventCode, startsAt, endsAt,
        audience: { issuer: 'kpm', scope, inviteeMembershipIds: invitees },
      })).id;
    const chosen = agents.slice(0, 20);
    const ids = {
      UP_ALL: await make('UP_ALL', at(5 * 24), at(5 * 24 + 2), 'all_agents'),
      UP_LEADERS: await make('UP_LEADERS', at(7 * 24), at(7 * 24 + 2), 'leaders'),
      UP_CHOSEN: await make('UP_CHOSEN', at(9 * 24), at(9 * 24 + 2), 'select_agents', chosen),
      RUN_ALL: await make('RUN_ALL', at(-1), at(3), 'all_agents'),
      RUN_LEADERS: await make('RUN_LEADERS', at(-2), at(2), 'leaders'),
      PAST_ALL_1: await make('PAST_ALL_1', at(-7 * 24), at(-7 * 24 + 3), 'all_agents'),
      PAST_ALL_2: await make('PAST_ALL_2', at(-14 * 24), at(-14 * 24 + 3), 'all_agents'),
      PAST_ALL_3: await make('PAST_ALL_3', at(-21 * 24), at(-21 * 24 + 3), 'all_agents'),
      PAST_ALL_4: await make('PAST_ALL_4', at(-28 * 24), at(-28 * 24 + 3), 'all_agents'),
      PAST_LEADERS: await make('PAST_LEADERS', at(-10 * 24), at(-10 * 24 + 2), 'leaders'),
      PAST_CHOSEN: await make('PAST_CHOSEN', at(-12 * 24), at(-12 * 24 + 4), 'select_agents', chosen),
      PAST_CHOSEN_LEADERS: await make('PAST_CHOSEN_LEADERS', at(-16 * 24), at(-16 * 24 + 2), 'select_leaders', aabs),
    };

    // The members' rows: on each past event, of its audience, half RSVP'd, a tenth said they came, two thirds of
    // those confirmed (one in five of them absent), and a third answered across the scale.
    const rsvps: Record<string, unknown>[] = [];
    const answers: Record<string, unknown>[] = [];
    const audienceOf = (key: string) => (key.includes('CHOSEN_LEADERS') ? aabs : key.includes('CHOSEN') ? chosen
      : key.includes('LEADERS') ? [ab, ...aabs] : everyone);
    for (const key of ['PAST_ALL_1', 'PAST_ALL_2', 'PAST_ALL_3', 'PAST_ALL_4', 'PAST_LEADERS', 'PAST_CHOSEN', 'PAST_CHOSEN_LEADERS'] as const) {
      audienceOf(key).forEach((membershipId, i) => {
        const going = i % 2 === 0;
        const claimed = i % 10 === 1;
        if (!going && !claimed) return;
        const confirmed = i % 3 !== 2;
        rsvps.push({
          kpmId, eventId: ids[key], membershipId, rsvpStatus: going ? 'going' : null, rsvpAt: going ? NOW : null, cancelledAt: null,
          claimedAt: claimed ? NOW : null, confirmedAttended: confirmed ? i % 5 !== 0 : null,
          confirmedByMembershipId: confirmed && membershipId !== ab ? ab : null, confirmedAt: confirmed ? NOW : null, deletedAt: null,
        });
        if (i % 3 === 0) {
          answers.push({
            kpmId, eventId: ids[key], membershipId, score: i % 11, why: 'Why', improve: i % 2 ? 'Improve' : '', submittedAt: NOW, deletedAt: null,
          });
        }
      });
    }
    await db.collection('eventRsvps').insertMany(rsvps);
    await db.collection('eventFeedback').insertMany(answers);
    return { kpmId, owner, agent: context(kpmId, agents[agents.length - 1], 'AGENT'), biggest: ids.PAST_ALL_1 };
  };

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await mongoose.connection.db!.collection('companies').insertOne({
      _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'prudential-events-perf', deletedAt: null,
    });
    offices.big = await build(BIG, '0417', 10, 49);
    offices.small = await build(SMALL, '0418', 1, 49);
    // Nothing in flight when a read is captured: the query log is the connection's, so a model's automatic index build
    // still running would land in one office's capture and not the other's (the scorecard spec's note).
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    await Promise.all(['Membership', 'MembershipHistory', 'Event', 'EventType', 'EventRsvp', 'EventFeedback', 'User']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
  }, 240_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  const counted = async <T>(run: () => Promise<T>): Promise<{ result: T; queries: string[] }> => {
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    try {
      return { result: await run(), queries };
    } finally {
      mongoose.set('debug', false);
    }
  };

  /** The p95 of twenty runs, after one to warm. */
  const p95 = async (run: () => Promise<unknown>): Promise<number> => {
    await run();
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await run();
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.ceil(0.95 * times.length) - 1];
  };

  it('P18.2-T11 AC-3 a member’s GET /events reads 501 people and a dozen events in the same queries as 51', async () => {
    const small = await counted(() => wired.eventGuests.list(offices.small.agent));
    const large = await counted(() => wired.eventGuests.list(offices.big.agent));
    // The agent's audience: the office-wide five, the four past ones among them, nothing for leaders or the chosen.
    expect(large.result.events.map((e) => e.code).sort()).toEqual(small.result.events.map((e) => e.code).sort());
    expect(large.result.events.map((e) => e.code)).toEqual(['PAST_ALL_4', 'PAST_ALL_3', 'PAST_ALL_2', 'PAST_ALL_1', 'RUN_ALL', 'UP_ALL']);
    expect(large.queries.sort()).toEqual(small.queries.sort());
    // eslint-disable-next-line no-console
    console.log(`  GET /events: ${large.queries.length} queries — ${large.queries.join(', ')}`);
    expect(large.queries.length).toBeLessThanOrEqual(10);
  }, 60_000);

  it('P18.2-T11 AC-3 a leader’s list, with the leaders’ edges read, is the same fixed shape at both sizes', async () => {
    const leader = (o: Office) => context(o.kpmId, String(o.owner.membershipId), 'AB', false);
    const small = await counted(() => wired.eventGuests.list(leader(offices.small)));
    const large = await counted(() => wired.eventGuests.list(leader(offices.big)));
    expect(large.result.events.map((e) => e.code)).toContain('PAST_LEADERS');
    expect(large.queries.sort()).toEqual(small.queries.sort());
    expect(large.queries.length).toBeLessThanOrEqual(10);
  }, 60_000);

  it('P18.2-T11 AC-3 the Owner’s View feedback — the roll call and the Feedback Summary — is a fixed number of queries', async () => {
    const callSmall = await counted(() => wired.eventRollCalls.rollCall(offices.small.owner, offices.small.biggest));
    const callLarge = await counted(() => wired.eventRollCalls.rollCall(offices.big.owner, offices.big.biggest));
    expect(callLarge.result.people).toHaveLength(501);
    expect(callSmall.result.people).toHaveLength(51);
    expect(callLarge.queries.sort()).toEqual(callSmall.queries.sort());
    const sumSmall = await counted(() => wired.eventRollCalls.feedbackSummary(offices.small.owner, offices.small.biggest));
    const sumLarge = await counted(() => wired.eventRollCalls.feedbackSummary(offices.big.owner, offices.big.biggest));
    // Answers from every third member who RSVP'd (i ≡ 0 mod 6: 84) or said they came (i ≡ 21 mod 30: 16).
    expect(sumLarge.result.responses).toBe(100);
    expect(sumLarge.queries.sort()).toEqual(sumSmall.queries.sort());
    // eslint-disable-next-line no-console
    console.log(`  roll call: ${callLarge.queries.length} queries; Feedback Summary: ${sumLarge.queries.length} queries`);
    expect(callLarge.queries.length).toBeLessThanOrEqual(10);
    expect(sumLarge.queries.length).toBeLessThanOrEqual(10);
  }, 60_000);

  it('P18.3-T1 AC-3 attendanceOfMany reads a dozen events over 501 people in the same queries as over 51', async () => {
    const all = async (o: Office) => (await wired.events.list(o.owner, false)).map((e: { id: string }) => e.id);
    const idsSmall = await all(offices.small);
    const idsBig = await all(offices.big);
    const small = await counted(() => wired.eventReadings.attendanceOfMany(offices.small.owner, idsSmall));
    const large = await counted(() => wired.eventReadings.attendanceOfMany(offices.big.owner, idsBig));
    expect(large.result.size).toBe(12);
    expect(small.result.size).toBe(12);
    expect(large.result.get(offices.big.biggest)!.rows).toHaveLength(501);
    expect(large.queries.sort()).toEqual(small.queries.sort());
    // eslint-disable-next-line no-console
    console.log(`  attendanceOfMany, 12 events: ${large.queries.length} queries — ${large.queries.join(', ')}`);
    // The events, the office's zone, the people, the leader edges (two started *Leaders* events), the RSVPs, the answers.
    expect(large.queries.length).toBeLessThanOrEqual(6);
    const time = await p95(() => wired.eventReadings.attendanceOfMany(offices.big.owner, idsBig));
    // eslint-disable-next-line no-console
    console.log(`  attendanceOfMany p95 of 20 at 501 people, 12 events: ${time.toFixed(1)} ms`);
    expect(time).toBeLessThan(2000);
  }, 120_000);

  it('P18.2-T11 AC-3 records the ceiling’s cost', async () => {
    const list = await p95(() => wired.eventGuests.list(offices.big.agent));
    const call = await p95(() => wired.eventRollCalls.rollCall(offices.big.owner, offices.big.biggest));
    const summary = await p95(() => wired.eventRollCalls.feedbackSummary(offices.big.owner, offices.big.biggest));
    // eslint-disable-next-line no-console
    console.log(`  events p95 of 20 at 501 people: GET /events ${list.toFixed(1)} ms; roll call ${call.toFixed(1)} ms; Feedback Summary ${summary.toFixed(1)} ms`);
    // Recorded, not budgeted here; the bounds catch a read gone per-member.
    expect(list).toBeLessThan(2000);
    expect(call).toBeLessThan(2000);
    expect(summary).toBeLessThan(2000);
  }, 120_000);
});
