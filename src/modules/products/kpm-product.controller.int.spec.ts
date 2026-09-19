import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, EVERY_MEMBER, FIXTURE_KPM, OWNER,
  productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { KpmProductController } from './kpm-product.controller';
import { KpmProductService } from './kpm-product.service';

const NOW = new Date('2026-09-18T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const KPM_A = FIXTURE_KPM;

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  list: 'tenant_config:read',
  setActive: 'tenant_config:write',
  saveOverrides: 'tenant_config:write',
  resetOverride: 'tenant_config:write',
  setDocument: 'tenant_config:write',
  resetDocument: 'tenant_config:write',
  documentUrl: 'tenant_config:read',
  pendingReviews: 'tenant_config:read',
  approveScript: 'sales_script:approve',
  rejectScript: 'sales_script:approve',
  effectiveScript: 'tenant_config:read',
};

/**
 * What an office decides about its products, over HTTP (P5-T5, P5-T10).
 *
 * **A service test cannot see a decorator**, and until this file existed nothing in the backend
 * called this controller at all — so its eleven `@RequirePermission` decorators were never
 * executed by a test in either direction. `kpm-product.tenancy.spec.ts` proves the isolation and
 * the inheritance by calling the service, and its fixture is an Owner by default, so P5-T10's own
 * AC-3 — *"every other role is refused by the API"* — was a sentence nothing checked.
 *
 * The auth guard is a stub: which session is signed in is `auth.e2e.int.spec.ts`'s question.
 * `PermissionsGuard` is the real one, because whether it refuses is this file's.
 */
