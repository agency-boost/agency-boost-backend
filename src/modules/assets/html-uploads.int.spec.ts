import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { DOCUMENT_MIME_TYPES, SEED_TRAINING_MODULES, TRAINING_FILE_MIME_TYPES } from '@/domain/constants';
import { NamedTemplateController } from '@/modules/config/named-template.controller';
import { NamedTemplateService } from '@/modules/config/named-template.service';
import { TemplateCopyService } from '@/modules/config/template-copy.service';
import { TemplateMaterialService } from '@/modules/config/template-material.service';
import { TemplatePushService } from '@/modules/config/template-push.service';
import { TemplateService } from '@/modules/config/template.service';
import { KpmProductController } from '@/modules/products/kpm-product.controller';
import { KpmProductService } from '@/modules/products/kpm-product.service';
import { ProductCatalogController } from '@/modules/products/product-catalog.controller';
import { ProductCatalogService } from '@/modules/products/product-catalog.service';
import { RecruitmentController, RecruitmentPitchController } from '@/modules/recruitment/recruitment.controller';
import { RecruitmentPitchService } from '@/modules/recruitment/recruitment-pitch.service';
import { RecruitmentPlanService } from '@/modules/recruitment/recruitment-plan.service';
import { TrainingProgressController } from '@/modules/training/training-progress.controller';
import { TrainingProgressService } from '@/modules/training/training-progress.service';
import { TrainingController } from '@/modules/training/training.controller';
import { TrainingService } from '@/modules/training/training.service';
import { configModule, provisionFrom } from '../../../test/config-module';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const NOW = new Date('2026-11-06T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';
const OTHER_KPM = '66f0000000000000000000b2';
const MODULE = SEED_TRAINING_MODULES.find((m) => m.publishState === 'published')!.code;
const LESSON = { filename: 'Pelajaran 01.html', mimeType: 'text/html', bytes: 48_211 };

/** A Super Admin's read-only support session as `who` (roles §3.13): it reads, and every write is refused. */
const viewOnly = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'root', null, false, true);
/** The Owner of another office of the same company: the stranger of every cross-tenant case. */
const OTHER_OWNER = new RequestContext('u-other', 'none', {
  membershipId: 'mem-other', kpmId: OTHER_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);
const FIELD: [string, RequestContext][] = [['an AB', AB], ['an AAB', AAB], ['an agent', AGENT]];
const WRITERS: [string, RequestContext][] = [['the Owner', OWNER], ['the Admin', ADMIN]];

/**
 * **HTML wherever an agent opens a file, over HTTP** (P19.6-T2 AC-1, AC-2, AC-6; ADR-0217 §1–§3, §8): the four routes
 * that accept `text/html` — a training module's *File*, the office's and the template's, the pitch documents and the
 * office's product documents — behind the real `PermissionsGuard` and the production pipe, and the three readers
 * that say a file is HTML so the screen draws it in the sandboxed frame. Storage is the stub (`test/stub-storage.ts`),
 * whose links are on a host of their own, never the API's or the app's; the adapter's inline `text/html` link is
 * `gcs.adapter.spec.ts`'s, and the sniff that refuses a file claimed as HTML is `content-sniff.spec.ts`'s.
 */
describe('P19.6-T2 HTML in the four upload routes, and the readers (ADR-0217)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let templateId: string;
  let otherTemplateId: string;
  let mapanId: string;
  const http = () => request(app.getHttpServer());
  const TRAINING = '/kpm/settings/training';
  const PITCH = '/kpm/settings/recruitment-pitch';
  const PRODUCTS = '/kpm/settings/products';
  const template = () => `/admin/companies/${COMPANY}/templates/${templateId}`;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [
        TrainingController, TrainingProgressController, NamedTemplateController,
        RecruitmentController, RecruitmentPitchController, KpmProductController, ProductCatalogController,
      ],
      providers: [
        { provide: TrainingService, useValue: wired.training },
        { provide: TrainingProgressService, useValue: wired.trainingProgress },
        { provide: NamedTemplateService, useValue: wired.namedTemplates },
        { provide: TemplateCopyService, useValue: wired.templateCopies },
        { provide: TemplateService, useValue: wired.templateService },
        { provide: TemplateMaterialService, useValue: wired.templateMaterial },
        { provide: TemplatePushService, useValue: wired.templatePush },
        { provide: RecruitmentPlanService, useValue: wired.recruitmentPlans },
        { provide: RecruitmentPitchService, useValue: wired.recruitmentPitch },
        { provide: KpmProductService, useValue: wired.kpmProducts },
        { provide: ProductCatalogService, useValue: new ProductCatalogService(wired.kpmProducts, wired.clock) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    const allianz = await companies.create({ _id: OTHER_COMPANY, name: 'Allianz Life', slug: 'allianz' } as never);
    templateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, prudential as never))._id);
    otherTemplateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, allianz as never))._id);
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const startFrom = { kind: 'template' as const, templateId };
    const plan = await wired.provisioning.planFor(COMPANY, startFrom);
    await kpms.create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'BSD', timezone: 'Asia/Jakarta',
      startedFrom: plan.startedFrom,
    } as never);
    await kpms.create({ _id: OTHER_KPM, companyId: COMPANY, code: '0418', branchName: 'Serpong', timezone: 'Asia/Jakarta' } as never);
    const done = await provisionFrom(wired, FIXTURE_KPM, COMPANY, startFrom);
    await kpms.updateOne({ _id: FIXTURE_KPM } as never, { $set: { seededFrom: done.seededFrom } } as never);
    await wired.provisioning.publishInitialSnapshotFor(FIXTURE_KPM, RequestContext.superAdminInTenant('root', FIXTURE_KPM));
    await wired.products.seedForCompany(COMPANY);
    mapanId = (await wired.products.list(COMPANY, { withCommission: false })).find((p) => p.code === 'PRUMAPAN')!.id;
    session.current = OWNER;
  });

  /** A key another office of the same company signed and holds: what a cross-tenant attach names. */
  const theirKey = async (folder: string, allowed: readonly string[]) =>
    (await wired.assets.requestUpload(OTHER_OWNER, { folder, ...LESSON }, allowed)).storageKey;

  /** Storage reports a file claimed as HTML as `application/octet-stream`: its bytes are no document. */
  const notHtml = (storageKey: string) =>
    wired.storage.setStored(storageKey, { storageKey, mimeType: 'application/octet-stream', bytes: LESSON.bytes });

  describe('a training module’s File, the office’s (`POST /kpm/settings/training/uploads`)', () => {
    it.each(WRITERS)('P19.6-T2 AC-1 %s signs, confirms and attaches an HTML lesson, and an agent reads it as HTML', async (_n, who) => {
      session.current = who;
      const signed = await http().post(`${TRAINING}/uploads`).send(LESSON).expect(201);
      expect(wired.storage.signedWith.at(-1)).toMatchObject({ mimeType: 'text/html', allowedMimeTypes: TRAINING_FILE_MIME_TYPES });
      expect(signed.body.fields).toMatchObject({ 'Content-Type': 'text/html' });
      const confirmed = await http().post(`${TRAINING}/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(201);
      expect(confirmed.body).toMatchObject({ mimeType: 'text/html' });
      await http().put(`${TRAINING}/modules/${MODULE}/content`)
        .send({ files: [{ label: 'Pelajaran 01', ...confirmed.body }] }).expect(200);

      // The reader: the item says it is HTML, and its link is storage's, never the API's.
      session.current = AGENT;
      const page = await http().get(`/training/modules/${MODULE}`).expect(200);
      const item = page.body.items.find((i: { label: string }) => i.label === 'Pelajaran 01');
      expect(item).toMatchObject({ kind: 'file', mimeType: 'text/html', url: null });
      const opened = await http().post(`/training/modules/${MODULE}/items/${item.id}/open`).expect(200);
      // The stub's storage host (`test/stub-storage.ts`): a host of its own, never the API's nor the app's.
      expect(new URL(opened.body.url).origin).toBe('https://cdn.test');
      expect(opened.body.url).toContain(signed.body.storageKey);
    });

    it('P19.6-T2 AC-1 refuses at confirm a file claimed as HTML that is not one, and nothing is attachable', async () => {
      const signed = await http().post(`${TRAINING}/uploads`).send(LESSON).expect(201);
      notHtml(signed.body.storageKey);
      const refused = await http().post(`${TRAINING}/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(415);
      expect(refused.body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
      await http().put(`${TRAINING}/modules/${MODULE}/content`)
        .send({ files: [{ label: 'x', storageKey: signed.body.storageKey, mimeType: 'text/html', bytes: 1 }] }).expect(409);
    });

    it('P19.6-T2 AC-1 refuses an HTML file over 25 MB before anything is signed', async () => {
      const before = wired.storage.signedWith.length;
      const res = await http().post(`${TRAINING}/uploads`).send({ ...LESSON, bytes: 25 * 1024 * 1024 + 1 }).expect(413);
      expect(res.body.error.code).toBe('ASSET_TOO_LARGE');
      expect(wired.storage.signedWith).toHaveLength(before);
    });

    it('P19.6-T2 AC-1 cross-tenant: another office’s HTML key is a 404 here', async () => {
      const key = await theirKey('training', TRAINING_FILE_MIME_TYPES);
      await http().post(`${TRAINING}/uploads/confirm`).send({ storageKey: key }).expect(404);
    });

    it.each([...FIELD, ['a Super Admin', SUPER_ADMIN] as [string, RequestContext]])('P19.6-T2 AC-1 refuses %s an HTML upload', async (_n, who) => {
      session.current = who;
      await http().post(`${TRAINING}/uploads`).send(LESSON).expect(403);
    });

    it('P19.6-T2 AC-1 refuses a view-only session as the Owner an HTML upload', async () => {
      session.current = viewOnly(OWNER);
      await http().post(`${TRAINING}/uploads`).send(LESSON).expect(403);
    });
  });

  describe('a training module’s File, the template’s (`POST …/templates/:templateId/training/uploads`)', () => {
    it('P19.6-T2 AC-1 the Super Admin signs and confirms an HTML lesson into the company’s folder', async () => {
      session.current = SUPER_ADMIN;
      const signed = await http().post(`${template()}/training/uploads`).send(LESSON).expect(201);
      expect(signed.body.storageKey).toMatch(new RegExp(`^dev/company/${COMPANY}/templates/${templateId}/training/`));
      expect(wired.storage.signedWith.at(-1)).toMatchObject({ mimeType: 'text/html', allowedMimeTypes: TRAINING_FILE_MIME_TYPES });
      const confirmed = await http().post(`${template()}/training/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(200);
      expect(confirmed.body).toMatchObject({ mimeType: 'text/html' });
      await http().put(`${template()}/training/modules/${MODULE}/content`)
        .send({ files: [{ label: 'Pelajaran 01', ...confirmed.body }] }).expect(200);
    });

    it('P19.6-T2 AC-1 refuses at confirm a file claimed as HTML that is not one', async () => {
      session.current = SUPER_ADMIN;
      const signed = await http().post(`${template()}/training/uploads`).send(LESSON).expect(201);
      notHtml(signed.body.storageKey);
      const refused = await http().post(`${template()}/training/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(415);
      expect(refused.body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
    });

    it('P19.6-T2 AC-1 another company’s template, or another template’s key, is a 404', async () => {
      session.current = SUPER_ADMIN;
      await http().post(`/admin/companies/${COMPANY}/templates/${otherTemplateId}/training/uploads`).send(LESSON).expect(404);
      const signed = await http().post(`/admin/companies/${OTHER_COMPANY}/templates/${otherTemplateId}/training/uploads`)
        .send(LESSON).expect(201);
      await http().post(`${template()}/training/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(404);
    });

    it.each([...WRITERS, ...FIELD])('P19.6-T2 AC-1 refuses %s the template’s HTML upload', async (_n, who) => {
      session.current = who;
      await http().post(`${template()}/training/uploads`).send(LESSON).expect(403);
    });

    describe('the editor’s preview (`GET …/templates/:templateId/training/files/url`, ADR-0217 §4)', () => {
      const confirmedLesson = async () => {
        session.current = SUPER_ADMIN;
        const signed = await http().post(`${template()}/training/uploads`).send(LESSON).expect(201);
        await http().post(`${template()}/training/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(200);
        return signed.body.storageKey as string;
      };

      it('P19.6-T2 AC-2 signs the Super Admin a link to the template’s lesson, on the storage host', async () => {
        const key = await confirmedLesson();
        const res = await http().get(`${template()}/training/files/url`).query({ storageKey: key }).expect(200);
        expect(Object.keys(res.body)).toEqual(['url']);
        expect(new URL(res.body.url).origin).toBe('https://cdn.test');
        expect(res.body.url).toContain(key);
      });

      it('P19.6-T2 AC-2 a file named by the section, uploaded into another of the company’s templates, is signed too', async () => {
        const key = await confirmedLesson();
        await http().put(`${template()}/training/modules/${MODULE}/content`)
          .send({ files: [{ label: 'Pelajaran 01', storageKey: key, mimeType: 'text/html', bytes: 1024 }] }).expect(200);
        // The same company, a second template: it neither uploaded nor names the file.
        const second = (await wired.namedTemplates.create(SUPER_ADMIN, COMPANY, { name: 'Kedua', from: 'defaults' })).id;
        await http().get(`/admin/companies/${COMPANY}/templates/${second}/training/files/url`).query({ storageKey: key }).expect(404);
        await http().get(`${template()}/training/files/url`).query({ storageKey: key }).expect(200);
      });

      it('P19.6-T2 AC-2 cross-company: another company’s file, another company’s template, a stranger key, no key — 404', async () => {
        const mine = await confirmedLesson();
        const signed = await http().post(`/admin/companies/${OTHER_COMPANY}/templates/${otherTemplateId}/training/uploads`)
          .send(LESSON).expect(201);
        await http().post(`/admin/companies/${OTHER_COMPANY}/templates/${otherTemplateId}/training/uploads/confirm`)
          .send({ storageKey: signed.body.storageKey }).expect(200);
        await http().get(`${template()}/training/files/url`).query({ storageKey: signed.body.storageKey }).expect(404);
        await http().get(`/admin/companies/${COMPANY}/templates/${otherTemplateId}/training/files/url`).query({ storageKey: mine }).expect(404);
        await http().get(`${template()}/training/files/url`).query({ storageKey: 'dev/company/x/training/nothing' }).expect(404);
        await http().get(`${template()}/training/files/url`).expect(404);
      });

      it('P19.6-T2 AC-2 an upload not yet confirmed is 409 ASSET_NOT_CONFIRMED', async () => {
        session.current = SUPER_ADMIN;
        const signed = await http().post(`${template()}/training/uploads`).send(LESSON).expect(201);
        const res = await http().get(`${template()}/training/files/url`).query({ storageKey: signed.body.storageKey }).expect(409);
        expect(res.body.error.code).toBe('ASSET_NOT_CONFIRMED');
      });

      it.each([...WRITERS, ...FIELD, ['a view-only Owner', viewOnly(OWNER)] as [string, RequestContext]])(
        'P19.6-T2 AC-2 refuses %s the preview link', async (_n, who) => {
          const key = await confirmedLesson();
          session.current = who;
          await http().get(`${template()}/training/files/url`).query({ storageKey: key }).expect(403);
        },
      );
    });
  });

  describe('the recruitment pitch documents (`POST /kpm/settings/recruitment-pitch/uploads`)', () => {
    it.each(WRITERS)('P19.6-T2 AC-1 %s attaches an HTML page to a slot, and every member reads it as HTML', async (_n, who) => {
      session.current = who;
      const signed = await http().post(`${PITCH}/uploads`).send(LESSON).expect(201);
      expect(wired.storage.signedWith.at(-1)).toMatchObject({ mimeType: 'text/html', allowedMimeTypes: DOCUMENT_MIME_TYPES });
      await http().put(`${PITCH}/opportunity`).send({ storageKey: signed.body.storageKey }).expect(200);

      session.current = AGENT;
      const read = await http().get('/recruitment/pitch-materials').expect(200);
      expect(read.body.slots.find((s: { slot: string }) => s.slot === 'opportunity').file)
        .toMatchObject({ name: LESSON.filename, mimeType: 'text/html' });
      const link = await http().get('/recruitment/pitch-materials/opportunity/url').expect(200);
      expect(link.body.url).toContain(signed.body.storageKey);
    });

    it('P19.6-T2 AC-6 a PDF in a slot reads as a PDF, as it always did', async () => {
      const signed = await http().post(`${PITCH}/uploads`).send({ filename: 'o.pdf', mimeType: 'application/pdf', bytes: 1024 }).expect(201);
      await http().put(`${PITCH}/proof`).send({ storageKey: signed.body.storageKey }).expect(200);
      const read = await http().get('/recruitment/pitch-materials').expect(200);
      expect(read.body.slots.find((s: { slot: string }) => s.slot === 'proof').file).toMatchObject({ mimeType: 'application/pdf' });
    });

    it('P19.6-T2 AC-1 refuses a file claimed as HTML that is not one, and the slot stays empty', async () => {
      const signed = await http().post(`${PITCH}/uploads`).send(LESSON).expect(201);
      notHtml(signed.body.storageKey);
      const refused = await http().put(`${PITCH}/opportunity`).send({ storageKey: signed.body.storageKey }).expect(415);
      expect(refused.body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
      const read = await http().get('/recruitment/pitch-materials').expect(200);
      expect(read.body.slots.find((s: { slot: string }) => s.slot === 'opportunity').file).toBeNull();
    });

    it('P19.6-T2 AC-1 refuses any other type, as before (a spreadsheet)', async () => {
      const res = await http().post(`${PITCH}/uploads`)
        .send({ filename: 'x.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 10 })
        .expect(415);
      expect(res.body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
    });

    it('P19.6-T2 AC-1 cross-tenant: another office’s HTML key is a 404 here', async () => {
      const key = await theirKey('recruitment-pitch', DOCUMENT_MIME_TYPES);
      await http().put(`${PITCH}/opportunity`).send({ storageKey: key }).expect(404);
    });

    it.each([...FIELD, ['a Super Admin', SUPER_ADMIN] as [string, RequestContext], ['a view-only Owner', viewOnly(OWNER)] as [string, RequestContext]])(
      'P19.6-T2 AC-1 refuses %s an HTML upload', async (_n, who) => {
        session.current = who;
        await http().post(`${PITCH}/uploads`).send(LESSON).expect(403);
      },
    );
  });

  describe('the office’s product documents (`POST /kpm/settings/products/uploads`)', () => {
    it.each(WRITERS)('P19.6-T2 AC-1 %s attaches an HTML page as a brochure, and an agent’s catalogue says it is HTML', async (_n, who) => {
      session.current = who;
      const signed = await http().post(`${PRODUCTS}/uploads`).send(LESSON).expect(201);
      expect(wired.storage.signedWith.at(-1)).toMatchObject({ mimeType: 'text/html', allowedMimeTypes: DOCUMENT_MIME_TYPES });
      const filled = await http().put(`${PRODUCTS}/${mapanId}/documents/brochure`)
        .send({ storageKey: signed.body.storageKey, label: 'Brosur' }).expect(200);
      expect(filled.body.documents.find((d: { slot: string }) => d.slot === 'brochure'))
        .toMatchObject({ source: 'kpm', mimeType: 'text/html' });

      session.current = AGENT;
      const product = await http().get('/product-catalog/PRUMAPAN').expect(200);
      expect(product.body.documents.find((d: { slot: string }) => d.slot === 'brochure'))
        .toEqual({ slot: 'brochure', label: expect.any(String), available: true, mimeType: 'text/html' });
      expect(product.body.documents.find((d: { slot: string }) => d.slot === 'productDoc')).toMatchObject({ available: false, mimeType: null });
      const link = await http().get('/product-catalog/PRUMAPAN/documents/brochure/url').expect(200);
      expect(link.body.url).toContain(signed.body.storageKey);
    });

    it('P19.6-T2 AC-1 refuses a file claimed as HTML that is not one, with nothing attached', async () => {
      const signed = await http().post(`${PRODUCTS}/uploads`).send(LESSON).expect(201);
      notHtml(signed.body.storageKey);
      const refused = await http().put(`${PRODUCTS}/${mapanId}/documents/brochure`)
        .send({ storageKey: signed.body.storageKey, label: 'Brosur' }).expect(415);
      expect(refused.body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
    });

    it('P19.6-T2 AC-1 cross-tenant: another office’s HTML key is a 404 here', async () => {
      const key = await theirKey('products', DOCUMENT_MIME_TYPES);
      await http().put(`${PRODUCTS}/${mapanId}/documents/brochure`).send({ storageKey: key, label: 'B' }).expect(404);
    });

    it.each([...FIELD, ['a Super Admin', SUPER_ADMIN] as [string, RequestContext], ['a view-only Owner', viewOnly(OWNER)] as [string, RequestContext]])(
      'P19.6-T2 AC-1 refuses %s an HTML upload', async (_n, who) => {
        session.current = who;
        await http().post(`${PRODUCTS}/uploads`).send(LESSON).expect(403);
      },
    );
  });
});
