import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuthGuard } from '@/common/auth/auth.guard';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { Clock, FixedClock } from '@/common/clock/clock.port';
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
import { AuthToken, AuthTokenSchema } from './auth-token.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ContextResolver } from './context-resolver';
import { ImpersonationService } from './impersonation.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter';
import { Hs256TokenSigner, TokenSigner } from './token-signer';

const NOW = new Date('2026-11-04T03:00:00Z');
const PASSWORD = 'correct horse battery';

interface Sent {
  userId?: string;
  templateId: string;
  payload: Record<string, unknown>;
}

/**
 * **Email, over HTTP** (P19-T1; UI-163, ADR-0190), through the real guards, context resolver, validation pipe and
 * service, `users` and `authTokens`; mail captured at the notification service.
 *
 * - `POST /auth/verify-email` `{ token }` — public; `200 { status: 'verified' }` on the press, and again for an address
 *   already verified; `400 AUTH_TOKEN_INVALID` for a link that names nobody or expired unverified.
 * - `POST /auth/login` — an unverified address signs in (`200`), where it was `403 AUTH_EMAIL_NOT_VERIFIED`.
 * - `GET /auth/me` — `user.emailVerified`, what the shells' banner reads.
 * - `POST /auth/resend-verification` — the banner's *Kirim ulang*, `202`, a new link to the signed-in person's address.
 * - `POST /auth/reset-password` — marks the address verified.
 *
 * No permission rows: `verify-email`, `login`, `resend-verification` and `reset-password` are public, and `/auth/me` is
 * any signed-in person's own (`AUTHENTICATED`). No cross-tenant case: the account is global (invariant 2), and nothing
 * here names an office.
 */
