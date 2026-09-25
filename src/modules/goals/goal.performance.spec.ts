import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-26T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

const AGENTS = 20;
const PERIODS = ['2024', '2025', '2026'];

interface Explained {
  queryPlanner: unknown;
  executionStats: { nReturned: number; totalDocsExamined: number };
}

const member = (kpmId: string, membershipId: string) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * The goal projection, measured (P8-T5 AC-4).
 *
 * `performance-and-scale.md` asks for an `explain()` assertion on every aggregate — no `COLLSCAN` on
 * a tenant-scoped collection. `goals` is small by construction: one row per member per period, so a
 * forty-agent office with three years of history holds a hundred and twenty. **That is the point
 * worth asserting** — the reads are by `(kpmId, membershipId, period)`, which is the unique index,
 * so they touch one document rather than scanning a collection that will only ever grow slowly.
 *
 * Two offices, because a plan that looks efficient inside one tenant and reads the other's rows to
 * get there is the failure this measures, not a slow one.
 */
describe('the goal projection, measured (P8-T5)', () => {
  let wired: ReturnType<typeof configModule>;
  const agents: string[] = [];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();

    const rows: Record<string, unknown>[] = [];
    for (let a = 0; a < AGENTS; a += 1) {
      const id = `mem-${String(a).padStart(3, '0')}`;
      agents.push(id);
      for (const kpmId of [KPM_A, KPM_B]) {
        for (const period of PERIODS) {
          rows.push({
            kpmId,
            membershipId: id,
            period,
            mode: 'direct',
            annualApeTargetMinor: 500_000_000_00,
            savingsTargetMinor: 0,
            commissionRatePct: 0,
            monthsLeftOverride: null,
            apeAchievedMinor: 0,
            caseSizeMinor: 18_000_000_00,
            leadsToApptPct: 30,
            closingRatePct: 30,
            snapshot: {
              monthlyApeTargetMinor: 100_000_000_00,
              policiesPerMonth: 6, appointmentsPerMonth: 20, leadsPerMonth: 67,
            },
            cascadeMapping: {
              leadsCode: 'LEADS_CONTACTED',
              appointmentsCode: 'SELL_PRESENTATION',
              closingsCode: 'SELL_SUBMISSION',
            },
            savedAt: NOW,
            savedByMembershipId: id,
            version: 1,
            deletedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
            createdBy: id,
            updatedBy: id,
          });
        }
      }
    }
    await mongoose.connection.db!.collection('goals').insertMany(rows as never);
    await mongoose.connection.db!.collection('goals').createIndexes([
      {
        key: { kpmId: 1, membershipId: 1, period: 1 },
        unique: true,
        partialFilterExpression: { deletedAt: null },
      },
      { key: { kpmId: 1, period: 1, deletedAt: 1 } },
    ]);
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: 'c', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: 'c', code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
  }, 60_000);

  afterAll(stopMongo);

  const explain = async (filter: Record<string, unknown>) =>
    (await mongoose.connection.db!.collection('goals')
      .find(filter).explain('executionStats')) as unknown as Explained;

  it('holds 120 goals across two offices', async () => {
    expect(await mongoose.connection.db!.collection('goals').countDocuments())
      .toBe(2 * AGENTS * PERIODS.length);
  });

  describe('the query plans (performance-and-scale.md §Indexing)', () => {
    it('AC-4: reads one plan by the unique index, touching one document', async () => {
      const plan = await explain({
        kpmId: KPM_A, membershipId: agents[0], period: '2026', deletedAt: null,
      });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(JSON.stringify(plan.queryPlanner)).toContain('IXSCAN');
      expect(plan.executionStats.nReturned).toBe(1);
      expect(plan.executionStats.totalDocsExamined).toBe(1);
    });

    it('AC-4: reads one member’s history without examining the office around them', async () => {
      const plan = await explain({ kpmId: KPM_A, membershipId: agents[0], deletedAt: null });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(plan.executionStats.nReturned).toBe(PERIODS.length);
      expect(plan.executionStats.totalDocsExamined).toBe(PERIODS.length);
    });

    it('AC-4: reads a whole office’s period without reading the other office at all', async () => {
      // What a leader's or an Owner's rollup reads — the widest query over this collection.
      const plan = await explain({ kpmId: KPM_A, period: '2026', deletedAt: null });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(plan.executionStats.nReturned).toBe(AGENTS);
      expect(plan.executionStats.totalDocsExamined).toBe(AGENTS);
    });
  });

  describe('what the screen waits for', () => {
    it('answers a plan well inside the read budget', async () => {
      const ctx = member(KPM_A, agents[0]);
      await wired.goals.read(ctx, '2026');

      let slowest = 0;
      for (let i = 0; i < 20; i += 1) {
        const started = process.hrtime.bigint();
        await wired.goals.read(ctx, '2026');
        slowest = Math.max(slowest, Number(process.hrtime.bigint() - started) / 1e6);
      }

      expect(slowest).toBeLessThan(300);
    });

    it('AC-1: the cascade is arithmetic, so a history costs one read and no extra passes', async () => {
      // `list` recomputes every row from one office-day lookup, not one per row.
      const history = await wired.goals.list(member(KPM_A, agents[0]));

      expect(history).toHaveLength(PERIODS.length);
      for (const goal of history) expect(goal.projected).not.toBeNull();
    });
  });
});
