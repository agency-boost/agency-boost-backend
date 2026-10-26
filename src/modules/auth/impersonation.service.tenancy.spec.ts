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
import { SETUP_SESSION_WRITE_SCOPE } from '@/modules/rbac/permissions';
import { Hs256TokenSigner } from './token-signer';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const NOW = new Date('2026-09-05T02:00:00Z');

describe('ImpersonationService', () => {
  let service: ImpersonationService;
  let signer: Hs256TokenSigner;
  let notified: { userId: string; templateId: string }[];
  /** What each notice carried, beside who was told: the kind of session is in it (ADR-0162 §3). */
  let payloads: { userId: string; payload: Record<string, unknown> }[];
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
    payloads = [];
    service = new ImpersonationService(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(ImpersonationSession.name, ImpersonationSessionSchema) as never,
      new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never),
      // A recording double: what matters is *who* was told, and the real service is
      // exercised in its own suite.
      { send: async (r: { userId?: string; templateId: string; payload?: Record<string, unknown> }) => {
        notified.push({ userId: r.userId ?? '', templateId: r.templateId });
        payloads.push({ userId: r.userId ?? '', payload: r.payload ?? {} });
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

  /*
   * **An office nobody can use** (P13.2 exit review): refused at the start under its own code, `409`,
   * naming the office and why — whoever in it is named. It was the member's `TENANT_SUSPENDED`, for an
   * office's Owner only: a session as anybody else in a suspended office started, and its first
   * request replaced the Super Admin's console with the member's *office unavailable* page.
   */
  describe('an office nobody can use (P13.2 exit review)', () => {
    async function memberOf(status: string, over: Record<string, unknown> = {}) {
      const kpm = await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0417', branchName: 'BSD', timezone: 'Asia/Jakarta', status, ...over,
      } as never) as unknown as { _id: unknown };
      const target = await makeUser();
      await mongoose.model(Membership.name).create({
        kpmId: String(kpm._id), userId: String(target._id), role: 'agent', status: 'active',
        agentCode: 'A1', agentSeq: 1, orgLevelId: 'level-agent', orgLevelCode: 'AGENT',
        leaderCode: `LC${Math.floor(Math.random() * 100000)}`,
      } as never);
      return String(target._id);
    }

    it('refuses an Owner of a suspended office, 409 with the office and the reason', async () => {
      const target = await makeUser();
      await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0417', branchName: 'BSD', ownerUserId: String(target._id),
        status: 'suspended',
      });
      const refused = await service.start(superAdmin, String(target._id), 'r').catch((e) => e);
      expect(refused).toMatchObject({
        code: 'IMPERSONATION_OFFICE_UNAVAILABLE',
        details: { kpmCode: '0417', branch: 'BSD', reason: 'suspended' },
      });
      expect(refused.getStatus()).toBe(409);
      expect(refused.message).toBe('KPM 0417 · BSD is suspended, so nobody can act as its members until it is reactivated.');
    });

    it.each(['suspended', 'archived'])('refuses an Agent of a %s office, and starts nothing', async (status) => {
      const target = await memberOf(status);
      const told = notified.length;
      await expect(service.start(superAdmin, target, 'ticket 42')).rejects.toMatchObject({
        code: 'IMPERSONATION_OFFICE_UNAVAILABLE',
        details: { kpmCode: '0417', branch: 'BSD', reason: status },
      });
      expect(await mongoose.model(ImpersonationSession.name).countDocuments({})).toBe(0);
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'impersonation.started' })).toBe(0);
      expect(notified).toHaveLength(told);
    });

    it('serves a member of an office whose subscription has ended: support may look into it', async () => {
      const target = await memberOf('active', {
        subscription: {
          startDate: '2026-01-01', endDate: '2026-08-31', pricePerLeaderMinor: null, currency: 'IDR',
          maxLeaders: null, keepActiveAfterEnd: false,
        },
      });
      await expect(service.start(superAdmin, target, 'ticket 42')).resolves.toMatchObject({ readOnly: true });
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

  /*
   * ADR-0162 (P18.9-T1 AC-1, AC-4, AC-6): **a setup session** — for an active office's Owner or one of its
   * Admins, read-only with the setup screens' permissions as its scope, started by one Super Admin alone.
   */
  describe('a setup session (P18.9-T1, ADR-0162)', () => {
    async function anOffice(status = 'active') {
      const ownerUser = await makeUser({ fullName: 'Rina Owner' });
      const kpm = await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'BSD',
        timezone: 'Asia/Jakarta', locale: 'id-ID', currency: 'IDR', status, ownerUserId: String(ownerUser._id),
      } as never) as unknown as { _id: unknown };
      const kpmId = String(kpm._id);
      const join = async (userId: string, over: Record<string, unknown> = {}) =>
        mongoose.model(Membership.name).create({
          kpmId, userId, role: 'agent', status: 'active', agentCode: `A${Math.random()}`, agentSeq: 1,
          orgLevelId: 'level-agent', orgLevelCode: 'AGENT', leaderCode: `LC${Math.floor(Math.random() * 100000)}`,
          ...over,
        } as never);
      await join(String(ownerUser._id), { role: 'ab', orgLevelCode: 'AB' });
      return { kpmId, owner: String(ownerUser._id), join };
    }

    it('AC-1 starts one as the Owner: read-only, with the setup scope on the row', async () => {
      const { owner } = await anOffice();
      const started = await service.start(superAdmin, owner, 'Setting up activity types', 60, 'setup');

      expect(started).toMatchObject({ readOnly: true, purpose: 'setup', writeScope: [...SETUP_SESSION_WRITE_SCOPE] });
      const row = await service.liveSession(started.accessToken);
      expect(row).toMatchObject({ readOnly: true, purpose: 'setup', elevatedByUserId: null });
      expect([...(row?.writeScope ?? [])]).toEqual([...SETUP_SESSION_WRITE_SCOPE]);
    });

    it('AC-1 starts one as one of the office\'s Admins', async () => {
      const { join } = await anOffice();
      const admin = await makeUser();
      await join(String(admin._id), { adminAccess: { isKpmAdmin: true, grantedAt: NOW, grantedByUserId: 'x' } });
      await expect(service.start(superAdmin, String(admin._id), 'Their lead statuses', 30, 'setup'))
        .resolves.toMatchObject({ purpose: 'setup' });
    });

    it('AC-1 refuses one as anybody else, 409, and starts nothing; a support session as them starts as before', async () => {
      const { join } = await anOffice();
      const agent = await makeUser();
      await join(String(agent._id));
      const nobody = await makeUser();
      const told = notified.length;

      for (const target of [String(agent._id), String(nobody._id)]) {
        const refused = await service.start(superAdmin, target, 'Setup', 60, 'setup').catch((e) => e);
        expect(refused).toMatchObject({ code: 'IMPERSONATION_SETUP_TARGET', details: { purpose: 'setup' } });
        expect(refused.getStatus()).toBe(409);
      }
      expect(await mongoose.model(ImpersonationSession.name).countDocuments({})).toBe(0);
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'impersonation.started' })).toBe(0);
      expect(notified).toHaveLength(told);

      await expect(service.start(superAdmin, String(agent._id), 'Ticket 42')).resolves
        .toMatchObject({ purpose: 'support', writeScope: [] });
    });

    it('AC-1 refuses one into an office that is not active, under the office\'s own code', async () => {
      const { owner } = await anOffice('suspended');
      await expect(service.start(superAdmin, owner, 'Setup', 60, 'setup'))
        .rejects.toMatchObject({ code: 'IMPERSONATION_OFFICE_UNAVAILABLE' });
    });

    it('AC-4 records the purpose and the session on impersonation.started, in the office', async () => {
      const { kpmId, owner } = await anOffice();
      const setup = await service.start(superAdmin, owner, 'Setting up', 60, 'setup');
      const row = await mongoose.model(AuditLog.name).findOne({ action: 'impersonation.started' });
      expect(row?.get('kpmId')).toBe(kpmId);
      expect(row?.get('actorUserId')).toBe('sa-1');
      expect(row?.get('after')).toMatchObject({
        reason: 'Setting up', minutes: 60, readOnly: true, purpose: 'setup', sessionId: setup.sessionId,
        writeScope: [...SETUP_SESSION_WRITE_SCOPE],
      });

      // A support session's entry names its purpose and its session too. A second later, or it is the same token.
      await mongoose.model(AuditLog.name).deleteMany({});
      clock.set(new Date(NOW.getTime() + 1000));
      const support = await service.start(superAdmin, owner, 'Ticket 42');
      expect((await mongoose.model(AuditLog.name).findOne({ action: 'impersonation.started' }))?.get('after'))
        .toMatchObject({ purpose: 'support', sessionId: support.sessionId, writeScope: [] });
    });

    it('AC-4 tells the person and the Owner that it is a setup session', async () => {
      const { owner, join } = await anOffice();
      const admin = await makeUser();
      await join(String(admin._id), { adminAccess: { isKpmAdmin: true, grantedAt: NOW, grantedByUserId: 'x' } });
      payloads = [];

      await service.start(superAdmin, String(admin._id), 'Their products', 60, 'setup');
      expect(payloads).toEqual([
        { userId: String(admin._id), payload: { reason: 'Their products', isSubject: true, purpose: 'setup' } },
        { userId: owner, payload: { reason: 'Their products', isSubject: false, purpose: 'setup' } },
      ]);
    });

    it('AC-6 one Super Admin suffices to start it, and elevating it still needs a second', async () => {
      const { owner } = await anOffice();
      const started = await service.start(superAdmin, owner, 'Setting up', 60, 'setup');

      await expect(service.elevate(superAdmin, started.sessionId, 'I need to change a role too.'))
        .rejects.toThrow('not the one running the session');
      expect((await service.liveSession(started.accessToken))?.readOnly).toBe(true);

      await service.elevate(new RequestContext('sa-2', 'super_admin', null), started.sessionId, 'A role needs fixing.');
      const elevated = await service.liveSession(started.accessToken);
      expect([elevated?.readOnly, elevated?.purpose, elevated?.elevatedByUserId]).toEqual([false, 'setup', 'sa-2']);
    });
  });

});
