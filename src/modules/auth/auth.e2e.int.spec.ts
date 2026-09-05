import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Reflector, APP_FILTER } from '@nestjs/core';
import mongoose, { Model } from 'mongoose';
import request from 'supertest';
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
    return { id: String(user!._id), ...login.body as { accessToken: string; refreshToken: string } };
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

    it('rotates a refresh token and refuses the spent one', async () => {
      const user = await makeUser('rotate@kpm.test');
      const rotated = await api().post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken }).expect(200);
      expect(rotated.body.refreshToken).not.toBe(user.refreshToken);

      await api().post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken }).expect(401);
    });

    it('carries a requestId on every error', async () => {
      const res = await api().get('/api/v1/auth/me').expect(401);
      expect(res.body.error.requestId).toBeDefined();
    });
  });
});
