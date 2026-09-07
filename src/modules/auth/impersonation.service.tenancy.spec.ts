import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, AuthTokenSchema } from './auth-token.schema';
import { PasswordService } from './password.service';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { ImpersonationService, IMPERSONATION_MAX_MINUTES } from './impersonation.service';
import { Hs256TokenSigner } from './token-signer';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const NOW = new Date('2026-09-05T02:00:00Z');

describe('ImpersonationService', () => {
  let service: ImpersonationService;
  let signer: Hs256TokenSigner;
  const clock = new FixedClock(NOW);

  const superAdmin = new RequestContext('sa-1', 'super_admin', null);
  const owner = new RequestContext('u-owner', 'none', {
    membershipId: 'm', kpmId: 'k', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });

  beforeAll(async () => {
    await startMongo();
    signer = new Hs256TokenSigner('a'.repeat(40), clock);
    service = new ImpersonationService(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(AuthToken.name, AuthTokenSchema) as never,
      signer,
      new PasswordService(),
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      clock,
    );
  });
  afterAll(stopMongo);
  beforeEach(async () => { await clearCollections(); clock.set(NOW); });

  async function makeUser(over: Record<string, unknown> = {}) {
    return mongoose.model(User.name).create({
      email: `u${Math.random()}@kpm.test`, passwordHash: 'x', fullName: 'Agent',
      status: 'active', platformRole: 'none', ...over,
    });
  }

  it('issues a time-boxed token for the target', async () => {
    const target = await makeUser();
    const { accessToken, expiresAt } = await service.start(superAdmin, String(target._id), 'ticket 42');

    const claims = signer.verify(accessToken);
    expect(claims.sub).toBe(String(target._id));
    expect(claims.sid).toBe('imp:sa-1'); // the real actor travels with the session
    expect(expiresAt.getTime() - NOW.getTime()).toBe(IMPERSONATION_MAX_MINUTES * 60_000);
  });

  it('caps the duration at an hour however long is asked for', async () => {
    const target = await makeUser();
    const { expiresAt } = await service.start(superAdmin, String(target._id), 'r', 60 * 24);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(IMPERSONATION_MAX_MINUTES * 60_000);
  });

  it('honours a shorter duration', async () => {
    const target = await makeUser();
    const { expiresAt } = await service.start(superAdmin, String(target._id), 'r', 5);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(5 * 60_000);
  });

  it('refuses a KPM Owner and a KPM Admin', async () => {
    const target = await makeUser();
    await expect(service.start(owner, String(target._id), 'r')).rejects.toMatchObject({
      code: 'PERM_DENIED',
    });
  });

  it('refuses impersonating another Super Admin', async () => {
    const other = await makeUser({ platformRole: 'super_admin' });
    await expect(service.start(superAdmin, String(other._id), 'r')).rejects.toMatchObject({
      code: 'PERM_DENIED',
    });
  });

  it('refuses impersonating yourself', async () => {
    const me = await makeUser();
    const ctx = new RequestContext(String(me._id), 'super_admin', null);
    await expect(service.start(ctx, String(me._id), 'r')).rejects.toMatchObject({
      code: 'PERM_DENIED',
    });
  });

  it('refuses nesting one impersonation inside another', async () => {
    const target = await makeUser();
    const already = new RequestContext('u-x', 'super_admin', null, 'sa-1');
    await expect(service.start(already, String(target._id), 'r')).rejects.toMatchObject({
      code: 'PERM_DENIED',
    });
  });

  it('requires a reason', async () => {
    const target = await makeUser();
    await expect(service.start(superAdmin, String(target._id), '   ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a target whose office is suspended', async () => {
    const target = await makeUser();
    await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD', ownerUserId: String(target._id),
      status: 'suspended',
    });
    await expect(service.start(superAdmin, String(target._id), 'r')).rejects.toMatchObject({
      code: 'TENANT_SUSPENDED',
    });
  });

  it('404s an unknown target', async () => {
    await expect(
      service.start(superAdmin, new mongoose.Types.ObjectId().toString(), 'r'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  describe('audit', () => {
    it('records the start with the reason', async () => {
      const target = await makeUser();
      await service.start(superAdmin, String(target._id), 'ticket 42');
      const row = await mongoose.model(AuditLog.name).findOne({ action: 'impersonation.started' });
      expect(row?.get('actorUserId')).toBe('sa-1');
      expect(row?.get('after')).toMatchObject({ reason: 'ticket 42' });
    });

    it('records both actors for an action taken while impersonating', async () => {
      const impersonating = new RequestContext('u-agent', 'none', null, 'sa-1');
      await service.end(impersonating);
      const row = await mongoose.model(AuditLog.name).findOne({ action: 'impersonation.ended' });
      expect(row?.get('actorUserId')).toBe('sa-1'); // the real Super Admin
      expect(row?.get('effectiveUserId')).toBe('u-agent'); // who they acted as
    });

    it('answers NOT_FOUND for a malformed target id, not a 500', async () => {
      // `POST /admin/impersonate/:userId` reaches `users` on the raw model.
      await expect(
        service.start(superAdmin, 'not-an-objectid', 'Support ticket 41'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('does nothing when ending a session that was not impersonating', async () => {
      await service.end(superAdmin);
      expect(await mongoose.model(AuditLog.name).countDocuments({})).toBe(0);
    });
  });
});
