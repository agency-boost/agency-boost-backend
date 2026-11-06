import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DirectoryService } from '@/modules/org/directory.service';
import { byKode } from '@/modules/production/upload-columns';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

/** 10:00 on 14 September in Jakarta: a year of files, the last held this month. */
const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;
/** Twelve months to this one: October last year to September. */
const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 9 + i, 1));
  return d.toISOString().slice(0, 7);
});

/** Collections every row of which belongs to one office: a scan of one is a read of every office. */
const TENANT_COLLECTIONS = new Set([
  'memberships', 'monthlyAgentData', 'activityLogs', 'coachingSessions', 'leads', 'goals', 'leadStatuses',
  'kpmRecruitTargets', 'auditLog', 'productionMonths',
]);

interface Query { collection: string; method: string; args: unknown[] }

/**
 * **P18-T7 AC-1, AC-2 — every read this phase adds, measured at the office's ceiling** (D-api,
 * `performance-and-scale.md`): an office of **500 members** — the Owner at the root, nine AB agencies, each with
 * two AAB units — beside a second office of fifty, each with **a year** of files, logging, 1:1s and leads. Every
 * read twenty times: the Overview, the not-logged list, the analytics for both periods with every row expanded (the
 * read carries them all), a directory page of fifty, and the platform's analytics across the offices.
 *
 * - **A fixed number of queries whatever the office's size** — the same for 500 as for 50, none per member — each
 *   bounded and asserted, the read entries one insert at most;
 * - **no `COLLSCAN` on a tenant collection**: every query a read sends is explained;
 * - **no `campaigns` row read** (D-clubs: the carrier rules' one reader only);
 * - **the budgets**: *Open KPM Overview* and *Open KPM analytics* under 3 s, server time — p95 of twenty, printed for
 *   `performance-and-scale.md`.
 */
