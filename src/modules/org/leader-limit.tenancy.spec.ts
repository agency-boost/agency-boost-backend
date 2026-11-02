import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { PasswordService } from '@/modules/auth/password.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { ROSTER_TEMPLATE_HEADER } from '@/modules/tenants/roster-csv';
import { RosterImportService } from '@/modules/tenants/roster-import.service';
import { TenantService } from '@/modules/tenants/tenant.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { ApprovalsService } from './approvals.service';
import { HierarchyService } from './hierarchy.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { countLeadersUsed, countLeadersUsedPerOffice, withLeaderSeat } from './leader-limit';
import { LeaderCodeService } from './leader-code.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OnboardingService } from './onboarding.service';
import { JoinRequestRepository, MembershipHistoryRepository } from './org.repositories';
import { RoleChangeService } from './role-change.service';

const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();
const NOW = new Date('2026-10-08T03:00:00Z');

/** The office's own context, for a write made on its behalf. */
const office = (kpmId: string) => RequestContext.superAdminInTenant('sa-1', kpmId);

/**
 * **The leader limit** (ADR-0113, P13.2-T4): what *Leaders used* counts (AC-1), where it is refused
 * (AC-2), on every path and for every role that can make a leader (AC-3), in the roster import (AC-4),
 * under a race (AC-6), when lowered (AC-7), on the paths that are never refused (AC-8), and never across
 * two offices (AC-9).
 */
