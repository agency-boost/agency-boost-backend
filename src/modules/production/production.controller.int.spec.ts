import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  ADMIN, declaredPermissions, FIXTURE_KPM, NOT_ADMINISTRATORS, OWNER, productionPipe, session,
  StubAuth, SUPER_ADMIN,
} from '../../../test/http-permissions';
import { createHash } from 'node:crypto';
import { Workbook } from 'exceljs';
import { zipSync } from 'fflate';
import { PRODUCTION_UPLOAD, XLSX_MIME_TYPE } from '@/domain/constants';
import { ProductionController } from './production.controller';
import { TEMPLATE_HEADER_V1, TEMPLATE_HEADER_V2 } from './production-template';
import { ProductionService } from './production.service';
import { ProductionImportService } from './production-import.service';
import { ProductionMonths } from './production-months.service';
import { ProductionMonth } from './production-month.schema';
import { ProductionCorrections } from './production-correction.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-27T02:00:00Z');

/** A binary answer, kept as bytes. */
const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};
const COMPANY = '66f0000000000000000000c1';
const RINA = '66f000000000000000000101';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  template: 'data_upload:download_template',
  preview: 'data_upload:upload_and_preview',
  commit: 'data_upload:commit_import',
  revert: 'data_upload:revert_batch',
  history: 'data_upload:read_history',
  lock: 'data_upload:lock_month',
  reopen: 'data_upload:reopen_month',
  correct: 'data_upload:correct_cell',
  readMonth: 'data_upload:read',
};

/**
 * The month table over HTTP (P9-T1 AC-5, AC-7).
 *
 * `production.tenancy.spec.ts` proves the rules through the service. What only a request can answer
 * is here: that the route declares the grant it should, and that §3.9 is what the guard enforces —
 * an Owner and an Admin may read the office's production, and nobody below them may.
 */
