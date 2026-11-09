import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuthGuard } from '@/common/auth/auth.guard';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { listenOnLoopback } from '../../../test/listen';
import { productionPipe } from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AccountLink, AccountLinkSchema } from './account-link.schema';
import { AccountLinksController } from './account-links.controller';
import { AccountLinksService } from './account-links.service';
import { AuthToken, AuthTokenSchema } from './auth-token.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ContextResolver } from './context-resolver';
import { ImpersonationSession, ImpersonationSessionSchema } from './impersonation-session.schema';
import { ImpersonationService } from './impersonation.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter';
import { Hs256TokenSigner, TokenSigner } from './token-signer';

const NOW = new Date('2026-11-05T03:00:00Z');
const PASSWORD = 'correct horse battery';
const OTHER_PASSWORD = 'another horse battery';
const APP = 'https://app.agencyboost.test';

interface Sent {
  userId?: string;
  templateId: string;
  payload: Record<string, unknown>;
}

type Role = 'owner' | 'admin' | 'ab' | 'aab' | 'agent' | 'super_admin' | 'none';

/**
 * **P19.2-T1 AC-8 — linked logins, over HTTP** (UI-169 item 5;
 * [ADR-0199](../../../../docs/04-adr/0199-a-second-login-is-linked-through-its-own-mailbox-and-password.md)), through
 * the real `AuthGuard`, `ContextResolver`, `PermissionsGuard`, validation pipe and cookie parser, the real services,
 * `authTokens`, `accountLinks`, `users`, `memberships`, `kpms` and the audit log; the mail captured at the notification
 * service.
 *
 * - `POST /auth/links` — `202` whatever the other address is; the caller's password first, their address verified, five
 *   an hour, the Owner's, the Admin's and the Super Admin's alone.
 * - `POST /auth/links/confirm` — public; the token and the other login's password; parks a session of it beside the
 *   starting login's when this browser holds one.
 * - `POST /auth/links/switch` — the two cookies change places; never a session made from the other login's.
 * - `DELETE /auth/links/:linkId`; `GET /auth/me`'s `linkedLogin`; `POST /auth/logout` ending both.
 *
 * Global, as logins are (invariant 2): the cross-office case is a link between logins of two offices, and another
 * person's link answering `404`.
 */
