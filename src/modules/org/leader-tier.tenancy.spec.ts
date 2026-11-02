import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { HierarchyService } from './hierarchy.service';
import { countLeadersUsed, countLeadersUsedPerOffice } from './leader-limit';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { HierarchyRole, Membership, MembershipSchema } from './membership.schema';
import { MembershipHistoryRepository } from './org.repositories';
import { RoleChangeService } from './role-change.service';

const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();
const NOW = new Date('2026-10-26T03:00:00Z');

/** The office's own context, for a write made on its behalf. */
const office = (kpmId: string) => RequestContext.superAdminInTenant('sa-1', kpmId);

/**
 * **A rung's leader tier decides who leads** (P18.8-T1 AC-3 to AC-5, ADR-0156): over a real database, a member's
 * class is the tier's of the rung they are placed on — on creation and on a role change — whatever the rung is
 * called; the class is what a grant reads and what *Leaders used* counts; and the leader limit holds for a leader
 * on a rung the company named itself. KPM A's company has a custom ladder beside the default codes; KPM B's company
 * has the default ladder alone, and neither office's reads reach the other's.
 */
describe('P18.8-T1 — the leader tier, where a member is placed', () => {
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let roles: RoleChangeService;
  let orgLevels: OrgLevelService;
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let history: mongoose.Model<MembershipHistory>;
  let companyA: string;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    history = mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never;
    const historyRepo = new MembershipHistoryRepository(history as never);
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    users = mongoose.model(User.name, UserSchema) as never;
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never, kpms as never, audit, clock, members,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, historyRepo, clock, orgLevels);
    roles = new RoleChangeService(
      members, hierarchy, historyRepo, users as never, audit, { send: async () => undefined } as never, clock,
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const companies = mongoose.model(Company.name);
    companyA = String((await companies.create({ name: 'Allianz Life', slug: `allianz-${Math.random()}` }))._id);
    const companyB = String((await companies.create({ name: 'Prudential', slug: `prudential-${Math.random()}` }))._id);
    await seedLadder(companyA);
    await seedLadder(companyB);
    // Allianz's own rungs: its leaders are SM and UM, and an FA leads nobody.
    for (const [code, label, displayOrder, leaderTier] of [
      ['FA', 'Financial Adviser', 4, null], ['UM', 'Unit Manager', 5, 'associate'], ['SM', 'Senior Manager', 6, 'senior'],
    ] as const) {
      await orgLevels.create(RequestContext.platform('root'), { companyId: companyA, code, label, displayOrder, leaderTier });
    }
    for (const [id, companyId, code] of [[KPM_A, companyA, '0701'], [KPM_B, companyB, '0417']]) {
      await kpms.create({
        _id: id, companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
    }
  });

  async function person(companyId: string) {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `${7000 + seq}`,
    });
    return String(u._id);
  }

  /**
   * Somebody placed on a rung by its code. `role` is the placement's lookup key — the rung's code lower-cased — and
   * typed as the class only because the three paths that exist name the default codes; the class written is the
   * rung's tier's, never this.
   */
  async function place(kpmId: string, rung: string, leaderId: string | null = null, status: 'active' | 'pending' = 'active') {
    const m = await hierarchy.create(office(kpmId), {
      userId: await person(kpmId === KPM_A ? companyA : String((await kpms.findById(kpmId))!.companyId)),
      role: rung.toLowerCase() as HierarchyRole, leaderId, status,
    });
    return m;
  }

  /** The context somebody's own sign-in would carry, read off their row. */
  async function as(kpmId: string, membershipId: string) {
    const row = await members.findById(office(kpmId), membershipId);
    return new RequestContext(row!.userId, 'none', {
      membershipId, kpmId: row!.kpmId, orgLevelCode: row!.orgLevelCode, hierarchyRole: row!.role,
      status: row!.status as 'active', isKpmOwner: false, isKpmAdmin: false, directCount: row!.directCounts?.total ?? 0,
    });
  }

  it('AC-3 a member placed on a rung takes its tier’s class, whatever the rung is called', async () => {
    const sm = await place(KPM_A, 'SM');
    const um = await place(KPM_A, 'UM', String(sm._id));
    const fa = await place(KPM_A, 'FA', String(um._id));
    expect([sm, um, fa].map((m) => [m.orgLevelCode, m.role])).toEqual([['SM', 'ab'], ['UM', 'aab'], ['FA', 'agent']]);
    // The first edge records the class too, as every later one does.
    const joined = await history.find({ eventType: 'joined', membershipId: String(sm._id) }).lean().exec();
    expect(joined.map((h) => h.toRole)).toEqual(['ab']);
    // The default ladder's rungs, unchanged: the class is the code lower-cased because that is what their tiers give.
    expect((await place(KPM_B, 'AB')).role).toBe('ab');
    expect((await place(KPM_B, 'AAB')).role).toBe('aab');
  });

  it('AC-3 a role change writes the target rung’s class, and judges the change by it', async () => {
    // The Super Admin marked Allianz's AAB *Not a leader* before anybody stood on it.
    const aab = (await orgLevels.list(RequestContext.platform('root'), companyA)).find((l) => l.code === 'AAB')!;
    await orgLevels.update(RequestContext.platform('root'), aab.orgLevelId, { leaderTier: null });

    const leader = await place(KPM_A, 'SM');
    const agent = await place(KPM_A, 'AGENT', String(leader._id));
    await roles.change(await as(KPM_A, String(leader._id)), String(agent._id), 'aab');

    const moved = await members.findById(office(KPM_A), String(agent._id));
    expect([moved!.orgLevelCode, moved!.role]).toEqual(['AAB', 'agent']);
    const edge = await history.findOne({ eventType: 'role_changed', membershipId: String(agent._id) }).lean().exec();
    expect([edge!.fromRole, edge!.toRole]).toEqual(['agent', 'agent']);
  });

  it('AC-4 a hierarchy grant reads the class: the Senior Manager holds an AB’s rights, the adviser an Agent’s', async () => {
    const sm = await place(KPM_A, 'SM');
    const fa = await place(KPM_A, 'FA', String(sm._id));
    expect(can(await as(KPM_A, String(sm._id)), 'leader_request:approve')).toBe(true);
    expect(can(await as(KPM_A, String(fa._id)), 'leader_request:approve')).toBe(false);
  });

  it('AC-5 Leaders used counts the leader classes on any rung, active only, office by office', async () => {
    const sm = await place(KPM_A, 'SM');
    await place(KPM_A, 'UM', String(sm._id));
    await place(KPM_A, 'FA', String(sm._id));
    await place(KPM_A, 'UM', String(sm._id), 'pending');
    await place(KPM_B, 'AB');

    expect(await countLeadersUsed(members, office(KPM_A))).toBe(2);
    expect(await countLeadersUsed(members, office(KPM_B))).toBe(1);
    const perOffice = await countLeadersUsedPerOffice(members, RequestContext.platform('root'), [KPM_A, KPM_B]);
    expect(Object.fromEntries(perOffice)).toEqual({ [KPM_A]: 2, [KPM_B]: 1 });
  });

  it('AC-5 the leader limit refuses a leader on a custom rung, and never a member of no tier', async () => {
    const sm = await place(KPM_A, 'SM');
    await kpms.updateOne({ _id: KPM_A }, {
      $set: {
        subscription: {
          startDate: null, endDate: null, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: 1, keepActiveAfterEnd: false,
        },
      },
    });
    await expect(place(KPM_A, 'UM', String(sm._id))).rejects.toMatchObject({ code: 'LEADER_LIMIT_REACHED' });
    await expect(place(KPM_A, 'FA', String(sm._id))).resolves.toMatchObject({ role: 'agent' });
    // A promotion onto a leader tier takes a seat; there is none.
    const fa = await place(KPM_A, 'FA', String(sm._id));
    await expect(hierarchy.setLevel(office(KPM_A), String(fa._id), 'sm' as HierarchyRole)).rejects.toMatchObject({
      code: 'LEADER_LIMIT_REACHED',
    });
  });

  it('AC-5 the roster import reads each office’s own ladder for which rungs lead, never another company’s', async () => {
    expect(Object.fromEntries(await hierarchy.rungClassesOf(KPM_A))).toEqual({
      AGENT: 'agent', AAB: 'aab', AB: 'ab', FA: 'agent', UM: 'aab', SM: 'ab',
    });
    expect(Object.fromEntries(await hierarchy.rungClassesOf(KPM_B))).toEqual({ AGENT: 'agent', AAB: 'aab', AB: 'ab' });
  });

  it('AC-2 once somebody stands on the custom rung, its tier is fixed', async () => {
    await place(KPM_A, 'SM');
    const sm = (await orgLevels.list(RequestContext.platform('root'), companyA)).find((l) => l.code === 'SM')!;
    await expect(orgLevels.update(RequestContext.platform('root'), sm.orgLevelId, { leaderTier: 'associate' }))
      .rejects.toMatchObject({ code: 'ORG_LEVEL_TIER_IN_USE', details: { members: 1 } });
  });
});
