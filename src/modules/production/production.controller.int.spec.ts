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

const NOW = new Date('2026-09-27T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const RINA = '66f000000000000000000101';

/** Every route, and the permission it must declare. */
const ROUTES: Record<string, string> = {
  template: 'data_upload:download_template',
  preview: 'data_upload:upload_and_preview',
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
      providers: [{ provide: ProductionService, useValue: wired.production }],
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
    expect(res.body.rows[0].metrics.ape.monthly).toEqual({ value: null, provenance: null });
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
  });

  it('refuses a path that is not a month, with a code a client can branch on', async () => {
    const res = await request(app.getHttpServer()).get('/kpm/data-upload/september');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
