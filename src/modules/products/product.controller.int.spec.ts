import mongoose from 'mongoose';
import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { REQUIRED_PERMISSION } from '@/common/auth/auth.decorators';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe } from '../../../test/http-permissions';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-18T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const KPM_A = '66f0000000000000000000a1';

const member = (over: Partial<Record<string, unknown>> = {}) => ({
  membershipId: 'mem-a', kpmId: KPM_A, orgLevelCode: 'AB', hierarchyRole: 'ab' as const,
  status: 'active' as const, isKpmOwner: true, isKpmAdmin: false, directCount: 0, ...over,
});
const SUPER_ADMIN = RequestContext.platform('root');
const OWNER = new RequestContext('u-owner', 'none', member() as never);
const ADMIN = new RequestContext('u-admin', 'none', member({
  membershipId: 'mem-c', isKpmOwner: false, isKpmAdmin: true,
}) as never);
const AGENT = new RequestContext('u-agent', 'none', member({
  membershipId: 'mem-b', orgLevelCode: 'AGENT', hierarchyRole: 'agent', isKpmOwner: false,
}) as never);
/** A plain AB and an AAB: leaders of the office, administrators of nothing. */
const AB = new RequestContext('u-ab', 'none', member({ membershipId: 'mem-d', isKpmOwner: false }) as never);
const AAB = new RequestContext('u-aab', 'none', member({
  membershipId: 'mem-e', orgLevelCode: 'AAB', hierarchyRole: 'aab', isKpmOwner: false,
}) as never);
/**
 * A Super Admin in a support session as the Owner — read-only, then elevated. Either way the context is
 * the member's, which holds no platform grant: `product_catalog:crud` is the Super Admin's as themselves.
 */
const supportSession = (readOnly: boolean) =>
  new RequestContext('u-owner', 'none', member() as never, 'root', null, false, readOnly);

let current: RequestContext = SUPER_ADMIN;

class StubAuth implements CanActivate {
  canActivate(execution: ExecutionContext): boolean {
    execution.switchToHttp().getRequest<{ context: RequestContext }>().context = current;
    return true;
  }
}

/**
 * The catalog controller over HTTP (P5-T4).
 *
 * A service test cannot see a decorator, and what this file is for is the decorators: who the
 * API refuses, and that `reorder` is routed as a literal rather than swallowed by `:productId`.
 * The auth guard is a stub — which session is signed in is `auth.e2e.int.spec.ts`'s question.
 * `PermissionsGuard` is the real one, because whether it refuses is this file's.
 */
