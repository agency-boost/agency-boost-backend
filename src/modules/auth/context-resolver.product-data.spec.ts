import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { ProductDataGrant, ProductDataGrantSchema } from '@/modules/product-data/product-data-grant.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { ContextResolver } from './context-resolver';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { ownersOf } from '../../../test/owners';

const PRU = '66f0000000000000000000c1';
const MANU = '66f0000000000000000000c2';

/**
 * **P19.15-T4 AC-2 — *Kelola data produk* is read on every request** (ADR-0260 §2): the context carries the companies
 * the person's live grant ticks, for an active KPM Owner or KPM Admin alone, so giving, changing and removing it are
 * in force from their next request, with no token to wait out.
 */
describe('P19.15-T4 ContextResolver — the Kelola data produk grant', () => {
  let resolver: ContextResolver;
  const clock = new FixedClock(new Date('2026-11-12T03:00:00Z'));
  const grants = () => mongoose.model(ProductDataGrant.name, ProductDataGrantSchema);
  let seq = 500;

  beforeAll(async () => {
    await startMongo();
    resolver = new ContextResolver(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(Membership.name, MembershipSchema) as never,
      clock,
      grants() as never,
    );
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

  /** A person in an office, as its Owner, an Admin or a plain member, with or without a live grant. */
  async function person(opts: {
    owner?: boolean; admin?: boolean; role?: 'ab' | 'aab' | 'agent'; status?: 'active' | 'pending'; grant?: string[];
  }): Promise<string> {
    const user = await mongoose.model(User.name).create({
      email: `u${++seq}@kpm.test`, passwordHash: 'x', fullName: 'Maya', status: 'active', platformRole: 'none',
    });
    const userId = String(user._id);
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: PRU, code: `0${seq}`, branchName: 'Bandung', owners: ownersOf(opts.owner ? userId : null),
    });
    await mongoose.model(Membership.name).create({
      kpmId: String(kpm._id), userId, agentCode: `PRU-${seq}`, agentSeq: seq, leaderCode: `LC${seq}`,
      orgLevelId: 'lvl-fixture', orgLevelCode: 'FIXTURE', role: opts.role ?? 'agent', status: opts.status ?? 'active',
      adminAccess: { isKpmAdmin: opts.admin ?? false },
    });
    if (opts.grant) {
      await grants().create({ userId, companyIds: opts.grant, grantedBy: 'root', grantedAt: clock.now() });
    }
    return userId;
  }

  it('P19.15-T4 AC-2 an Admin holding the grant carries its companies; an Owner too', async () => {
    expect((await resolver.resolve(await person({ admin: true, grant: [PRU, MANU] }))).productDataCompanyIds)
      .toEqual([PRU, MANU]);
    expect((await resolver.resolve(await person({ owner: true, grant: [MANU] }))).productDataCompanyIds).toEqual([MANU]);
  });

  it('P19.15-T4 AC-2 removal takes effect at once: the next request carries nothing', async () => {
    const maya = await person({ admin: true, grant: [PRU] });
    expect((await resolver.resolve(maya)).productDataCompanyIds).toEqual([PRU]);
    await grants().updateOne({ userId: maya }, { $set: { revokedAt: clock.now(), revokedBy: 'root' } });
    expect((await resolver.resolve(maya)).productDataCompanyIds).toEqual([]);
  });

  it('P19.15-T4 AC-2 a change of companies is in force on the next request', async () => {
    const maya = await person({ admin: true, grant: [PRU] });
    await grants().updateOne({ userId: maya }, { $set: { companyIds: [MANU] } });
    expect((await resolver.resolve(maya)).productDataCompanyIds).toEqual([MANU]);
  });

  it('P19.15-T4 AC-2 nobody else carries a grant: not an Admin without one, an agent, a pending Admin', async () => {
    expect((await resolver.resolve(await person({ admin: true }))).productDataCompanyIds).toEqual([]);
    expect((await resolver.resolve(await person({ role: 'ab', grant: [PRU] }))).productDataCompanyIds).toEqual([]);
    expect((await resolver.resolve(await person({ admin: true, status: 'pending', grant: [PRU] }))).productDataCompanyIds)
      .toEqual([]);
  });

  it('P19.15-T4 AC-2 somebody in no office, a Super Admin, and a resolver built without grants carry nothing', async () => {
    const root = await mongoose.model(User.name).create({
      email: 'root@kpm.test', passwordHash: 'x', fullName: 'Root', status: 'active', platformRole: 'super_admin',
    });
    expect((await resolver.resolve(String(root._id))).productDataCompanyIds).toEqual([]);
    const bare = new ContextResolver(
      mongoose.model(User.name) as never, mongoose.model(Kpm.name) as never, mongoose.model(Membership.name) as never, clock,
    );
    expect((await bare.resolve(await person({ admin: true, grant: [PRU] }))).productDataCompanyIds).toEqual([]);
  });

  it('P19.15-T4 AC-2 a support session carries the person\'s grant, and only looks', async () => {
    const maya = await person({ admin: true, grant: [PRU] });
    const session = await resolver.resolve(maya, 'root-id');
    expect(session.productDataCompanyIds).toEqual([PRU]);
    expect(session.impersonationReadOnly).toBe(true);
  });
});
