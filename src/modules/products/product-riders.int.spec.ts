import mongoose from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { PRODUCT_OBJECTIONS_MAX } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { KpmProductController } from './kpm-product.controller';
import { KpmProductService } from './kpm-product.service';
import { ProductCatalogService } from './product-catalog.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

const NOW = new Date('2026-11-05T02:00:00Z');
const SEQUIS = '66f0000000000000000000c1';
const MANULIFE = '66f0000000000000000000c2';
const KPM_A = FIXTURE_KPM;
const KPM_B = '66f0000000000000000000b1';
const KPM_MANULIFE = '66f0000000000000000000b2';

/** A member of another office of the same company, and of an office of another company. */
const memberOf = (kpmId: string, membershipId: string) => new RequestContext(`u-${membershipId}`, 'none', {
  membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
const OWNER_B = memberOf(KPM_B, 'mem-owner-b');
const OWNER_MANULIFE = memberOf(KPM_MANULIFE, 'mem-owner-m');
/** A Super Admin viewing as the Owner (*Hanya melihat*): the member's context, read-only (roles §3.13). */
const VIEW_AS_OWNER = new RequestContext('u-owner', 'none', {
  membershipId: 'mem-a', kpmId: KPM_A, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never, 'root', null, false, true);

/**
 * **P19.4-T4 — products: a base or a rider, its currencies, its objection cards, and a withdrawn one deleted**
 * (ADR-0209; the riders spec's rules 1 to 6, the data model and *Done when*; the handover's B1-1, B1-3, B1-4, B1-5).
 *
 * Over HTTP for the Super Admin's company routes and an office's settings — the real DTO pipe, the permissions guard
 * and the error filter — and over the real services for the agents' reads, on a real database.
 */
describe('P19.4-T4 products: riders, currencies, objections, delete (ADR-0209)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let catalog: ProductCatalogService;
  const ids: Record<string, string> = {};
  const url = `/admin/companies/${SEQUIS}/products`;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    catalog = new ProductCatalogService(wired.kpmProducts, wired.clock);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductController, KpmProductController],
      providers: [
        { provide: ProductService, useValue: wired.products },
        { provide: KpmProductService, useValue: wired.kpmProducts },
      ],
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
    session.current = SUPER_ADMIN;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: SEQUIS, name: 'Sequis', slug: 'sequis' },
      { _id: MANULIFE, name: 'Manulife', slug: 'manulife' },
    ]);
    const office = (_id: string, companyId: string, code: string) =>
      ({ _id, companyId, code, branchName: code, timezone: 'Asia/Jakarta' });
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      office(KPM_A, SEQUIS, '0417'), office(KPM_B, SEQUIS, '0555'), office(KPM_MANULIFE, MANULIFE, '0999'),
    ]);
    // Two companies with the same codes: an id of the other one is the probe.
    await wired.products.seedForCompany(SEQUIS);
    await wired.products.seedForCompany(MANULIFE);
    for (const p of await wired.products.list(SEQUIS, { withCommission: false })) ids[p.code] = p.id;
  });

  const byCode = async (code: string, companyId = SEQUIS) =>
    (await wired.products.list(companyId, { withCommission: true })).find((p) => p.code === code)!;
  /** A rider added through the route, as the Super Admin adds one. */
  const addRider = (attachesTo: string[], code = 'CI_COVERAGE_PLUS') => api().post(url).send({
    code, name: 'CI Coverage+ Insurance', channel: 'conventional', category: 'ci', kind: 'rider', attachesTo,
  });

  describe('AC-3 every product a base, attached to nothing (rule 1, the data model)', () => {
    it('P19.4-T4 AC-3 reads every seeded product as a base with no attachments, sold in IDR', async () => {
      const shelf = await wired.products.list(SEQUIS, { withCommission: false });
      expect(shelf.every((p) => p.kind === 'base' && p.attachesTo.length === 0)).toBe(true);
      expect(shelf.every((p) => p.currencies.join() === 'IDR')).toBe(true);
    });

    it('P19.4-T4 AC-3 adds a product as a base unless it says otherwise', async () => {
      const res = await api().post(url).send({ code: 'NEW_ONE', name: 'Baru', channel: 'syariah', category: 'life' })
        .expect(201);
      expect(res.body).toMatchObject({ kind: 'base', attachesTo: [], currencies: ['IDR'] });
    });
  });

  describe('AC-4 a rider attaches to at least one active base of its company (rule 2)', () => {
    it('P19.4-T4 AC-10 saves CI Coverage+ as a rider on SOFI (here PRUCritical Benefit 88)', async () => {
      const res = await addRider([ids.PRUCRITICAL_BENEFIT_88]).expect(201);
      expect(res.body).toMatchObject({ kind: 'rider', attachesTo: [ids.PRUCRITICAL_BENEFIT_88], category: 'ci' });
    });

    it('P19.4-T4 AC-4 refuses a rider with no base: "Pilih minimal satu produk dasar", on attachesTo', async () => {
      const res = await addRider([]).set('Accept-Language', 'id').expect(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', message: 'Pilih minimal satu produk dasar', details: { field: 'attachesTo' },
      });
      expect((await addRider([]).expect(400)).body.error.message).toBe('Choose at least one base product.');
      // Nothing was written.
      expect(await byCode('CI_COVERAGE_PLUS')).toBeUndefined();
    });

    it('P19.4-T4 AC-4 refuses a rider on a rider: no chains', async () => {
      await addRider([ids.PRUCRITICAL_BENEFIT_88]).expect(201);
      const rider = await byCode('CI_COVERAGE_PLUS');
      const res = await addRider([rider.id], 'SECOND_RIDER').expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'attachesTo' } });
      expect(res.body.error.message).toContain('is a rider');
    });

    it('P19.4-T4 AC-4 refuses another company’s id, naming nothing of that company', async () => {
      const theirs = (await byCode('PRUCRITICAL_BENEFIT_88', MANULIFE)).id;
      const res = await addRider([theirs]).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'attachesTo' } });
      expect(res.body.error.message).not.toContain('PRUCritical');
      // A malformed id is the same answer.
      await addRider(['not-an-id']).expect(400);
    });

    it('P19.4-T4 AC-4 refuses a base that is not on sale', async () => {
      await api().post(`${url}/${ids.PRULADY}/close-to-new-business`).send({}).expect(201);
      const res = await addRider([ids.PRULADY]).expect(400);
      expect(res.body.error.message).toContain('not on sale');
    });

    it('P19.4-T4 AC-4 refuses a base that names bases, and a rider its own base', async () => {
      await api().patch(`${url}/${ids.PRUMAPAN}`).send({ attachesTo: [ids.PRULADY] }).expect(400);
      await api().patch(`${url}/${ids.PRUMAPAN}`)
        .send({ kind: 'rider', attachesTo: [ids.PRUMAPAN] }).expect(400);
    });

    it('P19.4-T4 AC-4 a base with riders cannot become a rider, and a rider still attached cannot become a base', async () => {
      await addRider([ids.PRUCRITICAL_BENEFIT_88]).expect(201);
      const rider = await byCode('CI_COVERAGE_PLUS');

      const base = await api().patch(`${url}/${ids.PRUCRITICAL_BENEFIT_88}`)
        .send({ kind: 'rider', attachesTo: [ids.PRULADY] }).expect(409);
      expect(base.body.error).toMatchObject({ code: 'PRODUCT_KIND_IN_USE', details: { riders: 1 } });

      const stillAttached = await api().patch(`${url}/${rider.id}`).send({ kind: 'base' }).expect(409);
      expect(stillAttached.body.error).toMatchObject({ code: 'PRODUCT_KIND_IN_USE', details: { bases: 1 } });

      // Cleared in the same change, it becomes a base.
      const cleared = await api().patch(`${url}/${rider.id}`).send({ kind: 'base', attachesTo: [] }).expect(200);
      expect(cleared.body).toMatchObject({ kind: 'base', attachesTo: [] });
    });

    it('P19.4-T4 AC-15 the 409 on a stale save covers the new fields', async () => {
      const product = await byCode('PRUMAPAN');
      await api().patch(`${url}/${product.id}`).send({ currencies: ['USD'], expectedVersion: product.version })
        .expect(200);
      const stale = await api().patch(`${url}/${product.id}`)
        .send({ kind: 'rider', attachesTo: [ids.PRULADY], expectedVersion: product.version }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT' });
      const staleCards = await api().patch(`${url}/${product.id}`).send({
        defaultAttackPlan: { ...product.defaultAttackPlan, objections: [] }, expectedVersion: product.version,
      }).expect(409);
      expect(staleCards.body.error.code).toBe('VERSION_CONFLICT');
      expect((await byCode('PRUMAPAN')).kind).toBe('base');
    });
  });

  describe('AC-5 agents meet a rider only inside a base (rule 3)', () => {
    beforeEach(async () => {
      await addRider([ids.PRUCRITICAL_BENEFIT_88, ids.PRULADY]).expect(201);
    });
    const agentOf = (kpmId: string) => new RequestContext(`u-agent-${kpmId}`, 'none', {
      membershipId: `mem-agent-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 0,
    } as never);

    it('P19.4-T4 AC-10 hides the rider from the list and shows it inside its base as "Bisa ditambah"', async () => {
      const { products } = await catalog.catalog(agentOf(KPM_A));
      expect(products.map((p) => p.code)).not.toContain('CI_COVERAGE_PLUS');
      const base = await catalog.product(agentOf(KPM_A), 'PRUCRITICAL_BENEFIT_88');
      expect(base.riders).toEqual([{ code: 'CI_COVERAGE_PLUS', name: 'CI Coverage+ Insurance' }]);
      // A base with no rider says none.
      expect((await catalog.product(agentOf(KPM_A), 'PRUMAPAN')).riders).toEqual([]);
    });

    it('P19.4-T4 AC-5 answers a rider’s own address 404: never offered alone', async () => {
      await expect(catalog.product(agentOf(KPM_A), 'CI_COVERAGE_PLUS')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P19.4-T4 AC-5 never recommends a rider, and lists it under its base in the plan', async () => {
      const plan = await catalog.attackPlan(agentOf(KPM_A), { need: 'ci', age: 2, budget: 3 });
      expect(plan.product!.code).not.toBe('CI_COVERAGE_PLUS');
      expect(plan.alternatives.map((a) => a.code)).not.toContain('CI_COVERAGE_PLUS');
      await expect(catalog.attackPlan(agentOf(KPM_A), { need: 'ci', age: 2, budget: 3 }, 'CI_COVERAGE_PLUS'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      const onBase = await catalog.attackPlan(agentOf(KPM_A), { need: 'ci', age: 2, budget: 3 }, 'PRULADY');
      expect(onBase.product!.riders.map((r) => r.code)).toEqual(['CI_COVERAGE_PLUS']);
    });

    it('P19.4-T4 AC-3 nothing changes for agents but the rider itself: the shelf before and after', async () => {
      const before = (await catalog.catalog(agentOf(KPM_B))).products.map((p) => p.code);
      await api().delete(`${url}/${(await byCode('CI_COVERAGE_PLUS')).id}`).expect(400);
      const after = (await catalog.catalog(agentOf(KPM_B))).products.map((p) => p.code);
      expect(after).toEqual(before);
      expect(after).toHaveLength(31 - 2); // the two run-off products no office turned on
    });
  });

  describe('AC-6 withdrawing a base detaches it (rule 4)', () => {
    it('P19.4-T4 AC-10 withdrawing SOFI leaves CI Coverage+ hidden, attached to nothing, audited base_withdrawn', async () => {
      await addRider([ids.PRUCRITICAL_BENEFIT_88]).expect(201);
      const rider = await byCode('CI_COVERAGE_PLUS');

      await api().post(`${url}/${ids.PRUCRITICAL_BENEFIT_88}/withdraw`).send({}).expect(201);

      const after = await byCode('CI_COVERAGE_PLUS');
      expect(after).toMatchObject({ kind: 'rider', attachesTo: [], version: rider.version + 1 });
      const row = await mongoose.connection.db!.collection('auditLog')
        .findOne({ action: 'product.updated', targetId: rider.id, 'after.reason': 'base_withdrawn' });
      expect(row).toMatchObject({ before: { attachesTo: [ids.PRUCRITICAL_BENEFIT_88] }, after: { attachesTo: [] } });

      // Seen by no agent, on no shelf: no base offers it.
      const agent = new RequestContext('u-agent', 'none', {
        membershipId: 'mem-agent', kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      } as never);
      const shelf = await catalog.catalog(agent);
      expect(shelf.products.map((p) => p.code)).not.toContain('CI_COVERAGE_PLUS');
      // Putting the base back does not re-attach it.
      await api().post(`${url}/${ids.PRUCRITICAL_BENEFIT_88}/reopen`).expect(201);
      expect((await byCode('CI_COVERAGE_PLUS')).attachesTo).toEqual([]);
      expect((await catalog.product(agent, 'PRUCRITICAL_BENEFIT_88')).riders).toEqual([]);
    });

    it('P19.4-T4 AC-6 keeps a rider’s other bases when one is withdrawn', async () => {
      await addRider([ids.PRUCRITICAL_BENEFIT_88, ids.PRULADY]).expect(201);
      await api().post(`${url}/${ids.PRULADY}/withdraw`).send({}).expect(201);
      expect((await byCode('CI_COVERAGE_PLUS')).attachesTo).toEqual([ids.PRUCRITICAL_BENEFIT_88]);
    });
  });

  describe('AC-7 no product training module for a rider (rule 5)', () => {
    it('P19.4-T4 AC-7 makes no training module for a product, a rider or a base: modules name no product', async () => {
      await addRider([ids.PRUCRITICAL_BENEFIT_88]).expect(201);
      const db = mongoose.connection.db!;
      expect(await db.collection('trainingModules').countDocuments({})).toBe(0);
      expect(await db.collection('trainingModules').countDocuments({ productId: { $exists: true } })).toBe(0);
    });
  });

  describe('AC-8 a KPM switches a rider only with its base (rule 6)', () => {
    beforeEach(async () => {
      await addRider([ids.PRUCRITICAL_BENEFIT_88, ids.PRULADY]).expect(201);
      session.current = OWNER;
    });
    const riderRow = async () => (await api().get('/kpm/settings/products').expect(200)).body
      .find((p: { code: string }) => p.code === 'CI_COVERAGE_PLUS');

    it('P19.4-T4 AC-8 lists the rider with its bases and on exactly when one of them is, deciding nothing itself', async () => {
      expect(await riderRow()).toMatchObject({
        kind: 'rider', attachesTo: [ids.PRUCRITICAL_BENEFIT_88, ids.PRULADY],
        active: { value: true, overridden: false },
      });
      await api().put(`/kpm/settings/products/${ids.PRUCRITICAL_BENEFIT_88}/active`).send({ active: false }).expect(200);
      expect((await riderRow()).active).toEqual({ value: true, overridden: false });
      await api().put(`/kpm/settings/products/${ids.PRULADY}/active`).send({ active: false }).expect(200);
      expect((await riderRow()).active).toEqual({ value: false, overridden: false });
      // Nothing was stored for the rider.
      const rider = await byCode('CI_COVERAGE_PLUS');
      expect(await mongoose.connection.db!.collection('kpmProductConfigs').countDocuments({ productId: rider.id }))
        .toBe(0);
    });

    it('P19.4-T4 AC-8 refuses an office’s write about a rider: 409 PRODUCT_IS_RIDER', async () => {
      const rider = await byCode('CI_COVERAGE_PLUS');
      const base = `/kpm/settings/products/${rider.id}`;
      for (const call of [
        () => api().put(`${base}/active`).send({ active: true }),
        () => api().patch(`${base}/overrides`).send({ displayName: 'CI+' }),
        () => api().delete(`${base}/overrides/displayName`),
        () => api().delete(`${base}/documents/brochure`),
      ]) {
        const res = await call().expect(409);
        expect(res.body.error).toMatchObject({ code: 'PRODUCT_IS_RIDER', details: { productId: rider.id } });
      }
    });

    it('P19.4-T4 AC-8 answers a rider of another company 404 to an office, never 409', async () => {
      session.current = OWNER_MANULIFE;
      const rider = await byCode('CI_COVERAGE_PLUS');
      await api().put(`/kpm/settings/products/${rider.id}/active`).send({ active: true }).expect(404);
      const theirs = (await api().get('/kpm/settings/products').expect(200)).body as { code: string }[];
      expect(theirs.map((p) => p.code)).not.toContain('CI_COVERAGE_PLUS');
    });

    it('P19.4-T4 AC-8 derives the rider per office: one office’s switch is not another’s', async () => {
      await api().put(`/kpm/settings/products/${ids.PRUCRITICAL_BENEFIT_88}/active`).send({ active: false }).expect(200);
      await api().put(`/kpm/settings/products/${ids.PRULADY}/active`).send({ active: false }).expect(200);
      session.current = OWNER_B;
      expect((await riderRow()).active).toEqual({ value: true, overridden: false });
    });
  });

  describe('AC-1 objection cards (B1-1)', () => {
    it('P19.4-T4 AC-1 stores every card in order, each side with its lines, and serves every pair to agents', async () => {
      const product = await byCode('PRUMAPAN');
      const objections = [
        { objection: 'Preminya mahal.', answer: 'Mulai Rp 200 rb.\nBisa dicicil.' },
        { objection: 'Nanti saja.', answer: 'Makin awal, makin ringan.' },
        { objection: 'Saya sudah punya.', answer: 'Yang kantor berhenti saat Bapak pindah.' },
      ];
      const res = await api().patch(`${url}/${product.id}`)
        .send({ defaultAttackPlan: { ...product.defaultAttackPlan, objections } }).expect(200);
      expect(res.body.defaultAttackPlan.objections).toEqual(objections);

      const agent = new RequestContext('u-agent', 'none', {
        membershipId: 'mem-agent', kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      } as never);
      expect((await catalog.product(agent, 'PRUMAPAN')).script.objections).toEqual(objections);
    });

    it(`P19.4-T4 AC-1 refuses more than ${PRODUCT_OBJECTIONS_MAX} cards, and the old pair’s fields`, async () => {
      const product = await byCode('PRUMAPAN');
      const many = Array.from({ length: PRODUCT_OBJECTIONS_MAX + 1 }, (_, i) => ({ objection: `O${i}`, answer: 'A' }));
      await api().patch(`${url}/${product.id}`)
        .send({ defaultAttackPlan: { ...product.defaultAttackPlan, objections: many } }).expect(400);
      await api().patch(`${url}/${product.id}`).send({
        defaultAttackPlan: { ...product.defaultAttackPlan, objectionTheySay: 'x', objectionYouSay: 'y' },
      }).expect(400);
    });

    it('P19.4-T4 AC-1 an office overrides the whole list, held for approval, and its agents read it once approved', async () => {
      session.current = OWNER;
      const mine = [{ objection: 'Mahal.', answer: 'Bisa disesuaikan.' }];
      const saved = await api().patch(`/kpm/settings/products/${ids.PRUMAPAN}/overrides`)
        .send({ objections: mine }).expect(200);
      expect(saved.body.script.objections).toEqual({ value: mine, overridden: true });
      expect(saved.body.reviewState).toBe('pending');
      await api().post(`/kpm/settings/products/${ids.PRUMAPAN}/script/approve`).expect(201);
      const effective = await wired.kpmProducts.effectiveScript(OWNER, ids.PRUMAPAN);
      expect(effective.script.objections).toEqual(mine);
    });
  });

  describe('AC-12 currencies (B1-4)', () => {
    it('P19.4-T4 AC-12 names IDR, USD or both, stored IDR first, and shows them on the agent’s card', async () => {
      const res = await api().patch(`${url}/${ids.PRUMAPAN}`).send({ currencies: ['USD', 'IDR'] }).expect(200);
      expect(res.body.currencies).toEqual(['IDR', 'USD']);
      const agent = new RequestContext('u-agent', 'none', {
        membershipId: 'mem-agent', kpmId: KPM_A, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 0,
      } as never);
      const card = (await catalog.catalog(agent)).products.find((p) => p.code === 'PRUMAPAN')!;
      expect(card.currencies).toEqual(['IDR', 'USD']);
    });

    it.each([[[]], [['IDR', 'IDR']], [['EUR']]])('P19.4-T4 AC-12 refuses %j', async (currencies) => {
      await api().patch(`${url}/${ids.PRUMAPAN}`).send({ currencies }).expect(400);
    });
  });

  describe('AC-13 a withdrawn product nothing references is deleted, softly (B1-5, OD-264)', () => {
    it('P19.4-T4 AC-13 deletes a withdrawn product: gone from every list, audited, its code never reused', async () => {
      await api().post(`${url}/${ids.PRULADY}/withdraw`).send({}).expect(201);
      await api().delete(`${url}/${ids.PRULADY}`).expect(204);

      expect(await byCode('PRULADY')).toBeUndefined();
      const row = await mongoose.connection.db!.collection('products')
        .findOne({ _id: new mongoose.Types.ObjectId(ids.PRULADY) });
      expect(row!.deletedAt).toEqual(NOW);
      expect(await mongoose.connection.db!.collection('auditLog')
        .countDocuments({ action: 'product.deleted', targetId: ids.PRULADY })).toBe(1);
      // Its code is never reused.
      const again = await api().post(url).send({ code: 'PRULADY', name: 'X', channel: 'conventional', category: 'ci' })
        .expect(400);
      expect(again.body.error.message).toContain('PRULADY');
      // A second delete finds nothing.
      await api().delete(`${url}/${ids.PRULADY}`).expect(404);
    });

    it('P19.4-T4 AC-13 refuses a product an office sells or scripted, naming the kinds and counts', async () => {
      await wired.kpmProducts.setActive(OWNER, ids.PRULADY, true);
      await wired.kpmProducts.saveOverrides(OWNER_B, ids.PRULADY, { opening: 'Halo' });
      await api().post(`${url}/${ids.PRULADY}/withdraw`).send({}).expect(201);

      const res = await api().delete(`${url}/${ids.PRULADY}`).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'PRODUCT_IN_USE', details: { references: { activations: 1, scriptApprovals: 1, riders: 0 } },
      });
      expect(res.body.error.message).toContain('1 KPM sells it');
      expect(await byCode('PRULADY')).toBeDefined();
    });

    it('P19.4-T4 AC-13 refuses a withdrawn product a rider still names', async () => {
      // A rider attached before the rule existed: the detach is what keeps this rare, the refusal what makes it safe.
      await addRider([ids.PRULADY]).expect(201);
      await mongoose.connection.db!.collection('products').updateOne(
        { _id: new mongoose.Types.ObjectId(ids.PRULADY) }, { $set: { lifecycle: 'withdrawn' } },
      );
      const res = await api().delete(`${url}/${ids.PRULADY}`).expect(409);
      expect(res.body.error.details.references).toEqual({ activations: 0, scriptApprovals: 0, riders: 1 });
    });

    it('P19.4-T4 AC-13 answers another company’s product 404', async () => {
      const theirs = (await byCode('PRULADY', MANULIFE)).id;
      await api().delete(`${url}/${theirs}`).expect(404);
      await api().delete(`${url}/not-an-id`).expect(404);
    });
  });

  describe('AC-15 permissions', () => {
    it.each([
      ['an Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an agent', AGENT],
      ['a view-as session', VIEW_AS_OWNER],
    ])('P19.4-T4 AC-15 refuses %s every company product write, the new ones included', async (_who, ctx) => {
      session.current = ctx;
      await api().post(url).send({
        code: 'CI_COVERAGE_PLUS', name: 'CI+', channel: 'conventional', category: 'ci', kind: 'rider',
        attachesTo: [ids.PRUMAPAN],
      }).expect(403);
      await api().patch(`${url}/${ids.PRUMAPAN}`).send({ currencies: ['USD'] }).expect(403);
      await api().delete(`${url}/${ids.PRUMAPAN}`).expect(403);
      await api().get(url).expect(403);
    });

    it('P19.4-T4 AC-15 allows the Super Admin, and answers another company’s product 404', async () => {
      await api().get(url).expect(200);
      const theirs = (await byCode('PRUMAPAN', MANULIFE)).id;
      await api().patch(`${url}/${theirs}`).send({ currencies: ['USD'] }).expect(404);
      await api().patch(`${url}/${theirs}`).send({ kind: 'rider', attachesTo: [ids.PRULADY] }).expect(404);
    });
  });
});
