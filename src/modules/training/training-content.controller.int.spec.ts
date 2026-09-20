import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import {
  ADMIN, EVERY_MEMBER, FIXTURE_KPM, NOT_ADMINISTRATORS, OWNER, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';

const NOW = new Date('2026-09-18T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const MODULE = 'PROSPECT_LIST';

/**
 * A training module's content, over HTTP (P5-T2, ADR-0032).
 *
 * The sixth controller the Phase 5 exit review's finding reaches. `config.controller.int.spec.ts`
 * wires `TrainingController` and proves its decorators are named correctly, but it only calls the
 * **taxonomy** routes — the six content handlers sat at 25% function coverage, never entered by
 * anything. `training-content.tenancy.spec.ts` proves the company-versus-office boundary by
 * calling the service, which cannot see a pipe, a param or a decorator.
 *
 * What is proved here is only what a request can answer: who is refused, that the upload limits
 * are enforced **before** a signature is issued, and that `content/url` is a `GET` under the
 * module rather than something `:code` swallows.
 */
describe('a training module’s content over HTTP (P5-T2)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const url = '/kpm/settings/training';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);

    const moduleRef = await Test.createTestingModule({
      controllers: [TrainingController],
      providers: [{ provide: TrainingService, useValue: wired.training }],
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
      _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'A',
      timezone: 'Asia/Jakarta',
    });
    await provisionOffice(wired, FIXTURE_KPM, COMPANY);
  });

  /** Upload a file the way the screen does: request a signature, then confirm the bytes landed. */
  const upload = async (filename = 'deck.pdf') => {
    const signed = await request(app.getHttpServer()).post(`${url}/uploads`)
      .send({ filename, mimeType: 'application/pdf', bytes: 1024 }).expect(201);

    await request(app.getHttpServer()).post(`${url}/uploads/confirm`)
      .send({ storageKey: signed.body.storageKey }).expect(201);

    return signed.body.storageKey as string;
  };

  describe('who may reach it', () => {
    it.each(EVERY_MEMBER)('shows %s the module’s material', async (_name, who) => {
      session.current = who;

      const res = await request(app.getHttpServer())
        .get(`${url}/modules/${MODULE}/content`).expect(200);

      expect(res.body).toMatchObject({ moduleCode: MODULE, overridden: false });
      // Both halves on the wire: the office's own, and the company's underneath it, so a screen
      // can offer "use my company's again" without a second request.
      expect(res.body.companyContent).toBeTruthy();
    });

    it.each(NOT_ADMINISTRATORS)('refuses %s every write', async (_name, who) => {
      session.current = who;
      const server = app.getHttpServer();

      await request(server).post(`${url}/uploads`)
        .send({ filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1 }).expect(403);
      await request(server).post(`${url}/uploads/confirm`)
        .send({ storageKey: 'whatever' }).expect(403);
      await request(server).put(`${url}/modules/${MODULE}/content`)
        .send({ files: [] }).expect(403);
      await request(server).delete(`${url}/modules/${MODULE}/content`).expect(403);
    });

    it.each([['the Owner', OWNER], ['the Admin', ADMIN]])(
      'lets %s replace the company’s material and put it back', async (_name, who) => {
        session.current = who;
        const storageKey = await upload();

        const saved = await request(app.getHttpServer())
          .put(`${url}/modules/${MODULE}/content`)
          .send({
            files: [{
              label: 'Prospecting deck', storageKey, mimeType: 'application/pdf', bytes: 1024,
            }],
          })
          .expect(200);
        expect(saved.body.overridden).toBe(true);
        expect(saved.body.content.files[0]).toMatchObject({ label: 'Prospecting deck' });

        const reset = await request(app.getHttpServer())
          .delete(`${url}/modules/${MODULE}/content`).expect(200);
        expect(reset.body.overridden).toBe(false);
      },
    );
  });

  describe('the upload gate', () => {
    it('refuses a type the product does not accept, before any signature is issued', async () => {
      /*
       * `@IsIn(ASSET_LIMITS.ALLOWED_MIME_TYPES)` on the DTO, so the pipe answers — which is the
       * point the controller's own description makes: rejecting after an upload has finished
       * spends somebody's data allowance to say no.
       */
      await request(app.getHttpServer()).post(`${url}/uploads`)
        .send({ filename: 'x.exe', mimeType: 'application/x-msdownload', bytes: 1 }).expect(400);
    });

    it('refuses a negative size and a missing filename', async () => {
      await request(app.getHttpServer()).post(`${url}/uploads`)
        .send({ filename: 'x.pdf', mimeType: 'application/pdf', bytes: -1 }).expect(400);
      await request(app.getHttpServer()).post(`${url}/uploads`)
        .send({ mimeType: 'application/pdf', bytes: 1 }).expect(400);
    });

    it('refuses a body carrying a field the DTO never declared', async () => {
      const res = await request(app.getHttpServer()).post(`${url}/uploads`)
        .send({ filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1, folder: 'elsewhere' })
        .expect(400);

      expect(res.body.error.details.violations)
        .toEqual(expect.arrayContaining([expect.stringContaining('folder')]));
    });
  });

  describe('the signed URL', () => {
    it('answers a key the module actually holds, and 404s one it does not', async () => {
      // Which registry answers follows which half holds the file, never what the caller asks
      // for — so a key in neither half buys nothing.
      const storageKey = await upload();
      await request(app.getHttpServer()).put(`${url}/modules/${MODULE}/content`)
        .send({
          files: [{
            label: 'Prospecting deck', storageKey, mimeType: 'application/pdf', bytes: 1024,
          }],
        })
        .expect(200);

      const signed = await request(app.getHttpServer())
        .get(`${url}/modules/${MODULE}/content/url`).query({ storageKey }).expect(200);
      expect(signed.body.url).toEqual(expect.any(String));

      await request(app.getHttpServer()).get(`${url}/modules/${MODULE}/content/url`)
        .query({ storageKey: 'dev/nobody/training/NOPE' }).expect(404);
    });

    it('is a read, so everybody in the office may ask for one', async () => {
      const storageKey = await upload();
      await request(app.getHttpServer()).put(`${url}/modules/${MODULE}/content`)
        .send({
          files: [{
            label: 'Prospecting deck', storageKey, mimeType: 'application/pdf', bytes: 1024,
          }],
        })
        .expect(200);

      for (const [, who] of EVERY_MEMBER) {
        session.current = who;
        await request(app.getHttpServer()).get(`${url}/modules/${MODULE}/content/url`)
          .query({ storageKey }).expect(200);
      }
    });
  });

  it('404s a module code this office does not have', async () => {
    await request(app.getHttpServer()).get(`${url}/modules/NOT_A_MODULE/content`).expect(404);
  });
});
