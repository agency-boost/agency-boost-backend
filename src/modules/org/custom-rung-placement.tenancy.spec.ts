import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { PasswordService } from '@/modules/auth/password.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { ROSTER_TEMPLATE_HEADER } from '@/modules/tenants/roster-csv';
import { RosterImportService } from '@/modules/tenants/roster-import.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { HierarchyService } from './hierarchy.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { MembershipHistoryRepository } from './org.repositories';
import { RoleChangeService } from './role-change.service';

const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();
const NOW = new Date('2026-10-26T03:00:00Z');
const office = (kpmId: string) => RequestContext.superAdminInTenant('sa-1', kpmId);
/** The four a person records (ADR-0158), after the five: one row's tail. */
const PERSONAL = '1990-01-01,2020-01,full-time,female';

/**
 * **A member placed on a rung the company added, by name** (OD-50's placement gap, closed after P18.8-T1): the
 * role change and the roster import's *role* column take any live rung code of the office's company ladder, and
 * the class follows the rung's tier — `SM` (*Senior Leader*) gives `ab`, `UM` (*Associate Leader*) `aab`, `FA`
 * (*Not a leader*) `agent`. KPM A's company (Allianz) has those beside the default codes; KPM B's company has the
 * default ladder alone, so a code of Allianz's is no rung there.
 */
