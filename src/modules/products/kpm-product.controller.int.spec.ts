import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, declaredPermissions, FIXTURE_KPM, OWNER,
  productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { KpmProductController } from './kpm-product.controller';
import { KpmProductService } from './kpm-product.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-18T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const KPM_A = FIXTURE_KPM;

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  // The four reads carry the office's drafts and review state: the Owner's and the Admin's alone
  // (the Phase 14 exit review), never `tenant_config:read`, which every member holds.
  list: 'product_settings:read',
  setActive: 'tenant_config:write',
  saveOverrides: 'tenant_config:write',
  resetOverride: 'tenant_config:write',
  setDocument: 'tenant_config:write',
  resetDocument: 'tenant_config:write',
  documentUrl: 'product_settings:read',
  pendingReviews: 'product_settings:read',
  approveScript: 'sales_script:approve',
  rejectScript: 'sales_script:approve',
  effectiveScript: 'product_settings:read',
};

/** The Owner, in a Super Admin's **read-only** support session (roles §3.13). */
const READ_ONLY_OWNER = new RequestContext('u-owner', 'none', {
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never, 'root', null, false, true);

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
    await listenOnLoopback(app);
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

    it('P14 exit review: refuses the queue to a field member, with nothing of the draft in the answer', async () => {
      /*
       * The queue is the office's drafts — the words not yet approved, and a send-back's reason. It sat
       * on `tenant_config:read`, which every member holds, so an agent could read the Owner's
       * unapproved script here. A field member reads the approved words through `/product-catalog`.
       */
      await writeScript();

      for (const who of [AB, AAB, AGENT]) {
        session.current = who;
        const res = await request(app.getHttpServer()).get(`${url}/script-reviews`).expect(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
        expect(JSON.stringify(res.body)).not.toContain('Halo Pak, boleh saya cerita sebentar?');
        await request(app.getHttpServer())
          .post(`${url}/${mapanId}/script/approve`).send({}).expect(403);
      }
    });
  });

  describe('the office’s description over HTTP (OD-136, ADR-0120)', () => {
    const TAGLINE = 'Endowment-style life with guaranteed retirement payouts from age 55.';

    it.each([['the Owner', () => OWNER], ['the Admin', () => ADMIN]])(
      'lets %s write it, trimmed, and it waits for approval', async (_name, who) => {
        session.current = who();

        const res = await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
          .send({ description: '  Pensiun tenang dari usia 55.  ' }).expect(200);

        expect(res.body.description).toEqual({ value: 'Pensiun tenang dari usia 55.', overridden: true });
        expect(res.body.reviewState).toBe('pending');
        // Only the field sent: nothing else became the office's on the way through the pipe.
        expect(res.body.displayName.overridden).toBe(false);
        expect(Object.values(res.body.script as Record<string, { overridden: boolean }>)
          .some((f) => f.overridden)).toBe(false);

        const served = await request(app.getHttpServer())
          .get(`${url}/${mapanId}/script/effective`).expect(200);
        expect(served.body).toMatchObject({ source: 'company', description: TAGLINE });
      },
    );

    it.each([
      ['an AB', () => AB], ['an AAB', () => AAB], ['an agent', () => AGENT],
      ['a Super Admin', () => SUPER_ADMIN],
    ])('refuses %s, and writes nothing', async (_name, who) => {
      session.current = who();

      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ description: 'Kalimat kami.' }).expect(403);
      await request(app.getHttpServer())
        .delete(`${url}/${mapanId}/overrides/description`).expect(403);

      session.current = OWNER;
      const shelf = await request(app.getHttpServer()).get(url).expect(200);
      const mapan = shelf.body.find((p: { code: string }) => p.code === 'PRUMAPAN');
      expect(mapan.description).toEqual({ value: TAGLINE, overridden: false });
    });

    it('refuses one longer than the company’s tagline may be, and one that is not text', async () => {
      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ description: 'x'.repeat(301) }).expect(400);
      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ description: 42 }).expect(400);
      // The bound is on the trimmed sentence: padding does not count against it.
      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ description: ` ${'x'.repeat(300)} ` }).expect(200);
    });

    it('serves the approved one to the effective read, and gives it back on null', async () => {
      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ description: 'Pensiun tenang.' }).expect(200);
      await request(app.getHttpServer()).post(`${url}/${mapanId}/script/approve`).send({}).expect(201);

      const approved = await request(app.getHttpServer())
        .get(`${url}/${mapanId}/script/effective`).expect(200);
      expect(approved.body).toMatchObject({ source: 'kpm', description: 'Pensiun tenang.' });

      const back = await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ description: null }).expect(200);
      expect(back.body.description).toEqual({ value: TAGLINE, overridden: false });

      const served = await request(app.getHttpServer())
        .get(`${url}/${mapanId}/script/effective`).expect(200);
      expect(served.body.description).toBe(TAGLINE);
    });

    it('lists a pending description on the review queue', async () => {
      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ description: 'Pensiun tenang.' }).expect(200);

      const queue = await request(app.getHttpServer()).get(`${url}/script-reviews`).expect(200);

      expect(queue.body.map((p: { code: string; description: { value: string } }) =>
        [p.code, p.description.value])).toEqual([['PRUMAPAN', 'Pensiun tenang.']]);
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

    it.each([['the Owner', () => OWNER], ['the Admin', () => ADMIN], ['a read-only support session as the Owner', () => READ_ONLY_OWNER]])(
      'lets %s read the shelf, the queue and what agents are served', async (_name, who) => {
        await writeScript();
        session.current = who();

        const shelf = await request(app.getHttpServer()).get(url).expect(200);
        expect(shelf.body).toHaveLength(31);
        await request(app.getHttpServer()).get(`${url}/script-reviews`).expect(200);
        await request(app.getHttpServer()).get(`${url}/${mapanId}/script/effective`).expect(200);
      },
    );

    it.each([['an AB', () => AB], ['an AAB', () => AAB], ['an agent', () => AGENT]])(
      'P14 exit review: refuses %s all four settings reads, and nothing of the office’s drafts is in the answer', async (_name, who) => {
        /*
         * The settings reads carry `overrides`, the review state and a rejection's reason — what
         * ADR-0037 keeps from agents. They were `tenant_config:read`, every member's, so a field
         * member could read a draft the Owner had not approved. They are `product_settings:read` now.
         */
        await writeScript();
        await wired.kpmProducts.rejectScript(OWNER, mapanId, 'Terlalu menjanjikan.');
        session.current = who();

        for (const path of [
          url, `${url}/script-reviews`, `${url}/${mapanId}/script/effective`, `${url}/${mapanId}/documents/brochure/url`,
        ]) {
          const res = await request(app.getHttpServer()).get(path);
          expect([path, res.status, res.body.error?.code]).toEqual([path, 403, 'PERM_DENIED']);
          const body = JSON.stringify(res.body);
          for (const leaked of ['Halo Pak, boleh saya cerita sebentar?', 'Terlalu menjanjikan.', 'reviewState', 'overrides']) {
            expect([path, body.includes(leaked)]).toEqual([path, false]);
          }
        }
      },
    );

    it('answers a Super Admin 404 rather than 403, because they are in no office', async () => {
      /*
       * They hold `product_settings:read` at `all`, so the guard lets them through — and then
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

    it('writes only the field sent, so renaming a product leaves its script the company’s', async () => {
      /*
       * Regression, found by OD-136's tests (2026-10-08): the pipe hands over a DTO with every
       * declared field an own key, `undefined` where the body had none, and the service wrote each
       * as `''` — so *Save the name* made all seven script lines the office's, blank, and the row
       * pending. Every earlier test of this route called the service, or sent a body it refused.
       */
      const res = await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`)
        .send({ displayName: 'Mapan kami' }).expect(200);

      expect(res.body.displayName).toEqual({ value: 'Mapan kami', overridden: true });
      expect(res.body.description.overridden).toBe(false);
      for (const field of Object.values(res.body.script as Record<string, { overridden: boolean }>)) {
        expect(field.overridden).toBe(false);
      }
      expect(res.body.reviewState).toBe('none');
    });

    it('refuses a body with nothing in it', async () => {
      await request(app.getHttpServer()).patch(`${url}/${mapanId}/overrides`).send({}).expect(400);
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
