import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { ApprovalsService } from './approvals.service';
import { HierarchyService } from './hierarchy.service';
import { JoinRequest, JoinRequestSchema } from './join-request.schema';
import { LeaderCodeService } from './leader-code.service';
import { MembershipHistory, MembershipHistorySchema } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import { Membership, MembershipSchema } from './membership.schema';
import { OnboardingService } from './onboarding.service';
import { JoinRequestRepository, MembershipHistoryRepository } from './org.repositories';

/** 10:00 on 8 October 2026 in Jakarta; 03:00 UTC. In UTC−12 it is still the 7th. */
const NOW = new Date('2026-10-08T03:00:00Z');

/**
 * **An ended office, to somebody outside it** (ADR-0112 §3, P13.2-T3 AC-6; P13.2 exit review): the
 * directory does not offer it, registering to it and redeeming a leader's code into it are refused —
 * each the way a suspended office is, with nothing that says why. An office kept active after its end
 * is served on all three.
 *
 * And the directory's fifty: **filtered before they are cut, not after** (exit review), so ended
 * offices sorted ahead of an active one never hide it.
 */
describe('joining an ended office (P13.2 exit review, S1)', () => {
  let onboarding: OnboardingService;
  let leaderCodes: LeaderCodeService;
  let hierarchy: HierarchyService;
  let kpms: mongoose.Model<Kpm>;
  let users: mongoose.Model<User>;
  let companyId: string;
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    users = mongoose.model(User.name, UserSchema) as never;
    const companies = mongoose.model(Company.name, CompanySchema);
    const audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const notifications = { send: async () => undefined };
    const members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const requests = new JoinRequestRepository(mongoose.model(JoinRequest.name, JoinRequestSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      companies as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(
      members, kpms as never, users as never,
      new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never),
      clock, orgLevels,
    );
    onboarding = new OnboardingService(
      members, hierarchy, kpms as never, companies as never, users as never, requests, audit,
      notifications as never, clock,
    );
    const approvals = new ApprovalsService(
      members, hierarchy, requests,
      new MembershipHistoryRepository(mongoose.model(MembershipHistory.name) as never),
      users as never, audit, notifications as never, clock,
    );
    leaderCodes = new LeaderCodeService(
      members, hierarchy, requests, approvals, kpms as never, companies as never, users as never, audit,
      notifications as never, clock,
    );
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-${Math.random()}` });
    companyId = String(company._id);
    await seedLadder(companyId);
  });

  /** An office, its subscription ending on `endDate` (null: no dates). */
  async function office(code: string, endDate: string | null, over: Record<string, unknown> = {}) {
    const kpm = await kpms.create({
      companyId, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta', status: 'active',
      counters: { nextMemberSeq: 1 },
      subscription: endDate === null ? null : {
        startDate: '2025-10-01', endDate, pricePerLeaderMinor: null, currency: 'IDR', maxLeaders: null,
        keepActiveAfterEnd: false,
      },
      ...over,
    });
    return String(kpm._id);
  }

  async function person() {
    seq += 1;
    const u = await users.create({
      email: `p${seq}@kpm.test`, passwordHash: 'x', fullName: `Person ${seq}`, status: 'active',
      platformRole: 'none', companyId, agentCode: `PRU-${7000 + seq}`,
    });
    return String(u._id);
  }

  const newcomer = async () => new RequestContext(await person(), 'none', null);

  /** An office's leader, and the code they hand out. */
  async function leaderCodeIn(kpmId: string) {
    const m = await hierarchy.create(RequestContext.superAdminInTenant('sa-1', kpmId), {
      userId: await person(), role: 'ab', leaderId: null, status: 'active',
    });
    return m.leaderCode;
  }

  const kept = { 'subscription.keepActiveAfterEnd': true };

  describe('an office whose end date has passed, not kept active', () => {
    it('is not offered by the directory search, as a suspended office is not', async () => {
      await office('0601', '2026-10-07');
      await office('0602', '2026-10-07', { status: 'suspended' });
      await office('0603', '2026-10-08');
      expect((await onboarding.searchKpms()).map((k) => k.code)).toEqual(['0603']);
      expect(await onboarding.searchKpms('0601')).toEqual([]);
    });

    it('refuses the join, 404, the answer a suspended office gives', async () => {
      const ended = await office('0601', '2026-10-07');
      const suspended = await office('0602', null, { status: 'suspended' });
      const refusal = await onboarding.registerKpm(await newcomer(), ended).catch((e) => e);
      const suspendedRefusal = await onboarding.registerKpm(await newcomer(), suspended).catch((e) => e);
      expect(refusal).toMatchObject({ code: 'NOT_FOUND' });
      expect([refusal.code, refusal.message]).toEqual([suspendedRefusal.code, suspendedRefusal.message]);
    });

    it('refuses a leader’s code into it, 410, the answer a suspended office gives', async () => {
      const ended = await office('0601', '2026-10-08');
      const code = await leaderCodeIn(ended);
      const suspended = await office('0602', null);
      const suspendedCode = await leaderCodeIn(suspended);
      // Ended from today in Jakarta; suspended the same day.
      await kpms.updateOne({ _id: ended }, { $set: { 'subscription.endDate': '2026-10-07' } });
      await kpms.updateOne({ _id: suspended }, { $set: { status: 'suspended' } });

      const refusal = await leaderCodes.redeem(await newcomer(), code).catch((e) => e);
      const suspendedRefusal = await leaderCodes.redeem(await newcomer(), suspendedCode).catch((e) => e);
      expect(refusal).toMatchObject({ code: 'ORG_INVITE_EXPIRED' });
      expect([refusal.code, refusal.message]).toEqual([suspendedRefusal.code, suspendedRefusal.message]);
    });

    it('kept active, it is offered, joined and redeemed into as any other office', async () => {
      const id = await office('0601', '2026-10-07', kept);
      expect((await onboarding.searchKpms()).map((k) => k.code)).toEqual(['0601']);
      await expect(onboarding.registerKpm(await newcomer(), id)).resolves.toMatchObject({ status: 'pending' });
      const code = await leaderCodeIn(id);
      await expect(leaderCodes.redeem(await newcomer(), code)).resolves.toMatchObject({ kpmId: id });
    });
  });

  describe('the directory’s fifty (exit review)', () => {
    it('ended offices sorted ahead never hide an active one', async () => {
      // Sixty ended long ago and two ended yesterday in Jakarta, all sorting before the three that work.
      for (let i = 0; i < 60; i += 1) await office(`0${100 + i}`, '2026-09-30');
      await office('0300', '2026-10-07');
      await office('0301', '2026-10-07');
      await office('0900', '2026-10-08');
      await office('0901', null);
      await office('0902', '2026-09-30', kept);

      expect((await onboarding.searchKpms()).map((k) => k.code)).toEqual(['0900', '0901', '0902']);
    });

    it('still answers fifty, and no more, when more than fifty work', async () => {
      await office('0000', '2026-09-30');
      for (let i = 0; i < 55; i += 1) await office(`0${100 + i}`, null);
      const found = await onboarding.searchKpms();
      expect(found).toHaveLength(50);
      expect(found[0].code).toBe('0100');
    });
  });
});
