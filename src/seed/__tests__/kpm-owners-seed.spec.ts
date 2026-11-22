import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { ownerUserIdsOf } from '@/modules/tenants/kpm-owners';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo } from '../demo';
import { KPM_OWNERS_SEED } from '../kpm-owners-fixture';
import { SUBSCRIPTION_FIXTURE_PEOPLE } from '../subscription-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const NOW = new Date('2026-11-22T03:00:00Z');

/**
 * **P19.27-T6 AC-1 — a KPM with two owners, one of them invited** (ADR-0285; `kpm-owners-fixture.ts`): 0602 Bekasi
 * Barat's Yohanes first, Sinta second and invited, Joko a member and no owner; every other seeded KPM keeps one owner, so
 * no count the walks pin moves. A second run writes nothing new.
 */
describe('P19.27-T6 AC-1 the several-owners seed', () => {
  const clock = new FixedClock(NOW);
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
  }, RUN_MS);
  afterAll(stopMongo);

  const userOf = (email: string) => db().collection('users').findOne({ email });

  it('P19.27-T6 AC-1 0602 has two owners in order — Yohanes, then Sinta, invited today and never signed in', async () => {
    const kpm = (await db().collection('kpms').findOne({ code: KPM_OWNERS_SEED.code, deletedAt: null }))!;
    const yohanes = (await userOf(SUBSCRIPTION_FIXTURE_PEOPLE.owner0602.email))!;
    const sinta = (await userOf(SUBSCRIPTION_FIXTURE_PEOPLE.aab0602.email))!;
    const joko = (await userOf(SUBSCRIPTION_FIXTURE_PEOPLE.agent0602.email))!;
    expect(ownerUserIdsOf(kpm as never)).toEqual([String(yohanes._id), String(sinta._id)]);
    expect(kpm.owners[1]).toMatchObject({ addedByUserId: String(yohanes._id), since: NOW });
    expect(sinta.lastLoginAt ?? null).toBeNull();
    expect(await db().collection('memberships').findOne({ kpmId: String(kpm._id), userId: String(sinta._id) }))
      .toMatchObject({ status: 'active', role: 'aab', invitedAt: NOW });
    expect(ownerUserIdsOf(kpm as never)).not.toContain(String(joko._id));
  });

  it('P19.27-T6 AC-1 every other KPM has one owner or none; none has a stray ownerUserId', async () => {
    const kpms = await db().collection('kpms').find({ deletedAt: null, code: { $ne: KPM_OWNERS_SEED.code } }).toArray();
    expect(kpms.every((k) => (k.owners ?? []).length <= 1)).toBe(true);
    expect(await db().collection('kpms').countDocuments({ ownerUserId: { $exists: true } })).toBe(0);
  });

  it('P19.27-T6 AC-1 a second run adds no owner and moves no invitation', async () => {
    const before = await db().collection('kpms').findOne({ code: KPM_OWNERS_SEED.code, deletedAt: null });
    clock.set(new Date(NOW.getTime() + 60_000));
    await seedDemo({ clock, log: quiet });
    const after = await db().collection('kpms').findOne({ code: KPM_OWNERS_SEED.code, deletedAt: null });
    expect(after!.owners).toEqual(before!.owners);
  }, RUN_MS);
});
