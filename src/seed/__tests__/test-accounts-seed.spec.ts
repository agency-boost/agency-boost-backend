import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';
import { TEST_ACCOUNTS_SEED } from '../test-accounts-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const NOW = new Date('2026-11-20T03:00:00Z');

/**
 * **Two test accounts in 0417, flagged and never listed** (P19.17-T1 AC-1; ADR-0267 §1; `test-accounts-fixture.ts`): the
 * *FMT …* and *TES IMPOR …* agents under Agus are flagged by migration `0065`'s name rule, carry the flag on their
 * memberships, and are on neither Agus's roster nor the Owner's head count. A second run writes nothing.
 */
describe('P19.17-T1 the test-accounts seed', () => {
  const clock = new FixedClock(NOW);
  const db = () => mongoose.connection.db!;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(NOW);
  }, RUN_MS);
  afterAll(stopMongo);

  const membershipOf = async (email: string) => {
    const user = (await db().collection('users').findOne({ email }))!;
    return { user, membership: (await db().collection('memberships').findOne({ userId: String(user._id), status: 'active' }))! };
  };
  const asMember = (m: Record<string, unknown>, owner = false) => new RequestContext(String(m.userId), 'none', {
    membershipId: String(m._id), kpmId: m.kpmId, orgLevelCode: String(m.orgLevelCode), hierarchyRole: m.role,
    status: 'active', isKpmOwner: owner, isKpmAdmin: false, directCount: 1,
  } as never);

  it('P19.17-T1 AC-1 flags both accounts by their names, and their memberships with them — nobody else in 0417', async () => {
    for (const seed of Object.values(TEST_ACCOUNTS_SEED)) {
      const { user, membership } = await membershipOf(seed.email);
      expect({ email: seed.email, user: user.testAccount, membership: membership.testAccount })
        .toEqual({ email: seed.email, user: true, membership: true });
    }
    const agus = (await membershipOf('agus@kpm0417.test')).membership;
    const flagged = await db().collection('memberships').countDocuments({ kpmId: agus.kpmId, testAccount: true });
    expect(flagged).toBe(2);
    expect((await membershipOf('owner@kpm0417.test')).user.testAccount).toBe(false);
  });

  it('P19.17-T1 AC-1 Agus’s roster and the Owner’s head count leave both out', async () => {
    const agus = (await membershipOf('agus@kpm0417.test')).membership;
    const owner = (await membershipOf('owner@kpm0417.test')).membership;
    const ids = await Promise.all(Object.values(TEST_ACCOUNTS_SEED).map(async (s) => String((await membershipOf(s.email)).membership._id)));

    const coached = (await wired.coach.coacheesOf(asMember(agus), String(agus._id))).map((c) => c.membershipId);
    expect(coached.length).toBeGreaterThan(0);
    for (const id of ids) expect(coached).not.toContain(id);

    const people = await wired.officePeople.read(asMember(owner, true), null, 'Asia/Jakarta');
    for (const id of ids) expect(people.everyone.map((p) => p.membershipId)).not.toContain(id);
  });

  it('P19.17-T1 AC-1 a second run writes nothing', async () => {
    const before = await db().collection('memberships').countDocuments({ testAccount: true });
    await seedDemo({ clock, log: quiet });
    expect(await db().collection('memberships').countDocuments({ testAccount: true })).toBe(before);
    expect(await db().collection('users').countDocuments({ email: { $in: Object.values(TEST_ACCOUNTS_SEED).map((s) => s.email) } })).toBe(2);
  }, RUN_MS);
});
