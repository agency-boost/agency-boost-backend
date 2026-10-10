import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { freshItemState } from '@/modules/activation/activation-rules';
import { ActivationReadings } from '@/modules/activation/activation-readings';
import { MemberNames } from '@/modules/org/member-names.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../../test/mongo';
import { configModule, provisionOffice } from '../../../../test/config-module';
import { ActivationComplianceCategory } from './activation.category';
import { ActivityComplianceCategory } from './activity.category';
import { CampaignsComplianceCategory } from './campaigns.category';
import { COMPLIANCE_CATEGORIES, type ComplianceCategoryKey } from './compliance-category';
import { ComplianceService } from './compliance.service';
import { EventsComplianceCategory } from './events.category';
import { GoalsComplianceCategory } from './goals.category';
import { TrainingComplianceCategory } from './training.category';

/** 10:00 on Monday 14 September 2026 in Jakarta. */
const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const M = 1_000_000 * 100;
const H = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * H).toISOString();
const wib = (local: string) => new Date(`${local}+07:00`).toISOString();

/** Collections every row of which belongs to one office: a scan of one is a read of every office. */
const TENANT_COLLECTIONS = new Set([
  'memberships', 'activityLogs', 'goals', 'auditLog', 'trainingProgress', 'activationProgress', 'activationTemplates',
  'configSnapshots', 'trainingModules', 'events', 'eventRsvps', 'eventFeedback', 'campaigns', 'campaignChases',
  'campaignStandings', 'monthlyAgentData', 'membershipHistory', 'leads',
]);

interface Query { collection: string; method: string; args: unknown[] }

/**
 * **P18.6-T1 AC-11, P18.6-T2 AC-9 — the compliance tree, measured at the office's ceiling** (`performance-and-scale.md`):
 * an office of **500 members** — the Owner at the root, nine AB agencies, each with two AAB units — beside one of
 * **50**, each holding every kind of record every category reads: training done, half-done and untouched; goals;
 * a fortnight of logging; activations open, overdue, graduated and expired; this year's events with RSVPs, claims,
 * confirmations and answers; campaigns structural and seasonal, running and ended, with chases. Every category read
 * twenty times.
 *
 * - **The same queries for 50 members as for 500** — none per member — with every chip computed on every read, at most
 *   one audit insert;
 * - **no `COLLSCAN` on a tenant collection**: every query a read sends is explained;
 * - **the budget**: *Open KPM analytics* under 3 s, server time — p95 of twenty reads per category, printed for
 *   `performance-and-scale.md`.
 *
 * Each office is read once per category before anything is measured: a read heals an activation's newly met links and
 * may freeze a campaign window that just became final — writes once, never on the reads that follow.
 */
