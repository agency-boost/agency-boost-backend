import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildForumServices, type ForumServices } from '../../../test/forum-office';

/** 10:00 on 14 September in Jakarta: a year of files, the last held this month. */
const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;
/** Twenty-one months to this one: January last year to September, so *FY* and *YTD* both hold files. */
const MONTHS = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7));

/** Collections every row of which belongs to one office: a scan of one is a read of every office. */
const TENANT_COLLECTIONS = new Set([
  'memberships', 'monthlyAgentData', 'activationProgress', 'leaderMeetings', 'leaderMeetingShareLinks', 'auditLog', 'productionMonths',
]);

interface Query { collection: string; method: string; args: unknown[] }

/**
 * **P18.1-T4 AC-3 — a meeting with a live scorecard, read at the office's ceiling** (Phase 18's P18-T7 measurement
 * extended; `performance-and-scale.md`): an office of **500 members** — the Owner at the root, nine AB agencies, each
 * with two AAB units, twenty of them tagged *Core Leader* — beside a second office of fifty, each with twenty-one months
 * of files and a cohort of hires. An upcoming meeting in each, read twenty times through the service a request reaches.
 *
 * - **The same queries for 500 members as for 50**, none per member and none per editor, each bounded;
 * - **no `COLLSCAN` on a tenant collection**: every query the read sends is explained;
 * - **the p95 of twenty reads**, printed for `performance-and-scale.md`, under the forum's 3 s budget.
 */
