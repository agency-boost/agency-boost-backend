import mongoose from 'mongoose';
import { MonthlyAgentData } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { configModule } from '../../../../test/config-module';
import { LeaderScorecardService } from './scorecard.service';

/** 10:00 on 14 September 2026 in Jakarta, a meeting in two days: the live scorecard every read computes. */
const NOW = new Date('2026-09-14T03:00:00Z');
const MEETING = '2026-09-16';
const KPM_A = '66f0000000000000000a1810';
const KPM_B = '66f0000000000000000b1810';
const COMPANY = '66f0000000000000000c1810';
const M = 1_000_000 * 100;
/** January last year to this month: every month the scorecard reads, and a hire's four after this one's start. */
const MONTHS = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7));

/** Collections every row of which belongs to one office: a scan of one is a read of every office. */
const TENANT_COLLECTIONS = new Set(['memberships', 'monthlyAgentData', 'activationProgress', 'auditLog']);

interface Query { collection: string; method: string; args: unknown[] }

/**
 * **P18.1-T2 AC-4 — the scorecard in a fixed number of queries whatever the office's size** (`performance-and-scale.md`;
 * the forum's part of P18.1-T4 AC-3, whose meeting read adds the meeting's own): an office of **500 members** beside
 * one of **50**, each with every month from January last year on file and an activation for every fourth Agent.
 *
 * - the same queries for 500 as for 50, none per member, bounded;
 * - no `COLLSCAN` on a tenant collection: every query it sends is explained;
 * - nothing written: no audit row, no §3.5 entry;
 * - its p95 of twenty at 500, printed for `performance-and-scale.md`.
 */