describe('the product catalog controller (P5-T4)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = `/admin/companies/${COMPANY}/products`;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [ProductController],
      providers: [{ provide: ProductService, useValue: wired.products }],
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
    await stopMongo();
  });

  beforeEach(async () => {
    current = SUPER_ADMIN;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> })
      .create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' });
    await wired.products.seedForCompany(COMPANY);
  });

  const shelf = () => wired.products.list(COMPANY, { withCommission: true });

  describe('who may reach it', () => {
    it('answers the whole catalog to a Super Admin', async () => {
      const res = await request(app.getHttpServer()).get(url).expect(200);

      expect(res.body).toHaveLength(31);
      expect(res.body[0]).toMatchObject({ code: 'PRUMAPAN', sortOrder: 1, lifecycle: 'active' });
    });

    it.each([['an Owner', () => OWNER], ['an Admin', () => ADMIN], ['an agent', () => AGENT]])(
      'refuses %s, on the server and not only on the screen',
      async (_name, who) => {
        current = who();

        await request(app.getHttpServer()).get(url).expect(403);
        await request(app.getHttpServer()).post(url).send({
          code: 'X', name: 'X', channel: 'conventional', category: 'life',
        }).expect(403);
      },
    );

    it('declares a permission on every route', () => {
      // Four writes on AuthController once declared none, and a read-only support session
      // wrote through one of them. A route added here without a decorator fails this.
      const prototype = ProductController.prototype as unknown as Record<string, () => unknown>;
      const routes = Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => ({
          name,
          // A route, rather than a private helper: `@Get`/`@Post` stamp the method.
          method: Reflect.getMetadata('method', prototype[name]) as number | undefined,
          permission: new Reflector().get<string>(REQUIRED_PERMISSION, prototype[name]),
        }))
        .filter((r) => r.method !== undefined);

      // Eight since P19.4-T4: `DELETE …/:productId`, a withdrawn product's soft delete (ADR-0209 §10).
      expect(routes).toHaveLength(8);
      expect(routes.filter((r) => !r.permission).map((r) => r.name)).toEqual([]);
    });
  });

  describe('the routes', () => {
    it('adds a product and appends it to the shelf', async () => {
      const res = await request(app.getHttpServer()).post(url).send({
        code: 'pru_baru', name: 'PRUBaru', channel: 'syariah', category: 'health',
        primaryNeeds: ['health'], eligibleAgeBands: [1, 2], eligibleBudgetBands: [3],
      }).expect(201);

      expect(res.body).toMatchObject({ code: 'PRU_BARU', sortOrder: 32 });
    });

    it('refuses a code the company has used, and a code that is not one', async () => {
      await request(app.getHttpServer()).post(url).send({
        code: 'PRUMAPAN', name: 'Another', channel: 'conventional', category: 'life',
      }).expect(400);

      await request(app.getHttpServer()).post(url).send({
        code: 'PRULink Generasi Baru (PGB)', name: 'x', channel: 'conventional', category: 'life',
      }).expect(400);
    });

    it('refuses a channel, category or band the catalog does not have', async () => {
      const body = { code: 'PRU_X', name: 'X', channel: 'conventional', category: 'life' };

      await request(app.getHttpServer()).post(url)
        .send({ ...body, channel: 'unit-link' }).expect(400);
      await request(app.getHttpServer()).post(url)
        .send({ ...body, category: 'annuity' }).expect(400);
      // Seven budget bands, five age bands — the scale the ERD records.
      await request(app.getHttpServer()).post(url)
        .send({ ...body, eligibleBudgetBands: [8] }).expect(400);
      await request(app.getHttpServer()).post(url)
        .send({ ...body, eligibleAgeBands: [6] }).expect(400);
    });

    it('refuses a PATCH carrying a code or a lifecycle, by name', async () => {
      /*
       * `forbidNonWhitelisted` is on in production, so a field the DTO does not declare is a
       * **400 naming it**, not a silent drop — the reason `bootstrap.ts` gives is that a typo'd
       * field quietly ignored is the hardest kind of bug to find. This spec asserted the silent
       * drop until it booted the real pipe, which is the same mistake one layer up.
       */
      const mapan = (await shelf())[0];

      const res = await request(app.getHttpServer()).patch(`${url}/${mapan.id}`)
        .send({ name: 'PRUMapan Plus', code: 'ELSE', lifecycle: 'withdrawn' })
        .expect(400);

      expect(res.body.error.details.violations).toEqual(expect.arrayContaining([
        expect.stringContaining('code'), expect.stringContaining('lifecycle'),
      ]));
    });

    it('renames a product without touching its code or where it is in its life', async () => {
      const mapan = (await shelf())[0];

      const res = await request(app.getHttpServer()).patch(`${url}/${mapan.id}`)
        .send({ name: 'PRUMapan Plus' }).expect(200);

      expect(res.body).toMatchObject({
        code: 'PRUMAPAN', name: 'PRUMapan Plus', lifecycle: 'active',
      });
    });

    it('routes reorder as a literal, not as a product id', async () => {
      const ids = (await shelf()).map((p) => p.id).reverse();

      const res = await request(app.getHttpServer())
        .patch(`${url}/reorder`).send({ productIds: ids }).expect(200);

      expect(res.body.map((p: { id: string }) => p.id)).toEqual(ids);
    });

    it('moves a product along its lifecycle through its three named routes', async () => {
      const smart = (await shelf())[1];

      const closed = await request(app.getHttpServer())
        .post(`${url}/${smart.id}/close-to-new-business`).send({}).expect(201);
      expect(closed.body.lifecycle).toBe('closed_to_new_business');

      const withdrawn = await request(app.getHttpServer())
        .post(`${url}/${smart.id}/withdraw`).send({}).expect(201);
      expect(withdrawn.body.lifecycle).toBe('withdrawn');

      const reopened = await request(app.getHttpServer())
        .post(`${url}/${smart.id}/reopen`).send({}).expect(201);
      expect(reopened.body).toMatchObject({ lifecycle: 'active', replacedByProductId: null });
    });

    it('P19.4-T4 AC-13 refuses deleting a product on sale: it is withdrawn first', async () => {
      const mapan = (await shelf())[0];

      const res = await request(app.getHttpServer()).delete(`${url}/${mapan.id}`).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { lifecycle: 'active' } });
      expect((await shelf()).map((p) => p.id)).toContain(mapan.id);
    });

    it('answers 404 for a company that does not exist', async () => {
      await request(app.getHttpServer())
        .get('/admin/companies/66f0000000000000000000ff/products').expect(404);
    });
  });
  describe('the commission schedule (OD-135, ADR-0119)', () => {
    const mapanId = async () => (await shelf()).find((p) => p.code === 'PRUMAPAN')!.id;

    it('takes a rate per year from year 1, stores it in year order, and audits it', async () => {
      const id = await mapanId();

      const res = await request(app.getHttpServer()).patch(`${url}/${id}`).send({
        // Sent out of order: a schedule is a set of years, and it is stored as the drawer reads it.
        commissionSchedule: [{ year: 2, rate: 0.2 }, { year: 1, rate: 0.4 }, { year: 3, rate: 0.125 }],
      }).expect(200);

      expect(res.body.commissionSchedule).toEqual([
        { year: 1, rate: 0.4 }, { year: 2, rate: 0.2 }, { year: 3, rate: 0.125 },
      ]);
      // Only the schedule moved: nothing else on the product was written by a partial body.
      expect(res.body).toMatchObject({ code: 'PRUMAPAN', name: 'PRUMapan', version: 2 });

      const entry = await mongoose.connection.db!.collection('auditLog')
        .findOne({ action: 'product.updated', targetId: id });
      expect(entry!.after).toMatchObject({
        commissionSchedule: [{ year: 1, rate: 0.4 }, { year: 2, rate: 0.2 }, { year: 3, rate: 0.125 }],
      });
      // N3 (the Phase 14 exit review): what it replaced, too — the fields written and nothing else.
      expect(entry!.before).toEqual({ commissionSchedule: [] });
    });

    it('P14 exit review N3: a schedule changed and then cleared is audited with what each replaced', async () => {
      const id = await mapanId();
      await request(app.getHttpServer()).patch(`${url}/${id}`)
        .send({ commissionSchedule: [{ year: 1, rate: 0.4 }] }).expect(200);
      await request(app.getHttpServer()).patch(`${url}/${id}`)
        .send({ commissionSchedule: [{ year: 1, rate: 0.35 }, { year: 2, rate: 0.1 }] }).expect(200);
      await request(app.getHttpServer()).patch(`${url}/${id}`)
        .send({ commissionSchedule: [] }).expect(200);

      const entries = await mongoose.connection.db!.collection('auditLog')
        .find({ action: 'product.updated', targetId: id }).sort({ _id: 1 }).toArray();
      expect(entries.map((e) => [e.before, e.after])).toEqual([
        [{ commissionSchedule: [] }, { commissionSchedule: [{ year: 1, rate: 0.4 }] }],
        [{ commissionSchedule: [{ year: 1, rate: 0.4 }] }, { commissionSchedule: [{ year: 1, rate: 0.35 }, { year: 2, rate: 0.1 }] }],
        [{ commissionSchedule: [{ year: 1, rate: 0.35 }, { year: 2, rate: 0.1 }] }, { commissionSchedule: [] }],
      ]);
    });

    it('empties it back to not set', async () => {
      const id = await mapanId();
      await request(app.getHttpServer()).patch(`${url}/${id}`)
        .send({ commissionSchedule: [{ year: 1, rate: 0.4 }] }).expect(200);

      const res = await request(app.getHttpServer()).patch(`${url}/${id}`)
        .send({ commissionSchedule: [] }).expect(200);

      expect(res.body.commissionSchedule).toEqual([]);
    });

    it.each([
      ['a gap', [{ year: 1, rate: 0.4 }, { year: 3, rate: 0.1 }]],
      ['a year twice', [{ year: 1, rate: 0.4 }, { year: 1, rate: 0.3 }]],
      ['no year 1', [{ year: 2, rate: 0.2 }]],
    ])('refuses %s, naming the years, and writes nothing', async (_name, commissionSchedule) => {
      const id = await mapanId();

      const res = await request(app.getHttpServer()).patch(`${url}/${id}`)
        .send({ commissionSchedule }).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/from year 1, with no year missing and none twice/);
      expect((await shelf()).find((p) => p.id === id)!.commissionSchedule).toEqual([]);
    });

    it.each([
      ['over 100%', [{ year: 1, rate: 1.2 }]],
      ['below 0%', [{ year: 1, rate: -0.1 }]],
      ['a percentage where a proportion belongs', [{ year: 1, rate: 40 }]],
      ['a year that is not a whole number', [{ year: 1.5, rate: 0.4 }]],
      ['a rate that is not a number', [{ year: 1, rate: '40%' }]],
    ])('refuses %s through the pipe', async (_name, commissionSchedule) => {
      await request(app.getHttpServer()).patch(`${url}/${await mapanId()}`)
        .send({ commissionSchedule }).expect(400);
    });

    it.each([
      ['an Owner', () => OWNER], ['an Admin', () => ADMIN], ['an AB', () => AB], ['an AAB', () => AAB],
      ['an agent', () => AGENT],
      // P14 exit review S2: a support session is the member, never the platform — read-only or elevated.
      ['a read-only support session', () => supportSession(true)],
      ['an elevated support session', () => supportSession(false)],
    ])(
      'refuses %s a schedule, on the server and not only on the screen, and writes nothing', async (_name, who) => {
        const id = await mapanId();
        current = who();

        await request(app.getHttpServer()).patch(`${url}/${id}`)
          .send({ commissionSchedule: [{ year: 1, rate: 0.4 }] }).expect(403);

        expect((await shelf()).find((p) => p.id === id)!).toMatchObject({ commissionSchedule: [], version: 1 });
        expect(await mongoose.connection.db!.collection('auditLog').countDocuments({ targetId: id })).toBe(0);
      },
    );
  });
});
