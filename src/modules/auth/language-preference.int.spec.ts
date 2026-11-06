import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuthGuard } from '@/common/auth/auth.guard';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { DEFAULT_LANGUAGE } from '@/domain/constants';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { listenOnLoopback } from '../../../test/listen';
import { productionPipe } from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ContextResolver } from './context-resolver';
import { ImpersonationService } from './impersonation.service';
import { RateLimiter } from './rate-limiter';
import { Hs256TokenSigner, TokenSigner } from './token-signer';

const NOW = new Date('2026-10-29T03:00:00Z');

/**
 * **The one kind of support session** (ADR-0206 §3): it only looks. The setup session and the one a second Super Admin
 * let write (ADR-0162) are retired — `liveSession` answers `null` for their rows (`impersonation.service.tenancy.spec.ts`).
 */
const SESSIONS = {
  'a support session': { readOnly: true, purpose: 'support' },
} as const;
type SessionKind = keyof typeof SESSIONS;

/**
 * **The reader's language, kept on their account, over HTTP** (P18.10-T2 AC-1, AC-2, AC-7; ADR-0179 §2), through the
 * real `AuthGuard`, `ContextResolver` and `PermissionsGuard`, a signed token and the real `users` rows.
 *
 * - `GET /auth/me` answers `user.locale`, the language in force — `'id'` for somebody who has chosen nothing — and
 *   `user.localeChosen`, which tells the two apart.
 * - `PATCH /auth/me` takes `locale`, `'id'` or `'en'`, for every role, and refuses anything else, `null` included.
 * - It stays refused in a support session (ADR-0162 §4; since P19.4-T2 as every write of one is, ADR-0206 §4): the
 *   person's choice is neither written there nor replaced, and the session still reads.
 *
 * No cross-tenant case: the route reaches only the caller's own account (AC-7).
 */
