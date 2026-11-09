import mongoose from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { EVERY_MEMBER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { IN_INDONESIAN } from '../../../test/i18n';
import { listenOnLoopback } from '../../../test/listen';
import { ProductCatalogService } from './product-catalog.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

const NOW = new Date('2026-11-04T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';
const KPM = '66f0000000000000000000a1';

/** A field member of the office, reading the catalog in the API's English. */
const agent = new RequestContext('u-agent', 'none', {
  membershipId: 'mem-agent', kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never).withReader(SOURCE_READER);
const owner = new RequestContext('u-owner', 'none', {
  membershipId: 'mem-owner', kpmId: KPM, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never).withReader(SOURCE_READER);

/** Objections as the owner's team typed them on production, one per line (the 11-03 handover's B1-1, B1-2). */
const THEY_SAY = '1. "Preminya mahal"\r\n2. "Saya sudah punya asuransi kantor"';
const YOU_SAY = '1. Mulai Rp 300 rb sebulan.\n\n2. Asuransi kantor berhenti saat Bapak pindah kerja.';

/**
 * **A company's product keeps the words as typed, and a stale save is refused** (P19-T6 AC-1, AC-2; the 11-03 handover's
 * B1-2 and B1-10). Over HTTP for the Super Admin's writes — the DTO, the guard and the error filter real — and through
 * the services for what an office's Owner writes and an agent reads, over a real database.
 */
describe('a product’s words and its version (P19-T6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let catalog: ProductCatalogService;
  const url = `/admin/companies/${COMPANY}/products`;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    catalog = new ProductCatalogService(wired.kpmProducts, wired.clock);
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
    session.current = SUPER_ADMIN;
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: COMPANY, name: 'Prudential', slug: 'prudential' },
      { _id: OTHER_COMPANY, name: 'Manulife', slug: 'manulife' },
    ]);
    await mongoose.model(Kpm.name, KpmSchema).create({
      _id: KPM, companyId: COMPANY, code: '0417', branchName: '0417', timezone: 'Asia/Jakarta',
    });
    await wired.products.seedForCompany(COMPANY);
  });

  const api = () => request(app.getHttpServer());
  /** A product every office of the company sells before its Owner has an opinion, so the agent reads it. */
  const sold = async () => (await wired.products.list(COMPANY, { withCommission: true })).find((p) => p.activeByDefault)!;
  const planOf = (product: { defaultAttackPlan: object }, over: Record<string, unknown>) =>
    ({ ...product.defaultAttackPlan, ...over });

  describe('AC-1: line breaks are kept', () => {
    it('P19-T6 AC-1 keeps the line breaks typed in the objections and every text field of the plan, LF only', async () => {
      const product = await sold();
      const res = await api().patch(`${url}/${product.id}`).send({
        defaultAttackPlan: planOf(product, {
          opening: 'Halo Pak,\nboleh minta waktunya?',
          fullScript: 'Paragraf satu.\n\n\n\nParagraf dua.',
          // One objection card since P19.4-T4 (ADR-0209 §9): each side keeps its lines.
          objections: [{ objection: THEY_SAY, answer: YOU_SAY }],
          nextAction: 'Kirim ilustrasi.\nJadwalkan temu kedua.',
        }),
        differentiator: 'Premi tetap.\nUang kembali di akhir.',
      }).expect(200);

      expect(res.body.defaultAttackPlan).toMatchObject({
        opening: 'Halo Pak,\nboleh minta waktunya?',
        // At most one blank line between paragraphs.
        fullScript: 'Paragraf satu.\n\nParagraf dua.',
        objections: [{ objection: '1. "Preminya mahal"\n2. "Saya sudah punya asuransi kantor"', answer: YOU_SAY }],
        nextAction: 'Kirim ilustrasi.\nJadwalkan temu kedua.',
      });
      expect(res.body.differentiator).toBe('Premi tetap.\nUang kembali di akhir.');
      // Read back as stored, not only as answered.
      const [stored] = (await wired.products.list(COMPANY, { withCommission: true })).filter((p) => p.id === product.id);
      expect(stored.defaultAttackPlan.objections[0].answer).toBe(YOU_SAY);
    });

    it('P19-T6 AC-1 shows them to the agent: the catalog and the plan read the lines as stored', async () => {
      const product = await sold();
      await api().patch(`${url}/${product.id}`).send({
        defaultAttackPlan: planOf(product, { objections: [{ objection: THEY_SAY, answer: YOU_SAY }] }),
      }).expect(200);

      const read = await catalog.product(agent, product.code);
      expect(read.script.objections).toEqual([
        { objection: '1. "Preminya mahal"\n2. "Saya sudah punya asuransi kantor"', answer: YOU_SAY },
      ]);
    });

    it('P19-T6 AC-1 keeps each line of Manfaat as its own benefit, and one-line fields on one line', async () => {
      const product = await sold();
      const res = await api().patch(`${url}/${product.id}`).send({
        name: 'PRUMapan\nPlus',
        tagline: 'Proteksi\r\njiwa',
        bestFor: 'Keluarga\nmuda',
        benefits: ['Uang pertanggungan 100%', ' Bebas premi  ', ''],
        defaultAttackPlan: planOf(product, { benefits: ['Satu', 'Dua'] }),
      }).expect(200);

      expect(res.body).toMatchObject({
        name: 'PRUMapan Plus', tagline: 'Proteksi jiwa', bestFor: 'Keluarga muda',
        benefits: ['Uang pertanggungan 100%', 'Bebas premi'],
      });
      expect(res.body.defaultAttackPlan.benefits).toEqual(['Satu', 'Dua']);
    });

    it('P19-T6 AC-1 keeps the no-markup guarantee on a field that keeps its lines', async () => {
      const product = await sold();
      const res = await api().patch(`${url}/${product.id}`).send({
        defaultAttackPlan: planOf(product, {
          objections: [{ objection: '<i>Mahal</i>', answer: '<b>Satu</b>\n<script>alert(1)</script>Dua' }],
        }),
      }).expect(200);
      expect(res.body.defaultAttackPlan.objections).toEqual([{ objection: 'Mahal', answer: 'Satu\nDua' }]);
    });

    it('P19-T6 AC-1 keeps the line breaks an office’s Owner types in its own script, and none in its name', async () => {
      const product = await sold();
      const view = await wired.kpmProducts.saveOverrides(owner, product.id, {
        displayName: 'PRUMapan\nBSD', objections: [{ objection: 'Mahal', answer: YOU_SAY.replace(/\n/g, '\r\n') }],
        benefits: ['Satu\nDua'],
      });
      expect(view.displayName.value).toBe('PRUMapan BSD');
      expect(view.script.objections.value).toEqual([{ objection: 'Mahal', answer: YOU_SAY }]);
      expect(view.script.benefits.value).toEqual(['Satu Dua']);
    });
  });

  describe('AC-2: a stale save is refused', () => {
    it('P19-T6 AC-2 lands a save carrying the version read, and moves the version on', async () => {
      const product = await sold();
      const res = await api().patch(`${url}/${product.id}`)
        .send({ name: 'PRUMapan Plus', expectedVersion: product.version }).expect(200);
      expect(res.body).toMatchObject({ name: 'PRUMapan Plus', version: product.version + 1 });
    });

    it('P19-T6 AC-2 refuses a save carrying a version somebody saved past: 409, both versions, nothing written', async () => {
      const product = await sold();
      // The other Super Admin's save lands first …
      await api().patch(`${url}/${product.id}`).send({ name: 'Theirs', expectedVersion: product.version }).expect(200);

      // … and this editor, still at the version it opened, saves over it.
      const res = await api().patch(`${url}/${product.id}`)
        .send({ name: 'Mine', expectedVersion: product.version }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        message: 'This record changed since you loaded it. Reload and try again.',
        details: { expectedVersion: product.version, actualVersion: product.version + 1 },
      });
      const [now] = (await wired.products.list(COMPANY, { withCommission: true })).filter((p) => p.id === product.id);
      expect(now).toMatchObject({ name: 'Theirs', version: product.version + 1 });
    });

    it('P19-T6 AC-2 refuses a save pinned to the version before a withdrawal, in the reader’s language', async () => {
      const product = await sold();
      await wired.products.setLifecycle(SUPER_ADMIN, COMPANY, product.id, 'withdrawn');
      const res = await api().patch(`${url}/${product.id}`).set(...IN_INDONESIAN)
        .send({ name: 'Mine', expectedVersion: product.version }).expect(409);
      expect(res.body.error.message).toBe('Data ini berubah sejak Anda membukanya. Muat ulang, lalu coba lagi.');
    });

    it('P19-T6 AC-2 lets exactly one of two saves racing on one version land', async () => {
      const product = await sold();
      const answers = await Promise.all(['One', 'Two'].map((name) => api().patch(`${url}/${product.id}`)
        .send({ name, expectedVersion: product.version })));
      expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('P19-T6 AC-2 lands a save with no version, as API callers before the pin do', async () => {
      const product = await sold();
      await api().patch(`${url}/${product.id}`).send({ name: 'Theirs' }).expect(200);
      const res = await api().patch(`${url}/${product.id}`).send({ name: 'Unpinned' }).expect(200);
      expect(res.body).toMatchObject({ name: 'Unpinned', version: product.version + 2 });
    });

    it('P19-T6 AC-2 answers 404, not 409, for another company’s product named with a stale version', async () => {
      const product = await sold();
      await api().patch(`/admin/companies/${OTHER_COMPANY}/products/${product.id}`)
        .send({ name: 'X', expectedVersion: product.version + 5 }).expect(404);
    });

    it.each([['zero', 0], ['a fraction', 1.5], ['a string', '1']])(
      'P19-T6 AC-2 refuses %s for the version, 400, nothing written',
      async (_label, expectedVersion) => {
        const product = await sold();
        const res = await api().patch(`${url}/${product.id}`).send({ name: 'X', expectedVersion }).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        const [now] = (await wired.products.list(COMPANY, { withCommission: true })).filter((p) => p.id === product.id);
        expect(now).toMatchObject({ name: product.name, version: product.version });
      },
    );

    it.each(EVERY_MEMBER)('P19-T6 AC-2 still refuses %s, a correct version or not, 403', async (_name, who) => {
      const product = await sold();
      session.current = who;
      await api().patch(`${url}/${product.id}`).send({ name: 'X', expectedVersion: product.version }).expect(403);
    });
  });
});
