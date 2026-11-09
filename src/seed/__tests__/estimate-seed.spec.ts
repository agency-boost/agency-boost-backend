import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { UnitDashboardView, UnitGroup, UnitRow } from '@/modules/unit-dashboard/unit-dashboard.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';

const RUN_MS = 240_000;
const M = 1_000_000 * 100;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);
const rowsOf = (g: UnitGroup): UnitRow[] => [g.head, ...g.members, ...g.units.flatMap(rowsOf)];
const everyRow = (view: UnitDashboardView): UnitRow[] => [...view.yourUnit.rows, ...view.units.flatMap(rowsOf)];
/** The seed's year: the run's, in Jakarta (10:00 on 8 October 2026). */
const thisYear = () => '2026';

/** The account's live membership in office 0417, as a signed-in context. */
async function as(email: string): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  const direct = await col('memberships').countDocuments({ leaderId: String(member._id), status: 'active' });
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
    hierarchyRole: member.role, status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: direct,
  } as never);
}

/**
 * **P19.1-T4 AC-15 — the member's own estimate, seeded** (UI-157; ADR-0195): Raka holds an estimate and no upload, and
 * Rina's estimate was replaced by the office's files — each read back through the services the screens call.
 */
describe('P19.1-T4 AC-15 the estimate seed — a run at 10:00 on 8 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-08T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.1-T4 AC-15 Raka: an estimate and no upload — his Summary says perkiraan Anda, Satria’s dashboard Belum diunggah', async () => {
    const raka = await as('raka@kpm0417.test');
    const summary = await wired.summary.read(raka);
    expect(summary.yearly).toMatchObject({ actualMinor: 120 * M, production: 'estimate', source: { provenance: 'self_reported' } });
    expect(summary.monthly).toMatchObject({ actualMinor: null, production: 'none' });
    expect(summary.monthly.withoutProduction).not.toBeNull();

    const satria = await as('satria@kpm0417.test');
    const year = await wired.unitDashboard.read(satria, { period: 'year' });
    const row = everyRow(year).find((r) => r.membershipId === raka.membershipId)!;
    expect(row.goal).toMatchObject({ actualMinor: null, source: null });
  });

  it('P19.1-T4 AC-15 Rina: the office’s files replaced her estimate, and her Summary can say when', async () => {
    const rina = await as('rina@kpm0417.test');
    const summary = await wired.summary.read(rina);
    expect(summary.yearly.production).toBe('official');
    expect(summary.estimateReplaced).toEqual({ uploadedOn: summary.uploadedOn.year });
    expect(summary.uploadedOn.year).not.toBeNull();
  });

  it('P19.8-T5 AC-8 Pandu typed over his upload after the office’s latest file: his screens read his figure, Satria’s the office’s', async () => {
    const pandu = await as('pandu@kpm0417.test');
    const goal = await wired.goals.readOrDefaults(pandu, thisYear());
    expect(goal.achieved).toEqual({ minor: 60 * M, provenance: 'self_reported', month: null });
    expect(goal.official).toMatchObject({ provenance: expect.stringMatching(/^(imported|corrected)$/) });
    expect(goal.official!.minor).toBeGreaterThan(0);
    const summary = await wired.summary.read(pandu);
    expect(summary.yearly).toMatchObject({ actualMinor: 60 * M, production: 'estimate' });
    expect(summary.estimateReplaced).toBeNull();

    const satria = await as('satria@kpm0417.test');
    const year = await wired.unitDashboard.read(satria, { period: 'year' });
    const row = everyRow(year).find((r) => r.membershipId === pandu.membershipId)!;
    expect(row.goal).toMatchObject({ actualMinor: goal.official!.minor, source: { provenance: goal.official!.provenance } });
  });

  it('P19.8-T5 AC-8 Rina typed before the office’s files: they replaced her figure, which stays stored', async () => {
    const rina = await as('rina@kpm0417.test');
    const goal = await wired.goals.readOrDefaults(rina, thisYear());
    expect(goal.apeAchievedMinor).toBeGreaterThan(0);
    expect(goal.achieved.provenance).not.toBe('self_reported');
    expect(goal.official).toMatchObject({ minor: goal.achieved.minor });
  });

  it('P19.1-T4 AC-15 a second run changes neither', async () => {
    const before = await col('goals').find({ apeAchievedTypedAt: { $ne: null } }).project({ _id: 1, apeAchievedMinor: 1, apeAchievedTypedAt: 1 }).toArray();
    await seedDemo({ clock, log: quiet });
    const after = await col('goals').find({ apeAchievedTypedAt: { $ne: null } }).project({ _id: 1, apeAchievedMinor: 1, apeAchievedTypedAt: 1 }).toArray();
    expect(after).toEqual(before);
  }, RUN_MS);
});
