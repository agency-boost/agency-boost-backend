import mongoose from 'mongoose';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { ContextResolver } from './context-resolver';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

describe('ContextResolver', () => {
  let resolver: ContextResolver;

  beforeAll(async () => {
    await startMongo();
    resolver = new ContextResolver(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
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
    const ctx = await resolver.resolve(String(u._id));
    expect(ctx.kpmId).toBe(String(kpm._id));
    expect(ctx.membership?.isKpmOwner).toBe(true);
  });

  it('resolves roles from the database, not the token — a revoked grant bites at once', async () => {
    const u = await makeUser();
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD', ownerUserId: String(u._id),
    });
    expect((await resolver.resolve(String(u._id))).membership?.isKpmOwner).toBe(true);

    await mongoose.model(Kpm.name).updateOne({ _id: kpm._id }, { $set: { ownerUserId: null } });
    expect((await resolver.resolve(String(u._id))).membership).toBeNull();
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
    await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD',
      ownerUserId: String(u._id), status: 'suspended',
    });
    await expect(resolver.resolve(String(u._id))).rejects.toMatchObject({
      code: 'TENANT_SUSPENDED',
    });
  });

  it('short-circuits an archived office as read-only', async () => {
    const u = await makeUser();
    await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD',
      ownerUserId: String(u._id), status: 'archived',
    });
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
