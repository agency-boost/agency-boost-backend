import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { Company, CompanySchema } from './company.schema';
import { Kpm, KpmSchema } from './kpm.schema';
import { TenantService } from './tenant.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const NOW = new Date('2026-09-05T02:00:00Z');

function ctx(opts: { superAdmin?: boolean; owner?: boolean; admin?: boolean; kpmId?: string } = {}) {
  return new RequestContext(
    'u1',
    opts.superAdmin ? 'super_admin' : 'none',
    opts.kpmId || opts.owner || opts.admin
      ? {
          membershipId: 'mem-1',
          kpmId: opts.kpmId ?? 'kpm-x',
          hierarchyRole: 'ab',
          status: 'active',
          isKpmOwner: opts.owner ?? false,
          isKpmAdmin: opts.admin ?? false, directCount: 0,
        }
      : null,
  );
}

/** Inferring the model type keeps mongoose's generics out of the test's way. */
function userModel() {
  return mongoose.model(User.name, UserSchema);
}

describe('TenantService', () => {
  let service: TenantService;
  let users: ReturnType<typeof userModel>;
  let companyId: string;

  beforeAll(async () => {
    await startMongo();
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const companies = mongoose.model(Company.name, CompanySchema);
    const auditModel = mongoose.model(AuditLog.name, AuditLogSchema);
    users = userModel();
    const memberModel = mongoose.model(Membership.name, MembershipSchema);
    const historyModel = mongoose.model(MembershipHistory.name, MembershipHistorySchema);
    const repo = new MembershipRepository(memberModel as never);
    const clock = new FixedClock(NOW);
    service = new TenantService(
      kpms as never,
      companies as never,
      users as never,
      new AuditService(auditModel as never),
      clock,
      new HierarchyService(repo, kpms as never, historyModel as never, clock),
      repo,
    );
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await mongoose
      .model(Company.name)
      .create({ name: 'Prudential', slug: 'prudential', defaultTimezone: 'Asia/Jakarta' });
    companyId = String(company._id);
  });

  const input = () => ({ companyId, code: '0417', branchName: 'BSD City Branch' });

  /**
   * Seeds a membership straight through the model.
   *
   * The repository refuses a write with no tenant context, which is the whole point of
   * it — a Super Admin building fixtures is not a tenant request. Going around it here
   * is a test-setup shortcut, never something production code may copy.
   */
  const seedMember = (kpmId: string, userId: string, role: 'ab' | 'aab' | 'agent') =>
    mongoose.model(Membership.name).create({
      kpmId, userId, role, status: 'active', agentCode: `${kpmId.slice(-4)}-${userId}`,
      agentSeq: 1, leaderId: null, ancestorIds: [], depth: 0,
    });

  describe('only a Super Admin creates a KPM', () => {
    it('allows a Super Admin', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm.code).toBe('0417');
      expect(kpm.status).toBe('active');
      expect(kpm.ownerUserId).toBeNull();
    });

    it.each([
      ['a KPM Owner', ctx({ owner: true })],
      ['a KPM Admin', ctx({ admin: true })],
      ['an AB', ctx({ kpmId: 'kpm-x' })],
      ['a user with no membership', ctx()],
    ])('refuses %s with PERM_DENIED', async (_label, actor) => {
      await expect(service.createKpm(actor, input())).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });
  });

  describe('provisioning', () => {
    it('inherits the company defaults when none are given', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm.timezone).toBe('Asia/Jakarta');
      expect(kpm.currency).toBe('IDR');
    });

    it('seeds the settings every prototype screen hardcodes', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      expect(kpm.settings).toMatchObject({
        activationWindowDays: 90,
        ratioWindowDays: 30,
        onTrackPaceThreshold: 0.9,
        activityDailyMaxCount: 999,
      });
      expect(kpm.counters.nextAgentCodeSeq).toBe(1);
    });

    it('rejects a duplicate code within the same company', async () => {
      await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(service.createKpm(ctx({ superAdmin: true }), input())).rejects.toMatchObject({
        code: 'TENANT_CODE_TAKEN',
      });
    });

    it('allows the same code under a different company', async () => {
      await service.createKpm(ctx({ superAdmin: true }), input());
      const other = await mongoose.model(Company.name).create({ name: 'Allianz', slug: 'allianz' });
      const kpm = await service.createKpm(ctx({ superAdmin: true }), {
        ...input(),
        companyId: String(other._id),
      });
      expect(kpm.code).toBe('0417');
    });

    it('404s an unknown company rather than creating an orphan tenant', async () => {
      await expect(
        service.createKpm(ctx({ superAdmin: true }), {
          ...input(),
          companyId: new mongoose.Types.ObjectId().toString(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('ownership', () => {
    async function makeUser(email: string, status: 'active' | 'deactivated' = 'active') {
      const user = await users.create({
        email,
        passwordHash: 'x',
        fullName: email,
        status,
        platformRole: 'none',
      });
      return String(user._id);
    }

    it('assigns an owner and audits it', async () => {
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const updated = await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
        userId: owner,
      });
      expect(updated.ownerUserId).toBe(owner);

      const audit = await mongoose.model(AuditLog.name).findOne({ action: 'kpm.owner_assigned' });
      expect(audit).not.toBeNull();
    });

    it('accepts the email a Super Admin actually knows', async () => {
      // §6.1 of roles-and-permissions.md describes this by email. Requiring a Mongo id
      // made the console's own screen unusable — there was no way to learn one from it.
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const updated = await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
        email: '  Owner@KPM0417.test ',
      });
      expect(updated.ownerUserId).toBe(owner);
    });

    it('refuses an account that does not exist, instead of storing the string', async () => {
      // The bug this pins: the id was written on trust, so an office could be left
      // pointing at nobody — permanently, and with no one able to administer it.
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
          email: 'nobody@nowhere.test',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const unchanged = await mongoose.model(Kpm.name).findById(kpm._id);
      expect(unchanged?.get('ownerUserId')).toBeNull();
    });

    it('treats a malformed id as unknown rather than letting Mongoose throw a 500', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: 'not-an-id' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses a deactivated account, which could never sign in to administer anything', async () => {
      await makeUser('gone@kpm0417.test', 'deactivated');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {
          email: 'gone@kpm0417.test',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('asks for one of the two identifiers rather than silently doing nothing', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), {}),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('gives the new Owner a membership, or they cannot reach their own office', async () => {
      // §6.1 creates this on first login. Creating it at assignment means the office is
      // administrable the moment it is assigned, and a context resolves for the Owner.
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: owner });

      const membership = await mongoose
        .model(Membership.name)
        .findOne({ kpmId: String(kpm._id), userId: owner });
      expect(membership?.get('role')).toBe('ab');
      expect(membership?.get('status')).toBe('active');
      expect(membership?.get('leaderId')).toBeNull();
      // Server-issued from the office counter, never supplied by a caller.
      expect(membership?.get('agentCode')).toBe('KPM0417-001');
    });

    it('writes the joined history row from the first day, before any screen reads it', async () => {
      const owner = await makeUser('owner@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: owner });

      const events = await mongoose.model(MembershipHistory.name).find({ kpmId: String(kpm._id) });
      expect(events.map((e) => e.get('eventType'))).toEqual(['joined']);
      expect(events[0].get('validTo')).toBeNull();
    });

    it('does not mint a second membership when ownership returns to a previous owner', async () => {
      // The partial unique index would reject it, and the right answer is the row they
      // already have.
      const first = await makeUser('first@kpm0417.test');
      const second = await makeUser('second@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: first });
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: second });
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: first });

      const rows = await mongoose.model(Membership.name).find({ kpmId: String(kpm._id), userId: first });
      expect(rows).toHaveLength(1);
    });

    it('records a transfer with both parties', async () => {
      const first = await makeUser('first@kpm0417.test');
      const second = await makeUser('second@kpm0417.test');
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: first });
      await service.assignOwner(ctx({ superAdmin: true }), String(kpm._id), { userId: second });

      const audit = await mongoose.model(AuditLog.name).findOne({ action: 'kpm.owner_transferred' });
      expect(audit?.get('before')).toMatchObject({ ownerUserId: first });
      expect(audit?.get('after')).toMatchObject({ ownerUserId: second });
    });

    it('refuses an Owner transferring ownership themselves', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.assignOwner(ctx({ owner: true }), String(kpm._id), { email: 'other@kpm.test' }),
      ).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });

    it('refuses to leave a KPM ownerless', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.clearOwner(ctx({ superAdmin: true }), String(kpm._id)),
      ).rejects.toMatchObject({ code: 'PERM_LAST_OWNER' });
    });
  });

  describe('suspension', () => {
    it('suspends with a reason and a timestamp from the injected clock', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const s = await service.setStatus(ctx({ superAdmin: true }), String(kpm._id), 'suspended', 'unpaid');
      expect(s.status).toBe('suspended');
      expect(s.suspendedReason).toBe('unpaid');
      expect(s.suspendedAt).toEqual(NOW);
    });

    it('clears the suspension detail on reactivation', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await service.setStatus(ctx({ superAdmin: true }), String(kpm._id), 'suspended', 'unpaid');
      const back = await service.setStatus(ctx({ superAdmin: true }), String(kpm._id), 'active');
      expect(back.suspendedAt).toBeNull();
      expect(back.suspendedReason).toBeNull();
    });

    it('refuses suspension by a KPM Owner', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.setStatus(ctx({ owner: true }), String(kpm._id), 'suspended'),
      ).rejects.toMatchObject({ code: 'PERM_DENIED' });
    });
  });

  describe('reading a tenant profile', () => {
    it('lets an Owner read their own office', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      const read = await service.readProfile(ctx({ owner: true, kpmId: String(kpm._id) }), String(kpm._id));
      expect(read.branchName).toBe('BSD City Branch');
    });

    it('404s another office — never 403, which would confirm it exists', async () => {
      const mine = await service.createKpm(ctx({ superAdmin: true }), input());
      const theirs = await service.createKpm(ctx({ superAdmin: true }), { ...input(), code: '0289' });

      await expect(
        service.readProfile(ctx({ owner: true, kpmId: String(mine._id) }), String(theirs._id)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets a Super Admin read any office', async () => {
      const kpm = await service.createKpm(ctx({ superAdmin: true }), input());
      await expect(
        service.readProfile(ctx({ superAdmin: true }), String(kpm._id)),
      ).resolves.toBeDefined();
    });
  });

  describe('the platform overview (P3.5-T1)', () => {
    it('AC-2: is Super Admin only, like everything else on this console', async () => {
      await expect(service.platformOverview(ctx({ owner: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
      await expect(service.platformOverview(ctx({ admin: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
    });

    it('AC-2: counts companies, offices, members and Agency Builders across every tenant', async () => {
      // ADR-0011 retook ADR-0005 on exactly this: the prototype puts `Total members` and
      // `Agency Builders` on the front page, so aggregate composition is in scope.
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      const other = await service.createKpm(sa, { ...input(), code: '0555' });

      await seedMember(String(kpm._id), 'u-a', 'ab');
      await seedMember(String(kpm._id), 'u-b', 'agent');
      await seedMember(String(other._id), 'u-c', 'ab');

      const overview = await service.platformOverview(sa);
      expect(overview.tiles).toEqual({
        companies: 1,
        kpms: 2,
        totalMembers: 3,
        agencyBuilders: 2,
      });
    });

    it('AC-4: gives each company its own office and member totals', async () => {
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      await seedMember(String(kpm._id), 'u-a', 'agent');

      const [card] = (await service.platformOverview(sa)).companies;
      expect(card).toMatchObject({ kpmCount: 1, memberCount: 1 });
      expect(card.initials).toHaveLength(2);
    });

    it('AC-1: raises an office with no Owner, because only the platform can fix it', async () => {
      const sa = ctx({ superAdmin: true });
      await service.createKpm(sa, input());

      const { attention } = await service.platformOverview(sa);
      expect(attention).toHaveLength(1);
      expect(attention[0]).toMatchObject({
        tag: 'KPM owner',
        severity: 'structural',
        title: '1 office has no Owner',
      });
    });

    it('AC-1: says nothing when there is nothing to say', async () => {
      // The prototype's four rows come from sources that mostly do not exist yet — a
      // ladder request, pending registrations, template adoption, a product publish. An
      // empty queue is the honest answer; four invented rows would read as finished.
      const sa = ctx({ superAdmin: true });
      const kpm = await service.createKpm(sa, input());
      const user = await users.create({ email: 'o@kpm.test', fullName: 'Owner', passwordHash: 'x' });
      await service.assignOwner(sa, String(kpm._id), { userId: String(user._id) });

      expect((await service.platformOverview(sa)).attention).toEqual([]);
    });
  });

  describe('listing', () => {
    it('is Super Admin only', async () => {
      await expect(service.listAll(ctx({ owner: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
      await expect(service.listAll(ctx({ superAdmin: true }))).resolves.toEqual([]);
    });
  });
});
