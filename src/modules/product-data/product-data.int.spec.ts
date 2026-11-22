import mongoose from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  AAB, ADMIN, AGENT, AB, FIXTURE_KPM, OWNER, productionPipe, session, StubAuth, SUPER_ADMIN, declaredPermissions,
} from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { productDataFor, sampleCsv, workbookOf } from '../../../test/product-data';
import { ProductDataAccess } from './product-data-access.service';
import { ProductDataController } from './product-data.controller';
import { ProductDataService } from './product-data.service';
import { ProductRulesService } from './product-rules.service';
import { RateTableService } from './rate-table.service';

/** 10:00 on 12 November 2026 in Jakarta. */
const NOW = new Date('2026-11-12T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER = '66f0000000000000000000c2';
const PCB = '66f0000000000000000003c1';
const MEDICAL = '66f0000000000000000003c2';
const FOREIGN = '66f0000000000000000003c3';
const RIDER = '66f0000000000000000003c4';
const JT = 1_000_000;
const rp = (rupiah: number) => rupiah * 100;

/** A KPM Admin holding *Kelola data produk* for the companies named (D2, ADR-0260). */
const manager = (companies: string[]) => new RequestContext('u-maya', 'none', {
  membershipId: 'mem-maya', kpmId: FIXTURE_KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: false, isKpmAdmin: true, directCount: 0,
}, null, null, false, false, undefined, companies);
/** The Super Admin viewing as the Owner: reads as the member, writes nothing (ADR-0206 §4). */
const VIEW_AS_OWNER = new RequestContext('u-owner', 'none', {
  membershipId: 'mem-a', kpmId: FIXTURE_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
}, 'root', null, false, true);

const PAY_TERMS = [
  { key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 60, default: true },
  { key: 'y15', label: '15 tahun', years: 15, toAge: null, single: false, maxEntryAge: 50, default: false },
];

/**
 * **P19.15-T1 and T4 AC-1 — the Proposal tab over HTTP** (ADR-0258): the overview, *Isian*, a premium table uploaded,
 * its columns confirmed, its gaps, its *Ketentuan*, its three test profiles, activation, versions by date, turning off,
 * deleting, the template and *Uji coba* — the guard, the pipe and the filter real; every role's access positive and
 * negative; another company `404`.
 */
describe('P19.15-T1 the Proposal tab — premium tables over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let pd: ReturnType<typeof productDataFor>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    pd = productDataFor(wired);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductDataController],
      providers: [
        { provide: ProductDataAccess, useValue: pd.access },
        { provide: ProductDataService, useValue: pd.data },
        { provide: RateTableService, useValue: pd.rateTables },
        { provide: ProductRulesService, useValue: pd.rules },
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
    const db = mongoose.connection.db!;
    await db.collection('companies').insertMany([
      { _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'prudential', deletedAt: null },
      { _id: new mongoose.Types.ObjectId(OTHER), name: 'Manulife', slug: 'manulife', deletedAt: null },
    ]);
    await db.collection('kpms').insertOne({ _id: new mongoose.Types.ObjectId(FIXTURE_KPM), companyId: COMPANY, code: '0417', timezone: 'Asia/Jakarta', deletedAt: null });
    await db.collection('users').insertOne({ _id: new mongoose.Types.ObjectId('66f0000000000000000002ff'), email: 'sa@x.test', fullName: 'Sari Admin', deletedAt: null });
    const base = (id: string, code: string, name: string, over: Record<string, unknown> = {}) => ({
      _id: new mongoose.Types.ObjectId(id), companyId: COMPANY, code, name, channel: 'conventional', category: 'ci', kind: 'base',
      attachesTo: [], currencies: ['IDR'], lifecycle: 'active', sortOrder: 1, version: 1, deletedAt: null, ...over,
    });
    await mongoose.model('ProductModel').create([
      base(PCB, 'PCB88', 'PRUCritical Benefit 88', {
        calcType: 'up_premium', smokerRated: true, entryAge: { min: 30, max: 40 }, payTerms: PAY_TERMS,
        upStep: rp(JT), upMin: rp(100 * JT), sortOrder: 1,
      }),
      base(MEDICAL, 'PRUWELL', 'PRUWell Medical', { category: 'health', calcType: 'plan_priced', sortOrder: 2 }),
      base(RIDER, 'RIDER', 'PRU Rider', { kind: 'rider', attachesTo: [PCB], sortOrder: 3 }),
      base(FOREIGN, 'ASING', 'Asing', { companyId: OTHER }),
    ]);
  });

  const api = () => request(app.getHttpServer());
  const at = `/product-data/companies/${COMPANY}`;
  const upload = (csv = sampleCsv(), from = '2026-04-01', name = 'tarif.csv') =>
    api().post(`${at}/products/${PCB}/rate-tables`).attach('file', Buffer.from(csv, 'utf8'), name).field('effectiveFrom', from);
  const MAP = { Usia: 'age', 'Jenis kelamin': 'gender', Merokok: 'smoker', 'Masa bayar': 'payTerm', 'Tarif per 1.000 UP': 'rate' };
  /** Three profiles printed by the (made-up) illustration: a man of 35, 10 years, Rp500 jt, monthly. */
  const CASES = (premium = rp(555_750)) => Array.from({ length: 3 }, () => ({
    age: 35, gender: 'male', smoker: false, payTerm: 'y10', payFrequency: 'monthly', amountMinor: rp(500 * JT), expectedMinor: premium,
  }));
  /** A table uploaded, mapped, its factors saved, tested and activated. */
  async function activeTable(from = '2026-04-01') {
    const draft = (await upload(sampleCsv(), from).expect(201)).body;
    await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP }).expect(200);
    await api().patch(`${at}/rate-tables/${draft.id}`).send({ frequencies: { monthly: 0.09, annual: 1 } }).expect(200);
    await api().put(`${at}/rate-tables/${draft.id}/tests`).send({ cases: CASES() }).expect(200);
    return (await api().post(`${at}/rate-tables/${draft.id}/activate`).send({}).expect(200)).body;
  }

  it('declares a permission on every route', () => {
    expect(declaredPermissions(ProductDataController)).toEqual({
      overview: 'product_data:read', detail: 'product_data:read', saveRules: 'product_data:manage', template: 'product_data:read',
      upload: 'product_data:manage', tryIt: 'product_data:read', readTable: 'product_data:read', updateTable: 'product_data:manage',
      tests: 'product_data:manage', activate: 'product_data:manage', turnOff: 'product_data:manage', remove: 'product_data:manage',
    });
  });

  describe('P19.15-T4 AC-1 the overview: four counters, one row per product, Perlu dicek first', () => {
    it('every product types until a table is in force; riders and another company’s are not listed', async () => {
      const res = await api().get(`${at}/products`).expect(200);
      expect(res.body).toMatchObject({
        company: { id: COMPANY, name: 'Prudential' }, canManage: true,
        counters: { check: 0, manual: 2, ready: 0, withdrawn: 0 },
      });
      expect(res.body.products.map((p: { code: string }) => p.code)).toEqual(['PCB88', 'PRUWELL']);
      expect(res.body.products[0]).toMatchObject({
        calcType: 'up_premium', status: 'manual', isSyariah: false,
        table: { state: 'none', id: null }, illustration: { state: 'none', blocks: 0 },
      });
    });

    it('a table in force is Siap hitung; one with gaps or ending within 30 days is Perlu dicek, sorted first', async () => {
      const table = await activeTable();
      let res = await api().get(`${at}/products`).expect(200);
      // The sample covers ages 30–40, both genders and the smoker rate, 10 years only: 15 tahun is a gap.
      expect(res.body.products[0]).toMatchObject({ code: 'PCB88', status: 'check', checkReasons: ['gaps'], table: { state: 'gaps', gapCount: 1, effectiveFrom: '2026-04-01' } });
      await mongoose.model('RateTable').updateOne({ _id: table.id }, { $set: { gapCount: 0, gaps: [], effectiveTo: '2026-12-01' } });
      res = await api().get(`${at}/products`).expect(200);
      expect(res.body.products[0]).toMatchObject({ status: 'check', checkReasons: ['ending'], table: { state: 'ending', effectiveTo: '2026-12-01' } });
      await mongoose.model('RateTable').updateOne({ _id: table.id }, { $set: { effectiveTo: null } });
      res = await api().get(`${at}/products`).expect(200);
      expect(res.body.counters).toEqual({ check: 0, manual: 1, ready: 1, withdrawn: 0 });
      expect(res.body.products.map((p: { status: string }) => p.status)).toEqual(['manual', 'ready']);
      expect(res.body.lastUpdated).toMatchObject({ at: expect.any(String) });
    });

    it('a product changed in the catalogue after its table was made is Perlu dicek', async () => {
      const table = await activeTable();
      await mongoose.model('RateTable').updateOne({ _id: table.id }, { $set: { gapCount: 0, gaps: [] } });
      await mongoose.model('ProductModel').updateOne({ _id: PCB }, { $set: { smokerRated: false } });
      const res = await api().get(`${at}/products`).expect(200);
      expect(res.body.products[0]).toMatchObject({ status: 'check', checkReasons: ['changed'] });
    });

    it('a withdrawn product is Ditarik', async () => {
      await mongoose.model('ProductModel').updateOne({ _id: MEDICAL }, { $set: { lifecycle: 'withdrawn' } });
      const res = await api().get(`${at}/products`).expect(200);
      expect(res.body.counters.withdrawn).toBe(1);
      expect(res.body.products.at(-1)).toMatchObject({ code: 'PRUWELL', status: 'withdrawn' });
    });
  });

  describe('P19.15-T1 AC-1 upload, Cocokkan kolom, Cek kelengkapan', () => {
    it('P19.15-T1 AC-1 a CSV becomes a draft, its columns suggested, its first rows shown', async () => {
      const res = await upload().expect(201);
      expect(res.body).toMatchObject({
        version: 1, status: 'draft', effectiveFrom: '2026-04-01', effectiveTo: null, mapped: false, rowCount: 0,
        source: { fileName: 'tarif.csv', type: 'csv' }, rulesSource: 'catalogue', rulesConfirmed: true,
        file: { header: Object.keys(MAP), columnMap: MAP, rows: 44, ketentuan: false },
        previous: { from: 'catalogue', rules: { upStep: rp(JT), upMin: rp(100 * JT), entryAgeMin: 30, entryAgeMax: 40, payTermMaxAge: { y10: 60, y15: 50 } } },
      });
      expect(res.body.file.preview).toHaveLength(5);
      const audit = await mongoose.model('AuditLogModel').findOne({ action: 'rate_table.uploaded' }).lean();
      expect(audit).toMatchObject({ targetCollection: 'rateTables', after: { companyId: COMPANY, productId: PCB, rows: 44 } });
    });

    it('P19.15-T1 AC-1 the columns confirmed: the rows read, every gap listed in plain words’ terms', async () => {
      const draft = (await upload().expect(201)).body;
      const res = await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP }).expect(200);
      expect(res.body).toMatchObject({ mapped: true, basis: 'per_mille', rowCount: 44, gapCount: 1 });
      expect(res.body.gaps).toEqual([{ kind: 'payTerm', payTerm: 'y15', payTermLabel: '15 tahun' }]);
      expect(await mongoose.model('RateRow').countDocuments({ rateTableId: draft.id, deletedAt: null })).toBe(44);
      // Again, under other columns: the earlier rows are soft-deleted, never left to price anything.
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP }).expect(200);
      expect(await mongoose.model('RateRow').countDocuments({ rateTableId: draft.id, deletedAt: null })).toBe(44);
      expect(await mongoose.model('RateRow').countDocuments({ rateTableId: draft.id })).toBe(88);
    });

    it('P19.15-T1 AC-1 never guesses: unreadable cells are 422 with their rows, nothing written', async () => {
      const draft = (await upload(`${sampleCsv()}\r\n41;X;Tidak;10 tahun;abc`).expect(201)).body;
      const res = await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP }).expect(422);
      expect(res.body.error.code).toBe('RATE_TABLE_ROWS_INVALID');
      expect(res.body.error.details).toMatchObject({ count: 2, problems: [{ row: 46, column: 'Jenis kelamin', value: 'X', reason: 'gender' }, { row: 46, reason: 'number' }] });
      expect(await mongoose.model('RateRow').countDocuments({ rateTableId: draft.id })).toBe(0);
    });

    it('a mapping the file cannot take is 400 naming why', async () => {
      const draft = (await upload().expect(201)).body;
      const res = await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: { Usia: 'age' } }).expect(400);
      expect(res.body.error.details).toMatchObject({ field: 'columnMap', kind: 'rateColumn' });
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: { Nope: 'age' } }).expect(400);
      await api().patch(`${at}/rate-tables/${draft.id}`).send({}).expect(400);
    });

    it('P19.15-T1 AC-1 an Excel workbook’s Data sheet; a PDF goes through Unggah file; dates checked', async () => {
      const book = await workbookOf(sampleCsv().split('\r\n').map((l) => l.split(';')));
      const res = await api().post(`${at}/products/${PCB}/rate-tables`).attach('file', book, 'tarif.xlsx')
        .field('effectiveFrom', '2026-04-01').field('effectiveTo', '2027-03-31').expect(201);
      expect(res.body).toMatchObject({ source: { type: 'xlsx' }, effectiveTo: '2027-03-31', file: { rows: 44 } });
      const pdf = await api().post(`${at}/products/${PCB}/rate-tables`).attach('file', Buffer.from('%PDF-1.7 …'), 't.pdf')
        .field('effectiveFrom', '2026-04-01').expect(422);
      expect(pdf.body.error.code).toBe('UPLOAD_MALFORMED_CSV');
      await upload(sampleCsv(), '1 April').expect(400);
      await api().post(`${at}/products/${PCB}/rate-tables`).attach('file', Buffer.from(sampleCsv()), 'a.csv')
        .field('effectiveFrom', '2026-04-01').field('effectiveTo', '2026-03-01').expect(400);
      await api().post(`${at}/products/${PCB}/rate-tables`).field('effectiveFrom', '2026-04-01').expect(400);
      await api().post(`${at}/products/${PCB}/rate-tables`).attach('file', Buffer.from('\n\n'), 'a.csv').field('effectiveFrom', '2026-04-01').expect(422);
      const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
      const big = await api().post(`${at}/products/${PCB}/rate-tables`).attach('file', tooBig, 'a.csv').field('effectiveFrom', '2026-04-01').expect(413);
      expect(big.body.error.code).toBe('ASSET_TOO_LARGE');
    });

    it('P19.15-T1 AC-1 the template: the product’s own columns, and Ketentuan filled with what it would replace', async () => {
      const res = await api().get(`${at}/products/${PCB}/rate-tables/template`).buffer(true)
        .parse((r, done) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => done(null, Buffer.concat(chunks))); })
        .expect(200);
      expect(res.headers['content-disposition']).toContain('Tabel-premi-PCB88.xlsx');
      const book = new Workbook();
      await book.xlsx.load(res.body);
      expect((book.getWorksheet('Data')!.getRow(1).values as unknown[]).slice(1)).toEqual(['Usia', 'Jenis kelamin', 'Merokok', 'Masa bayar', 'Tarif per 1.000 UP']);
      const ketentuan = book.getWorksheet('Ketentuan')!;
      expect(ketentuan.getRow(2).values).toEqual([undefined, 'UP kelipatan', '1000000']);
      const csv = await api().get(`${at}/products/${PCB}/rate-tables/template?format=csv`).expect(200);
      expect(csv.text).toContain('Usia,Jenis kelamin,Merokok,Masa bayar,Tarif per 1.000 UP');
    });
  });

  describe('P19.15-T1 AC-4 Ketentuan: read from the file, shown old → new, confirmed before activation', () => {
    it('the rules read; activation waits until a person saves them', async () => {
      const book = await workbookOf(sampleCsv().split('\r\n').map((l) => l.split(';')), [
        ['Ketentuan', 'Nilai'], ['UP minimum', '150.000.000'], ['Faktor bulanan', '0,09'], ['Usia masuk maks. 10 tahun', '55'], ['Diskon', '5%'],
      ]);
      const draft = (await api().post(`${at}/products/${PCB}/rate-tables`).attach('file', book, 'tarif.xlsx').field('effectiveFrom', '2026-04-01').expect(201)).body;
      expect(draft).toMatchObject({
        rulesSource: 'ketentuan', rulesConfirmed: false,
        rules: { upMin: rp(150 * JT), upStep: rp(JT), payTermMaxAge: { y10: 55 } }, frequencies: { monthly: 0.09 },
        previous: { rules: { upMin: rp(100 * JT) } },
        file: { ketentuan: true, ketentuanProblems: [{ label: 'Diskon', value: '5%' }] },
      });
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP }).expect(200);
      await api().put(`${at}/rate-tables/${draft.id}/tests`).send({ cases: CASES() }).expect(200);
      const refused = await api().post(`${at}/rate-tables/${draft.id}/activate`).send({}).expect(422);
      expect(refused.body.error).toMatchObject({ code: 'RATE_TABLE_NOT_READY', details: { reason: 'rules' } });
      const saved = await api().patch(`${at}/rate-tables/${draft.id}`).send({ rules: { ...draft.rules, upMin: rp(150 * JT) }, frequencies: draft.frequencies }).expect(200);
      expect(saved.body).toMatchObject({ rulesConfirmed: true, rulesSource: 'ketentuan' });
      await api().post(`${at}/rate-tables/${draft.id}/activate`).send({}).expect(200);
    });

    it('a rule out of order or of the wrong shape is 400', async () => {
      const draft = (await upload().expect(201)).body;
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ rules: { upMin: 5, upMax: 1 } }).expect(400);
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ rules: { upStep: 0 } }).expect(400);
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ rules: { payTermMaxAge: [] } }).expect(400);
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ frequencies: { monthly: 2 } }).expect(400);
    });
  });

  describe('P19.15-T1 AC-2 Uji 3 contoh, then activation', () => {
    it('P19.15-T1 AC-2 three profiles, each with the app’s result beside it; activation refused until they match or a reason is written', async () => {
      const draft = (await upload().expect(201)).body;
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP, frequencies: { monthly: 0.09 } }).expect(200);
      await api().put(`${at}/rate-tables/${draft.id}/tests`).send({ cases: CASES().slice(0, 2) }).expect(400);
      const tested = await api().put(`${at}/rate-tables/${draft.id}/tests`).send({ cases: CASES(rp(555_752)) }).expect(200);
      expect(tested.body.testCases[0]).toMatchObject({ expectedMinor: rp(555_752), actualMinor: rp(555_750), match: false });
      const refused = await api().post(`${at}/rate-tables/${draft.id}/activate`).send({}).expect(422);
      expect(refused.body.error.details).toMatchObject({ reason: 'tests', tests: [{ match: false }, { match: false }, { match: false }] });
      // Within Rp1 is a match.
      const close = await api().put(`${at}/rate-tables/${draft.id}/tests`).send({ cases: CASES(rp(555_751)) }).expect(200);
      expect(close.body.testCases.every((c: { match: boolean }) => c.match)).toBe(true);
      const activated = await api().post(`${at}/rate-tables/${draft.id}/activate`).send({}).expect(200);
      expect(activated.body).toMatchObject({ status: 'active', overrideReason: null, file: null, activatedBy: { id: 'root' } });
      const product = await mongoose.model('ProductModel').findById(PCB).lean() as unknown as { rateTableId: string };
      expect(product.rateTableId).toBe(draft.id);
    });

    it('P19.15-T1 AC-2 a written reason activates a version whose profiles do not match', async () => {
      const draft = (await upload().expect(201)).body;
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP }).expect(200);
      const res = await api().post(`${at}/rate-tables/${draft.id}/activate`).send({ overrideReason: 'Ilustrasi pakai tarif lama' }).expect(200);
      expect(res.body.overrideReason).toBe('Ilustrasi pakai tarif lama');
      await api().post(`${at}/rate-tables/${(await upload().expect(201)).body.id}/activate`).send({ overrideReason: 'x' }).expect(422);
    });

    it('activation needs columns and rows', async () => {
      const draft = (await upload().expect(201)).body;
      const unmapped = await api().post(`${at}/rate-tables/${draft.id}/activate`).send({ overrideReason: 'x' }).expect(422);
      expect(unmapped.body.error.details.reason).toBe('unmapped');
      await mongoose.model('RateTable').updateOne({ _id: draft.id }, { $set: { mappedAt: new Date() } });
      const empty = await api().post(`${at}/rate-tables/${draft.id}/activate`).send({ overrideReason: 'x' }).expect(422);
      expect(empty.body.error.details.reason).toBe('no_rows');
      await api().post(`${at}/rate-tables/${draft.id}/activate`).send({ overrideReason: 'x'.repeat(501) }).expect(400);
    });
  });

  describe('P19.15-T1 AC-3 versions by date: in force from 00:00 on Berlaku mulai, never edited, deleted only unused', () => {
    it('P19.15-T1 AC-3 a version with a future date is scheduled, and in force from its day with no job', async () => {
      const april = await activeTable('2026-04-01');
      const december = await activeTable('2026-12-01');
      expect(december).toMatchObject({ version: 2, status: 'scheduled' });
      let detail = await api().get(`${at}/products/${PCB}`).expect(200);
      expect(detail.body).toMatchObject({ inForce: { id: april.id, version: 1 }, scheduled: { id: december.id, effectiveFrom: '2026-12-01' } });
      expect(detail.body.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, 'scheduled'], [1, 'active']]);
      const overview = await api().get(`${at}/products`).expect(200);
      expect(overview.body.products.find((p: { code: string }) => p.code === 'PCB88').table.scheduledFrom).toBe('2026-12-01');
      // 00:05 on 1 December in Jakarta is still 30 November in UTC.
      const later = productDataFor(wired, new Date('2026-11-30T17:05:00Z'));
      expect((await later.rateTables.inForce(PCB, later.rateTables.today()))?.version).toBe(2);
      detail = { body: await later.data.detail(SUPER_ADMIN, COMPANY, PCB) } as never;
      expect(detail.body.versions.map((v: { status: string }) => v.status)).toEqual(['active', 'old']);
    });

    it('P19.15-T1 AC-3 an activated version is never edited', async () => {
      const table = await activeTable();
      for (const call of [
        api().patch(`${at}/rate-tables/${table.id}`).send({ effectiveFrom: '2026-05-01' }),
        api().put(`${at}/rate-tables/${table.id}/tests`).send({ cases: CASES() }),
        api().post(`${at}/rate-tables/${table.id}/activate`).send({}),
      ]) {
        const res = await call.expect(409);
        expect(res.body.error).toMatchObject({ code: 'RATE_TABLE_NOT_EDITABLE', details: { status: 'active' } });
      }
    });

    it('P19.15-T1 AC-3 turning off returns the product to the version before it, then to typing', async () => {
      const april = await activeTable('2026-04-01');
      const may = await activeTable('2026-05-01');
      const off = await api().post(`${at}/rate-tables/${may.id}/turn-off`).expect(200);
      expect(off.body.status).toBe('off');
      expect((await pd.rateTables.inForce(PCB, '2026-11-12'))?.id).toBe(april.id);
      await api().post(`${at}/rate-tables/${april.id}/turn-off`).expect(200);
      expect(await pd.rateTables.inForce(PCB, '2026-11-12')).toBeNull();
      expect((await mongoose.model('ProductModel').findById(PCB).lean() as unknown as { rateTableId: string | null }).rateTableId).toBeNull();
      const again = await api().post(`${at}/rate-tables/${april.id}/turn-off`).expect(409);
      expect(again.body.error.code).toBe('RATE_TABLE_NOT_EDITABLE');
      const draft = (await upload().expect(201)).body;
      await api().post(`${at}/rate-tables/${draft.id}/turn-off`).expect(409);
      const audit = await mongoose.model('AuditLogModel').findOne({ action: 'rate_table.turned_off' }).lean();
      expect(audit).toMatchObject({ before: { companyId: COMPANY, productId: PCB, status: 'active' }, after: { companyId: COMPANY, productId: PCB, status: 'off' } });
    });

    it('P19.15-T1 AC-3 a version no proposal used is deleted; one used is 409', async () => {
      const draft = (await upload().expect(201)).body;
      await api().delete(`${at}/rate-tables/${draft.id}`).expect(204);
      await api().get(`${at}/rate-tables/${draft.id}`).expect(404);
      const used = await activeTable();
      await pd.calculator.markUsed(used.id);
      const res = await api().delete(`${at}/rate-tables/${used.id}`).expect(409);
      expect(res.body.error.code).toBe('RATE_TABLE_IN_USE');
    });

    it('a version of another company, or an id that is nobody’s, is 404', async () => {
      const table = await activeTable();
      await api().get(`/product-data/companies/${OTHER}/rate-tables/${table.id}`).expect(404);
      await api().get(`${at}/rate-tables/nope`).expect(404);
      await api().get(`${at}/products/${FOREIGN}`).expect(404);
      await api().post(`/product-data/companies/${OTHER}/products/${PCB}/rate-tables`).attach('file', Buffer.from(sampleCsv()), 'a.csv').field('effectiveFrom', '2026-04-01').expect(404);
    });
  });

  describe('P19.15-T1 AC-4 Isian: the catalogue’s rules as forms, audited', () => {
    it('saves through the catalogue’s own checks, pinned, with before and after', async () => {
      const res = await api().patch(`${at}/products/${PCB}/rules`).send({ expectedVersion: 1, upMin: rp(150 * JT), smokerRated: false }).expect(200);
      expect(res.body.product).toMatchObject({ version: 2, rules: { upMin: rp(150 * JT), smokerRated: false } });
      const audit = await mongoose.model('AuditLogModel').findOne({ action: 'product_rules.updated' }).lean();
      // The company and the product on both sides: *Perubahan oleh pengelola* reads them from the entry (ADR-0260 §6).
      expect(audit).toMatchObject({
        before: { companyId: COMPANY, productId: PCB, upMin: rp(100 * JT), smokerRated: true },
        after: { companyId: COMPANY, productId: PCB, upMin: rp(150 * JT), smokerRated: false },
      });
      await api().patch(`${at}/products/${PCB}/rules`).send({ expectedVersion: 1, upMin: 1 }).expect(409);
      const bad = await api().patch(`${at}/products/${PCB}/rules`).send({ expectedVersion: 2, upMin: 5, upMax: 1 }).expect(400);
      expect(bad.body.error.details.field).toBe('upMin');
      await api().patch(`${at}/products/${PCB}/rules`).send({ expectedVersion: 2, rateTableId: 'x' }).expect(400);
    });

    it('proposes a change without writing it (Unggah file’s cards)', async () => {
      const proposed = await pd.rules.proposeChange(COMPANY, PCB, { upMin: rp(150 * JT), upStep: rp(JT) });
      expect(proposed).toMatchObject({ before: { upMin: rp(100 * JT) }, after: { upMin: rp(150 * JT) }, changed: ['upMin'] });
      expect((await mongoose.model('ProductModel').findById(PCB).lean() as unknown as { upMin: number }).upMin).toBe(rp(100 * JT));
    });
  });

  describe('P19.15-T1 AC-7 Uji coba: the agent’s card, nothing stored', () => {
    it('the premium, the UP rounding and the limits, as the card calculates them', async () => {
      await activeTable();
      const up = await api().post(`${at}/products/${PCB}/try`).send({ age: 35, gender: 'male', patch: { up: { amountMinor: rp(500 * JT) } } }).expect(200);
      expect(up.body.item).toMatchObject({
        fixedField: 'up', premium: { amountMinor: rp(555_750) }, rateTableEffectiveFrom: '2026-04-01', payTerm: 'y10', payFrequency: 'monthly',
        totalPaid: { amountMinor: rp(555_750) * 12 * 10, years: 10 }, calc: { state: 'ok', frequencies: ['monthly', 'annual'] },
      });
      expect(up.body.box).toMatchObject({ title: 'PRUCritical Benefit 88', source: expect.stringContaining('Tabel tarif berlaku') });
      const premium = await api().post(`${at}/products/${PCB}/try`).send({
        age: 35, gender: 'male', state: up.body.item, patch: { premium: { amountMinor: rp(600_000) } },
      }).expect(200);
      expect(premium.body.item).toMatchObject({ fixedField: 'premium', up: { amountMinor: rp(539 * JT) }, premium: { amountMinor: rp(599_099) }, calcNote: 'up_rounded' });
      const small = await api().post(`${at}/products/${PCB}/try`).send({ age: 35, gender: 'male', patch: { up: { amountMinor: rp(50 * JT) } } }).expect(200);
      expect(small.body.item.calc.limit).toEqual({ kind: 'up_min', limitMinor: rp(100 * JT), chip: { field: 'up', amountMinor: rp(100 * JT) } });
      const missing = await api().post(`${at}/products/${PCB}/try`).send({ age: 35, gender: 'male', patch: { payTerm: 'y15', up: { amountMinor: rp(500 * JT) } } }).expect(200);
      expect(missing.body.item).toMatchObject({ premium: null, calc: { state: 'missing_combination' } });
    });

    it('a named version (a draft too); one not this product’s is 400; a bad patch is the item’s own 400', async () => {
      const draft = (await upload().expect(201)).body;
      await api().patch(`${at}/rate-tables/${draft.id}`).send({ columnMap: MAP }).expect(200);
      const res = await api().post(`${at}/products/${PCB}/try`).send({ age: 35, gender: 'male', rateTableId: draft.id, patch: { payFrequency: 'annual', up: { amountMinor: rp(500 * JT) } } }).expect(200);
      expect(res.body.item.premium.amountMinor).toBe(rp(6_175_000));
      await api().post(`${at}/products/${PCB}/try`).send({ age: 35, gender: 'male', rateTableId: '66f0000000000000000009ff' }).expect(400);
      await api().post(`${at}/products/${PCB}/try`).send({ age: 35, gender: 'male', patch: { payTerm: 'nope' } }).expect(400);
      await api().post(`${at}/products/${PCB}/try`).send({ age: 0, gender: 'male' }).expect(400);
      // No table: typed, as the agent’s card is.
      const manual = await api().post(`${at}/products/${MEDICAL}/try`).send({ age: 35, gender: 'female' }).expect(200);
      expect(manual.body.item).toMatchObject({ calc: null, premium: null });
    });
  });

  describe('P19.15-T4 AC-3 who reaches it', () => {
    it('P19.15-T4 AC-3 the KPM Owner and Admin read their own company, read-only; another company is 404', async () => {
      const table = await activeTable();
      for (const reader of [OWNER, ADMIN]) {
        session.current = reader;
        const res = await api().get(`${at}/products`).expect(200);
        expect(res.body.canManage).toBe(false);
        await api().get(`${at}/products/${PCB}`).expect(200);
        await api().get(`/product-data/companies/${OTHER}/products`).expect(404);
        const refused = await api().patch(`${at}/products/${PCB}/rules`).send({ expectedVersion: 1, upMin: 1 }).expect(403);
        expect(refused.body.error.code).toBe('PERM_DENIED');
        await api().post(`${at}/rate-tables/${table.id}/turn-off`).expect(403);
      }
    });

    it('P19.15-T4 AC-3 agents and leaders cannot reach it', async () => {
      for (const reader of [AGENT, AB, AAB]) {
        session.current = reader;
        await api().get(`${at}/products`).expect(403);
        await api().post(`${at}/products/${PCB}/try`).send({ age: 35, gender: 'male' }).expect(403);
        await api().patch(`${at}/products/${PCB}/rules`).send({ expectedVersion: 1, upMin: 1 }).expect(403);
        await upload().expect(403);
      }
    });

    it('P19.15-T4 AC-2 a Kelola data produk holder manages the companies ticked only', async () => {
      session.current = manager([COMPANY]);
      await upload().expect(201);
      session.current = manager([OTHER]);
      // Her own company, not ticked: read-only. Another, ticked: hers.
      await api().get(`${at}/products`).expect(200);
      await upload().expect(403);
      const other = await api().get(`/product-data/companies/${OTHER}/products`).expect(200);
      expect(other.body.canManage).toBe(true);
    });

    // A holder's change to an insurer's data is the platform's record, never their office's: its Owner reads that log.
    it('P19.15-T4 AC-2 a holder’s change is written in the platform’s log, not in their own office’s', async () => {
      session.current = manager([COMPANY]);
      await upload().expect(201);
      const rows = await mongoose.connection.db!.collection('auditLog')
        .find({ action: { $regex: /^rate_table\./ }, actorUserId: 'u-maya' }).toArray();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.kpmId === null && row.actorMembershipId === 'mem-maya')).toBe(true);
      expect(await mongoose.connection.db!.collection('auditLog').countDocuments({ kpmId: FIXTURE_KPM, action: { $regex: /^rate_table\./ } }))
        .toBe(0);
    });

    it('the Super Admin viewing as the Owner reads, and writes nothing', async () => {
      session.current = VIEW_AS_OWNER;
      const res = await api().get(`${at}/products`).expect(200);
      expect(res.body.canManage).toBe(false);
      await api().patch(`${at}/products/${PCB}/rules`).send({ expectedVersion: 1, upMin: 1 }).expect(403);
    });

    it('an unknown company is 404 for the Super Admin too', async () => {
      await api().get('/product-data/companies/66f0000000000000000000ff/products').expect(404);
      await api().get('/product-data/companies/nope/products').expect(404);
    });
  });
});