describe('P18.10-T2 the language on the account, over HTTP', () => {
  let app: INestApplication;
  const clock = new FixedClock(NOW);
  const signer = new Hs256TokenSigner('s'.repeat(40), clock);
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let memberships: mongoose.Model<Membership>;
  /** The support session the next `imp:` token is in, as `ImpersonationService.liveSession` reads its row. */
  let liveSession: { readOnly: boolean; purpose: string } = SESSIONS['a support session'];
  let seq = 0;

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    memberships = mongoose.model(Membership.name, MembershipSchema) as never;

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        Reflector,
        { provide: Clock, useValue: clock },
        { provide: TokenSigner, useValue: signer },
        { provide: getModelToken(User.name), useValue: users },
        { provide: getModelToken(Kpm.name), useValue: kpms },
        { provide: getModelToken(Membership.name), useValue: memberships },
        MembershipRepository,
        // `PATCH /auth/me` asks the service about a birth date and a join month only; neither is sent here.
        { provide: AuthService, useValue: { refusePersonalData: () => undefined } },
        { provide: RateLimiter, useValue: { check: () => null } },
        { provide: ConfigService, useValue: { get: () => undefined, getOrThrow: () => 's'.repeat(40) } },
        { provide: ImpersonationService, useValue: { liveSession: async () => liveSession } },
        ContextResolver, AuthGuard, ViewOnlySessionGuard, PermissionsGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(app.get(AuthGuard), app.get(ViewOnlySessionGuard), app.get(PermissionsGuard));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    liveSession = SESSIONS['a support session'];
  });

  type Role = 'super_admin' | 'owner' | 'admin' | 'ab' | 'aab' | 'agent' | 'nobody';
  const ROLES: [string, Role][] = [
    ['the Super Admin', 'super_admin'], ['a KPM Owner', 'owner'], ['a KPM Admin', 'admin'], ['an AB', 'ab'],
    ['an AAB', 'aab'], ['an Agent', 'agent'], ['somebody in no office yet', 'nobody'],
  ];

  /** A person at a role, with the account `users` holds for them — `locale` as every account made before T2 has it. */
  async function person(role: Role, locale: string | null = null): Promise<string> {
    seq += 1;
    const user = await users.create({
      email: `${role}${seq}@kpm.test`, passwordHash: 'x', fullName: `${role} ${seq}`, status: 'active',
      platformRole: role === 'super_admin' ? 'super_admin' : 'none', locale,
    });
    if (role === 'super_admin' || role === 'nobody') return String(user._id);
    const kpm = await kpms.create({
      companyId: `company-${seq}`, code: `04${String(seq).padStart(2, '0')}`, branchName: 'Cempaka Putih',
      timezone: 'Asia/Jakarta',
    });
    const rung = role === 'owner' || role === 'admin' ? 'ab' : role;
    await memberships.create({
      kpmId: String(kpm._id), userId: String(user._id), agentCode: `${10_000 + seq}`, agentSeq: seq,
      leaderCode: `LC${String(seq).padStart(4, '0')}`, orgLevelId: `lvl-${rung}`, orgLevelCode: rung.toUpperCase(),
      role: rung, status: 'active',
      adminAccess: { isKpmAdmin: role === 'admin', grantedByUserId: null, grantedAt: null, revokedAt: null },
    });
    if (role === 'owner') await kpms.updateOne({ _id: kpm._id }, { $set: { ownerUserId: String(user._id) } });
    return String(user._id);
  }

  const as = (userId: string, sid = 'session') => ({ Authorization: `Bearer ${signer.sign({ sub: userId, sid }, 3600)}` });
  const http = () => request(app.getHttpServer());
  const me = (userId: string, sid?: string) => http().get('/api/v1/auth/me').set(as(userId, sid));
  const patch = (userId: string, body: unknown, sid?: string) =>
    http().patch('/api/v1/auth/me').set(as(userId, sid)).send(body as object);
  const stored = async (userId: string) => (await users.findById(userId).lean().exec())?.locale;

  describe('AC-1 the stored value', () => {
    it.each(ROLES)('reads %s who has chosen nothing — a null, as on every account — as Bahasa Indonesia', async (_, role) => {
      const userId = await person(role);
      expect(await stored(userId)).toBeNull();

      const res = await me(userId).expect(200);

      expect(res.body.user).toMatchObject({ locale: 'id', localeChosen: false });
      expect(res.body.user.locale).toBe(DEFAULT_LANGUAGE);
    });

    it.each(ROLES)('saves %s’s choice on their account, and answers it as chosen', async (_, role) => {
      const userId = await person(role);

      const res = await patch(userId, { locale: 'en' }).expect(200);

      // The answer is `GET`'s shape, as every `PATCH /auth/me` is: the screen never guesses what it became.
      expect(res.body.user).toMatchObject({ locale: 'en', localeChosen: true });
      expect(await stored(userId)).toBe('en');
      expect((await me(userId).expect(200)).body.user).toMatchObject({ locale: 'en', localeChosen: true });

      // And back: choosing Bahasa Indonesia is a choice, not the default.
      await patch(userId, { locale: 'id' }).expect(200);
      expect(await stored(userId)).toBe('id');
      expect((await me(userId).expect(200)).body.user).toMatchObject({ locale: 'id', localeChosen: true });
    });

    it('takes the language on its own, and touches nothing else on the account', async () => {
      const userId = await person('agent');
      await users.updateOne({ _id: userId }, { $set: { preferredName: 'Rina', pronoun: 'she' } });

      await patch(userId, { locale: 'en' }).expect(200);

      const after = await users.findById(userId).lean().exec();
      expect(after).toMatchObject({ locale: 'en', preferredName: 'Rina', pronoun: 'she', fullName: `agent ${seq}` });
    });

    it('leaves the language as it was when a change does not send one', async () => {
      const userId = await person('agent', 'en');

      await patch(userId, { pronoun: 'he' }).expect(200);

      expect(await stored(userId)).toBe('en');
    });

    it.each([
      ['a language the app does not speak', 'fr'],
      ['null: a choice once made is not taken back', null],
      ['nothing at all', ''],
      ['a code in capitals', 'EN'],
      ['a region’s form', 'id-ID'],
      ['a number', 1],
    ])('refuses %s, 400 VALIDATION_FAILED with the violation, and writes nothing', async (_, locale) => {
      const userId = await person('agent', 'en');

      const res = await patch(userId, { locale }).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.violations).toEqual(['locale must be id or en']);
      expect(await stored(userId)).toBe('en');
    });
  });

  // Phase 18.10's exit permission review: a language is saved by somebody, never by nobody.
  it('refuses a language with no session, 401, and writes nothing', async () => {
    const userId = await person('agent', 'en');

    const res = await request(app.getHttpServer()).patch('/api/v1/auth/me').send({ locale: 'id' }).expect(401);

    expect(res.body.error.code).toBeDefined();
    expect(await stored(userId)).toBe('en');
  });

  describe('AC-2 in a support session the person’s language is theirs', () => {
    it.each(Object.keys(SESSIONS) as SessionKind[])('P19.4-T2 AC-2 refuses PATCH /auth/me in %s, 403 IMPERSONATION_READ_ONLY', async (kind) => {
      liveSession = SESSIONS[kind];
      const userId = await person('owner', 'en');

      const res = await patch(userId, { locale: 'id' }, 'imp:sa-1').expect(403);

      // Every write of a session meets `ViewOnlySessionGuard` first (ADR-0206 §4); it was `PERM_DENIED` until then.
      expect(res.body.error.code).toBe('IMPERSONATION_READ_ONLY');
      // Neither written nor replaced: the person's own choice stands.
      expect(await stored(userId)).toBe('en');
    });

    it.each(Object.keys(SESSIONS) as SessionKind[])('still reads the session’s account in %s', async (kind) => {
      liveSession = SESSIONS[kind];
      const userId = await person('agent');

      const res = await me(userId, 'imp:sa-1').expect(200);

      expect(res.body).toMatchObject({ isImpersonating: true, user: { locale: 'id', localeChosen: false } });
    });

    it('lets the person themselves, outside the session, change it as before', async () => {
      const userId = await person('agent', 'en');
      await patch(userId, { locale: 'id' }, 'imp:sa-1').expect(403);

      await patch(userId, { locale: 'id' }).expect(200);

      expect(await stored(userId)).toBe('id');
    });
  });
});
