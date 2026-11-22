import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { strToU8, zipSync } from 'fflate';
import mongoose from 'mongoose';
import request from 'supertest';
import { FixedClock } from '@/common/clock/clock.port';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { KpmProductConfig, KpmProductConfigSchema } from '@/modules/products/kpm-product-config.schema';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { ProductService } from '@/modules/products/product.service';
import { ProposalPdfBuilder } from '@/modules/proposals/proposal-pdf.builder';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { FIXTURE_KPM, productionPipe, session, StubAuth, SUPER_ADMIN, AGENT, AB, AAB } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { startMongo, stopMongo } from '../../../test/mongo';
import { StubStorage } from '../../../test/stub-storage';
import {
  ProductDataReader, type FileReadingInput, type IllustrationReadingInput, type ReadingResult,
} from './ai/reader.port';
import type { FileReading, IllustrationReading, ReadItem } from './ai/reading-schema';
import { IllustrationController } from './illustration.controller';
import { Illustration, IllustrationSchema } from './illustration.schema';
import { IllustrationService } from './illustration.service';
import type { RateRowInput } from './intake-apply-plan';
import { IntakeCatalogue } from './intake-catalogue';
import { IntakeReading } from './intake-reading';
import { IntakeTargets } from './intake-targets';
import type { ProductNow } from './intake-understanding';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';
import { ProductDataAccess } from './product-data-access.service';
import { IntakeItem, IntakeItemSchema, UploadIntake, UploadIntakeSchema } from './upload-intake.schema';