describe('the forum’s meeting read, measured at 500 members (P18.1-T4 AC-3)', () => {
  let wired: ReturnType<typeof configModule>;
  let forum: ForumServices;
  const owners: Record<'A' | 'B', RequestContext> = {} as never;
  const meetings: Record<'A' | 'B', string> = {} as never;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await clearCollections();
    const db = mongoose.connection.db!;
    await db.collection('companies').insertOne({ _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'p', deletedAt: null });
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    forum = await buildForumServices(wired);

    const users: Record<string, unknown>[] = [];
    const members: Record<string, unknown>[] = [];
    let seq = 0;
    const place = (kpmId: string, role: 'ab' | 'aab' | 'agent', leader: { id: string; ancestors: string[] } | null, extra: Record<string, unknown> = {}) => {
      seq += 1;
      const userId = new mongoose.Types.ObjectId();
      const id = new mongoose.Types.ObjectId();
      const ancestors = leader ? [...leader.ancestors, leader.id] : [];
      users.push({ _id: userId, email: `p${seq}@forum-scale.test`, passwordHash: 'x', fullName: `Person ${String(seq).padStart(3, '0')}`, status: 'active', deletedAt: null });
      members.push({
        _id: id, kpmId, userId: String(userId), agentCode: `F${seq}`, agentSeq: seq, leaderCode: `FC${seq}`, orgLevelId: 'x',
        orgLevelCode: role.toUpperCase(), role, leaderId: leader?.id ?? null, ancestorIds: ancestors, depth: ancestors.length,
        status: 'active', joinedAt: new Date(Date.UTC(2025, seq % 20, 2)), deletedAt: null, isCoreLeader: false, ...extra,
      });
      return { id: String(id), ancestors, userId: String(userId) };
    };
    const everyone: Record<'A' | 'B', ReturnType<typeof place>[]> = { A: [], B: [] };
    const build = (key: 'A' | 'B', kpmId: string, abs: number, aabsPer: number, agentsPerAab: number, directPer: number, extra: number) => {
      const root = place(kpmId, 'ab', null);
      everyone[key].push(root);
      const admin = place(kpmId, 'ab', root, { adminAccess: { isKpmAdmin: true, grantedByUserId: null, grantedAt: null, revokedAt: null } });
      everyone[key].push(admin);
      for (let a = 0; a < abs; a += 1) {
        // Every AB tagged *Core Leader*, and every AAB in the larger office: the editors grow with the office.
        const ab = place(kpmId, 'ab', root, { isCoreLeader: true });
        everyone[key].push(ab);
        for (let u = 0; u < aabsPer; u += 1) {
          const aab = place(kpmId, 'aab', ab, { isCoreLeader: key === 'A' });
          everyone[key].push(aab);
          for (let g = 0; g < agentsPerAab; g += 1) everyone[key].push(place(kpmId, 'agent', aab));
        }
        for (let g = 0; g < directPer; g += 1) everyone[key].push(place(kpmId, 'agent', ab));
      }
      for (let g = 0; g < extra; g += 1) everyone[key].push(place(kpmId, 'agent', root));
      owners[key] = new RequestContext(root.userId, 'none', {
        membershipId: root.id, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: abs + extra + 1,
      } as never);
      return root;
    };
    const rootA = build('A', KPM_A, 9, 2, 20, 12, 3); // 1 + 1 + 9 × (1 + 2 × 21 + 12) + 3 = 500
    const rootB = build('B', KPM_B, 1, 2, 20, 4, 1); // 1 + 1 + (1 + 2 × 21 + 4) + 1 = 50
    expect(everyone.A).toHaveLength(500);
    expect(everyone.B).toHaveLength(50);
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta', ownerUserId: rootA.userId },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta', ownerUserId: rootB.userId },
    ]);
    await db.collection('users').insertMany(users);
    await db.collection('memberships').insertMany(members);

    const months: Record<string, unknown>[] = [];
    const activations: Record<string, unknown>[] = [];
    const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
    for (const [kpmId, people] of [[KPM_A, everyone.A], [KPM_B, everyone.B]] as const) {
      people.forEach((p, i) => {
        let ytd = 0;
        for (const month of MONTHS) {
          if (month.endsWith('-01')) ytd = 0;
          const ape = (i % 3 === 0 ? 0 : 10 + (i % 30)) * M;
          ytd += ape;
          months.push({
            kpmId, membershipId: p.id, month, agentCode: `F${i}`, deletedAt: null, apeMonthly: cell(ape), apeYtd: cell(ytd),
            policyCountMonthly: cell(i % 4), newActiveAgentsMonthly: cell(i % 7 === 0 ? 1 : 0),
          });
        }
        // Every tenth a hire: their activation started across last year and this.
        if (i % 10 === 5) {
          activations.push({
            kpmId, membershipId: p.id, templateId: 't', templateVersion: 1, origin: 'joined', items: [], deletedAt: null,
            startDate: `${MONTHS[i % MONTHS.length]}-15`,
          });
        }
      });
    }
    await db.collection('monthlyAgentData').insertMany(months);
    await db.collection('activationProgress').insertMany(activations);
    // Nothing in flight when a read is captured: the query log is the connection's, so a model's automatic index
    // build still running would land in one office's capture and not the other's (the scorecard spec's note).
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    await Promise.all(['Membership', 'MonthlyAgentData', 'ActivationProgress', 'User', 'AuditLog', 'LeaderMeeting', 'LeaderMeetingShareLink']
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).syncIndexes()));

    for (const key of ['A', 'B'] as const) {
      for (const [n, date] of [[12, '2026-08-17'], [13, '2026-08-31']] as const) {
        await forum.forum.create(owners[key], { title: `Strategic Check-in — #${n}`, date });
      }
      meetings[key] = (await forum.forum.create(owners[key], { title: 'Strategic Check-in — #14', date: '2026-09-17' })).id;
      for (let r = 0; r < 4; r += 1) await forum.minutes.addActionItem(owners[key], meetings[key]);
    }
  }, 600_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  const READS: Record<string, (key: 'A' | 'B') => Promise<unknown>> = {
    'a meeting with a live scorecard': (key) => forum.forum.read(owners[key], meetings[key]),
    'the list': (key) => forum.forum.list(owners[key]),
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

  it.each(Object.keys(READS))('P18.1-T4 AC-3 %s sends the same queries for 500 members as for 50: none per member, none per editor', async (name) => {
    const large = await counted(() => READS[name]('A'));
    const small = await counted(() => READS[name]('B'));
    const shape = (qs: Query[]) => qs.map((q) => `${q.collection}.${q.method}`).sort();
    expect(shape(large)).toEqual(shape(small));
    // eslint-disable-next-line no-console
    console.log(`  ${name}: ${large.length} queries — ${shape(large).join(', ')}`);
    expect(large.length).toBeLessThanOrEqual(20);
    // A read of a live meeting writes nothing: no freeze, no audit row.
    expect(large.filter((q) => !['find', 'findOne', 'aggregate', 'countDocuments', 'distinct'].includes(q.method))).toEqual([]);
  });

  it('P18.1-T4 AC-3 the meeting read scans no tenant collection: every query explained', async () => {
    const db = mongoose.connection.db!;
    const scans: string[] = [];
    for (const q of await counted(() => READS['a meeting with a live scorecard']('A'))) {
      if (!TENANT_COLLECTIONS.has(q.collection)) continue;
      let plan: unknown = null;
      if (q.method === 'find' || q.method === 'findOne') {
        const [filter, projection, options] = q.args as [Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined];
        plan = await db.collection(q.collection).find(filter, { projection: projection ?? undefined, ...(options ?? {}) }).explain('queryPlanner');
      } else if (q.method === 'aggregate') {
        plan = await db.collection(q.collection).aggregate(q.args[0] as Record<string, unknown>[]).explain('queryPlanner');
      } else {
        continue;
      }
      if (JSON.stringify(plan).includes('COLLSCAN')) scans.push(`${q.collection}.${q.method} ${JSON.stringify(q.args[0]).slice(0, 160)}`);
    }
    expect(scans).toEqual([]);
  }, 120_000);

  it('P18.1-T4 AC-3 the p95 of twenty reads at 500 members, beside a second office, under 3 s; recorded', async () => {
    const results: Record<string, number> = {};
    for (const [name, read] of Object.entries(READS)) results[name] = await p95(() => read('A'));
    // eslint-disable-next-line no-console
    console.log(`  p95 of 20 at 500 members: ${Object.entries(results).map(([n, ms]) => `${n} ${ms.toFixed(1)} ms`).join('; ')}`);
    expect(results['a meeting with a live scorecard']).toBeLessThan(3000);
    expect(results['the list']).toBeLessThan(3000);
  }, 300_000);
});
