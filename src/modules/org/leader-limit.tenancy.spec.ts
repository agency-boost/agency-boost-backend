import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
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
  /** A roster import over another hierarchy service: the race below swaps in one that promotes somebody mid-commit. */
  let rosterOver: (h: HierarchyService) => RosterImportService;
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
    const tokens = mongoose.models[AuthToken.name] ?? mongoose.model(AuthToken.name, AuthTokenSchema);
    rosterOver = (h) => new RosterImportService(
      members, h, kpms as never, users as never, new PasswordService(), audit, clock, orgLevels, historyRepo,
      notifications as never, tokens as never,
    );
    roster = rosterOver(hierarchy);
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
      // ADR-0190 §4 (P19-T3): only a verified address may be made an office's Owner.
      emailVerifiedAt: new Date('2026-10-01T00:00:00Z'),
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
    }).withReader(SOURCE_READER); // the API's English, as asserted below: nobody's choice reads Indonesian (P18.10-T4)
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

  /*
   * **The member import under the limit** (P13.2-T4 AC-4, as P19.3-T4 keeps it; ADR-0205 §9). Since A3 a row past the
   * limit is **skipped** with its words, and the rest of the file imports; a write the limit refuses while the commit
   * runs — the office filled in another tab — undoes the whole commit and answers the limit's own code.
   */
  describe('AC-4: the roster import', () => {
    const HEADER = ROSTER_TEMPLATE_HEADER;
    /** A3's columns: code, name, rung, upline, number, email. */
    const row = (code: string, name: string, rung: string, up = '') => `${code},${name},${rung},${up},,${name.toLowerCase()}@kpm.test`;
    const rowsOf = (preview: { rows: { agentCode: string; outcome: string; messages: string[] }[] }) =>
      preview.rows.map((r) => [r.agentCode, r.outcome]);

    it('the preview skips each row past the limit with its words, in the file’s order, and the rest import', async () => {
      await limit(KPM_A, 2);
      const root = await join(KPM_A, 'ab');
      const file = [HEADER, row('9001', 'Ana', 'aab', ''), row('9002', 'Budi', 'agent', '9001'), row('9003', 'Citra', 'ab'), row('9004', 'Dodi', 'aab', '9003')]
        .join('\n');

      // The office's Owner imports since P19.4-T2 (ADR-0206 §2); the Super Admin did until then, with words of its own.
      const ownerCtx = await as(root, { owner: true });
      const asOwner = await roster.preview(ownerCtx, KPM_A, file);
      // Ana is an AAB with no upline: A3 asks one of her. The limit then counts Citra, the only leader left in.
      expect(rowsOf(asOwner)).toEqual([['9001', 'skipped'], ['9002', 'skipped'], ['9003', 'imported'], ['9004', 'skipped']]);
      const dodi = asOwner.rows[3].messages[0];
      expect(dodi).toMatch(/limit is 2/);
      expect(dodi).not.toMatch(/LEADER_LIMIT_REACHED/);
      // P18.5-T2 AC-9 (ADR-0157 §5): a row past the limit is skipped, never queued, and the way through that asks is named.
      expect(dodi).toMatch(/Import them as an Agent, then promote them on their page/);
      expect(dodi).toMatch(/asks AgencyBoost to approve it/);
      // And the Super Admin imports nothing at all.
      await expect(roster.preview(RequestContext.platform('sa-1'), KPM_A, file)).rejects.toMatchObject({ code: 'PERM_DENIED' });

      // Committed: the rows the preview let in, and no other.
      await roster.commit(ownerCtx, KPM_A, file);
      expect(await used(KPM_A)).toBe(2);
      expect(await users.countDocuments({ email: 'dodi@kpm.test', deletedAt: null })).toBe(0);
      expect(await users.countDocuments({ email: 'citra@kpm.test', deletedAt: null })).toBe(1);
    });

    it('the commit checks the limit again: a row the office filled up for after the preview is skipped', async () => {
      await limit(KPM_A, 2);
      const root = await join(KPM_A, 'ab');
      const rootCode = (await members.findById(office(KPM_A), root))!.agentCode;
      const file = [HEADER, row('9001', 'Ana', 'aab', rootCode), row('9005', 'Eko', 'agent', rootCode)].join('\n');
      const ownerCtx = await as(root, { owner: true });
      expect(rowsOf(await roster.preview(ownerCtx, KPM_A, file))).toEqual([['9001', 'imported'], ['9005', 'imported']]);

      await join(KPM_A, 'aab', root);
      const result = await roster.commit(ownerCtx, KPM_A, file);
      expect(rowsOf(result)).toEqual([['9001', 'skipped'], ['9005', 'imported']]);
      expect(await users.countDocuments({ email: 'ana@kpm.test', deletedAt: null })).toBe(0);
    });
  });

  describe('exit review: a roster row refused mid-commit leaves no account behind', () => {
    const HEADER = ROSTER_TEMPLATE_HEADER;

    it('the office fills while the commit runs: the limit’s code, and the whole commit undone (ADR-0205 §9)', async () => {
      await limit(KPM_A, 3);
      const root = await join(KPM_A, 'ab');
      const agent = await join(KPM_A, 'agent', root);

      // A promotion in another tab, landing between the first row's write and the second's.
      let calls = 0;
      const racing = Object.create(hierarchy) as HierarchyService;
      racing.createWithAccount = async (...args: Parameters<HierarchyService['createWithAccount']>) => {
        calls += 1;
        if (calls === 2) await hierarchy.setLevel(office(KPM_A), agent, 'aab');
        return hierarchy.createWithAccount(...args);
      };
      const file = [HEADER, '9001,Ana,ab,,,ana@kpm.test', '9002,Budi,aab,9001,,budi@kpm.test'].join('\n');

      const ownerCtx = await as(root, { owner: true });
      await expect(rosterOver(racing).commit(ownerCtx, KPM_A, file)).rejects.toMatchObject({
        ...LIMIT, details: { maxLeaders: 3, leadersUsed: 3 },
      });
      // Nobody of the file is left: Ana's account and membership were undone with the refusal, and Budi's never made.
      expect(await users.countDocuments({ email: 'ana@kpm.test', deletedAt: null })).toBe(0);
      expect(await users.countDocuments({ email: 'budi@kpm.test', deletedAt: null })).toBe(0);
      expect(await used(KPM_A)).toBe(2);
      // So the same file imports once the limit is raised.
      await limit(KPM_A, 4);
      await expect(roster.commit(ownerCtx, KPM_A, file)).resolves.toMatchObject({ counts: { imported: 2 } });
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
