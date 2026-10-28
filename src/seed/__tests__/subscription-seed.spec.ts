import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { ContextResolver } from '@/modules/auth/context-resolver';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { countLeadersUsed } from '@/modules/org/leader-limit';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { subscriptionStateOf } from '@/modules/tenants/subscription';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo, type SeedResult } from '../demo';
import { planSubscriptions, SUBSCRIPTION_OFFICES } from '../subscription-fixture';
import { COHORT_HIRES } from '../cohort-fixture';

/**
 * **Subscriptions and the leader limit, seeded** (Phase 13.2, *Seed*; `subscription-fixture.ts`), run as
 * the command runs it and read back through the product's own rules: the ended state from the office's
 * today, *Leaders used* through the one count, the refusal through `ContextResolver`, and a promotion
 * through `RoleChangeService`.
 *
 * Run at 03:00 on a Monday in Jakarta, still Sunday in UTC — the day the office's zone and the server's
 * disagree, so a date taken from the server would be a day early.
 */
const RUN_MS = 240_000;
const TZ = 'Asia/Jakarta';
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

describe('the subscription seed', () => {
  const clock = new FixedClock(new Date('2026-10-04T20:00:00Z'));
  const today = clock.localDateFor(TZ);
  const plan = planSubscriptions(today);
  let first: SeedResult;
  let resolver: ContextResolver;
  let roles: RoleChangeService;
  let members: MembershipRepository;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    first = await seedDemo({ clock, log: quiet });

    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const users = mongoose.model(User.name, UserSchema);
    const memberModel = mongoose.model(Membership.name, MembershipSchema);
    members = new MembershipRepository(memberModel as never);
    resolver = new ContextResolver(users as never, kpms as never, memberModel as never, clock);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const history = new MembershipHistoryRepository(
      mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never,
    );
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never, kpms as never, audit, clock,
    );
    const hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    roles = new RoleChangeService(
      members, hierarchy, history, users as never, audit, { send: async () => undefined } as never, clock,
    );
  }, RUN_MS);
  afterAll(stopMongo);

  const office = async (code: string) => (await col('kpms').findOne({ code }))!;
  const userIdOf = async (email: string) => String((await col('users').findOne({ email }))!._id);
  const used = async (code: string) => countLeadersUsed(
    members, RequestContext.tenantRead(String((await office(code))._id), 'seed-spec'),
  );

  it('dates every subscription from the office’s today, the Monday in Jakarta', () => {
    expect(today).toBe('2026-10-05');
    expect(plan['0417'].endDate).toBe('2027-01-05');
    expect(plan['0555'].endDate).toBe('2026-10-10');
    expect(plan['0601'].endDate).toBe('2026-09-25');
    expect(plan['0602'].endDate).toBe('2026-10-02');
  });

  it('0417: three months to run, Rp 350,000 a leader, 9 of 10 leaders used', async () => {
    const kpm = await office('0417');
    expect(kpm.subscription).toEqual(plan['0417']);
    expect(kpm.subscription).toMatchObject({ pricePerLeaderMinor: 350_000_00, maxLeaders: 10, keepActiveAfterEnd: false });
    expect(subscriptionStateOf(kpm as never, clock)).toBe('active');
    // The Owner, the Admin, Agus, Sari, Dewi and Arief — and since Phase 18's reporting fixture, the two new ABs,
    // Yosef and Satria, and Winda, Yosef's AAB.
    expect(await used('0417')).toBe(9);
  });

  it('0555: five days to run and no limit — the list’s near end', async () => {
    const kpm = await office('0555');
    expect(kpm.subscription).toMatchObject({ endDate: plan['0555'].endDate, maxLeaders: null });
    expect(subscriptionStateOf(kpm as never, clock)).toBe('active');
  });

  it('0601: ended ten days ago, not kept active — its Owner and its Agent are refused with the page’s code', async () => {
    const kpm = await office('0601');
    expect(String(kpm._id)).toBe(SUBSCRIPTION_OFFICES['0601']._id);
    expect(subscriptionStateOf(kpm as never, clock)).toBe('ended');
    for (const email of ['owner@kpm0601.test', 'agent@kpm0601.test']) {
      await expect(resolver.resolve(await userIdOf(email))).rejects.toMatchObject({
        code: 'TENANT_SUBSCRIPTION_ENDED',
        details: { endDate: plan['0601'].endDate, kpmCode: '0601', branch: 'Cikarang Branch' },
      });
    }
  });

  it('0602: ended three days ago and kept active, at its limit of 2 — the Owner is served and refused Joko’s promotion', async () => {
    const kpm = await office('0602');
    expect(subscriptionStateOf(kpm as never, clock)).toBe('ended_kept_active');
    expect(kpm.subscription).toMatchObject({ maxLeaders: 2, keepActiveAfterEnd: true });
    expect(await used('0602')).toBe(2);

    const owner = await resolver.resolve(await userIdOf('owner@kpm0602.test'));
    expect(owner.membership?.isKpmOwner).toBe(true);
    const joko = await col('memberships').findOne({ userId: await userIdOf('agent@kpm0602.test') });
    await expect(roles.change(owner, String(joko!._id), 'aab')).rejects.toMatchObject({
      code: 'LEADER_LIMIT_REACHED', details: { maxLeaders: 2, leadersUsed: 2 },
    });
  });

  it('P18.8-T2 0603: a limit of 10 and 13 used — three approved past it, a fourth waiting (ADR-0157)', async () => {
    const kpm = await office('0603');
    expect(String(kpm._id)).toBe(SUBSCRIPTION_OFFICES['0603']._id);
    expect(kpm.subscription).toEqual(plan['0603']);
    expect(kpm.subscription).toMatchObject({ maxLeaders: 10, pricePerLeaderMinor: 350_000_00 });
    expect(await used('0603')).toBe(13);

    const requests = await col('leaderLimitRequests').find({ kpmId: String(kpm._id) }).sort({ createdAt: 1 }).toArray();
    const nameOf = async (membershipId: string) => {
      const m = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(membershipId) });
      return (await col('users').findOne({ _id: new mongoose.Types.ObjectId(m!.userId as string) }))!.fullName;
    };
    const named = await Promise.all(requests.map(async (r) => [await nameOf(r.subjectMembershipId), r.status]));
    expect(named).toEqual([
      ['Irfan Hakim', 'approved'], ['Siska Amelia', 'approved'], ['Fajar Nugroho', 'approved'], ['Rizky Ramadhan', 'pending'],
    ]);
    // Each approved act carried out: the AAB they are, and the promotion on the role change log.
    for (const r of requests.filter((x) => x.status === 'approved')) {
      const m = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(r.subjectMembershipId) });
      expect([m!.orgLevelCode, m!.role]).toEqual(['AAB', 'aab']);
      expect(await col('membershipHistory').findOne({ membershipId: r.subjectMembershipId, eventType: 'role_changed', validTo: null }))
        .toMatchObject({ fromRole: 'agent', toRole: 'aab', reason: 'Leads the weekend team already' });
      expect(r.decidedByUserId).toBe(await userIdOf('superadmin@agencyboost.test'));
    }
    // Rizky waits: still an Agent, the Owner's ask open.
    const rizky = await col('memberships').findOne({ userId: await userIdOf('agent@kpm0603.test') });
    expect(rizky!.role).toBe('agent');
    expect(requests.at(-1)).toMatchObject({ subjectMembershipId: String(rizky!._id), toOrgLevelCode: 'AAB' });
  });

  it('every other office has no subscription and behaves as before (T3 AC-10)', async () => {
    const rest = await col('kpms').find({ code: { $nin: ['0417', '0555', '0601', '0602', '0603'] } }).toArray();
    expect(rest.length).toBeGreaterThan(0);
    for (const kpm of rest) expect(kpm.subscription ?? null).toBeNull();
  });

  it('the new offices add no hire to the activation demo: everybody in them joined over six months ago', () => {
    // The activation fixture's nine, and Phase 18.1's cohort of 0417's graduated hires (`cohort-fixture.ts`).
    // And P18.96-T6's two new hires (`activation-3m-fixture.ts`), Lukman and Tari, in 0417.
    expect(first.written.activationProgress).toBe(9 + COHORT_HIRES.length + 2);
  });

  it('a second run on the same day writes nothing, and keeps a subscription a walk edited', async () => {
    await col('kpms').updateOne({ code: '0601' }, { $set: { 'subscription.keepActiveAfterEnd': true } });
    const second = await seedDemo({ clock, log: quiet });
    expect(second.written).toEqual({});
    expect((await office('0601')).subscription.keepActiveAfterEnd).toBe(true);
  }, RUN_MS);
});
