import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import type { CoachingRosterView } from './coaching-roster.service';

/** 10:00 on 14 September in Jakarta: eight months on file, a fortnight of September logged. */
const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;

/** The 500-member ceiling (`performance-and-scale.md`): one AB, ten AABs, forty-nine agents under each. */
const UNITS = 10;
const PER_UNIT = 49;
const DAYS = 14;
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => `2026-${m}`);

const ctxFor = (membershipId: string, rung: 'AB' | 'AAB') => new RequestContext(`u-${membershipId}`, 'none', {
  membershipId, kpmId: KPM_A, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: rung === 'AB' ? UNITS : PER_UNIT,
} as never);

/**
 * **The roster read, measured** (P11-T6 AC-9): its cost at the 500-member ceiling, for P18-T7 to plan
 * from, and the shape of that cost — **a fixed number of queries whatever the roster's size**, none of
 * them per person, each served by an index. Not a budget this task solves: the numbers are recorded.
 */
describe('the coaching roster, measured (P11-T6 AC-9)', () => {
  let wired: ReturnType<typeof configModule>;
  let ab: string;
  const aabs: string[] = [];

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
      users.push({ _id: userId, email: `p${seq}@scale.test`, passwordHash: 'x', fullName: `Person ${String(seq).padStart(3, '0')}`, status: 'active', deletedAt: null });
      members.push({
        _id: id, kpmId: KPM_A, userId: String(userId), agentCode: `S${seq}`, agentSeq: seq, leaderCode: `SC${seq}`,
        orgLevelId: 'x', orgLevelCode: role.toUpperCase(), role, leaderId: leader, ancestorIds: ancestors,
        depth: ancestors.length, status: 'active', deletedAt: null,
      });
      return String(id);
    };
    ab = place('ab', null, []);
    const agents: string[] = [];
    for (let u = 0; u < UNITS; u += 1) {
      const aab = place('aab', ab, [ab]);
      aabs.push(aab);
      for (let a = 0; a < PER_UNIT; a += 1) agents.push(place('agent', aab, [ab, aab]));
    }
    await db.collection('users').insertMany(users);
    await db.collection('memberships').insertMany(members);

    const everyone = [...aabs, ...agents];
    const goals: Record<string, unknown>[] = [];
    const months: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const sessions: Record<string, unknown>[] = [];
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    everyone.forEach((id, i) => {
      goals.push({
        kpmId: KPM_A, membershipId: id, period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0,
        commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M,
        leadsToApptPct: 30, closingRatePct: 30, savedAt: NOW, savedByMembershipId: id, version: 1, deletedAt: null,
        cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
      });
      MONTHS.forEach((month, m) => months.push({
        kpmId: KPM_A, membershipId: id, month, agentCode: `S${i}`, deletedAt: null,
        apeMonthly: cell(20 * M), apeYtd: cell(20 * M * (m + 1)),
      }));
      for (let d = 1; d <= DAYS; d += 1) {
        logs.push({
          kpmId: KPM_A, membershipId: id, localDate: `2026-09-${String(d).padStart(2, '0')}`, source: 'self',
          enteredByMembershipId: id, version: 1, frozenAt: null, corrections: [], deletedAt: null, totalCount: 3,
          entries: [
            { activityTypeId: 't-l', activityTypeCode: 'LEADS_CONTACTED', count: 1 },
            { activityTypeId: 't-p', activityTypeCode: 'SELL_PRESENTATION', count: 1 },
            { activityTypeId: 't-r', activityTypeCode: 'RECRUIT_FOLLOWUP', count: 1 },
          ],
        });
      }
      // Two finalized 1:1s each, a fortnight and a few days back, and nobody coached today.
      for (const date of ['2026-08-31', `2026-09-0${(i % 9) + 1}`]) {
        sessions.push({
          kpmId: KPM_A, coachMembershipId: ab, coacheeMembershipId: id, status: 'finalized', date,
          frozenAt: new Date(`${date}T04:00:00Z`), finalizedAt: new Date(`${date}T04:00:00Z`),
          finalizedByMembershipId: ab, version: 3, lastWeek: null, lastWeekItems: [], actionItems: [], tips: [],
          leadActions: [], snapshot: null, corrections: [], deletedAt: null,
        });
      }
    });
    await db.collection('goals').insertMany(goals);
    await db.collection('monthlyAgentData').insertMany(months);
    await db.collection('activityLogs').insertMany(logs);
    await db.collection('coachingSessions').insertMany(sessions);
    await Promise.all(['Membership', 'Goal', 'MonthlyAgentData', 'ActivityLog', 'CoachingSession', 'User']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
  }, 180_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  /** The roster read, with every query it sends counted. */
  const counted = async (ctx: RequestContext): Promise<{ view: CoachingRosterView; queries: string[] }> => {
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    try {
      return { view: await wired.coachingRoster.read(ctx), queries };
    } finally {
      mongoose.set('debug', false);
    }
  };

  /** Nearest-rank p95 of twenty reads, as `performance-and-scale.md` states the budget. */
  const p95 = async (ctx: RequestContext): Promise<number> => {
    await wired.coachingRoster.read(ctx);
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await wired.coachingRoster.read(ctx);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.ceil(0.95 * times.length) - 1];
  };

  it('P11-T6 AC-9 lists all five hundred, grouped: ten units of forty-nine', async () => {
    const { view } = await counted(ctxFor(ab, 'AB'));
    expect(view.directAgents).toEqual([]);
    expect(view.units).toHaveLength(UNITS);
    expect(view.units.map((u) => u.members.length)).toEqual(Array(UNITS).fill(PER_UNIT));
  });

  it('P11-T6 AC-9 sends the same queries for forty-nine people as for five hundred: none per person', async () => {
    const small = await counted(ctxFor(aabs[0], 'AAB'));
    const large = await counted(ctxFor(ab, 'AB'));

    expect(large.queries.sort()).toEqual(small.queries.sort());
    // eslint-disable-next-line no-console
    console.log(`  coaching roster: ${large.queries.length} queries per read — ${large.queries.join(', ')}`);
    expect(large.queries.length).toBeLessThanOrEqual(12);
  });

  it('P11-T6 AC-9 finds each coachee’s latest 1:1 by index, never by scanning the sessions', async () => {
    const coachees = (await mongoose.connection.db!.collection('memberships')
      .find({ kpmId: KPM_A, ancestorIds: ab }).project({ _id: 1 }).toArray()).map((m) => String(m._id));
    const plan = await mongoose.connection.db!.collection('coachingSessions').aggregate([
      {
        $match: {
          kpmId: KPM_A, deletedAt: null, coacheeMembershipId: { $in: coachees },
          status: { $in: ['finalized', 'reopened'] }, date: { $ne: null },
        },
      },
      { $sort: { coacheeMembershipId: 1, date: -1, frozenAt: -1 } },
      { $group: { _id: '$coacheeMembershipId', date: { $first: '$date' } } },
    ]).explain('queryPlanner');

    const text = JSON.stringify(plan);
    expect(text).not.toContain('COLLSCAN');
    expect(text).toContain('IXSCAN');
  });

  it('P11-T6 AC-9 answers a unit of forty-nine inside the read budget, and records the ceiling’s cost', async () => {
    const unit = await p95(ctxFor(aabs[0], 'AAB'));
    const ceiling = await p95(ctxFor(ab, 'AB'));
    // eslint-disable-next-line no-console
    console.log(`  coaching roster p95 of 20: ${PER_UNIT} people ${unit.toFixed(1)} ms; ${UNITS * (PER_UNIT + 1)} people ${ceiling.toFixed(1)} ms`);
    expect(unit).toBeLessThan(300);
    // The ceiling is recorded for P18-T7, not budgeted here; this bound only catches a read gone per-person.
    expect(ceiling).toBeLessThan(3000);
  });
});
