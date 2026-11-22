import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { ImpersonationSession, ImpersonationSessionSchema } from './impersonation-session.schema';
import {
  IMPERSONATION_HANDOFF_SECONDS, IMPERSONATION_MAX_MINUTES, ImpersonationService,
} from './impersonation.service';
import { PasswordService } from './password.service';
import { Hs256TokenSigner } from './token-signer';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const NOW = new Date('2026-11-20T03:00:00Z');

/**
 * **P19.23-T2 AC-7 — *Lihat sebagai* opens a new window** (ADR-0277): the session is started with no token, the window
 * redeems a one-time code for one, once, within `IMPERSONATION_HANDOFF_SECONDS`, as the Super Admin who started it.
 */
describe('P19.23-T2 AC-7 ImpersonationService — the new window\'s one-time code', () => {
  let service: ImpersonationService;
  let signer: Hs256TokenSigner;
  const clock = new FixedClock(NOW);
  const passwords = new PasswordService();
  const sessions = () => mongoose.model(ImpersonationSession.name, ImpersonationSessionSchema);
  const audit = () => mongoose.model(AuditLog.name, AuditLogSchema);

  const superAdmin = new RequestContext('sa-1', 'super_admin', null);
  const otherSuperAdmin = new RequestContext('sa-2', 'super_admin', null);

  beforeAll(async () => {
    await startMongo();
    signer = new Hs256TokenSigner('a'.repeat(40), clock);
    service = new ImpersonationService(
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      sessions() as never,
      new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never),
      { send: async () => undefined } as never,
      signer,
      passwords,
      new AuditService(audit() as never),
      clock,
    );
  });
  afterAll(stopMongo);
  beforeEach(async () => { await clearCollections(); clock.set(NOW); });

  async function agentInOffice() {
    const kpm = await mongoose.model(Kpm.name).create({
      companyId: 'c1', code: '0417', branchName: 'BSD City Branch', timezone: 'Asia/Jakarta', status: 'active',
    } as never) as unknown as { _id: unknown };
    const target = await mongoose.model(User.name).create({
      email: `rina${Math.random()}@kpm.test`, passwordHash: 'x', fullName: 'Rina Wijaya', status: 'active',
      platformRole: 'none',
    }) as unknown as { _id: unknown };
    await mongoose.model(Membership.name).create({
      kpmId: String(kpm._id), userId: String(target._id), role: 'agent', status: 'active',
      agentCode: 'A1', agentSeq: 1, orgLevelId: 'level-agent', orgLevelCode: 'AGENT',
      leaderCode: `LC${Math.floor(Math.random() * 100000)}`,
    });
    return { kpmId: String(kpm._id), userId: String(target._id) };
  }

  it('P19.23-T2 AC-7 starts the session with no token: a code, its 60 seconds, and the session\'s hour', async () => {
    const { userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent dari halaman KPM');

    expect(started).not.toHaveProperty('accessToken');
    expect(started.handoffCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.handoffExpiresAt.getTime() - NOW.getTime()).toBe(IMPERSONATION_HANDOFF_SECONDS * 1000);
    expect(started.expiresAt.getTime() - NOW.getTime()).toBe(IMPERSONATION_MAX_MINUTES * 60_000);
    expect(started.readOnly).toBe(true);

    // Stored hashed, never as typed; the row's token hash matches no token anybody holds.
    const row = await sessions().findById(started.sessionId).lean().exec() as Record<string, unknown>;
    expect(row.handoffCodeHash).toBe(passwords.hashToken(started.handoffCode));
    expect(row.handoffRedeemedAt).toBeNull();
    expect(JSON.stringify(row)).not.toContain(started.handoffCode);
    expect(await service.liveSession(started.handoffCode)).toBeNull();
  });

  it('P19.23-T2 AC-7 records the start as any session\'s, marked as a window', async () => {
    const { kpmId, userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent');
    const entry = await audit().findOne({ action: 'impersonation.started' }).lean().exec() as Record<string, unknown>;
    expect(entry).toMatchObject({ kpmId, targetId: userId });
    expect(entry.after).toMatchObject({ sessionId: started.sessionId, readOnly: true, window: true });
  });

  it('P19.23-T2 AC-7 redeems the code once for a token of the rest of the session, as the person', async () => {
    const { kpmId, userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent');
    clock.set(new Date(NOW.getTime() + 20_000));

    const taken = await service.redeemHandoff(superAdmin, started.handoffCode);

    const claims = signer.verify(taken.accessToken);
    expect(claims.sub).toBe(userId);
    expect(claims.sid).toBe('imp:sa-1');
    expect(taken).toMatchObject({ sessionId: started.sessionId, readOnly: true, expiresAt: started.expiresAt });
    // The guard now finds the session by that token: it is live.
    expect(String((await service.liveSession(taken.accessToken))?._id)).toBe(started.sessionId);
    const entry = await audit().findOne({ action: 'impersonation.window_opened' }).lean().exec() as Record<string, unknown>;
    expect(entry).toMatchObject({ kpmId, targetId: userId, after: { sessionId: started.sessionId } });
  });

  it('P19.23-T2 AC-7 a second redemption is 410 used, and mints nothing', async () => {
    const { userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent');
    const first = await service.redeemHandoff(superAdmin, started.handoffCode);

    await expect(service.redeemHandoff(superAdmin, started.handoffCode)).rejects.toMatchObject({
      code: 'IMPERSONATION_HANDOFF_SPENT', status: 410, details: { reason: 'used' },
    });
    // The first window's token still works; nothing was replaced.
    expect(await service.liveSession(first.accessToken)).not.toBeNull();
  });

  it('P19.23-T2 AC-7 two redemptions at once mint one session', async () => {
    const { userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent');
    const results = await Promise.allSettled([
      service.redeemHandoff(superAdmin, started.handoffCode),
      service.redeemHandoff(superAdmin, started.handoffCode),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it(`P19.23-T2 AC-7 past ${IMPERSONATION_HANDOFF_SECONDS} seconds the code is 410 expired`, async () => {
    const { userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent');
    clock.set(new Date(NOW.getTime() + IMPERSONATION_HANDOFF_SECONDS * 1000));
    await expect(service.redeemHandoff(superAdmin, started.handoffCode)).rejects.toMatchObject({
      code: 'IMPERSONATION_HANDOFF_SPENT', status: 410, details: { reason: 'expired' },
    });
  });

  it('P19.23-T2 AC-7 a session ended before the window opened is 410 ended', async () => {
    const { userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent');
    await sessions().updateOne({ _id: started.sessionId }, { $set: { endedAt: NOW } }).exec();
    await expect(service.redeemHandoff(superAdmin, started.handoffCode)).rejects.toMatchObject({
      code: 'IMPERSONATION_HANDOFF_SPENT', details: { reason: 'ended' },
    });
  });

  it('P19.23-T2 AC-7 another Super Admin\'s code, and an unknown one, are 404', async () => {
    const { userId } = await agentInOffice();
    const started = await service.startForWindow(superAdmin, userId, 'Lihat sebagai Agent');
    await expect(service.redeemHandoff(otherSuperAdmin, started.handoffCode)).rejects.toMatchObject({
      code: 'NOT_FOUND', status: 404,
    });
    await expect(service.redeemHandoff(superAdmin, passwords.generateToken())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.redeemHandoff(superAdmin, '')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // And the rightful Super Admin can still take it up: a wrong one spent nothing.
    await expect(service.redeemHandoff(superAdmin, started.handoffCode)).resolves.toHaveProperty('accessToken');
  });

  it('P19.23-T2 AC-7 refuses a tenant role and a support session, before reading any code', async () => {
    const owner = new RequestContext('u-owner', 'none', {
      membershipId: 'm', kpmId: 'k', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
      isKpmOwner: true, isKpmAdmin: false, directCount: 0,
    });
    const inSession = new RequestContext('u-x', 'super_admin', null, 'sa-1');
    await expect(service.redeemHandoff(owner, 'x'.repeat(43))).rejects.toMatchObject({ code: 'PERM_DENIED' });
    await expect(service.redeemHandoff(inSession, 'x'.repeat(43))).rejects.toMatchObject({ code: 'PERM_DENIED' });
  });

  it('P19.23-T2 AC-7 a window start is refused as any start is: another Super Admin, no reason', async () => {
    const other = await mongoose.model(User.name).create({
      email: 'sa2@agencyboost.test', passwordHash: 'x', fullName: 'Other', status: 'active', platformRole: 'super_admin',
    }) as unknown as { _id: unknown };
    await expect(service.startForWindow(superAdmin, String(other._id), 'r')).rejects.toMatchObject({ code: 'PERM_DENIED' });
    const { userId } = await agentInOffice();
    await expect(service.startForWindow(superAdmin, userId, '  ')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await sessions().countDocuments({}).exec()).toBe(0);
  });

  it('P19.23-T2 AC-7 a same-tab start keeps its token and carries no code', async () => {
    const { userId } = await agentInOffice();
    const started = await service.start(superAdmin, userId, 'ticket 42');
    expect(started).not.toHaveProperty('handoffCode');
    const row = await sessions().findById(started.sessionId).lean().exec() as Record<string, unknown>;
    expect(row.handoffCodeHash).toBeNull();
    expect(await service.liveSession(started.accessToken)).not.toBeNull();
  });
});
