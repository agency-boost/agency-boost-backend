import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { ContextResolver } from './context-resolver';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

describe('ContextResolver', () => {
  let resolver: ContextResolver;
  // 10:00 on 8 October 2026 in Jakarta: the day after an office whose subscription ended on the 7th.
  const clock = new FixedClock(new Date('2026-10-08T03:00:00Z'));

  beforeAll(async () => {
    await startMongo();
    resolver = new ContextResolver(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(Membership.name, MembershipSchema) as never,
      clock,
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
  // Counted, not drawn: `leaderCode` is unique across every office, and two random draws from 900 met on GitHub's
  // runner (`E11000 … leaderCode: "LC0779"`, production's first release, 2026-11-02).
  let joined = 99;
  async function join(userId: string, kpmId: string, over: Record<string, unknown> = {}) {
    const seq = ++joined;
    return mongoose.model(Membership.name).create({
      kpmId, userId, agentCode: `PRU-${seq}`, agentSeq: seq,
      // Every membership carries one, generated with it (P3.2-T1).
      leaderCode: `LC${String(seq).padStart(4, '0')}`,
      // A placeholder rung, deliberately: this helper writes straight to the model to
      // build a context, and what it exercises is the resolver, not the ladder.
      orgLevelId: 'lvl-fixture', orgLevelCode: 'FIXTURE',
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

  describe('P18.5-T5 AC-1: the effective Core Leader, read on every request (ADR-0159 §4)', () => {
    async function tagged(role: 'ab' | 'aab' | 'agent', isCoreLeader: boolean) {
      const u = await makeUser();
      const kpm = await mongoose.model(Kpm.name).create({ companyId: 'c1', code: '0417', branchName: 'BSD' });
      const row = await join(String(u._id), String(kpm._id), { role, isCoreLeader });
      return { userId: String(u._id), row };
    }

    it.each([['ab'], ['aab']] as const)('a tagged %s is one', async (role) => {
      const { userId } = await tagged(role, true);
      const ctx = await resolver.resolve(userId);
      expect(ctx.membership?.isCoreLeader).toBe(true);
      expect(ctx.isCoreLeader).toBe(true);
    });

    it('a tagged Agent is not — the tag on a rung that leads nothing has no effect', async () => {
      const { userId } = await tagged('agent', true);
      const ctx = await resolver.resolve(userId);
      expect(ctx.membership?.isCoreLeader).toBe(false);
      expect(ctx.isCoreLeader).toBe(false);
    });

    it('an untagged leader is not', async () => {
      const { userId } = await tagged('aab', false);
      expect((await resolver.resolve(userId)).isCoreLeader).toBe(false);
    });

    it('untagging, or a move off a leader rung, takes effect on the next request', async () => {
      const { userId, row } = await tagged('ab', true);
      expect((await resolver.resolve(userId)).isCoreLeader).toBe(true);
      await mongoose.model(Membership.name).updateOne({ _id: row._id }, { $set: { role: 'agent' } });
      expect((await resolver.resolve(userId)).isCoreLeader).toBe(false);
      await mongoose.model(Membership.name).updateOne({ _id: row._id }, { $set: { role: 'aab' } });
      expect((await resolver.resolve(userId)).isCoreLeader).toBe(true);
      await mongoose.model(Membership.name).updateOne({ _id: row._id }, { $set: { isCoreLeader: false } });
      expect((await resolver.resolve(userId)).isCoreLeader).toBe(false);
    });
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

  describe('an office whose subscription has ended (ADR-0112 §3, P13.2-T3 AC-5)', () => {
    // Ended on 30 September: today, 8 October, is the eighth day after it — past the seven days of grace (ADR-0279 §5).
    const ended = (over: Record<string, unknown> = {}) => ({
      startDate: '2024-10-01', endDate: '2026-09-30', pricePerLeaderMinor: null,
      currency: 'IDR', maxLeaders: null, keepActiveAfterEnd: false, ...over,
    });

    async function memberOf(kpmOver: Record<string, unknown>) {
      const u = await makeUser();
      const kpm = await mongoose.model(Kpm.name).create({
        // A company per office: two offices may share a code across insurers, never within one.
        companyId: `c-${Math.random()}`, code: '0601', branchName: 'Ended Branch', ...kpmOver,
      });
      await join(String(u._id), String(kpm._id), { role: 'agent', orgLevelCode: 'AGENT' });
      return String(u._id);
    }

    it('P19.23-T5 AC-5 refuses its member once the seven days of grace have passed, naming the date and the office', async () => {
      const userId = await memberOf({ subscription: ended() });
      await expect(resolver.resolve(userId)).rejects.toMatchObject({
        code: 'TENANT_SUBSCRIPTION_ENDED',
        details: { endDate: '2026-09-30', kpmCode: '0601', branch: 'Ended Branch' },
      });
      // The sentence writes the date as ADR-0167 §1 does; `details` keeps it machine-readable.
      await expect(resolver.resolve(userId)).rejects.toThrow(
        'This office’s subscription ended on 30 Sep 2026. Nobody in it can use AgencyBoost until it is renewed. Contact AgencyBoost.',
      );
    });

    it('P19.23-T5 AC-5 serves its member through the grace: the day after the end, and the seventh day', async () => {
      const dayOne = await memberOf({ subscription: ended({ endDate: '2026-10-07' }) });
      const daySeven = await memberOf({ subscription: ended({ endDate: '2026-10-01' }) });
      await expect(resolver.resolve(dayOne)).resolves.toBeDefined();
      await expect(resolver.resolve(daySeven)).resolves.toBeDefined();
    });

    it('serves its member on the end date itself', async () => {
      const userId = await memberOf({ subscription: ended({ endDate: '2026-10-08' }) });
      await expect(resolver.resolve(userId)).resolves.toBeDefined();
    });

    it('serves an office kept active, and one with no dates', async () => {
      const kept = await memberOf({ subscription: ended({ keepActiveAfterEnd: true }) });
      const undated = await memberOf({ subscription: ended({ startDate: null, endDate: null }) });
      const none = await memberOf({ subscription: null });
      for (const userId of [kept, undated, none]) {
        await expect(resolver.resolve(userId)).resolves.toBeDefined();
      }
    });

    it('a suspended or an archived office keeps its own code, which wins', async () => {
      const suspended = await memberOf({ subscription: ended(), status: 'suspended' });
      const archived = await memberOf({ subscription: ended(), status: 'archived' });
      await expect(resolver.resolve(suspended)).rejects.toMatchObject({
        code: 'TENANT_SUSPENDED', details: { kpmCode: '0601', branch: 'Ended Branch' },
      });
      await expect(resolver.resolve(archived)).rejects.toMatchObject({ code: 'TENANT_ARCHIVED' });
    });

    it('serves a support session into it, and refuses one into a suspended office as before', async () => {
      const ended0601 = await memberOf({ subscription: ended() });
      await expect(resolver.resolve(ended0601, 'sa-1')).resolves.toMatchObject({ isImpersonating: true });
      const suspended = await memberOf({ subscription: ended(), status: 'suspended' });
      await expect(resolver.resolve(suspended, 'sa-1')).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
    });

    it('leaves another office’s members alone', async () => {
      await memberOf({ subscription: ended() });
      const other = await memberOf({ code: '0417', subscription: ended({ endDate: '2027-01-31' }) });
      await expect(resolver.resolve(other)).resolves.toBeDefined();
    });
  });

  it('carries the real actor through an impersonation session', async () => {
    const u = await makeUser();
    const ctx = await resolver.resolve(String(u._id), 'sa-1');
    expect(ctx.isImpersonating).toBe(true);
    expect(ctx.auditActors).toEqual({ actorUserId: 'sa-1', effectiveUserId: String(u._id) });
  });

  it('P19.4-T2 AC-2 marks every session read-only, and nobody acting as themselves (ADR-0206 §4)', async () => {
    const u = await makeUser();
    // No caller says so any more: a session is read-only because it is a session. The setup scope is gone (ADR-0162).
    expect((await resolver.resolve(String(u._id), 'sa-1')).impersonationReadOnly).toBe(true);
    expect((await resolver.resolve(String(u._id), 'sa-1', true)).impersonationReadOnly).toBe(true);
    expect((await resolver.resolve(String(u._id))).impersonationReadOnly).toBe(false);
  });

  /*
   * **A Super Admin inside a KPM** (ADR-0268 §3; P19.17 F2): `X-Kpm-Id`, honoured for a Super Admin acting as themselves
   * and nobody else. The context is the KPM's Owner's (`can()`), writable, with no membership and the Super Admin as the
   * actor — never the support session, which stays a member's and read-only.
   */
  describe('ADR-0268 §3 the KPM a Super Admin enters', () => {
    async function office(over: Record<string, unknown> = {}) {
      return mongoose.model(Kpm.name).create({ companyId: 'c1', code: '0417', branchName: 'BSD', ...over });
    }

    it('places a Super Admin inside the KPM the header names, writable and as themselves', async () => {
      const sa = await makeUser({ platformRole: 'super_admin' });
      const kpm = await office();
      const ctx = await resolver.resolve(String(sa._id), null, false, null, String(kpm._id));
      expect(ctx.isSuperAdminInKpm).toBe(true);
      expect(ctx.kpmId).toBe(String(kpm._id));
      expect(ctx.membership).toBeNull();
      expect(ctx.impersonationReadOnly).toBe(false);
      expect(ctx.auditActors).toEqual({ actorUserId: String(sa._id), effectiveUserId: String(sa._id) });
    });

    it('sets aside a membership the Super Admin holds elsewhere, and keeps their password state', async () => {
      const sa = await makeUser({ platformRole: 'super_admin', mustChangePassword: true });
      const theirs = await office({ code: '0001' });
      await join(String(sa._id), String(theirs._id));
      const entered = await office({ code: '0002' });
      const ctx = await resolver.resolve(String(sa._id), null, false, null, String(entered._id));
      expect(ctx.kpmId).toBe(String(entered._id));
      expect(ctx.membership).toBeNull();
      expect(ctx.mustChangePassword).toBe(true);
    });

    it('enters a suspended or archived KPM: the Super Admin is who mends it', async () => {
      const sa = await makeUser({ platformRole: 'super_admin' });
      for (const status of ['suspended', 'archived']) {
        const kpm = await office({ code: `09${status.length}`, status });
        await expect(resolver.resolve(String(sa._id), null, false, null, String(kpm._id)))
          .resolves.toMatchObject({ isSuperAdminInKpm: true });
      }
    });

    it('refuses a KPM that does not exist, a deleted one and a malformed id, 404 — never a cast error', async () => {
      const sa = await makeUser({ platformRole: 'super_admin' });
      const deleted = await office({ deletedAt: new Date() });
      for (const id of [String(new mongoose.Types.ObjectId()), String(deleted._id), 'not-an-id', '{"$ne":null}']) {
        await expect(resolver.resolve(String(sa._id), null, false, null, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
    });

    it('ignores the header for anybody else: a member, somebody in no KPM, and a support session', async () => {
      const kpm = await office();
      const other = await office({ code: '0999' });
      const member = await makeUser();
      await join(String(member._id), String(kpm._id));
      const mine = await resolver.resolve(String(member._id), null, false, null, String(other._id));
      expect(mine.kpmId).toBe(String(kpm._id));
      expect(mine.isSuperAdminInKpm).toBe(false);

      const newcomer = await makeUser();
      expect((await resolver.resolve(String(newcomer._id), null, false, null, String(other._id))).kpmId).toBeNull();

      const session = await resolver.resolve(String(member._id), 'sa-1', false, null, String(other._id));
      expect(session.kpmId).toBe(String(kpm._id));
      expect(session.impersonationReadOnly).toBe(true);
      expect(session.isSuperAdminInKpm).toBe(false);
    });

    it('without the header a Super Admin is in no KPM, as before', async () => {
      const sa = await makeUser({ platformRole: 'super_admin' });
      const ctx = await resolver.resolve(String(sa._id));
      expect(ctx.kpmId).toBeNull();
      expect(ctx.isSuperAdminInKpm).toBe(false);
    });
  });
});
