import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Model } from 'mongoose';
import request from 'supertest';
import { configureApp } from '@/bootstrap';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { REGISTRATION } from '@/domain/constants';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { User, UserDocument, UserSchema } from '@/modules/users/user.schema';
import { listenOnLoopback } from '../../../test/listen';
import { startMongo, stopMongo } from '../../../test/mongo';
import { AuthToken, AuthTokenDocument, AuthTokenSchema } from './auth-token.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter';
import { Hs256TokenSigner, TokenSigner } from './token-signer';

const APP = 'https://agencyboost.id';
const STAGING = 'https://staging.agencyboost.id';
const PASSWORD = 'correct horse battery';
const PERSONAL = { dateOfBirth: '1990-04-12', companyJoinMonth: '2020-03', workStatus: 'full_time', gender: 'male' };

/**
 * **Registering signs you in** (P19.12-T2 AC-3; ADR-0245 §3; the client's message of 11 November 2026, item 6), over
 * HTTP and through `configureApp`, as `auth-proxy.int.spec.ts` boots the API: an account made by `POST /auth/register`
 * is answered with an access token and given the refresh cookie `/auth/login` gives, its sign-in stamped and its
 * verification email still sent. An address that already had an account gets the neutral answer and no session. A page
 * on a foreign origin is refused before anything is made, and the per-address limit is as it was.
 */