describe('the compliance tree, measured at 500 members (P18.6-T1 AC-11, P18.6-T2 AC-9)', () => {
  let wired: ReturnType<typeof configModule>;
  let compliance: ComplianceService;
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
    await wired.campaigns.seedForCompany(COMPANY);
    for (const kpmId of [KPM_A, KPM_B]) await provisionOffice(wired, kpmId, COMPANY);
    const sales = (await wired.training.offered(RequestContext.forJob(KPM_A, 'measure')))
      .flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => m.code)));

    let seq = 0;
    const build = async (key: 'A' | 'B', kpmId: string, abs: number, aabsPer: number, agentsPerAab: number, directPer: number, extra: number) => {
      const users: Record<string, unknown>[] = [];
      const members: Record<string, unknown>[] = [];
      const edges: Record<string, unknown>[] = [];
      const joined = new Date('2025-01-02T02:00:00Z');
      const place = (role: 'ab' | 'aab' | 'agent', leader: { id: string; ancestors: string[] } | null) => {
        seq += 1;
        const userId = new mongoose.Types.ObjectId();
        const id = new mongoose.Types.ObjectId();
        const ancestors = leader ? [...leader.ancestors, leader.id] : [];
        users.push({ _id: userId, email: `p${seq}@tree.test`, passwordHash: 'x', fullName: `Person ${String(seq).padStart(3, '0')}`, status: 'active', platformRole: 'none', deletedAt: null });
        members.push({
          _id: id, kpmId, userId: String(userId), agentCode: `T${seq}`, agentSeq: seq, leaderCode: `TC${seq}`, orgLevelId: 'x',
          orgLevelCode: role.toUpperCase(), role, leaderId: leader?.id ?? null, ancestorIds: ancestors, depth: ancestors.length,
          directCounts: { total: 0 }, status: 'active', joinedAt: joined, removedAt: null, deletedAt: null,
        });
        edges.push({ kpmId, membershipId: String(id), eventType: 'joined', toLeaderId: leader?.id ?? null, validFrom: joined, validTo: null, deletedAt: null });
        return { id: String(id), ancestors, role };
      };
      const everyone: ReturnType<typeof place>[] = [];
      const root = place('ab', null);
      everyone.push(root);
      for (let a = 0; a < abs; a += 1) {
        const ab = place('ab', root);
        everyone.push(ab);
        for (let u = 0; u < aabsPer; u += 1) {
          const aab = place('aab', ab);
          everyone.push(aab);
          for (let g = 0; g < agentsPerAab; g += 1) everyone.push(place('agent', aab));
        }
        for (let g = 0; g < directPer; g += 1) everyone.push(place('agent', ab));
      }
      for (let g = 0; g < extra; g += 1) everyone.push(place('agent', root));
      await db.collection('users').insertMany(users);
      await db.collection('memberships').insertMany(members);
      await db.collection('membershipHistory').insertMany(edges);
      owners[key] = new RequestContext(`u-root-${key}`, 'none', {
        membershipId: root.id, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: abs + extra,
      } as never);
      const owner = owners[key];
      await wired.config.publish(owner);

      const version = (await wired.activation.findVersion(RequestContext.forJob(kpmId, 'measure'), 1))!;
      const progress: Record<string, unknown>[] = [];
      const goals: Record<string, unknown>[] = [];
      const logs: Record<string, unknown>[] = [];
      const activations: Record<string, unknown>[] = [];
      const months: Record<string, unknown>[] = [];
      const chases: Record<string, unknown>[] = [];
      const cell = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
      everyone.forEach((p, i) => {
        const row = (moduleCode: string, status: 'done' | 'in_progress') => progress.push({
          kpmId, membershipId: p.id, moduleCode, status, startedAt: NOW, completedAt: status === 'done' ? NOW : null,
          opened: [], version: 1, deletedAt: null,
        });
        if (i % 4 === 0) for (const code of sales) row(code, 'done');
        if (i % 4 === 1) row(sales[0], 'done');
        if (i % 4 === 2) row(sales[0], 'in_progress');
        if (i % 3 !== 0) {
          goals.push({
            kpmId, membershipId: p.id, period: '2026', mode: 'direct', annualApeTargetMinor: 500 * M, savingsTargetMinor: 0,
            commissionRatePct: 0, monthsLeftOverride: null, apeAchievedMinor: 0, caseSizeMinor: 18 * M, leadsToApptPct: 30,
            closingRatePct: 30, savedAt: NOW, savedByMembershipId: p.id, version: 1, deletedAt: null,
            cascadeMapping: { leadsCode: 'LEADS_CONTACTED', appointmentsCode: 'SELL_PRESENTATION', closingsCode: 'SELL_SUBMISSION' },
          });
        }
        if (i % 7 !== 0) {
          for (let d = 0; d < 14; d += 1) {
            logs.push({
              kpmId, membershipId: p.id, localDate: new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10),
              source: 'self', enteredByMembershipId: p.id, version: 1, frozenAt: null, corrections: [], deletedAt: null,
              totalCount: 2, entries: [{ activityTypeId: 't', activityTypeCode: 'LEADS_CONTACTED', count: 2 }],
            });
          }
        }
        if (p.role === 'agent' && i % 5 !== 4) {
          const kind = i % 5;
          activations.push({
            kpmId, membershipId: p.id, templateId: version.id, templateVersion: version.version,
            startDate: ['2026-08-01', '2026-04-01', '2026-03-01', '2026-01-02'][kind],
            startCorrectedAt: null, startCorrectedByMembershipId: null, origin: 'joined',
            items: version.aspects.flatMap((a) => a.items).map((item) => freshItemState(item.code)), note: null,
            graduatedAt: kind === 2 ? new Date('2026-05-20T03:00:00Z') : null, graduatedByMembershipId: kind === 2 ? p.id : null,
            version: 1, deletedAt: null, createdAt: NOW, updatedAt: NOW,
          });
        }
        ['2026-07', '2026-08', '2026-09'].forEach((month, m) => months.push({
          kpmId, membershipId: p.id, month, agentCode: `T${i}`, deletedAt: null, apeMonthly: cell(20 * M), apeYtd: cell(20 * M * (m + 7)),
          policyCountMonthly: cell(1), persistencyMonthly: cell(90), recruitmentMonthly: cell(1), newActiveAgentsMonthly: cell(0),
        }));
        if (i % 2 === 0) for (const campaignCode of ['APE_SPRINT', 'MDRT_QUALIFICATION', 'JULY_PUSH']) {
          chases.push({ kpmId, membershipId: p.id, campaignCode, chasing: true, deletedAt: null });
        }
      });
      await db.collection('trainingProgress').insertMany(progress);
      await db.collection('goals').insertMany(goals);
      await db.collection('activityLogs').insertMany(logs);
      await db.collection('activationProgress').insertMany(activations);
      await db.collection('monthlyAgentData').insertMany(months);
      await db.collection('campaignChases').insertMany(chases);

      // This year's events: upcoming, running for leaders, past for everybody and for chosen agents.
      const agents = everyone.filter((p) => p.role === 'agent').map((p) => p.id);
      const make = async (code: string, startsAt: string, endsAt: string, scope: string, invitees: string[] = []) =>
        (await wired.events.create(owner, {
          code, typeCode: 'TRAINING', title: code, startsAt, endsAt, audience: { issuer: 'kpm', scope, inviteeMembershipIds: invitees },
        })).id;
      const past = await make('PAST_ALL', at(-7 * 24), at(-7 * 24 + 3), 'all_agents');
      await make('UP_ALL', at(5 * 24), at(5 * 24 + 2), 'all_agents');
      await make('RUN_LEADERS', at(-1), at(2), 'leaders');
      await make('PAST_CHOSEN', at(-12 * 24), at(-12 * 24 + 3), 'select_agents', agents.slice(0, 20));
      const rsvps: Record<string, unknown>[] = [];
      const answers: Record<string, unknown>[] = [];
      everyone.forEach((p, i) => {
        if (i % 2 !== 0 && i % 10 !== 1) return;
        const confirmed = i % 3 !== 2;
        rsvps.push({
          kpmId, eventId: past, membershipId: p.id, rsvpStatus: i % 2 === 0 ? 'going' : null, rsvpAt: NOW, cancelledAt: null,
          claimedAt: i % 10 === 1 ? NOW : null, confirmedAttended: confirmed ? i % 5 !== 0 : null,
          confirmedByMembershipId: confirmed ? owner.membershipId : null, confirmedAt: confirmed ? NOW : null, deletedAt: null,
        });
        if (i % 3 === 0) answers.push({ kpmId, eventId: past, membershipId: p.id, score: i % 11, why: 'Why', improve: '', submittedAt: NOW, deletedAt: null });
      });
      await db.collection('eventRsvps').insertMany(rsvps);
      await db.collection('eventFeedback').insertMany(answers);

      // This year's campaigns: seasonal running and ended, structural.
      const campaign = (body: Record<string, unknown>) => wired.campaigns.create(owner, body);
      await campaign({
        code: 'APE_SPRINT', title: 'APE Sprint', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'),
        requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 30 * M }],
      });
      await campaign({
        code: 'JULY_PUSH', title: 'July Push', startsAt: wib('2026-07-01T00:00:00'), endsAt: wib('2026-07-31T23:59:00'),
        requirements: [{ metricKey: 'ROLLING_PERSISTENCY', comparator: 'gte', value: 85 }],
      });
      await campaign({
        code: 'MDRT_QUALIFICATION', title: 'MDRT', kind: 'structural', subtype: 'ongoing', window: 'calendar_year',
        startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 100 * M }],
      });
      return everyone;
    };
    expect(await build('A', KPM_A, 9, 2, 20, 12, 4)).toHaveLength(500); // 1 + 9 × (1 + 2 × 21 + 12) + 4
    expect(await build('B', KPM_B, 1, 2, 20, 5, 1)).toHaveLength(50); // 1 + (1 + 2 × 21 + 5) + 1

    const activationReadings = new ActivationReadings(wired.activationRows, wired.activationProgress, wired.clock);
    compliance = new ComplianceService(
      wired.officePeople, new TenantDay(wired.kpms as never, wired.clock), wired.clock, wired.subjectReads,
      new TrainingComplianceCategory(wired.offeredTraining, wired.trainingReadings, wired.clock),
      new GoalsComplianceCategory(wired.goals, wired.clock),
      new ActivityComplianceCategory(wired.activityReadings),
      new ActivationComplianceCategory(activationReadings),
      new EventsComplianceCategory(wired.eventReadings),
      new CampaignsComplianceCategory(wired.campaignStandingsReader, new MemberNames(wired.memberships, wired.users as never)),
    );

    // Every model's indexes built before anything is counted: an index build is not a read's query.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    // Once per category per office: the link heals and any first freeze, written now and never on a measured read.
    for (const owner of [owners.A, owners.B]) {
      for (const category of COMPLIANCE_CATEGORIES) await compliance.read(owner, { category });
    }
  }, 600_000);

  afterAll(async () => {
    mongoose.set('debug', false);
    await stopMongo();
  });

  const read = (category: ComplianceCategoryKey) => (owner: RequestContext) => compliance.read(owner, { category });

  /** A read, with every query it sends recorded. */
  const counted = async (run: () => Promise<unknown>): Promise<Query[]> => {
    const queries: Query[] = [];
    mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => { queries.push({ collection, method, args }); });
    try {
      await run();
      return queries;
    } finally {
      mongoose.set('debug', false);
    }
  };

  /** Nearest-rank p95 of twenty reads. */
  const p95 = async (run: () => Promise<unknown>): Promise<number> => {
    await run();
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      await run();
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.ceil(0.95 * times.length) - 1];
  };

  it('P18.6-T1 AC-11 the tree lists every member of each office: 500 and 50, every chip computed', async () => {
    for (const [owner, people] of [[owners.A, 500], [owners.B, 50]] as const) {
      const view = await compliance.read(owner, { category: 'activity' });
      expect(view.people).toBe(people);
      expect(view.summary.every((c) => c.of > 0)).toBe(true);
    }
  });

  it.each([...COMPLIANCE_CATEGORIES])('P18.6-T1 AC-11, P18.6-T2 AC-9 %s sends the same queries for 50 members as for 500: none per member', async (category) => {
    const large = await counted(() => read(category)(owners.A));
    const small = await counted(() => read(category)(owners.B));
    const shape = (qs: Query[]) => qs.map((q) => `${q.collection}.${q.method}`).sort();
    expect(shape(large)).toEqual(shape(small));
    // eslint-disable-next-line no-console
    console.log(`  ${category}: ${large.length} queries — ${shape(large).join(', ')}`);
    expect(large.length).toBeLessThanOrEqual(45);
    // At most one audit insert, and no other write: the heals and the freezes happened before.
    expect(large.filter((q) => q.collection === 'auditLog').length).toBeLessThanOrEqual(category === 'goals' || category === 'events' || category === 'campaigns' ? 0 : 1);
    expect(large.filter((q) => /^(insert|update|findOneAndUpdate|bulkWrite|replace)/.test(q.method) && q.collection !== 'auditLog')).toEqual([]);
  });

  it.each([...COMPLIANCE_CATEGORIES])('P18.6-T1 AC-11 %s scans no tenant collection: every query explained', async (category) => {
    const db = mongoose.connection.db!;
    const scans: string[] = [];
    for (const q of await counted(() => read(category)(owners.A))) {
      if (!TENANT_COLLECTIONS.has(q.collection)) continue;
      let plan: unknown = null;
      if (q.method === 'find' || q.method === 'findOne') {
        const [filter, projection, options] = q.args as [Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined];
        plan = await db.collection(q.collection).find(filter, { projection: projection ?? undefined, ...(options ?? {}) }).explain('queryPlanner');
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

  it('P18.6-T1 AC-11, P18.6-T2 AC-9 the budget: every category under 3 s at the ceiling, p95 of twenty', async () => {
    const results: Record<string, number> = {};
    for (const category of COMPLIANCE_CATEGORIES) results[category] = await p95(() => read(category)(owners.A));
    // eslint-disable-next-line no-console
    console.log(`  p95 of 20 at 500 members: ${Object.entries(results).map(([n, ms]) => `${n} ${ms.toFixed(1)} ms`).join('; ')}`);
    for (const [category, ms] of Object.entries(results)) expect([category, ms < 3000]).toEqual([category, true]);
  }, 300_000);
});