describe('OD-50 — placing a member on a custom rung by its code', () => {
  let members: MembershipRepository;
  let hierarchy: HierarchyService;
  let roles: RoleChangeService;
  let roster: RosterImportService;
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let history: mongoose.Model<MembershipHistory>;
  let companyA: string;
  let companyB: string;
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
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never, kpms as never, audit, clock, members,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, historyRepo, clock, orgLevels);
    roles = new RoleChangeService(
      members, hierarchy, historyRepo, users as never, audit, { send: async () => undefined } as never, clock,
    );
    roster = new RosterImportService(members, hierarchy, kpms as never, users as never, new PasswordService(), audit, clock);
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const companies = mongoose.model(Company.name);
    companyA = String((await companies.create({ name: 'Allianz Life', slug: `allianz-${Math.random()}` }))._id);
    companyB = String((await companies.create({ name: 'Prudential', slug: `prudential-${Math.random()}` }))._id);
    await seedLadder(companyA);
    await seedLadder(companyB);
    // Allianz's own rungs, as the Super Admin added them: SM and UM lead, FA does not.
    const levels = mongoose.model(CompanyOrgLevel.name);
    for (const [code, label, displayOrder, leaderTier] of [
      ['FA', 'Financial Adviser', 4, null], ['UM', 'Unit Manager', 5, 'associate'], ['SM', 'Senior Manager', 6, 'senior'],
    ] as const) {
      await levels.create({
        companyId: companyA, code, label, displayOrder, leaderTier, status: 'active', archivedAt: null, deletedAt: null,
      });
    }
    for (const [id, companyId, code] of [[KPM_A, companyA, '0701'], [KPM_B, companyB, '0417']]) {
      await kpms.create({
        _id: id, companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta',
        counters: { nextMemberSeq: 1 }, status: 'active',
      });
    }
  });

  async function place(kpmId: string, rung: string, leaderId: string | null = null) {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active', platformRole: 'none',
      companyId: kpmId === KPM_A ? companyA : companyB, agentCode: `${7100 + seq}`,
    });
    const m = await hierarchy.create(office(kpmId), { userId: String(u._id), role: rung, leaderId, status: 'active' });
    return String(m._id);
  }

  async function as(kpmId: string, membershipId: string, owner = false) {
    const row = await members.findById(office(kpmId), membershipId);
    return new RequestContext(row!.userId, 'none', {
      membershipId, kpmId, orgLevelCode: row!.orgLevelCode, hierarchyRole: row!.role, status: 'active',
      isKpmOwner: owner, isKpmAdmin: false, directCount: row!.directCounts?.total ?? 0,
    });
  }
  const rungOf = async (kpmId: string, id: string) => {
    const row = await members.findById(office(kpmId), id);
    return [row!.orgLevelCode, row!.role];
  };

  describe('the role change', () => {
    it('places a member on a rung the company added, in any case, the class from its tier', async () => {
      const root = await place(KPM_A, 'SM');
      const owner = await as(KPM_A, root, true);
      const fa = await place(KPM_A, 'FA', root);
      const other = await place(KPM_A, 'AGENT', root);

      await roles.change(owner, fa, 'UM');
      expect(await rungOf(KPM_A, fa)).toEqual(['UM', 'aab']);
      await roles.change(owner, other, 'sm');
      expect(await rungOf(KPM_A, other)).toEqual(['SM', 'ab']);
      // And back down to a rung that leads nobody, which is the company's own too.
      await roles.change(owner, fa, 'fa');
      expect(await rungOf(KPM_A, fa)).toEqual(['FA', 'agent']);

      const edges = await history.find({ eventType: 'role_changed', membershipId: fa }).sort({ validFrom: 1 }).lean().exec();
      expect(edges.map((e) => e.toRole)).toEqual(['aab', 'agent']);
    });

    it('judges the change by the class: a direct leader places an adviser on UM, never on SM', async () => {
      const root = await place(KPM_A, 'SM');
      const um = await place(KPM_A, 'UM', root);
      const fa = await place(KPM_A, 'FA', um);
      const leader = await as(KPM_A, um);

      await roles.change(leader, fa, 'UM');
      expect(await rungOf(KPM_A, fa)).toEqual(['UM', 'aab']);
      await expect(roles.change(leader, fa, 'SM')).rejects.toMatchObject({ code: 'ORG_ROLE_CHANGE_NOT_PERMITTED' });
    });

    it('refuses a code that is no live rung of this company’s ladder', async () => {
      const root = await place(KPM_A, 'SM');
      const fa = await place(KPM_A, 'FA', root);
      await expect(roles.change(await as(KPM_A, root, true), fa, 'XY')).rejects.toMatchObject({
        code: 'ORG_LEVEL_NOT_ON_LADDER',
      });
      // Another company's rung is no rung here.
      const bRoot = await place(KPM_B, 'AB');
      const bAgent = await place(KPM_B, 'AGENT', bRoot);
      await expect(roles.change(await as(KPM_B, bRoot, true), bAgent, 'SM')).rejects.toMatchObject({
        code: 'ORG_LEVEL_NOT_ON_LADDER',
      });
      expect(await rungOf(KPM_B, bAgent)).toEqual(['AGENT', 'agent']);
    });
  });

  describe('the roster import’s role column', () => {
    const file = (...lines: string[]) => [ROSTER_TEMPLATE_HEADER, ...lines].join('\n');

    it('creates people on the company’s own rungs, the class from each tier', async () => {
      const csv = file(
        `Sinta,sinta@k.test,301,SM,,${PERSONAL}`,
        `Umar,umar@k.test,302,um,301,${PERSONAL}`,
        `Fajar,fajar@k.test,303,Fa,302,${PERSONAL}`,
      );
      const preview = await roster.preview(RequestContext.platform('sa-1'), KPM_A, csv);
      expect(preview.issues).toEqual([]);
      await roster.commit(RequestContext.platform('sa-1'), KPM_A, csv);

      const made = await mongoose.model(Membership.name).find({ kpmId: KPM_A }).sort({ agentSeq: 1 }).lean().exec();
      expect(made.map((m) => [m.agentCode, m.orgLevelCode, m.role])).toEqual([
        ['301', 'SM', 'ab'], ['302', 'UM', 'aab'], ['303', 'FA', 'agent'],
      ]);
    });

    it('names a code that is no rung of this company’s ladder, with the ones that are', async () => {
      const preview = await roster.preview(
        RequestContext.platform('sa-1'), KPM_B, file(`Sinta,sinta@k.test,301,SM,,${PERSONAL}`),
      );
      expect(preview.issues).toEqual([{
        line: 2, column: 'role', message: '"SM" is not a rung of this company’s ladder. Use one of: AAB, AB, AGENT.',
      }]);
      expect(preview.willCreate).toBe(0);
    });

    it('counts a custom leader rung against the limit as it counts AB', async () => {
      await kpms.updateOne({ _id: KPM_A }, {
        $set: {
          subscription: {
            startDate: null, endDate: null, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: 1,
            keepActiveAfterEnd: false,
          },
        },
      });
      const preview = await roster.preview(RequestContext.platform('sa-1'), KPM_A, file(
        `Sinta,sinta@k.test,301,SM,,${PERSONAL}`,
        `Umar,umar@k.test,302,UM,301,${PERSONAL}`,
        `Fajar,fajar@k.test,303,FA,302,${PERSONAL}`,
      ));
      expect(preview.issues.map((i) => [i.line, i.column])).toEqual([[3, 'role']]);
    });
  });
  describe('the rung a placement with no choice lands on (ADR-0156)', () => {
    it('gives an Owner the highest Senior Leader rung and a joiner the lowest rung that leads nobody', async () => {
      // The default ladder answers what the placements always wrote.
      expect(await hierarchy.entryRungCode(KPM_B, 'owner')).toBe('AB');
      expect(await hierarchy.entryRungCode(KPM_B, 'joiner')).toBe('AGENT');
      // Allianz also has SM, a Senior Leader rung above AB, and FA, a rung that leads nobody above AGENT.
      expect(await hierarchy.entryRungCode(KPM_A, 'owner')).toBe('SM');
      expect(await hierarchy.entryRungCode(KPM_A, 'joiner')).toBe('AGENT');
    });

    it('places an Owner and a joiner on a ladder with no AB and no AGENT', async () => {
      const levels = mongoose.model(CompanyOrgLevel.name);
      await levels.updateMany({ companyId: companyA, code: { $in: ['AB', 'AAB', 'AGENT'] } }, { $set: { status: 'archived' } });
      expect(await hierarchy.entryRungCode(KPM_A, 'owner')).toBe('SM');
      expect(await hierarchy.entryRungCode(KPM_A, 'joiner')).toBe('FA');
      const root = await place(KPM_A, await hierarchy.entryRungCode(KPM_A, 'owner'));
      expect(await rungOf(KPM_A, root)).toEqual(['SM', 'ab']);
    });

    it('refuses a ladder with no such rung, naming what is missing', async () => {
      const levels = mongoose.model(CompanyOrgLevel.name);
      await levels.updateMany({ companyId: companyA, leaderTier: 'senior' }, { $set: { status: 'archived' } });
      await levels.updateMany({ companyId: companyA, code: 'AB' }, { $set: { status: 'archived' } });
      await expect(hierarchy.entryRungCode(KPM_A, 'owner'))
        .rejects.toMatchObject({ code: 'ORG_LEVEL_NOT_ON_LADDER', details: { purpose: 'owner' } });
      await levels.updateMany({ companyId: companyB, code: { $in: ['AGENT'] } }, { $set: { status: 'archived' } });
      await expect(hierarchy.entryRungCode(KPM_B, 'joiner'))
        .rejects.toMatchObject({ code: 'ORG_LEVEL_NOT_ON_LADDER', details: { purpose: 'joiner' } });
    });
  });
});