describe('the Owner’s reporting, measured at 500 members (P18-T7)', () => {
  let wired: ReturnType<typeof configModule>;
  let directory: DirectoryService;
  const owners: Record<'A' | 'B', RequestContext> = {} as never;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    const db = mongoose.connection.db!;
    await db.collection('companies').insertOne({ _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'p', deletedAt: null });
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, KPM_A, COMPANY);
    await wired.provisioning.seedLeadPipelines(KPM_B);
    await wired.campaigns.seedForCompany(COMPANY);
    directory = new DirectoryService(wired.memberships, wired.users as never, wired.kpms as never);

    const users: Record<string, unknown>[] = [];
    const members: Record<string, unknown>[] = [];
    let seq = 0;
    const place = (kpmId: string, role: 'ab' | 'aab' | 'agent', leader: { id: string; ancestors: string[] } | null) => {
      seq += 1;
      const userId = new mongoose.Types.ObjectId();
      const id = new mongoose.Types.ObjectId();
      const ancestors = leader ? [...leader.ancestors, leader.id] : [];
      users.push({
        _id: userId, email: `p${seq}@scale.test`, passwordHash: 'x', fullName: `Person ${String(seq).padStart(3, '0')}`,
        status: 'active', deletedAt: null, lastLoginAt: seq % 3 === 0 ? null : new Date(NOW.getTime() - (seq % 40) * 86_400_000),
      });
      members.push({
        _id: id, kpmId, userId: String(userId), agentCode: `S${seq}`, agentSeq: seq, leaderCode: `SC${seq}`, orgLevelId: 'x',
        orgLevelCode: role.toUpperCase(), role, leaderId: leader?.id ?? null, ancestorIds: ancestors, depth: ancestors.length,
        status: 'active', joinedAt: new Date('2025-01-02T02:00:00Z'), deletedAt: null,
      });
      return { id: String(id), ancestors, userId: String(userId), role };
    };
    const everyone: Record<'A' | 'B', ReturnType<typeof place>[]> = { A: [], B: [] };
    const build = (key: 'A' | 'B', kpmId: string, abs: number, aabsPer: number, agentsPerAab: number, directPer: number, extra: number) => {
      const root = place(kpmId, 'ab', null);
      everyone[key].push(root);
      for (let a = 0; a < abs; a += 1) {
        const ab = place(kpmId, 'ab', root);
        everyone[key].push(ab);
        for (let u = 0; u < aabsPer; u += 1) {
          const aab = place(kpmId, 'aab', ab);
          everyone[key].push(aab);
          for (let g = 0; g < agentsPerAab; g += 1) everyone[key].push(place(kpmId, 'agent', aab));
        }
        for (let g = 0; g < directPer; g += 1) everyone[key].push(place(kpmId, 'agent', ab));
      }
      for (let g = 0; g < extra; g += 1) everyone[key].push(place(kpmId, 'agent', root));
      owners[key] = new RequestContext(root.userId, 'none', {
        membershipId: root.id, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: abs + extra,
      } as never);
    };
    build('A', KPM_A, 9, 2, 20, 12, 4); // 1 + 9 × (1 + 2 × 21 + 12) + 4 = 500
    build('B', KPM_B, 1, 2, 20, 5, 1); // 1 + (1 + 2 × 21 + 5) + 1 = 50
    expect(everyone.A).toHaveLength(500);
    expect(everyone.B).toHaveLength(50);
    await db.collection('users').insertMany(users);
    await db.collection('memberships').insertMany(members);

    const goals: Record<string, unknown>[] = [];
    const months: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const sessions: Record<string, unknown>[] = [];
    const leads: Record<string, unknown>[] = [];
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    for (const [kpmId, people] of [[KPM_A, everyone.A], [KPM_B, everyone.B]] as const) {
      people.forEach((p, i) => {
        goals.push({
          kpmId, membershipId: p.id, period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0,
          commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30,
          closingRatePct: 30, savedAt: NOW, savedByMembershipId: p.id, version: 1, deletedAt: null,
          cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
        });
        let ytd = 0;
        MONTHS.forEach((month) => {
          if (month.endsWith('-01')) ytd = 0;
          const ape = (10 + (i % 30)) * M;
          ytd += ape;
          months.push({
            kpmId, membershipId: p.id, month, agentCode: `S${i}`, deletedAt: null,
            ...byKode({ apeMonthly: cell(ape), apeYtd: cell(ytd), persistencyMonthly: cell(70 + (i % 30)), policyCountMonthly: cell(i % 4) }),
          });
        });
        // A year of logging, weekly, and the last fortnight daily — for all but every seventh member.
        if (i % 7 !== 0) {
          const days = new Set<string>();
          for (let w = 0; w < 52; w += 1) days.add(new Date(NOW.getTime() - w * 7 * 86_400_000).toISOString().slice(0, 10));
          for (let d = 0; d < 14; d += 1) days.add(new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10));
          for (const localDate of days) {
            logs.push({
              kpmId, membershipId: p.id, localDate, source: 'self', enteredByMembershipId: p.id, version: 1, frozenAt: null,
              corrections: [], deletedAt: null, totalCount: 2,
              entries: [{ activityTypeId: 't', activityTypeCode: 'LEADS_CONTACTED', count: 2 }],
            });
          }
        }
        // A 1:1 a month with their leader, the last ones spread over the last forty days.
        const leader = p.ancestors.at(-1);
        if (leader) {
          for (let k = 0; k < 12; k += 1) {
            const date = new Date(NOW.getTime() - ((i % 40) + k * 30) * 86_400_000).toISOString().slice(0, 10);
            sessions.push({
              kpmId, coachMembershipId: leader, coacheeMembershipId: p.id, status: 'finalized', date,
              frozenAt: new Date(`${date}T04:00:00Z`), finalizedAt: new Date(`${date}T04:00:00Z`), finalizedByMembershipId: leader,
              version: 3, lastWeekItems: [], tips: [], leadActions: [], actionItems: [], snapshot: null, corrections: [], deletedAt: null,
            });
          }
        }
        for (let n = 0; n < 4; n += 1) {
          leads.push({
            kpmId, ownerMembershipId: p.id, type: n % 2 ? 'recruitment' : 'sales', name: `L${n}`,
            statusCode: n === 3 ? 'AAJI_LICENSED' : null, outcome: n === 2 && i % 5 === 0 ? 'won' : null,
            outcomeAt: n === 2 && i % 5 === 0 ? new Date('2026-08-20T03:00:00Z') : null,
            commitments: n < 2 ? [{ month: '2026-09' }, { month: '2026-08' }] : [], transitions: [], version: 1, deletedAt: null,
            dateRegistered: new Date('2025-11-01T02:00:00Z'),
          });
        }
      });
    }
    await db.collection('goals').insertMany(goals);
    await db.collection('monthlyAgentData').insertMany(months);
    await db.collection('activityLogs').insertMany(logs);
    await db.collection('coachingSessions').insertMany(sessions);
    await db.collection('leads').insertMany(leads);
    await Promise.all(['Membership', 'Goal', 'MonthlyAgentData', 'ActivityLog', 'CoachingSession', 'User', 'Lead', 'AuditLog', 'KpmRecruitTarget']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));
    // And every model's own index build settled (`init()`), as the compliance tree's spec does: `syncIndexes` does
    // not wait for the autoIndex build a model starts when it compiles, and under a full suite's load that build
    // landed inside the overview's capture as two `memberships.createIndex` — an index build, not a read's query.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, 600_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  const READS: Record<string, (ctx: RequestContext) => Promise<unknown>> = {
    overview: (ctx) => wired.kpmOverview.read(ctx),
    'not-logged': (ctx) => wired.kpmOverview.notLogged(ctx),
    'analytics (this month)': (ctx) => wired.kpmAnalytics.read(ctx, { period: 'this_month' }),
    'analytics (previous month)': (ctx) => wired.kpmAnalytics.read(ctx, { period: 'previous_month' }),
    'directory page of 50': async (ctx) => wired.directoryColumns.decorate(ctx, await directory.list(ctx, { limit: 50 })),
    'platform analytics': () => wired.platformAnalytics.read(RequestContext.platform('root')),
  };

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

  /** Nearest-rank p95 of twenty reads, as `performance-and-scale.md` states the budget. */
  const p95 = async (read: () => Promise<unknown>): Promise<number> => {
    await read();
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await read();
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.ceil(0.95 * times.length) - 1];
  };

  it.each(Object.keys(READS))('P18-T7 AC-1 %s sends the same queries for 50 members as for 500: none per member', async (name) => {
    const large = await counted(() => READS[name](owners.A));
    const small = await counted(() => READS[name](owners.B));
    const shape = (qs: Query[]) => qs.map((q) => `${q.collection}.${q.method}`).sort();
    expect(shape(large)).toEqual(shape(small));
    // eslint-disable-next-line no-console
    console.log(`  ${name}: ${large.length} queries — ${shape(large).join(', ')}`);
    expect(large.length).toBeLessThanOrEqual(30);
    expect(large.filter((q) => q.collection === 'auditLog').length).toBeLessThanOrEqual(1);
    expect(large.filter((q) => q.collection === 'campaigns')).toEqual([]);
  });

  it.each(Object.keys(READS))('P18-T7 AC-1 %s scans no tenant collection: every query explained', async (name) => {
    const db = mongoose.connection.db!;
    const scans: string[] = [];
    for (const q of await counted(() => READS[name](owners.A))) {
      if (!TENANT_COLLECTIONS.has(q.collection)) continue;
      let plan: unknown = null;
      if (q.method === 'find' || q.method === 'findOne') {
        const [filter, projection, options] = q.args as [Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined];
        const cursor = db.collection(q.collection).find(filter, { projection: projection ?? undefined, ...(options ?? {}) });
        plan = await cursor.explain('queryPlanner');
      } else if (q.method === 'aggregate') {
        plan = await db.collection(q.collection).aggregate(q.args[0] as Record<string, unknown>[]).explain('queryPlanner');
      } else if (q.method === 'countDocuments') {
        plan = await db.collection(q.collection).find(q.args[0] as Record<string, unknown>).explain('queryPlanner');
      } else {
        continue;
      }
      if (JSON.stringify(plan).includes('COLLSCAN')) scans.push(`${q.collection}.${q.method} ${JSON.stringify(q.args[0]).slice(0, 160)}`);
    }
    expect(scans).toEqual([]);
  }, 120_000);

  it('P18-T7 AC-2 the budgets: Open KPM Overview and Open KPM analytics under 3 s at the ceiling; every p95 recorded', async () => {
    const results: Record<string, number> = {};
    for (const [name, read] of Object.entries(READS)) results[name] = await p95(() => read(owners.A));
    // eslint-disable-next-line no-console
    console.log(`  p95 of 20 at 500 members: ${Object.entries(results).map(([n, ms]) => `${n} ${ms.toFixed(1)} ms`).join('; ')}`);
    expect(results.overview).toBeLessThan(3000);
    expect(results['analytics (this month)']).toBeLessThan(3000);
    expect(results['analytics (previous month)']).toBeLessThan(3000);
  }, 300_000);
});
