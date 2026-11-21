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

  it('P19.22-T1 AC-1 the seven tabs, in the fixed order', async () => {
    const shell = await wired.advancedAnalytics.shell(owner);
    expect(shell.sections.map((s) => s.slug)).toEqual(['demographics', 'mapa', 'nps', 'quant', 'qual', 'subgroup', 'events']);
  });

  it('P19.22-T2 AC-1 Demografi: every seeded member counted in each dimension; some data complete, some to fill', async () => {
    const d = await wired.advancedAnalytics.demographics(owner, {});
    expect(d.manpower).toBeGreaterThan(10);
    for (const dim of [d.role, d.workStatus, d.gender, d.ageBand, d.tenureBand]) {
      expect(dim.reduce((s, r) => s + r.count, 0)).toBe(d.manpower);
    }
    expect(d.ageBand.find((b) => b.key === 'unset')!.count).toBeLessThan(d.manpower);
    expect(d.summary.complete).toBeGreaterThan(0);
    expect(d.summary.incomplete).toBeGreaterThan(0);
    expect(d.members.filter((m) => m.missing.length > 0)).toHaveLength(d.summary.incomplete);
  });

  it('P19.22-T3 MAPA driver: this year beside last year, Rekrut the new hires, the targets the AB groups’', async () => {
    const mapa = await wired.advancedAnalytics.mapa(owner, {});
    const ape = mapa.rows.find((r) => r.key === 'ape')!;
    expect(ape.ytd).not.toBeNull();
    expect(ape.ytdLastYear).not.toBeNull();
    expect(mapa.rows.find((r) => r.key === 'active_agent')!.target).not.toBeNull();
    expect(mapa.rows.find((r) => r.key === 'rekrut')!.target).not.toBeNull();
  });

  it('P19.22-T4 AC-1 Analisa kuantitatif’s latest half-year: a median from three peers on every metric, Semester lalu read', async () => {
    const quant = await wired.advancedAnalytics.quantView(owner, {});
    expect(quant).toMatchObject({ periodEnd: '2026-06', fromMonth: '2026-01' });
    for (const m of quant.metrics) expect([m.code, m.peers, m.median === null]).toEqual([m.code, 3, false]);
    expect(quant.metrics.filter((m) => m.previous !== null).length).toBeGreaterThan(5);
    // P19.22-T4 AC-2: the distribution per leader on at least one metric.
    expect(quant.metrics.some((m) => m.distribution.leaders.length > 1)).toBe(true);
  });

  it('P19.5-T3 AC-8 the earlier half-year: every chip, and A2 short of peers', async () => {
    const quant = await wired.advancedAnalytics.quantView(owner, { periodEnd: '2025-12' });
    expect(quant.frozenAt).not.toBeNull();
    expect(quant.fromMonth).toBe('2025-07');
    expect(new Set(quant.metrics.map((m) => m.status))).toEqual(new Set(['above', 'in_line', 'below', null]));
    expect(quant.metrics.find((m) => m.code === 'A2')).toMatchObject({ median: null, peers: 2, status: null });
  });

  it('P19.22-T5 Informal group: one card per informal group, then Tanpa group; each AB group with its drivers and targets', async () => {
    const view = await wired.advancedAnalytics.subgroup(owner, {});
    expect(view.groups.map((g) => g.group?.name ?? null)).toEqual(['LEADER MUDA', 'Mentoring Agen Baru', 'Top Producers 2026', null]);
    const top = view.groups.find((g) => g.group?.name === 'Top Producers 2026')!;
    expect(top.abGroups.length).toBe(2);
    expect(top.drivers.maa.target).not.toBeNull();
    const total = view.groups.reduce((sum, g) => sum + g.counts.people, 0);
    expect(total).toBeLessThanOrEqual(view.total.people);
  });

  it('P19.5-T3 the fixture writes nothing the second time', async () => {
    const again = await seedDemo({ clock, log: quiet });
    // 0417's latest run is the page's own, written by the reads above: a second seed adds no run.
    expect(again.written.quantRuns ?? 0).toBe(0);
  }, RUN_MS);
});
