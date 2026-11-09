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
import { NotificationService } from '@/modules/notifications/notification.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { User, UserDocument, UserSchema } from '@/modules/users/user.schema';
import { listenOnLoopback } from '../../../test/listen';
import { startMongo, stopMongo } from '../../../test/mongo';
import { AuthToken, AuthTokenDocument, AuthTokenSchema } from './auth-token.schema';
import { AuthController, REFRESH_LIMIT } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter';
import { Hs256TokenSigner, TokenSigner } from './token-signer';

const APP = 'https://agencyboost.id';
const STAGING = 'https://staging.agencyboost.id';
const PASSWORD = 'correct horse battery';
/** Two failed sign-ins per address per window, so a bucket fills in two requests rather than five. */
const LOGIN_LIMIT = 2;

/**
 * **The API behind one proxy, and the cookie on the wrong site** (P18.4-T1, ADR-0152), over HTTP.
 *
 * Booted through `configureApp`, the function `main.ts` calls, so `trust proxy` is set exactly as the
 * VM sets it, and `req.ip` is the one Express derives, not one a test made up. The configuration is the
 * validated shape: `TRUST_PROXY` arrives as `false` or a hop count.
 */
async function boot(uri: string, dbName: string, env: Record<string, unknown>): Promise<INestApplication> {
  const config = { NODE_ENV: 'production', CORS_ORIGINS: APP, RATE_LIMIT_LOGIN_PER_15M: LOGIN_LIMIT, ...env };
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
      // `/auth/me` reads and writes work status on the membership (ADR-0158).
      MembershipRepository,
      PasswordService,
      RateLimiter,
      { provide: Clock, useClass: SystemClock },
      { provide: TokenSigner, useFactory: (clock: Clock) => new Hs256TokenSigner('s'.repeat(40), clock), inject: [Clock] },
      // Nothing here sends mail: signing in and refreshing do not.
      { provide: NotificationService, useValue: { send: async () => undefined } },
      { provide: ConfigService, useValue: { get: (key: string, fallback?: unknown) => config[key as keyof typeof config] ?? fallback } },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  await listenOnLoopback(app);
  return app;
}

/** The refresh cookie a response set, as a `Cookie` header. Sent by hand: it is `Secure`, and this is http. */
function refreshCookieFrom(res: request.Response): string {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = set.find((c) => c.startsWith('agencyboost_refresh='));
  if (!cookie) throw new Error('no refresh cookie was set');
  return cookie.split(';')[0];
}

