import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
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
          isKpmAdmin: opts.admin ?? false,
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
    service = new TenantService(
      kpms as never,
      companies as never,
      users as never,
      new AuditService(auditModel as never),
      new FixedClock(NOW),
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

  describe('listing', () => {
    it('is Super Admin only', async () => {
      await expect(service.listAll(ctx({ owner: true }))).rejects.toMatchObject({
        code: 'PERM_DENIED',
      });
      await expect(service.listAll(ctx({ superAdmin: true }))).resolves.toEqual([]);
    });
  });
});
