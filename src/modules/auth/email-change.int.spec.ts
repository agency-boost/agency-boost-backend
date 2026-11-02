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

const NOW = new Date('2026-10-30T03:00:00Z');
const PASSWORD = 'correct horse battery';

interface Sent {
  userId?: string;
  templateId: string;
  payload: Record<string, unknown>;
  toAddress?: string;
}

/**
 * **The email change, over HTTP** (UI V1, 2026-10-30; UI-111; ADR-0181), through the real `AuthGuard`,
 * `ContextResolver`, `PermissionsGuard` and validation pipe, the real service, `authTokens`, `users` and audit log;
 * the mail captured at the notification service.
 *
 * - `POST /auth/me/email` `{ newEmail, currentPassword }` — `202`, nothing on the account changes; `400` for a
 *   malformed address, a missing password or the address the account has; `401` a wrong password; `409` a taken
 *   address; `429` past five an hour; `403` in any support session; `401` signed out.
 * - `POST /auth/verify-email-change` `{ token }` — public; `200 { status: 'changed', email }`, the account moved and
 *   still signed in; `400 AUTH_TOKEN_INVALID` for a link that does not work; `400 VALIDATION_FAILED` with no token.
 *
 * No cross-tenant case: the account is global and the route reaches only the caller's own (invariant 2).
 */