describe('P19.12-T2 registering signs the new account in (ADR-0245 §3)', () => {
  let app: INestApplication;
  let users: Model<UserDocument>;
  let tokens: Model<AuthTokenDocument>;
  let companyId: string;
  let seq = 0;
  const sent: { userId: string; templateId: string }[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const uri = await startMongo();
    const dbName = mongoose.connection.db?.databaseName as string;
    await mongoose.disconnect();
    const config = { NODE_ENV: 'production', CORS_ORIGINS: APP, TRUST_PROXY: 1 };
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri, { dbName }),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: AuthToken.name, schema: AuthTokenSchema },
          { name: Company.name, schema: CompanySchema },
          { name: Membership.name, schema: MembershipSchema },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        MembershipRepository,
        PasswordService,
        RateLimiter,
        { provide: Clock, useClass: SystemClock },
        { provide: TokenSigner, useFactory: (clock: Clock) => new Hs256TokenSigner('s'.repeat(40), clock), inject: [Clock] },
        // The verification email, caught where it is handed over.
        { provide: NotificationService, useValue: { send: async (n: { userId: string; templateId: string }) => { sent.push(n); } } },
        { provide: ConfigService, useValue: { get: (key: string, fallback?: unknown) => config[key as keyof typeof config] ?? fallback } },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    users = app.get(getModelToken(User.name));
    tokens = app.get(getModelToken(AuthToken.name));
    const companies = app.get<Model<unknown>>(getModelToken(Company.name));
    companyId = String((await companies.create({ name: 'Prudential', slug: 'prudential-register' }) as { _id: unknown })._id);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  /** A sign-up with its own agent code, from its own client address unless one is named, so no test spends another's. */
  const register = (over: Record<string, unknown> = {}, ip?: string) => {
    seq += 1;
    return http()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', ip ?? `198.51.100.${seq}`)
      .send({
        email: `baru${seq}@example.test`, password: PASSWORD, fullName: 'Hadi Santoso', companyId,
        agentCode: String(70000 + seq), ...PERSONAL, ...over,
      });
  };

  /** A `Set-Cookie`'s attributes, its value and its moment of expiry left out: what login and register must share. */
  const attributesOf = (res: request.Response): string[] => {
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('agencyboost_refresh='));
    if (!cookie) throw new Error('no refresh cookie was set');
    return cookie.split(';').slice(1).map((a) => a.trim()).filter((a) => !/^expires=/i.test(a)).sort();
  };

  it('P19.12-T2 AC-3 a new account is answered with an access token and the refresh cookie login sets', async () => {
    const res = await register({ email: 'hadi.baru@example.test' }).set('Origin', APP).expect(201);
    expect(res.body).toEqual({ status: 'signed_in', accessToken: expect.any(String), expiresIn: 900 });

    await users.create({
      email: 'rina.login@example.test', passwordHash: await new PasswordService().hash(PASSWORD), fullName: 'Rina',
      status: 'active', emailVerifiedAt: new Date(),
    });
    const login = await http().post('/api/v1/auth/login').set('Origin', APP).set('X-Forwarded-For', '203.0.113.1')
      .send({ email: 'rina.login@example.test', password: PASSWORD }).expect(200);
    expect(attributesOf(res)).toEqual(attributesOf(login));
    expect(attributesOf(res)).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax']));
  });

  it('P19.12-T2 AC-3 the session is real: the cookie refreshes, the sign-in is stamped, the address is still unverified', async () => {
    const res = await register({ email: 'citra.baru@example.test' }).expect(201);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0].split(';')[0];
    const account = (await users.findOne({ email: 'citra.baru@example.test' }).exec())!;
    expect(account.lastLoginAt).toBeInstanceOf(Date);
    expect(account.emailVerifiedAt).toBeNull();
    expect(await tokens.countDocuments({ userId: String(account._id), kind: 'refresh' })).toBe(1);
    // The verification email is still sent (ADR-0190 §4: optional, never withheld).
    expect(sent).toContainEqual(expect.objectContaining({
      userId: String(account._id), templateId: NotificationTemplate.EMAIL_VERIFICATION,
    }));
    const refreshed = await http().post('/api/v1/auth/refresh').set('Origin', APP).set('Cookie', cookie).expect(200);
    expect(refreshed.body).toEqual({ accessToken: expect.any(String), expiresIn: 900 });
  });

  it('P19.12-T2 AC-3 an address that already had an account is answered as before, signs nobody in, makes nothing', async () => {
    await register({ email: 'sudah.ada@example.test' }).expect(201);
    const before = await tokens.countDocuments({});
    const res = await register({ email: 'sudah.ada@example.test', password: 'a different password' }).expect(201);
    expect(res.body).toEqual({ status: 'verification_sent' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await tokens.countDocuments({})).toBe(before);
    expect(await users.countDocuments({ email: 'sudah.ada@example.test' })).toBe(1);
  });

  it('P19.12-T2 AC-3 a sign-up from a foreign origin is 403 AUTH_ORIGIN_REFUSED: no account, no cookie, no budget spent', async () => {
    const ip = '192.0.2.77';
    for (let n = 0; n < REGISTRATION.MAX_PER_ADDRESS + 1; n += 1) {
      const res = await register({ email: `forged${n}@example.test` }, ip).set('Origin', STAGING).expect(403);
      expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(await users.countDocuments({ email: /^forged/ })).toBe(0);
    // Refused before the limiter: the address's hour is untouched, and the app's own origin signs up.
    await register({ email: 'own.origin@example.test' }, ip).set('Origin', APP).expect(201);
    // A request with no Origin is not a page, and is let through.
    await register({ email: 'no.origin@example.test' }).expect(201);
  });

  it('P19.12-T2 AC-3 the per-address limit is unchanged: the twenty-first sign-up in an hour is 429, refused or not', async () => {
    const ip = '192.0.2.88';
    for (let n = 0; n < REGISTRATION.MAX_PER_ADDRESS; n += 1) {
      // Refused by the service — a birth date under eighteen years ago — and counted all the same.
      await register({ email: `probe${n}@example.test`, dateOfBirth: '2015-01-01' }, ip).expect(400);
    }
    const res = await register({ email: 'one.more@example.test' }, ip).expect(429);
    expect(res.body.error.code).toBe('AUTH_RATE_LIMITED');
    expect(await users.countDocuments({ email: 'one.more@example.test' })).toBe(0);
  });
});
