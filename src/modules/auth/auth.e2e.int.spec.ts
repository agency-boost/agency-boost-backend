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
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import {
  MembershipHistory, MembershipHistorySchema,
} from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { DirectoryService } from '@/modules/org/directory.service';
import { OrgController } from '@/modules/org/org.controller';
import { JoinRequest, JoinRequestSchema } from '@/modules/org/join-request.schema';
import { OnboardingService } from '@/modules/org/onboarding.service';
import { OnboardingController } from '@/modules/org/onboarding.controller';
import { InviteCode, InviteCodeSchema } from '@/modules/org/invite-code.schema';
import { InviteService } from '@/modules/org/invite.service';
import { ApprovalsService } from '@/modules/org/approvals.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
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
          { name: Membership.name, schema: MembershipSchema },
          { name: MembershipHistory.name, schema: MembershipHistorySchema },
          { name: JoinRequest.name, schema: JoinRequestSchema },
          { name: InviteCode.name, schema: InviteCodeSchema },
        ]),
      ],
      controllers: [AuthController, AdminController, OrgController, OnboardingController],
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
        MembershipRepository, HierarchyService, DirectoryService, OnboardingService, InviteService, ApprovalsService, RoleChangeService,
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
      // Three, and every one of them exists so somebody in no office can get into one:
      // find an office, attach to it, or walk in through a leader's invite. Anything
      // more would be a grant that outlives the reason for it.
      expect(me.body.permissions).toEqual([
        'kpm:read_directory',
        'kpm_registration:create',
        'join_via_code_link_qr',
      ]);
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

  describe('joining an office, over HTTP (P3-T3)', () => {
    /** The whole chain, in the order a person actually walks it. */
    async function officeWithLeader() {
      const sa = await makeUser(`sa-join-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-join-${Math.random()}@kpm.test`);

      const company = await api().post('/api/v1/admin/companies').set(auth)
        .send({ name: `Insurer ${Math.random()}`, slug: `slug-${Math.random()}`.replace(/[^a-z0-9-]/g, '') })
        .expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'Join Branch' })
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
      expect(Object.keys(res.body[0]).sort()).toEqual(
        ['branchName', 'city', 'code', 'companyName', 'kpmId'],
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

      const company = await api().post('/api/v1/admin/companies').set(auth)
        .send({ name: `Insurer ${Math.random()}`, slug: `s${Math.random()}`.replace(/[^a-z0-9-]/g, '') })
        .expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({ companyId: String(company.body._id), code: `${Math.floor(Math.random() * 9000) + 1000}`, branchName: 'Roster Branch' })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      return { kpmId: String(kpm.body._id), owner, auth: { Authorization: `Bearer ${owner.accessToken}` } };
    }

    it('returns the Owner as an AB at the root, with an issued code', async () => {
      const { auth } = await officeWithOwner();
      const res = await api().get('/api/v1/members').set(auth).expect(200);

      expect(res.body.members).toHaveLength(1);
      expect(res.body.members[0]).toMatchObject({
        role: 'ab', status: 'active', leaderId: null, isLeader: false,
      });
      expect(res.body.members[0].agentCode).toMatch(/^KPM\d+-001$/);
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

      const company = await api().post('/api/v1/admin/companies').set(auth)
        .send({ name: `Insurer ${Math.random()}`, slug: `i${Math.random()}`.replace(/[^a-z0-9-]/g, '') })
        .expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: String(company.body._id),
          code: `${Math.floor(Math.random() * 9000) + 1000}`,
          branchName: 'Invite Branch',
        })
        .expect(201);
      await api().patch(`/api/v1/admin/tenants/${kpm.body._id}/owner`)
        .set(auth).send({ userId: owner.id }).expect(200);

      return { kpmId: String(kpm.body._id), auth: { Authorization: `Bearer ${owner.accessToken}` } };
    }

    it('issues a code and a link that are the same invite', async () => {
      const { auth } = await leaderInOffice();
      // 201, not 200: this creates a resource, the same as a company or a tenant does.
      const res = await api().post('/api/v1/join/invites').set(auth).send({}).expect(201);

      expect(res.body.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(res.body.url).toContain(`/join?code=${res.body.code}`);
      expect(res.body.state).toBe('active');
    });

    it('walks the whole redemption: preview, then accept', async () => {
      const { auth, kpmId } = await leaderInOffice();
      const issued = await api().post('/api/v1/join/invites').set(auth).send({}).expect(201);

      const joiner = await makeUser(`inv-joiner-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${joiner.accessToken}` };

      // Lower case on purpose: people type a code as they read it.
      const preview = await api()
        .get(`/api/v1/join/invite?code=${issued.body.code.toLowerCase()}`)
        .set(asJoiner).expect(200);
      expect(preview.body.kpmLabel).toContain('Invite Branch');
      expect(preview.body.leaderName).toBeTruthy();

      const redeemed = await api().post('/api/v1/join/redeem')
        .set(asJoiner).send({ code: issued.body.code }).expect(200);
      expect(redeemed.body.kpmId).toBe(kpmId);

      // Active straight away, tagged to the issuer, and no request in anybody's inbox.
      const me = await api().get('/api/v1/join/me').set(asJoiner).expect(200);
      expect(me.body.status).toBe('active');
      expect(me.body.leaderName).toBeTruthy();
      expect(me.body.pendingRequestTo).toBeNull();
    });

    it('refuses a withdrawn invite exactly as it refuses one nobody issued', async () => {
      const { auth } = await leaderInOffice();
      const issued = await api().post('/api/v1/join/invites').set(auth).send({}).expect(201);
      await api().delete(`/api/v1/join/invites/${issued.body.inviteId}`).set(auth).expect(200);

      const joiner = await makeUser(`inv-late-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${joiner.accessToken}` };

      const withdrawn = await api().post('/api/v1/join/redeem')
        .set(asJoiner).send({ code: issued.body.code }).expect(410);
      const unknown = await api().post('/api/v1/join/redeem')
        .set(asJoiner).send({ code: 'ZZZZZZ' }).expect(410);

      expect(withdrawn.body.error.code).toBe(unknown.body.error.code);
      expect(withdrawn.body.error.message).toBe(unknown.body.error.message);
    });

    it('refuses an agent issuing one — an invite is a leader artefact', async () => {
      const { auth, kpmId } = await leaderInOffice();
      const issued = await api().post('/api/v1/join/invites').set(auth).send({}).expect(201);

      const joiner = await makeUser(`inv-agent-${Math.random()}@kpm.test`);
      const asJoiner = { Authorization: `Bearer ${joiner.accessToken}` };
      await api().post('/api/v1/join/redeem').set(asJoiner).send({ code: issued.body.code }).expect(200);
      expect(kpmId).toBeDefined();

      const res = await api().post('/api/v1/join/invites').set(asJoiner).send({}).expect(403);
      expect(res.body.error.details.permission).toBe('member:invite');
    });

    it('validates the limits rather than clamping them silently', async () => {
      const { auth } = await leaderInOffice();
      await api().post('/api/v1/join/invites').set(auth).send({ maxUses: 0 }).expect(400);
      await api().post('/api/v1/join/invites').set(auth).send({ expiresInDays: 900 }).expect(400);
      await api().post('/api/v1/join/invites').set(auth).send({ code: 'MINE01' }).expect(400);
    });
  });

  describe('approving and tagging, over HTTP (P3-T5)', () => {
    async function officeWithLeader() {
      const sa = await makeUser(`sa-app-${Math.random()}@agencyboost.test`, 'super_admin');
      const auth = { Authorization: `Bearer ${sa.accessToken}` };
      const owner = await makeUser(`owner-app-${Math.random()}@kpm.test`);

      const company = await api().post('/api/v1/admin/companies').set(auth)
        .send({ name: `Insurer ${Math.random()}`, slug: `a${Math.random()}`.replace(/[^a-z0-9-]/g, '') })
        .expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: String(company.body._id),
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

      const company = await api().post('/api/v1/admin/companies').set(auth)
        .send({ name: `Insurer ${Math.random()}`, slug: `r${Math.random()}`.replace(/[^a-z0-9-]/g, '') })
        .expect(201);
      const kpm = await api().post('/api/v1/admin/tenants').set(auth)
        .send({
          companyId: String(company.body._id),
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

    it('validates the role rather than writing whatever arrives', async () => {
      const { asOwner, agent } = await officeWithAgent();
      const res = await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'manager' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');

      await api().patch(`/api/v1/members/${agent.membershipId}/role`)
        .set(asOwner).send({ toRole: 'aab', note: 'dropped?' }).expect(400);
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
