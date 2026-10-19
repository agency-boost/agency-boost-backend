import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

/** 10:00 on Monday 14 September 2026 in Jakarta. */
const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const COMPANY = '66f0000000000000000000c1';

/** The 500-member ceiling (`performance-and-scale.md`): one AB, ten AABs, forty-nine agents under each. */
const UNITS = 10;
const PER_UNIT = 49;
/** Entries each member organises over the six weeks around today, on top of the AB's standups. */
const PER_MEMBER = 12;
const RUNS = 20;
const BUDGET_MS = 300;

const ctxFor = (membershipId: string, rung: 'AB' | 'AAB' | 'AGENT') => new RequestContext(`u-${membershipId}`, 'none', {
  membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: rung === 'AGENT' ? 0 : 1,
} as never);

/** The 95th percentile of a run of timings, in milliseconds. */
async function p95(work: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = process.hrtime.bigint();
    await work();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.ceil(RUNS * 0.95) - 1];
}

/**
 * **The calendar's reads, measured at the office ceiling** (`functional/calendar.md`, the Data contract:
 * *"Each read answers inside the 300 ms p95 budget"*): a member's own week and month, a compared pane, and
 * the people picker over all 500 members — each read through the service, on the in-memory database, with
 * some six thousand entries on file. And the shape of the cost: the range read is served by the two
 * `kpmId`-led indexes, never a collection scan.
 */
describe('the calendar’s reads, measured at 500 members', () => {
  let wired: ReturnType<typeof configModule>;
  let ab: string;
  let aab: string;
  let agent: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    const db = mongoose.connection.db!;
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create(
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
    );
    await wired.orgLevels.seedDefaultLadder(COMPANY);

    const users: Record<string, unknown>[] = [];
    const members: Record<string, unknown>[] = [];
    let seq = 0;
    const place = (role: 'ab' | 'aab' | 'agent', leader: string | null, ancestors: string[]) => {
      seq += 1;
      const userId = new mongoose.Types.ObjectId();
      const id = new mongoose.Types.ObjectId();
      users.push({ _id: userId, email: `c${seq}@scale.test`, passwordHash: 'x', fullName: `Person ${String(seq).padStart(3, '0')}`, status: 'active', deletedAt: null });
      members.push({
        _id: id, kpmId: KPM_A, userId: String(userId), agentCode: `S${seq}`, agentSeq: seq, leaderCode: `SC${seq}`,
        orgLevelId: 'x', orgLevelCode: role.toUpperCase(), role, leaderId: leader, ancestorIds: ancestors,
        depth: ancestors.length, status: 'active', deletedAt: null,
      });
      return String(id);
    };
    ab = place('ab', null, []);
    const everyone = [ab];
    for (let u = 0; u < UNITS; u += 1) {
      const head = place('aab', ab, [ab]);
      everyone.push(head);
      for (let a = 0; a < PER_UNIT; a += 1) everyone.push(place('agent', head, [ab, head]));
      if (u === 0) aab = head;
    }
    agent = everyone[everyone.length - 1];
    await db.collection('users').insertMany(users);
    await db.collection('memberships').insertMany(members);

    // Six weeks of entries for everybody, and the AB's twice-weekly standup with fifty on it.
    const entries: Record<string, unknown>[] = [];
    const at = (day: number, hour: number) => new Date(Date.UTC(2026, 7, 31 + day, hour - 7));
    for (const [i, organiser] of everyone.entries()) {
      for (let n = 0; n < PER_MEMBER; n += 1) {
        const day = (n * 3 + i) % 42;
        entries.push({
          kpmId: KPM_A, organiserMembershipId: organiser, type: 'task', title: `Task ${n}`, notes: '',
          startsAt: at(day, 9 + (n % 8)), endsAt: at(day, 10 + (n % 8)), startsOn: null, endsOn: null,
          attendees: [], version: 1, deletedAt: null,
        });
      }
    }
    for (let week = 0; week < 6; week += 1) {
      for (const day of [0, 3]) {
        entries.push({
          kpmId: KPM_A, organiserMembershipId: ab, type: 'meeting', title: 'Weekly unit standup', notes: '',
          startsAt: at(week * 7 + day, 9), endsAt: at(week * 7 + day, 10), startsOn: null, endsOn: null,
          attendees: everyone.slice(1, 51).map((membershipId) => ({ membershipId, placed: false, answer: 'accepted', answeredAt: null, addedAt: NOW })),
          version: 1, deletedAt: null,
        });
      }
    }
    await db.collection('calendarEvents').insertMany(entries);
    await mongoose.model('CalendarEvent').syncIndexes();
  }, 120_000);
  afterAll(stopMongo);

  it('reads a week, a month, a compared pane and the picker inside the budget', async () => {
    const timings = {
      ownWeek: await p95(() => wired.calendar.read(ctxFor(ab, 'AB'), {})),
      ownMonth: await p95(() => wired.calendar.read(ctxFor(ab, 'AB'), { view: 'month' })),
      comparedWeek: await p95(() => wired.calendar.read(ctxFor(ab, 'AB'), { for: aab })),
      picker: await p95(() => wired.calendarPeople.people(ctxFor(agent, 'AGENT'), {})),
      pickerSearch: await p95(() => wired.calendarPeople.people(ctxFor(agent, 'AGENT'), { q: 'person 4' })),
      compareList: await p95(() => wired.calendarPeople.downline(ctxFor(ab, 'AB'))),
    };
    for (const [read, ms] of Object.entries(timings)) {
      expect([read, ms < BUDGET_MS, Math.round(ms)]).toEqual([read, true, Math.round(ms)]);
    }
  });

  it('serves the range read from the kpmId-led indexes, never a collection scan', async () => {
    const plan = await mongoose.connection.db!.collection('calendarEvents').find({
      kpmId: KPM_A, deletedAt: null,
      $or: [{ organiserMembershipId: aab }, { attendees: { $elemMatch: { membershipId: aab, answer: { $ne: 'declined' } } } }],
      startsAt: { $gte: new Date('2026-08-14T17:00:00Z'), $lt: new Date('2026-09-20T17:00:00Z') },
      endsAt: { $gt: new Date('2026-09-13T17:00:00Z') },
    }).explain('queryPlanner');
    const text = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(text).not.toContain('COLLSCAN');
    expect(text).toContain('kpmId_1_organiserMembershipId_1_startsAt_1');
    expect(text).toContain('kpmId_1_attendees.membershipId_1_startsAt_1');
  });
});