describe('the leader limit', () => {
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let roles: RoleChangeService;
  let onboarding: OnboardingService;
  let leaderCodes: LeaderCodeService;
  let approvals: ApprovalsService;
  let roster: RosterImportService;
  let tenants: TenantService;
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let companyId: string;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    const memberModel = mongoose.model(Membership.name, MembershipSchema);
    const historyRepo = new MembershipHistoryRepository(
      mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never,
    );
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    users = mongoose.model(User.name, UserSchema) as never;
    const companies = mongoose.model(Company.name, CompanySchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const notifications = { send: async () => undefined };
    const requests = new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never);
    members = new MembershipRepository(memberModel as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      companies as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, historyRepo, clock, orgLevels);
    roles = new RoleChangeService(members, hierarchy, historyRepo, users as never, audit, notifications as never, clock);
    onboarding = new OnboardingService(
      members, hierarchy, kpms as never, companies as never, users as never, requests, audit,
      notifications as never, clock,
    );
    leaderCodes = new LeaderCodeService(
      members, hierarchy, requests, kpms as never, companies as never, users as never, audit,
      notifications as never, clock,
    );
    approvals = new ApprovalsService(
      members, hierarchy, requests, historyRepo, users as never, audit, notifications as never, clock,
    );
    roster = new RosterImportService(
      members, hierarchy, kpms as never, users as never, new PasswordService(), audit, clock,
    );
    // Only what assigning an Owner reads is real; the rest are inert.
    const Service = TenantService as unknown as new (...deps: unknown[]) => TenantService;
    tenants = new Service(
      kpms, companies, users, mongoose.model(KpmRequest.name, KpmRequestSchema), audit, clock,
      hierarchy, members, {}, {}, {}, {}, {},
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await companies().create({ name: 'Prudential', slug: `prudential-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
    for (const [id, code] of [[KPM_A, '0602'], [KPM_B, '0555']]) {
      await kpms.create({
        _id: id, companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
    }
  });

  const companies = () => mongoose.model(Company.name);

  async function limit(kpmId: string, maxLeaders: number | null) {
    await kpms.updateOne({ _id: kpmId }, {
      $set: {
        subscription: {
          startDate: null, endDate: null, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders,
          keepActiveAfterEnd: false,
        },
      },
    });
  }

  async function person(email?: string) {
    seq += 1;
    const u = await users.create({
      email: email ?? `p${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `PRU-${5000 + seq}`,
    });
    return String(u._id);
  }

  async function join(kpmId: string, role: 'ab' | 'aab' | 'agent', leaderId: string | null = null) {
    const m = await hierarchy.create(office(kpmId), { userId: await person(), role, leaderId, status: 'active' });
    return String(m._id);
  }

  /** The context somebody's own sign-in would carry, read off their row. */
  async function as(membershipId: string, over: { owner?: boolean; admin?: boolean } = {}) {
    const row = await members.findById(office(KPM_A), membershipId);
    return new RequestContext(row!.userId, 'none', {
      membershipId, kpmId: row!.kpmId, orgLevelCode: row!.orgLevelCode, hierarchyRole: row!.role,
      status: row!.status as 'active', isKpmOwner: over.owner ?? false, isKpmAdmin: over.admin ?? false,
      directCount: row!.directCounts?.total ?? 0,
    }).withReader(SOURCE_READER); // the API's English, as asserted below: nobody's choice reads Indonesian (P18.98-T4)
  }

  const used = (kpmId: string) => countLeadersUsed(members, office(kpmId));
  const LIMIT = { code: 'LEADER_LIMIT_REACHED' };

  describe('AC-1: Leaders used counts the active ABs and AABs, the Owner and an Admin included', () => {
    it.each<[string, number, 'ab' | 'aab' | 'agent', Record<string, unknown>]>([
      ['an active AB', 1, 'ab', {}],
      ['an active AAB', 1, 'aab', {}],
      ['an active Agent', 0, 'agent', {}],
      ['a pending AAB', 0, 'aab', { status: 'pending' }],
      ['a removed AB', 0, 'ab', { status: 'removed' }],
      ['a deleted AAB', 0, 'aab', { deletedAt: NOW }],
      ['an Admin at AAB', 1, 'aab', { 'adminAccess.isKpmAdmin': true }],
      ['an Admin at Agent', 0, 'agent', { 'adminAccess.isKpmAdmin': true }],
    ])('%s counts %i', async (_what, expected, role, change) => {
      const id = await join(KPM_A, role);
      if (Object.keys(change).length) await mongoose.model(Membership.name).updateOne({ _id: id }, { $set: change });
      expect(await used(KPM_A)).toBe(expected);
    });

    it('counts the Owner, made the root AB when assigned', async () => {
      const ownerId = await person('owner@kpm0602.test');
      await tenants.assignOwner(RequestContext.platform('sa-1'), KPM_A, { userId: ownerId });
      expect(await used(KPM_A)).toBe(1);
    });

    it('AC-9: one office’s count never includes another’s members, scoped or per office', async () => {
      await join(KPM_A, 'ab');
      await join(KPM_B, 'ab');
      await join(KPM_B, 'aab');
      expect(await used(KPM_A)).toBe(1);
      expect(await used(KPM_B)).toBe(2);
      const perOffice = await countLeadersUsedPerOffice(members, RequestContext.platform('sa-1'), [KPM_A, KPM_B]);
      expect([perOffice.get(KPM_A), perOffice.get(KPM_B)]).toEqual([1, 2]);
    });

    it('the per-office count is the Super Admin’s alone', async () => {
      const member = new RequestContext('u-1', 'none', null, null, KPM_A);
      await expect(countLeadersUsedPerOffice(members, member, [KPM_A])).rejects.toThrow();
    });
  });

  describe('AC-2: refused in create and setLevel', () => {
    it('create: an active AB past the limit is 409 with the maximum and the count, and nothing is written', async () => {
      await limit(KPM_A, 1);
      await join(KPM_A, 'ab');
      const before = (await kpms.findById(KPM_A).lean().exec())!.counters.nextMemberSeq;
      await expect(join(KPM_A, 'aab')).rejects.toMatchObject({
        ...LIMIT, details: { maxLeaders: 1, leadersUsed: 1 },
      });
      expect(await used(KPM_A)).toBe(1);
      // The refusal came before a join number was spent.
      expect((await kpms.findById(KPM_A).lean().exec())!.counters.nextMemberSeq).toBe(before);
    });

    it('create: served below the limit, and an Agent is never refused at it', async () => {
      await limit(KPM_A, 2);
      await join(KPM_A, 'ab');
      await join(KPM_A, 'aab');
      await expect(join(KPM_A, 'agent')).resolves.toBeDefined();
      expect(await used(KPM_A)).toBe(2);
    });

    it('setLevel: an Agent to AAB at the limit is refused; AB to AAB and AAB to AB are served', async () => {
      await limit(KPM_A, 2);
      const ab = await join(KPM_A, 'ab');
      const aab = await join(KPM_A, 'aab', ab);
      const agent = await join(KPM_A, 'agent', ab);
      await expect(hierarchy.setLevel(office(KPM_A), agent, 'aab')).rejects.toMatchObject({
        ...LIMIT, details: { maxLeaders: 2, leadersUsed: 2 },
      });
      await expect(hierarchy.setLevel(office(KPM_A), aab, 'ab')).resolves.toMatchObject({ role: 'ab' });
      await expect(hierarchy.setLevel(office(KPM_A), aab, 'aab')).resolves.toMatchObject({ role: 'aab' });
      expect(await used(KPM_A)).toBe(2);
    });

    it('no maximum, no check', async () => {
      await limit(KPM_A, null);
      for (let i = 0; i < 4; i += 1) await join(KPM_A, 'ab');
      expect(await used(KPM_A)).toBe(4);
    });

    it('leaves the lease free after a refusal, so the next write is not kept waiting', async () => {
      await limit(KPM_A, 1);
      await join(KPM_A, 'ab');
      await expect(join(KPM_A, 'ab')).rejects.toMatchObject(LIMIT);
      expect((await kpms.findById(KPM_A).lean().exec())!.leaderLimitLock).toBeNull();
    });
  });

  describe('AC-3: per path and per role', () => {
    let owner: string;
    let sub: string;
    let aab: string;
    let agentOfAb: string;
    let agentOfAab: string;

    beforeEach(async () => {
      owner = await join(KPM_A, 'ab');
      sub = await join(KPM_A, 'ab', owner);
      aab = await join(KPM_A, 'aab', sub);
      agentOfAb = await join(KPM_A, 'agent', sub);
      agentOfAab = await join(KPM_A, 'agent', aab);
    });

    it.each<[string, () => Promise<RequestContext>, () => string]>([
      ['the Owner', () => as(owner, { owner: true }), () => agentOfAb],
      ['an Admin', () => as(owner, { admin: true }), () => agentOfAb],
      ['an AB, their direct report', () => as(sub), () => agentOfAb],
      ['an AAB, their direct report', () => as(aab), () => agentOfAab],
    ])('a role change by %s is refused at the limit and served below it', async (_who, actor, target) => {
      await limit(KPM_A, 3);
      await expect(roles.change(await actor(), target(), 'aab')).rejects.toMatchObject(LIMIT);
      expect((await members.findById(office(KPM_A), target()))!.role).toBe('agent');

      await limit(KPM_A, 4);
      await roles.change(await actor(), target(), 'aab');
      expect((await members.findById(office(KPM_A), target()))!.role).toBe('aab');
    });

    it('assigning an Owner who would be a new AB is refused at the limit, and writes nothing', async () => {
      await limit(KPM_A, 3);
      const newcomer = await person('new-owner@kpm0602.test');
      await expect(
        tenants.assignOwner(RequestContext.platform('sa-1'), KPM_A, { userId: newcomer }),
      ).rejects.toMatchObject(LIMIT);
      expect((await kpms.findById(KPM_A).lean().exec())!.ownerUserId ?? null).toBeNull();
      expect(await mongoose.model(Membership.name).countDocuments({ userId: newcomer })).toBe(0);
    });

    it('assigning one already at a leader rung is served at the limit', async () => {
      await limit(KPM_A, 3);
      const sitting = (await members.findById(office(KPM_A), sub))!.userId;
      await expect(
        tenants.assignOwner(RequestContext.platform('sa-1'), KPM_A, { userId: sitting }),
      ).resolves.toMatchObject({ ownerUserId: sitting, leadersUsed: 3 });
    });
  });

  describe('AC-4: the roster import', () => {
    const HEADER = ROSTER_TEMPLATE_HEADER;

    it('the preview names each row past the limit by its line and role column, so nothing commits', async () => {
      await limit(KPM_A, 2);
      await join(KPM_A, 'ab');
      const file = [
        HEADER,
        'Ana,ana@kpm.test,9001,aab,,1990-01-01,2020-01,full-time,female',
        'Budi,budi@kpm.test,9002,agent,9001,1990-01-01,2020-01,full-time,female',
        'Citra,citra@kpm.test,9003,ab,,1990-01-01,2020-01,full-time,female',
        'Dodi,dodi@kpm.test,9004,aab,9003,1990-01-01,2020-01,full-time,female',
      ].join('\n');

      // Read in the API's English, as asserted: nobody's choice is Bahasa Indonesia since P18.98-T4's exit.
      const asSa = await roster.preview(RequestContext.platform('sa-1').withReader(SOURCE_READER), KPM_A, file);
      expect(asSa.willCreate).toBe(0);
      expect(asSa.issues.map((i) => [i.line, i.column])).toEqual([[4, 'role'], [5, 'role']]);
      expect(asSa.issues[0].message).toMatch(/limit is 2/);
      expect(asSa.issues[0].message).toMatch(/Edit subscription on the offices list/);
      expect(asSa.issues[0].message).not.toMatch(/LEADER_LIMIT_REACHED/);

      const ownerCtx = await as((await members.find(office(KPM_A), { role: 'ab' }))[0].id, { owner: true });
      const asOwner = await roster.preview(ownerCtx, KPM_A, file);
      // P18.8-T2 AC-9 (ADR-0157 §5): a row past the limit is still refused, and the way through that asks is named.
      expect(asOwner.issues[0].message).toMatch(/Import them as an Agent, then promote them on their page/);
      expect(asOwner.issues[0].message).toMatch(/asks AgencyBoost to approve it/);

      // Committed anyway, against the preview's advice: refused whole, with the limit's own code.
      await expect(roster.commit(RequestContext.platform('sa-1'), KPM_A, file)).rejects.toMatchObject(LIMIT);
      expect(await used(KPM_A)).toBe(1);
      expect(await users.countDocuments({ email: 'ana@kpm.test' })).toBe(0);
    });

    it('the commit refuses with the code when the office filled up after the preview, creating nobody', async () => {
      await limit(KPM_A, 2);
      const root = await join(KPM_A, 'ab');
      const file = [HEADER, 'Ana,ana@kpm.test,9001,aab,,1990-01-01,2020-01,full-time,female'].join('\n');
      expect((await roster.preview(RequestContext.platform('sa-1'), KPM_A, file)).issues).toEqual([]);

      await join(KPM_A, 'aab', root);
      await expect(roster.commit(RequestContext.platform('sa-1'), KPM_A, file)).rejects.toMatchObject({
        ...LIMIT, details: { maxLeaders: 2, leadersUsed: 2 },
      });
      expect(await users.countDocuments({ email: 'ana@kpm.test' })).toBe(0);
    });
  });

  describe('exit review: a roster row refused mid-commit leaves no account behind', () => {
    const HEADER = ROSTER_TEMPLATE_HEADER;

    it('the office fills while the loop runs: the refused row’s account is never made', async () => {
      await limit(KPM_A, 3);
      const root = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', root);

      // A promotion in another tab, landing between the first row and the second.
      let hashed = 0;
      const passwords = {
        hash: async (plain: string) => {
          hashed += 1;
          if (hashed === 2) await hierarchy.setLevel(office(KPM_A), agent, 'aab');
          return `hash:${plain}`;
        },
      };
      const racing = new RosterImportService(
        members, hierarchy, kpms as never, users as never, passwords as never,
        new AuditService(mongoose.model(AuditLog.name) as never), new FixedClock(NOW),
      );
      const file = [
        HEADER,
        'Ana,ana@kpm.test,9001,ab,,1990-01-01,2020-01,full-time,female',
        'Budi,budi@kpm.test,9002,aab,,1990-01-01,2020-01,full-time,female',
      ].join('\n');

      await expect(racing.commit(RequestContext.platform('sa-1'), KPM_A, file)).rejects.toMatchObject({
        ...LIMIT, details: { maxLeaders: 3, leadersUsed: 3 },
      });
      expect(await users.countDocuments({ email: 'ana@kpm.test' })).toBe(1);
      // The refused row: no account, so the same file's row imports once the limit is raised.
      expect(await users.countDocuments({ email: 'budi@kpm.test' })).toBe(0);
      expect(await used(KPM_A)).toBe(3);
    });
  });

  describe('AC-6: the race', () => {
    it('two promotions at one below the limit, at once: exactly one succeeds', async () => {
      await limit(KPM_A, 2);
      const ab = await join(KPM_A, 'ab');
      const one = await join(KPM_A, 'agent', ab);
      const two = await join(KPM_A, 'agent', ab);

      const results = await Promise.allSettled([
        hierarchy.setLevel(office(KPM_A), one, 'aab'),
        hierarchy.setLevel(office(KPM_A), two, 'aab'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject(LIMIT);
      expect(await used(KPM_A)).toBe(2);
    });

    it('five leaders made at once into two places: exactly two are', async () => {
      await limit(KPM_A, 2);
      const people = await Promise.all([1, 2, 3, 4, 5].map(() => person()));
      const results = await Promise.allSettled(people.map((userId) =>
        hierarchy.create(office(KPM_A), { userId, role: 'aab', leaderId: null, status: 'active' })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(await used(KPM_A)).toBe(2);
    });
  });

  /*
   * **A pending member promoted is held to the limit when they are made active** (P13.2 exit review).
   * *Leaders used* counts active members, so promoting a pending one passed, and the approval, the tag
   * or the Owner's assignment that made them active asked nobody: two promoted at one below the limit
   * and both approved made the office one over. The activation takes the seat now.
   */
  describe('exit review: a pending member promoted, then made active', () => {
    let root: string;
    let rootCtx: RequestContext;
    let first: RequestContext;
    let second: RequestContext;

    async function registered() {
      const userId = await person();
      await onboarding.registerKpm(new RequestContext(userId, 'none', null), KPM_A);
      const row = await mongoose.model(Membership.name).findOne({ userId }).exec();
      return new RequestContext(userId, 'none', {
        membershipId: String(row!._id), kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
        status: 'pending', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
    }

    async function requestOf(joiner: RequestContext) {
      await onboarding.requestLeader(joiner, root);
      return (await approvals.inbox(rootCtx)).find((r) => r.membershipId === joiner.membershipId)!;
    }

    const row = async (who: RequestContext) => members.findById(office(KPM_A), who.membershipId!);

    beforeEach(async () => {
      // Limit 3, two used: one below it.
      await limit(KPM_A, 3);
      root = await join(KPM_A, 'ab');
      await join(KPM_A, 'aab', root);
      rootCtx = await as(root, { owner: true });
      first = await registered();
      second = await registered();
      // Both promotions pass: neither is counted while pending.
      await hierarchy.setLevel(office(KPM_A), first.membershipId!, 'ab');
      await hierarchy.setLevel(office(KPM_A), second.membershipId!, 'aab');
      expect(await used(KPM_A)).toBe(2);
    });

    it('approval: the first takes the last seat, the second is refused with nothing written', async () => {
      await approvals.approve(rootCtx, (await requestOf(first)).requestId);
      expect(await used(KPM_A)).toBe(3);

      const request = await requestOf(second);
      await expect(approvals.approve(rootCtx, request.requestId)).rejects.toMatchObject({
        ...LIMIT, details: { maxLeaders: 3, leadersUsed: 3 },
      });
      expect(await row(second)).toMatchObject({ status: 'pending', leaderId: null });
      expect((await approvals.inbox(rootCtx)).map((r) => r.requestId)).toContain(request.requestId);
      expect(await used(KPM_A)).toBe(3);
      expect((await kpms.findById(KPM_A).lean().exec())!.leaderLimitLock).toBeNull();
    });

    it('a tag: refused at the limit, the member left pending and untagged', async () => {
      await approvals.tag(rootCtx, first.membershipId!);
      expect(await used(KPM_A)).toBe(3);
      await expect(approvals.tag(rootCtx, second.membershipId!)).rejects.toMatchObject(LIMIT);
      expect(await row(second)).toMatchObject({ status: 'pending', leaderId: null });
      expect(await used(KPM_A)).toBe(3);
    });

    it('the Owner’s assignment: refused at the limit, the office’s Owner unchanged', async () => {
      await approvals.tag(rootCtx, first.membershipId!);
      const before = (await kpms.findById(KPM_A).lean().exec())!.ownerUserId ?? null;
      await expect(
        tenants.assignOwner(RequestContext.platform('sa-1'), KPM_A, { userId: second.userId }),
      ).rejects.toMatchObject(LIMIT);
      expect((await kpms.findById(KPM_A).lean().exec())!.ownerUserId ?? null).toBe(before);
      expect(await row(second)).toMatchObject({ status: 'pending' });
      expect(await used(KPM_A)).toBe(3);
    });

    it('below the limit, the same approval and assignment are served', async () => {
      await limit(KPM_A, 4);
      await approvals.approve(rootCtx, (await requestOf(first)).requestId);
      await tenants.assignOwner(RequestContext.platform('sa-1'), KPM_A, { userId: second.userId });
      expect(await row(second)).toMatchObject({ status: 'active' });
      expect(await used(KPM_A)).toBe(4);
    });

    it('the join paths are still served at the limit: an Agent approved, an Agent tagged', async () => {
      await approvals.tag(rootCtx, first.membershipId!);
      expect(await used(KPM_A)).toBe(3);
      const agent = await registered();
      await expect(approvals.approve(rootCtx, (await requestOf(agent)).requestId)).resolves.toBeDefined();
      const tagged = await registered();
      await expect(approvals.tag(rootCtx, tagged.membershipId!)).resolves.toBeDefined();
      expect([(await row(agent))!.status, (await row(tagged))!.status]).toEqual(['active', 'active']);
      expect(await used(KPM_A)).toBe(3);
    });
  });

  describe('exit review: the member is read with the lease held', () => {
    it('two promotions of one Agent at once, one below the limit: both are served, one seat taken', async () => {
      await limit(KPM_A, 2);
      const ab = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', ab);

      const results = await Promise.allSettled([
        hierarchy.setLevel(office(KPM_A), agent, 'aab'),
        hierarchy.setLevel(office(KPM_A), agent, 'ab'),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await used(KPM_A)).toBe(2);
    });

    it('a move down to Agent takes no lease, at the limit or past it', async () => {
      await limit(KPM_A, 1);
      const ab = await join(KPM_A, 'ab');
      const aab = await join(KPM_A, 'aab').catch(() => null);
      expect(aab).toBeNull();
      // Held by somebody else: a move that takes the lease would wait for it.
      await kpms.updateOne({ _id: KPM_A }, { $set: { leaderLimitLock: { token: 'held', until: new Date(NOW.getTime() + 60_000) } } });
      await expect(hierarchy.setLevel(office(KPM_A), ab, 'agent')).resolves.toMatchObject({ role: 'agent' });
    });
  });

  describe('exit review: no path without an office', () => {
    it('a write with no office in its context is refused as a programming error, and never runs', async () => {
      const work = jest.fn(async () => 'written');
      await expect(
        withLeaderSeat({ kpms: kpms as never, members, clock: new FixedClock(NOW) }, RequestContext.platform('sa-1'), work),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(work).not.toHaveBeenCalled();
    });
  });

  describe('AC-7: lowering it', () => {
    it('demotes nobody, and refuses the next leader until the count is under it', async () => {
      const ab = await join(KPM_A, 'ab');
      await join(KPM_A, 'aab', ab);
      await join(KPM_A, 'aab', ab);
      const agent = await join(KPM_A, 'agent', ab);
      await limit(KPM_A, 1);
      expect(await used(KPM_A)).toBe(3);
      await expect(hierarchy.setLevel(office(KPM_A), agent, 'aab')).rejects.toMatchObject({
        ...LIMIT, details: { maxLeaders: 1, leadersUsed: 3 },
      });
    });
  });

  describe('AC-8: the paths that make an Agent are served at the limit', () => {
    let leader: string;
    let leaderCtx: RequestContext;

    beforeEach(async () => {
      await limit(KPM_A, 1);
      leader = await join(KPM_A, 'ab');
      leaderCtx = await as(leader);
      expect(await used(KPM_A)).toBe(1);
    });

    async function registered() {
      const userId = await person();
      await onboarding.registerKpm(new RequestContext(userId, 'none', null), KPM_A);
      const row = await mongoose.model(Membership.name).findOne({ userId }).exec();
      return new RequestContext(userId, 'none', {
        membershipId: String(row!._id), kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
        status: 'pending', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      });
    }

    it('registration', async () => {
      const joiner = await registered();
      expect(joiner.membership?.status).toBe('pending');
    });

    it('approval', async () => {
      const joiner = await registered();
      await onboarding.requestLeader(joiner, leader);
      const [request] = await approvals.inbox(leaderCtx);
      await expect(approvals.approve(leaderCtx, request.requestId)).resolves.toBeDefined();
    });

    it('a tag', async () => {
      const joiner = await registered();
      await expect(approvals.tag(leaderCtx, joiner.membershipId!)).resolves.toBeDefined();
    });

    it('a leader’s code', async () => {
      const code = (await members.findById(office(KPM_A), leader))!.leaderCode;
      await expect(
        leaderCodes.redeem(new RequestContext(await person(), 'none', null), code),
      ).resolves.toMatchObject({ kpmId: KPM_A });
    });

    afterEach(async () => {
      expect(await used(KPM_A)).toBe(1);
    });
  });
});