describe('an office’s products over HTTP (P5-T5, P5-T10)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let mapanId: string;
  const url = '/kpm/settings/products';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [KpmProductController],
      providers: [{ provide: KpmProductService, useValue: wired.kpmProducts }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    session.current = OWNER;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> })
      .create({ _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' });
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: KPM_A, companyId: PRUDENTIAL, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    });
    await wired.products.seedForCompany(PRUDENTIAL);
    mapanId = (await wired.products.list(PRUDENTIAL, { withCommission: false }))
      .find((p) => p.code === 'PRUMAPAN')!.id;
  });

  /** Put a script override in front of the gate, so approve and reject have something to decide. */
  const writeScript = () => wired.kpmProducts.saveOverrides(OWNER, mapanId, {
    opening: 'Halo Pak, boleh saya cerita sebentar?',
  });

  describe('the decorators', () => {
    it('declares a permission on every route, and the right one', () => {
      // Equality, not a subset: a route added without a row above fails this too.
      expect(declaredPermissions(KpmProductController)).toEqual(ROUTES);
    });
  });

  describe('the script approval gate, per role (P5-T10 AC-3)', () => {
    /*
     * The gate is the reason this file was written first.
     *
     * ADR-0037 made approving a **separate** permission from writing, precisely so that moving it
     * later — to a Super Admin, or to a company compliance role — is a grant change rather than a
     * redesign. Today both lists read Owner and Admin, which is exactly why the negative half has
     * to be spelled out per role: nothing else in the suite distinguishes the two permissions.
     */
    it.each([['the Owner', () => OWNER], ['the Admin', () => ADMIN]])(
      'lets %s approve, and the row comes back approved', async (_name, who) => {
        await writeScript();
        session.current = who();

        const res = await request(app.getHttpServer())
          .post(`${url}/${mapanId}/script/approve`).send({}).expect(201);

        expect(res.body.script.opening.value).toBe('Halo Pak, boleh saya cerita sebentar?');
        expect(res.body.reviewState).toBe('approved');
      },
    );

    it.each([
      ['an AB', () => AB], ['an AAB', () => AAB], ['an agent', () => AGENT],
      // A Super Admin writes the **company's** catalog, never an office's decisions about it —
      // so the platform is refused here as firmly as a leader is.
      ['a Super Admin', () => SUPER_ADMIN],
    ])('refuses %s both decisions, on the server and not only on the screen', async (_n, who) => {
      await writeScript();
      session.current = who();

      await request(app.getHttpServer())
        .post(`${url}/${mapanId}/script/approve`).send({}).expect(403);
      await request(app.getHttpServer())
        .post(`${url}/${mapanId}/script/reject`).send({ reason: 'Terlalu menjanjikan.' })
        .expect(403);
    });

    it('leaves the script unapproved after a refusal, not merely unanswered', async () => {
      // A 403 that had already written would be worse than no gate: the caller is told no and
      // the agents read it anyway.
      await writeScript();
      session.current = AGENT;
      await request(app.getHttpServer())
        .post(`${url}/${mapanId}/script/approve`).send({}).expect(403);

      session.current = OWNER;
      const served = await request(app.getHttpServer())
        .get(`${url}/${mapanId}/script/effective`).expect(200);
      expect(served.body.source).toBe('company');
    });

    it('needs a reason to send one back, through the pipe as well as the service', async () => {
      await writeScript();

      await request(app.getHttpServer())
        .post(`${url}/${mapanId}/script/reject`).send({}).expect(400);
      await request(app.getHttpServer())
        .post(`${url}/${mapanId}/script/reject`).send({ reason: '   ' }).expect(400);
    });

    it('routes script-reviews as a literal, not as a product id', async () => {
      await writeScript();

      const res = await request(app.getHttpServer()).get(`${url}/script-reviews`).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].code).toBe('PRUMAPAN');
    });

    it('opens the queue to everybody in the office, and deciding to nobody else', async () => {
      // Reading is `tenant_config:read` on purpose: every row is already in the shelf, so a
      // stricter grant on the same bytes would be theatre. Deciding is the separate grant.
      await writeScript();

      for (const who of [AB, AAB, AGENT]) {
        session.current = who;
        await request(app.getHttpServer()).get(`${url}/script-reviews`).expect(200);
        await request(app.getHttpServer())
          .post(`${url}/${mapanId}/script/approve`).send({}).expect(403);
      }
    });
  });

  describe('the office’s own decisions, per role', () => {
    it.each([['the Owner', () => OWNER], ['the Admin', () => ADMIN]])(
      'lets %s change what the office sells', async (_name, who) => {
        session.current = who();

        const res = await request(app.getHttpServer())
          .put(`${url}/${mapanId}/active`).send({ active: false }).expect(200);

        expect(res.body.active).toMatchObject({ value: false, overridden: true });
      },
    );

    it.each([
      ['an AB', () => AB], ['an AAB', () => AAB], ['an agent', () => AGENT],
      ['a Super Admin', () => SUPER_ADMIN],
    ])('refuses %s every write this controller has', async (_name, who) => {
      session.current = who();
      const server = app.getHttpServer();

      await request(server).put(`${url}/${mapanId}/active`).send({ active: true }).expect(403);
      await request(server).patch(`${url}/${mapanId}/overrides`)
        .send({ displayName: 'Ours' }).expect(403);
      await request(server).delete(`${url}/${mapanId}/overrides/displayName`).expect(403);
      await request(server).put(`${url}/${mapanId}/documents/brochure`)
        .send({ storageKey: 'k', label: 'L' }).expect(403);
      await request(server).delete(`${url}/${mapanId}/documents/brochure`).expect(403);
    });

    it('lets every member of the office read the shelf', async () => {
      for (const [, who] of EVERY_MEMBER) {
        session.current = who;
        const res = await request(app.getHttpServer()).get(url).expect(200);
        expect(res.body).toHaveLength(31);
      }
    });

    it('answers a Super Admin 404 rather than 403, because they are in no office', async () => {
      /*
       * They hold `tenant_config:read` at `all`, so the guard lets them through — and then
       * `companyOf` has no `kpmId` to resolve and the shelf genuinely does not exist for them.
       * 404 is the right answer and the project's stated one: a 403 would confirm an office the
       * caller never named. Worth pinning, because the grant reads as though this route were
       * open to the platform and it is not.
       */
      session.current = SUPER_ADMIN;

      await request(app.getHttpServer()).get(url).expect(404);
    });

    it('refuses a field that belongs to the company, by name and before it writes', async () => {
      /*
       * The pipe refuses it, naming `code`, and nothing is written — not even the half of the
       * body that was legitimate. An edit that half-saved leaves nobody able to find out which
       * half, which is the same reason the service refuses a bad field list whole.
       */
      const res = await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ code: 'SOMETHING', displayName: 'Ours' }).expect(400);

      expect(res.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('code')]));

      const shelf = await request(app.getHttpServer()).get(url).expect(200);
      const mapan = shelf.body.find((p: { code: string }) => p.code === 'PRUMAPAN');
      expect(mapan.displayName.overridden).toBe(false);
    });

    it('gives the sell decision back to the company when the body omits it', async () => {
      /*
       * `active: null` and *no* `active` are the same request, and both mean "follow the
       * company again" — which is not the same as writing the company's value today, because
       * the company may change it later. The controller's `?? null` is the whole of that.
       */
      await request(app.getHttpServer())
        .put(`${url}/${mapanId}/active`).send({ active: false }).expect(200);

      const back = await request(app.getHttpServer())
        .put(`${url}/${mapanId}/active`).send({}).expect(200);

      expect(back.body.active.overridden).toBe(false);
    });

    it('fills a document slot, signs a URL for it, and gives it back', async () => {
      /*
       * The three handlers no role test enters — a 403 stops at the guard — and the only ones
       * that need an upload to exist first. Without this the document half of the controller
       * was reachable by nothing.
       */
      const signed = await wired.assets.requestUpload(OWNER, {
        folder: 'products', filename: 'brochure.pdf', mimeType: 'application/pdf', bytes: 1024,
      });
      await wired.assets.confirmUpload(OWNER, signed.storageKey);

      const filled = await request(app.getHttpServer()).put(`${url}/${mapanId}/documents/brochure`)
        .send({ storageKey: signed.storageKey, label: 'Our brochure' }).expect(200);
      expect(filled.body.documents[0]).toMatchObject({ source: 'kpm', filename: 'Our brochure' });

      const url300 = await request(app.getHttpServer())
        .get(`${url}/${mapanId}/documents/brochure/url`).expect(200);
      expect(url300.body.url).toEqual(expect.any(String));

      const given = await request(app.getHttpServer())
        .delete(`${url}/${mapanId}/documents/brochure`).expect(200);
      expect(given.body.documents[0].source).toBe('none');
    });

    it('refuses a slot a product does not have', async () => {
      await request(app.getHttpServer())
        .delete(`${url}/${mapanId}/documents/poster`).expect(400);
    });

    it('resets a field over HTTP, and the row inherits again', async () => {
      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ displayName: 'Ours' }).expect(200);

      const res = await request(app.getHttpServer())
        .delete(`${url}/${mapanId}/overrides/displayName`).expect(200);

      expect(res.body.displayName.overridden).toBe(false);
    });
  });
});
