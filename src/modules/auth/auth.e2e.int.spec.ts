import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Reflector, APP_FILTER } from '@nestjs/core';
import mongoose, { Connection, Model } from 'mongoose';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Clock, SystemClock } from '@/common/clock/clock.port';
import { AuthGuard } from '@/common/auth/auth.guard';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import {
  Notification, NotificationDocument, NotificationPreferences,
  NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import {
  NOTIFICATION_ADAPTERS, NotificationService, TemplateRenderer,
} from '@/modules/notifications/notification.service';
import { ConsoleTemplateRenderer } from '@/modules/notifications/console-renderer';
import { User, UserDocument, UserSchema } from '@/modules/users/user.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { TenantService } from '@/modules/tenants/tenant.service';
import { AdminController } from '@/modules/tenants/admin.controller';
import { AuthToken, AuthTokenSchema } from './auth-token.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ContextResolver } from './context-resolver';
import { ImpersonationService } from './impersonation.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter';
import { Hs256TokenSigner, TokenSigner } from './token-signer';
import { startMongo, stopMongo } from '../../../test/mongo';

/**
 * Boots the real controllers, guards and filter over a real database, and walks the
 * journey a reviewer would: register, verify, sign in, read /auth/me, create a tenant,
 * and be refused the things this role may not do.
 *
 * This is the test that proves the Swagger surface is actually usable — the service
 * tests do not exercise routing, guards or the error envelope.
 */
describe('auth and admin over HTTP', () => {
  let app: INestApplication;
  let mongoUri: string;

  beforeAll(async () => {
    mongoUri = await startMongo();
    await mongoose.disconnect(); // hand the connection to Nest

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongoUri),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: AuthToken.name, schema: AuthTokenSchema },
          { name: Company.name, schema: CompanySchema },
          { name: Kpm.name, schema: KpmSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Notification.name, schema: NotificationSchema },
          { name: NotificationPreferences.name, schema: NotificationPreferencesSchema },
        ]),
      ],
      controllers: [AuthController, AdminController],
      providers: [
        Reflector,
        { provide: Clock, useClass: SystemClock },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => 'a'.repeat(40), get: () => 'test' },
        },
        {
          provide: TokenSigner,
          inject: [Clock],
          useFactory: (clock: Clock) => new Hs256TokenSigner('a'.repeat(40), clock),
        },
        { provide: TemplateRenderer, useClass: ConsoleTemplateRenderer },
        { provide: NOTIFICATION_ADAPTERS, useValue: [] },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        AuditService, NotificationService, PasswordService, RateLimiter,
        AuthService, ContextResolver, ImpersonationService, TenantService,
        AuthGuard, PermissionsGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalGuards(app.get(AuthGuard), app.get(PermissionsGuard));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  // Each test starts from an empty database. Email and company slug are unique, so
  // without this the suite depends on declaration order and on no earlier test having
  // claimed the same value.
  beforeEach(async () => {
    const connection = app.get<Connection>(getConnectionToken());
    await Promise.all(
      Object.values(connection.collections).map((c) => c.deleteMany({})),
    );
    app.get(RateLimiter).prune();
  });

  const api = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery';

  /** Registers, reads the verification token from the notification, and signs in. */
  async function makeUser(email: string, platformRole: 'super_admin' | 'none' = 'none') {
    await api().post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Test Person' }).expect(201);

    const users = app.get<Model<UserDocument>>(getModelToken(User.name));
    const notifications = app.get<Model<NotificationDocument>>(getModelToken(Notification.name));
    const user = await users.findOne({ email }).exec();

    const note = await notifications
      .findOne({ userId: String(user!._id), templateId: 'auth.email_verification' }).exec();
    const token = (note!.get('payload') as { token: string }).token;

    await api().post('/api/v1/auth/verify-email').send({ token }).expect(200);
    if (platformRole === 'super_admin') {
      await users.updateOne({ _id: user!._id }, { $set: { platformRole } }).exec();
    }

    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[] | undefined;
    const refreshCookie = (cookies ?? []).find((c) => c.startsWith('agencyboost_refresh='));
    return {
      id: String(user!._id),
      accessToken: (login.body as { accessToken: string }).accessToken,
      refreshCookie: refreshCookie ?? '',
    };
  }

  describe('the journey a reviewer walks', () => {
    it('registers, verifies, signs in and reads its own context', async () => {
      const user = await makeUser('journey@kpm.test');

      const me = await api().get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${user.accessToken}`).expect(200);

      expect(me.body.user.email).toBe('journey@kpm.test');
      expect(me.body.user.pronoun).toBe('they');
      expect(me.body.membership).toBeNull(); // the new-agent state
      expect(me.body.permissions).toEqual([]);
    });

    it('refuses /auth/me without a token', async () => {
      const res = await api().get('/api/v1/auth/me').expect(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('lets a Super Admin create a company and a KPM', async () => {
      const sa = await makeUser('sa@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Prudential', slug: 'prudential' }).expect(201);

      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '0417', branchName: 'BSD City Branch' })
        .expect(201);

      expect(kpm.body.code).toBe('0417');
      expect(kpm.body.settings.activationWindowDays).toBe(90);
      expect(kpm.body.timezone).toBe('Asia/Jakarta');
    });

    it('refuses tenant creation to a non-Super-Admin with PERM_DENIED', async () => {
      const plain = await makeUser('plain@kpm.test');
      const res = await api().post('/api/v1/admin/tenants')
        .set('Authorization', `Bearer ${plain.accessToken}`)
        .send({ companyId: 'x', code: '0999', branchName: 'Nope' })
        .expect(403);

      expect(res.body.error.code).toBe('PERM_DENIED');
      expect(res.body.error.details.permission).toBe('kpm:create');
    });

    it('shows an Owner their membership and permissions after assignment', async () => {
      const sa = await makeUser('sa2@agencyboost.test', 'super_admin');
      const owner = await makeUser('owner2@kpm.test');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Allianz', slug: 'allianz' }).expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '0289', branchName: 'BGC' }).expect(201);

      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      // Roles resolve per request, so the existing token already sees the new grant.
      const me = await api().get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${owner.accessToken}`).expect(200);

      expect(me.body.membership.isKpmOwner).toBe(true);
      expect(me.body.permissions).toContain('kpm_admin:grant');
      expect(me.body.permissions).not.toContain('kpm:create');
    });

    it('lands the Owner on their own office with the seeded settings present', async () => {
      // P2-T6 AC-3. The Owner's landing reads its own office through the same route the
      // Super Admin console uses; `readProfile` admits an Owner to their own tenant.
      const sa = await makeUser('sa3@agencyboost.test', 'super_admin');
      const owner = await makeUser('owner3@kpm.test');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Manulife', slug: 'manulife' }).expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '0731', branchName: 'Kuningan' }).expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      const office = await api().get(`/api/v1/admin/tenants/${kpm.body._id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`).expect(200);

      expect(office.body.branchName).toBe('Kuningan');
      expect(office.body.settings.activationWindowDays).toBe(90);
      expect(office.body.timezone).toBe('Asia/Jakarta');
    });

    it("refuses an Owner another office, as a 404 rather than a 403", async () => {
      // A 403 would confirm the other office exists. The console and the Owner's
      // landing share this route, so the distinction is load-bearing for both.
      const sa = await makeUser('sa4@agencyboost.test', 'super_admin');
      const owner = await makeUser('owner4@kpm.test');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'AXA', slug: 'axa' }).expect(201);
      const mine = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '0801', branchName: 'Mine' }).expect(201);
      const theirs = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '0802', branchName: 'Theirs' }).expect(201);
      await api().patch(`/api/v1/admin/tenants/${mine.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      const res = await api().get(`/api/v1/admin/tenants/${theirs.body._id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('refuses to point an office at an account that does not exist', async () => {
      // The console's screen claimed this error before the service produced it: the id
      // was stored on trust, so an office could be left owned by nobody, permanently.
      const sa = await makeUser('sa6@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Generali', slug: 'generali' }).expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '1001', branchName: 'Menteng' }).expect(201);

      const res = await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ email: 'nobody@nowhere.test' }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');

      const after = await api().get(`/api/v1/admin/tenants/${kpm.body._id}`).set(auth).expect(200);
      expect(after.body.ownerUserId).toBeNull();
    });

    it('assigns by the email a Super Admin actually knows', async () => {
      const sa = await makeUser('sa7@agencyboost.test', 'super_admin');
      const owner = await makeUser('owner7@kpm.test');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'BNI Life', slug: 'bni-life' }).expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '1002', branchName: 'Thamrin' }).expect(201);

      // Pasted addresses carry whitespace and case. @IsEmail runs before the service
      // normalises, so the trim has to happen on the DTO or HTTP rejects what the
      // service would have accepted.
      const assigned = await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ email: '  Owner7@KPM.test  ' }).expect(200);
      expect(assigned.body.ownerUserId).toBe(owner.id);
    });

    it('shows a Super Admin the platform audit trail their own work wrote', async () => {
      const sa = await makeUser('sa5@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Sequis', slug: 'sequis' }).expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: '0912', branchName: 'Sudirman' }).expect(201);

      // A Super Admin has no tenant, so their actions carry a null kpmId. Reading the
      // default scope must find them; asking for an office must not.
      const platform = await api().get('/api/v1/admin/audit').set(auth).expect(200);
      expect(platform.body.map((e: { action: string }) => e.action)).toContain('kpm.created');

      const office = await api().get(`/api/v1/admin/audit?kpmId=${kpm.body._id}`)
        .set(auth).expect(200);
      expect(office.body).toEqual([]);
    });
  });

  describe('the contract holds over HTTP', () => {
    it('rejects an unknown body field rather than dropping it', async () => {
      const res = await api().post('/api/v1/auth/login')
        .send({ email: 'a@b.test', password: 'x', kpmId: 'kpm-b' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('always returns 202 from forgot-password, known address or not', async () => {
      await api().post('/api/v1/auth/forgot-password').send({ email: 'nobody@kpm.test' }).expect(202);
    });

    it('never puts the refresh token in the response body', async () => {
      const user = await makeUser('cookie@kpm.test');
      // A body value would have to be stored where JavaScript can read it, which turns
      // any XSS into an account takeover.
      expect(user.refreshCookie).toContain('HttpOnly');
      expect(user.refreshCookie).toContain('SameSite=Lax');
      expect(user.refreshCookie).toContain('Path=/api/v1/auth');

      // The cookie attributes are only half of it: the body must not carry the token
      // either, or a client could read it from there and store it anyway.
      const login = await api().post('/api/v1/auth/login')
        .send({ email: 'cookie@kpm.test', password: PASSWORD }).expect(200);
      expect(login.body).toEqual({ accessToken: expect.any(String), expiresIn: 900 });
      expect(JSON.stringify(login.body)).not.toContain('refresh');
    });

    it('rotates using the cookie and refuses the spent one', async () => {
      const user = await makeUser('rotate@kpm.test');

      const rotated = await api().post('/api/v1/auth/refresh')
        .set('Cookie', user.refreshCookie).expect(200);
      expect(rotated.body.accessToken).toBeDefined();
      expect(rotated.body.refreshToken).toBeUndefined();

      // Replaying the cookie the client already spent trips family revocation.
      await api().post('/api/v1/auth/refresh').set('Cookie', user.refreshCookie).expect(401);
    });

    it('refuses a refresh with no cookie and no body', async () => {
      await api().post('/api/v1/auth/refresh').expect(401);
    });

    it('clears the cookie on logout', async () => {
      const user = await makeUser('logout@kpm.test');
      const res = await api().post('/api/v1/auth/logout')
        .set('Cookie', user.refreshCookie).expect(204);
      const cleared = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cleared).toContain('agencyboost_refresh=;');
    });

    it('carries a requestId on every error', async () => {
      const res = await api().get('/api/v1/auth/me').expect(401);
      expect(res.body.error.requestId).toBeDefined();
    });
  });
});
