import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import {
  ImpersonationSession, ImpersonationSessionSchema,
} from './impersonation-session.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
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
  let notified: { userId: string; templateId: string }[];
  const clock = new FixedClock(NOW);

  const superAdmin = new RequestContext('sa-1', 'super_admin', null);
  const owner = new RequestContext('u-owner', 'none', {
    membershipId: 'm', kpmId: 'k', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });

  beforeAll(async () => {
    await startMongo();
    signer = new Hs256TokenSigner('a'.repeat(40), clock);
    notified = [];
    service = new ImpersonationService(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(ImpersonationSession.name, ImpersonationSessionSchema) as never,
      new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never),
      // A recording double: what matters is *who* was told, and the real service is
      // exercised in its own suite.
      { send: async (r: { userId?: string; templateId: string }) => {
        notified.push({ userId: r.userId ?? '', templateId: r.templateId });
      } } as never,
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
  describe('read-only by default (P4-T10, §3.13)', () => {
    it('starts every session read-only, whoever starts it', async () => {
      // The operator who wants to write is not the one who decides they may.
      const target = await makeUser();
      const { readOnly } = await service.start(superAdmin, String(target._id), 'ticket 42');
      expect(readOnly).toBe(true);
    });

    it('lets a second Super Admin approve writing', async () => {
      const target = await makeUser();
      const started = await service.start(superAdmin, String(target._id), 'ticket 42');
      const second = new RequestContext('sa-2', 'super_admin', null);

      await service.elevate(second, started.sessionId, 'Their taxonomy has a duplicate code.');

      const live = await service.liveSession(started.accessToken);
      expect(live?.readOnly).toBe(false);
      expect(live?.elevatedByUserId).toBe('sa-2');
    });

    it('refuses the operator who started it, which is the whole rule', async () => {
      /*
       * A two-person rule that lets one person be both is a one-person rule with extra
       * steps. This is the assertion the control actually rests on.
       */
      const target = await makeUser();
      const started = await service.start(superAdmin, String(target._id), 'ticket 42');

      await expect(service.elevate(superAdmin, started.sessionId, 'I need to fix it.'))
        .rejects.toThrow('not the one running the session');
    });

    it('refuses somebody who is not a Super Admin at all', async () => {
      const target = await makeUser();
      const started = await service.start(superAdmin, String(target._id), 'ticket 42');
      await expect(service.elevate(owner, started.sessionId, 'Let me in.'))
        .rejects.toThrow('Only a Super Admin');
    });

    it('refuses an approver who is themselves inside a session', async () => {
      // Otherwise a session could approve itself by impersonating another Super Admin.
      const target = await makeUser();
      const started = await service.start(superAdmin, String(target._id), 'ticket 42');
      const inSession = new RequestContext('sa-2', 'super_admin', null, 'sa-3');

      await expect(service.elevate(inSession, started.sessionId, 'A good reason here.'))
        .rejects.toThrow('End your own support session');
    });

    it('demands a reason the Owner can read', async () => {
      const target = await makeUser();
      const started = await service.start(superAdmin, String(target._id), 'ticket 42');
      const second = new RequestContext('sa-2', 'super_admin', null);
      await expect(service.elevate(second, started.sessionId, '   '))
        .rejects.toThrow('Say why this session needs to write');
    });

    it('refuses to elevate a session that has ended', async () => {
      const target = await makeUser();
      const started = await service.start(superAdmin, String(target._id), 'ticket 42');
      await service.end(new RequestContext(String(target._id), 'none', null, 'sa-1'));

      const second = new RequestContext('sa-2', 'super_admin', null);
      await expect(service.elevate(second, started.sessionId, 'Too late for this.'))
        .rejects.toThrow('Support session');
    });
  });

  describe('who is told (P4-T10, §3.13)', () => {
    it('tells the person being impersonated, always', async () => {
      // Not a per-office setting. Somebody being acted as has a right to know.
      const target = await makeUser();
      await service.start(superAdmin, String(target._id), 'ticket 42');

      expect(notified).toContainEqual({
        userId: String(target._id), templateId: 'impersonation.started',
      });
    });

    it('tells the office’s Owner as well', async () => {
      const ownerUser = await makeUser();
      const kpm = await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0417', branchName: 'B', timezone: 'Asia/Jakarta',
        locale: 'id-ID', currency: 'IDR', status: 'active', ownerUserId: String(ownerUser._id),
      } as never);
      void kpm;
      const target = await makeUser();
      await mongoose.model(Membership.name).create({
        kpmId: String((kpm as unknown as { _id: unknown })._id),
        userId: String(target._id),
        role: 'agent', status: 'active', agentCode: 'A1', agentSeq: 1,
        orgLevelId: 'level-agent', orgLevelCode: 'AGENT',
        leaderCode: `LC${Math.floor(Math.random() * 100000)}`,
      } as never);

      await service.start(superAdmin, String(target._id), 'ticket 42');
      expect(notified.map((n) => n.userId)).toContain(String(ownerUser._id));
    });

    it('tells somebody once when they are both', async () => {
      // An Owner being impersonated is the subject and the Owner; two identical notices
      // would read as a bug rather than as thoroughness.
      const ownerUser = await makeUser();
      await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0418', branchName: 'B', timezone: 'Asia/Jakarta',
        locale: 'id-ID', currency: 'IDR', status: 'active', ownerUserId: String(ownerUser._id),
      } as never);

      await service.start(superAdmin, String(ownerUser._id), 'ticket 42');
      const toOwner = notified.filter((n) => n.userId === String(ownerUser._id));
      expect(toOwner).toHaveLength(1);
    });
  });

  describe('the refusals (P4-T12)', () => {
    it('refuses a second session from inside one', async () => {
      // Otherwise a chain of sessions has no real actor at its end — the audit row would
      // name whoever the previous session was already pretending to be.
      const target = await makeUser();
      const inSession = new RequestContext('sa-1', 'super_admin', null, 'sa-0');
      await expect(service.start(inSession, String(target._id), 'again'))
        .rejects.toThrow('already impersonating');
    });

    it('needs a separate grant to act as an office’s Owner or Admin', async () => {
      /*
       * §3.13 permits it — refusing outright would make the highest-value support cases
       * unsupportable, since tenant admins are exactly the users whose screens break —
       * and constrains it with its own permission. `start()` checked only for another
       * Super Admin until P4-T10.
       */
      const ownerUser = await makeUser();
      await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0419', branchName: 'B', timezone: 'Asia/Jakarta',
        locale: 'id-ID', currency: 'IDR', status: 'active', ownerUserId: String(ownerUser._id),
      } as never);

      // A Super Admin holds the grant, so this is allowed.
      await expect(service.start(superAdmin, String(ownerUser._id), 'their overview'))
        .resolves.toMatchObject({ readOnly: true });
    });

    it('refuses an id that is not an id, rather than answering 500', async () => {
      const second = new RequestContext('sa-2', 'super_admin', null);
      await expect(service.elevate(second, 'not-an-id', 'A good enough reason.'))
        .rejects.toThrow('Support session');
    });
  });

});
