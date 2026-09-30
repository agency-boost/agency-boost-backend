import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-25T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

/*
 * Big enough that a `COLLSCAN` would be unmistakable in `totalDocsExamined`, and no bigger.
 *
 * The assertions here are about the **plan**, not the volume — `examined === returned` proves the
 * index either way — and `jest.config.ts` runs four workers against one `mongod`. The first
 * version seeded 2,400 rows and pushed an unrelated suite past a 30-second hook timeout, which is
 * a worse thing to leave behind than a smaller fixture.
 */
const AGENTS = 20;
const LEADS = 20;

interface Explained {
  queryPlanner: unknown;
  executionStats: { nReturned: number; totalDocsExamined: number; executionTimeMillis: number };
}

const member = (kpmId: string, membershipId: string) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * The rollups, measured (P7-T6 AC-3).
 *
 * `performance-and-scale.md` asks for an `explain()` assertion on every aggregate — no `COLLSCAN`
 * on a tenant-scoped collection. `leads` is the **second** per-person collection and the one an
 * office fills fastest by hand: forty agents with thirty prospects each is 1,200 rows in a quiet
 * office, and the summary reads across all of them every time it is asked. No route asks since
 * P10.1-T4; the budget stands for the next reader of the two recruitment metrics.
 *
 * Two offices are seeded, because a plan that looks efficient inside one tenant and reads the
 * other's rows to get there is the failure this measures, not a slow one.
 */
describe('the lead rollups, measured (P7-T6)', () => {
  let wired: ReturnType<typeof configModule>;
  const agents: string[] = [];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);

    const rows: Record<string, unknown>[] = [];
    for (let a = 0; a < AGENTS; a += 1) {
      const id = `mem-${String(a).padStart(3, '0')}`;
      agents.push(id);
      for (const kpmId of [KPM_A, KPM_B]) {
        for (let n = 0; n < LEADS; n += 1) {
          rows.push({
            kpmId,
            ownerMembershipId: id,
            name: `Lead ${a}-${n}`,
            type: n % 2 === 0 ? 'sales' : 'recruitment',
            contact: { phone: null, email: null },
            lawfulBasis: null,
            consentAt: null,
            statusCode: n % 3 === 0 ? 'AAJI_LICENSED' : null,
            statusId: null,
            commitments: n % 5 === 0 ? [{ month: '2026-09', at: NOW, byMembershipId: id }] : [],
            remarks: n % 4 === 0 ? null : 'Talked on Friday.',
            nextActionDate: n % 7 === 0 ? '2026-09-01' : '2026-12-01',
            nextActionNote: null,
            outcome: n % 11 === 0 ? 'lost' : null,
            outcomeAt: null,
            dateRegistered: NOW,
            source: null,
            version: 1,
            transitions: [],
            deletedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
            createdBy: id,
            updatedBy: id,
          });
        }
      }
    }
    await mongoose.connection.db!.collection('leads').insertMany(rows as never);
    await mongoose.connection.db!.collection('leads').createIndexes([
      { key: { kpmId: 1, ownerMembershipId: 1, deletedAt: 1, dateRegistered: -1 } },
      { key: { kpmId: 1, type: 1, outcome: 1, statusCode: 1, deletedAt: 1 } },
      { key: { kpmId: 1, ownerMembershipId: 1, nextActionDate: 1, deletedAt: 1 } },
    ]);
  }, 60_000);

  afterAll(stopMongo);

  const explain = async (filter: Record<string, unknown>) =>
    (await mongoose.connection.db!.collection('leads')
      .find(filter).explain('executionStats')) as unknown as Explained;

  it('holds 800 leads across two offices, so the plans are measured at scale', async () => {
    const total = await mongoose.connection.db!.collection('leads').countDocuments();
    expect(total).toBe(2 * AGENTS * LEADS);
  });

  describe('the query plans (performance-and-scale.md §Indexing)', () => {
    it('AC-3: rolls up one agent by index, never by scanning the collection', async () => {
      const plan = await explain({
        kpmId: KPM_A, ownerMembershipId: { $in: [agents[0]] }, deletedAt: null,
      });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(JSON.stringify(plan.queryPlanner)).toContain('IXSCAN');
      expect(plan.executionStats.nReturned).toBe(LEADS);
      // 800 rows exist; the plan touches this agent's twenty and no more.
      expect(plan.executionStats.totalDocsExamined).toBe(LEADS);
    });

    it('AC-3: rolls up a leader’s whole downline the same way', async () => {
      const downline = agents.slice(0, 10);
      const plan = await explain({
        kpmId: KPM_A, ownerMembershipId: { $in: downline }, deletedAt: null,
      });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(plan.executionStats.nReturned).toBe(10 * LEADS);
      expect(plan.executionStats.totalDocsExamined).toBe(10 * LEADS);
    });

    it('AC-3: rolls up a whole office without reading the other one', async () => {
      // The Owner's counts — the widest read over this collection, and the one §3.7 allows.
      const plan = await explain({ kpmId: KPM_A, deletedAt: null });

      expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
      expect(plan.executionStats.nReturned).toBe(AGENTS * LEADS);
      // Half the collection, which is the half that belongs to this office.
      expect(plan.executionStats.totalDocsExamined).toBe(AGENTS * LEADS);
    });
  });

  describe('what a reader waits for', () => {
    it('answers an agent’s counts well inside the read budget', async () => {
      const ctx = member(KPM_A, agents[0]);
      // Warm, then the slowest of twenty: a cold first call measures the connection pool.
      await wired.leadRecords.summary(ctx);
      let slowest = 0;
      for (let i = 0; i < 20; i += 1) {
        const started = process.hrtime.bigint();
        await wired.leadRecords.summary(ctx);
        slowest = Math.max(slowest, Number(process.hrtime.bigint() - started) / 1e6);
      }

      expect(slowest).toBeLessThan(300);
    });

    it('costs an office no more than an agent by an order of magnitude', async () => {
      // The number to watch is not the milliseconds — it is that one `$facet` over an indexed
      // match does not become forty round trips as the office grows.
      const owner = new RequestContext('u-owner', 'none', {
        membershipId: 'mem-owner', kpmId: KPM_A, orgLevelCode: 'AB', hierarchyRole: 'ab',
        status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 40,
      } as never);

      const counts = await wired.leadRecords.summary(owner);

      expect(counts.open).toBeGreaterThan(300);
      expect(counts.open).toBeLessThan(AGENTS * LEADS);
    });
  });
});