describe('the API behind a proxy, and the refresh cookie on a foreign origin (P18.4-T1)', () => {
  let uri: string;
  let dbName: string;
  let users: Model<UserDocument>;
  let tokens: Model<AuthTokenDocument>;
  const apps: INestApplication[] = [];

  async function app(env: Record<string, unknown>): Promise<INestApplication> {
    const booted = await boot(uri, dbName, env);
    apps.push(booted);
    users = booted.get(getModelToken(User.name));
    tokens = booted.get(getModelToken(AuthToken.name));
    return booted;
  }

  beforeAll(async () => {
    uri = await startMongo();
    dbName = mongoose.connection.db?.databaseName as string;
    await mongoose.disconnect();
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await stopMongo();
  });

  async function aVerifiedUser(email: string): Promise<void> {
    await users.create({
      email,
      passwordHash: await new PasswordService().hash(PASSWORD),
      fullName: 'Rina Wijaya',
      status: 'active',
      emailVerifiedAt: new Date(),
    });
  }

  /** A failed sign-in from `ip`, each with an address nobody has, so only the per-IP bucket fills. */
  function failFrom(server: INestApplication, ip: string | null, n: number) {
    const call = request(server.getHttpServer()).post('/api/v1/auth/login');
    if (ip) call.set('X-Forwarded-For', ip);
    return call.send({ email: `nobody-${ip ?? 'direct'}-${n}@kpm0417.test`, password: 'not the password' });
  }

  describe('TRUST_PROXY=1, behind Caddy', () => {
    let server: INestApplication;
    beforeAll(async () => {
      server = await app({ TRUST_PROXY: 1 });
    });

    it('P18.4-T1 two clients behind the proxy do not share a login bucket', async () => {
      // Client A spends its budget, and is then refused.
      for (let n = 0; n < LOGIN_LIMIT; n += 1) {
        await failFrom(server, '203.0.113.10', n).expect(401);
      }
      const refused = await failFrom(server, '203.0.113.10', 99).expect(429);
      expect(refused.body.error.code).toBe('AUTH_RATE_LIMITED');

      // Client B, at another address, is still asked for its password, not locked out with A.
      const other = await failFrom(server, '198.51.100.20', 0).expect(401);
      expect(other.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('ADR-0168, the permission review: garbage refresh tokens from one address do not lock out another', async () => {
      const garbageFrom = (ip: string, n: number) => request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', ip).send({ refreshToken: `not-a-token-${n}` });
      // The session limit, per address for a token that names no session (P19-T5: 30 a minute, was 60 an hour).
      for (let n = 0; n < REFRESH_LIMIT; n += 1) await garbageFrom('203.0.113.30', n).expect(401);
      expect((await garbageFrom('203.0.113.30', 99).expect(429)).body.error.code).toBe('AUTH_RATE_LIMITED');
      // Another browser with a dead cookie is still told its session ended.
      expect((await garbageFrom('198.51.100.40', 0).expect(401)).body.error.code).toBe('AUTH_SESSION_ENDED');
    });

    it('P18.4-T1 takes the hop the proxy wrote, not the one a client sent ahead of it', async () => {
      // A client that sends its own X-Forwarded-For: Caddy appends the address it saw, and that one counts.
      for (let n = 0; n < LOGIN_LIMIT; n += 1) {
        await request(server.getHttpServer()).post('/api/v1/auth/login')
          .set('X-Forwarded-For', `10.9.9.${n}, 192.0.2.77`)
          .send({ email: `rotating-${n}@kpm0417.test`, password: 'not the password' })
          .expect(401);
      }
      await request(server.getHttpServer()).post('/api/v1/auth/login')
        .set('X-Forwarded-For', '10.9.9.200, 192.0.2.77')
        .send({ email: 'rotating-last@kpm0417.test', password: 'not the password' })
        .expect(429);
    });

    it('P18.4-T1 the session row records the client\'s address, at sign-in and at each refresh', async () => {
      await aVerifiedUser('rina.proxy@kpm0417.test');
      const login = await request(server.getHttpServer()).post('/api/v1/auth/login')
        .set('X-Forwarded-For', '203.0.113.55')
        .send({ email: 'rina.proxy@kpm0417.test', password: PASSWORD })
        .expect(200);
      const user = await users.findOne({ email: 'rina.proxy@kpm0417.test' }).exec();
      const [signedIn] = await tokens.find({ userId: String(user?._id), kind: 'refresh' }).lean().exec();
      expect(signedIn.ip).toBe('203.0.113.55');

      // The same session, refreshed from another network: the new row records where it came from.
      await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', '198.51.100.66')
        .set('Origin', APP)
        .set('Cookie', refreshCookieFrom(login))
        .expect(200);
      const rows = await tokens.find({ userId: String(user?._id), kind: 'refresh' }).sort({ _id: 1 }).lean().exec();
      expect(rows.map((r) => r.ip)).toEqual(['203.0.113.55', '198.51.100.66']);
    });
  });

  describe('TRUST_PROXY=false, the default', () => {
    let server: INestApplication;
    beforeAll(async () => {
      server = await app({ TRUST_PROXY: false });
    });

    it('P18.4-T1 a forged X-Forwarded-For buys no new bucket: the socket is the client', async () => {
      for (let n = 0; n < LOGIN_LIMIT; n += 1) {
        await failFrom(server, `203.0.113.${100 + n}`, n).expect(401);
      }
      // A third "address", from the same socket, is the same client.
      const refused = await failFrom(server, '198.51.100.250', 0).expect(429);
      expect(refused.body.error.code).toBe('AUTH_RATE_LIMITED');
    });

    it('P18.4-T1 and the session row records the socket\'s address, not the header', async () => {
      await aVerifiedUser('rina.direct@kpm0417.test');
      // This app's IP bucket is spent by the test above; a success needs a fresh one, so boot another.
      const fresh = await app({ TRUST_PROXY: false });
      await request(fresh.getHttpServer()).post('/api/v1/auth/login')
        .set('X-Forwarded-For', '203.0.113.200')
        .send({ email: 'rina.direct@kpm0417.test', password: PASSWORD })
        .expect(200);
      const user = await users.findOne({ email: 'rina.direct@kpm0417.test' }).exec();
      const [row] = await tokens.find({ userId: String(user?._id), kind: 'refresh' }).lean().exec();
      expect(row.ip).not.toBe('203.0.113.200');
      expect(row.ip).toMatch(/127\.0\.0\.1$/);
    });
  });

  /*
   * The four hosts share the `agencyboost.id` site, so a page on staging is same-site with the production
   * API and the browser sends production's `SameSite=Lax` cookie with it. CORS hides the answer from the
   * page; without this the token had already rotated, or the session already ended.
   */
  describe('the Origin of a refresh or a sign-out that carries the cookie', () => {
    let server: INestApplication;
    let cookie: string;

    beforeAll(async () => {
      server = await app({ TRUST_PROXY: 1 });
      await aVerifiedUser('rina.origin@kpm0417.test');
    });

    beforeEach(async () => {
      const login = await request(server.getHttpServer()).post('/api/v1/auth/login')
        .set('X-Forwarded-For', '192.0.2.1')
        .send({ email: 'rina.origin@kpm0417.test', password: PASSWORD })
        .expect(200);
      cookie = refreshCookieFrom(login);
    });

    const live = async () => tokens.countDocuments({ kind: 'refresh', usedAt: null, revokedAt: null }).exec();

    it('P18.4-T1 refuses a refresh from a foreign origin with 403 AUTH_ORIGIN_REFUSED, and rotates nothing', async () => {
      const before = await live();
      const res = await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Origin', STAGING).set('Cookie', cookie)
        .expect(403);
      expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await live()).toBe(before);

      // The token is still good from the app's own origin: nothing was spent.
      await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Origin', APP).set('Cookie', cookie)
        .expect(200);
    });

    it('P18.4-T1 refuses a sign-out from a foreign origin, and the session survives it', async () => {
      const res = await request(server.getHttpServer()).post('/api/v1/auth/logout')
        .set('Origin', STAGING).set('Cookie', cookie)
        .expect(403);
      expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
      expect(res.headers['set-cookie']).toBeUndefined();

      await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Origin', APP).set('Cookie', cookie)
        .expect(200);
    });

    it('P18.4-T1 lets the app\'s own origin refresh and sign out', async () => {
      const refreshed = await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Origin', APP).set('Cookie', cookie)
        .expect(200);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));

      await request(server.getHttpServer()).post('/api/v1/auth/logout')
        .set('Origin', APP).set('Cookie', refreshCookieFrom(refreshed))
        .expect(204);
    });

    it('P18.4-T1 lets a request with no Origin through: a server or curl, not a page', async () => {
      const refreshed = await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      await request(server.getHttpServer()).post('/api/v1/auth/logout')
        .set('Cookie', refreshCookieFrom(refreshed))
        .expect(204);
    });

    it('P18.4-T1 leaves a foreign origin with no cookie alone: there is no session for it to spend', async () => {
      // A sign-out with nothing to sign out is a 204 wherever it comes from, as it was before.
      await request(server.getHttpServer()).post('/api/v1/auth/logout').set('Origin', STAGING).expect(204);
      // A refresh with no cookie and no body is refused for the reason it always was.
      const res = await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Origin', STAGING)
        .expect(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    /*
     * Swagger UI at `/api/docs` on staging is a page this API serves, and it posts to the API it came from.
     * Its origin is the API's own, which `CORS_ORIGINS` (the app's) does not list (the review's L3).
     */
    it('P18.4-T1 lets the API\'s own origin through, as Caddy forwards it', async () => {
      const own = 'https://staging-api.agencyboost.id';
      await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Host', 'staging-api.agencyboost.id').set('X-Forwarded-Proto', 'https').set('Origin', own)
        .set('Cookie', cookie)
        .expect(200);
      await request(server.getHttpServer()).post('/api/v1/auth/login')
        .set('Host', 'staging-api.agencyboost.id').set('X-Forwarded-Proto', 'https').set('Origin', own)
        .set('X-Forwarded-For', '192.0.2.1')
        .send({ email: 'rina.origin@kpm0417.test', password: PASSWORD })
        .expect(200);
      // Another host's page is still another origin, however close its name.
      const res = await request(server.getHttpServer()).post('/api/v1/auth/refresh')
        .set('Host', 'staging-api.agencyboost.id').set('X-Forwarded-Proto', 'https').set('Origin', 'https://api.agencyboost.id')
        .set('Cookie', cookie)
        .expect(403);
      expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
    });
  });

  /*
   * Login CSRF (the review's L1): a `<form method=POST>` on staging needs no preflight, and the cookie its
   * answer sets is kept, because the hosts are same-site. The browser would be signed in to whichever
   * account the form named.
   */
  describe('the Origin of a sign-in', () => {
    let server: INestApplication;

    beforeAll(async () => {
      server = await app({ TRUST_PROXY: 1 });
      await aVerifiedUser('rina.login@kpm0417.test');
    });

    const signIn = () => request(server.getHttpServer()).post('/api/v1/auth/login')
      .set('X-Forwarded-For', '192.0.2.9')
      .send({ email: 'rina.login@kpm0417.test', password: PASSWORD });

    it('P18.4-T1 refuses a sign-in from a foreign origin with no cookie, and sets none', async () => {
      const res = await signIn().set('Origin', STAGING).expect(403);
      expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('P18.4-T1 refuses it with a cookie too, and leaves the cookie\'s session alone', async () => {
      const cookie = refreshCookieFrom(await signIn().set('Origin', APP).expect(200));
      const res = await signIn().set('Origin', STAGING).set('Cookie', cookie).expect(403);
      expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
      await request(server.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', APP).set('Cookie', cookie).expect(200);
    });

    it('P18.4-T1 a refused sign-in spends nothing of the limiter\'s budget', async () => {
      for (let n = 0; n < LOGIN_LIMIT + 2; n += 1) {
        await signIn().set('Origin', STAGING).expect(403);
      }
      await signIn().set('Origin', APP).expect(200);
    });

    it('P18.4-T1 lets the app\'s own origin sign in, and a request with no Origin', async () => {
      const fromApp = await signIn().set('Origin', APP).expect(200);
      expect(refreshCookieFrom(fromApp)).toMatch(/^agencyboost_refresh=/);
      await signIn().expect(200);
    });
  });

  it('P18.4-T1 with the proxy untrusted, the API\'s own https origin reads as http and is refused: it fails closed', async () => {
    const server = await app({ TRUST_PROXY: false });
    const res = await request(server.getHttpServer()).post('/api/v1/auth/login')
      .set('Host', 'staging-api.agencyboost.id').set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://staging-api.agencyboost.id')
      .send({ email: 'nobody@kpm0417.test', password: 'not the password' })
      .expect(403);
    expect(res.body.error.code).toBe('AUTH_ORIGIN_REFUSED');
  });
});