const NOW = new Date('2026-11-12T03:00:00Z');
const PRU = '66f0000000000000000000c1';
const MANU = '66f0000000000000000000c2';
const CERAH = '66f0000000000000000000d1';
const MEDICAL = '66f0000000000000000000d2';
const MANU_PRODUCT = '66f0000000000000000000d3';
const KPM_B = '66f0000000000000000000b1';
const MAYA = '66f0000000000000000000e2';
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** A KPM Admin of `FIXTURE_KPM` (Prudential), holding *Kelola data produk* for `companies`. */
const admin = (companies: string[] = [], viewAs = false) => new RequestContext(
  MAYA, 'none',
  { membershipId: 'mem-maya', kpmId: FIXTURE_KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active', isKpmOwner: false, isKpmAdmin: true, directCount: 0 },
  viewAs ? 'root' : null, null, false, viewAs, undefined, companies,
);
const owner = () => new RequestContext(
  'u-owner', 'none',
  { membershipId: 'mem-owner', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0 },
);
/** An Admin of a Manulife office, with no grant: Prudential's data is not theirs to read. */
const otherAdmin = () => new RequestContext(
  'u-other', 'none',
  { membershipId: 'mem-o', kpmId: KPM_B, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active', isKpmOwner: false, isKpmAdmin: true, directCount: 0 },
);

const usage = { inputTokens: 1000, outputTokens: 200, model: 'claude-opus-5-5' };

/** Claude, doubled: scripted answers, and every request it was given. */
class FakeReader extends ProductDataReader {
  on = true;
  files: FileReading[] = [];
  illustration: IllustrationReading | null = null;
  calls: FileReadingInput[] = [];
  illustrationCalls: IllustrationReadingInput[] = [];
  get enabled() { return this.on; }
  async readFile(input: FileReadingInput): Promise<ReadingResult<FileReading>> {
    this.calls.push(input);
    const next = this.files.shift();
    return next ? { ok: true, value: next, usage } : { ok: false, failure: 'refused', usage: null };
  }
  async condenseIllustration(input: IllustrationReadingInput): Promise<ReadingResult<IllustrationReading>> {
    this.illustrationCalls.push(input);
    return this.illustration ? { ok: true, value: this.illustration, usage } : { ok: false, failure: 'unreadable', usage };
  }
}

/** T1's flows, doubled: what a confirmed card hands them. */
class FakeTargets extends IntakeTargets {
  drafts: Parameters<IntakeTargets['createRateTableDraft']>[1][] = [];
  rules: Parameters<IntakeTargets['applyRules']>[1][] = [];
  inForce: RateRowInput[] | null = null;
  async productNow(companyId: string, productId: string): Promise<ProductNow | null> {
    return {
      id: productId, companyId, name: productId === CERAH ? 'PRUCerah' : 'PRUWell Medical', lifecycle: 'active', smokerRated: false,
      frequencies: ['monthly'], payTerms: [{ key: 'y10', label: '10 tahun', years: 10 }], chipFields: [],
      rules: { upStep: null, upMin: 10_000_000_000, upMax: null, premiumMin: null, premiumMax: null, entryAgeMin: null, entryAgeMax: null, payTermMaxAge: {}, frequencyFactor: { monthly: null, quarterly: null, semiannual: null } },
      table: this.inForce ? { effectiveFrom: '2026-04-01', basis: 'per_mille', rateDecimals: 2 } : null,
    };
  }
  async createRateTableDraft(_ctx: RequestContext, input: Parameters<IntakeTargets['createRateTableDraft']>[1]) {
    this.drafts.push(input);
    return { rateTableId: `rt-${this.drafts.length}` };
  }
  async inForceRows() {
    return this.inForce ? { rateTableId: 'rt-old', rows: this.inForce, basis: 'per_mille' as const, currency: 'IDR' as const } : null;
  }
  async applyRules(_ctx: RequestContext, input: Parameters<IntakeTargets['applyRules']>[1]) {
    this.rules.push(input);
    return { kind: 'product' as const, id: input.productId };
  }
}

const src = { page: 1, sheet: null, cell: null, quote: null };
const day = (date: string | null) => ({ asWritten: date, date, clear: date !== null });
const item = (over: Partial<ReadItem>): ReadItem => ({
  kind: 'product_rules', summary: 'Ketentuan baru PRUCerah', company: null,
  products: [{ asWritten: 'PRUCerah', id: CERAH, clear: true }], effectiveFrom: day('2026-12-01'), effectiveTo: day(null),
  source: src, changes: [], table: null, percent: null, newProductName: null, questions: [], ...over,
});
const upMin = (asWritten: string, value: string, certain = true) => ({
  key: 'upMin' as const, payTermKey: null, frequency: null, fieldKey: null, label: 'UP minimum', value: { asWritten, value, certain }, source: src,
});

const PDF = Buffer.from('%PDF-1.4\n%%EOF');

/**
 * **P19.15-T2, T3 — *Unggah file* and *Ilustrasi*, over HTTP** (ADR-0259): the services real over a real database, the
 * deployed pipe, the real permission and view-only guards, storage and Claude doubled at their ports. Access per role:
 * the Super Admin; a holder of *Kelola data produk* for a ticked company and not for another; the KPM Owner/Admin
 * read-only; agents and leaders refused; a view-as session read-only; another company's office `404`.
 */
describe('P19.15-T2 T3 Unggah file and Ilustrasi over HTTP', () => {
  let app: INestApplication;
  const db = () => mongoose.connection.db!;
  const reader = new FakeReader();
  const targets = new FakeTargets();
  const storage = new StubStorage();
  let reading: IntakeReading;
  let illustrations: IllustrationService;
  const http = () => request(app.getHttpServer());
  const settle = async () => { await reading.settled(); await illustrations.settled(); };

  beforeAll(async () => {
    await startMongo();
    const model = (name: string, schema: mongoose.Schema) => mongoose.model(name, schema) as never;
    const companies = model(Company.name, CompanySchema);
    const kpms = model(Kpm.name, KpmSchema);
    const products = model(Product.name, ProductSchema);
    const audit = new AuditService(model(AuditLog.name, AuditLogSchema));
    const clock = new FixedClock(NOW);
    const access = new ProductDataAccess(companies, kpms);
    const catalogue = new IntakeCatalogue(products, companies);
    const productService = new ProductService(products, companies, audit, clock, new KpmProductConfigRepository(model(KpmProductConfig.name, KpmProductConfigSchema)));
    illustrations = new IllustrationService(
      model(Illustration.name, IllustrationSchema), companies, reader, access, catalogue, productService, storage, audit, new ProposalPdfBuilder(), clock,
    );
    const intakes = model(UploadIntake.name, UploadIntakeSchema);
    const items = model(IntakeItem.name, IntakeItemSchema);
    reading = new IntakeReading(intakes, items, reader, catalogue, targets, clock);
    const service = new IntakeService(
      intakes, items, companies, model(User.name, UserSchema), reader, reading, access, catalogue, targets, productService,
      illustrations, storage, audit, clock,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [IntakeController, IllustrationController],
      providers: [{ provide: IntakeService, useValue: service }, { provide: IllustrationService, useValue: illustrations }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(reflector), new PermissionsGuard(reflector));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  beforeEach(async () => {
    for (const name of ['users', 'companies', 'kpms', 'products', 'auditLog', 'uploadIntakes', 'intakeItems', 'illustrations']) {
      await db().collection(name).deleteMany({});
    }
    session.current = SUPER_ADMIN;
    Object.assign(reader, { on: true, files: [], illustration: null, calls: [], illustrationCalls: [] });
    Object.assign(targets, { drafts: [], rules: [], inForce: null });
    await db().collection('companies').insertMany([
      { _id: oid(PRU), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null },
      { _id: oid(MANU), name: 'Manulife', slug: 'manulife', kind: 'insurer', deletedAt: null },
    ]);
    await db().collection('kpms').insertMany([
      { _id: oid(FIXTURE_KPM), companyId: PRU, code: '0417', branchName: 'Bandung', status: 'active', deletedAt: null },
      { _id: oid(KPM_B), companyId: MANU, code: '0900', branchName: 'Medan', status: 'active', deletedAt: null },
    ]);
    const product = (id: string, companyId: string, code: string, name: string, over: Record<string, unknown> = {}) => ({
      _id: oid(id), companyId, code, name, channel: 'conventional', category: 'life', sortOrder: 1, version: 1, lifecycle: 'active',
      replacedByProductId: null, deletedAt: null, currencies: ['IDR'], proposalFields: [], pdfDetail: [], ...over,
    });
    await db().collection('products').insertMany([
      product(CERAH, PRU, 'PRUCERAH', 'PRUCerah', { calcType: 'up_premium', payTerms: [{ key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 55, default: true }] }),
      product(MEDICAL, PRU, 'PRUWELL_MEDICAL', 'PRUWell Medical', { category: 'health', calcType: 'plan_priced' }),
      product(MANU_PRODUCT, MANU, 'MIPLAN', 'MiPlan'),
    ]);
  });

  const upload = (url: string, files: [string, Buffer][]) => {
    const req = http().post(url);
    for (const [name, body] of files) req.attach('files', body, name);
    return req;
  };

  describe('P19.15-T3 AC-5 without the key', () => {
    it('says reading is not switched on, and refuses an upload with it, writing nothing', async () => {
      reader.on = false;
      const list = await http().get(`/product-data/companies/${PRU}/intakes`).expect(200);
      expect(list.body).toEqual({ aiReading: false, intakes: [] });
      const res = await upload(`/product-data/companies/${PRU}/intakes`, [['tarif.pdf', PDF]]).expect(503);
      expect(res.body.error.code).toBe('AI_READING_OFF');
      expect(res.body.error.message).toContain('Excel or CSV');
      expect(await db().collection('uploadIntakes').countDocuments()).toBe(0);
    });
  });

  describe('P19.15-T3 AC-1 AC-2 AC-3 an upload is read, shown, asked about, and applied only when confirmed', () => {
    it('reads several files at once, a ZIP unpacked, answering at once and reading in the background', async () => {
      reader.files = [
        { items: [item({ changes: [upMin('Rp150 jt', '150000000')] })], notes: null },
        { items: [], notes: 'Brosur saja.' },
      ];
      const zip = Buffer.from(zipSync({ 'brosur.pdf': strToU8('%PDF-1.4 brosur') }));
      const res = await upload(`/product-data/companies/${PRU}/intakes`, [['ketentuan.pdf', PDF], ['kiriman.zip', zip]]).expect(201);
      expect(res.body).toMatchObject({ companyId: PRU, status: 'reading', files: [{ name: 'ketentuan.pdf', kind: 'pdf', status: 'reading', kept: true }, { name: 'kiriman.zip › brosur.pdf', kind: 'pdf' }] });
      await settle();

      expect(reader.calls.map((c) => [c.file.name, c.company?.name, c.catalogue.map((p) => p.code)])).toEqual([
        ['ketentuan.pdf', 'Prudential', ['PRUCERAH', 'PRUWELL_MEDICAL']],
        ['kiriman.zip › brosur.pdf', 'Prudential', ['PRUCERAH', 'PRUWELL_MEDICAL']],
      ]);
      const detail = await http().get(`/product-data/intakes/${res.body.id}`).expect(200);
      expect(detail.body).toMatchObject({ status: 'ready', canManage: true, items: 1, open: 0 });
      expect(detail.body.cards[0]).toMatchObject({
        kind: 'product_rules', productId: CERAH, productName: 'PRUCerah', status: 'ready', effectiveFrom: '2026-12-01',
        diff: [{ key: 'upMin', label: 'UP minimum', old: 'Rp 100 Jt', new: 'Rp 150 Jt', certain: true, source: { file: 0, fileName: 'ketentuan.pdf', page: 1 } }],
      });

      // Its source links to the original file.
      const link = await http().get(`/product-data/intakes/${res.body.id}/files/0`).expect(200);
      expect(link.body.url).toContain(`company/${PRU}/intake/${res.body.id}/0-ketentuan.pdf`);

      // Confirmed: through T1's rules, audited and linked to the file.
      expect(targets.rules).toEqual([]);
      const applied = await http().post(`/product-data/intakes/${res.body.id}/items/${detail.body.cards[0].id}/confirm`).expect(200);
      expect(applied.body).toMatchObject({ status: 'applied', appliedRef: { kind: 'product', id: CERAH } });
      expect(targets.rules[0]).toMatchObject({ companyId: PRU, productId: CERAH, rules: { upMin: 15_000_000_000 }, effectiveFrom: '2026-12-01' });
      const audit = await db().collection('auditLog').findOne({ action: 'intake.applied' });
      expect(audit?.after).toMatchObject({ intakeId: res.body.id, file: { name: 'ketentuan.pdf', storageKey: expect.stringContaining('ketentuan.pdf') }, appliedRef: { kind: 'product', id: CERAH } });
      expect((await http().get(`/product-data/intakes/${res.body.id}`)).body.status).toBe('applied');
    });

    it('applies nothing while a question is open; a blurry number is typed, never filled in', async () => {
      reader.files = [{ items: [item({ changes: [upMin('Rp1?0 jt', '150000000', false)] })], notes: null }];
      const res = await upload(`/product-data/companies/${PRU}/intakes`, [['foto.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])]]).expect(201);
      await settle();
      const { body } = await http().get(`/product-data/intakes/${res.body.id}`).expect(200);
      // A picture sharp cannot open is reported, not read: a real photo is scaled; this one fails to `unreadable`.
      expect(body.files[0]).toMatchObject({ status: 'failed', failure: 'unreadable' });
      expect(body.status).toBe('failed');

      reader.files = [{ items: [item({ changes: [upMin('Rp1?0 jt', '150000000', false)] })], notes: null }];
      const again = await upload(`/product-data/companies/${PRU}/intakes`, [['pesan.pdf', PDF]]).expect(201);
      await settle();
      const card = (await http().get(`/product-data/intakes/${again.body.id}`)).body.cards[0];
      expect(card.status).toBe('needs_answers');
      expect(card.diff[0]).toMatchObject({ new: null, certain: false });
      const question = card.questions[0];
      expect(question).toMatchObject({ kind: 'type_number', open: true });
      const refused = await http().post(`/product-data/intakes/${again.body.id}/items/${card.id}/confirm`).expect(409);
      expect(refused.body.error).toMatchObject({ code: 'INTAKE_QUESTIONS_OPEN', details: { open: [question.id] } });
      expect(targets.rules).toEqual([]);

      await http().post(`/product-data/intakes/${again.body.id}/items/${card.id}/answers`).send({ questionId: question.id, answer: 'seratus' }).expect(400);
      const answered = await http().post(`/product-data/intakes/${again.body.id}/items/${card.id}/answers`).send({ questionId: question.id, answer: '150.000.000' }).expect(200);
      expect(answered.body.status).toBe('ready');
      await http().post(`/product-data/intakes/${again.body.id}/items/${card.id}/confirm`).expect(200);
      expect(targets.rules[0].rules).toEqual({ upMin: 15_000_000_000 });
      await http().post(`/product-data/intakes/${again.body.id}/items/${card.id}/reject`).expect(409);
    });

    it('turns "naik 5%" into an approval request; only an approval makes a table, by our code, as a draft', async () => {
      targets.inForce = [{ age: 30, gender: 'male', smoker: null, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille', rate: 12.35, bandMin: null, bandMax: null }];
      reader.files = [{ items: [item({ kind: 'percent_change', percent: { asWritten: '5%', direction: 'up', appliesTo: 'semua tarif' } })], notes: null }];
      const res = await upload(`/product-data/companies/${PRU}/intakes`, [['wa.pdf', PDF]]).expect(201);
      await settle();
      const card = (await http().get(`/product-data/intakes/${res.body.id}`)).body.cards[0];
      expect(card.percent.rule).toBe('semua tarif × 1,05, dibulatkan ke 2 angka desimal seperti tabel asal');
      expect(targets.drafts).toEqual([]);
      await http().post(`/product-data/intakes/${res.body.id}/items/${card.id}/answers`).send({ questionId: card.questions[0].id, answer: 'approve' }).expect(200);
      await http().post(`/product-data/intakes/${res.body.id}/items/${card.id}/confirm`).expect(200);
      expect(targets.drafts[0]).toMatchObject({ productId: CERAH, effectiveFrom: '2026-12-01', rows: [expect.objectContaining({ rate: 12.97 })], source: { fileName: 'wa.pdf', intakeItemId: card.id } });
    });

    it('rejects a card a person answered "Tidak": nothing applied, and the files of an all-rejected upload removed', async () => {
      reader.files = [{ items: [item({ kind: 'percent_change', percent: { asWritten: '5%', direction: 'up', appliesTo: 'x' } })], notes: null }];
      const res = await upload(`/product-data/companies/${PRU}/intakes`, [['wa.pdf', PDF]]).expect(201);
      await settle();
      const card = (await http().get(`/product-data/intakes/${res.body.id}`)).body.cards[0];
      const answered = await http().post(`/product-data/intakes/${res.body.id}/items/${card.id}/answers`).send({ questionId: card.questions[0].id, answer: 'reject' }).expect(200);
      expect(answered.body.status).toBe('rejected');
      const after = (await http().get(`/product-data/intakes/${res.body.id}`)).body;
      expect(after).toMatchObject({ status: 'rejected', files: [{ kept: false }] });
      expect(storage.removed.some((k) => k.endsWith('0-wa.pdf'))).toBe(true);
      expect(targets.drafts).toEqual([]);
    });

    it('refuses a file of a kind not read, a ZIP in a ZIP, and too many files, before anything is kept', async () => {
      expect((await upload(`/product-data/companies/${PRU}/intakes`, [['x.exe', Buffer.from('MZ\0\0')]]).expect(415)).body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
      const nested = Buffer.from(zipSync({ 'in.zip': zipSync({ 'a.pdf': strToU8('%PDF-1.4') }) }));
      expect((await upload(`/product-data/companies/${PRU}/intakes`, [['luar.zip', nested]]).expect(415)).body.error.details.name).toBe('luar.zip › in.zip');
      const eleven = Array.from({ length: 11 }, (_, i) => [`${i}.pdf`, PDF] as [string, Buffer]);
      expect((await upload(`/product-data/companies/${PRU}/intakes`, eleven).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await http().post(`/product-data/companies/${PRU}/intakes`).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      expect(await db().collection('uploadIntakes').countDocuments()).toBe(0);
    });

    it('reports a reading the process lost as failed once it is older than 15 minutes', async () => {
      const { insertedId } = await db().collection('uploadIntakes').insertOne({
        companyId: PRU, files: [{ index: 0, name: 'a.pdf', kind: 'pdf', mimeType: 'application/pdf', bytes: 9, storageKey: null, fromZip: null, status: 'reading', failure: null, items: 0 }],
        uploadedBy: 'root', status: 'reading', readingStartedAt: new Date(NOW.getTime() - 16 * 60_000), readAt: null, failure: null,
        usage: { inputTokens: 0, outputTokens: 0 }, deletedAt: null, createdAt: NOW, updatedAt: NOW,
      });
      const res = await http().get(`/product-data/intakes/${String(insertedId)}`).expect(200);
      expect(res.body).toMatchObject({ status: 'failed', failure: 'stale', files: [{ status: 'failed' }] });
    });
  });

  describe('P19.15-T3 AC-1 Perusahaan’s upload, for any company', () => {
    it('asks which company when the file does not say it, and is the Super Admin’s alone', async () => {
      reader.files = [{ items: [item({ company: { asWritten: 'Pru', id: null, clear: false }, products: [{ asWritten: 'Cerah', id: null, clear: false }] })], notes: null }];
      const res = await upload('/product-data/intakes', [['tarif.pdf', PDF]]).expect(201);
      expect(res.body.companyId).toBeNull();
      await settle();
      expect(reader.calls[0].company).toBeNull();
      expect(reader.calls[0].catalogue.map((p) => p.code)).toEqual(expect.arrayContaining(['PRUCERAH', 'MIPLAN']));
      const card = (await http().get(`/product-data/intakes/${res.body.id}`)).body.cards[0];
      expect(card.questions.map((q: { kind: string }) => q.kind)).toEqual(['company', 'product']);
      expect((await http().get('/product-data/intakes')).body.intakes[0].id).toBe(res.body.id);

      for (const who of [admin([PRU]), owner()]) {
        session.current = who;
        await http().get('/product-data/intakes').expect(404);
        await http().get(`/product-data/intakes/${res.body.id}`).expect(404);
      }
      session.current = admin([PRU]);
      await upload('/product-data/intakes', [['tarif.pdf', PDF]]).expect(404);
    });
  });

  describe('P19.15-T3 who may reach it', () => {
    let intakeId: string;
    beforeEach(async () => {
      reader.files = [{ items: [item({ changes: [upMin('Rp150 jt', '150000000')] })], notes: null }];
      intakeId = (await upload(`/product-data/companies/${PRU}/intakes`, [['k.pdf', PDF]]).expect(201)).body.id;
      await settle();
    });

    it('lets a holder of Kelola data produk for Prudential upload, answer and confirm, and not for Manulife', async () => {
      session.current = admin([PRU]);
      reader.files = [{ items: [], notes: null }];
      await upload(`/product-data/companies/${PRU}/intakes`, [['k.pdf', PDF]]).expect(201);
      await settle();
      const card = (await http().get(`/product-data/intakes/${intakeId}`).expect(200)).body.cards[0];
      await http().post(`/product-data/intakes/${intakeId}/items/${card.id}/confirm`).expect(200);
      await upload(`/product-data/companies/${MANU}/intakes`, [['k.pdf', PDF]]).expect(404);
      await http().get(`/product-data/companies/${MANU}/intakes`).expect(404);
    });

    it('shows the KPM Owner and Admin their company’s uploads read-only', async () => {
      for (const who of [owner(), admin([])]) {
        session.current = who;
        const res = await http().get(`/product-data/intakes/${intakeId}`).expect(200);
        expect(res.body.canManage).toBe(false);
        await upload(`/product-data/companies/${PRU}/intakes`, [['k.pdf', PDF]]).expect(403);
        await http().post(`/product-data/intakes/${intakeId}/items/${res.body.cards[0].id}/confirm`).expect(403);
      }
    });

    it('refuses agents and leaders on the server, and another company’s office sees nothing (404)', async () => {
      for (const who of [AGENT, AB, AAB]) {
        session.current = who;
        await http().get(`/product-data/companies/${PRU}/intakes`).expect(403);
        await http().get(`/product-data/intakes/${intakeId}`).expect(403);
        await upload(`/product-data/companies/${PRU}/intakes`, [['k.pdf', PDF]]).expect(403);
      }
      session.current = otherAdmin();
      const theirs = await http().get(`/product-data/intakes/${intakeId}`).expect(404);
      const nobodys = await http().get('/product-data/intakes/66f0000000000000000009ff').expect(404);
      // Another company's upload reads exactly as one that does not exist: the answer names no company.
      expect(theirs.body.error).toEqual(nobodys.body.error);
      await http().get(`/product-data/companies/${PRU}/intakes`).expect(404);
    });

    it('keeps a view-as session read-only', async () => {
      session.current = admin([PRU], true);
      const res = await http().get(`/product-data/intakes/${intakeId}`).expect(200);
      expect(res.body.canManage).toBe(false);
      await http().post(`/product-data/intakes/${intakeId}/items/${res.body.cards[0].id}/confirm`).expect(403);
    });
  });

  describe('P19.15-T2 the official illustration becomes the PDF’s detail', () => {
    const condensed = (formula: string): IllustrationReading => ({
      product: { asWritten: 'PRUCerah', id: CERAH, clear: true }, plan: null, illustrationDate: day('2026-11-01'),
      sampleInputs: [{ name: 'up', value: { asWritten: 'Rp500.000.000', value: '500000000', certain: true }, page: 1 }],
      blocks: [
        {
          block: 'manfaat', page: 2,
          rows: [{
            label: 'Meninggal dunia', note: null, formula, text: null, page: 2,
            evidence: [
              { page: 2, printed: { asWritten: '500.000.000', value: '500000000', certain: true }, inputs: [] },
              { page: 5, printed: { asWritten: '1.000.000.000', value: '1000000000', certain: true }, inputs: [{ name: 'up', value: { asWritten: '1.000.000.000', value: '1000000000', certain: true } }] },
            ],
          }],
        },
        { block: 'pengecualian', page: 7, rows: [{ label: 'Bunuh diri dalam 2 tahun pertama', note: null, formula: null, text: null, page: 7, evidence: [] }] },
      ],
      dropped: ['Deskripsi dana investasi'],
    });
    const base = `/product-data/companies/${PRU}`;

    it('P19.15-T2 AC-1 AC-2 condenses an uploaded PDF into blocks with their pages, each formula checked by our code', async () => {
      reader.illustration = condensed('100% × up');
      const res = await http().post(`${base}/products/${CERAH}/illustrations`).field('illustrationDate', '2026-11-01').attach('file', PDF, 'ilustrasi.pdf').expect(201);
      expect(res.body.status).toBe('reading');
      await settle();
      const view = (await http().get(`${base}/illustrations/${res.body.id}`).expect(200)).body;
      expect(view).toMatchObject({ status: 'draft', mismatches: 0, unchecked: 0, formulaNames: ['up'], sampleInputs: { up: 50_000_000_000 }, dropped: ['Deskripsi dana investasi'] });
      expect(view.blocks[0]).toMatchObject({ block: 'manfaat', page: 2, rows: [{ label: 'Meninggal dunia', formula: '100% × up', page: 2, check: { state: 'match' } }] });
      expect(view.blocks[1]).toMatchObject({ block: 'pengecualian', rows: [{ text: 'Tidak ditanggung' }] });
      expect(reader.illustrationCalls[0].product.formulaNames).toEqual(['up']);
    });

    it('P19.15-T2 AC-2 AC-3 flags a formula that does not match, refuses to publish it, and publishes once corrected', async () => {
      reader.illustration = condensed('2 × up');
      const res = await http().post(`${base}/products/${CERAH}/illustrations`).field('illustrationDate', '2026-11-01').attach('file', PDF, 'ilustrasi.pdf').expect(201);
      await settle();
      const view = (await http().get(`${base}/illustrations/${res.body.id}`)).body;
      expect(view.mismatches).toBe(1);
      expect((await http().post(`${base}/illustrations/${res.body.id}/publish`).expect(409)).body.error.code).toBe('ILLUSTRATION_FORMULA_MISMATCH');

      const row = view.blocks[0].rows[0];
      const edited = await http().patch(`${base}/illustrations/${res.body.id}`).send({
        blocks: [
          { block: 'manfaat', rows: [{ id: row.id, label: 'Meninggal dunia', note: null, formula: '100% × up', text: null }, { id: null, label: 'Rawat inap', note: null, formula: '1% × up', text: null }] },
          { block: 'pengecualian', rows: [{ id: view.blocks[1].rows[0].id, label: 'Bunuh diri 2 tahun pertama', note: null, formula: null, text: 'Tidak ditanggung' }] },
        ],
      }).expect(200);
      expect(edited.body.blocks[0].rows.map((r: { check: { state: string } }) => r.check.state)).toEqual(['match', 'unchecked']);

      const preview = await http().get(`${base}/illustrations/${res.body.id}/preview`).expect(200);
      expect(preview.body.rows.map((r: { label: string; value: string }) => [r.label, r.value])).toEqual(expect.arrayContaining([['Meninggal dunia', 'Rp\u00a0500\u00a0juta'], ['Rawat inap', 'Rp\u00a05\u00a0juta']]));
      expect(preview.body.fits).toBe(true);
      const pdf = await http().get(`${base}/illustrations/${res.body.id}/preview.pdf`).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');

      const published = await http().post(`${base}/illustrations/${res.body.id}/publish`).expect(200);
      expect(published.body.status).toBe('published');
      const product = await db().collection('products').findOne({ _id: oid(CERAH) });
      expect(product?.pdfDetail).toEqual([
        { block: 'manfaat', rows: [{ label: 'Meninggal dunia', note: null, formula: '100% × up', text: null }, { label: 'Rawat inap', note: null, formula: '1% × up', text: null }], source: { file: 'ilustrasi.pdf', page: 2, date: '2026-11-01' }, notGuaranteed: false },
        { block: 'pengecualian', rows: [{ label: 'Bunuh diri 2 tahun pertama', note: null, formula: null, text: 'Tidak ditanggung' }], source: { file: 'ilustrasi.pdf', page: 7, date: '2026-11-01' }, notGuaranteed: false },
      ]);
      expect(await db().collection('auditLog').countDocuments({ action: 'illustration.published' })).toBe(1);
      expect((await http().patch(`${base}/illustrations/${res.body.id}`).send({ blocks: [] }).expect(409)).body.error.code).toBe('ILLUSTRATION_NOT_DRAFT');
    });

    it('takes only a PDF and a real date, and is read-only for the Owner and refused to an agent', async () => {
      expect((await http().post(`${base}/products/${CERAH}/illustrations`).field('illustrationDate', '2026-11-01').attach('file', Buffer.from('MZ'), 'x.exe').expect(415)).body.error.code).toBe('ASSET_TYPE_NOT_ALLOWED');
      expect((await http().post(`${base}/products/${CERAH}/illustrations`).field('illustrationDate', '2027-01-01').attach('file', PDF, 'i.pdf').expect(400)).body.error.details.field).toBe('illustrationDate');
      session.current = owner();
      await http().get(`${base}/products/${CERAH}/illustrations`).expect(200);
      await http().post(`${base}/products/${CERAH}/illustrations`).field('illustrationDate', '2026-11-01').attach('file', PDF, 'i.pdf').expect(403);
      session.current = AGENT;
      await http().get(`${base}/products/${CERAH}/illustrations`).expect(403);
      session.current = otherAdmin();
      await http().get(`${base}/products/${CERAH}/illustrations`).expect(404);
    });

    it('P19.15-T3 AC-4 an illustration found by Unggah file is condensed in Ilustrasi once its card is confirmed', async () => {
      reader.files = [{ items: [item({ kind: 'illustration', effectiveFrom: day('2026-11-01') })], notes: null }];
      reader.illustration = condensed('100% × up');
      const res = await upload(`/product-data/companies/${PRU}/intakes`, [['ilustrasi-cerah.pdf', PDF]]).expect(201);
      await settle();
      const card = (await http().get(`/product-data/intakes/${res.body.id}`)).body.cards[0];
      const applied = await http().post(`/product-data/intakes/${res.body.id}/items/${card.id}/confirm`).expect(200);
      expect(applied.body.appliedRef.kind).toBe('illustration');
      await settle();
      const view = (await http().get(`${base}/illustrations/${applied.body.appliedRef.id}`).expect(200)).body;
      expect(view).toMatchObject({ status: 'draft', intakeItemId: card.id, fileName: 'ilustrasi-cerah.pdf', illustrationDate: '2026-11-01' });
    });
  });
});