describe('UI-111 POST /auth/me/email and POST /auth/verify-email-change (ADR-0181)', () => {
  let app: INestApplication;
  const clock = new FixedClock(NOW);
  const signer = new Hs256TokenSigner('s'.repeat(40), clock);
  const passwords = new PasswordService();
  let users: mongoose.Model<User>;
  let audit: mongoose.Model<AuditLog>;
  let sent: Sent[] = [];
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    audit = mongoose.model(AuditLog.name, AuditLogSchema) as never;

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
        { provide: getModelToken(AuditLog.name), useValue: audit },
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
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    sent = [];
  });

  /** A verified account in no office — the route is the person's, whatever their office. */
  async function person(email = `agus${++seq}@kpm.test`): Promise<string> {
    const user = await users.create({
      email, passwordHash: await passwords.hash(PASSWORD), fullName: 'Agus Prasetyo', status: 'active',
      platformRole: 'none', emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    });
    return String(user._id);
  }

  const as = (userId: string, sid = 'session') => ({ Authorization: `Bearer ${signer.sign({ sub: userId, sid }, 3600)}` });
  const http = () => request(app.getHttpServer());
  const ask = (userId: string, body: unknown, sid?: string) =>
    http().post('/api/v1/auth/me/email').set(as(userId, sid)).send(body as object);
  const open = (body: unknown) => http().post('/api/v1/auth/verify-email-change').send(body as object);
  const emailOf = async (userId: string) => (await users.findById(userId).lean().exec())?.email;
  const tokenSentTo = (address: string) =>
    sent.find((s) => s.templateId === 'auth.email_change_verification' && s.toAddress === address)!.payload.token as string;

  it('UI-111 asks, 202, and changes nothing yet; the link then moves the account, 200 with the new address, still signed in', async () => {
    const userId = await person('agus@kpm.test');

    const asked = await ask(userId, { newEmail: ' Agus.Baru@KPM.test', currentPassword: PASSWORD }).expect(202);
    expect(asked.body).toEqual({ status: 'accepted' });
    expect(await emailOf(userId)).toBe('agus@kpm.test');
    expect(sent.map((s) => [s.templateId, s.toAddress ?? 'the account’s'])).toEqual([
      ['auth.email_change_verification', 'agus.baru@kpm.test'],
      ['auth.email_change_requested', 'the account’s'],
    ]);

    // Public: the link is opened from a mail client, signed in or not.
    const opened = await open({ token: tokenSentTo('agus.baru@kpm.test') }).expect(200);
    expect(opened.body).toEqual({ status: 'changed', email: 'agus.baru@kpm.test' });
    expect(await emailOf(userId)).toBe('agus.baru@kpm.test');

    // The session asked with is still good, and reads the new address.
    const me = await http().get('/api/v1/auth/me').set(as(userId)).expect(200);
    expect(me.body.user.email).toBe('agus.baru@kpm.test');

    const rows = await audit.find({ action: 'user.email_changed' }).lean().exec();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kpmId: null, actorUserId: userId, targetCollection: 'users', targetId: userId,
      before: { email: 'agus@kpm.test' }, after: { email: 'agus.baru@kpm.test' },
    });
  });

  it('UI-111 signs in with the new address afterwards, and no longer with the old one', async () => {
    const userId = await person('agus@kpm.test');
    await ask(userId, { newEmail: 'agus.baru@kpm.test', currentPassword: PASSWORD }).expect(202);
    await open({ token: tokenSentTo('agus.baru@kpm.test') }).expect(200);

    await http().post('/api/v1/auth/login').send({ email: 'agus@kpm.test', password: PASSWORD }).expect(401);
    await http().post('/api/v1/auth/login').send({ email: 'agus.baru@kpm.test', password: PASSWORD }).expect(200);
  });

  it.each([
    ['an address that is not one', { newEmail: 'not-an-address', currentPassword: PASSWORD }],
    ['no address', { currentPassword: PASSWORD }],
    ['no password', { newEmail: 'agus.baru@kpm.test' }],
    ['a field it does not take', { newEmail: 'agus.baru@kpm.test', currentPassword: PASSWORD, email: 'x@kpm.test' }],
  ])('UI-111 refuses %s, 400 VALIDATION_FAILED, and sends nothing', async (_, body) => {
    const userId = await person();

    const res = await ask(userId, body).expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sent).toEqual([]);
  });

  it('UI-111 refuses the address the account already has, 400 naming newEmail', async () => {
    const userId = await person('agus@kpm.test');

    const res = await ask(userId, { newEmail: 'AGUS@kpm.test', currentPassword: PASSWORD }).expect(400);

    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'newEmail' } });
  });

  it('UI-111 refuses a wrong password, 401 AUTH_INVALID_CREDENTIALS, as change-password does', async () => {
    const userId = await person();

    const res = await ask(userId, { newEmail: 'agus.baru@kpm.test', currentPassword: 'wrong password' }).expect(401);

    expect(res.body.error).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Your current password is not correct.' });
    expect(sent).toEqual([]);
  });

  it('UI-111 refuses an address another account has, 409 AUTH_EMAIL_TAKEN naming newEmail, in the reader’s language', async () => {
    const userId = await person();
    await person('dewi@kpm.test');

    const res = await ask(userId, { newEmail: 'dewi@kpm.test', currentPassword: PASSWORD }).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'AUTH_EMAIL_TAKEN', message: 'That address belongs to another account. Use a different one.',
      details: { field: 'newEmail' },
    });

    const id = await ask(userId, { newEmail: 'dewi@kpm.test', currentPassword: PASSWORD }).set('Accept-Language', 'id').expect(409);
    expect(id.body.error.message).toBe('Alamat itu sudah dipakai akun lain. Gunakan alamat lain.');
  });

  it('UI-111 asks at most five times an hour per account, then 429 AUTH_RATE_LIMITED', async () => {
    const userId = await person();
    for (let i = 0; i < 5; i += 1) {
      await ask(userId, { newEmail: `try${i}@kpm.test`, currentPassword: PASSWORD }).expect(202);
    }

    const res = await ask(userId, { newEmail: 'try5@kpm.test', currentPassword: PASSWORD }).expect(429);

    expect(res.body.error.code).toBe('AUTH_RATE_LIMITED');
  });

  it('UI-111 refuses it in a support session, 403 PERM_DENIED: a support session never changes somebody’s login', async () => {
    const userId = await person('agus@kpm.test');

    const res = await ask(userId, { newEmail: 'agus.baru@kpm.test', currentPassword: PASSWORD }, 'imp:sa-1').expect(403);

    expect(res.body.error.code).toBe('PERM_DENIED');
    expect(sent).toEqual([]);
  });

  it('UI-111 refuses somebody signed out, 401', async () => {
    await http().post('/api/v1/auth/me/email').send({ newEmail: 'agus.baru@kpm.test', currentPassword: PASSWORD }).expect(401);
  });

  it('UI-111 a link that does not work is 400 AUTH_TOKEN_INVALID, verify-email’s answer; no token at all is VALIDATION_FAILED', async () => {
    const userId = await person('agus@kpm.test');
    await ask(userId, { newEmail: 'agus.baru@kpm.test', currentPassword: PASSWORD }).expect(202);
    const token = tokenSentTo('agus.baru@kpm.test');
    await open({ token }).expect(200);

    const again = await open({ token }).expect(400);
    expect(again.body.error).toMatchObject({ code: 'AUTH_TOKEN_INVALID', message: 'That link is no longer valid. Request a new one.' });
    expect((await open({ token: 'made-up' }).expect(400)).body.error.code).toBe('AUTH_TOKEN_INVALID');
    expect((await open({}).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
  });

  it('UI-111 an address taken since the request is 409 on the link, and the account keeps its address', async () => {
    const userId = await person('agus@kpm.test');
    await ask(userId, { newEmail: 'agus.baru@kpm.test', currentPassword: PASSWORD }).expect(202);
    await person('agus.baru@kpm.test');

    const res = await open({ token: tokenSentTo('agus.baru@kpm.test') }).expect(409);

    expect(res.body.error.code).toBe('AUTH_EMAIL_TAKEN');
    expect(await emailOf(userId)).toBe('agus@kpm.test');
  });
});
