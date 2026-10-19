import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AppModule } from '@/app.module';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth,
  SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { BillingController } from './billing.controller';

/** A support session: the Super Admin acting as the office's Owner, read-only or with write approved. */
const supportSession = (readOnly: boolean) => new RequestContext(
  'u-owner', 'none',
  {
    membershipId: 'mem-owner', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 3,
  },
  'u-root', null, false, readOnly,
);

const rp = (major: number) => major * 100;

/**
 * The quote tool's price read over HTTP (P13.2-T2 AC-2; ADR-0111 §3).
 *
 * The Super Admin reads the table; every tenant role and a support session are refused 403 by the
 * guard, before the handler runs. **Built with no providers at all**: the controller has nothing to read
 * a collection with and nothing to write an audit row with, so this module compiling is the proof that
 * it does neither (AC-2, AC-9). A dependency added to it later fails here.
 */
describe('GET /admin/billing/prices (P13.2-T2)', () => {
  let app: INestApplication;
  const url = '/admin/billing/prices';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    session.current = SUPER_ADMIN;
  });

  it('declares billing:read_prices on its one route, and has no other', () => {
    expect(declaredPermissions(BillingController)).toEqual({ prices: 'billing:read_prices' });
  });

  it('is wired into the application', () => {
    expect(Reflect.getMetadata('controllers', AppModule)).toContain(BillingController);
  });

  it('AC-2 reads no collection and writes no audit row: the controller takes nothing to do either with', () => {
    // No constructor parameters: no model, no repository, no audit service can reach it.
    expect(Reflect.getMetadata('design:paramtypes', BillingController) ?? []).toEqual([]);
    expect(BillingController.length).toBe(0);
  });

  it('AC-2 answers the Super Admin the table, in IDR minor units, with the annual discount', async () => {
    const res = await request(app.getHttpServer()).get(url).expect(200);

    expect(res.body).toEqual({
      currency: 'IDR',
      annualDiscountPct: 5,
      tiers: [
        { code: 'TIER_1_10', minLeaders: 1, maxLeaders: 10, standardMinor: rp(500_000), sixMonthMinor: rp(400_000), annualMinor: rp(380_000), customPricing: false },
        { code: 'TIER_11_20', minLeaders: 11, maxLeaders: 20, standardMinor: rp(475_000), sixMonthMinor: rp(375_000), annualMinor: rp(356_250), customPricing: false },
        { code: 'TIER_21_50', minLeaders: 21, maxLeaders: 50, standardMinor: rp(450_000), sixMonthMinor: rp(350_000), annualMinor: rp(332_500), customPricing: false },
        { code: 'TIER_51_100', minLeaders: 51, maxLeaders: 100, standardMinor: rp(425_000), sixMonthMinor: rp(300_000), annualMinor: rp(285_000), customPricing: false },
        { code: 'TIER_101_PLUS', minLeaders: 101, maxLeaders: null, standardMinor: rp(375_000), sixMonthMinor: rp(250_000), annualMinor: rp(237_500), customPricing: true },
      ],
    });
  });

  it('AC-2 answers the same table twice: a caller cannot change what the next one reads', async () => {
    const first = await request(app.getHttpServer()).get(url).expect(200);
    const second = await request(app.getHttpServer()).get(url).expect(200);
    expect(second.body).toEqual(first.body);
  });

  it.each([
    ['the Owner', OWNER],
    ['the Admin', ADMIN],
    ['an AB', AB],
    ['an AAB', AAB],
    ['an Agent', AGENT],
    ['a read-only support session', supportSession(true)],
    ['a support session approved to write', supportSession(false)],
  ] as [string, RequestContext][])('AC-2 refuses %s 403, and shows them no rate', async (_name, who) => {
    session.current = who;

    const res = await request(app.getHttpServer()).get(url).expect(403);

    expect(res.body.error.code).toBe('PERM_DENIED');
    expect(res.body.error.details).toEqual({ permission: 'billing:read_prices' });
    // Not one figure of the table, the 101+ tier's least of all.
    expect(JSON.stringify(res.body)).not.toMatch(/TIER_|Minor/);
  });

  it('AC-9 writes nothing: the route answers GET alone', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      await request(app.getHttpServer())[method](url).send({}).expect(404);
    }
  });
});
