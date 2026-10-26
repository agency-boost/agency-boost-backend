import { Controller, Get, HttpCode, INestApplication, Post, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuthGuard } from '@/common/auth/auth.guard';
import {
  ALLOWED_WHILE_OFFICE_UNAVAILABLE, AllowWhileOfficeUnavailable, AllowWhileReadOnly, Ctx, RequirePermission,
} from '@/common/auth/auth.decorators';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock, Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { AdminController } from '@/modules/tenants/admin.controller';
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

/** Any tenant route: what a member's next request after `/auth/me` meets. */
@Controller('probe')
class TenantProbeController {
  @Get()
  @RequirePermission('tenant_config:read')
  read(@Ctx() ctx: RequestContext) {
    return { kpmId: ctx.kpmId };
  }
}

/** A route marked as `POST /admin/impersonate/end` is: what a support session leaving meets. */
@Controller('probe-leave')
class LeaveProbeController {
  @Post()
  @HttpCode(200)
  @AllowWhileReadOnly()
  @AllowWhileOfficeUnavailable()
  leave(@Ctx() ctx: RequestContext) {
    return { isImpersonating: ctx.isImpersonating };
  }
}

/** The end date of office 0601, and the instants either side of it in Jakarta. */
const END_DATE = '2026-10-07';
/** 23:30 on the end date in Jakarta: still served. */
const ON_THE_END_DATE = new Date('2026-10-07T16:30:00Z');
/** 00:00 the next day in Jakarta, 17:00 UTC on the end date: refused. */
const THE_NEXT_DAY = new Date('2026-10-07T17:00:00Z');

/**
 * **The end of a subscription, over HTTP** (ADR-0112 §3, P13.2-T3 AC-5), through the real `AuthGuard`,
 * `ContextResolver` and `PermissionsGuard`: a signed token, a real membership, a real office row.
 *
 * One test per role — the Owner, the Admin, an AB, an AAB and an Agent — each served on the end date and
 * refused `403 TENANT_SUBSCRIPTION_ENDED` from 00:00 the next day in Jakarta, on `/auth/me` and on a
 * tenant route after it, the office named in the details. Then what is never refused: an office kept
 * active, one with no dates, the Super Admin, a support session, and another office's members; and what
 * keeps its own code: a suspended or archived office.
 */
