import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

/** 10:00 on 14 September 2026 in Jakarta. */
const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;

const AGENTS = 20;
const LEADER = '66f0000000000000000002ff';
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => `2026-${m}`);

type Explained = { queryPlanner: unknown; executionStats: { nReturned: number; totalDocsExamined: number } };

/**
 * **The session's Ratios and Activity cards' reads, measured** (P11-T4 AC-7; `performance-and-scale.md`,
 * 300 ms at p95 for a read) — and the *Activity* tab's Dashboard of a coachee (P13.1-T9).
 *
 * A leader's read of one coachee is the coachee's own read plus the resolution and the audit entry: the
 * subject through `COACH` (the coachee's membership and every link above them), then for the week the
 * goal and the office's production behind this month's targets, the 7 days' log, the taxonomy and the
 * tiles. Two offices with nine months of both behind every agent, so a read that reached into the other
 * office would show up as time and as a wrong figure.
 */
describe('P11-T4 AC-7 — a coachee’s ratios and week, measured', () => {
  let wired: ReturnType<typeof configModule>;
  const agents: string[] = [];
  const leader = new RequestContext('u-leader', 'none', {
    membershipId: LEADER, kpmId: KPM_A, orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: AGENTS,
  } as never);

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

    const memberships: Record<string, unknown>[] = [
      { _id: new mongoose.Types.ObjectId(LEADER), kpmId: KPM_A, userId: 'u-leader', leaderCode: 'LC-LEAD',
        orgLevelCode: 'AB', leaderId: null, ancestorIds: [], depth: 0, status: 'active', deletedAt: null },
    ];
    const goals: Record<string, unknown>[] = [];
    const production: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    for (let a = 0; a < AGENTS; a += 1) {
      for (const [kpmId, scale] of [[KPM_A, 1], [KPM_B, 10]] as const) {
        const id = new mongoose.Types.ObjectId().toString();
        if (kpmId === KPM_A) agents.push(id);
        memberships.push({
          _id: new mongoose.Types.ObjectId(id), kpmId, userId: `u-${id}`, leaderCode: `LC-${id.slice(-8)}`,
          orgLevelCode: 'AGENT', leaderId: kpmId === KPM_A ? LEADER : null, ancestorIds: kpmId === KPM_A ? [LEADER] : [],
          depth: kpmId === KPM_A ? 1 : 0, status: 'active', deletedAt: null,
        });
        goals.push({
          kpmId, membershipId: id, period: '2026', mode: 'direct',
          annualApeTargetMinor: 500 * M, savingsTargetMinor: 0, commissionRatePct: 0, monthsLeftOverride: null,
          apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30, closingRatePct: 30,
          snapshot: { monthlyApeTargetMinor: 100 * M, policiesPerMonth: 6, appointmentsPerMonth: 20, leadsPerMonth: 67 },
          cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
          savedAt: NOW, savedByMembershipId: id, revisions: [], version: 1, deletedAt: null,
          createdAt: NOW, updatedAt: NOW, createdBy: id, updatedBy: id,
        });
        MONTHS.forEach((month, i) => production.push({
          kpmId, membershipId: id, month, agentCode: `PRU-${a}`, deletedAt: null,
          apeMonthly: cell(20 * M * scale), apeYtd: cell(20 * M * scale * (i + 1)),
        }));
        for (const [m, days] of [[1, 31], [2, 28], [3, 31], [4, 30], [5, 31], [6, 30], [7, 31], [8, 31], [9, 14]]) {
          for (let d = 1; d <= days; d += 1) {
            logs.push({
              kpmId, membershipId: id, localDate: `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
              entries: [
                { activityTypeId: 't-LEADS_CONTACTED', activityTypeCode: 'LEADS_CONTACTED', count: 2 * scale },
                { activityTypeId: 't-SELL_PRESENTATION', activityTypeCode: 'SELL_PRESENTATION', count: scale },
                { activityTypeId: 't-SELL_SUBMISSION', activityTypeCode: 'SELL_SUBMISSION', count: scale },
                { activityTypeId: 't-RECRUIT_FOLLOWUP', activityTypeCode: 'RECRUIT_FOLLOWUP', count: scale },
              ],
              totalCount: 5 * scale, source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
            });
          }
        }
      }
    }
    const db = mongoose.connection.db!;
    await db.collection('memberships').insertMany(memberships as never);
    await db.collection('goals').insertMany(goals as never);
    await db.collection('monthlyAgentData').insertMany(production as never);
    await db.collection('activityLogs').insertMany(logs as never);
    // Inserted through the driver, so the models' indexes are built here, as a deployed database has them.
    await Promise.all(['Goal', 'MonthlyAgentData', 'ActivityLog', 'Membership']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
  }, 120_000);

  afterAll(stopMongo);

  /** The p95 of `runs` by nearest rank, each run reading the next agent. */
  const p95 = async (runs: number, work: (agent: string) => Promise<unknown>) => {
    const times: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const started = process.hrtime.bigint();
      await work(agents[i % agents.length]);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.ceil(0.95 * times.length) - 1];
  };

  it('answers the coachee’s figures, and office A’s: office B’s volume is ten times this', async () => {
    const week = await wired.activityLogs.summary(leader, { membershipId: agents[0] });
    // Seven days of two leads a day, one presentation and one submission; Rp 85 M this month is 13, 4 and 1.
    expect(week.targets.map((t) => [t.logged, t.target])).toEqual([[14, 13], [7, 4], [7, 1]]);
    const ratios = await wired.activityLogs.ratios(leader, agents[0]);
    expect(ratios.membershipId).toBe(agents[0]);
  });

  it('reads the coachee’s month of production by index, never the other office’s', async () => {
    const plan = (await mongoose.connection.db!.collection('monthlyAgentData')
      .find({ kpmId: KPM_A, membershipId: agents[0], month: { $lte: '2026-08' }, deletedAt: null })
      .explain('executionStats')) as unknown as Explained;
    expect(JSON.stringify(plan.queryPlanner)).not.toContain('COLLSCAN');
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(MONTHS.length);
  });

  it('P11-T4 AC-7 GET /activity/ratios?for= answers inside the read budget at p95', async () => {
    const ms = await p95(20, (agent) => wired.activityLogs.ratios(leader, agent));
    // eslint-disable-next-line no-console
    console.log(`  ratios for=           p95 of 20: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(300);
  });

  it('P11-T4 AC-7 GET /activity/summary?membershipId=, with its targets and tiles, answers inside the budget at p95', async () => {
    const ms = await p95(20, (agent) => wired.activityLogs.summary(leader, { membershipId: agent }));
    // eslint-disable-next-line no-console
    console.log(`  summary membershipId= p95 of 20: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(300);
  });

  it('P13.1-T9 GET /activity/dashboard?for=, coaching’s Activity tab over its widest preset, answers inside the budget at p95', async () => {
    const ms = await p95(20, (agent) => wired.activityLogs.dashboard(leader, { for: agent, range: 'ROLLING_30D' }));
    // eslint-disable-next-line no-console
    console.log(`  dashboard for= 30d    p95 of 20: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(300);
  });

  it('P11-T4 AC-5 every one of those reads left its record', async () => {
    const entries = await mongoose.connection.db!.collection('auditLog').aggregate([
      { $match: { action: 'activity_log.read_raw' } },
      { $group: { _id: '$after.surface', n: { $sum: 1 } } },
    ]).toArray();
    // The figures' read above, and twenty of each measured.
    expect(Object.fromEntries(entries.map((e) => [e._id, e.n])))
      .toEqual({ ratios: 21, summary: 21, activity_dashboard: 20 });
  });
});