describe('P19-T1 email over HTTP (UI-163, ADR-0190)', () => {
  let app: INestApplication;
  const clock = new FixedClock(NOW);
  const signer = new Hs256TokenSigner('s'.repeat(40), clock);
  const passwords = new PasswordService();
  let users: mongoose.Model<User>;
  let auth: AuthService;
  let sent: Sent[] = [];
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        Reflector,
        { provide: Clock, useValue: clock },
        { provide: TokenSigner, useValue: signer },
        { provide: getModelToken(User.name), useValue: users },
        { provide: getModelToken(AuthToken.name), useValue: mongoose.model(AuthToken.name, AuthTokenSchema) },
        { provide: getModelToken(Company.name), useValue: mongoose.model(Company.name, CompanySchema) },
        { provide: getModelToken(Kpm.name), useValue: mongoose.model(Kpm.name, KpmSchema) },
        { provide: getModelToken(Membership.name), useValue: mongoose.model(Membership.name, MembershipSchema) },
        { provide: getModelToken(AuditLog.name), useValue: mongoose.model(AuditLog.name, AuditLogSchema) },
        { provide: PasswordService, useValue: passwords },
        { provide: NotificationService, useValue: { send: async (r: Sent) => { sent.push(r); } } },
        { provide: RateLimiter, useValue: new RateLimiter(clock) },
        { provide: ConfigService, useValue: { get: () => undefined, getOrThrow: () => 's'.repeat(40) } },
        { provide: ImpersonationService, useValue: { liveSession: async () => ({ readOnly: false, writeScope: [] }) } },
        AuditService, AuthService, MembershipRepository, ContextResolver, AuthGuard, PermissionsGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(app.get(AuthGuard), app.get(PermissionsGuard));
    await app.init();
    await listenOnLoopback(app);
    auth = app.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    clock.set(NOW);
    sent = [];
  });

  /** An account as registration leaves it — `invited`, unverified — and the link its mail carried. */
  async function registered(): Promise<{ userId: string; email: string; token: string }> {
    const email = `victor${++seq}@kpm.test`;
    const user = await users.create({
      email, passwordHash: await passwords.hash(PASSWORD), fullName: 'Victor Gunawan', status: 'invited', platformRole: 'none',
    });
    const token = await auth.issueVerification(user as never);
    return { userId: String(user._id), email, token };
  }

  const http = () => request(app.getHttpServer());
  const verify = (body: unknown) => http().post('/api/v1/auth/verify-email').send(body as object);
  const signIn = (email: string, password = PASSWORD) => http().post('/api/v1/auth/login').send({ email, password });
  const me = (accessToken: string) => http().get('/api/v1/auth/me').set({ Authorization: `Bearer ${accessToken}` });
  const lastToken = (templateId: string) => sent.filter((s) => s.templateId === templateId).at(-1)!.payload.token as string;

  it('P19-T1 AC-2 the press verifies, 200; pressing again answers 200 as well, the address verified once', async () => {
    const { userId, token } = await registered();
    expect((await verify({ token }).expect(200)).body).toEqual({ status: 'verified' });
    clock.set(new Date(NOW.getTime() + 60_000));
    expect((await verify({ token }).expect(200)).body).toEqual({ status: 'verified' });
    expect((await users.findById(userId).lean().exec())!.emailVerifiedAt).toEqual(NOW);
  });

  it('P19-T1 AC-2 a token that names nobody is 400 AUTH_TOKEN_INVALID, in the reader’s language', async () => {
    const refused = await verify({ token: 'never-issued' }).set('Accept-Language', 'id').expect(400);
    expect(refused.body.error).toMatchObject({ code: 'AUTH_TOKEN_INVALID', message: 'Tautan itu sudah tidak berlaku. Minta tautan baru.' });
  });

  it('P19-T1 AC-2 a link expired before the address was verified is 400 AUTH_TOKEN_INVALID; no token at all is 400 VALIDATION_FAILED', async () => {
    const { token } = await registered();
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    expect((await verify({ token }).expect(400)).body.error.code).toBe('AUTH_TOKEN_INVALID');
    expect((await verify({}).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
  });

  it('P19-T1 AC-4 an unverified address signs in; /auth/me says so until the link is pressed', async () => {
    const { email, token } = await registered();
    const login = await signIn(email).expect(200);
    const accessToken = login.body.accessToken as string;

    expect((await me(accessToken).expect(200)).body.user).toMatchObject({ email, emailVerified: false });
    await verify({ token }).expect(200);
    expect((await me(accessToken).expect(200)).body.user.emailVerified).toBe(true);
  });

  it('P19-T1 AC-4 the banner’s Kirim ulang sends a new link to the signed-in person’s address, and the new link verifies', async () => {
    const { userId, email } = await registered();
    sent = [];
    expect((await http().post('/api/v1/auth/resend-verification').send({ email }).expect(202)).body).toEqual({ status: 'accepted' });
    expect(sent.map((s) => [s.templateId, s.userId])).toEqual([['auth.email_verification', userId]]);

    await verify({ token: lastToken('auth.email_verification') }).expect(200);
    expect((await users.findById(userId).lean().exec())!.emailVerifiedAt).toEqual(NOW);
  });

  it('P19-T1 AC-3 a completed reset marks the address verified, and the person is told the password changed', async () => {
    const { userId, email } = await registered();
    await http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
    await http().post('/api/v1/auth/reset-password')
      .send({ token: lastToken('auth.password_reset'), newPassword: 'a brand new password' }).expect(200);

    expect(await users.findById(userId).lean().exec()).toMatchObject({ emailVerifiedAt: NOW, status: 'active' });
    expect(sent.map((s) => s.templateId)).toContain('auth.password_changed');
    const login = await signIn(email, 'a brand new password').expect(200);
    expect((await me(login.body.accessToken).expect(200)).body.user.emailVerified).toBe(true);
  });

  it('P19-T1 AC-5 a change of password from the profile sends the password-changed mail', async () => {
    const { email } = await registered();
    const login = await signIn(email).expect(200);
    sent = [];
    await http().post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' }).expect(200);
    expect(sent.map((s) => s.templateId)).toEqual(['auth.password_changed']);
  });

  it('P19-T1 AC-4 /auth/me is refused signed out, as before: 401', async () => {
    await http().get('/api/v1/auth/me').expect(401);
  });
});
