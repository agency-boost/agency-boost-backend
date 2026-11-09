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
  describe('a session only looks (P4-T10, §3.13; P19.4-T2, ADR-0206 §3)', () => {
    it('starts every session read-only, whoever starts it', async () => {
      const target = await makeUser();
      const { readOnly } = await service.start(superAdmin, String(target._id), 'ticket 42');
      expect(readOnly).toBe(true);
    });

    it('P19.4-T2 AC-1 answers the start with the token, its expiry, the session and readOnly — no purpose, no scope', async () => {
      const target = await makeUser();
      const started = await service.start(superAdmin, String(target._id), 'ticket 42');
      expect(Object.keys(started).sort()).toEqual(['accessToken', 'expiresAt', 'readOnly', 'sessionId']);
      expect(await service.liveSession(started.accessToken)).toMatchObject({
        readOnly: true, purpose: 'support', writeScope: [], elevatedByUserId: null, endReason: null,
      });
    });

    it('P19.4-T2 AC-1 the elevation a second Super Admin could approve is gone', () => {
      // `POST /admin/impersonation/:sessionId/elevate` answers 404 (`auth.e2e.int.spec.ts`); the method is gone too.
      expect((service as unknown as Record<string, unknown>).elevate).toBeUndefined();
    });

    it('P19.4-T2 AC-1 treats a row that could write as no session: a setup one, or one elevated before the deploy', async () => {
      const target = await makeUser();
      const Sessions = mongoose.model(ImpersonationSession.name);
      for (const [over, live] of [
        [{ purpose: 'setup', writeScope: ['tenant_config:write'] }, false],
        [{ readOnly: false, elevatedByUserId: 'sa-2' }, false],
        [{}, true],
      ] as const) {
        clock.advance(1000);
        const started = await service.start(superAdmin, String(target._id), 'ticket 42');
        await Sessions.updateOne({ _id: started.sessionId }, { $set: over });
        expect([over, Boolean(await service.liveSession(started.accessToken))]).toEqual([over, live]);
      }
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

  });

  /*
   * ADR-0168 §4 (OD-211): **a double start is refused, not crashed.** Two starts by one Super Admin as the same
   * person within one second sign the same token — `iat` is in seconds — so the second row's `tokenHash` met the
   * unique index and the API answered `500`. It is `409 IMPERSONATION_JUST_STARTED` now, and writes nothing.
   */
  describe('a double start (ADR-0168 §4)', () => {
    const Sessions = () => mongoose.model(ImpersonationSession.name);
    const JUST_STARTED = 'A session as this person started a moment ago. Use that one, or wait a second and start again.';

    /** An Agent in an office with an Owner, so one start tells two people: one round of notices is two. */
    async function anAgentWithAnOwner() {
      const ownerUser = await makeUser();
      const kpm = await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0420', branchName: 'BSD', timezone: 'Asia/Jakarta', locale: 'id-ID', currency: 'IDR',
        status: 'active', ownerUserId: String(ownerUser._id),
      } as never) as unknown as { _id: unknown };
      const target = await makeUser();
      await mongoose.model(Membership.name).create({
        kpmId: String(kpm._id), userId: String(target._id), role: 'agent', status: 'active', agentCode: 'A1',
        agentSeq: 1, orgLevelId: 'level-agent', orgLevelCode: 'AGENT', leaderCode: `LC${Math.floor(Math.random() * 100000)}`,
      } as never);
      return String(target._id);
    }

    // The unique index the collision meets, built before either start rather than racing them.
    beforeEach(async () => { await Sessions().init(); });

    it('answers the second start in the same second 409, and writes no row, no entry and no notice for it', async () => {
      const target = await anAgentWithAnOwner();
      const before = notified.length;

      const first = await service.start(superAdmin, target, 'Ticket 42');
      const round = notified.length - before;
      expect(round).toBe(2);

      const refused = await service.start(superAdmin, target, 'Ticket 42').catch((e) => e);
      expect(refused).toMatchObject({ code: 'IMPERSONATION_JUST_STARTED' });
      expect(refused.getStatus()).toBe(409);
      expect(refused.message).toBe(JUST_STARTED);

      expect(await Sessions().countDocuments({})).toBe(1);
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'impersonation.started' })).toBe(1);
      expect(notified.length - before).toBe(round);
      // The first session is untouched, and still the one to use.
      expect((await service.liveSession(first.accessToken))?.get('_id').toString()).toBe(first.sessionId);
    });

    it('collides whatever reason the second start gives, or whether it names support: neither is in the token', async () => {
      const owner = await makeUser();
      await mongoose.model(Kpm.name).create({
        companyId: 'c1', code: '0421', branchName: 'BSD', timezone: 'Asia/Jakarta', status: 'active',
        ownerUserId: String(owner._id),
      } as never);

      await service.start(superAdmin, String(owner._id), 'Ticket 42');
      await expect(service.start(superAdmin, String(owner._id), 'Looking at their overview', 60, 'support'))
        .rejects.toMatchObject({ code: 'IMPERSONATION_JUST_STARTED' });
      expect(await Sessions().countDocuments({})).toBe(1);
    });

    it('starts again a second later, as the message says', async () => {
      const target = await anAgentWithAnOwner();
      await service.start(superAdmin, target, 'Ticket 42');
      clock.advance(1000);
      await expect(service.start(superAdmin, target, 'Ticket 42')).resolves.toMatchObject({ readOnly: true });
      expect(await Sessions().countDocuments({})).toBe(2);
    });

    it('lets every other failure of the write through as it was: another index\'s collision, or no database', async () => {
      const target = await anAgentWithAnOwner();
      const otherIndex = Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { other: 1 } });
      const down = new Error('connection closed');
      const create = jest.spyOn(Sessions(), 'create')
        .mockRejectedValueOnce(otherIndex as never)
        .mockRejectedValueOnce(down as never);
      try {
        await expect(service.start(superAdmin, target, 'Ticket 42')).rejects.toBe(otherIndex);
        await expect(service.start(superAdmin, target, 'Ticket 42')).rejects.toBe(down);
      } finally {
        create.mockRestore();
      }
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'impersonation.started' })).toBe(0);
    });
  });

  /*
   * **No setup session** (P19.4-T2 AC-1, AC-5, AC-7; ADR-0206 §3, superseding ADR-0162). Each old *"a setup session may"*
   * is pinned the other way round: `setup` is refused, and nothing is written for it; a session as the Owner of a new
   * office only looks; and what does not change — the reason, the 60 minutes, the notices, the audit entry — is asked
   * again here.
   */
  describe('P19.4-T2 view-as only looks (ADR-0206)', () => {
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

    it('P19.4-T2 AC-1 refuses a setup session 400 VALIDATION_FAILED naming purpose, and writes nothing', async () => {
      const { owner, join } = await anOffice();
      const admin = await makeUser();
      await join(String(admin._id), { adminAccess: { isKpmAdmin: true, grantedAt: NOW, grantedByUserId: 'x' } });
      const told = notified.length;

      // As the Owner and as an Admin — the two a setup session acted as — and as anybody else.
      for (const target of [owner, String(admin._id), String((await makeUser())._id)]) {
        const refused = await service.start(superAdmin, target, 'Setting up activity types', 60, 'setup').catch((e) => e);
        expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'purpose' } });
        expect(refused.getStatus()).toBe(400);
        expect(refused.message).toBe(
          'A support session only looks: there is no setup session. Start one with no purpose, or with support.',
        );
      }
      expect(await mongoose.model(ImpersonationSession.name).countDocuments({})).toBe(0);
      expect(await mongoose.model(AuditLog.name).countDocuments({ action: 'impersonation.started' })).toBe(0);
      expect(notified).toHaveLength(told);
    });

    it('P19.4-T2 AC-7 (Overview case 9) a session as a new office\'s Owner, with no purpose or support, only looks', async () => {
      const { owner } = await anOffice();
      await expect(service.start(superAdmin, owner, 'Melihat saja')).resolves.toMatchObject({ readOnly: true });
      clock.advance(1000);
      const named = await service.start(superAdmin, owner, 'Melihat saja', 30, 'support');
      expect(await service.liveSession(named.accessToken)).toMatchObject({ readOnly: true, purpose: 'support', writeScope: [] });
    });

    it('P19.4-T2 AC-5 refuses a session into an office that is not active, under the office\'s own code, as before', async () => {
      const { owner } = await anOffice('suspended');
      await expect(service.start(superAdmin, owner, 'Ticket 42'))
        .rejects.toMatchObject({ code: 'IMPERSONATION_OFFICE_UNAVAILABLE' });
    });

    it('P19.4-T2 AC-5 records impersonation.started in the office with the reason, the length and the session', async () => {
      const { kpmId, owner } = await anOffice();
      const started = await service.start(superAdmin, owner, 'Checking their overview', 30);
      const row = await mongoose.model(AuditLog.name).findOne({ action: 'impersonation.started' });
      expect(row?.get('kpmId')).toBe(kpmId);
      expect(row?.get('actorUserId')).toBe('sa-1');
      expect(row?.get('after')).toEqual({
        reason: 'Checking their overview', minutes: 30, readOnly: true, sessionId: started.sessionId,
      });
    });

    it('P19.4-T2 AC-5 tells the person and the Owner, with a support session\'s notice', async () => {
      const { owner, join } = await anOffice();
      const admin = await makeUser();
      await join(String(admin._id), { adminAccess: { isKpmAdmin: true, grantedAt: NOW, grantedByUserId: 'x' } });
      payloads = [];

      await service.start(superAdmin, String(admin._id), 'Their products', 60);
      expect(payloads).toEqual([
        { userId: String(admin._id), payload: { reason: 'Their products', isSubject: true, purpose: 'support' } },
        { userId: owner, payload: { reason: 'Their products', isSubject: false, purpose: 'support' } },
      ]);
    });
  });

});