describe('the forum’s scorecard, measured at 500 members (P18.1-T2 AC-4)', () => {
  let wired: ReturnType<typeof configModule>;
  let scorecard: LeaderScorecardService;
  const compute = (kpmId: string) => scorecard.compute({ kpmId, timezone: 'Asia/Jakarta', meetingDate: MEETING });

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    const db = mongoose.connection.db!;
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);

    const users: Record<string, unknown>[] = [];
    const members: Record<string, unknown>[] = [];
    const rows: Record<string, unknown>[] = [];
    const activations: Record<string, unknown>[] = [];
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    let seq = 0;
    const office = (kpmId: string, size: number) => {
      const root = { id: '', ancestors: [] as string[] };
      for (let i = 0; i < size; i += 1) {
        seq += 1;
        const userId = new mongoose.Types.ObjectId();
        const id = new mongoose.Types.ObjectId();
        // The root AB; then an AB, two AABs and their agents, over and over: three in four are Agents.
        const role = i === 0 ? 'ab' : i % 24 === 1 ? 'ab' : i % 12 === 2 ? 'aab' : 'agent';
        const ancestors = i === 0 ? [] : [root.id];
        // A tenth left this year; the rest joined in waves from 2024 to this summer.
        const joinedAt = new Date(Date.UTC(2024 + (i % 3), (i * 7) % 12, 2 + (i % 25), 3));
        const removedAt = i % 10 === 9 ? new Date('2026-03-15T03:00:00Z') : null;
        users.push({ _id: userId, email: `p${seq}@forum-scale.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active', deletedAt: null });
        members.push({
          _id: id, kpmId, userId: String(userId), agentCode: `F${seq}`, agentSeq: seq, leaderCode: `FL${seq}`, orgLevelId: 'x',
          orgLevelCode: role.toUpperCase(), role, leaderId: i === 0 ? null : root.id, ancestorIds: ancestors, depth: ancestors.length,
          status: removedAt ? 'removed' : 'active', joinedAt, removedAt, deletedAt: null,
        });
        if (i === 0) root.id = String(id);
        let ytd = 0;
        for (const month of MONTHS.filter((m) => m <= '2026-09' && m !== '2026-08')) {
          if (month.endsWith('-01')) ytd = 0;
          const ape = (i % 5 === 0 ? 0 : 5 + (i % 30)) * M;
          ytd += ape;
          rows.push({
            kpmId, membershipId: String(id), month, agentCode: `F${seq}`, deletedAt: null, apeMonthly: cell(ape), apeYtd: cell(ytd),
            policyCountMonthly: cell(i % 5 === 0 ? 0 : 1 + (i % 3)), newActiveAgentsMonthly: cell(i % 7 === 0 ? 1 : 0),
          });
        }
        if (role === 'agent' && i % 4 === 3) {
          activations.push({
            kpmId, membershipId: String(id), templateId: 'x', templateVersion: 1,
            startDate: joinedAt.toISOString().slice(0, 10), startCorrectedAt: null, startCorrectedByMembershipId: null,
            origin: 'joined', items: [], note: null, graduatedAt: null, graduatedByMembershipId: null, version: 1, deletedAt: null,
          });
        }
      }
    };
    office(KPM_A, 500);
    office(KPM_B, 50);
    await db.collection('users').insertMany(users);
    await db.collection('memberships').insertMany(members);
    await db.collection('monthlyAgentData').insertMany(rows);
    await db.collection('activationProgress').insertMany(activations);
    /*
     * **Nothing in flight when a read is captured.** The query log is the connection's, so every model `configModule`
     * compiled — some forty — would put its automatic index build (`createIndex`) into whichever capture it overlapped:
     * one office's list and not the other's, or past the bound. Every model's build is awaited here, then the indexes
     * the reads use are synced, then both offices are read once, so the captures below hold the reads and nothing else.
     */
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    await Promise.all(['Membership', 'MonthlyAgentData', 'ActivationProgress', 'User', 'AuditLog']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));

    scorecard = new LeaderScorecardService(
      wired.officePeople, wired.productionReadings,
      new MonthlyAgentDataRepository(mongoose.model(MonthlyAgentData.name) as never), wired.activationRows, wired.clock,
    );
    await compute(KPM_A);
    await compute(KPM_B);
  }, 600_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  /** A read, with every query it sends recorded. */
  const counted = async (read: () => Promise<unknown>): Promise<Query[]> => {
    const queries: Query[] = [];
    mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => { queries.push({ collection, method, args }); });
    try {
      await read();
      return queries;
    } finally {
      mongoose.set('debug', false);
    }
  };

  it('P18.1-T2 AC-4 sends the same queries for 50 members as for 500: none per member', async () => {
    const large = await counted(() => compute(KPM_A));
    const small = await counted(() => compute(KPM_B));
    const shape = (qs: Query[]) => qs.map((q) => `${q.collection}.${q.method}`).sort();
    expect(shape(large)).toEqual(shape(small));
    // eslint-disable-next-line no-console
    console.log(`  scorecard: ${large.length} queries at 500 and ${small.length} at 50 — ${shape(large).join(', ')}`);
    expect(large.length).toBeLessThanOrEqual(10);
    // A read of the office's records: nothing written, nobody's disclosure recorded.
    expect(large.filter((q) => q.collection === 'auditLog' || !['find', 'findOne', 'aggregate', 'countDocuments'].includes(q.method)))
      .toEqual([]);
  });

  it('P18.1-T2 AC-4 scans no tenant collection: every query explained', async () => {
    const db = mongoose.connection.db!;
    const scans: string[] = [];
    for (const q of await counted(() => compute(KPM_A))) {
      if (!TENANT_COLLECTIONS.has(q.collection)) continue;
      let plan: unknown;
      if (q.method === 'aggregate') {
        plan = await db.collection(q.collection).aggregate(q.args[0] as Record<string, unknown>[]).explain('queryPlanner');
      } else {
        const [filter, projection, options] = q.args as [Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined];
        plan = await db.collection(q.collection).find(filter, { projection: projection ?? undefined, ...(options ?? {}) }).explain('queryPlanner');
      }
      if (JSON.stringify(plan).includes('COLLSCAN')) scans.push(`${q.collection}.${q.method} ${JSON.stringify(q.args[0]).slice(0, 160)}`);
    }
    expect(scans).toEqual([]);
  }, 120_000);

  it('P18.1-T2 AC-4 computes the 500-member scorecard well inside the meeting read’s 3 s; its p95 of twenty recorded', async () => {
    await compute(KPM_A);
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await compute(KPM_A);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1];
    // eslint-disable-next-line no-console
    console.log(`  scorecard p95 of 20 at 500 members: ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(3000);
  }, 300_000);
});
