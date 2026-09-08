import mongoose from 'mongoose';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { ContextResolver } from './context-resolver';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

describe('ContextResolver', () => {
  let resolver: ContextResolver;

  beforeAll(async () => {
    await startMongo();
    resolver = new ContextResolver(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(Membership.name, MembershipSchema) as never,
    );
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

  async function makeUser(over: Record<string, unknown> = {}) {
    return mongoose.model(User.name).create({
      email: `u${Math.random()}@kpm.test`, passwordHash: 'x', fullName: 'Rina',
      status: 'active', platformRole: 'none', ...over,
    });
  }

  /**
   * The membership row is what resolves a context now, not `kpms.ownerUserId`. The
   * synthetic owner membership Phase 2 fabricated is gone: a context built from a row
   * that does not exist cannot carry a direct count, and leadership is that count.
   */
  async function join(userId: string, kpmId: string, over: Record<string, unknown> = {}) {
    const seq = Math.floor(Math.random() * 900) + 100;
    return mongoose.model(Membership.name).create({
      kpmId, userId, agentCode: `PRU-${seq}`, agentSeq: seq,
      // Every membership carries one, generated with it (P3.6-T1).
      leaderCode: `LC${String(seq).padStart(4, '0')}`,
      // A placeholder rung, deliberately: this helper writes straight to the model to
      // build a context, and what it exercises is the resolver, not the ladder.
      orgLevelId: 'lvl-fixture',
      role: 'ab', status: 'active', ...over,
    });
  }

  it('resolves a Super Admin with no tenant', async () => {
    const u = await makeUser({ platformRole: 'super_admin' });
    const ctx = await resolver.resolve(String(u._id));
    expect(ctx.isSuperAdmin).toBe(true);
    expect(ctx.kpmId).toBeNull();
  });

  it('resolves a user with no membership — the new agent, which is valid', async () => {
    const u = await makeUser();
    const ctx = await resolver.resolve(String(u._id));
    expect(ctx.membership).toBeNull();
    expect(ctx.kpmId).toBeNull();
    expect(ctx.isSuperAdmin).toBe(false);
  });

  it('resolves a KPM Owner to their office', async () => {
    const u = await makeUser();
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD', ownerUserId: String(u._id),
    });
    await join(String(u._id), String(kpm._id));
    const ctx = await resolver.resolve(String(u._id));
    expect(ctx.kpmId).toBe(String(kpm._id));
    expect(ctx.membership?.isKpmOwner).toBe(true);
  });

  it('resolves a pending member, so the app can say what they are waiting for', async () => {
    const u = await makeUser();
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD',
    });
    await join(String(u._id), String(kpm._id), { role: 'agent', status: 'pending' });
    const ctx = await resolver.resolve(String(u._id));
    expect(ctx.membership?.status).toBe('pending');
    expect(ctx.kpmId).toBe(String(kpm._id));
  });

  it('ignores a removed membership — leaving is not a state you can act from', async () => {
    const u = await makeUser();
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD',
    });
    await join(String(u._id), String(kpm._id), { status: 'removed' });
    expect((await resolver.resolve(String(u._id))).membership).toBeNull();
  });

  describe('leadership is the graph, not the role (OD-23)', () => {
    it('an AAB with no direct reports is not a leader', async () => {
      const u = await makeUser();
      const kpm = await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0417', branchName: 'BSD',
      });
      await join(String(u._id), String(kpm._id), { role: 'aab' });
      const ctx = await resolver.resolve(String(u._id));
      expect(ctx.membership?.hierarchyRole).toBe('aab');
      expect(ctx.isLeader).toBe(false);
    });

    it('an agent with a direct report is', async () => {
      // Contrived on purpose: the point is that the count decides, not the role.
      const u = await makeUser();
      const kpm = await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0417', branchName: 'BSD',
      });
      await join(String(u._id), String(kpm._id), {
        role: 'agent',
        directCounts: { ab: 0, aab: 0, agent: 1, total: 1 },
      });
      expect((await resolver.resolve(String(u._id))).isLeader).toBe(true);
    });
  });

  it('resolves roles from the database, not the token — a revoked grant bites at once', async () => {
    const u = await makeUser();
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD', ownerUserId: String(u._id),
    });
    await join(String(u._id), String(kpm._id));
    expect((await resolver.resolve(String(u._id))).membership?.isKpmOwner).toBe(true);

    // Ownership moves; the membership stays. They are still in the office, no longer
    // running it — which is exactly what a transfer does.
    await mongoose.model(Kpm.name).updateOne({ _id: kpm._id }, { $set: { ownerUserId: null } });
    const after = await resolver.resolve(String(u._id));
    expect(after.membership).not.toBeNull();
    expect(after.membership?.isKpmOwner).toBe(false);
  });

  it('refuses a deactivated account', async () => {
    const u = await makeUser({ status: 'deactivated' });
    await expect(resolver.resolve(String(u._id))).rejects.toMatchObject({
      code: 'AUTH_ACCOUNT_DEACTIVATED',
    });
  });

  it('refuses an unknown user', async () => {
    await expect(
      resolver.resolve(new mongoose.Types.ObjectId().toString()),
    ).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });

  it('short-circuits a member of a suspended office, distinctly from a permission failure', async () => {
    const u = await makeUser();
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD',
      ownerUserId: String(u._id), status: 'suspended',
    });
    await join(String(u._id), String(kpm._id));
    await expect(resolver.resolve(String(u._id))).rejects.toMatchObject({
      code: 'TENANT_SUSPENDED',
    });
  });

  it('short-circuits an archived office as read-only', async () => {
    const u = await makeUser();
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD',
      ownerUserId: String(u._id), status: 'archived',
    });
    await join(String(u._id), String(kpm._id));
    await expect(resolver.resolve(String(u._id))).rejects.toMatchObject({
      code: 'TENANT_ARCHIVED',
    });
  });

  it('does not short-circuit a Super Admin, who has no membership to suspend', async () => {
    const sa = await makeUser({ platformRole: 'super_admin' });
    await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD', status: 'suspended',
    });
    await expect(resolver.resolve(String(sa._id))).resolves.toBeDefined();
  });

  it('carries the real actor through an impersonation session', async () => {
    const u = await makeUser();
    const ctx = await resolver.resolve(String(u._id), 'sa-1');
    expect(ctx.isImpersonating).toBe(true);
    expect(ctx.auditActors).toEqual({ actorUserId: 'sa-1', effectiveUserId: String(u._id) });
  });
});
