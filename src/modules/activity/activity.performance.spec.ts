import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-03-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

/**
 * The office this measures against: 40 agents, 90 days each, and a second office beside it
 * holding the same volume — because a plan that ignores `kpmId` looks fast until there are two.
 */
const AGENTS = 40;
const DAYS = 90;

const member = (kpmId: string, membershipId: string) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

type Explained = {
  queryPlanner: unknown;
  executionStats: { nReturned: number; totalDocsExamined: number; executionTimeMillis: number };
};

/**
 * The daily loop, measured (P6 exit criterion; `performance-and-scale.md` §Budgets).
 *
 * The phase's exit criterion is *"a day is logged in under 60 seconds on a mid-range Android over
 * 4G"*, and most of those sixty seconds belong to the person typing. What this file measures is
 * the part that does **not**: the server's share, and whether it grows with the office.
 *
 * `performance-and-scale.md` also requires an `explain()` assertion on every list endpoint — no
 * `COLLSCAN` on a tenant-scoped collection. `activityLogs` is the first per-person collection in
 * the product and the one that grows fastest: one row per agent per day, so a 40-agent office
 * writes ~1,000 rows a month and this is where a missing index would first be felt.
 */
describe('the daily loop, measured (P6)', () => {
  let wired: ReturnType<typeof configModule>;
  const agents: string[] = [];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();

    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);

    const types = await mongoose.connection.db!.collection('activityTypes')
      .find({ kpmId: KPM_A, status: 'active' }).toArray();

    const rows: Record<string, unknown>[] = [];
    for (const kpmId of [KPM_A, KPM_B]) {
      for (let a = 0; a < AGENTS; a += 1) {
        const membershipId = `${kpmId}-mem-${a}`;
        if (kpmId === KPM_A) agents.push(membershipId);
        for (let d = 0; d < DAYS; d += 1) {
          const day = new Date(Date.UTC(2026, 2, 11) - d * 86_400_000).toISOString().slice(0, 10);
          const entries = types.map((t, i) => ({
            activityTypeId: String(t._id),
            activityTypeCode: t.code as string,
            count: (a + d + i) % 7,
          }));
          rows.push({
            kpmId,
            membershipId,
            localDate: day,
            entries,
            totalCount: entries.reduce((sum, e) => sum + e.count, 0),
            source: 'self',
            enteredByMembershipId: membershipId,
            version: 1,
            frozenAt: null,
            corrections: [],
            deletedAt: null,
          });
        }
      }
    }
    await mongoose.connection.db!.collection('activityLogs').insertMany(rows);

    /*
     * **Build the indexes explicitly.** These rows go in through the raw driver, which is fast
     * and which means Mongoose never touches the model — so its indexes are never created, and
     * the first run of this file measured a plan examining all 3,600 of the office's rows to
     * return one. That was the harness, not the product: a deployed database gets these from the
     * schema on first write and from migration `0002` besides. Measuring without them would have
     * reported a problem that does not exist, which is worse than measuring nothing.
     */
    await mongoose.model('ActivityLog').syncIndexes();
  }, 120_000);

  afterAll(stopMongo);

  const explain = async (filter: Record<string, unknown>) =>
    (await mongoose.connection.db!.collection('activityLogs')
      .find(filter).explain('executionStats')) as unknown as Explained;

  it('holds 7,200 days across two offices, so the plans are measured at scale', async () => {
    const total = await mongoose.connection.db!.collection('activityLogs').countDocuments();
    expect(total).toBe(2 * AGENTS * DAYS);
  });

  describe('the query plans (performance-and-scale.md §Indexing)', () => {
    it('reads one day by index, touching one document', async () => {
      const plan = await explain({
        kpmId: KPM_A, membershipId: agents[0], localDate: '2026-03-11', deletedAt: null,
      });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(JSON.stringify(plan.queryPlanner)).toContain('IXSCAN');
      expect(plan.executionStats.nReturned).toBe(1);
      // The unique index is the upsert target, so the engine touches exactly the row it returns.
      expect(plan.executionStats.totalDocsExamined).toBe(1);
    });

    it('reads a member’s window without examining the office around them', async () => {
      const plan = await explain({
        kpmId: KPM_A,
        membershipId: agents[0],
        localDate: { $gte: '2026-03-05', $lte: '2026-03-11' },
        deletedAt: null,
      });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(plan.executionStats.nReturned).toBe(7);
      // 7,200 rows exist; the plan is allowed to look at a handful, not at the collection.
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(14);
    });

    it('reads a whole office’s day without reading the other office at all', async () => {
      // The Owner's compliance tree, which is the widest read over this collection.
      const plan = await explain({
        kpmId: KPM_A, localDate: '2026-03-11', deletedAt: null,
      });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(plan.executionStats.nReturned).toBe(AGENTS);
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(AGENTS * 2);
    });
  });

  describe('the server’s share of the sixty seconds', () => {
    /** The slowest of `runs`, because a budget is met at p95 and not on average. */
    const slowest = async (runs: number, work: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < runs; i += 1) {
        const started = process.hrtime.bigint();
        await work();
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      return Math.max(...times);
    };

    it('opens the day well inside the read budget', async () => {
      const ctx = member(KPM_A, agents[0]);
      const ms = await slowest(20, () => wired.activityLogs.readDay(ctx, {}));

      // performance-and-scale.md: API p95 under 300 ms for reads. This is the database and the
      // service, with no network in it — the number to watch is that it does not grow with the
      // office, which the plans above are what guarantee.
      expect(ms).toBeLessThan(300);
      console.log(`  readDay        slowest of 20: ${ms.toFixed(1)} ms`);
    });

    it('saves a day well inside the write budget', async () => {
      const ctx = member(KPM_A, agents[1]);
      const ms = await slowest(20, () => wired.activityLogs.saveDay(ctx, {
        counts: { SELL_SUBMISSION: 2, LEADS_CONTACTED: 4 },
      }));

      // performance-and-scale.md: 500 ms for writes, and "Save a day < 500 ms" as an interaction.
      expect(ms).toBeLessThan(500);
      console.log(`  saveDay        slowest of 20: ${ms.toFixed(1)} ms`);
    });

    it('answers compliance and the week’s summary inside the read budget', async () => {
      const ctx = member(KPM_A, agents[2]);

      const compliance = await slowest(20, () => wired.activityLogs.compliance(ctx, {}));
      const summary = await slowest(20, () => wired.activityLogs.summary(ctx, {
        period: 'ROLLING_7D',
      }));

      expect(compliance).toBeLessThan(300);
      expect(summary).toBeLessThan(300);
      console.log(`  compliance     slowest of 20: ${compliance.toFixed(1)} ms`);
      console.log(`  summary        slowest of 20: ${summary.toFixed(1)} ms`);
    });

    it('costs the same for the fortieth agent as for the first', async () => {
      /*
       * The check that actually matters. A plan that scanned would be fast on a small office
       * and slow on a real one, and the difference would only appear in production — so it is
       * measured here, across the whole seeded office, rather than asserted about one row.
       */
      const first = await slowest(10, () => wired.activityLogs.readDay(member(KPM_A, agents[0]), {}));
      const last = await slowest(10, () => wired.activityLogs.readDay(
        member(KPM_A, agents[AGENTS - 1]), {},
      ));

      // Generous, because a single slow run on a loaded CI box is noise and a scan is not.
      expect(last).toBeLessThan(Math.max(first * 5, 50));
      console.log(`  first vs last agent: ${first.toFixed(1)} ms → ${last.toFixed(1)} ms`);
    });
  });
});
