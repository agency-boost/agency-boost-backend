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
import { PRODUCTION_UPLOAD } from '@/domain/constants';
import { ProductionController } from './production.controller';
import { TEMPLATE_HEADER_V1 } from './production-template';
import { ProductionService } from './production.service';
import { ProductionImportService } from './production-import.service';
import { ProductionMonths } from './production-months.service';
import { ProductionMonth } from './production-month.schema';
import { ProductionCorrections } from './production-correction.service';
import { listenOnLoopback } from '../../../test/listen';

const NOW = new Date('2026-09-27T02:00:00Z');
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
    expect(res.body.rows[0].metrics.ape.monthly).toEqual({ value: null, provenance: null, correction: null });
    // Not reported is sent as `null`, not dropped: a missing key and `false` would read alike.
    expect(res.body.rows[0]).toHaveProperty('monthlyActiveAgent', null);
  });

  it('OD-21: carries each row’s Monthly Active Agent as the metric computes it (ADR-0054)', async () => {
    const figure = (value: number) => ({ value, provenance: 'imported', sourceBatchId: 'batch-1' });
    await mongoose.connection.db!.collection('monthlyAgentData').insertOne({
      kpmId: FIXTURE_KPM, membershipId: RINA, month: '2026-09', agentCode: 'PRU-001', deletedAt: null,
      apeMonthly: figure(0), policyCountMonthly: figure(0),
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

    it('refuses a Super Admin by name rather than by a 500', async () => {
      // §3.9 grants them `all`, and the route resolves the office from the caller's membership,
      // which they have none of. The guard passes and the service refuses cleanly.
      session.current = SUPER_ADMIN;
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09');
      expect(res.status).not.toBe(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(typeof res.body.error?.code).toBe('string');
    });
  });

  describe('the template (P9-T2)', () => {
    it('answers the Owner the file, named for the office and the month', async () => {
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        month: '2026-09', version: 1, filename: 'KPM0417-agent-data-Sep-2026.csv', rowCount: 1,
      });
      expect(res.body.file.split('\n')[1]).toBe('PRU-001,"Rina Wijaya",,,,,,,,,,,,');
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

    it('refuses a Super Admin by name rather than by a 500', async () => {
      // The same shape as the month: §3.9 grants `all`, the guard passes, and the service refuses
      // because the file is named for an office the caller does not belong to.
      session.current = SUPER_ADMIN;
      const res = await request(app.getHttpServer()).get('/kpm/data-upload/template?month=2026-09');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('refuses a missing or malformed month with a code a client can branch on', async () => {
      for (const q of ['', '?month=', '?month=Sep-2026']) {
        const res = await request(app.getHttpServer()).get(`/kpm/data-upload/template${q}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
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
        summary: { rows: 1, ready: 1, newCells: 1, notProvidedCells: 11 },
      });
      expect(res.body.rows[0].cells[0]).toMatchObject({ metric: 'ape', cadence: 'monthly', status: 'new', after: 150_000_000 });
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

    it('refuses a Super Admin by name — there is no office to read the roster of', async () => {
      session.current = SUPER_ADMIN;
      const res = await send(FILLED);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('AC-11: receives bytes — a Windows-1252 file arrives intact and is read as one', async () => {
      const ansi = Buffer.concat(
        [...FILLED].map((ch) => (ch === '—' ? Buffer.from([0x97]) : Buffer.from(ch, 'utf8'))),
      );
      const res = await send(ansi);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ encoding: 'windows-1252', templateVersion: 1 });
    });

    it('AC-2: refuses a header nobody issued, whole, with 422 and the column', async () => {
      const res = await send(FILLED.replace('Recruitment — This Month', 'Recruits'));
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'UPLOAD_TEMPLATE_MISMATCH', details: { column: 5 } });
    });

    it('AC-3: refuses a workbook, whole, with 422', async () => {
      const res = await send(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UPLOAD_MALFORMED_CSV');
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

    it('P18.98-T5 AC-4 answers each row’s and each cell’s issue in the reader’s language, the cells named as the file names them', async () => {
      const file = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,140,,,,,,,,,,\nPRU-999,"Nobody",1,,,,,,,,,,,\n`;
      const issues = (body: { rows: { issues: { code: string; message: string }[] }[] }) =>
        body.rows.map((row) => row.issues.map((issue) => [issue.code, issue.message]));
      expect(issues((await send(file).expect(200)).body)).toEqual([
        [['UPLOAD_VALUE_OUT_OF_RANGE', 'Rolling Persistency (%) — This Month: “140” is above 100 — persistency is a percentage.']],
        [['UPLOAD_UNKNOWN_AGENT_CODE', 'No active member of this office has this code.']],
      ]);
      const indonesian = await send(file).set('Accept-Language', 'id').expect(200);
      expect(issues(indonesian.body)).toEqual([
        [['UPLOAD_VALUE_OUT_OF_RANGE', 'Rolling Persistency (%) — This Month: “140” lebih dari 100 — persistency adalah persentase.']],
        [['UPLOAD_UNKNOWN_AGENT_CODE', 'Tidak ada anggota aktif KPM ini yang memiliki kode ini.']],
      ]);
      // Everything else in the preview is the same in both: codes, statuses, figures.
      expect(indonesian.body.summary).toMatchObject({ rows: 2, ready: 1, refused: 1, newCells: 1, refusedCells: 1 });
    });

    it('P18.98-T5 AC-2 refuses the file in Indonesian: its header, its size, a missing file', async () => {
      const header = await send(FILLED.replace('Recruitment — This Month', 'Recruits')).set('Accept-Language', 'id').expect(422);
      expect(header.body.error).toMatchObject({
        code: 'UPLOAD_TEMPLATE_MISMATCH', details: { column: 5 },
        message: 'Kolom 5 di header berisi “Recruits”; di templat berisi “Recruitment — This Month”. Unduh templat untuk bulan '
          + 'ini dan isi templat itu — belum ada yang dibaca.',
      });
      const big = await send(Buffer.alloc(PRODUCTION_UPLOAD.MAX_BYTES + 1, 0x41)).set('Accept-Language', 'id').expect(413);
      expect(big.body.error).toMatchObject({
        code: 'ASSET_TOO_LARGE', details: { maxBytes: 1_048_576 },
        message: 'File ini lebih besar dari 1 MB. Templat untuk satu KPM hanya beberapa kilobyte — periksa apakah ini file yang benar.',
      });
      const noFile = await request(app.getHttpServer()).post('/kpm/data-upload/preview').set('Accept-Language', 'id')
        .field('month', '2026-09').expect(400);
      expect(noFile.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'file' }, message: 'Lampirkan templat yang sudah diisi sebagai kolom `file`.',
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
      expect(month.body.rows[0].metrics.ape.monthly).toEqual({ value: 150_000_000, provenance: 'imported', correction: null });
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

    it('refuses a Super Admin every route by name — there is no office to write to', async () => {
      session.current = SUPER_ADMIN;
      for (const [, send] of WRITES) {
        const res = await send();
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
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
        month: '2026-09', membershipId: RINA, metric: 'ape', cadence: 'monthly', value: 300_000_000, revision: 0, reason: 'x',
      });
      const preview = await request(app.getHttpServer()).post('/kpm/data-upload/preview')
        .field('month', '2026-09').attach('file', Buffer.from(FILLED), 'filled.csv');
      expect(preview.body.summary.correctionCells).toBe(1);

      const kept = await commit('1', FILLED);
      expect(kept.status).toBe(400);

      const replaced = await request(app.getHttpServer()).post('/kpm/data-upload/commit')
        .field('month', '2026-09').field('revision', '1').field('replace', `${RINA}:apeMonthly`)
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

    it('P18.98-T5 AC-2 refuses in Indonesian: a month locked on its schedule, its month and day in the reader’s figures', async () => {
      const august = request(app.getHttpServer()).post('/kpm/data-upload/commit').set('Accept-Language', 'id')
        .field('month', '2026-08').field('revision', '0').attach('file', Buffer.from(FILLED), 'filled.csv');
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

    it('P18.98-T5 AC-6 keeps a commit’s issues with the batch in the words of whoever imported it', async () => {
      const file = `${TEMPLATE_HEADER_V1.join(',')}\nPRU-001,"Rina Wijaya",1.5,140,,,,,,,,,,\n`;
      await commit('0', file).set('Accept-Language', 'id').expect(201);
      const [row] = await mongoose.connection.db!.collection('dataUploadRows').find({}).toArray();
      expect(row.issues).toEqual([{
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', metric: 'persistency', cadence: 'monthly',
        message: 'Rolling Persistency (%) — This Month: “140” lebih dari 100 — persistency adalah persentase.',
      }]);
    });
  });

  describe('correcting one figure (P9-T5)', () => {
    const patch = (body: Record<string, unknown>) => request(app.getHttpServer()).patch('/kpm/data-upload/cell').send({
      month: '2026-09', membershipId: RINA, metric: 'ape', cadence: 'monthly', value: 200_000_000,
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
      expect(month.body.rows[0].metrics.ape.monthly).toMatchObject({
        value: 300_000_000, provenance: 'corrected', correction: { reason: 'The carrier restated it' },
      });
    });

    it('clears a figure with an explicit null — and an absent value is not a request to clear', async () => {
      await patch({});
      expect((await patch({ value: null, revision: 1 })).body.after).toEqual({ value: null, provenance: 'corrected' });
      const absent = await request(app.getHttpServer()).patch('/kpm/data-upload/cell').send({
        month: '2026-09', membershipId: RINA, metric: 'ape', cadence: 'monthly', revision: 2, reason: 'x',
      });
      expect(absent.status).toBe(400);
      expect(absent.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('answers a figure out of range with 422 and the reason', async () => {
      const res = await patch({ metric: 'persistency', value: 140 });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', message: 'Rolling persistency this month is above 100 — persistency is a percentage.',
      });
    });

    it('P18.98-T5 AC-2 refuses a correction in Indonesian: the figure named by its metric, the cadence in the reader’s words', async () => {
      const range = await patch({ metric: 'persistency', cadence: 'ytd', value: 140 }).set('Accept-Language', 'id').expect(422);
      expect(range.body.error).toMatchObject({
        code: 'UPLOAD_VALUE_OUT_OF_RANGE', details: { metric: 'persistency', cadence: 'ytd', value: 140 },
        message: 'Rolling persistency YTD lebih dari 100 — persistency adalah persentase.',
      });
      const noReason = await patch({ reason: '  ' }).set('Accept-Language', 'id').expect(400);
      expect(noReason.body.error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'reason' }, message: 'Jelaskan mengapa angka ini dikoreksi.',
      });
      // Too long is the form's to refuse, in the pipe's own Indonesian, before the service reads it.
      const tooLong = await patch({ reason: 'x'.repeat(501) }).set('Accept-Language', 'id').expect(400);
      expect(tooLong.body.error.message).toBe('reason paling banyak 500 karakter');
    });

    it('P18.98-T5 AC-6 stores the reason a person types as typed, and reads it as stored, whatever the language', async () => {
      await patch({ reason: 'Carrier mengoreksi lewat email' }).set('Accept-Language', 'id').expect(200);
      const month = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09').expect(200);
      expect(month.body.rows[0].metrics.ape.monthly.correction.reason).toBe('Carrier mengoreksi lewat email');
      const indonesian = await request(app.getHttpServer()).get('/kpm/data-upload/2026-09').set('Accept-Language', 'id').expect(200);
      expect(indonesian.body.rows[0].metrics.ape.monthly.correction.reason).toBe('Carrier mengoreksi lewat email');
    });

    it.each(NOT_ADMINISTRATORS.filter(([who]) => who !== 'a Super Admin'))('refuses %s', async (_who, ctx) => {
      session.current = ctx;
      expect((await patch({})).status).toBe(403);
    });

    it('refuses a Super Admin by name', async () => {
      session.current = SUPER_ADMIN;
      const res = await patch({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TENANT_NO_MEMBERSHIP');
    });

    it('refuses what the form gets wrong, field by field', async () => {
      for (const body of [
        { metric: 'ytd' }, { cadence: 'weekly' }, { revision: -1 }, { revision: 1.5 }, { value: 'lots' }, { reason: 5 },
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
});
