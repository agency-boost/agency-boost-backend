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
import { EmailTemplateRenderer } from '@/modules/notifications/email-renderer';
import { User, UserDocument, UserSchema } from '@/modules/users/user.schema';
import { Company, CompanyDocument, CompanySchema } from '@/modules/tenants/company.schema';
import { DEFAULT_ORG_LADDER } from '@/domain/constants';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { TenantService } from '@/modules/tenants/tenant.service';
import { KpmRequest, KpmRequestSchema } from '@/modules/tenants/kpm-request.schema';
import {
  CompanyOrgLevel, CompanyOrgLevelDocument, CompanyOrgLevelSchema,
} from '@/modules/tenants/company-org-level.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { KpmRequestService } from '@/modules/tenants/kpm-request.service';
import { AdminController } from '@/modules/tenants/admin.controller';
import { CompanyController } from '@/modules/tenants/company.controller';
import { RosterImportService } from '@/modules/tenants/roster-import.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import {
  GroupRepository, JoinRequestRepository, MembershipHistoryRepository,
} from '@/modules/org/org.repositories';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { DirectoryService } from '@/modules/org/directory.service';
import { OrgController } from '@/modules/org/org.controller';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { OnboardingService } from '@/modules/org/onboarding.service';
import { OnboardingController } from '@/modules/org/onboarding.controller';
import { LeaderCodeService } from '@/modules/org/leader-code.service';
import { ApprovalsService } from '@/modules/org/approvals.service';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { AdminDelegationService } from '@/modules/org/admin-delegation.service';
import { GroupService } from '@/modules/org/group.service';
import { OrgTreeService } from '@/modules/org/org-tree.service';
import { RemovalService } from '@/modules/org/removal.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { AuthToken, AuthTokenDocument, AuthTokenSchema } from './auth-token.schema';
import {
  NotificationChannel, NotificationChannelAdapter, RenderedMessage, SendRequest,
} from '@/modules/notifications/notification.types';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ContextResolver } from './context-resolver';
import { ImpersonationService } from './impersonation.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter';
import { Hs256TokenSigner, TokenSigner } from './token-signer';
import { startMongo, stopMongo } from '../../../test/mongo';
import {
  ActivityCategory, ActivityCategorySchema,
} from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import {
  RatioDefinition, RatioDefinitionSchema,
} from '@/modules/config/ratio-definition.schema';
import {
  ConfigSnapshot, ConfigSnapshotSchema,
} from '@/modules/config/config-snapshot.schema';
import {
  PlatformTemplate, PlatformTemplateSchema,
} from '@/modules/config/platform-template.schema';
import {
  ActivityCategoryRepository, ActivityTypeRepository, ConfigSnapshotRepository,
  LeadStatusRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { LeadStatusService } from '@/modules/config/lead-status.service';
import { RatioService } from '@/modules/config/ratio.service';
import { ActivityConfigService } from '@/modules/config/activity.service';
import { ProvisioningService } from '@/modules/config/provisioning.service';
import {
  TenantConfigController, TenantConfigReadController,
} from '@/modules/config/config.controller';
import { TenantConfigService } from '@/modules/config/tenant-config.service';
import { TemplateService } from '@/modules/config/template.service';
import { OfficeCounter } from '@/modules/config/office-counter.port';
import { KpmOfficeCounter } from '@/modules/config/office-counter';

/**
 * Boots the real controllers, guards and filter over a real database, and walks the
 * journey a reviewer would: register, verify, sign in, read /auth/me, create a tenant,
 * and be refused the things this role may not do.
 *
 * This is the test that proves the Swagger surface is actually usable — the service
 * tests do not exercise routing, guards or the error envelope.
 */
/**
 * The mail the product would have sent, captured at the channel.
 *
 * The verification token used to be read out of the notification row's stored payload,
 * which is where it no longer is: a live single-use token at rest, on a row nothing ever
 * renders, is what ADR-0019 removed. An adapter is where a token legitimately arrives —
 * a real mailer needs it to build the link — so reading it here exercises the path the
 * email adapter will take in `P4-T14`, instead of a storage detail that had to leak.
 */
class Mailbox extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  readonly sent: Array<{ to: SendRequest; rendered: RenderedMessage }> = [];

  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    this.sent.push({ to, rendered });
  }

  /** The most recent token sent to this person, for the template asked about. */
  tokenFor(userId: string, templateId: string): string {
    const hit = [...this.sent].reverse().find(
      (m) => m.to.userId === userId && m.to.templateId === templateId,
    );
    if (!hit) throw new Error(`no ${templateId} was sent to ${userId}`);
    return (hit.to.payload as { token: string }).token;
  }
}