describe('an ended office over HTTP (P13.2-T3 AC-5)', () => {
  let app: INestApplication;
  const clock = new FixedClock(ON_THE_END_DATE);
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
      controllers: [AuthController, TenantProbeController, LeaveProbeController],
      providers: [
        Reflector,
        { provide: Clock, useValue: clock },
        { provide: TokenSigner, useValue: signer },
        { provide: getModelToken(User.name), useValue: users },
        { provide: getModelToken(Kpm.name), useValue: kpms },
        { provide: getModelToken(Membership.name), useValue: memberships },
        // `/auth/me` reads the reader's work status off their membership (ADR-0158).
        MembershipRepository,
        // `/auth/me` reads the user model and the context; nothing it calls on the service runs here.
        { provide: AuthService, useValue: {} },
        { provide: RateLimiter, useValue: { check: () => null } },
        { provide: ConfigService, useValue: { get: () => undefined, getOrThrow: () => 's'.repeat(40) } },
        // A support session is live for as long as this says so; its own lifecycle is tested elsewhere.
        { provide: ImpersonationService, useValue: { liveSession: async () => ({ readOnly: true }) } },
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

  beforeEach(async () => {
    await clearCollections();
    clock.set(ON_THE_END_DATE);
  });

  const subscription = (over: Record<string, unknown> = {}) => ({
    startDate: '2025-10-08', endDate: END_DATE, pricePerLeaderMinor: 350_000_00,
    currency: 'IDR', maxLeaders: null, keepActiveAfterEnd: false, ...over,
  });

  async function office(over: Record<string, unknown> = {}) {
    seq += 1;
    return kpms.create({
      companyId: `company-${seq}`, code: '0601', branchName: 'Cikarang Branch',
      timezone: 'Asia/Jakarta', subscription: subscription(), ...over,
    });
  }

  type Role = 'owner' | 'admin' | 'ab' | 'aab' | 'agent';

  /** A person standing in an office at a role, with the token their sign-in would carry. */
  async function member(kpm: { _id: unknown }, role: Role): Promise<string> {
    seq += 1;
    const user = await users.create({
      email: `${role}${seq}@kpm.test`, passwordHash: 'x', fullName: `${role} ${seq}`,
      status: 'active', platformRole: 'none',
    });
    const rung = role === 'owner' || role === 'admin' ? 'ab' : role;
    await memberships.create({
      kpmId: String(kpm._id), userId: String(user._id), agentCode: `PRU-${seq}`, agentSeq: seq,
      leaderCode: `LC${String(seq).padStart(4, '0')}`, orgLevelId: `lvl-${rung}`,
      orgLevelCode: rung.toUpperCase(), role: rung, status: 'active',
      adminAccess: {
        isKpmAdmin: role === 'admin', grantedByUserId: null, grantedAt: null, revokedAt: null,
      },
    });
    if (role === 'owner') await kpms.updateOne({ _id: kpm._id }, { $set: { ownerUserId: String(user._id) } });
    return String(user._id);
  }

  const token = (userId: string, sid = 'session') => signer.sign({ sub: userId, sid }, 3600);
  const me = (userId: string, sid?: string) =>
    request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token(userId, sid)}`);
  const probe = (userId: string, sid?: string) =>
    request(app.getHttpServer()).get('/api/v1/probe').set('Authorization', `Bearer ${token(userId, sid)}`);

  const ENDED = {
    code: 'TENANT_SUBSCRIPTION_ENDED',
    details: { endDate: END_DATE, kpmCode: '0601', branch: 'Cikarang Branch' },
  };

  it.each<[string, Role]>([
    ['the Owner', 'owner'], ['the Admin', 'admin'], ['an AB', 'ab'], ['an AAB', 'aab'], ['an Agent', 'agent'],
  ])('%s is served on the end date, and refused from 00:00 the next day in Jakarta', async (_who, role) => {
    const kpm = await office();
    const userId = await member(kpm, role);

    await me(userId).expect(200);
    await probe(userId).expect(200);

    clock.set(THE_NEXT_DAY);
    const refusedMe = await me(userId).expect(403);
    expect(refusedMe.body.error).toMatchObject(ENDED);
    const refusedLater = await probe(userId).expect(403);
    expect(refusedLater.body.error).toMatchObject(ENDED);
  });

  it('serves an office kept active after its end, and one with no dates', async () => {
    const kept = await member(await office({ subscription: subscription({ keepActiveAfterEnd: true }) }), 'agent');
    const undated = await member(
      await office({ subscription: subscription({ startDate: null, endDate: null }) }), 'agent',
    );
    const none = await member(await office({ subscription: null }), 'agent');
    clock.set(THE_NEXT_DAY);
    for (const userId of [kept, undated, none]) {
      await me(userId).expect(200);
      await probe(userId).expect(200);
    }
  });

  it('a suspended and an archived office keep their own codes, which win', async () => {
    const suspended = await member(await office({ status: 'suspended' }), 'owner');
    const archived = await member(await office({ status: 'archived' }), 'agent');
    clock.set(THE_NEXT_DAY);
    expect((await me(suspended).expect(403)).body.error).toMatchObject({
      code: 'TENANT_SUSPENDED', details: { kpmCode: '0601', branch: 'Cikarang Branch' },
    });
    expect((await me(archived).expect(403)).body.error).toMatchObject({ code: 'TENANT_ARCHIVED' });
  });

  it('never refuses the Super Admin, who is nobody’s member', async () => {
    await office();
    const sa = await users.create({
      email: 'sa@agencyboost.test', passwordHash: 'x', fullName: 'Root', status: 'active',
      platformRole: 'super_admin',
    });
    clock.set(THE_NEXT_DAY);
    await me(String(sa._id)).expect(200);
  });

  it('serves a support session into an ended office, so support can still look', async () => {
    const agent = await member(await office(), 'agent');
    clock.set(THE_NEXT_DAY);
    const res = await me(agent, 'imp:sa-1').expect(200);
    expect(res.body).toMatchObject({ isImpersonating: true, impersonatedBy: 'sa-1' });
    await probe(agent, 'imp:sa-1').expect(200);
  });

  /*
   * **Leaving a support session in an office suspended under it** (P13.2 exit review): every other
   * request of the session is refused with the office's code, and ending it is not — so the operator is
   * never stranded in a session that stays live and writes no `impersonation.ended`. Only a session: the
   * member's own request to the same route is refused as before.
   */
  it.each(['suspended', 'archived'])('lets a support session leave a %s office, and nothing else', async (status) => {
    const agent = await member(await office({ status }), 'agent');
    await probe(agent, 'imp:sa-1').expect(403);
    const leave = (sid?: string) => request(app.getHttpServer()).post('/api/v1/probe-leave')
      .set('Authorization', `Bearer ${token(agent, sid)}`);
    expect((await leave('imp:sa-1').expect(200)).body).toEqual({ isImpersonating: true });
    expect((await leave().expect(403)).body.error.code).toBe(status === 'archived' ? 'TENANT_ARCHIVED' : 'TENANT_SUSPENDED');
  });

  it('marks ending a support session, and only that, as reachable in an office nobody can use', () => {
    const marked = Object.getOwnPropertyNames(AdminController.prototype).filter((name) =>
      Reflect.getMetadata(ALLOWED_WHILE_OFFICE_UNAVAILABLE, (AdminController.prototype as never)[name]) === true);
    expect(marked).toEqual(['endImpersonation']);
  });

  it('leaves another office’s members alone', async () => {
    await member(await office(), 'agent');
    const elsewhere = await member(await office({ code: '0417', subscription: subscription({ endDate: '2027-01-06' }) }), 'agent');
    clock.set(THE_NEXT_DAY);
    await me(elsewhere).expect(200);
  });

  it('lets the members back in at their next request once the end is moved', async () => {
    const kpm = await office();
    const agent = await member(kpm, 'agent');
    clock.set(THE_NEXT_DAY);
    await me(agent).expect(403);
    await kpms.updateOne({ _id: kpm._id }, { $set: { 'subscription.endDate': '2026-12-31' } });
    await me(agent).expect(200);
  });
});