describe('production over HTTP (P9-T1)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductionController],
      providers: [
        { provide: ProductionService, useValue: wired.production },
        { provide: ProductionImportService, useValue: wired.productionImport },
        { provide: ProductionMonths, useValue: wired.productionMonths },
        { provide: ProductionCorrections, useValue: wired.productionCorrections },
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
    session.current = OWNER;
    await clearCollections();
    // The first claim on a month is made safe by its unique index, which has to exist to enforce it.
    await mongoose.model(ProductionMonth.name).syncIndexes();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    });
    await mongoose.connection.db!.collection('memberships').insertOne({
      _id: new mongoose.Types.ObjectId(RINA), kpmId: FIXTURE_KPM, userId: '66f000000000000000000301',
      agentCode: 'PRU-001', agentSeq: 1, leaderCode: 'LC-101', orgLevelCode: 'AGENT',
      hierarchyRole: 'agent', leaderId: null, ancestorIds: [], status: 'active', deletedAt: null,
    } as never);
    await mongoose.connection.db!.collection('users').insertOne({
      _id: new mongoose.Types.ObjectId('66f000000000000000000301'),
      email: 'rina@kpm.test', fullName: 'Rina Wijaya', deletedAt: null,
    } as never);
  });

  it('declares a permission on every route, and the right one', () => {
    expect(declaredPermissions(ProductionController)).toEqual(ROUTES);
  });

  it('answers the Owner the office’s month, every member a row', async () => {
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ month: '2026-09', withData: 0 });
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ name: 'Rina Wijaya', agentCode: 'PRU-001' });
    expect(res.body.rows[0].values.APE).toEqual({ value: null, provenance: null, correction: null, outOfBounds: null });
    // P19.5-T2: the template's columns, the history, the grid and the completeness ride with the month (ADR-0214 §14).
    expect(res.body.config).toMatchObject({ templateId: null, version: 1, historyFrom: expect.stringMatching(/^\d{4}-\d{2}$/), completePct: 90 });
    expect(res.body.config.columns.map((c: { kode: string }) => c.kode)).toContain('APE');
    expect(res.body).toMatchObject({ unregistered: [], completeness: { month: '2026-09', status: 'missing' } });
    // Not reported is sent as `null`, not dropped: a missing key and `false` would read alike.
    expect(res.body.rows[0]).toHaveProperty('monthlyActiveAgent', null);
  });

  it('OD-21: carries each row’s Monthly Active Agent as the metric computes it (ADR-0054)', async () => {
    const figure = (value: number) => ({ value, provenance: 'imported', sourceBatchId: 'batch-1' });
    await mongoose.connection.db!.collection('monthlyAgentData').insertOne({
      kpmId: FIXTURE_KPM, membershipId: RINA, month: '2026-09', agentCode: 'PRU-001', deletedAt: null,
      templateVersion: 1, values: { APE: figure(0), POLICY_COUNT: figure(0) },
    } as never);
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
    expect(res.body.rows[0].monthlyActiveAgent).toBe(false);
  });

  it('answers the Admin the same — §3.9 grants both', async () => {
    session.current = ADMIN;
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
    expect(res.status).toBe(200);
  });

  describe('AC-5 — who may not', () => {
    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))(
      'refuses %s: production is the office’s business, not a rung’s',
      async (_who, ctx) => {
        session.current = ctx;
        const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
        expect(res.status).toBe(403);
      },
    );

    it('P19.4-T2 AC-4 refuses a Super Admin by the permission: the data upload is the office’s (ADR-0206 §2)', async () => {
      // §3.9 granted them `all` until P19.4-T2, and the service refused them for having no office. The guard does now.
      session.current = SUPER_ADMIN;
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
      expect([res.status, res.body.error?.code, res.body.error?.details?.permission])
        .toEqual([403, 'PERM_DENIED', 'data_upload:read']);
    });
  });

  describe('the template (P9-T2)', () => {
    it('answers the Owner the file, named for the office and the month', async () => {
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        month: '2026-09', version: 1, filename: '0417-agent-data-2026-09.csv', rowCount: 1,
      });
      // P19.5-T2 AC-1: an empty field per column of the template — its seven.
      expect(res.body.file.split('\n')[1]).toBe('PRU-001,"Rina Wijaya",,,,,,,');
      expect(res.body.header[2]).toMatch(/^APE \(Rp (M|juta)\) \[APE\]$/);
    });

    it('is reached as itself, not as a month called "template"', async () => {
      // Declaration order: `template` above `:month`, or Nest reads the word as a bad month.
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09');
      expect(res.body.error).toBeUndefined();
    });

    it('answers the Admin the same — §3.9 grants both', async () => {
      session.current = ADMIN;
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09');
      expect(res.status).toBe(200);
    });

    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))(
      'refuses %s a file in the office’s name',
      async (_who, ctx) => {
        session.current = ctx;
        const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09');
        expect(res.status).toBe(403);
      },
    );

    it('P19.4-T2 AC-4 refuses a Super Admin the template by the permission (ADR-0206 §2)', async () => {
      session.current = SUPER_ADMIN;
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09');
      expect([res.status, res.body.error.code, res.body.error.details?.permission])
        .toEqual([403, 'PERM_DENIED', 'data_upload:download_template']);
    });

    it('refuses a missing or malformed month with a code a client can branch on', async () => {
      for (const q of ['', '?month=', '?month=Sep-2026']) {
        const res = await request(app.getHttpServer()).get(`/kpm/data-upload/template${q}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('ADR-0184: answers format=xlsx with the month’s template as a workbook, named as the CSV is, its guide the reader’s', async () => {
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09&format=xlsx')
        .set('Accept-Language', 'id').buffer(true).parse(binary).expect(200);
      expect(res.headers['content-type']).toBe(XLSX_MIME_TYPE);
      expect(res.headers['content-disposition']).toBe('attachment; filename="0417-agent-data-2026-09.xlsx"');
      const workbook = new Workbook();
      await workbook.xlsx.load(res.body as unknown as Parameters<Workbook['xlsx']['load']>[0]);
      expect(workbook.worksheets.map((w) => w.name)).toEqual(['Petunjuk', 'Data']);
      expect((workbook.getWorksheet('Data')!.getRow(2).values as unknown[]).slice(1)).toEqual(['PRU-001', 'Rina Wijaya']);
    });

    it('ADR-0184: refuses a format the template does not come in, and a bad month in the workbook’s too', async () => {
      const csv = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09&format=csv').expect(400);
      expect(csv.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { violations: ['That is not a format the template comes in. Ask for format=xlsx, or for no format to have the CSV.'] },
      });
      const month = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=Sep-2026&format=xlsx').expect(400);
      expect(month.body.error.code).toBe('VALIDATION_FAILED');
    });

    /*
     * **S4 (the T17–T20 permission review): the query is a DTO** — a format that is no file, an operator object in
     * place of a string, and a field nobody declared are each a 400 before the office is read.
     */
    it.each([
      ['format=pdf', '?month=2026-09&format=pdf'],
      ['format as an operator object', '?month=2026-09&format[$ne]=csv'],
      ['month as an operator object', '?month[$ne]=2026-09'],
      ['an undeclared field', '?month=2026-09&office=0417'],
    ])('S4 refuses %s with 400 VALIDATION_FAILED', async (_what, query) => {
      const res = await request(app.getHttpServer()).get(`/kpm/data-upload/template${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    /* S5: every role below the office's administrators, not only the first, and the Super Admin by name. */
    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))(
      'ADR-0184: refuses %s the workbook',
      async (_who, ctx) => {
        session.current = ctx;
        const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09&format=xlsx');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PERM_DENIED');
      },
    );

    it('ADR-0184, P19.4-T2 AC-4: refuses a Super Admin the workbook by the permission', async () => {
      session.current = SUPER_ADMIN;
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09&format=xlsx');
      expect([res.status, res.body.error.code]).toEqual([403, 'PERM_DENIED']);
    });

    it('ADR-0184: answers the Admin the workbook too — §3.9 grants both', async () => {
      session.current = ADMIN;
      await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09&format=xlsx')
        .buffer(true).parse(binary).expect(200);
    });
  });

  describe('the preview (P9-T3)', () => {
    const FILLED = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,,,,,,,,,,,\n`;
    const send = (body: Buffer | string, month: string | null = '2026-09') => {
      const req = request(app.getHttpServer()).post('/kpm/data-upload/preview');
      if (month !== null) req.field('month', month);
      return req.attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), 'filled.csv');
    };

    it('answers the Owner what the file would change, as multipart form data', async () => {
      const res = await send(FILLED);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        month: '2026-09', filename: 'filled.csv', templateVersion: 1,
        summary: { rows: 1, ready: 1, newCells: 1, notProvidedCells: 5 },
      });
      expect(res.body.rows[0].cells[0]).toMatchObject({ kode: 'APE', ytd: false, status: 'new', after: 150_000_000 });
      // P19.5-T2 AC-3: the version 1 file's six YTD columns are calculated now — noted, not read (R4).
      expect(res.body.notes.filter((n: { code: string }) => n.code === 'column_retired')).toHaveLength(6);
    });

    it('answers the Admin the same — §3.9 grants both', async () => {
      session.current = ADMIN;
      expect((await send(FILLED)).status).toBe(200);
    });

    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))(
      'refuses %s',
      async (_who, ctx) => {
        session.current = ctx;
        expect((await send(FILLED)).status).toBe(403);
      },
    );

    it('P19.4-T2 AC-4 refuses a Super Admin the preview by the permission (ADR-0206 §2)', async () => {
      session.current = SUPER_ADMIN;
      const res = await send(FILLED);
      expect([res.status, res.body.error.code, res.body.error.details?.permission])
        .toEqual([403, 'PERM_DENIED', 'data_upload:upload_and_preview']);
    });

    it('AC-11: receives bytes — a Windows-1252 file arrives intact and is read as one', async () => {
      const ansi = Buffer.concat(
        [...FILLED].map((ch) => (ch === '—' ? Buffer.from([0x97]) : Buffer.from(ch, 'utf8'))),
      );
      const res = await send(ansi);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ encoding: 'windows-1252', templateVersion: 1 });
    });

    it('P19.5-T2 AC-2: a header it does not know is noted, and the rest reads; a file with no Agent Code is refused whole', async () => {
      const noted = await send(FILLED.replace('Recruitment — This Month', 'Recruits')).expect(200);
      expect(noted.body.notes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'column_unknown', header: 'Recruits' })]));
      const res = await send(FILLED.replace('Agent Code', 'Nomor'));
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'UPLOAD_TEMPLATE_MISMATCH', details: { column: 'Agent Code' } });
    });

    it('AC-3: refuses, whole, with 422, a file that starts as a workbook and will not open as one', async () => {
      const res = await send(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UPLOAD_MALFORMED_CSV');
    });

    describe('ADR-0184 — a filled Excel template', () => {
      /** The month's template as the Owner downloads it, its Data sheet's row 2 given figures. */
      const filled = async (header: readonly string[] = TEMPLATE_HEADER_V1) => {
        const workbook = new Workbook();
        const data = workbook.addWorksheet('Data');
        data.addRow([...header]);
        data.addRow(['PRU-001', 'Rina Wijaya', 1.5]);
        return Buffer.from(await workbook.xlsx.writeBuffer());
      };

      it('previews it as it previews the CSV, saying it was a workbook', async () => {
        const res = await send(await filled()).expect(200);
        expect(res.body).toMatchObject({
          format: 'xlsx', templateVersion: 1, summary: { rows: 1, ready: 1, newCells: 1, notProvidedCells: 5 },
        });
        expect(res.body.rows[0]).toMatchObject({ line: 2, agentCode: 'PRU-001' });
        expect(res.body.rows[0].cells[0]).toMatchObject({ kode: 'APE', ytd: false, status: 'new', after: 150_000_000 });
      });

      it('P19.5-T2 AC-2 refuses a Data sheet with two headers on one kode as UPLOAD_TEMPLATE_MISMATCH, naming them', async () => {
        const res = await send(await filled([...TEMPLATE_HEADER_V1, 'APE [APE]']));
        expect(res.status).toBe(422);
        expect(res.body.error).toMatchObject({ code: 'UPLOAD_TEMPLATE_MISMATCH', details: { kode: 'APE', columns: [3, 15] } });
      });

      it('refuses a zip bomb, before opening it, as ASSET_TOO_LARGE', async () => {
        const bomb = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(30 * 1024 * 1024) }, { level: 9 }));
        const res = await send(bomb).expect(413);
        expect(res.body.error).toMatchObject({ code: 'ASSET_TOO_LARGE', details: { maxUncompressedBytes: 26_214_400 } });
      });

      it('confirms it, the batch recording a workbook, its hash the uploaded bytes’', async () => {
        const bytes = await filled();
        const res = await request(app.getHttpServer()).post('/kpm/data-upload/commit')
          .field('month', '2026-09').field('revision', '0').attach('file', bytes, 'filled.xlsx').expect(201);
        expect(res.body.batch).toMatchObject({ filename: 'filled.xlsx', status: 'committed', cellCount: 1 });
        const batch = await mongoose.connection.db!.collection('dataUploadBatches').findOne({});
        expect(batch).toMatchObject({
          format: 'xlsx', encoding: 'utf-8', delimiter: ',',
          fileSha256: createHash('sha256').update(bytes).digest('hex'),
        });
      });
    });

    it('refuses a file over the ceiling as ASSET_TOO_LARGE, not as a fault', async () => {
      const res = await send(Buffer.alloc(PRODUCTION_UPLOAD.MAX_BYTES + 1, 0x41));
      expect(res.status).toBe(413);
      expect(res.body.error).toMatchObject({ code: 'ASSET_TOO_LARGE', details: { maxBytes: 1_048_576 } });
    });

    it('refuses a file sent under another field name as a validation failure, not a fault', async () => {
      const res = await request(app.getHttpServer()).post('/kpm/data-upload/preview')
        .field('month', '2026-09').attach('upload', Buffer.from(FILLED), 'filled.csv');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a request with no file, or no month, with a code a client can branch on', async () => {
      const noFile = await request(app.getHttpServer()).post('/kpm/data-upload/preview').field('month', '2026-09');
      expect(noFile.status).toBe(400);
      expect(noFile.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'file' } });

      const noMonth = await send(FILLED, null);
      expect(noMonth.status).toBe(400);
      expect(noMonth.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P18.10-T5 AC-4 answers each row’s and each cell’s issue in the reader’s language, the cells named as the file names them', async () => {
      const file = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,140,,,,,,,,,,\nPRU-999,"Nobody",1,,,,,,,,,,,\n`;
      const issues = (body: { rows: { issues: { code: string; message: string }[] }[] }) =>
        body.rows.map((row) => row.issues.map((issue) => [issue.code, issue.message]));
      // P19.5-T2: a cell is named by the template's header for its column, in the reader's language; PRU-999 is not in the
      // format of the office's codes either (ADR-0214 §5 step 2), which is said first.
      expect(issues((await send(file).set('Accept-Language', 'en').expect(200)).body)).toEqual([
        [['UPLOAD_VALUE_OUT_OF_RANGE', 'Rolling persistency (%) [PERSISTENCY]: “140” is above 100 — persistency is a percentage.']],
        [['UPLOAD_AGENT_CODE_PATTERN', 'This code is not in the agent code format of this KPM\'s template — for example 80777.']],
      ]);
      const indonesian = await send(file).set('Accept-Language', 'id').expect(200);
      expect(issues(indonesian.body)).toEqual([
        [['UPLOAD_VALUE_OUT_OF_RANGE', 'Persistensi rolling (%) [PERSISTENCY]: “140” lebih dari 100 — persistency adalah persentase.']],
        [['UPLOAD_AGENT_CODE_PATTERN', 'Kode ini tidak sesuai format kode agen di template KPM ini — contohnya 80777.']],
      ]);
      // Everything else in the preview is the same in both: codes, statuses, figures.
      expect(indonesian.body.summary).toMatchObject({ rows: 2, ready: 1, refused: 1, newCells: 1, refusedCells: 1 });
    });

    it('P18.10-T5 AC-2 refuses the file in Indonesian: its header, its size, a missing file', async () => {
      const header = await send(FILLED.replace('Agent Code', 'Nomor')).set('Accept-Language', 'id').expect(422);
      expect(header.body.error).toMatchObject({
        code: 'UPLOAD_TEMPLATE_MISMATCH', details: { column: 'Agent Code' },
        message: 'File ini tidak memiliki kolom Agent Code, jadi tidak ada baris yang bisa dicocokkan dengan orangnya. Unduh '
          + 'template untuk bulan ini dan isi template itu — belum ada yang dibaca.',
      });
      const big = await send(Buffer.alloc(PRODUCTION_UPLOAD.MAX_BYTES + 1, 0x41)).set('Accept-Language', 'id').expect(413);
      expect(big.body.error).toMatchObject({
        code: 'ASSET_TOO_LARGE', details: { maxBytes: 1_048_576 },
        message: 'File ini lebih besar dari 1 MB. Template untuk satu KPM hanya beberapa kilobyte — periksa apakah ini file yang benar.',
      });
      const noFile = await request(app.getHttpServer()).post('/kpm/data-upload/preview').set('Accept-Language', 'id')
        .field('month', '2026-09').expect(400);
      expect(noFile.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'file' }, message: 'Lampirkan template yang sudah diisi sebagai kolom `file`.',
      });
      const notAMonth = await send(FILLED, 'Sep-2026').set('Accept-Language', 'id').expect(400);
      expect(notAMonth.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Sep-2026 bukan bulan. Gunakan format YYYY-MM.' });
    });
  });

  describe('confirm, revert, history and the month lock (P9-T4)', () => {
    const FILLED = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,,,,,,,,,,,\n`;
    const commit = (revision: string | null = '0', body = FILLED) => {
      const req = request(app.getHttpServer()).post('/kpm/data-upload/commit').field('month', '2026-09');
      if (revision !== null) req.field('revision', revision);
      return req.attach('file', Buffer.from(body), 'filled.csv');
    };
    /** Every write route, as the caller of the moment sends it. */
    const WRITES: [string, () => request.Test][] = [
      ['commit', () => commit()],
      ['revert', () => request(app.getHttpServer()).post('/kpm/data-upload/revert').send({ batchId: '66f0000000000000000000ff' })],
      ['history', () => request(app.getHttpServer()).get('/kpm/data-upload/history?month=2026-09')],
      ['lock', () => request(app.getHttpServer()).post('/kpm/data-upload/months/2026-09/lock')],
      ['reopen', () => request(app.getHttpServer()).post('/kpm/data-upload/months/2026-09/reopen')],
    ];

    it('confirms an import for the Owner, answering the batch and the month after it', async () => {
      const res = await commit();
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        batch: { filename: 'filled.csv', status: 'committed', cellCount: 1, canRevert: true },
        state: { month: '2026-09', revision: 1, locked: false },
      });
      const month = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
      expect(month.body.rows[0].values.APE).toEqual({ value: 150_000_000, provenance: 'imported', correction: null, outOfBounds: null });
      // D8: September is running on 27 Sep: its upload stands at today.
      expect(month.body.state.asOf).toBe('2026-09-27');
      expect(month.body.state).toMatchObject({ revision: 1, reason: 'open', editableUntil: '2026-10-07' });
    });

    it('lists, then reverts, over HTTP', async () => {
      const { body } = await commit();
      const history = await request(app.getHttpServer()).get('/kpm/data-upload/history?month=2026-09');
      expect(history.status).toBe(200);
      expect(history.body.batches.map((b: { id: string }) => b.id)).toEqual([body.batch.id]);

      const res = await request(app.getHttpServer()).post('/kpm/data-upload/revert').send({ batchId: body.batch.id });
      expect(res.status).toBe(200);
      expect(res.body.batch).toMatchObject({ status: 'reverted', restoredCellCount: 1 });
    });

    it('locks and reopens a month over HTTP', async () => {
      const locked = await request(app.getHttpServer()).post('/kpm/data-upload/months/2026-09/lock');
      expect(locked.status).toBe(200);
      expect(locked.body).toMatchObject({ locked: true, reason: 'locked_by_hand' });
      expect((await commit('1')).body.error.code).toBe('UPLOAD_MONTH_LOCKED');

      const reopened = await request(app.getHttpServer()).post('/kpm/data-upload/months/2026-09/reopen');
      expect(reopened.body).toMatchObject({ locked: false, reason: 'reopened' });
    });

    it('answers the Admin on every route — §3.9 grants both', async () => {
      session.current = ADMIN;
      // The revert names a batch that does not exist: its 404 is the service answering, past the guard.
      const expected: Record<string, number> = { commit: 201, revert: 404, history: 200, lock: 200, reopen: 200 };
      for (const [route, send] of WRITES) expect([route, (await send()).status]).toEqual([route, expected[route]]);
    });

    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))(
      'refuses %s every route',
      async (_who, ctx) => {
        session.current = ctx;
        for (const [, send] of WRITES) expect((await send()).status).toBe(403);
      },
    );

    it('P19.4-T2 AC-4 refuses a Super Admin every route by the permission — the data upload is the office’s', async () => {
      session.current = SUPER_ADMIN;
      for (const [route, send] of WRITES) {
        const res = await send();
        expect([route, res.status, res.body.error.code]).toEqual([route, 403, 'PERM_DENIED']);
      }
    });

    it('reaches history as itself, not as a month called "history"', async () => {
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/history?month=2026-09');
      expect(res.body).toEqual({ month: '2026-09', batches: [] });
    });

    it('refuses what is missing with a code a client can branch on', async () => {
      const noRevision = await commit(null);
      expect(noRevision.status).toBe(400);
      expect(noRevision.body.error.code).toBe('VALIDATION_FAILED');

      const noBatch = await request(app.getHttpServer()).post('/kpm/data-upload/revert').send({});
      expect(noBatch.status).toBe(400);

      const badMonth = await request(app.getHttpServer()).post('/kpm/data-upload/months/Sep/lock');
      expect(badMonth.status).toBe(400);
      expect(badMonth.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('replaces a correction named in the form, and keeps one that is not (ADR-0053)', async () => {
      await request(app.getHttpServer()).patch('/kpm/data-upload/cell').send({
        month: '2026-09', membershipId: RINA, kode: 'APE', ytd: false, value: 300_000_000, revision: 0, reason: 'x',
      });
      const preview = await request(app.getHttpServer()).post('/kpm/data-upload/preview')
        .field('month', '2026-09').attach('file', Buffer.from(FILLED), 'filled.csv');
      expect(preview.body.summary.correctionCells).toBe(1);

      const kept = await commit('1', FILLED);
      expect(kept.status).toBe(400);

      const replaced = await request(app.getHttpServer()).post('/kpm/data-upload/commit')
        .field('month', '2026-09').field('revision', '1').field('replace', `${RINA}:APE`)
        .attach('file', Buffer.from(FILLED), 'filled.csv');
      expect(replaced.status).toBe(201);
      expect(replaced.body.batch).toMatchObject({ replacedCorrectionCount: 1, keptCorrectionCount: 0 });
    });

    it('answers a stale preview with 409 VERSION_CONFLICT', async () => {
      await commit();
      const res = await commit('0', FILLED.replace('1.5', '2'));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('P18.10-T5 AC-2 refuses in Indonesian: a month locked on its schedule, its month and day in the reader’s figures', async () => {
      // August was written before (P19.5-T2: a never-written month of the history is open until its first upload).
      await mongoose.connection.db!.collection('productionMonths').insertOne({ kpmId: FIXTURE_KPM, month: '2026-08', revision: 1, firstWrittenOn: '2026-08-31', deletedAt: null });
      const august = request(app.getHttpServer()).post('/kpm/data-upload/commit').set('Accept-Language', 'id')
        .field('month', '2026-08').field('revision', '1').attach('file', Buffer.from(FILLED), 'filled.csv');
      expect((await august.expect(409)).body.error).toMatchObject({
        code: 'UPLOAD_MONTH_LOCKED', details: { month: '2026-08', reason: 'schedule', editableUntil: '2026-09-07' },
        message: 'Agu 2026 dikunci setelah 7 Sep 2026, saat masa pengisiannya berakhir. Buka kembali bulan ini untuk mengubah '
          + 'angkanya.',
      });
      await commit();
      const stale = await commit('0', FILLED.replace('1.5', '2')).set('Accept-Language', 'id').expect(409);
      expect(stale.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        message: 'Sep 2026 telah berubah sejak Anda membukanya. Muat ulang, lalu unggah file lagi jika Anda sedang mengimpor.',
      });
      const again = await commit('0').set('Accept-Language', 'id').expect(409);
      expect(again.body.error).toMatchObject({
        code: 'UPLOAD_BATCH_ALREADY_COMMITTED',
        message: 'File ini sudah diimpor, dari pratinjau yang sama. Angka-angkanya sudah ada di tabel.',
      });
      const nothing = await commit('1').set('Accept-Language', 'id').expect(400);
      expect(nothing.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'File ini tidak akan mengubah apa pun: setiap angka di dalamnya kosong, sudah tersimpan, atau tidak diambil.',
      });
      const noRevision = await commit('latest').set('Accept-Language', 'id').expect(400);
      expect(noRevision.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'revision' }, message: 'Kirim `revision` yang menjadi dasar pratinjau.',
      });
    });

    it('P18.10-T5 AC-6 keeps a commit’s issues with the batch in the words of whoever imported it', async () => {
      const file = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,140,,,,,,,,,,\n`;
      await commit('0', file).set('Accept-Language', 'id').expect(201);
      const [row] = await mongoose.connection.db!.collection('dataUploadRows').find({}).toArray();
      expect(row.issues).toEqual([{
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', kode: 'PERSISTENCY', ytd: false,
        message: 'Persistensi rolling (%) [PERSISTENCY]: “140” lebih dari 100 — persistency adalah persentase.',
      }]);
    });
  });

  describe('correcting one figure (P9-T5)', () => {
    const patch = (body: Record<string, unknown>) => request(app.getHttpServer()).patch('/kpm/data-upload/cell').send({
      month: '2026-09', membershipId: RINA, kode: 'APE', ytd: false, value: 200_000_000,
      revision: 0, reason: 'The carrier restated it', ...body,
    });

    it('corrects for the Owner and the Admin, answering the figure before and after', async () => {
      const res = await patch({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        changed: true, before: { value: null }, after: { value: 200_000_000, provenance: 'corrected' }, state: { revision: 1 },
      });
      session.current = ADMIN;
      expect((await patch({ value: 300_000_000, revision: 1 })).status).toBe(200);
      const month = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
      // The cell says who corrected it, when and why, with no second request (P9-T6).
      expect(month.body.rows[0].values.APE).toMatchObject({
        value: 300_000_000, provenance: 'corrected', correction: { reason: 'The carrier restated it' },
      });
    });

    it('clears a figure with an explicit null — and an absent value is not a request to clear', async () => {
      await patch({});
      expect((await patch({ value: null, revision: 1 })).body.after).toEqual({ value: null, provenance: 'corrected' });
      const absent = await request(app.getHttpServer()).patch('/kpm/data-upload/cell').send({
        month: '2026-09', membershipId: RINA, kode: 'APE', ytd: false, revision: 2, reason: 'x',
      });
      expect(absent.status).toBe(400);
      expect(absent.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('answers a figure out of range with 422 and the reason', async () => {
      const res = await patch({ kode: 'PERSISTENCY', value: 140 }).set('Accept-Language', 'en');
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', message: 'Rolling persistency this month is above 100 — persistency is a percentage.',
      });
    });

    it('P18.10-T5 AC-2 refuses a correction in Indonesian: the figure named by its metric, the cadence in the reader’s words', async () => {
      const range = await patch({ kode: 'PERSISTENCY', value: 140 }).set('Accept-Language', 'id').expect(422);
      expect(range.body.error).toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', details: { kode: 'PERSISTENCY', ytd: false, value: 140 },
        message: 'Persistensi rolling bulan ini lebih dari 100 — persistency adalah persentase.',
      });
      // P19.5-T2 AC-7: a summed year to date is never typed (R4).
      const ytd = await patch({ ytd: true }).set('Accept-Language', 'id').expect(400);
      expect(ytd.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'YTD APE dihitung dari bulan-bulannya. Koreksi angka bulannya.' });
      const noReason = await patch({ reason: '  ' }).set('Accept-Language', 'id').expect(400);
      expect(noReason.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'reason' }, message: 'Jelaskan mengapa angka ini dikoreksi.',
      });
      // Too long is the form's to refuse, in the pipe's own Indonesian, before the service reads it.
      const tooLong = await patch({ reason: 'x'.repeat(501) }).set('Accept-Language', 'id').expect(400);
      expect(tooLong.body.error.message).toBe('reason paling banyak 500 karakter');
    });

    it('P18.10-T5 AC-6 stores the reason a person types as typed, and reads it as stored, whatever the language', async () => {
      await patch({ reason: 'Carrier mengoreksi lewat email' }).set('Accept-Language', 'id').expect(200);
      const month = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09').expect(200);
      expect(month.body.rows[0].values.APE.correction.reason).toBe('Carrier mengoreksi lewat email');
      const indonesian = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09').set('Accept-Language', 'id').expect(200);
      expect(indonesian.body.rows[0].values.APE.correction.reason).toBe('Carrier mengoreksi lewat email');
    });

    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))('refuses %s', async (_who, ctx) => {
      session.current = ctx;
      expect((await patch({})).status).toBe(403);
    });

    it('P19.4-T2 AC-4 refuses a Super Admin a correction by the permission (ADR-0206 §2)', async () => {
      session.current = SUPER_ADMIN;
      const res = await patch({});
      expect([res.status, res.body.error.code, res.body.error.details?.permission])
        .toEqual([403, 'PERM_DENIED', 'data_upload:correct_cell']);
    });

    it('refuses what the form gets wrong, field by field', async () => {
      for (const body of [
        { kode: 'ape' }, { kode: 5 }, { ytd: 'yes' }, { revision: -1 }, { revision: 1.5 }, { value: 'lots' }, { reason: 5 },
      ]) {
        const res = await patch(body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
    });
  });

  it('refuses a path that is not a month, with a code a client can branch on', async () => {
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/september');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  /**
   * **P19.3-T1 AC-6 — *Unit Persistency (%)* over HTTP** (ADR-0201 §2). The template issues version 2; a filled version 2
   * file previews the column — an issue on an agent's row — and commits it on a leader's; a version 1 file is read as
   * before. The routes and their grants are unchanged (the tests above), so one negative per write here, and the
   * other office's file reaching none of this one's rows.
   */
  describe('P19.3-T1 AC-6 — Unit Persistency (%) over HTTP', () => {
    const AGUS = '66f000000000000000000102';
    const V2 = (rina: string, agus: string) =>
      `${TEMPLATE_HEADER_V2.join(',')}\nPRU-001,"Rina Wijaya",1.5,,,,,,,,,,,,${rina}\nPRU-002,"Agus Prasetyo",2,,,,,,,,,,,,${agus}\n`;
    const upload = (path: 'preview' | 'commit', body: string, revision?: string) => {
      const req = request(app.getHttpServer()).post(`/kpm/data-upload/${path}`).field('month', '2026-09');
      if (revision !== undefined) req.field('revision', revision);
      return req.attach('file', Buffer.from(body), 'filled.csv');
    };

    beforeEach(async () => {
      // Agus leads: an AB, by class (ADR-0156).
      await mongoose.connection.db!.collection('memberships').insertOne({
        _id: new mongoose.Types.ObjectId(AGUS), kpmId: FIXTURE_KPM, userId: '66f000000000000000000302',
        agentCode: 'PRU-002', agentSeq: 2, leaderCode: 'LC-102', orgLevelCode: 'AB', role: 'ab',
        hierarchyRole: 'ab', leaderId: null, ancestorIds: [], status: 'active', deletedAt: null,
      } as never);
      await mongoose.connection.db!.collection('users').insertOne({
        _id: new mongoose.Types.ObjectId('66f000000000000000000302'),
        email: 'agus@kpm.test', fullName: 'Agus Prasetyo', deletedAt: null,
      } as never);
    });

    it('P19.5-T2 AC-1 the template is the template’s: its header ending with Unit persistency (%) [UNIT_PERSISTENCY]', async () => {
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09').set('Accept-Language', 'en').expect(200);
      expect(res.body.version).toBe(1);
      expect(res.body.header.at(-1)).toBe('Unit persistency (%) [UNIT_PERSISTENCY]');
      expect(res.body.file.split('\n')[0].split(',')).toHaveLength(9);
    });

    it('P19.3-T1 AC-6 previews the column: a leader’s figure new, an agent’s an issue naming the column', async () => {
      const res = await upload('preview', V2('85', '82.5')).expect(200);
      expect(res.body.templateVersion).toBe(1);
      const [rina, agus] = res.body.rows;
      expect(rina.issues).toEqual([expect.objectContaining({ code: 'UPLOAD_LEADER_ONLY_VALUE', kode: 'UNIT_PERSISTENCY', ytd: false })]);
      expect(rina.cells.find((c: { kode: string }) => c.kode === 'UNIT_PERSISTENCY')).toMatchObject({ status: 'refused' });
      expect(agus.issues).toEqual([]);
      expect(agus.cells.find((c: { kode: string }) => c.kode === 'UNIT_PERSISTENCY')).toMatchObject({ status: 'new', after: 82.5 });
      // In Indonesian to an Indonesian reader.
      const id = await upload('preview', V2('85', '')).set('Accept-Language', 'id').expect(200);
      expect(id.body.rows[0].issues[0].message).toContain('ada di baris agen dan tidak disimpan');
    });

    it('P19.3-T1 AC-6 commits a leader’s figure, not an agent’s, and the month table shows it', async () => {
      const res = await upload('commit', V2('85', '82.5'), '0').expect(201);
      expect(res.body.batch).toMatchObject({ status: 'committed', templateVersion: 1, cellCount: 3, issueCount: 1 });
      const month = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09').expect(200);
      const row = (code: string) => month.body.rows.find((r: { agentCode: string }) => r.agentCode === code);
      expect(row('PRU-002')).toMatchObject({ leader: true, values: { UNIT_PERSISTENCY: { value: 82.5, provenance: 'imported', correction: null } } });
      expect(row('PRU-001')).toMatchObject({ leader: false, values: { UNIT_PERSISTENCY: { value: null, provenance: null, correction: null } } });
      expect(row('PRU-001').values.APE).toMatchObject({ value: 150_000_000 });
    });

    it('P19.5-T2 AC-3 a version 1 file still previews and commits: its six month columns read, the seventh noted as missing', async () => {
      const v1 = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-002,"Agus Prasetyo",2,,,,,,,,,,,\n`;
      const preview = await upload('preview', v1).expect(200);
      expect(preview.body).toMatchObject({ templateVersion: 1 });
      expect(preview.body.rows[0].cells).toHaveLength(6);
      expect(preview.body.notes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'column_missing', kode: 'UNIT_PERSISTENCY' })]));
      await upload('commit', v1, '0').expect(201);
    });

    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))(
      'P19.3-T1 AC-6 refuses %s a version 2 file, as every file (§3.9)',
      async (_who, ctx) => {
        session.current = ctx;
        await upload('preview', V2('', '80')).expect(403);
        await upload('commit', V2('', '80'), '0').expect(403);
        session.current = OWNER;
        const month = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09').expect(200);
        expect(month.body.withData).toBe(0);
      },
    );
  });
});
