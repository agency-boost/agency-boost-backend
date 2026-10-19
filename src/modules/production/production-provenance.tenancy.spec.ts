import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { Goal } from '../goals/goal.schema';
import { MonthlyAgentData } from './monthly-agent-data.schema';
import { ProductionMonth } from './production-month.schema';
import { VALUE_COLUMNS } from './production-preview';
import { TEMPLATE_HEADER_V1 } from './production-template';

// 09:00 on 27 September in Jakarta: September is open.
const NOW = new Date('2026-09-27T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const RINA = '66f000000000000000000101';
const BUDI = '66f000000000000000000102';
const HENDRA = '66f000000000000000000201';

/** Rina is the Owner here and an agent with a plan of her own — one person, both roles, as in a small office. */
const ctxFor = (kpmId: string, membershipId: string) => new RequestContext('u-' + membershipId.slice(-3), 'none', {
  membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
const A = ctxFor(KPM_A, RINA);
const B = ctxFor(KPM_B, HENDRA);

const person = (id: string, kpmId: string, code: string) => ({
  _id: new mongoose.Types.ObjectId(id), kpmId, userId: '66f000000000000000003' + id.slice(-3),
  agentCode: code, agentSeq: Number(id.slice(-1)), leaderCode: `LC-${id.slice(-3)}`, orgLevelCode: 'AGENT',
  hierarchyRole: 'agent', leaderId: null, ancestorIds: [], status: 'active', deletedAt: null,
});

const file = (...rows: [string, Record<string, string>][]) => ({
  buffer: Buffer.from([
    TEMPLATE_HEADER_V1.join(','),
    ...rows.map(([code, cells]) => [code, '"x"', ...VALUE_COLUMNS.map((c) => cells[`${c.metric}.${c.cadence}`] ?? '')].join(',')),
  ].join('\n')),
  originalname: 'f.csv',
  size: 0,
});

/** Rp M in the file → sen. */
const rpM = (millions: number) => millions * 100_000_000;

describe('three writers, one visible answer (P9-T6)', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;

  const importFile = async (f: ReturnType<typeof file>, replace?: string, month = '2026-09', ctx = A) => {
    const p = await wired.production.preview(ctx, month, f);
    return wired.productionImport.commit(ctx, month, String(p.revision), f, replace);
  };
  const correct = async (over: Record<string, unknown>) => wired.productionCorrections.correct(A, {
    month: '2026-09', membershipId: RINA, metric: 'ape', cadence: 'ytd', value: rpM(120),
    revision: (await wired.productionMonths.state(A, '2026-09')).revision, reason: 'Carrier restated it', ...over,
  } as never);
  const plan = (over: Record<string, unknown> = {}) => ({
    period: '2026', mode: 'direct', annualApeTargetMinor: rpM(500), savingsTargetMinor: rpM(50),
    commissionRatePct: 10, monthsLeft: 3.2, apeAchievedMinor: rpM(50), caseSizeMinor: rpM(18),
    leadsToApptPct: 30, closingRatePct: 30, ...over,
  });
  const goal = () => wired.goals.read(A, '2026');

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of [MonthlyAgentData.name, ProductionMonth.name, Goal.name]) await mongoose.model(name).syncIndexes();
    await db().collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(KPM_A), code: '0417', timezone: 'Asia/Jakarta', settings: { productionLockGraceDays: 7 } },
      { _id: new mongoose.Types.ObjectId(KPM_B), code: '0555', timezone: 'Asia/Jakarta', settings: { productionLockGraceDays: 7 } },
    ] as never);
    await db().collection('memberships').insertMany([
      person(RINA, KPM_A, 'PRU-001'), person(BUDI, KPM_A, 'PRU-002'), person(HENDRA, KPM_B, 'PRU-001'),
    ] as never);
    await db().collection('users').insertMany([
      { _id: new mongoose.Types.ObjectId('66f000000000000000003101'), email: 'r@k.test', fullName: 'Rina Wijaya', deletedAt: null },
    ] as never);
  });

  describe('AC-2, AC-3 — the precedence the spec states, walked end to end', () => {
    it('the agent’s own → the carrier’s → a correction → kept through a re-upload → replaced when ticked → back on revert', async () => {
      // 1. Before any file: the agent's own figure, and it says so.
      await wired.goals.save(A, plan());
      expect((await goal()).achieved).toEqual({ minor: rpM(50), provenance: 'self_reported', month: null });

      // 2. The carrier's file arrives: the goal reads it, and the agent's figure is kept, not overwritten.
      await importFile(file(['PRU-001', { 'ape.monthly': '10', 'ape.ytd': '100' }]));
      let g = await goal();
      expect(g.achieved).toEqual({ minor: rpM(100), provenance: 'imported', month: '2026-09' });
      expect(g.apeAchievedMinor).toBe(rpM(50));
      expect(g.projected!.apeAchievedMinor).toBe(rpM(100));

      // 3. A correction by hand outranks the file it corrects.
      await correct({ value: rpM(120) });
      expect((await goal()).achieved).toEqual({ minor: rpM(120), provenance: 'corrected', month: '2026-09' });

      // 4. The same file again, unticked: the correction stands (ADR-0053).
      const kept = await importFile(file(['PRU-001', { 'ape.monthly': '10', 'ape.ytd': '100', 'fyp.monthly': '1' }]));
      expect(kept.batch).toMatchObject({ keptCorrectionCount: 1 });
      expect((await goal()).achieved).toMatchObject({ minor: rpM(120), provenance: 'corrected' });

      // 5. The carrier restates, and the importer ticks it: the carrier's figure wins.
      const replaced = await importFile(file(['PRU-001', { 'ape.ytd': '130' }]), `${RINA}:apeYtd`);
      expect((await goal()).achieved).toEqual({ minor: rpM(130), provenance: 'imported', month: '2026-09' });

      // 6. Reverting that import brings the correction back, whole.
      await wired.productionImport.revert(A, replaced.batch.id);
      expect((await goal()).achieved).toEqual({ minor: rpM(120), provenance: 'corrected', month: '2026-09' });

      // And nothing ever wrote the agent's own figure into production, or over it.
      expect((await goal()).apeAchievedMinor).toBe(rpM(50));
      expect(await db().collection('monthlyAgentData').countDocuments({ 'apeYtd.provenance': 'self_reported' })).toBe(0);
    });
  });

  describe('AC-3 — the goal screen reads the carrier’s figure once there is one', () => {
    it('agrees the plan against it: the snapshot is computed from the figure the screen showed', async () => {
      await importFile(file(['PRU-001', { 'ape.ytd': '400' }]));
      const saved = await wired.goals.save(A, plan({ apeAchievedMinor: rpM(50) }));
      // 500 - 400 = 100 left over 3.2 months, not 450.
      expect(saved.achieved.provenance).toBe('imported');
      expect(saved.projected!.remainingApeMinor).toBe(rpM(100));
      expect(saved.snapshot.monthlyApeTargetMinor).toBe(saved.projected!.monthlyApeTargetMinor);
    });

    it('opens a first-time plan on the carrier’s figure too', async () => {
      await importFile(file(['PRU-001', { 'ape.ytd': '200' }]));
      const offered = await wired.goals.readOrDefaults(A, '2026');
      expect(offered.achieved).toEqual({ minor: rpM(200), provenance: 'imported', month: '2026-09' });
      expect(offered.apeAchievedMinor).toBe(0);
    });

    it('reads the latest month with a year-to-date figure, in the plan’s own year', async () => {
      await wired.productionMonths.reopen(A, '2026-08');
      await importFile(file(['PRU-001', { 'ape.ytd': '80' }]), undefined, '2026-08');
      await importFile(file(['PRU-001', { 'ape.monthly': '5' }]));
      // September has no YTD, so August answers.
      expect(await wired.productionReadings.apeYearToDate(A, RINA, '2026')).toEqual({ minor: rpM(80), provenance: 'imported', month: '2026-08', correctedBy: null, correctedAt: null });
      expect(await wired.productionReadings.apeYearToDate(A, RINA, '2025')).toBeNull();
      expect(await wired.productionReadings.apeYearToDate(A, RINA, 'soon')).toBeNull();
    });

    it('falls back past a year-to-date figure somebody emptied by hand', async () => {
      await wired.productionMonths.reopen(A, '2026-08');
      await importFile(file(['PRU-001', { 'ape.ytd': '80' }]), undefined, '2026-08');
      await importFile(file(['PRU-001', { 'ape.ytd': '90' }]));
      await correct({ value: null, reason: 'Belongs to October' });
      expect((await wired.productionReadings.apeYearToDate(A, RINA, '2026'))!.month).toBe('2026-08');
    });

    it('never reads another office’s production, though both offices have a PRU-001', async () => {
      await importFile(file(['PRU-001', { 'ape.ytd': '900' }]), undefined, '2026-09', B);
      await wired.goals.save(A, plan());
      expect((await goal()).achieved.provenance).toBe('self_reported');
    });
  });

  describe('AC-1, AC-4 — every month cell says whose it is, with no second request', () => {
    it('names who corrected a figure, when and why — and keeps a figure emptied by hand visible as a decision', async () => {
      await importFile(file(['PRU-001', { 'ape.monthly': '10', 'fyp.monthly': '5' }]));
      await correct({ cadence: 'monthly', value: rpM(12) });
      await correct({ metric: 'fyp', cadence: 'monthly', value: null, reason: 'Belongs to October' });

      const view = await wired.production.readMonth(A, '2026-09');
      const rina = view.rows.find((r) => r.membershipId === RINA)!;
      expect(rina.metrics.ape.monthly).toEqual({
        value: rpM(12), provenance: 'corrected',
        correction: { by: 'Rina Wijaya', at: NOW.toISOString(), reason: 'Carrier restated it' },
      });
      expect(rina.metrics.fyp.monthly).toEqual({
        value: null, provenance: 'corrected',
        correction: { by: 'Rina Wijaya', at: NOW.toISOString(), reason: 'Belongs to October' },
      });
      expect(rina.metrics.ape.ytd).toEqual({ value: null, provenance: null, correction: null });
      // An emptied figure is still nothing held: it does not count as a member with figures.
      expect(view.withData).toBe(1);
    });
  });
});
