import mongoose from 'mongoose';
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
  ADMIN, EVERY_MEMBER, FIXTURE_KPM, NOT_ADMINISTRATORS, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { KpmProductController } from './kpm-product.controller';
import { KpmProductService } from './kpm-product.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { effectiveProposalWordsOf } from './proposal-fields';

const NOW = new Date('2026-11-05T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';
const KPM_B = '66f0000000000000000000b1';

/** KPM B's Owner: another office of the same company. */
const OWNER_B = new RequestContext('u-owner-b', 'none', {
  membershipId: 'mem-b', kpmId: KPM_B, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

const PLAN = {
  key: 'plan', label: 'Plan', type: 'chips', options: [{ label: 'Silver' }, { label: 'Gold' }], default: 'Gold',
  plan: true, showOnSummary: true,
};
const UP = { key: 'up', label: 'Uang pertanggungan', labelSyariah: 'Santunan asuransi', type: 'money', quickAmounts: [100_000_000_00] };
const PLANS = [
  { name: 'Silver', highlights: [{ label: 'Kamar', value: 'Rp 1 jt/hari' }] },
  { name: 'Gold', highlights: [{ label: 'Kamar', value: 'Rp 2 jt/hari' }], popular: true },
];
const FAQ = [{ question: 'Ada masa tunggu?', answer: 'Ya, 30 hari.\nKecuali kecelakaan.' }];
const DETAIL = [{
  block: 'manfaat', rows: [{ label: 'Meninggal dunia', formula: '200% × up' }],
  source: { file: 'Ilustrasi.pdf', page: 2, date: '2026-11-01' },
}];

/**
 * **P19.7-T1 AC-2, AC-3 — the catalogue's proposal fields over HTTP, and an office's FAQ and plan highlights**
 * (ADR-0225 §1, §2, §5): the Super Admin's `PATCH` with the DTO, the guard and the filter real; every other role
 * refused by the API; an office's two overrides held for approval with the script, read by agents only once approved,
 * and never across offices.
 */
describe('P19.7-T1 the proposal’s catalogue fields', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let productId: string;
  const url = `/admin/companies/${COMPANY}/products`;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
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
      { _id: COMPANY, name: 'Prudential', slug: 'prudential' },
      { _id: OTHER_COMPANY, name: 'Manulife', slug: 'manulife' },
    ]);
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.products.seedForCompany(COMPANY);
    await wired.products.seedForCompany(OTHER_COMPANY);
    productId = (await wired.products.list(COMPANY, { withCommission: true })).find((p) => p.code === 'PRUWELL_MEDICAL')!.id;
  });

  const api = () => request(app.getHttpServer());
  const patch = (body: Record<string, unknown>) => api().patch(`${url}/${productId}`).send(body);

  describe('P19.7-T1 AC-2, AC-3 the Super Admin writes them', () => {
    it('P19.7-T1 AC-3 saves fields, plans, FAQ, a detail block and the product’s own words, and reads them back', async () => {
      const res = await patch({
        proposalFields: [PLAN, UP], planOptions: PLANS, faq: FAQ, pdfDetail: DETAIL,
        syariahName: 'PRUWell Medical Syariah', defaultInsured: 'client', proposalTypeLabel: 'Kesehatan', expectedVersion: 1,
      }).expect(200);
      expect(res.body).toMatchObject({
        version: 2, syariahName: 'PRUWell Medical Syariah', defaultInsured: 'client', proposalTypeLabel: 'Kesehatan',
        proposalFields: [{ key: 'plan', default: 'Gold', plan: true, showOnPdf: true }, { key: 'up', type: 'money' }],
        planOptions: [{ name: 'Silver', popular: false }, { name: 'Gold', popular: true }],
        faq: FAQ,
        pdfDetail: [{ block: 'manfaat', rows: [{ formula: '200% × up' }], notGuaranteed: false }],
      });
      const list = await api().get(url).expect(200);
      expect(list.body.find((p: { id: string }) => p.id === productId).proposalFields).toHaveLength(2);
      // Every other product answers its empty proposal fields.
      expect(list.body.find((p: { code: string }) => p.code === 'PRUMAPAN')).toMatchObject({
        proposalFields: [], planOptions: [], faq: [], pdfDetail: [], syariahName: null, defaultInsured: null, proposalTypeLabel: null,
      });
    });

    it('P19.7-T1 AC-3 reorders by sending the list in its new order (↑ / ↓)', async () => {
      await patch({ proposalFields: [PLAN, UP] }).expect(200);
      const res = await patch({ proposalFields: [UP, PLAN] }).expect(200);
      expect(res.body.proposalFields.map((f: { key: string }) => f.key)).toEqual(['up', 'plan']);
    });

    it('P19.7-T1 AC-3 audits product.updated naming the fields changed', async () => {
      await patch({ proposalFields: [PLAN], faq: FAQ }).expect(200);
      const entry = await mongoose.connection.db!.collection('auditLog').findOne({ action: 'product.updated', targetId: productId });
      expect(Object.keys(entry!.after)).toEqual(expect.arrayContaining(['proposalFields', 'faq']));
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['nine fields', { proposalFields: Array.from({ length: 9 }, (_, i) => ({ ...UP, key: `m${i}` })) }, 'proposalFields'],
      ['a reserved key', { proposalFields: [{ ...UP, key: 'premium' }] }, 'proposalFields[0].key'],
      ['a chips default that is no option', { proposalFields: [{ ...PLAN, default: 'Diamond' }] }, 'proposalFields[0].default'],
      ['a plan card naming no plan option', { proposalFields: [PLAN], planOptions: [{ name: 'Diamond', highlights: [{ label: 'a', value: 'b' }] }] }, 'planOptions[0].name'],
      ['a formula naming another field', { proposalFields: [PLAN, UP], pdfDetail: [{ ...DETAIL[0], rows: [{ label: 'x', formula: '2 × santunan' }] }] }, 'pdfDetail[0].rows[0].formula'],
      ['a formula outside the grammar', { proposalFields: [UP], pdfDetail: [{ ...DETAIL[0], rows: [{ label: 'x', formula: 'process.exit()' }] }] }, 'pdfDetail[0].rows[0].formula'],
      ['21 FAQ entries', { faq: Array.from({ length: 21 }, () => FAQ[0]) }, 'faq'],
      ['a currency option the product does not sell', { proposalFields: [{ ...PLAN, plan: false, currency: true, key: 'mata_uang', options: [{ label: 'Dolar', currency: 'USD' }], default: 'Dolar' }] }, 'proposalFields[0].options[0].currency'],
    ])('P19.7-T1 AC-3 refuses %s: 400 VALIDATION_FAILED naming the path, nothing written', async (_case, body, field) => {
      const res = await patch(body).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field } });
      const stored = await mongoose.connection.db!.collection('products').findOne({ _id: new mongoose.Types.ObjectId(productId) });
      expect(stored).toMatchObject({ version: 1, proposalFields: [] });
    });

    it('P19.7-T1 AC-3 says the formula refusal in Indonesian: "`santunan` bukan kolom uang produk ini."', async () => {
      const res = await patch({ proposalFields: [UP], pdfDetail: [{ ...DETAIL[0], rows: [{ label: 'x', formula: '2 × santunan' }] }] })
        .set('Accept-Language', 'id').expect(400);
      expect(res.body.error.message).toBe('`santunan` bukan kolom uang produk ini.');
    });

    it('P19.7-T1 AC-3 refuses a syariahName left on a product moved to the syariah channel', async () => {
      await patch({ syariahName: 'PRUWell Medical Syariah' }).expect(200);
      const res = await patch({ channel: 'syariah' }).expect(400);
      expect(res.body.error.details).toEqual({ field: 'syariahName' });
    });

    it('P19.7-T1 AC-3 refuses a stale save with 409 VERSION_CONFLICT, before any rule', async () => {
      await patch({ faq: FAQ }).expect(200);
      const res = await patch({ proposalFields: [{ ...UP, key: 'premium' }], expectedVersion: 1 }).expect(409);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('P19.7-T1 AC-3 answers 404 for another company’s product, whatever the body', async () => {
      const theirs = (await wired.products.list(OTHER_COMPANY, { withCommission: true }))[0].id;
      await api().patch(`${url}/${theirs}`).send({ faq: FAQ }).expect(404);
    });

    it.each([...EVERY_MEMBER])('P19.7-T1 AC-3 refuses %s: no role but the Super Admin writes a product’s proposal fields', async (_who, ctx) => {
      session.current = ctx;
      await patch({ faq: FAQ }).expect(403);
    });

    it('P19.7-T1 AC-7 has no rate table and no premium calculation: a rateTable is an unknown field, 400', async () => {
      const res = await patch({ rateTable: [] }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/rateTable/);
    });
  });

  describe('P19.7-T1 AC-3 an office’s FAQ and plan highlights, approved with the script (ADR-0225 §5)', () => {
    const office = '/kpm/settings/products';
    beforeEach(async () => {
      await wired.products.update(SUPER_ADMIN, COMPANY, productId, { proposalFields: [PLAN, UP], planOptions: PLANS, faq: FAQ });
      session.current = OWNER;
    });
    const agentReads = async (ctx: RequestContext) => {
      const shelf = await wired.kpmProducts.shelfOf(ctx);
      const entry = shelf.entries.find((e) => String(e.product._id) === productId)!;
      return effectiveProposalWordsOf(entry.product, entry.approved);
    };
    const own = { faq: [{ question: 'Bisa dicicil?', answer: 'Bisa, bulanan.' }], planHighlights: { Gold: [{ label: 'Kamar', value: 'VIP' }] } };

    it.each([['the Owner', () => OWNER], ['the Admin', () => ADMIN]])('P19.7-T1 AC-3 lets %s write both, held pending', async (_who, who) => {
      session.current = who();
      const res = await api().patch(`${office}/${productId}/overrides`).send(own).expect(200);
      expect(res.body).toMatchObject({
        reviewState: 'pending',
        faq: { value: own.faq, overridden: true },
        plans: [
          { name: 'Silver', highlights: { value: PLANS[0].highlights, overridden: false } },
          { name: 'Gold', popular: true, highlights: { value: own.planHighlights.Gold, overridden: true } },
        ],
      });
    });

    it.each(NOT_ADMINISTRATORS)('P19.7-T1 AC-3 refuses %s: an office’s FAQ is its administrators’', async (_who, ctx) => {
      session.current = ctx;
      await api().patch(`${office}/${productId}/overrides`).send(own).expect(403);
    });

    it('P19.7-T1 AC-3 serves agents the company’s until approved, then the office’s; reset gives the company’s back', async () => {
      await api().patch(`${office}/${productId}/overrides`).send(own).expect(200);
      expect(await agentReads(OWNER)).toMatchObject({ faq: FAQ, source: 'company' });
      await api().post(`${office}/${productId}/script/approve`).send({}).expect(201);
      const approved = await agentReads(OWNER);
      expect(approved).toMatchObject({ faq: own.faq, source: 'kpm' });
      expect(approved.plans.find((p) => p.name === 'Gold')!.highlights).toEqual(own.planHighlights.Gold);
      // An edit after approval waits again, and agents keep the approved words meanwhile.
      await api().patch(`${office}/${productId}/overrides`).send({ faq: FAQ }).expect(200);
      expect((await agentReads(OWNER)).faq).toEqual(own.faq);
      await api().delete(`${office}/${productId}/overrides/faq`).expect(200);
      await api().delete(`${office}/${productId}/overrides/planHighlights`).expect(200);
      expect(await agentReads(OWNER)).toMatchObject({ faq: FAQ, source: 'company' });
    });

    it('P19.7-T1 AC-3 refuses a plan the company does not have, and an FAQ past its bounds, naming the path', async () => {
      const plan = await api().patch(`${office}/${productId}/overrides`).send({ planHighlights: { Diamond: [{ label: 'a', value: 'b' }] } }).expect(400);
      expect(plan.body.error.details).toEqual({ field: 'planHighlights.Diamond' });
      const faq = await api().patch(`${office}/${productId}/overrides`).send({ faq: [{ question: 'q', answer: 'x'.repeat(1001) }] }).expect(400);
      expect(faq.body.error.details).toEqual({ field: 'faq[0].answer' });
    });

    it('P19.7-T1 AC-3 ignores, on read, a plan the company has since removed', async () => {
      await api().patch(`${office}/${productId}/overrides`).send({ planHighlights: { Silver: [{ label: 'Kamar', value: 'Kelas 1' }] } }).expect(200);
      await api().post(`${office}/${productId}/script/approve`).send({}).expect(201);
      await wired.products.update(SUPER_ADMIN, COMPANY, productId, {
        proposalFields: [{ ...PLAN, options: [{ label: 'Gold' }] }, UP], planOptions: [PLANS[1]],
      });
      expect((await agentReads(OWNER)).plans.map((p) => p.name)).toEqual(['Gold']);
      const row = (await wired.kpmProducts.list(OWNER)).find((p) => p.productId === productId)!;
      expect(row.plans.map((p) => p.name)).toEqual(['Gold']);
    });

    it('P19.7-T1 AC-3 keeps one office’s FAQ from another: KPM B reads the company’s, and cannot approve A’s', async () => {
      await api().patch(`${office}/${productId}/overrides`).send(own).expect(200);
      await api().post(`${office}/${productId}/script/approve`).send({}).expect(201);
      expect(await agentReads(OWNER_B)).toMatchObject({ faq: FAQ, source: 'company' });
      const theirs = (await wired.kpmProducts.list(OWNER_B)).find((p) => p.productId === productId)!;
      expect(theirs.faq).toEqual({ value: FAQ, overridden: false });
      session.current = OWNER_B;
      const res = await api().post(`${office}/${productId}/script/approve`).send({});
      expect(res.status).toBe(400);
    });
  });
});