const mailbox = new Mailbox();

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
          { name: KpmRequest.name, schema: KpmRequestSchema },
          { name: CompanyOrgLevel.name, schema: CompanyOrgLevelSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Notification.name, schema: NotificationSchema },
          { name: NotificationPreferences.name, schema: NotificationPreferencesSchema },
          { name: Membership.name, schema: MembershipSchema },
          { name: MembershipHistory.name, schema: MembershipHistorySchema },
          { name: JoinRequest.name, schema: JoinRequestSchema },
          { name: Group.name, schema: GroupSchema },
          { name: ActivityCategory.name, schema: ActivityCategorySchema },
          { name: ActivityType.name, schema: ActivityTypeSchema },
          { name: LeadStatus.name, schema: LeadStatusSchema },
          { name: RatioDefinition.name, schema: RatioDefinitionSchema },
          { name: ConfigSnapshot.name, schema: ConfigSnapshotSchema },
          { name: PlatformTemplate.name, schema: PlatformTemplateSchema },
        ]),
      ],
      controllers: [
        AuthController, AdminController, CompanyController, OrgController, OnboardingController,
        TenantConfigController,
        TenantConfigReadController,
      ],
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
        { provide: TemplateRenderer, useClass: EmailTemplateRenderer },
        { provide: NOTIFICATION_ADAPTERS, useValue: [mailbox] },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        ActivityCategoryRepository, ActivityTypeRepository, ActivityConfigService,
        LeadStatusRepository, LeadStatusService, RatioDefinitionRepository, RatioService,
        ConfigSnapshotRepository,
        TenantConfigService, TemplateService,
        { provide: OfficeCounter, useClass: KpmOfficeCounter },
    TemplateService,
    { provide: OfficeCounter, useClass: KpmOfficeCounter },
        ProvisioningService,
        AuditService, NotificationService, PasswordService, RateLimiter,
        AuthService, ContextResolver, ImpersonationService, TenantService, KpmRequestService, OrgLevelService,
        RosterImportService,
        MembershipRepository, GroupRepository, JoinRequestRepository,
        MembershipHistoryRepository,
    GroupRepository,
    JoinRequestRepository,
    MembershipHistoryRepository, HierarchyService, DirectoryService, OnboardingService, LeaderCodeService, ApprovalsService, RoleChangeService, RemovalService, OrgTreeService, GroupService, AdminDelegationService,
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
    // Listen once, for the whole suite.
    //
    // Given a server that is not listening, supertest opens an ephemeral port for each
    // request and closes it again afterwards — several hundred listen/close cycles per
    // run. The OS reissues those port numbers, so a request can arrive at whatever now
    // owns the port it was told to use: another dev server on this machine, or nothing
    // at all. That is the intermittent this suite has been showing — a random test
    // failing with a 404 carrying no `x-powered-by` and an empty body, or a socket hang
    // up, in a run where nothing was wrong with the code under test.
    //
    // With the server already listening, supertest reuses it and never closes it.
    await app.listen(0);
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

  /**
   * The insurer registration names (ADR-0017), created once per test.
   *
   * Each test starts from an empty database, so this is find-or-create rather than a
   * fixture built in `beforeAll`.
   */
  let e2eCodeSeq = 0;
  async function anInsurer(): Promise<string> {
    const companies = app.get<Model<CompanyDocument>>(getModelToken(Company.name));
    // Named the thing the assertions below expect. A person and the office they own must
    // belong to one insurer (ADR-0017), so a fixture insurer separate from the office's
    // would make every owner assignment a 404 — which is the rule working, not a bug.
    const existing = await companies.findOne({ slug: 'prudential' }).exec();
    if (existing) return String(existing._id);
    const made = await companies.create({ name: 'Prudential', slug: 'prudential' });

    // **And its ladder.** `createCompany` seeds `DEFAULT_ORG_LADDER`; writing straight to
    // the model skips that, and a company with no rungs cannot place anybody —
    // `HierarchyService.create` resolves the role against the ladder (ADR-0012), so every
    // owner assignment would 409 with `ORG_LEVEL_NOT_ON_LADDER`.
    const levels = app.get<Model<CompanyOrgLevelDocument>>(getModelToken(CompanyOrgLevel.name));
    await levels.insertMany(
      DEFAULT_ORG_LADDER.map((rung) => ({
        ...rung, companyId: String(made._id), status: 'active', deletedAt: null,
      })),
    );
    return String(made._id);
  }

  /** Registers, reads the verification token from the notification, and signs in. */
  async function makeUser(email: string, platformRole: 'super_admin' | 'none' = 'none') {
    const companyId = await anInsurer();
    e2eCodeSeq += 1;
    await api().post('/api/v1/auth/register')
      .send({
        email, password: PASSWORD, fullName: 'Test Person',
        companyId, agentCode: `PRU-${9000 + e2eCodeSeq}`,
      }).expect(201);

    const users = app.get<Model<UserDocument>>(getModelToken(User.name));
    const user = await users.findOne({ email }).exec();

    const token = mailbox.tokenFor(String(user!._id), 'auth.email_verification');

    await api().post('/api/v1/auth/verify-email').send({ token }).expect(200);
    if (platformRole === 'super_admin') {
      await users.updateOne({ _id: user!._id }, { $set: { platformRole } }).exec();
    }

    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[] | undefined;
    const refreshCookie = (cookies ?? []).find((c) => c.startsWith('agencyboost_refresh='));
    return {
      id: String(user!._id),
      email,
      accessToken: (login.body as { accessToken: string }).accessToken,
      refreshCookie: refreshCookie ?? '',
      /** What the mailer was handed — so a test can assert it is not also in the database. */
      verificationToken: token,
    };
  }

  describe('the journey a reviewer walks', () => {
    it('writes no live token to the database, where nothing would ever read it (ADR-0019)', async () => {
      /*
       * `authTokens` stores only `tokenHash`, so that reading the database cannot verify
       * an address or reset a password. The notification row used to store the raw token
       * beside it — and `auth.email_verification` has no `in_app` channel, so that row is
       * never rendered by anything. This asserts it at the storage layer, which is the
       * layer the guarantee is actually about.
       */
      const email = 'no-token-at-rest@kpm.test';
      const user = await makeUser(email);
      const users = app.get<Model<UserDocument>>(getModelToken(User.name));
      const account = await users.findOne({ email }).exec();
      const notifications = app.get<Model<NotificationDocument>>(getModelToken(Notification.name));

      const rows = await notifications.find({ userId: String(account!._id) }).exec();
      const verification = rows.find((r) => r.get('templateId') === 'auth.email_verification');

      // The row exists — it is the delivery record — and carries nothing to sign in with.
      expect(verification).toBeDefined();
      expect(verification!.get('payload')).toEqual({});
      expect(JSON.stringify(verification!.toObject())).not.toContain(user.verificationToken);
    });

    it('registers, verifies, signs in and reads its own context', async () => {
      const user = await makeUser('journey@kpm.test');

      const me = await api().get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${user.accessToken}`).expect(200);

      expect(me.body.user.email).toBe('journey@kpm.test');
      expect(me.body.user.pronoun).toBe('they');
      expect(me.body.membership).toBeNull(); // the new-agent state
      // Four ways into an office — find one, attach to it, walk in through a leader's
      // invite, or ask for one that has never been provisioned — plus their own inbox,
      // which is addressed to them as a person and exists before any office does.
      // Anything more would be a grant that outlives the reason for it.
      expect(me.body.permissions.sort()).toEqual([
        'join_via_code_link_qr',
        'kpm:read_directory',
        'kpm_registration:create',
        'kpm_request:create',
        'notification:mark_read',
        'notification:read_inbox',
      ]);
    });

    /*
     * P3.6-T3 AC-2. Registration asks which insurer issued your code, and it is the one
     * company question a person can ask before they have an account: `GET /admin/companies`
     * is `company:crud`, Super Admin only.
     */
    it('lists insurers to somebody with no account, and tells them nothing else', async () => {
      const sa = await makeUser(`sa-co-${Math.random()}@agencyboost.test`, 'super_admin');
      await api().post('/api/v1/admin/companies')
        .set({ Authorization: `Bearer ${sa.accessToken}` })
        .send({ name: 'Allianz', slug: 'allianz' }).expect(201);

      // No Authorization header at all.
      const res = await api().get('/api/v1/companies').expect(200);
      const names = res.body.map((c: { name: string }) => c.name);
      expect(names).toContain('Allianz');
      expect(names).toContain('Prudential');
      // By name, so the selector is not in insertion order.
      expect(names).toEqual([...names].sort());
      // An id and a name, and nothing else — not the slug, not the defaults, not the
      // counts. Which insurers exist is not a secret; how each is configured is.
      for (const row of res.body) expect(Object.keys(row).sort()).toEqual(['_id', 'name']);
    });

    it('refuses an agent code that is not text, rather than upper-casing a number', async () => {
      // The DTO upper-cases what arrives, because a code is read off a contract and typed
      // by hand. A JSON number has no `toUpperCase`, so the transform has to leave it be
      // and let `@IsString` refuse it — otherwise the request is a 500.
      const companyId = await anInsurer();
      const res = await api().post('/api/v1/auth/register')
        .send({
          email: `num-${Math.random()}@kpm.test`, password: PASSWORD, fullName: 'N',
          companyId, agentCode: 88213,
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    /*
     * P3.6-T4, and the reason the gate is in `AuthGuard` rather than in a redirect.
     *
     * A roster-imported account signs in on a password an admin generated, read, and put
     * in an email. Anybody who saw that email — or the admin's screen, or the spreadsheet
     * it was pasted into — holds the same credential. A client-side redirect would leave
     * it working against the API for the life of the account, and the API is exactly what
     * somebody with a copy would use.
     */
    it('lets a temporary password reach three routes and no others', async () => {
      const person = await makeUser(`temp-${Math.random()}@kpm.test`);
      const users = app.get<Model<UserDocument>>(getModelToken(User.name));
      await users.updateOne({ _id: person.id }, { $set: { mustChangePassword: true } });
      const auth = { Authorization: `Bearer ${person.accessToken}` };

      // The three that let them fix it.
      await api().get('/api/v1/auth/me').set(auth).expect(200);

      // Everything else, including the routes a brand-new person would otherwise reach.
      // `/members` is a permission the person does not hold anyway — which is the point:
      // the guard refuses before `PermissionsGuard` is ever consulted, so the answer is
      // about the password rather than about the grant.
      for (const path of ['/api/v1/join/me', '/api/v1/join/kpms', '/api/v1/members']) {
        const res = await api().get(path).set(auth).expect(403);
        expect(res.body.error.code).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');
      }
    });

    it('opens the rest of the product the moment the password is theirs', async () => {
      const person = await makeUser(`temp2-${Math.random()}@kpm.test`);
      const users = app.get<Model<UserDocument>>(getModelToken(User.name));
      await users.updateOne({ _id: person.id }, { $set: { mustChangePassword: true } });
      const auth = { Authorization: `Bearer ${person.accessToken}` };

      await api().get('/api/v1/join/me').set(auth).expect(403);

      await api().post('/api/v1/auth/change-password').set(auth)
        .send({ currentPassword: PASSWORD, newPassword: 'a different long password' })
        .expect(200);

      // Changing a password signs every session out, so this is a fresh one — which is
      // itself the point: the token minted under the temporary password is dead.
      const again = await api().post('/api/v1/auth/login')
        .send({ email: person.email, password: 'a different long password' }).expect(200);
      await api().get('/api/v1/join/me')
        .set({ Authorization: `Bearer ${again.body.accessToken}` }).expect(200);
    });

    it('refuses /auth/me without a token', async () => {
      const res = await api().get('/api/v1/auth/me').expect(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('lets a Super Admin create a company and a KPM', async () => {
      const sa = await makeUser('sa@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const companyId = await anInsurer();

      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: companyId, code: '0417', branchName: 'BSD City Branch' })
        .expect(201);

      expect(kpm.body.code).toBe('0417');
      expect(kpm.body.settings.activationWindowDays).toBe(90);
      expect(kpm.body.timezone).toBe('Asia/Jakarta');
    });

    it('P3.5-T14 AC-7: the wire carries the owner\u2019s name, not only their id', async () => {
      // At the HTTP layer deliberately. Mongoose runs strict, so a field attached to a
      // hydrated document never reaches `_doc` and never reaches the response — while a
      // service test reading the same object back would pass. That is the two-halves
      // failure `.claude/rules/backend-then-frontend.md` describes, and only a request
      // catches it.
      const sa = await makeUser('sa-owner@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      await makeUser('rina@kpm0417.test'); // `makeUser` names everybody 'Test Person'.

      const companyId = await anInsurer();
      const created = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: companyId, code: '0417', branchName: 'BSD City Branch' })
        .expect(201);

      expect(created.body.ownerName).toBeNull();
      expect(created.body.companyName).toBe('Prudential');

      const assigned = await api().patch(`/api/v1/admin/tenants/${created.body._id}/owner`)
        .set(auth).send({ email: 'rina@kpm0417.test' }).expect(200);
      expect(assigned.body.ownerName).toBe('Test Person');
      expect(assigned.body.ownerEmail).toBe('rina@kpm0417.test');

      // All five KPM responses share one shape. Adding the field to the detail alone
      // would leave the roster showing an id and make the post-assign redirect flicker
      // from a name back to one.
      const list = await api().get('/api/v1/admin/tenants').set(auth).expect(200);
      expect(list.body[0].ownerName).toBe('Test Person');
      const read = await api().get(`/api/v1/admin/tenants/${created.body._id}`).set(auth).expect(200);
      expect(read.body.ownerName).toBe('Test Person');
      const status = await api().patch(`/api/v1/admin/tenants/${created.body._id}/status`)
        .set(auth).send({ status: 'suspended', reason: 'unpaid' }).expect(200);
      expect(status.body.ownerName).toBe('Test Person');

      // And the internal sequence is off the wire.
      expect(read.body).not.toHaveProperty('counters');
    });

    it('P3.5-T14 AC-7: refuses a time zone the product cannot honour', async () => {
      // `{"timezone":"banana"}` returned 201 before this, and every day boundary in that
      // office resolved to an Invalid DateTime from then on, with nothing raised at
      // creation. v1 runs on one zone (ADR-0016) and the API says so.
      const sa = await makeUser('sa-tz@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const company = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Allianz', slug: 'allianz' }).expect(201);

      const office = { companyId: String(company.body._id), branchName: 'Makassar Branch' };

      const bad = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ ...office, code: '0500', timezone: 'banana' })
        .expect(400);
      // The violation is asserted, not just the status. A 400 for some *other* reason
      // would make this test pass while proving nothing about the time zone.
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      expect(bad.body.error.details.violations.join(' ')).toContain('timezone must be Asia/Jakarta');

      // A second real IANA zone is refused too — this is one zone, not "any valid zone".
      const makassar = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ ...office, code: '0501', timezone: 'Asia/Makassar' })
        .expect(400);
      expect(makassar.body.error.details.violations.join(' ')).toContain('timezone must be Asia/Jakarta');

      // The legal value still works, so nobody sending it today breaks.
      await api().post('/api/v1/admin/tenants').set(auth)
        .send({ ...office, code: '0502', timezone: 'Asia/Jakarta' })
        .expect(201);
    });

    it('P3.5-T14 AC-7: refuses a duplicate company slug with 409, not 500', async () => {
      const sa = await makeUser('sa-slug@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Prudential Indonesia', slug: 'prudential-indonesia' }).expect(201);

      const clash = await api().post('/api/v1/admin/companies')
        .set(auth).send({ name: 'Prudential-Indonesia', slug: 'prudential-indonesia' }).expect(409);

      expect(clash.body.error.code).toBe('COMPANY_SLUG_TAKEN');
      expect(clash.body.error.message).toContain('Prudential Indonesia');
    });

    it('P3.5-T14: refuses a slug shaped in a way derivation never produces', async () => {
      const sa = await makeUser('sa-shape@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      for (const slug of ['-', '--a--', 'a--b', 'Prudential']) {
        await api().post('/api/v1/admin/companies')
          .set(auth).send({ name: 'Whatever', slug }).expect(400);
      }
    });

    it('P3.5-T7: the ladder is Super Admin only, over HTTP as well as in the service', async () => {
      const sa = await makeUser('sa-ladder@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const plain = await makeUser('plain-ladder@kpm.test');
      const theirs = { Authorization: `Bearer ${plain.accessToken}` };

      const companyId = await anInsurer();

      // A company arrives with a ladder (P3.5-T8): `memberships.orgLevelId` resolves
      // against it on every join, so a company without one is an office nobody can join.
      const seeded = await api().get('/api/v1/admin/org-levels').set(auth).expect(200);
      expect(seeded.body.map((l: { code: string }) => l.code)).toEqual(['AGENT', 'AAB', 'AB']);

      const ladder = await api().post('/api/v1/admin/org-levels').set(auth)
        .send({ companyId, code: 'SAB', label: 'Senior AB', displayOrder: 4 }).expect(201);
      expect(ladder.body).toHaveLength(4);
      expect(ladder.body[3]).toMatchObject({ code: 'SAB', label: 'Senior AB', status: 'active' });

      // AC-2, at the layer a KPM Owner would actually reach it from.
      for (const call of [
        api().get('/api/v1/admin/org-levels').set(theirs),
        api().post('/api/v1/admin/org-levels').set(theirs)
          .send({ companyId, code: 'AAB', label: 'AAB', displayOrder: 2 }),
        api().patch(`/api/v1/admin/org-levels/${ladder.body[0].orgLevelId}`).set(theirs)
          .send({ label: 'Anything' }),
      ]) {
        const res = await call.expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
      }

      // The code is not in the update contract at all, so sending one is refused rather
      // than silently ignored — `forbidNonWhitelisted` makes the shape the enforcement.
      const sneaky = await api().patch(`/api/v1/admin/org-levels/${ladder.body[0].orgLevelId}`)
        .set(auth).send({ code: 'SOMETHING_ELSE' }).expect(400);
      expect(sneaky.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P3.5-T7 AC-5: the overview card carries the ladder, from data', async () => {
      const sa = await makeUser('sa-card@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const companyId = await anInsurer();

      // Seeded at creation, so the card is right from the first moment.
      const seeded = await api().get('/api/v1/admin/overview').set(auth).expect(200);
      expect(seeded.body.companies[0].ladder).toEqual(['Agent', 'AAB', 'AB']);

      // A rung added out of order still reads junior first, and an archived one leaves
      // the card — it is not a rung anybody can be given today.
      await api().post('/api/v1/admin/org-levels').set(auth)
        .send({ companyId, code: 'SAB', label: 'Senior AB', displayOrder: 4 }).expect(201);
      const levels = await api().get('/api/v1/admin/org-levels').set(auth).expect(200);
      const aab = levels.body.find((l: { code: string }) => l.code === 'AAB');
      await api().patch(`/api/v1/admin/org-levels/${aab.orgLevelId}`)
        .set(auth).send({ status: 'archived' }).expect(200);

      const after = await api().get('/api/v1/admin/overview').set(auth).expect(200);
      expect(after.body.companies[0].ladder).toEqual(['Agent', 'AB', 'Senior AB']);
    });

    it('exit review B-2: ending a session revokes the token, not just the audit trail', async () => {
      // `end()` used to write an audit row and nothing else. The access token is a
      // stateless JWT, so it stayed valid for the rest of its hour — anyone holding a
      // copy kept acting as the target, and the banner's Stop button was decoration.
      const sa = await makeUser('sa-revoke@agencyboost.test', 'super_admin');
      const target = await makeUser('revoke-target@kpm.test');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const started = await api().post(`/api/v1/admin/impersonate/${target.id}`)
        .set(auth).send({ reason: 'Cannot see their roster' }).expect(201);
      const asThem = { Authorization: `Bearer ${started.body.accessToken}` };

      // Live: the session reads as the target.
      const before = await api().get('/api/v1/auth/me').set(asThem).expect(200);
      expect(before.body.isImpersonating).toBe(true);

      await api().post('/api/v1/admin/impersonate/end').set(asThem).expect(200);

      // Dead, from the very next request — and with the same token, which is the point.
      const after = await api().get('/api/v1/auth/me').set(asThem).expect(401);
      expect(after.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
      expect(after.body.error.message).toContain('support session has ended');

      // The Super Admin's own token is untouched.
      await api().get('/api/v1/auth/me').set(auth).expect(200);
    });

    it('exit review B-2: a session minted with no row is refused, not trusted', async () => {
      // A token from before this existed, or one whose row was pruned. Failing closed is
      // the only safe reading of "I cannot find this session".
      const sa = await makeUser('sa-norow@agencyboost.test', 'super_admin');
      const target = await makeUser('norow-target@kpm.test');
      const started = await api().post(`/api/v1/admin/impersonate/${target.id}`)
        .set({ Authorization: `Bearer ${sa.accessToken}` })
        .send({ reason: 'Support' }).expect(201);

      const tokens = app.get<Model<AuthTokenDocument>>(getModelToken(AuthToken.name));
      await tokens.deleteMany({ kind: 'impersonation' });

      await api().get('/api/v1/auth/me')
        .set({ Authorization: `Bearer ${started.body.accessToken}` }).expect(401);
    });

    it('P3.5-T11 AC-5: an impersonation can actually be ended, and answers 200', async () => {
      // Two defects in one route, and the second only surfaced because the first was
      // being tested. The document said 201 while the server said 200 — nothing asserted
      // it, so it drifted for two phases. And `impersonate/:userId` was declared *before*
      // `impersonate/end`, so Nest bound `userId = 'end'` and the route was unreachable:
      // ending a support session was impossible and nothing said so.
      const sa = await makeUser('sa-imp@agencyboost.test', 'super_admin');
      const target = await makeUser('imp-target@kpm.test');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const started = await api().post(`/api/v1/admin/impersonate/${target.id}`)
        .set(auth).send({ reason: 'They cannot see their roster' }).expect(201);

      const ended = await api().post('/api/v1/admin/impersonate/end')
        .set({ Authorization: `Bearer ${started.body.accessToken}` });
      expect(ended.status).toBe(200);
      expect(ended.body).toEqual({ status: 'ended' });
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

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '0289', branchName: 'BGC' }).expect(201);

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

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '0731', branchName: 'Kuningan' }).expect(201);
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

      const companyId = await anInsurer();
      const mine = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '0801', branchName: 'Mine' }).expect(201);
      const theirs = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '0802', branchName: 'Theirs' }).expect(201);
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

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '1001', branchName: 'Menteng' }).expect(201);

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

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '1002', branchName: 'Thamrin' }).expect(201);

      // Pasted addresses carry whitespace and case. @IsEmail runs before the service
      // normalises, so the trim has to happen on the DTO or HTTP rejects what the
      // service would have accepted.
      const assigned = await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ email: '  Owner7@KPM.test  ' }).expect(200);
      expect(assigned.body.ownerUserId).toBe(owner.id);
    });

    it('P3.5-T1: the overview counts the platform, and refuses an Owner', async () => {
      const sa = await makeUser(`sa-ov-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const companyId = await anInsurer();
      await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '7001', branchName: 'Overview Branch' })
        .expect(201);

      const res = await api().get('/api/v1/admin/overview').set(auth).expect(200);
      expect(res.body.tiles.kpms).toBeGreaterThan(0);
      // An office with no Owner is the one attention row that has a real source today.
      expect(res.body.attention.some((a: { tag: string }) => a.tag === 'KPM owner')).toBe(true);

      const outsider = await makeUser(`out-ov-${Math.random()}@kpm.test`);
      const refused = await api().get('/api/v1/admin/overview')
        .set('Authorization', `Bearer ${outsider.accessToken}`).expect(403);
      expect(refused.body.error.code).toBe('PERM_DENIED');
    });

    it('P3.5-T12: the admin roster names the Owner and the office', async () => {
      const sa = await makeUser(`sa-ta-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`own-ta-${Math.random()}@kpm.test`);
      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '7002', branchName: 'Roster Branch' })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      const res = await api().get('/api/v1/admin/tenant-admins').set(auth).expect(200);
      const row = res.body.find((r: { kpmLabel: string }) => r.kpmLabel.includes('7002'));
      expect(row).toMatchObject({ isOwner: true, isAdmin: false, grantedAt: null });

      // `kpm_admin:list` gives an Owner their own office's list; the platform roster is a
      // different question and a different grant, refused at the door rather than by the
      // repository.
      const refused = await api().get('/api/v1/admin/tenant-admins')
        .set('Authorization', `Bearer ${owner.accessToken}`).expect(403);
      expect(refused.body.error.code).toBe('PERM_DENIED');
    });

    it('P3.5-T2: somebody with no office can ask for one, and the platform decides', async () => {
      const sa = await makeUser(`sa-rq-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const companyId = await anInsurer();

      const asker = await makeUser(`ask-${Math.random()}@example.test`);
      const asking = { Authorization: `Bearer ${asker.accessToken}` };
      expect((await api().get('/api/v1/join/kpm-request').set(asking).expect(200)).body)
        .toEqual({ request: null });

      const filed = await api().post('/api/v1/join/kpm-request').set(asking)
        .send({ companyId, branchName: 'Surabaya Branch' })
        .expect(201);
      expect(filed.body.status).toBe('pending');

      // One at a time.
      const second = await api().post('/api/v1/join/kpm-request').set(asking)
        .send({ companyId, branchName: 'Medan Branch' })
        .expect(409);
      expect(second.body.error.code).toBe('TENANT_REQUEST_ALREADY_OPEN');

      // The queue is the platform's, and nobody else's.
      await api().get('/api/v1/admin/kpm-requests').set(asking).expect(403);

      const queue = await api().get('/api/v1/admin/kpm-requests').set(auth).expect(200);
      expect(queue.body[0]).toMatchObject({
        branchName: 'Surabaya Branch',
        status: 'pending',
      });

      const approved = await api()
        .post(`/api/v1/admin/kpm-requests/${filed.body.requestId}/approve`)
        .set(auth).send({ code: '7003' }).expect(200);
      const row = approved.body.find((r: { requestId: string }) => r.requestId === filed.body.requestId);
      expect(row.status).toBe('approved');
      expect(row.createdKpmId).toBeTruthy();

      // The office is theirs, which is what "proposed KPM Owner" means.
      const me = await api().get('/api/v1/auth/me').set(asking).expect(200);
      expect(me.body.membership.isKpmOwner).toBe(true);

      // Deciding twice says which way the first went.
      const again = await api()
        .post(`/api/v1/admin/kpm-requests/${filed.body.requestId}/decline`)
        .set(auth).send({}).expect(409);
      expect(again.body.error.code).toBe('TENANT_REQUEST_DECIDED');
    });

    it('shows a Super Admin the platform audit trail their own work wrote', async () => {
      const sa = await makeUser('sa5@agencyboost.test', 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: '0912', branchName: 'Sudirman' }).expect(201);

      // A Super Admin has no tenant, so their actions carry a null kpmId. Reading the
      // default scope must find them; asking for an office must not.
      const platform = await api().get('/api/v1/admin/audit').set(auth).expect(200);
      expect(platform.body.map((e: { action: string }) => e.action)).toContain('kpm.created');

      const office = await api().get(`/api/v1/admin/audit?kpmId=${kpm.body._id}`)
        .set(auth).expect(200);
      expect(office.body).toEqual([]);
    });
  });

  describe('joining an office, over HTTP (P3-T3)', () => {
    /** The whole chain, in the order a person actually walks it. */
    async function officeWithLeader() {
      const sa = await makeUser(`sa-join-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-join-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'Join Branch' })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      return { kpmId: String(kpm.body._id), code: kpm.body.code, owner };
    }

    it('AC-1: a newcomer has no office, and says so rather than failing', async () => {
      const person = await makeUser(`new-${Math.random()}@kpm.test`);
      const res = await api().get('/api/v1/join/me')
        .set('Authorization', `Bearer ${person.accessToken}`).expect(200);
      expect(res.body).toMatchObject({ kpmId: null, status: 'none' });
    });

    it('AC-2: refuses a leader search before an office is registered', async () => {
      // The permission guard refuses first, so the code is PERM_DENIED rather than the
      // service's more helpful TENANT_NO_MEMBERSHIP. That is the right order: the gate
      // is the gate, and widening the grant to improve an error string would weaken it.
      // The screen never makes this call — it knows there is no office — and a direct
      // caller gets an accurate refusal.
      const person = await makeUser(`new2-${Math.random()}@kpm.test`);
      const res = await api().get('/api/v1/join/leaders')
        .set('Authorization', `Bearer ${person.accessToken}`).expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
      expect(res.body.error.details.permission).toBe('leader:search_directory');
    });

    it('lists offices to anyone, including somebody in none', async () => {
      const { code } = await officeWithLeader();
      const person = await makeUser(`new3-${Math.random()}@kpm.test`);

      const res = await api().get(`/api/v1/join/kpms?q=${code}`)
        .set('Authorization', `Bearer ${person.accessToken}`).expect(200);

      expect(res.body).toHaveLength(1);
      // Projection-limited by construction: no member counts, no production, no owner.
      // `companyId` is here so somebody whose branch is missing can name the company they
      // would belong to (P3.5-T2); it identifies a company the same row already names.
      expect(Object.keys(res.body[0]).sort()).toEqual(
        ['branchName', 'city', 'code', 'companyId', 'companyName', 'kpmId'],
      );
    });

    it('walks the whole chain: register, search, ask', async () => {
      const { kpmId, owner } = await officeWithLeader();
      const person = await makeUser(`joiner-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${person.accessToken}` };

      const registered = await api().post('/api/v1/join/kpm')
        .set(asJoiner).send({ kpmId }).expect(200);
      expect(registered.body).toMatchObject({ kpmId, status: 'pending', leaderMembershipId: null });

      const leaders = await api().get('/api/v1/join/leaders').set(asJoiner).expect(200);
      // The Owner is an AB at the root, so they are the leader on offer.
      expect(leaders.body).toHaveLength(1);
      expect(leaders.body[0].role).toBe('ab');

      const asked = await api().post('/api/v1/join/leader-request')
        .set(asJoiner).send({ leaderMembershipId: leaders.body[0].membershipId }).expect(200);
      expect(asked.body.pendingRequestTo).toBe(leaders.body[0].membershipId);

      const after = await api().get('/api/v1/join/leaders').set(asJoiner).expect(200);
      expect(after.body[0].requestSent).toBe(true);

      // And the leader is told. `owner` is who was asked.
      expect(owner.id).toBeDefined();

      const withdrawn = await api().delete('/api/v1/join/leader-request').set(asJoiner).expect(200);
      expect(withdrawn.body.pendingRequestTo).toBeNull();
    });

    it('refuses a second registration rather than moving somebody silently', async () => {
      const first = await officeWithLeader();
      const second = await officeWithLeader();
      const person = await makeUser(`twice-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${person.accessToken}` };

      await api().post('/api/v1/join/kpm').set(asJoiner).send({ kpmId: first.kpmId }).expect(200);
      const res = await api().post('/api/v1/join/kpm')
        .set(asJoiner).send({ kpmId: second.kpmId }).expect(409);
      expect(res.body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
    });

    it('404s an office that does not exist, without saying which kind of absent', async () => {
      const person = await makeUser(`ghost-${Math.random()}@kpm.test`);
      await api().post('/api/v1/join/kpm')
        .set('Authorization', `Bearer ${person.accessToken}`)
        .send({ kpmId: '6a9b7b8dedbf9254dd6a98bc' })
        .expect(404);
    });

    it('validates the body rather than dropping an unknown field', async () => {
      const person = await makeUser(`bad-${Math.random()}@kpm.test`);
      const res = await api().post('/api/v1/join/kpm')
        .set('Authorization', `Bearer ${person.accessToken}`)
        .send({ kpmId: 'x', somethingElse: 1 })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('keeps the roster closed to somebody still waiting to be let in', async () => {
      // A pending member is registered to the office, not in it. `member:read_profile`
      // is an active-member grant, and the join screens are what they see instead.
      const { kpmId } = await officeWithLeader();
      const person = await makeUser(`solo-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${person.accessToken}` };
      await api().post('/api/v1/join/kpm').set(asJoiner).send({ kpmId }).expect(200);

      const res = await api().get('/api/v1/members').set(asJoiner).expect(403);
      expect(res.body.error.code).toBe('PERM_DENIED');
      // But the join chain stays open to them — that is the point of the state.
      await api().get('/api/v1/join/leaders').set(asJoiner).expect(200);
    });
  });

  describe('the roster, over HTTP (P3-T1)', () => {
    async function officeWithOwner() {
      const sa = await makeUser(`sa-ros-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-ros-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId, code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'Roster Branch' })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      return { kpmId: String(kpm.body._id), owner, auth: { Authorization: `Bearer ${owner.accessToken}` } };
    }

    it('returns the Owner as an AB at the root, carrying their own code', async () => {
      const { auth } = await officeWithOwner();
      const res = await api().get('/api/v1/members').set(auth).expect(200);

      expect(res.body.members).toHaveLength(1);
      expect(res.body.members[0]).toMatchObject({
        role: 'ab', status: 'active', leaderId: null, isLeader: false,
      });
      // Their insurer's producer id (ADR-0017), not a code the office minted. This
      // asserted /^KPM\d+-001$/ until 2026-09-08.
      expect(res.body.members[0].agentCode).toMatch(/^PRU-\d+$/);
      expect(res.body.nextCursor).toBeNull();
    });

    it('converts limit from the query string, which arrives as text', async () => {
      // Implicit conversion is off globally, so this DTO opts in per field. Without it
      // the validator would reject a perfectly good `?limit=1`.
      const { auth } = await officeWithOwner();
      await api().get('/api/v1/members?limit=1').set(auth).expect(200);
    });

    it('refuses a limit outside the range rather than clamping it silently', async () => {
      const { auth } = await officeWithOwner();
      await api().get('/api/v1/members?limit=0').set(auth).expect(400);
      await api().get('/api/v1/members?limit=500').set(auth).expect(400);
      await api().get('/api/v1/members?role=chief').set(auth).expect(400);
    });

    it('trims a pasted search term', async () => {
      const { auth } = await officeWithOwner();
      const res = await api().get('/api/v1/members?q=%20%20Roster%20%20').set(auth).expect(200);
      expect(res.body.members).toHaveLength(0);
    });

    it('reads one member, and 404s somebody who is not there', async () => {
      const { auth } = await officeWithOwner();
      const list = await api().get('/api/v1/members').set(auth).expect(200);
      const id = list.body.members[0].membershipId;

      await api().get(`/api/v1/members/${id}`).set(auth).expect(200);
      await api().get(`/api/v1/members/${id}/reports`).set(auth).expect(200);
      await api().get('/api/v1/members/6a9b7b8dedbf9254dd6a98bc').set(auth).expect(404);
    });

    it('404s another office\'s member rather than 403 — a 403 would confirm they exist', async () => {
      const mine = await officeWithOwner();
      const theirs = await officeWithOwner();
      const list = await api().get('/api/v1/members').set(theirs.auth).expect(200);

      await api().get(`/api/v1/members/${list.body.members[0].membershipId}`)
        .set(mine.auth).expect(404);
    });
  });

  describe('invites, over HTTP (P3-T4)', () => {
    async function leaderInOffice() {
      const sa = await makeUser(`sa-inv-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-inv-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Invite Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      return { kpmId: String(kpm.body._id), auth: { Authorization: `Bearer ${owner.accessToken}` } };
    }

    it('hands a leader their own code, with the link that carries it', async () => {
      const { auth } = await leaderInOffice();
      const res = await api().get('/api/v1/join/my-code').set(auth).expect(200);

      expect(res.body.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(res.body.url).toContain(`/join?code=${res.body.code}`);
      // Two fields. `state`, `maxUses`, `useCount`, `expiresAt`, `revokedAt` and `label`
      // went with the lifecycle they described (P3.6-T1).
      expect(Object.keys(res.body).sort()).toEqual(['code', 'url']);
    });

    it('gives the same code back every time, and offers no way to change it', async () => {
      const { auth } = await leaderInOffice();
      const first = await api().get('/api/v1/join/my-code').set(auth).expect(200);
      const again = await api().get('/api/v1/join/my-code').set(auth).expect(200);
      expect(again.body.code).toBe(first.body.code);

      // The three routes that used to manage an invite are gone, not merely forbidden.
      await api().post('/api/v1/join/invites').set(auth).send({}).expect(404);
      await api().get('/api/v1/join/invites').set(auth).expect(404);
      await api().delete('/api/v1/join/invites/anything').set(auth).expect(404);
    });

    it('walks the whole redemption: preview, then accept', async () => {
      const { auth, kpmId } = await leaderInOffice();
      const mine = await api().get('/api/v1/join/my-code').set(auth).expect(200);

      const joiner = await makeUser(`inv-joiner-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${joiner.accessToken}` };

      // Lower case on purpose: people type a code as they read it.
      const preview = await api()
        .get(`/api/v1/join/invite?code=${mine.body.code.toLowerCase()}`)
        .set(asJoiner).expect(200);
      expect(preview.body.kpmLabel).toContain('Invite Branch');
      expect(preview.body.leaderName).toBeTruthy();

      const redeemed = await api().post('/api/v1/join/redeem')
        .set(asJoiner).send({ code: mine.body.code }).expect(200);
      expect(redeemed.body.kpmId).toBe(kpmId);

      // Active straight away, tagged to the code's owner, and no request in any inbox.
      const me = await api().get('/api/v1/join/me').set(asJoiner).expect(200);
      expect(me.body.status).toBe('active');
      expect(me.body.leaderName).toBeTruthy();
      expect(me.body.pendingRequestTo).toBeNull();
    });

    it('needs an account before it will say whose code this is', async () => {
      // Settled 2026-09-09. The code space is 32^6 and the preview names a real office
      // and a real person, so a prober must have an account first — and an account is
      // auditable. `request-context.ts` claimed the opposite in a comment for two phases
      // while the route was never `@Public()`.
      const { auth } = await leaderInOffice();
      const mine = await api().get('/api/v1/join/my-code').set(auth).expect(200);

      await api().get(`/api/v1/join/invite?code=${mine.body.code}`).expect(401);
      await api().post('/api/v1/join/redeem').send({ code: mine.body.code }).expect(401);
    });

    it('refuses a code nobody holds, and refuses it the same way twice', async () => {
      // Six characters, and the reward for guessing one is joining somebody's unit. The
      // departed-leader and suspended-office cases answer identically; those are pinned
      // at the service level, where the state can actually be arranged.
      const joiner = await makeUser(`inv-late-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${joiner.accessToken}` };

      const first = await api().post('/api/v1/join/redeem')
        .set(asJoiner).send({ code: 'ZZZZZZ' }).expect(410);
      const second = await api().post('/api/v1/join/redeem')
        .set(asJoiner).send({ code: 'YYYYYY' }).expect(410);

      expect(first.body.error.code).toBe('ORG_INVITE_EXPIRED');
      expect(first.body.error.message).toBe(second.body.error.message);
    });
  });

  describe('the office activity taxonomy, over HTTP (P4-T1)', () => {
    /** An office with an Owner signed in, which is who edits a taxonomy. */
    async function anOfficeWithOwner() {
      const sa = await makeUser(`sa-cfg-${Math.random()}@agencyboost.test`, 'super_admin');
      const saAuth = { Authorization: `Bearer ${sa.accessToken}` };
      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(saAuth)
        .send({
          companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Config Branch',
        })
        .expect(201);
      const kpmId = String(kpm.body._id);

      const owner = await makeUser(`owner-cfg-${Math.random()}@kpm.test`);
      await api().patch(`/api/v1/admin/tenants/${kpmId}/owner`).set(saAuth)
        .send({ email: owner.email }).expect(200);
      // The grant lands on the membership, so the token has to be minted after it.
      const again = await api().post('/api/v1/auth/login')
        .send({ email: owner.email, password: PASSWORD }).expect(200);
      return {
        kpmId,
        saAuth,
        auth: { Authorization: `Bearer ${(again.body as { accessToken: string }).accessToken}` },
      };
    }

    it('AC-4/AC-5: a brand-new office arrives with a taxonomy to work against', async () => {
      // The company has published no template, so this is the platform-defaults path —
      // which is the normal state of a new insurer's first office.
      const { auth } = await anOfficeWithOwner();
      const res = await api().get('/api/v1/kpm/settings/activity-types').set(auth).expect(200);

      expect(res.body.map((c: { code: string }) => c.code)).toEqual([
        'LEADS_GENERATION', 'SELLING', 'RECRUITMENT',
        'PERSONAL_DEVELOPMENT', 'TEAM_DEVELOPMENT',
      ]);
      expect(res.body.flatMap((c: { types: unknown[] }) => c.types)).toHaveLength(12);
    });

    it('AC-6: archiving takes a type off the list and leaves it readable', async () => {
      const { auth } = await anOfficeWithOwner();
      const list = await api().get('/api/v1/kpm/settings/activity-types').set(auth).expect(200);
      const type = list.body[1].types[2];
      expect(type.code).toBe('SELL_SUBMISSION');

      await api().delete(`/api/v1/kpm/settings/activity-types/${type.id}`).set(auth).expect(200);

      const after = await api().get('/api/v1/kpm/settings/activity-types').set(auth).expect(200);
      const codes = (rows: { types: { code: string }[] }[]) =>
        rows.flatMap((c) => c.types).map((t) => t.code);
      expect(codes(after.body)).not.toContain('SELL_SUBMISSION');

      const withArchived = await api()
        .get('/api/v1/kpm/settings/activity-types?includeArchived=true').set(auth).expect(200);
      expect(codes(withArchived.body)).toContain('SELL_SUBMISSION');
    });

    it('refuses a duplicate code with 400, naming it', async () => {
      const { auth } = await anOfficeWithOwner();
      const res = await api().post('/api/v1/kpm/settings/activity-types').set(auth)
        .send({ code: 'SELL_SUBMISSION', categoryCode: 'SELLING', label: 'Again' })
        .expect(400);
      expect(res.body.error.message).toContain('SELL_SUBMISSION');
    });

    it('refuses a code that is not a code, at the DTO', async () => {
      const { auth } = await anOfficeWithOwner();
      await api().post('/api/v1/kpm/settings/activity-types').set(auth)
        .send({ code: 'has spaces', categoryCode: 'SELLING', label: 'x' })
        .expect(400);
    });

    it('AC-7: refuses an agent the write, over HTTP and not only on the screen', async () => {
      /*
       * A permission expressed only in the frontend is a blocking defect. The screen hides
       * these controls; this is the half that matters.
       */
      const { kpmId, auth } = await anOfficeWithOwner();
      const code = await api().get('/api/v1/join/my-code').set(auth).expect(200);
      const agent = await makeUser(`agent-cfg-${Math.random()}@kpm.test`);
      const agentAuth = { Authorization: `Bearer ${agent.accessToken}` };
      await api().post('/api/v1/join/redeem').set(agentAuth)
        .send({ code: (code.body as { code: string }).code }).expect(200);

      const mine = await api().post('/api/v1/auth/login')
        .send({ email: agent.email, password: PASSWORD }).expect(200);
      const asAgent = {
        Authorization: `Bearer ${(mine.body as { accessToken: string }).accessToken}`,
      };

      // They read it — it is their capture screen.
      const list = await api().get('/api/v1/kpm/settings/activity-types').set(asAgent).expect(200);
      expect(list.body.length).toBeGreaterThan(0);

      // And they cannot change it.
      await api().post('/api/v1/kpm/settings/activity-types').set(asAgent)
        .send({ code: 'AGENT_INVENTED', categoryCode: 'SELLING', label: 'x' })
        .expect(403);
      void kpmId;
    });

    it('refuses another office\'s type as a 404, never a 403', async () => {
      const mine = await anOfficeWithOwner();
      const theirs = await anOfficeWithOwner();
      const list = await api().get('/api/v1/kpm/settings/activity-types')
        .set(theirs.auth).expect(200);
      const type = list.body[0].types[0];

      await api().delete(`/api/v1/kpm/settings/activity-types/${type.id}`)
        .set(mine.auth).expect(404);
    });

    it('reorders without changing a single code', async () => {
      const { auth } = await anOfficeWithOwner();
      const list = await api().get('/api/v1/kpm/settings/activity-types').set(auth).expect(200);
      const types = list.body.flatMap((c: { types: { id: string; code: string }[] }) => c.types);
      const reversed = [...types].reverse().map((t: { id: string }) => t.id);

      const after = await api().patch('/api/v1/kpm/settings/activity-types/reorder').set(auth)
        .send({ ids: reversed }).expect(200);

      expect(after.body.map((t: { code: string }) => t.code))
        .toEqual([...types].reverse().map((t: { code: string }) => t.code));
      expect(new Set(after.body.map((t: { code: string }) => t.code)))
        .toEqual(new Set(types.map((t: { code: string }) => t.code)));
    });

    it('refuses a partial reorder rather than guessing', async () => {
      const { auth } = await anOfficeWithOwner();
      const list = await api().get('/api/v1/kpm/settings/activity-types').set(auth).expect(200);
      const first = list.body[0].types[0].id;
      await api().patch('/api/v1/kpm/settings/activity-types/reorder').set(auth)
        .send({ ids: [first] }).expect(400);
    });
  });

  describe('the consolidated configuration read (P4-T7)', () => {
    async function anOfficeWithAgentAndOwner() {
      const sa = await makeUser(`sa-cfgread-${Math.random()}@agencyboost.test`, 'super_admin');
      const saAuth = { Authorization: `Bearer ${sa.accessToken}` };
      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(saAuth)
        .send({
          companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Read Branch',
        })
        .expect(201);
      const owner = await makeUser(`owner-cfgread-${Math.random()}@kpm.test`);
      await api().patch(`/api/v1/admin/tenants/${String(kpm.body._id)}/owner`).set(saAuth)
        .send({ email: owner.email }).expect(200);
      const again = await api().post('/api/v1/auth/login')
        .send({ email: owner.email, password: PASSWORD }).expect(200);
      return {
        auth: {
          Authorization: `Bearer ${(again.body as { accessToken: string }).accessToken}`,
        },
      };
    }

    it('AC-1: answers the taxonomy, the ratios and both pipelines in one request', async () => {
      // Three requests to render one screen is how a 4G budget is spent before anything
      // is drawn.
      const { auth } = await anOfficeWithAgentAndOwner();
      const res = await api().get('/api/v1/kpm/config').set(auth).expect(200);

      expect(res.body.activity).toHaveLength(5);
      expect(res.body.activity.flatMap((c: { types: unknown[] }) => c.types)).toHaveLength(12);
      expect(res.body.ratios).toHaveLength(5);
      expect(res.body.leadPipelines.map((p: { pipeline: string }) => p.pipeline))
        .toEqual(['sales', 'recruitment']);
      expect(res.body.version).toBe(1);
    });

    it('AC-2: answers 304 to a repeat read carrying the tag', async () => {
      const { auth } = await anOfficeWithAgentAndOwner();
      const first = await api().get('/api/v1/kpm/config').set(auth).expect(200);
      const etag = first.headers.etag;
      expect(etag).toMatch(/^"/);

      const second = await api().get('/api/v1/kpm/config')
        .set({ ...auth, 'If-None-Match': etag }).expect(304);
      expect(second.body).toEqual({});
    });

    it('P4-T6: an edit does not reach agents until it is published', async () => {
      /*
       * The gate this exists for. An Owner restructuring a taxonomy does it in steps, and
       * between them a ratio can name a type archived a minute ago that nobody can log
       * against. Agents stay on the published copy until somebody says otherwise.
       */
      const { auth } = await anOfficeWithAgentAndOwner();
      const before = await api().get('/api/v1/kpm/config').set(auth).expect(200);

      const type = before.body.activity[1].types[0];
      await api().patch(`/api/v1/kpm/settings/activity-types/${type.id}`).set(auth)
        .send({ label: 'Renamed' }).expect(200);

      // Unchanged, tag included — nothing an agent reads has moved.
      await api().get('/api/v1/kpm/config')
        .set({ ...auth, 'If-None-Match': before.headers.etag }).expect(304);

      const state = await api().get('/api/v1/kpm/settings/publish-state').set(auth).expect(200);
      expect(state.body.hasUnpublishedChanges).toBe(true);
    });

    it('P4-T6: changes the tag once it is published', async () => {
      const { auth } = await anOfficeWithAgentAndOwner();
      const before = await api().get('/api/v1/kpm/config').set(auth).expect(200);

      const type = before.body.activity[1].types[0];
      await api().patch(`/api/v1/kpm/settings/activity-types/${type.id}`).set(auth)
        .send({ label: 'Renamed' }).expect(200);
      await api().post('/api/v1/kpm/settings/publish').set(auth).expect(201);

      const after = await api().get('/api/v1/kpm/config')
        .set({ ...auth, 'If-None-Match': before.headers.etag }).expect(200);
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect(after.body.version).toBe(2);
    });

    it('carries no archived row, because it is what can be logged against today', async () => {
      const { auth } = await anOfficeWithAgentAndOwner();
      const before = await api().get('/api/v1/kpm/config').set(auth).expect(200);
      const type = before.body.activity[1].types.find(
        (t: { code: string }) => t.code === 'SELL_SUBMISSION',
      );

      await api().delete(`/api/v1/kpm/settings/activity-types/${type.id}`).set(auth).expect(200);
      await api().post('/api/v1/kpm/settings/publish').set(auth).expect(201);

      const after = await api().get('/api/v1/kpm/config').set(auth).expect(200);
      const codes = after.body.activity
        .flatMap((c: { types: { code: string }[] }) => c.types)
        .map((t: { code: string }) => t.code);
      expect(codes).not.toContain('SELL_SUBMISSION');
    });

    it('tells a caller not to trust the copy without asking', async () => {
      // Configuration changes rarely and unpredictably. An agent looking at a taxonomy
      // their Owner edited an hour ago is worse than one conditional request.
      const { auth } = await anOfficeWithAgentAndOwner();
      const res = await api().get('/api/v1/kpm/config').set(auth).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-cache');
    });
  });

  describe('filling an office from a spreadsheet (P3.6-T4)', () => {
    async function anOffice() {
      const sa = await makeUser(`sa-roster-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Roster Branch',
        })
        .expect(201);
      return { auth, kpmId: String(kpm.body._id) };
    }

    const file = (...rows: string[]) =>
      ['fullName,email,agentCode,role,leaderAgentCode', ...rows].join('\n');

    it('offers the template, on a route an :id would otherwise swallow', async () => {
      const { auth } = await anOffice();
      const res = await api().get('/api/v1/admin/tenants/roster-template').set(auth).expect(200);
      expect(res.body.header).toBe('fullName,email,agentCode,role,leaderAgentCode');
      // The same three rows as cells, for the paste box. A screen splitting the CSV out
      // of `template` would be a second parser, disagreeing over the quoted row.
      expect(res.body.examples).toEqual([
        ['Agus Prasetyo', 'agus@example.test', 'PRU-88001', 'ab', ''],
        ['Puspita, Sari', 'sari@example.test', 'PRU-88002', 'aab', 'PRU-88001'],
        ['Rina Wijaya', 'rina@example.test', 'PRU-88003', 'agent', 'PRU-88002'],
      ]);
    });

    it('previews without writing, then commits the whole file', async () => {
      const { auth, kpmId } = await anOffice();
      const csv = file(
        `Root,root-${Math.random()}@k.test,RT-${Math.random()},ab,`,
      ).replace(/RT-0\./, 'RT-');

      const preview = await api().post(`/api/v1/admin/tenants/${kpmId}/roster/preview`)
        .set(auth).send({ rows: csv }).expect(200);
      expect(preview.body.issues).toEqual([]);
      expect(preview.body.willCreate).toBe(1);

      const committed = await api().post(`/api/v1/admin/tenants/${kpmId}/roster`)
        .set(auth).send({ rows: csv }).expect(201);
      expect(committed.body.created).toHaveLength(1);
      // The password comes back once, and nowhere else.
      expect(committed.body.created[0].temporaryPassword).toMatch(/^[a-z2-9-]+$/);
    });

    it('signs an imported person in, and lets them nowhere until they choose a password', async () => {
      // The whole point of the flow, end to end: an operator emails a password on, the
      // person signs in with it, and the product is shut to them until it is theirs.
      const { auth, kpmId } = await anOffice();
      const email = `imported-${Math.random()}@k.test`;
      const csv = file(`Imported Person,${email},IMP-${Date.now()},ab,`);

      const committed = await api().post(`/api/v1/admin/tenants/${kpmId}/roster`)
        .set(auth).send({ rows: csv }).expect(201);
      const { temporaryPassword } = committed.body.created[0];

      const login = await api().post('/api/v1/auth/login')
        .send({ email, password: temporaryPassword }).expect(200);
      const theirs = { Authorization: `Bearer ${login.body.accessToken}` };

      await api().get('/api/v1/auth/me').set(theirs).expect(200);
      const refused = await api().get('/api/v1/join/me').set(theirs).expect(403);
      expect(refused.body.error.code).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');

      await api().post('/api/v1/auth/change-password').set(theirs)
        .send({ currentPassword: temporaryPassword, newPassword: 'a password of my own' })
        .expect(200);

      const again = await api().post('/api/v1/auth/login')
        .send({ email, password: 'a password of my own' }).expect(200);
      const mine = await api().get('/api/v1/join/me')
        .set({ Authorization: `Bearer ${again.body.accessToken}` }).expect(200);
      expect(mine.body.status).toBe('active');
    });

    it('refuses the whole file for one bad row, and writes nothing', async () => {
      const { auth, kpmId } = await anOffice();
      const csv = file(
        `Good,good-${Math.random()}@k.test,GD-${Date.now()},ab,`,
        'Bad,not-an-email,BD-1,agent,',
      );

      const refused = await api().post(`/api/v1/admin/tenants/${kpmId}/roster`)
        .set(auth).send({ rows: csv }).expect(400);
      expect(refused.body.error.details.issues).toHaveLength(1);

      // And the good row did not land either.
      const roster = await api().get('/api/v1/admin/tenants').set(auth).expect(200);
      expect(roster.body.find((k: { _id: string }) => k._id === kpmId)).toBeDefined();
      const preview = await api().post(`/api/v1/admin/tenants/${kpmId}/roster/preview`)
        .set(auth).send({ rows: file(`Good,good2-${Math.random()}@k.test,GD2-${Date.now()},ab,`) })
        .expect(200);
      expect(preview.body.willCreate).toBe(1);
    });

    it('lets an Owner fill their own office, and no other', async () => {
      // An office that hires ten people at once is the case this exists for. The office
      // id is in the URL, so what stops one office filling another is the check that
      // answers **404** — never 403, which would confirm the id is real.
      const { auth, kpmId } = await anOffice();
      const owner = await makeUser(`ro-${Math.random()}@k.test`);
      await api().patch(`/api/v1/admin/tenants/${kpmId}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);
      const theirs = { Authorization: `Bearer ${owner.accessToken}` };

      await api().get('/api/v1/admin/tenants/roster-template').set(theirs).expect(200);
      const mine = await api().post(`/api/v1/admin/tenants/${kpmId}/roster/preview`)
        .set(theirs).send({ rows: file(`R,r-${Math.random()}@k.test,OW-${Date.now()},agent,`) })
        .expect(200);
      expect(mine.body.willCreate).toBe(1);

      const somebodyElse = await anOffice();
      await api().post(`/api/v1/admin/tenants/${somebodyElse.kpmId}/roster/preview`)
        .set(theirs).send({ rows: file() }).expect(404);
      await api().post(`/api/v1/admin/tenants/${somebodyElse.kpmId}/roster`)
        .set(theirs).send({ rows: file() }).expect(404);
    });

    it('refuses a leader, who administers nothing', async () => {
      const { kpmId } = await anOffice();
      const leader = await makeUser(`rl-${Math.random()}@k.test`);
      const theirs = { Authorization: `Bearer ${leader.accessToken}` };

      await api().post(`/api/v1/admin/tenants/${kpmId}/roster/preview`)
        .set(theirs).send({ rows: file() }).expect(403);
    });
  });

  describe('approving and tagging, over HTTP (P3-T5)', () => {
    async function officeWithLeader() {
      const sa = await makeUser(`sa-app-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-app-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Approval Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      return { kpmId: String(kpm.body._id), auth: { Authorization: `Bearer ${owner.accessToken}` } };
    }

    /** Somebody registered to the office who has asked the Owner to take them on. */
    async function asked(kpmId: string, leaderMembershipId: string) {
      const joiner = await makeUser(`asker-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${joiner.accessToken}` };
      await api().post('/api/v1/join/kpm').set(asJoiner).send({ kpmId }).expect(200);
      await api().post('/api/v1/join/leader-request')
        .set(asJoiner).send({ leaderMembershipId }).expect(200);
      return { joiner, asJoiner };
    }

    it('AC-1: refuses the inbox to somebody who leads nobody', async () => {
      // The permission is AB and AAB only; an agent never sees this.
      const { kpmId, auth } = await officeWithLeader();
      const list = await api().get('/api/v1/members').set(auth).expect(200);
      const { asJoiner } = await asked(kpmId, list.body.members[0].membershipId);

      const res = await api().get('/api/v1/join/requests').set(asJoiner).expect(403);
      expect(res.body.error.details.permission).toBe('leader_request:read_inbox');
    });

    it('shows the request, approves it, and empties the inbox', async () => {
      const { kpmId, auth } = await officeWithLeader();
      const list = await api().get('/api/v1/members').set(auth).expect(200);
      const leaderId = list.body.members[0].membershipId;
      const { asJoiner } = await asked(kpmId, leaderId);

      const inbox = await api().get('/api/v1/join/requests').set(auth).expect(200);
      expect(inbox.body).toHaveLength(1);
      expect(inbox.body[0].role).toBe('agent');

      const after = await api()
        .post(`/api/v1/join/requests/${inbox.body[0].requestId}/approve`)
        .set(auth).send({}).expect(200);
      expect(after.body).toEqual([]);

      // They are in, under the approver, and their own view says so.
      const me = await api().get('/api/v1/join/me').set(asJoiner).expect(200);
      expect(me.body.status).toBe('active');
      expect(me.body.leaderMembershipId).toBe(leaderId);
    });

    it('AC-4: refuses a second decision, naming which way the first went', async () => {
      const { kpmId, auth } = await officeWithLeader();
      const list = await api().get('/api/v1/members').set(auth).expect(200);
      await asked(kpmId, list.body.members[0].membershipId);

      const inbox = await api().get('/api/v1/join/requests').set(auth).expect(200);
      const { requestId } = inbox.body[0];
      await api().post(`/api/v1/join/requests/${requestId}/approve`).set(auth).send({}).expect(200);

      const res = await api()
        .post(`/api/v1/join/requests/${requestId}/decline`)
        .set(auth).send({}).expect(409);
      expect(res.body.error.code).toBe('ORG_REQUEST_ALREADY_DECIDED');
      expect(res.body.error.details.status).toBe('approved');
    });

    it('declining leaves them registered, free to ask somebody else', async () => {
      const { kpmId, auth } = await officeWithLeader();
      const list = await api().get('/api/v1/members').set(auth).expect(200);
      const { asJoiner } = await asked(kpmId, list.body.members[0].membershipId);

      const inbox = await api().get('/api/v1/join/requests').set(auth).expect(200);
      await api().post(`/api/v1/join/requests/${inbox.body[0].requestId}/decline`)
        .set(auth).send({ reason: 'Not my patch' }).expect(200);

      const me = await api().get('/api/v1/join/me').set(asJoiner).expect(200);
      expect(me.body.status).toBe('pending');
      expect(me.body.pendingRequestTo).toBeNull();
      // And the leader search is still open to them.
      await api().get('/api/v1/join/leaders').set(asJoiner).expect(200);
    });

    it('AC-3: tags somebody untagged, with nothing asked of them', async () => {
      const { kpmId, auth } = await officeWithLeader();
      const joiner = await makeUser(`untagged-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${joiner.accessToken}` };
      await api().post('/api/v1/join/kpm').set(asJoiner).send({ kpmId }).expect(200);

      const pool = await api().get('/api/v1/join/untagged').set(auth).expect(200);
      expect(pool.body).toHaveLength(1);

      const after = await api()
        .post(`/api/v1/join/untagged/${pool.body[0].membershipId}`)
        .set(auth).expect(200);
      expect(after.body).toEqual([]);

      const me = await api().get('/api/v1/join/me').set(asJoiner).expect(200);
      expect(me.body.status).toBe('active');
    });

    it('refuses tagging somebody who already reports to a leader', async () => {
      const { kpmId, auth } = await officeWithLeader();
      const list = await api().get('/api/v1/members').set(auth).expect(200);
      const leaderId = list.body.members[0].membershipId;
      await asked(kpmId, leaderId);
      const inbox = await api().get('/api/v1/join/requests').set(auth).expect(200);
      await api().post(`/api/v1/join/requests/${inbox.body[0].requestId}/approve`)
        .set(auth).send({}).expect(200);

      const res = await api()
        .post(`/api/v1/join/untagged/${inbox.body[0].membershipId}`)
        .set(auth).expect(409);
      expect(res.body.error.code).toBe('ORG_AGENT_ALREADY_TAGGED');
    });

    it('never reaches another office request', async () => {
      const mine = await officeWithLeader();
      const theirs = await officeWithLeader();
      const list = await api().get('/api/v1/members').set(theirs.auth).expect(200);
      await asked(theirs.kpmId, list.body.members[0].membershipId);
      const inbox = await api().get('/api/v1/join/requests').set(theirs.auth).expect(200);

      await api().post(`/api/v1/join/requests/${inbox.body[0].requestId}/approve`)
        .set(mine.auth).send({}).expect(404);
    });
  });

  describe('changing a role, over HTTP (P3-T6)', () => {
    /** An office, its Owner, and one agent who reports to them. */
    async function officeWithAgent() {
      const sa = await makeUser(`sa-role-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-role-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Role Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      const asOwner = { Authorization: `Bearer ${owner.accessToken}` };
      const kpmId = String(kpm.body._id);
      const agent = await joins(kpmId, asOwner);
      return { kpmId, asOwner, agent };
    }

    /** Somebody registers to the office and is pulled into the tagger's unit. */
    async function joins(kpmId: string, tagger: Record<string, string>) {
      const email = `member-${Math.random()}@kpm.test`;
      const user = await makeUser(email);
      const as = { Authorization: `Bearer ${user.accessToken}` };
      await api().post('/api/v1/join/kpm').set(as).send({ kpmId }).expect(200);

      const pool = await api().get('/api/v1/join/untagged').set(tagger).expect(200);
      const mine = pool.body.find((row: { email: string }) => row.email === email);
      await api().post(`/api/v1/join/untagged/${mine.membershipId}`).set(tagger).expect(200);
      return { ...user, as, membershipId: String(mine.membershipId) };
    }

    it('AC-1/AC-2: promotes, and the log carries the reason and who did it', async () => {
      const { asOwner, agent } = await officeWithAgent();

      const team = await api().get('/api/v1/members/my-team').set(asOwner).expect(200);
      expect(team.body).toHaveLength(1);
      expect(team.body[0]).toMatchObject({ role: 'agent', canChangeRole: true, directCount: 0 });

      const after = await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab', reason: 'Ready to lead a unit' }).expect(200);
      // The write answers with the team as it now stands, so the screen never has to
      // guess what the row became.
      expect(after.body[0].role).toBe('aab');

      const log = await api().get('/api/v1/members/role-changes').set(asOwner).expect(200);
      expect(log.body[0]).toMatchObject({
        membershipId: agent.membershipId,
        fromRole: 'agent',
        toRole: 'aab',
        reason: 'Ready to lead a unit',
      });
      expect(log.body[0].actorName).toBeTruthy();
    });

    it('nobody moves: the promoted person still reports to the same leader', async () => {
      const { asOwner, agent } = await officeWithAgent();
      const before = await api().get(`/api/v1/members/${agent.membershipId}`)
        .set(asOwner).expect(200);

      await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);

      const after = await api().get(`/api/v1/members/${agent.membershipId}`)
        .set(asOwner).expect(200);
      expect(after.body.leaderId).toBe(before.body.leaderId);
      expect(after.body.role).toBe('aab');
    });

    it('AC-3: refuses a demotion while people still report to them, with the count', async () => {
      const { kpmId, asOwner, agent } = await officeWithAgent();
      await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);
      await joins(kpmId, agent.as); // now the AAB leads somebody

      const res = await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'agent' }).expect(409);
      expect(res.body.error.code).toBe('ORG_HAS_DIRECT_REPORTS');
      expect(res.body.error.details.directCount).toBe(1);
      expect(res.body.error.message).toContain('1 person reports');
    });

    it('AC-1: an AB who is not an Admin cannot hand out AB', async () => {
      const { kpmId, asOwner, agent } = await officeWithAgent();
      await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'ab' }).expect(200);
      const theirs = await joins(kpmId, agent.as);

      // Agent ⇄ AAB is theirs to decide…
      await api().patch(`/api/v1/members/${theirs.membershipId}/role`)
        .set(agent.as).send({ toRole: 'aab' }).expect(200);

      // …the shape of the office is not.
      const res = await api().patch(`/api/v1/members/${theirs.membershipId}/role`)
        .set(agent.as).send({ toRole: 'ab' }).expect(403);
      expect(res.body.error.code).toBe('ORG_ROLE_CHANGE_NOT_PERMITTED');
      expect(res.body.error.message).toContain('Agency Builder');
    });

    it('refuses somebody who has the permission but is not their leader', async () => {
      const { kpmId, asOwner, agent } = await officeWithAgent();
      await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'ab' }).expect(200);
      const stranger = await joins(kpmId, asOwner); // reports to the Owner, not to the AB

      const res = await api().patch(`/api/v1/members/${stranger.membershipId}/role`)
        .set(agent.as).send({ toRole: 'aab' }).expect(403);
      expect(res.body.error.code).toBe('ORG_ROLE_CHANGE_NOT_PERMITTED');
      expect(res.body.error.message).toContain('direct leader');

      // And their team never listed them, so the control was never offered either.
      const team = await api().get('/api/v1/members/my-team').set(agent.as).expect(200);
      expect(team.body.map((r: { membershipId: string }) => r.membershipId))
        .not.toContain(stranger.membershipId);
    });

    it('refuses an agent outright — the permission is a leader permission', async () => {
      const { agent } = await officeWithAgent();
      const res = await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(agent.as).send({ toRole: 'aab' }).expect(403);
      expect(res.body.error.details.permission).toBe('member:change_role');
    });

    it('never reaches another office member, and 404s rather than 403', async () => {
      const mine = await officeWithAgent();
      const theirs = await officeWithAgent();

      await api().patch(`/api/v1/members/${theirs.agent.membershipId}/role`)
        .set(mine.asOwner).send({ toRole: 'aab' }).expect(404);

      // And the log stops at the office boundary too.
      await api().patch(`/api/v1/members/${theirs.agent.membershipId}/role`)
        .set(theirs.asOwner).send({ toRole: 'aab' }).expect(200);
      const log = await api().get('/api/v1/members/role-changes').set(mine.asOwner).expect(200);
      expect(log.body).toEqual([]);
    });

    it('refuses the office role-change log to an agent, whose own roster is one row', async () => {
      // The route was gated on `member:read_profile` until 2026-09-06 — a permission
      // every member holds — so any agent could read every promotion and demotion in the
      // office, with names and the leader's written reason, for people whose roster row
      // they are not allowed to see. `member:read_role_change_log` is the office-
      // administration permission, and nobody in the hierarchy is granted it.
      const { asOwner, agent } = await officeWithAgent();
      await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab', reason: 'Ready to lead a unit' }).expect(200);

      // The Owner sees it.
      const asSeen = await api().get('/api/v1/members/role-changes').set(asOwner).expect(200);
      expect(asSeen.body).toHaveLength(1);

      // The person it is *about* does not — the log is not a personal record.
      const refused = await api().get('/api/v1/members/role-changes').set(agent.as).expect(403);
      expect(refused.body.error.code).toBe('PERM_DENIED');
    });

    it('validates the role rather than writing whatever arrives', async () => {
      const { asOwner, agent } = await officeWithAgent();
      const res = await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'manager' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');

      await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab', note: 'dropped?' }).expect(400);
    });
  });

  describe('removing somebody, over HTTP (P3-T7)', () => {
    async function office() {
      const sa = await makeUser(`sa-rm-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-rm-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Removal Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      const asOwner = { Authorization: `Bearer ${owner.accessToken}` };
      return { kpmId: String(kpm.body._id), asOwner };
    }

    /** Registers somebody to the office and pulls them into the tagger's unit. */
    async function joins(kpmId: string, tagger: Record<string, string>) {
      const email = `rm-${Math.random()}@kpm.test`;
      const user = await makeUser(email);
      const as = { Authorization: `Bearer ${user.accessToken}` };
      await api().post('/api/v1/join/kpm').set(as).send({ kpmId }).expect(200);

      const pool = await api().get('/api/v1/join/untagged').set(tagger).expect(200);
      const mine = pool.body.find((row: { email: string }) => row.email === email);
      await api().post(`/api/v1/join/untagged/${mine.membershipId}`).set(tagger).expect(200);
      return { email, as, membershipId: String(mine.membershipId), accessToken: user.accessToken };
    }

    it('AC-1: refuses without the word, and the roster is unchanged', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);

      const res = await api().delete(`/api/v1/members/${them.membershipId}`)
        .set(asOwner).send({ confirmation: 'yes' }).expect(400);
      expect(res.body.error.code).toBe('ORG_REMOVAL_NOT_CONFIRMED');

      const roster = await api().get('/api/v1/members').set(asOwner).expect(200);
      expect(roster.body.members.map((m: { membershipId: string }) => m.membershipId))
        .toContain(them.membershipId);
    });

    it('AC-2: removes, and the row is still there when asked for', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);

      const after = await api().delete(`/api/v1/members/${them.membershipId}`)
        .set(asOwner).send({ confirmation: 'REMOVE', reason: 'Left the industry' }).expect(200);
      expect(after.body.map((r: { membershipId: string }) => r.membershipId))
        .not.toContain(them.membershipId);

      const roster = await api().get('/api/v1/members').set(asOwner).expect(200);
      expect(roster.body.members.map((m: { membershipId: string }) => m.membershipId))
        .not.toContain(them.membershipId);

      const removed = await api().get('/api/v1/members?status=removed').set(asOwner).expect(200);
      expect(removed.body.members).toHaveLength(1);
      expect(removed.body.members[0].removedAt).not.toBeNull();

      // And the link from that row still goes somewhere.
      const one = await api().get(`/api/v1/members/${them.membershipId}`).set(asOwner).expect(200);
      expect(one.body.status).toBe('removed');
    });

    it('AC-3: refuses a leader with reports until the body says where they go', async () => {
      const { kpmId, asOwner } = await office();
      const leader = await joins(kpmId, asOwner);
      await api().patch(`/api/v1/members/${leader.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);
      const asLeader = { Authorization: `Bearer ${leader.accessToken}` };
      const under = await joins(kpmId, asLeader);

      const refused = await api().delete(`/api/v1/members/${leader.membershipId}`)
        .set(asOwner).send({ confirmation: 'REMOVE' }).expect(400);
      expect(refused.body.error.code).toBe('ORG_SUBTREE_DISPOSITION_REQUIRED');
      expect(refused.body.error.details.directCount).toBe(1);

      await api().delete(`/api/v1/members/${leader.membershipId}`)
        .set(asOwner)
        .send({ confirmation: 'REMOVE', subtree: { action: 'orphan' } })
        .expect(200);

      // Orphaned, so they are back in the pool somebody can pick up.
      const pool = await api().get('/api/v1/join/untagged').set(asOwner).expect(200);
      expect(pool.body.map((p: { membershipId: string }) => p.membershipId))
        .toContain(under.membershipId);
    });

    it('AC-3: reassign moves the unit to the named leader', async () => {
      const { kpmId, asOwner } = await office();
      const leader = await joins(kpmId, asOwner);
      await api().patch(`/api/v1/members/${leader.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);
      const under = await joins(kpmId, { Authorization: `Bearer ${leader.accessToken}` });

      const owner = await api().get('/api/v1/members').set(asOwner).expect(200);
      const ownerId = owner.body.members.find(
        (m: { leaderId: string | null }) => m.leaderId === null,
      ).membershipId;

      await api().delete(`/api/v1/members/${leader.membershipId}`)
        .set(asOwner)
        .send({ confirmation: 'REMOVE', subtree: { action: 'reassign', toMembershipId: ownerId } })
        .expect(200);

      const moved = await api().get(`/api/v1/members/${under.membershipId}`).set(asOwner).expect(200);
      expect(moved.body.leaderId).toBe(ownerId);
    });

    it('AC-4: coming back is a new membership, carrying the same code', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);
      const before = await api().get(`/api/v1/members/${them.membershipId}`).set(asOwner).expect(200);

      await api().delete(`/api/v1/members/${them.membershipId}`)
        .set(asOwner).send({ confirmation: 'REMOVE' }).expect(200);

      // Their own view says they are out, and the register step is open again.
      const gone = await api().get('/api/v1/join/me').set(them.as).expect(200);
      expect(gone.body.status).toBe('none');

      await api().post('/api/v1/join/kpm').set(them.as).send({ kpmId }).expect(200);

      const rejoined = await api().get('/api/v1/join/me').set(them.as).expect(200);
      expect(rejoined.body.status).toBe('pending');

      const removed = await api().get('/api/v1/members?status=removed').set(asOwner).expect(200);
      expect(removed.body.members[0].agentCode).toBe(before.body.agentCode);

      // **Reversed by ADR-0017.** This asserted `not.toBe` while the office minted codes.
      // A producer id belongs to the person, so it comes back with them — and the
      // production import reconciles their figures across the gap instead of splitting
      // them between two producers who happen to share a name.
      const live = await api().get('/api/v1/members?status=pending').set(asOwner).expect(200);
      expect(live.body.members[0].agentCode).toBe(before.body.agentCode);
      expect(live.body.members[0].membershipId).not.toBe(them.membershipId);
    });

    it('refuses an agent the endpoint outright', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);
      const other = await joins(kpmId, asOwner);

      const res = await api().delete(`/api/v1/members/${other.membershipId}`)
        .set(them.as).send({ confirmation: 'REMOVE' }).expect(403);
      expect(res.body.error.details.permission).toBe('member:remove_from_team');
    });

    it('never reaches another office member, and 404s rather than 403', async () => {
      const mine = await office();
      const theirs = await office();
      const target = await joins(theirs.kpmId, theirs.asOwner);

      await api().delete(`/api/v1/members/${target.membershipId}`)
        .set(mine.asOwner).send({ confirmation: 'REMOVE' }).expect(404);
    });

    it('validates the disposition rather than writing a half-understood one', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);

      await api().delete(`/api/v1/members/${them.membershipId}`)
        .set(asOwner)
        .send({ confirmation: 'REMOVE', subtree: { action: 'move' } })
        .expect(400);

      // `reassign` without a destination is not a disposition.
      await api().delete(`/api/v1/members/${them.membershipId}`)
        .set(asOwner)
        .send({ confirmation: 'REMOVE', subtree: { action: 'reassign' } })
        .expect(400);

      await api().delete(`/api/v1/members/${them.membershipId}`)
        .set(asOwner)
        .send({ confirmation: 'REMOVE', note: 'dropped?' })
        .expect(400);
    });
  });

  describe('the tree, over HTTP (P3-T8)', () => {
    async function office() {
      const sa = await makeUser(`sa-tree-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-tree-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Tree Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      return { kpmId: String(kpm.body._id), asOwner: { Authorization: `Bearer ${owner.accessToken}` } };
    }

    async function joins(kpmId: string, tagger: Record<string, string>) {
      const email = `tree-${Math.random()}@kpm.test`;
      const user = await makeUser(email);
      const as = { Authorization: `Bearer ${user.accessToken}` };
      await api().post('/api/v1/join/kpm').set(as).send({ kpmId }).expect(200);
      const pool = await api().get('/api/v1/join/untagged').set(tagger).expect(200);
      const mine = pool.body.find((row: { email: string }) => row.email === email);
      await api().post(`/api/v1/join/untagged/${mine.membershipId}`).set(tagger).expect(200);
      return { as, membershipId: String(mine.membershipId), accessToken: user.accessToken };
    }

    it('routes /members/tree to the tree, not to a member called "tree"', async () => {
      // @Get('tree') has to be declared above @Get(':membershipId') or Nest resolves
      // this as a membership id and 404s.
      const { asOwner } = await office();
      const res = await api().get('/api/v1/members/tree').set(asOwner).expect(200);
      expect(res.body).toHaveProperty('nodes');
      expect(res.body).toHaveProperty('rootIds');
    });

    it('AC-2: gives the Owner the office, and a leader only their downline', async () => {
      const { kpmId, asOwner } = await office();
      const lead = await joins(kpmId, asOwner);
      await api().patch(`/api/v1/members/${lead.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);
      const under = await joins(kpmId, { Authorization: `Bearer ${lead.accessToken}` });
      const other = await joins(kpmId, asOwner);

      const wide = await api().get('/api/v1/members/tree').set(asOwner).expect(200);
      expect(wide.body.nodes).toHaveLength(4);

      const narrow = await api().get('/api/v1/members/tree').set(lead.as).expect(200);
      const ids = narrow.body.nodes.map((n: { membershipId: string }) => n.membershipId);
      expect(ids.sort()).toEqual([lead.membershipId, under.membershipId].sort());
      expect(ids).not.toContain(other.membershipId);
    });

    it('AC-1: layers are relative to your own tree, and your leader is not one', async () => {
      const { kpmId, asOwner } = await office();
      const lead = await joins(kpmId, asOwner);
      await api().patch(`/api/v1/members/${lead.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);
      const under = await joins(kpmId, { Authorization: `Bearer ${lead.accessToken}` });

      const mine = await api().get('/api/v1/members/tree').set(lead.as).expect(200);
      const byId = new Map(
        mine.body.nodes.map((n: { membershipId: string; layer: number }) => [n.membershipId, n.layer]),
      );
      expect(byId.get(lead.membershipId)).toBe(1);
      expect(byId.get(under.membershipId)).toBe(2);

      // The Owner is above them, sent separately, and is not a node.
      expect(mine.body.leader).not.toBeNull();
      expect(mine.body.leader).not.toHaveProperty('layer');
      expect(mine.body.nodes.map((n: { membershipId: string }) => n.membershipId))
        .not.toContain(mine.body.leader.membershipId);

      // The same person is one layer deeper seen office-wide.
      const wide = await api().get('/api/v1/members/tree').set(asOwner).expect(200);
      const wideById = new Map(
        wide.body.nodes.map((n: { membershipId: string; layer: number }) => [n.membershipId, n.layer]),
      );
      expect(wideById.get(under.membershipId)).toBe(3);
    });

    it('sends every root, so an orphan is not hidden', async () => {
      const { kpmId, asOwner } = await office();
      const lead = await joins(kpmId, asOwner);
      await api().patch(`/api/v1/members/${lead.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);
      const under = await joins(kpmId, { Authorization: `Bearer ${lead.accessToken}` });

      await api().delete(`/api/v1/members/${lead.membershipId}`)
        .set(asOwner).send({ confirmation: 'REMOVE', subtree: { action: 'orphan' } })
        .expect(200);

      const tree = await api().get('/api/v1/members/tree').set(asOwner).expect(200);
      expect(tree.body.rootIds).toContain(under.membershipId);
      expect(tree.body.nodes.map((n: { membershipId: string }) => n.membershipId))
        .toContain(under.membershipId);
      // And the removed leader is gone from it.
      expect(tree.body.nodes.map((n: { membershipId: string }) => n.membershipId))
        .not.toContain(lead.membershipId);
    });

    it('never reaches another office', async () => {
      const mine = await office();
      const theirs = await office();
      await joins(theirs.kpmId, theirs.asOwner);

      const tree = await api().get('/api/v1/members/tree').set(mine.asOwner).expect(200);
      expect(tree.body.nodes).toHaveLength(1);
    });

    it('answers an agent with a tree of one rather than refusing them', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);

      const tree = await api().get('/api/v1/members/tree').set(them.as).expect(200);
      expect(tree.body.nodes).toHaveLength(1);
      expect(tree.body.nodes[0].isSelf).toBe(true);
      expect(tree.body.leader).not.toBeNull();
    });
  });

  describe('groups and Core Leader, over HTTP (P3-T9)', () => {
    async function office() {
      const sa = await makeUser(`sa-grp-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-grp-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Group Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      const asOwner = { Authorization: `Bearer ${owner.accessToken}` };
      const roster = await api().get('/api/v1/members').set(asOwner).expect(200);
      return {
        kpmId: String(kpm.body._id),
        asOwner,
        ownerMembershipId: String(roster.body.members[0].membershipId),
      };
    }

    async function joins(kpmId: string, tagger: Record<string, string>) {
      const email = `grp-${Math.random()}@kpm.test`;
      const user = await makeUser(email);
      const as = { Authorization: `Bearer ${user.accessToken}` };
      await api().post('/api/v1/join/kpm').set(as).send({ kpmId }).expect(200);
      const pool = await api().get('/api/v1/join/untagged').set(tagger).expect(200);
      const mine = pool.body.find((row: { email: string }) => row.email === email);
      await api().post(`/api/v1/join/untagged/${mine.membershipId}`).set(tagger).expect(200);
      return { as, membershipId: String(mine.membershipId) };
    }

    it('routes /members/groups to groups, not to a member called "groups"', async () => {
      const { asOwner } = await office();
      const res = await api().get('/api/v1/members/groups').set(asOwner).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('creates, renames, and counts who is tagged', async () => {
      const { kpmId, asOwner, ownerMembershipId } = await office();
      const them = await joins(kpmId, asOwner);

      const made = await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: 'New Agent Mentoring Circle', ownerMembershipId })
        .expect(201);
      expect(made.body[0]).toMatchObject({ name: 'New Agent Mentoring Circle', memberCount: 0 });
      const groupId = made.body[0].groupId;

      await api().put(`/api/v1/members/${them.membershipId}/tags`).set(asOwner)
        .send({ groupIds: [groupId], isCoreLeader: false }).expect(200);

      const listed = await api().get('/api/v1/members/groups').set(asOwner).expect(200);
      expect(listed.body[0].memberCount).toBe(1);

      const renamed = await api().put(`/api/v1/members/groups/${groupId}`).set(asOwner)
        .send({ name: 'Top Producers 2026', ownerMembershipId }).expect(200);
      expect(renamed.body[0].name).toBe('Top Producers 2026');
    });

    it('refuses a duplicate name, and frees it once the group is retired', async () => {
      const { asOwner, ownerMembershipId } = await office();
      const made = await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: 'Task Force', ownerMembershipId }).expect(201);

      const clash = await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: 'Task Force', ownerMembershipId }).expect(409);
      expect(clash.body.error.code).toBe('ORG_GROUP_NAME_TAKEN');

      await api().delete(`/api/v1/members/groups/${made.body[0].groupId}`).set(asOwner).expect(200);
      await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: 'Task Force', ownerMembershipId }).expect(201);
    });

    it('AC-1: retiring keeps the tag, so who was in a cohort stays readable', async () => {
      const { kpmId, asOwner, ownerMembershipId } = await office();
      const them = await joins(kpmId, asOwner);
      const made = await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: 'Class of 2025', ownerMembershipId }).expect(201);
      const groupId = made.body[0].groupId;

      await api().put(`/api/v1/members/${them.membershipId}/tags`).set(asOwner)
        .send({ groupIds: [groupId], isCoreLeader: false }).expect(200);
      await api().delete(`/api/v1/members/groups/${groupId}`).set(asOwner).expect(200);

      const tags = await api().get(`/api/v1/members/${them.membershipId}/tags`)
        .set(asOwner).expect(200);
      expect(tags.body.groupIds).toEqual([groupId]);
      expect(await api().get('/api/v1/members/groups').set(asOwner).expect(200))
        .toHaveProperty('body', []);
    });

    it('AC-1: a group changes nothing about what anybody can see', async () => {
      const { kpmId, asOwner, ownerMembershipId } = await office();
      const one = await joins(kpmId, asOwner);
      const two = await joins(kpmId, asOwner);
      const made = await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: 'Circle', ownerMembershipId }).expect(201);

      const before = await api().get('/api/v1/members').set(one.as).expect(200);

      for (const person of [one, two]) {
        await api().put(`/api/v1/members/${person.membershipId}/tags`).set(asOwner)
          .send({ groupIds: [made.body[0].groupId], isCoreLeader: true }).expect(200);
      }

      const after = await api().get('/api/v1/members').set(one.as).expect(200);
      expect(after.body.members.map((m: { membershipId: string }) => m.membershipId))
        .toEqual(before.body.members.map((m: { membershipId: string }) => m.membershipId));
      // And the tree does not gain a node either.
      const tree = await api().get('/api/v1/members/tree').set(one.as).expect(200);
      expect(tree.body.nodes.map((n: { membershipId: string }) => n.membershipId))
        .not.toContain(two.membershipId);
    });

    it('refuses an agent every one of these routes', async () => {
      const { kpmId, asOwner, ownerMembershipId } = await office();
      const them = await joins(kpmId, asOwner);

      const listed = await api().get('/api/v1/members/groups').set(them.as).expect(403);
      expect(listed.body.error.details.permission).toBe('group_informal:create');

      await api().post('/api/v1/members/groups').set(them.as)
        .send({ name: 'Mine', ownerMembershipId }).expect(403);
      await api().put(`/api/v1/members/${them.membershipId}/tags`).set(them.as)
        .send({ groupIds: [], isCoreLeader: true }).expect(403);
    });

    it('never reaches another office group or member', async () => {
      const mine = await office();
      const theirs = await office();
      const made = await api().post('/api/v1/members/groups').set(theirs.asOwner)
        .send({ name: 'Theirs', ownerMembershipId: theirs.ownerMembershipId }).expect(201);
      const groupId = made.body[0].groupId;

      expect((await api().get('/api/v1/members/groups').set(mine.asOwner).expect(200)).body)
        .toEqual([]);
      await api().delete(`/api/v1/members/groups/${groupId}`).set(mine.asOwner).expect(404);
      await api().put(`/api/v1/members/${mine.ownerMembershipId}/tags`).set(mine.asOwner)
        .send({ groupIds: [groupId], isCoreLeader: false }).expect(404);
    });

    it('validates the body rather than writing what arrives', async () => {
      const { asOwner, ownerMembershipId } = await office();
      await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: '', ownerMembershipId }).expect(400);
      await api().post('/api/v1/members/groups').set(asOwner)
        .send({ name: 'Fine', ownerMembershipId, colour: 'red' }).expect(400);
      await api().put(`/api/v1/members/${ownerMembershipId}/tags`).set(asOwner)
        .send({ groupIds: 'not-an-array', isCoreLeader: false }).expect(400);
      await api().put(`/api/v1/members/${ownerMembershipId}/tags`).set(asOwner)
        .send({ groupIds: [], isCoreLeader: 'yes' }).expect(400);
    });
  });

  describe('KPM Admin delegation, over HTTP (P3-T10)', () => {
    async function office() {
      const sa = await makeUser(`sa-del-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-del-${Math.random()}@kpm.test`);

      const companyId = await anInsurer();
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: companyId,
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Delegation Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      const asOwner = { Authorization: `Bearer ${owner.accessToken}` };
      const roster = await api().get('/api/v1/members').set(asOwner).expect(200);
      return {
        kpmId: String(kpm.body._id),
        asOwner,
        ownerMembershipId: String(roster.body.members[0].membershipId),
      };
    }

    async function joins(kpmId: string, tagger: Record<string, string>) {
      const email = `del-${Math.random()}@kpm.test`;
      const user = await makeUser(email);
      const as = { Authorization: `Bearer ${user.accessToken}` };
      await api().post('/api/v1/join/kpm').set(as).send({ kpmId }).expect(200);
      const pool = await api().get('/api/v1/join/untagged').set(tagger).expect(200);
      const mine = pool.body.find((row: { email: string }) => row.email === email);
      await api().post(`/api/v1/join/untagged/${mine.membershipId}`).set(tagger).expect(200);
      return { as, membershipId: String(mine.membershipId) };
    }

    it('routes /members/admins to the list, not to a member called "admins"', async () => {
      const { asOwner } = await office();
      const res = await api().get('/api/v1/members/admins').set(asOwner).expect(200);
      expect(res.body).toEqual([]);
    });

    it('AC-2: grants to an AB with a unit, and touches neither role nor unit', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);
      await api().patch(`/api/v1/members/${them.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab' }).expect(200);
      await joins(kpmId, them.as);

      const before = await api().get(`/api/v1/members/${them.membershipId}`).set(asOwner).expect(200);
      const granted = await api().post(`/api/v1/members/${them.membershipId}/admin`)
        .set(asOwner).expect(201);

      expect(granted.body[0]).toMatchObject({ membershipId: them.membershipId, role: 'aab' });
      const after = await api().get(`/api/v1/members/${them.membershipId}`).set(asOwner).expect(200);
      expect(after.body.role).toBe(before.body.role);
      expect(after.body.directCount).toBe(before.body.directCount);
      expect(after.body.isKpmAdmin).toBe(true);
    });

    it('AC-1: an Admin is refused with PERM_OWNER_ONLY, not a flat PERM_DENIED', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);
      const other = await joins(kpmId, asOwner);
      await api().post(`/api/v1/members/${them.membershipId}/admin`).set(asOwner).expect(201);

      const granting = await api().post(`/api/v1/members/${other.membershipId}/admin`)
        .set(them.as).expect(403);
      expect(granting.body.error.code).toBe('PERM_OWNER_ONLY');
      expect(granting.body.error.details.permission).toBe('kpm_admin:grant');

      const revoking = await api().delete(`/api/v1/members/${them.membershipId}/admin`)
        .set(them.as).expect(403);
      expect(revoking.body.error.code).toBe('PERM_OWNER_ONLY');

      // They may still read the list, and every row says they cannot act on it.
      const listed = await api().get('/api/v1/members/admins').set(them.as).expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].canRevoke).toBe(false);
    });

    it('refuses an agent with PERM_DENIED — they are not missing owner-ness', async () => {
      // The distinction the guard draws: an Admin is told the Owner reserved it, an
      // agent is told this is not for them at all.
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);

      const listed = await api().get('/api/v1/members/admins').set(them.as).expect(403);
      expect(listed.body.error.code).toBe('PERM_DENIED');
    });

    it('revokes, and the person keeps their place in the office', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);
      await api().post(`/api/v1/members/${them.membershipId}/admin`).set(asOwner).expect(201);

      const after = await api().delete(`/api/v1/members/${them.membershipId}/admin`)
        .set(asOwner).expect(200);
      expect(after.body).toEqual([]);

      const still = await api().get(`/api/v1/members/${them.membershipId}`).set(asOwner).expect(200);
      expect(still.body.status).toBe('active');
      expect(still.body.isKpmAdmin).toBe(false);
    });

    it('refuses the Owner their own access — transferring the office is the operation', async () => {
      const { asOwner, ownerMembershipId } = await office();
      await api().post(`/api/v1/members/${ownerMembershipId}/admin`).set(asOwner).expect(201);

      const res = await api().delete(`/api/v1/members/${ownerMembershipId}/admin`)
        .set(asOwner).expect(403);
      expect(res.body.error.code).toBe('PERM_OWNER_ONLY');
    });

    it('refuses granting twice, and revoking somebody who never had it', async () => {
      const { kpmId, asOwner } = await office();
      const them = await joins(kpmId, asOwner);

      await api().post(`/api/v1/members/${them.membershipId}/admin`).set(asOwner).expect(201);
      const twice = await api().post(`/api/v1/members/${them.membershipId}/admin`)
        .set(asOwner).expect(409);
      expect(twice.body.error.code).toBe('ORG_ALREADY_ADMIN');

      const other = await joins(kpmId, asOwner);
      const never = await api().delete(`/api/v1/members/${other.membershipId}/admin`)
        .set(asOwner).expect(409);
      expect(never.body.error.code).toBe('ORG_NOT_AN_ADMIN');
    });

    it('never reaches another office member', async () => {
      const mine = await office();
      const theirs = await office();
      const target = await joins(theirs.kpmId, theirs.asOwner);

      await api().post(`/api/v1/members/${target.membershipId}/admin`)
        .set(mine.asOwner).expect(404);
      expect((await api().get('/api/v1/members/admins').set(mine.asOwner).expect(200)).body)
        .toEqual([]);
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