describe('P19.2-T1 AC-8 linked logins (ADR-0199)', () => {
  let app: INestApplication;
  const clock = new FixedClock(NOW);
  const signer = new Hs256TokenSigner('s'.repeat(40), clock);
  const passwords = new PasswordService();
  const limiter = new RateLimiter(clock);
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let memberships: mongoose.Model<Membership>;
  let tokens: mongoose.Model<AuthToken>;
  let links: mongoose.Model<AccountLink>;
  let audit: mongoose.Model<AuditLog>;
  let sent: Sent[] = [];
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;
    tokens = mongoose.model(AuthToken.name, AuthTokenSchema) as never;
    links = mongoose.model(AccountLink.name, AccountLinkSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;
    await links.syncIndexes();

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, AccountLinksController],
      providers: [
        Reflector,
        { provide: Clock, useValue: clock },
        { provide: TokenSigner, useValue: signer },
        { provide: getModelToken(User.name), useValue: users },
        { provide: getModelToken(AuthToken.name), useValue: tokens },
        { provide: getModelToken(AccountLink.name), useValue: links },
        { provide: getModelToken(Company.name), useValue: mongoose.model(Company.name, CompanySchema) },
        { provide: getModelToken(Kpm.name), useValue: kpms },
        { provide: getModelToken(Membership.name), useValue: memberships },
        { provide: getModelToken(AuditLog.name), useValue: audit },
        { provide: PasswordService, useValue: passwords },
        { provide: NotificationService, useValue: { send: async (r: Sent) => { sent.push(r); } } },
        { provide: RateLimiter, useValue: limiter },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'CORS_ORIGINS' ? APP : undefined), getOrThrow: () => 's'.repeat(40) },
        },
        // An `imp:` session is live and may write: the refusals below are the routes' own, not a read-only session's.
        { provide: ImpersonationService, useValue: { liveSession: async () => ({ readOnly: false, writeScope: [] }) } },
        AuditService, AuthService, AccountLinksService, MembershipRepository, ContextResolver, AuthGuard, PermissionsGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(app.get(AuthGuard), app.get(PermissionsGuard));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    await links.syncIndexes();
    clock.set(NOW);
    (limiter as unknown as { windows: Map<string, unknown> }).windows.clear();
    sent = [];
  });

  // ------------------------------------------------------------------------- fixtures

  async function office(code: string): Promise<string> {
    const kpm = await kpms.create({ companyId: 'company-1', code, branchName: `${code} Branch`, timezone: 'Asia/Jakarta' });
    return String(kpm._id);
  }

  /** A login: a Super Admin, or a member of `kpmId` as the role says, or somebody in no office. */
  async function login(email: string, role: Role, opts: {
    kpmId?: string; verified?: boolean; status?: 'active' | 'deactivated'; password?: string; name?: string;
  } = {}): Promise<string> {
    const user = await users.create({
      email,
      passwordHash: await passwords.hash(opts.password ?? PASSWORD),
      fullName: opts.name ?? email.split('@')[0],
      status: opts.status ?? 'active',
      platformRole: role === 'super_admin' ? 'super_admin' : 'none',
      emailVerifiedAt: opts.verified === false ? null : new Date('2026-01-01T00:00:00Z'),
    });
    const userId = String(user._id);
    if (role === 'super_admin' || role === 'none') return userId;
    const kpmId = opts.kpmId ?? await office(`K${++seq}`);
    const rung = role === 'owner' || role === 'admin' ? 'ab' : role;
    seq += 1;
    await memberships.create({
      kpmId, userId, agentCode: `PRU-${seq}`, agentSeq: seq, leaderCode: `LC${String(seq).padStart(4, '0')}`,
      orgLevelId: `lvl-${rung}`, orgLevelCode: rung.toUpperCase(), role: rung, status: 'active',
      adminAccess: { isKpmAdmin: role === 'admin', grantedByUserId: null, grantedAt: null, revokedAt: null },
    });
    if (role === 'owner') await kpms.updateOne({ _id: kpmId }, { $set: { ownerUserId: userId } });
    return userId;
  }

  const http = () => request(app.getHttpServer());
  const bearer = (userId: string, sid = 'session') => ({ Authorization: `Bearer ${signer.sign({ sub: userId, sid }, 3600)}` });

  /** The value of one `Set-Cookie` the answer carries, `''` for a cleared one, `undefined` for none. */
  function cookieOf(res: request.Response, name: string): string | undefined {
    const all = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const line = all.find((c) => c.startsWith(`${name}=`));
    return line === undefined ? undefined : decodeURIComponent(line.slice(name.length + 1).split(';')[0]);
  }
  function cookieLine(res: request.Response, name: string): string {
    return ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';
  }
  const jar = (cookies: Record<string, string | null | undefined>) => Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('; ');

  /** Signs in as this browser would: the access token and the refresh cookie. */
  async function signIn(email: string, password = PASSWORD): Promise<{ access: string; refresh: string }> {
    const res = await http().post('/api/v1/auth/login').send({ email, password }).expect(200);
    return { access: res.body.accessToken as string, refresh: cookieOf(res, 'agencyboost_refresh')! };
  }

  const start = (userId: string, body: unknown, sid?: string) =>
    http().post('/api/v1/auth/links').set(bearer(userId, sid)).send(body as object);
  const confirm = (body: unknown, cookies: Record<string, string | null | undefined> = {}) =>
    http().post('/api/v1/auth/links/confirm').set('Cookie', jar(cookies)).send(body as object);
  const switchTo = (access: string, body: unknown, cookies: Record<string, string | null | undefined> = {}) =>
    http().post('/api/v1/auth/links/switch').set('Authorization', `Bearer ${access}`).set('Cookie', jar(cookies)).send(body as object);
  const meOf = async (access: string) =>
    (await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`).expect(200)).body;
  const linkTokenSentTo = (userId: string) =>
    sent.filter((s) => s.templateId === 'auth.account_link_request' && s.userId === userId).at(-1)!.payload.token as string;

  /** An Owner and a Super Admin login of one person, linked from the Owner's browser: the owner's own case. */
  async function linkedPair() {
    const ownerId = await login('owner@kpm0417.test', 'owner', { name: 'Wilson Tanoto' });
    const saId = await login('wilson@agencyboost.test', 'super_admin', { name: 'Wilson Tanoto', password: OTHER_PASSWORD });
    const owner = await signIn('owner@kpm0417.test');
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    const confirmed = await confirm(
      { token: linkTokenSentTo(saId), password: OTHER_PASSWORD }, { agencyboost_refresh: owner.refresh },
    ).expect(200);
    const parked = cookieOf(confirmed, 'agencyboost_refresh_linked')!;
    const link = await links.findOne({ deletedAt: null }).lean().exec();
    return { ownerId, saId, owner, parked, linkId: String(link!._id) };
  }

  // ---------------------------------------------------------------------- happy path

  it('P19.2-T1 AC-8 the happy path: start 202, the link to the other address, confirm with its password, both in the switcher', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner', { name: 'Wilson Tanoto' });
    const saId = await login('wilson@agencyboost.test', 'super_admin', { name: 'Wilson SA', password: OTHER_PASSWORD, verified: false });
    const owner = await signIn('owner@kpm0417.test');

    const started = await start(ownerId, { email: ' Wilson@AgencyBoost.test', currentPassword: PASSWORD }).expect(202);
    expect(started.body).toEqual({ status: 'accepted' });
    // The link to the other login's mailbox, naming who asked; the notice, with no link, to the caller's own.
    expect(sent.map((s) => [s.templateId, s.userId])).toEqual([
      ['auth.account_link_request', saId],
      ['auth.account_link_requested', ownerId],
    ]);
    expect(sent[0].payload).toMatchObject({ requesterName: 'Wilson Tanoto', requesterEmail: 'owner@kpm0417.test' });
    expect(sent[1].payload).toMatchObject({ linkEmail: 'wilson@agencyboost.test' });
    expect(await links.countDocuments()).toBe(0);

    // The token is hashed at rest, as every single-use token is: the raw value is in the mail alone.
    const raw = linkTokenSentTo(saId);
    const pending = await tokens.findOne({ kind: 'account_link' }).lean().exec();
    expect(pending).toMatchObject({ userId: ownerId, linkUserId: saId, usedAt: null, revokedAt: null });
    expect(pending!.tokenHash).not.toBe(raw);
    expect(pending!.expiresAt.getTime() - NOW.getTime()).toBe(24 * 3_600_000);

    sent = [];
    const confirmed = await confirm({ token: raw, password: OTHER_PASSWORD }, { agencyboost_refresh: owner.refresh }).expect(200);
    expect(confirmed.body).toEqual({ status: 'linked' });
    // This browser held the Owner's session, so the Super Admin login is signed in here too — parked, httpOnly.
    const parked = cookieLine(confirmed, 'agencyboost_refresh_linked');
    expect(parked).toMatch(/HttpOnly/);
    expect(parked).toMatch(/SameSite=Lax/);
    expect(parked).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookieOf(confirmed, 'agencyboost_refresh')).toBeUndefined();

    const link = await links.findOne({ deletedAt: null }).lean().exec();
    expect(link).toMatchObject({ userIds: [ownerId, saId].sort(), requestedBy: ownerId });
    // The link proved the other mailbox, as a reset link does.
    expect((await users.findById(saId).lean().exec())!.emailVerifiedAt).not.toBeNull();
    expect(sent.map((s) => [s.templateId, s.userId, s.payload.otherEmail])).toEqual([
      ['auth.account_linked', ownerId, 'wilson@agencyboost.test'],
      ['auth.account_linked', saId, 'owner@kpm0417.test'],
    ]);

    const asOwner = await meOf(owner.access);
    expect(asOwner.linkedLogin).toEqual({
      linkId: String(link!._id), userId: saId, email: 'wilson@agencyboost.test', fullName: 'Wilson SA',
      views: [{ kind: 'super_admin', officeName: null }],
    });
    const asSa = await meOf(signer.sign({ sub: saId, sid: 's' }, 3600));
    expect(asSa.linkedLogin).toMatchObject({
      userId: ownerId, email: 'owner@kpm0417.test',
      views: [{ kind: 'self', officeName: null }, { kind: 'kpm_owner', officeName: expect.stringMatching(/Branch$/) }],
    });

    const rows = await audit.find({ action: { $regex: /^account_link\./ } }).sort({ createdAt: 1 }).lean().exec();
    expect(rows.map((r) => [r.action, r.actorUserId, r.kpmId])).toEqual([
      ['account_link.requested', ownerId, null],
      ['account_link.created', saId, null],
    ]);
    expect(rows[0].after).toEqual({ linkUserId: saId });
    expect(rows[1].after).toMatchObject({ linkId: String(link!._id), userIds: [ownerId, saId].sort() });
    // No token and no password is ever stored in the audit log.
    expect(JSON.stringify(rows)).not.toContain(raw);
    expect(JSON.stringify(rows)).not.toContain(OTHER_PASSWORD);
  });

  it('P19.2-T1 AC-8 a switch moves between the two sessions this browser holds: the cookies change places, no sign-out', async () => {
    const { ownerId, saId, owner, parked, linkId } = await linkedPair();

    const switched = await switchTo(owner.access, { userId: saId }, {
      agencyboost_refresh: owner.refresh, agencyboost_refresh_linked: parked,
    }).expect(200);
    // The other login's access token: `me` is the Super Admin's.
    expect((await meOf(switched.body.accessToken)).user.id).toBe(saId);
    // Its parked token rotated into the active cookie; the Owner's, unchanged, parked.
    const active = cookieOf(switched, 'agencyboost_refresh')!;
    expect(active).toBeTruthy();
    expect(active).not.toBe(parked);
    expect(cookieOf(switched, 'agencyboost_refresh_linked')).toBe(owner.refresh);
    // The parked token is spent by its rotation — reused, it would revoke the Super Admin's session.
    expect((await tokens.findOne({ tokenHash: passwords.hashToken(parked) }).lean().exec())!.usedAt).not.toBeNull();

    // And back again, with the cookies as the browser now holds them.
    const back = await switchTo(switched.body.accessToken, { userId: ownerId }, {
      agencyboost_refresh: active, agencyboost_refresh_linked: owner.refresh,
    }).expect(200);
    expect((await meOf(back.body.accessToken)).user.id).toBe(ownerId);
    expect(cookieOf(back, 'agencyboost_refresh_linked')).toBe(active);

    const rows = await audit.find({ action: 'account_link.switched' }).sort({ createdAt: 1 }).lean().exec();
    expect(rows.map((r) => [r.actorUserId, r.after])).toEqual([
      [ownerId, { userId: saId, linkId, passwordAsked: false }],
      [saId, { userId: ownerId, linkId, passwordAsked: false }],
    ]);
  });

  it('P19.2-T1 AC-8 a link between logins of two offices: an Owner of one and an Admin of another', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    const adminId = await login('admin@kpm0555.test', 'admin', { password: OTHER_PASSWORD });
    await start(ownerId, { email: 'admin@kpm0555.test', currentPassword: PASSWORD }).expect(202);
    await confirm({ token: linkTokenSentTo(adminId), password: OTHER_PASSWORD }).expect(200);

    const me = await meOf(signer.sign({ sub: ownerId, sid: 's' }, 3600));
    expect(me.linkedLogin.views).toEqual([
      { kind: 'self', officeName: null }, { kind: 'kpm_admin', officeName: expect.stringMatching(/Branch$/) },
    ]);
    // Nothing of the other office is read but its name: the caller's own membership is still their own.
    expect(me.membership.isKpmOwner).toBe(true);
  });

  // -------------------------------------------------------------------------- start

  it.each([
    ['an address with no account', async () => undefined],
    ['a deleted login', async () => {
      await login('other@kpm.test', 'super_admin');
      await users.updateOne({ email: 'other@kpm.test' }, { $set: { deletedAt: NOW } });
    }],
    ['a deactivated login', async () => { await login('other@kpm.test', 'super_admin', { status: 'deactivated' }); }],
    ['an Agent’s login', async () => { await login('other@kpm.test', 'agent'); }],
    ['an AB’s login', async () => { await login('other@kpm.test', 'ab'); }],
    ['a login already linked', async () => {
      const otherId = await login('other@kpm.test', 'super_admin');
      const thirdId = await login('third@kpm.test', 'owner');
      await links.create({ userIds: [otherId, thirdId].sort(), requestedBy: thirdId });
    }],
  ])('P19.2-T1 AC-8 answers the same 202 for %s, and sends nothing: no oracle', async (_case, arrange) => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    await arrange();

    const res = await start(ownerId, { email: 'other@kpm.test', currentPassword: PASSWORD }).expect(202);

    expect(res.body).toEqual({ status: 'accepted' });
    expect(sent).toEqual([]);
    expect(await tokens.countDocuments({ kind: 'account_link' })).toBe(0);
    const row = await audit.findOne({ action: 'account_link.requested' }).lean().exec();
    expect(row).toMatchObject({ actorUserId: ownerId, kpmId: null, after: { linkUserId: null } });
  });

  it('P19.2-T1 AC-8 refuses a wrong password first, 401 AUTH_INVALID_CREDENTIALS, and sends nothing', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    await login('wilson@agencyboost.test', 'super_admin');

    const res = await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: 'wrong password' }).expect(401);

    expect(res.body.error).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Your current password is not correct.' });
    expect(sent).toEqual([]);
    expect(await audit.countDocuments({ action: { $regex: /^account_link\./ } })).toBe(0);
  });

  it('P19.2-T1 AC-8 refuses an unverified caller, 409 AUTH_EMAIL_NOT_VERIFIED: the starting address must be proven', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner', { verified: false });
    await login('wilson@agencyboost.test', 'super_admin');

    const res = await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(409);

    expect(res.body.error.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
    expect(sent).toEqual([]);
  });

  it('P19.2-T1 AC-8 refuses linking a login to itself, 400 naming email', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');

    const res = await start(ownerId, { email: 'OWNER@kpm0417.test', currentPassword: PASSWORD }).expect(400);

    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'email' } });
  });

  it('P19.2-T1 AC-8 refuses a second link while the first stands, 409 AUTH_LINK_EXISTS', async () => {
    const { ownerId } = await linkedPair();
    await login('third@kpm.test', 'super_admin');

    const res = await start(ownerId, { email: 'third@kpm.test', currentPassword: PASSWORD }).expect(409);

    expect(res.body.error.code).toBe('AUTH_LINK_EXISTS');
  });

  it('P19.2-T1 AC-8 starts at most five times an hour per account, then 429 AUTH_RATE_LIMITED', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    for (let i = 0; i < 5; i += 1) {
      await start(ownerId, { email: `try${i}@kpm.test`, currentPassword: PASSWORD }).expect(202);
    }

    const res = await start(ownerId, { email: 'try5@kpm.test', currentPassword: PASSWORD }).expect(429);

    expect(res.body.error.code).toBe('AUTH_RATE_LIMITED');
  });

  it.each([
    ['an Owner', 'owner', 202],
    ['an Admin', 'admin', 202],
    ['a Super Admin', 'super_admin', 202],
    ['an AB', 'ab', 403],
    ['an AAB', 'aab', 403],
    ['an Agent', 'agent', 403],
    ['somebody in no office', 'none', 403],
  ] as const)('P19.2-T1 AC-8 Tambah akun is offered to %s: %s', async (_who, role, status) => {
    const callerId = await login('caller@kpm.test', role);

    const res = await start(callerId, { email: 'nobody@kpm.test', currentPassword: PASSWORD }).expect(status);

    if (status === 403) expect(res.body.error).toMatchObject({ code: 'PERM_DENIED', details: { permission: 'account_link:create' } });
  });

  // ------------------------------------------------------------------------ confirm

  it('P19.2-T1 AC-8 a link expired, used or replaced is 400 AUTH_TOKEN_INVALID, and links nothing', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    const saId = await login('wilson@agencyboost.test', 'super_admin', { password: OTHER_PASSWORD });

    // Replaced: a newer start revokes the one before.
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    const first = linkTokenSentTo(saId);
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    const second = linkTokenSentTo(saId);
    expect((await confirm({ token: first, password: OTHER_PASSWORD }).expect(400)).body.error.code).toBe('AUTH_TOKEN_INVALID');

    // Expired: 24 hours, the verification link's lifetime.
    clock.advance(24 * 3_600_000 + 1);
    expect((await confirm({ token: second, password: OTHER_PASSWORD }).expect(400)).body.error.code).toBe('AUTH_TOKEN_INVALID');
    clock.set(NOW);

    // Used: once linked, the same link again is spent.
    await confirm({ token: second, password: OTHER_PASSWORD }).expect(200);
    const again = await confirm({ token: second, password: OTHER_PASSWORD }).expect(400);
    expect(again.body.error).toMatchObject({ code: 'AUTH_TOKEN_INVALID', message: 'That link is no longer valid. Request a new one.' });
    expect((await confirm({ token: 'made-up', password: OTHER_PASSWORD }).expect(400)).body.error.code).toBe('AUTH_TOKEN_INVALID');
    expect(await links.countDocuments()).toBe(1);
  });

  it('P19.2-T1 AC-8 a password change of the starting login revokes its pending link', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    const saId = await login('wilson@agencyboost.test', 'super_admin', { password: OTHER_PASSWORD });
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    const token = linkTokenSentTo(saId);

    await http().post('/api/v1/auth/change-password').set(bearer(ownerId))
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' }).expect(200);

    expect((await confirm({ token, password: OTHER_PASSWORD }).expect(400)).body.error.code).toBe('AUTH_TOKEN_INVALID');
    expect(await links.countDocuments()).toBe(0);
  });

  it('P19.2-T1 AC-8 the other login’s wrong password is 401 and spends nothing; the right one then links', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    const saId = await login('wilson@agencyboost.test', 'super_admin', { password: OTHER_PASSWORD });
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    const token = linkTokenSentTo(saId);

    const wrong = await confirm({ token, password: PASSWORD }).expect(401);
    expect(wrong.body.error).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS', message: 'That is not the password of that login.' });
    expect(await links.countDocuments()).toBe(0);
    // No session parked for a browser that did not hold the starting login's.
    const right = await confirm({ token, password: OTHER_PASSWORD }).expect(200);
    expect(cookieOf(right, 'agencyboost_refresh_linked')).toBeUndefined();
    expect(await links.countDocuments()).toBe(1);
  });

  it('P19.2-T1 AC-8 the other login’s password is limited as signing in is: five in 15 minutes, then 429', async () => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    const saId = await login('wilson@agencyboost.test', 'super_admin', { password: OTHER_PASSWORD });
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    const token = linkTokenSentTo(saId);
    for (let i = 0; i < 5; i += 1) await confirm({ token, password: `wrong ${i}` }).expect(401);

    expect((await confirm({ token, password: OTHER_PASSWORD }).expect(429)).body.error.code).toBe('AUTH_RATE_LIMITED');
  });

  it.each([
    ['the other login was linked since', 'linked', 409, 'AUTH_LINK_EXISTS'],
    ['the other login was deactivated since', 'deactivated', 403, 'AUTH_ACCOUNT_DEACTIVATED'],
    ['the starting login is no longer an Owner', 'demoted', 403, 'PERM_DENIED'],
  ] as const)('P19.2-T1 AC-8 a confirm after %s is refused and links nothing', async (_case, change, status, code) => {
    const ownerId = await login('owner@kpm0417.test', 'owner');
    const saId = await login('wilson@agencyboost.test', 'super_admin', { password: OTHER_PASSWORD });
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    const token = linkTokenSentTo(saId);
    if (change === 'linked') {
      const thirdId = await login('third@kpm.test', 'owner');
      await links.create({ userIds: [saId, thirdId].sort(), requestedBy: thirdId });
    }
    if (change === 'deactivated') await users.updateOne({ _id: saId }, { $set: { status: 'deactivated' } });
    if (change === 'demoted') await kpms.updateMany({}, { $set: { ownerUserId: null } });

    const res = await confirm({ token, password: OTHER_PASSWORD }).expect(status);

    expect(res.body.error.code).toBe(code);
    expect(await links.countDocuments({ requestedBy: ownerId })).toBe(0);
  });

  it('P19.2-T1 AC-8 the confirm refuses a page on another origin, 403 AUTH_ORIGIN_REFUSED, before anything is read', async () => {
    const res = await http().post('/api/v1/auth/links/confirm').set('Origin', 'https://evil.test')
      .send({ token: 'whatever', password: PASSWORD }).expect(403);
    expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
    await http().post('/api/v1/auth/links/confirm').set('Origin', APP).send({ token: 'whatever', password: PASSWORD }).expect(400);
  });

  // ------------------------------------------------------------------------- switch

  it('P19.2-T1 AC-8 a switch with no session of the other login asks for its password: 409, then 401 wrong, then 200', async () => {
    const { ownerId, saId, owner } = await linkedPair();

    // A browser that never held the Super Admin's session — no parked cookie, or one of another login's.
    const none = await switchTo(owner.access, { userId: saId }, { agencyboost_refresh: owner.refresh }).expect(409);
    expect(none.body.error).toMatchObject({ code: 'AUTH_LINK_SIGN_IN_REQUIRED' });
    expect(cookieOf(none, 'agencyboost_refresh')).toBeUndefined();
    await switchTo(owner.access, { userId: saId }, {
      agencyboost_refresh: owner.refresh, agencyboost_refresh_linked: owner.refresh,
    }).expect(409);

    const wrong = await switchTo(owner.access, { userId: saId, password: PASSWORD }, { agencyboost_refresh: owner.refresh }).expect(401);
    expect(wrong.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');

    const signedIn = await switchTo(owner.access, { userId: saId, password: OTHER_PASSWORD }, { agencyboost_refresh: owner.refresh }).expect(200);
    expect((await meOf(signedIn.body.accessToken)).user.id).toBe(saId);
    expect(cookieOf(signedIn, 'agencyboost_refresh_linked')).toBe(owner.refresh);
    const row = await audit.findOne({ action: 'account_link.switched' }).lean().exec();
    expect(row).toMatchObject({ actorUserId: ownerId, after: { userId: saId, passwordAsked: true } });
  });

  it('P19.2-T1 AC-8 a dead parked session is no session: after the other login signs out everywhere, 409', async () => {
    const { saId, owner, parked } = await linkedPair();
    await http().post('/api/v1/auth/logout-all').set(bearer(saId)).expect(204);

    const res = await switchTo(owner.access, { userId: saId }, {
      agencyboost_refresh: owner.refresh, agencyboost_refresh_linked: parked,
    }).expect(409);
    expect(res.body.error.code).toBe('AUTH_LINK_SIGN_IN_REQUIRED');
  });

  it('P19.2-T1 AC-8 another person’s link is never usable, and a login not linked to yours is 404', async () => {
    const { saId, parked } = await linkedPair();
    const strangerId = await login('stranger@kpm0555.test', 'owner');
    const stranger = await signIn('stranger@kpm0555.test');

    const res = await switchTo(stranger.access, { userId: saId }, { agencyboost_refresh_linked: parked }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await switchTo(stranger.access, { userId: strangerId }).expect(404);
    await switchTo(stranger.access, { userId: 'not-an-id' }).expect(400);
    // Nor can they remove it.
    const link = await links.findOne({ deletedAt: null }).lean().exec();
    await http().delete(`/api/v1/auth/links/${String(link!._id)}`).set('Authorization', `Bearer ${stranger.access}`).expect(404);
    expect(await links.countDocuments({ deletedAt: null })).toBe(1);
  });

  it('P19.2-T1 AC-8 a deactivated other login is 403, a deleted one 404 and gone from me', async () => {
    const { saId, owner, parked } = await linkedPair();
    await users.updateOne({ _id: saId }, { $set: { status: 'deactivated' } });
    const off = await switchTo(owner.access, { userId: saId }, { agencyboost_refresh_linked: parked }).expect(403);
    expect(off.body.error.code).toBe('AUTH_ACCOUNT_DEACTIVATED');

    await users.updateOne({ _id: saId }, { $set: { status: 'active', deletedAt: NOW } });
    await switchTo(owner.access, { userId: saId }, { agencyboost_refresh_linked: parked }).expect(404);
    expect((await meOf(owner.access)).linkedLogin).toBeNull();
  });

  it('P19.2-T1 AC-8 the switch refuses a page on another origin, 403 AUTH_ORIGIN_REFUSED', async () => {
    const { saId, owner, parked } = await linkedPair();
    const res = await http().post('/api/v1/auth/links/switch').set('Authorization', `Bearer ${owner.access}`)
      .set('Origin', 'https://evil.test').set('Cookie', jar({ agencyboost_refresh_linked: parked }))
      .send({ userId: saId }).expect(403);
    expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
  });

  // ------------------------------------------------------------------------- remove

  it('P19.2-T1 AC-8 removing the link takes it out of both switchers, clears the parked cookie, and a switch after is 404', async () => {
    const { ownerId, saId, owner, parked, linkId } = await linkedPair();

    const removed = await http().delete(`/api/v1/auth/links/${linkId}`).set('Authorization', `Bearer ${owner.access}`)
      .set('Cookie', jar({ agencyboost_refresh_linked: parked })).expect(204);
    expect(cookieOf(removed, 'agencyboost_refresh_linked')).toBe('');

    expect((await meOf(owner.access)).linkedLogin).toBeNull();
    expect((await meOf(signer.sign({ sub: saId, sid: 's' }, 3600))).linkedLogin).toBeNull();
    // Soft-deleted, never removed (invariant 6), and recorded.
    expect(await links.findById(linkId).lean().exec()).toMatchObject({ deletedBy: ownerId });
    expect(await audit.findOne({ action: 'account_link.removed' }).lean().exec())
      .toMatchObject({ actorUserId: ownerId, kpmId: null, after: { userId: saId, linkId } });
    // The other login's sessions are its own: the parked one is not revoked, it simply cannot be switched to any more.
    expect((await tokens.findOne({ tokenHash: passwords.hashToken(parked) }).lean().exec())!.revokedAt).toBeNull();
    const res = await switchTo(owner.access, { userId: saId }, { agencyboost_refresh_linked: parked }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await http().delete(`/api/v1/auth/links/${linkId}`).set('Authorization', `Bearer ${owner.access}`).expect(404);

    // Free to link again.
    await start(ownerId, { email: 'wilson@agencyboost.test', currentPassword: PASSWORD }).expect(202);
    expect(sent.some((s) => s.templateId === 'auth.account_link_request' && s.userId === saId)).toBe(true);
  });

  it('P19.2-T1 AC-8 either login of the pair may remove it', async () => {
    const { saId, linkId } = await linkedPair();
    await http().delete(`/api/v1/auth/links/${linkId}`).set(bearer(saId)).expect(204);
    expect(await links.countDocuments({ deletedAt: null })).toBe(0);
  });

  // ------------------------------------------------------------------- sign-out, me

  it('P19.2-T1 AC-8 Keluar ends both sessions this browser holds and clears both cookies', async () => {
    const { owner, parked } = await linkedPair();

    const out = await http().post('/api/v1/auth/logout').set('Cookie', jar({
      agencyboost_refresh: owner.refresh, agencyboost_refresh_linked: parked,
    })).expect(204);

    expect(cookieOf(out, 'agencyboost_refresh')).toBe('');
    expect(cookieOf(out, 'agencyboost_refresh_linked')).toBe('');
    for (const token of [owner.refresh, parked]) {
      expect((await tokens.findOne({ tokenHash: passwords.hashToken(token) }).lean().exec())!.revokedAt).not.toBeNull();
    }
    await http().post('/api/v1/auth/refresh').set('Cookie', jar({ agencyboost_refresh: parked })).expect(401);
  });

  // ---------------------------------------------------------------- support sessions

  it('P19.2-T1 AC-8 every link route is refused in a support session, and its me carries no linkedLogin', async () => {
    const { ownerId, saId, linkId } = await linkedPair();
    const session = bearer(ownerId, 'imp:sa-1');

    for (const res of [
      await start(ownerId, { email: 'x@kpm.test', currentPassword: PASSWORD }, 'imp:sa-1').expect(403),
      await http().post('/api/v1/auth/links/switch').set(session).send({ userId: saId }).expect(403),
      await http().delete(`/api/v1/auth/links/${linkId}`).set(session).expect(403),
    ]) {
      expect(res.body.error.code).toBe('PERM_DENIED');
    }
    const me = (await http().get('/api/v1/auth/me').set(session).expect(200)).body;
    expect(me.linkedLogin).toBeNull();
    expect(me.permissions).not.toContain('account_link:create');
    expect(me.permissions).not.toContain('account_link:manage_self');
    expect(await links.countDocuments({ deletedAt: null })).toBe(1);
  });

  it('P19.2-T1 AC-8 a Super Admin may not start a support session as a login linked to their own', async () => {
    const { ownerId, saId } = await linkedPair();
    const operatorId = await login('superadmin@agencyboost.test', 'super_admin');
    const impersonation = new ImpersonationService(
      users as never, kpms as never,
      mongoose.model(ImpersonationSession.name, ImpersonationSessionSchema) as never,
      app.get(MembershipRepository), { send: async () => undefined } as never, signer, passwords,
      app.get(AuditService), clock, links as never,
    );

    await expect(impersonation.start(new RequestContext(saId, 'super_admin', null), ownerId, 'checking a report'))
      .rejects.toMatchObject({ code: 'PERM_DENIED', message: 'That login is linked to yours. Switch to it from your avatar menu instead.' });
    // Another Super Admin, not linked, still may.
    await expect(impersonation.start(new RequestContext(operatorId, 'super_admin', null), ownerId, 'checking a report'))
      .resolves.toMatchObject({ readOnly: true });
  });

  it('P19.2-T1 AC-8 signed out, every link route but the public confirm is 401', async () => {
    await http().post('/api/v1/auth/links').send({ email: 'a@b.test', currentPassword: PASSWORD }).expect(401);
    await http().post('/api/v1/auth/links/switch').send({ userId: '6720a0a0a0a0a0a0a0a0a0a0' }).expect(401);
    await http().delete('/api/v1/auth/links/6720a0a0a0a0a0a0a0a0a0a0').expect(401);
  });
});
