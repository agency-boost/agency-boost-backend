import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

/** 09:00 in Jakarta on 14 September — nine months of production on file, two weeks of log. */
const NOW = new Date('2026-09-14T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const M = 1_000_000 * 100;

const AGENTS = 20;
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => `2026-${m}`);

const member = (kpmId: string, membershipId: string) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * The Personal Summary, measured (P10-T4 AC-6).
 *
 * One read is three: the goal, the office's production — through last month, and this month's own —
 * and the member's closings this month. Two offices with a year of both behind every agent, so a read
 * that reaches into the other office, or scans a month to find one row, shows up as time **and** as a
 * wrong figure: office B's production is ten times office A's.
 */
describe('the Personal Summary, measured (P10-T4)', () => {
  let wired: ReturnType<typeof configModule>;
  const agents: string[] = [];

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();

    const goals: Record<string, unknown>[] = [];
    const production: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    for (let a = 0; a < AGENTS; a += 1) {
      const id = `66f000000000000000000${String(a).padStart(3, '0')}`;
      agents.push(id);
      for (const [kpmId, scale] of [[KPM_A, 1], [KPM_B, 10]] as const) {
        goals.push({
          kpmId, membershipId: id, period: '2026', mode: 'direct',
          annualApeTargetMinor: 500 * M, savingsTargetMinor: 0, commissionRatePct: 0, monthsLeftOverride: null,
          apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
          snapshot: { monthlyApeTargetMinor: 100 * M, policiesPerMonth: 6, appointmentsPerMonth: 20, leadsPerMonth: 67 },
          cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
          savedAt: NOW, savedByMembershipId: id, version: 1, deletedAt: null,
          createdAt: NOW, updatedAt: NOW, createdBy: id, updatedBy: id,
        });
        MONTHS.forEach((month, i) => production.push({
          kpmId, membershipId: id, month, agentCode: `PRU-${a}`, deletedAt: null,
          apeMonthly: cell(20 * M * scale), apeYtd: cell(20 * M * scale * (i + 1)),
        }));
        for (let d = 1; d <= 14; d += 1) {
          logs.push({
            kpmId, membershipId: id, localDate: `2026-09-${String(d).padStart(2, '0')}`,
            entries: [{ activityTypeId: 't-SELL_SUBMISSION', activityTypeCode: 'SELL_SUBMISSION', count: scale }],
            totalCount: scale, source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
          });
        }
      }
    }
    const db = mongoose.connection.db!;
    await db.collection('goals').insertMany(goals as never);
    await db.collection('monthlyAgentData').insertMany(production as never);
    await db.collection('activityLogs').insertMany(logs as never);
    await Promise.all(['Goal', 'MonthlyAgentData', 'ActivityLog']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: 'c', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: 'c', code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
  }, 60_000);

  afterAll(stopMongo);

  it('holds a year of production and two weeks of log for forty agents across two offices', async () => {
    const db = mongoose.connection.db!;
    expect(await db.collection('monthlyAgentData').countDocuments()).toBe(2 * AGENTS * MONTHS.length);
    expect(await db.collection('activityLogs').countDocuments()).toBe(2 * AGENTS * 14);
  });

  it('AC-6: reads its own office’s figures and nobody else’s', async () => {
    const view = await wired.summary.read(member(KPM_A, agents[0]));

    // (500 − 160 through August) over the four months left including September.
    expect(view.monthly).toMatchObject({ targetMinor: 85 * M, actualMinor: 20 * M });
    expect(view.yearly).toMatchObject({ actualMinor: 180 * M });
    expect(view.pace).toMatchObject({ closingsLogged: 14 });
  });

  it('AC-6: answers well inside the read budget, at p95', async () => {
    const ctx = member(KPM_A, agents[0]);
    await wired.summary.read(ctx);

    // Nearest-rank p95 of 20, as `performance-and-scale.md` states the budget — not the maximum,
    // which one garbage-collection pause in a coverage run turns into a failure (P10-T4).
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await wired.summary.read(ctx);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1];

    // eslint-disable-next-line no-console
    console.log(`  summary.read   p95 of 20: ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(300);
  });
});
