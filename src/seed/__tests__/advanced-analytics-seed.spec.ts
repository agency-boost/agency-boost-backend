import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo, type SeedResult } from '../demo';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in an office, as a signed-in context. */
async function as(code: string, email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false, directCount: 0,
  } as never);
}

/**
 * **P19.5-T3 — the Advanced analytics page, seeded** (`advanced-analytics-fixture.ts`; ADR-0215). The seed run as the
 * command runs it, at 10:00 on Friday 6 November 2026 in Jakarta, then read back through the page's own service as 0417's
 * Owner, so what is asserted is what a reviewer sees on a fresh seed — every section with something in it, every state of
 * the Quant tab — and a second run writes no row of it.
 */
describe('P19.5-T3 the Advanced analytics seed — a run at 10:00 on 6 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-06T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;
  let owner: RequestContext;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    owner = await as('0417', 'owner@kpm0417.test', { owner: true });
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.5-T3 the periods: June 2026 the latest run, December 2025 the one before', () => {
    expect(seeded.advancedAnalytics.periods).toEqual({ latest: '2026-06', previous: '2025-12' });
  });

  it('P19.5-T3 AC-1 every section the template has on, then Event', async () => {
    const shell = await wired.advancedAnalytics.shell(owner);
    expect(shell.sections.map((s) => s.slug)).toEqual(['demographics', 'mapa', 'nps', 'quant', 'qual', 'subgroup', 'events']);
  });

  it('P19.5-T3 AC-2 Demographics: every seeded member counted in each dimension', async () => {
    const d = await wired.advancedAnalytics.demographics(owner, {});
    expect(d.manpower).toBeGreaterThan(10);
    for (const dim of [d.role, d.workStatus, d.gender, d.ageBand, d.tenureBand]) {
      expect(dim.reduce((s, r) => s + r.count, 0)).toBe(d.manpower);
    }
    expect(d.ageBand.find((b) => b.key === 'unset')!.count).toBeLessThan(d.manpower);
  });

  it('P19.5-T3 AC-4 MAPA: this year’s APE and FLC targets typed; December TBD', async () => {
    const ape = (await wired.advancedAnalytics.mapa(owner, {})).rows.find((r) => r.row === 'ape')!;
    expect(ape.months.find((m) => m.month === '2026-01')!.target).toBe(150 * 1_000_000 * 100);
    expect(ape.months.find((m) => m.month === '2026-12')!.target).toBeNull();
  });

  it('P19.5-T3 AC-7 Quant’s latest run: a median from three peers on every metric, the incomplete fourth left out', async () => {
    const quant = await wired.advancedAnalytics.quantView(owner, {});
    expect(quant.periodEnd).toBe('2026-06');
    for (const m of quant.metrics) expect([m.code, m.peers, m.median === null]).toEqual([m.code, 3, false]);
  });

  it('P19.5-T3 AC-8 the earlier run: every chip, and A2 short of peers', async () => {
    const quant = await wired.advancedAnalytics.quantView(owner, { periodEnd: '2025-12' });
    expect(quant.frozenAt).not.toBeNull();
    expect(new Set(quant.metrics.map((m) => m.status))).toEqual(new Set(['above', 'in_line', 'below', null]));
    expect(quant.metrics.find((m) => m.code === 'A2')).toMatchObject({ median: null, peers: 2, status: null });
  });

  it('P19.5-T3 AC-10 Sub-group: Agus on his own targets, everybody else the template’s', async () => {
    const view = await wired.advancedAnalytics.subgroup(owner);
    const agus = view.rows.find((r) => r.head.name.startsWith('Agus'))!;
    expect(agus.targets).toEqual({ aa: 4, rec: 8, isDefault: false });
    expect(view.rows.filter((r) => r !== agus).every((r) => r.targets.isDefault)).toBe(true);
  });

  it('P19.5-T3 the fixture writes nothing the second time', async () => {
    const again = await seedDemo({ clock, log: quiet });
    expect(again.written.analyticsTargets ?? 0).toBe(0);
    // 0417's latest run is the page's own, written by the reads above: a second seed adds no run.
    expect(again.written.quantRuns ?? 0).toBe(0);
  }, RUN_MS);
});
