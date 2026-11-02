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

const NOW = new Date('2026-10-30T03:00:00Z');

/**
 * **Your own WhatsApp number, over HTTP** (UI V1, 2026-10-30; UI-081, UI-101, UI-111, the owner's D-22), through the
 * real `AuthGuard`, `ContextResolver` and `PermissionsGuard`, a signed token and the real `users` rows.
 *
 * - `PATCH /auth/me` takes `phone` as people type it and stores `+62` and 9 to 13 digits (`normalisePhone`); empty,
 *   blank or `null` clears it; anything else is `400 VALIDATION_FAILED` naming `phone`, and nothing is written.
 * - `GET /auth/me` answers `user.phone`, `null` for somebody who has none.
 * - Refused in a support session, as everything on `PATCH /auth/me` is (ADR-0162 §4).
 *
 * No cross-tenant case: the route reaches only the caller's own account.
 */
describe('UI-081 / D-22 your own WhatsApp number on PATCH /auth/me', () => {
  let app: INestApplication;
  const clock = new FixedClock(NOW);
  const signer = new Hs256TokenSigner('s'.repeat(40), clock);
  let users: mongoose.Model<User>;
  let kpms: mongoose.Model<Kpm>;
  let memberships: mongoose.Model<Membership>;
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
        { provide: ImpersonationService, useValue: { liveSession: async () => ({ readOnly: false, writeScope: [] }) } },
        ContextResolver, AuthGuard, PermissionsGuard,
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

  beforeEach(clearCollections);

  /** An agent in an office, with the account `users` holds for them. */
  async function agent(phone: string | null = null): Promise<string> {
    seq += 1;
    const user = await users.create({
      email: `agent${seq}@kpm.test`, passwordHash: 'x', fullName: `Agent ${seq}`, status: 'active',
      platformRole: 'none', phone,
    });
    const kpm = await kpms.create({
      companyId: `company-${seq}`, code: `05${String(seq).padStart(2, '0')}`, branchName: 'Cempaka Putih',
      timezone: 'Asia/Jakarta',
    });
    await memberships.create({
      kpmId: String(kpm._id), userId: String(user._id), agentCode: `${20_000 + seq}`, agentSeq: seq,
      leaderCode: `LC${String(seq).padStart(4, '0')}`, orgLevelId: 'lvl-agent', orgLevelCode: 'AGENT',
      role: 'agent', status: 'active',
      adminAccess: { isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null },
    });
    return String(user._id);
  }

  const as = (userId: string, sid = 'session') => ({ Authorization: `Bearer ${signer.sign({ sub: userId, sid }, 3600)}` });
  const http = () => request(app.getHttpServer());
  const me = (userId: string, sid?: string) => http().get('/api/v1/auth/me').set(as(userId, sid));
  const patch = (userId: string, body: unknown, sid?: string) =>
    http().patch('/api/v1/auth/me').set(as(userId, sid)).send(body as object);
  const stored = async (userId: string) => (await users.findById(userId).lean().exec())?.phone;

  it('UI-081 answers null on GET /auth/me for somebody with no number', async () => {
    const userId = await agent();

    expect((await me(userId).expect(200)).body.user.phone).toBeNull();
  });

  it.each([
    ['with its dashes', '0812-1100-2200'],
    ['with +62 and spaces', '+62 812 1100 2200'],
    ['without its trunk zero', '812 1100 2200'],
  ])('UI-081 saves a number typed %s as +62 and its digits, and GET reads it back', async (_, typed) => {
    const userId = await agent();

    const res = await patch(userId, { phone: typed }).expect(200);

    expect(res.body.user.phone).toBe('+6281211002200');
    expect(await stored(userId)).toBe('+6281211002200');
    expect((await me(userId).expect(200)).body.user.phone).toBe('+6281211002200');
  });

  it.each([['null', null], ['an empty field', ''], ['a blank one', '   ']])('UI-081 clears the number on %s', async (_, phone) => {
    const userId = await agent('+6281211002200');

    const res = await patch(userId, { phone }).expect(200);

    expect(res.body.user.phone).toBeNull();
    expect(await stored(userId)).toBeNull();
  });

  it('UI-081 leaves the number as it was when a change does not send one', async () => {
    const userId = await agent('+6281211002200');

    await patch(userId, { pronoun: 'he' }).expect(200);

    expect(await stored(userId)).toBe('+6281211002200');
  });

  it.each([
    ['eight digits', '12345678'],
    ['fourteen digits', '8'.repeat(14)],
    ['letters', '0812-ABCD-2200'],
    ['a number, not text', 81211002200],
  ])('UI-081 refuses %s, 400 VALIDATION_FAILED naming phone, in both languages, and writes nothing', async (_, phone) => {
    const userId = await agent('+6281211002200');

    const res = await patch(userId, { phone }).expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.violations).toEqual(['phone must be an Indonesian number: 9 to 13 digits after +62']);
    expect(await stored(userId)).toBe('+6281211002200');

    const id = await patch(userId, { phone }).set('Accept-Language', 'id').expect(400);
    expect(id.body.error.details.violations).toEqual(['phone harus nomor Indonesia: 9 sampai 13 digit setelah +62']);
  });

  it('UI-081 refuses it in a support session, 403 PERM_DENIED, and writes nothing', async () => {
    const userId = await agent('+6281211002200');

    const res = await patch(userId, { phone: '0813 0000 1111' }, 'imp:sa-1').expect(403);

    expect(res.body.error.code).toBe('PERM_DENIED');
    expect(await stored(userId)).toBe('+6281211002200');
  });
});
