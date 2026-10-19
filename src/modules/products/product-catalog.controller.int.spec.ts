import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, OWNER,
  productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { AttackPlanController, ProductCatalogController } from './product-catalog.controller';
import { ProductCatalogService } from './product-catalog.service';

const NOW = new Date('2026-10-08T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';

/** A member of the fixture office whose membership is not active: no hierarchy grant survives it. */
const PENDING_AGENT = new RequestContext('u-pending', 'none', {
  membershipId: 'mem-p', kpmId: FIXTURE_KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'pending', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/** A Super Admin in a **read-only** support session, acting as the fixture office's agent (roles §3.13). */
const READ_ONLY_SESSION = new RequestContext('u-agent', 'none', {
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never, 'root', null, false, true);

/**
 * **Who the API lets read the office's shelf** (P14-T7 AC-12, P14-T8 AC-12): the four field routes over
 * HTTP, with the real `PermissionsGuard` and the production pipe. The service's own rules — isolation, the
 * words, the scorer — are `product-catalog.tenancy.spec.ts`'s; this asks what a caller meets at the door.
 */
describe('the Product Catalog and the Sales Attack Plan over HTTP (Phase 14)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const service = new ProductCatalogService(wired.kpmProducts, wired.clock);

    const moduleRef = await Test.createTestingModule({
      controllers: [ProductCatalogController, AttackPlanController],
      providers: [{ provide: ProductCatalogService, useValue: service }],
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
    session.current = AGENT;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> })
      .create({ _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' });
    await mongoose.model(Kpm.name, KpmSchema).create({
      _id: FIXTURE_KPM, companyId: PRUDENTIAL, code: '0417', branchName: 'BSD City', timezone: 'Asia/Jakarta',
    });
    await wired.products.seedForCompany(PRUDENTIAL);
    // The company's illustration on PRUMapan, so a document's link has a file to sign (the brochure
    // slot stays empty: *a slot with nothing in it is 404*, below).
    const signed = await wired.assets.requestCompanyUpload(PRUDENTIAL, {
      folder: 'products', filename: 'illustration.pdf', mimeType: 'application/pdf', bytes: 2048,
    });
    await wired.assets.confirmCompanyUpload(PRUDENTIAL, signed.storageKey);
    await mongoose.connection.db!.collection('products').updateOne(
      { companyId: PRUDENTIAL, code: 'PRUMAPAN' },
      { $set: { 'defaultDocuments.illustration': { storageKey: signed.storageKey, label: 'Ilustrasi', mimeType: 'application/pdf', bytes: 2048 } } },
    );
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  /** Every route, with a path that answers 200 for a reader who may read. */
  const READS = [
    ['the shelf', '/product-catalog'],
    ['one product', '/product-catalog/PRUMAPAN'],
    ['a document’s link', '/product-catalog/PRUMAPAN/documents/illustration/url'],
    ['the plan', '/attack-plan?need=retirement&age=2&budget=2'],
  ] as const;

  describe('the decorators', () => {
    it('declares product_catalog:read on every route, the plan’s included (D-api)', () => {
      expect(declaredPermissions(ProductCatalogController)).toEqual({
        list: 'product_catalog:read', product: 'product_catalog:read', documentUrl: 'product_catalog:read',
      });
      expect(declaredPermissions(AttackPlanController)).toEqual({ plan: 'product_catalog:read' });
    });
  });

  describe('per role (P14-T7 AC-12, P14-T8 AC-12)', () => {
    it.each(EVERY_MEMBER)('lets %s read the shelf, a product, a document’s link and a plan', async (_name, who) => {
      session.current = who;
      for (const [, path] of READS) {
        const res = await get(path);
        expect([path, res.status]).toEqual([path, 200]);
      }
    });

    it.each(EVERY_MEMBER)('sends %s the commission schedule, every field role holding commission_rates:read (OD-135)', async (_n, who) => {
      session.current = who;
      const res = await get('/product-catalog/PRUMAPAN').expect(200);
      expect(res.body.commissionSchedule).toEqual([]);
    });

    it('refuses a Super Admin outside a support session on every route: there is no office to read', async () => {
      session.current = SUPER_ADMIN;
      for (const path of [...READS.map(([, p]) => p), '/product-catalog/PRUMAPAN/documents/brochure/url']) {
        const res = await get(path);
        expect([path, res.status, res.body.error?.code]).toEqual([path, 403, 'TENANT_NO_MEMBERSHIP']);
      }
    });

    it('refuses a member whose membership is not active, at the guard', async () => {
      session.current = PENDING_AGENT;
      for (const path of [...READS.map(([, p]) => p), '/product-catalog/PRUMAPAN/documents/brochure/url']) {
        const res = await get(path);
        expect([path, res.status]).toEqual([path, 403]);
      }
    });

    it('lets a read-only support session read the shelf, open a document and build a plan — which writes nothing anyway', async () => {
      session.current = READ_ONLY_SESSION;
      for (const [, path] of READS) {
        const res = await get(path);
        expect([path, res.status]).toEqual([path, 200]);
      }
    });

    it('answers the same shelf to the Owner, the Admin and each rung of one office', async () => {
      const shelves = [];
      for (const who of [OWNER, ADMIN, AB, AAB, AGENT]) {
        session.current = who;
        shelves.push((await get('/product-catalog').expect(200)).body.products.map((p: { code: string }) => p.code));
      }
      expect(new Set(shelves.map((s) => JSON.stringify(s))).size).toBe(1);
      expect(shelves[0]).toHaveLength(29);
    });
  });

  describe('the shapes (the Data contract)', () => {
    it('answers the shelf as { products }, each card the contract’s fields and nothing of the office’s drafts', async () => {
      const res = await get('/product-catalog').expect(200);
      expect(Object.keys(res.body)).toEqual(['products']);
      expect(Object.keys(res.body.products[0]).sort()).toEqual(
        ['category', 'channel', 'code', 'lifecycle', 'name', 'needs', 'tagline'],
      );
    });

    it('answers one product with the drawer’s fields', async () => {
      const res = await get('/product-catalog/PRUMAPAN').expect(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'ageBands', 'benefits', 'bestFit', 'budgetBands', 'category', 'channel', 'code', 'commissionSchedule',
        'differentiator', 'documents', 'lifecycle', 'name', 'needs', 'runOffNote', 'script', 'successorCode', 'tagline',
      ]);
    });

    it('answers a plan with the brief as read, as numbers', async () => {
      const res = await get('/attack-plan?need=retirement&age=2&budget=2').expect(200);
      expect(res.body).toMatchObject({
        brief: { need: 'retirement', age: 2, budget: 2 },
        product: { code: 'PRUMAPAN' }, verdict: 'good_fit', outside: [],
        alternatives: [{ code: 'PRUANUGERAH', name: 'PRUAnugerah' }], moreCount: 0, shelfEmpty: false,
      });
    });
  });

  describe('a brief outside the constants is refused (P14-T8 AC-4)', () => {
    it.each([
      ['an unknown need', '/attack-plan?need=pets&age=2&budget=2'],
      ['an age band past 5', '/attack-plan?need=health&age=6&budget=2'],
      ['an age band of 0', '/attack-plan?need=health&age=0&budget=2'],
      ['a budget band past 7', '/attack-plan?need=health&age=2&budget=8'],
      ['a band that is not a whole number', '/attack-plan?need=health&age=2.5&budget=2'],
      ['a band that is not a number', '/attack-plan?need=health&age=two&budget=2'],
      ['no need', '/attack-plan?age=2&budget=2'],
      ['no budget', '/attack-plan?need=health&age=2'],
      ['a parameter nobody asked for', '/attack-plan?need=health&age=2&budget=2&channel=syariah'],
      ['an empty product', '/attack-plan?need=health&age=2&budget=2&product='],
    ])('%s: 400 VALIDATION_FAILED', async (_n, path) => {
      const res = await get(path).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('outside the shelf is 404, never 403', () => {
    it('a code the office does not keep on, and one nobody holds', async () => {
      // PSGB is in run-off and not on by default: the office has never kept it on.
      for (const path of [
        '/product-catalog/PRULINK_SYARIAH_GENERASI_BARU_PSGB',
        '/product-catalog/NOT_A_PRODUCT',
        '/product-catalog/NOT_A_PRODUCT/documents/brochure/url',
        '/attack-plan?need=health&age=2&budget=2&product=PRUMAPAN',
      ]) {
        const res = await get(path);
        expect([path, res.status, res.body.error?.code]).toEqual([path, 404, 'NOT_FOUND']);
      }
    });

    it('a slot with nothing in it is 404', async () => {
      const res = await get('/product-catalog/PRUMAPAN/documents/brochure/url').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
