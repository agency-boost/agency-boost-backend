import mongoose from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { up as templateCompany } from '@/migrations/0037-template-company';
import { AdminController } from '@/modules/tenants/admin.controller';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { EVERY_MEMBER, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { IN_INDONESIAN } from '../../../test/i18n';
import { listenOnLoopback } from '../../../test/listen';
import { TemplateService } from './template.service';

const NOW = new Date('2026-11-04T02:00:00Z');
const LIBRARY = TEMPLATE_LIBRARY.companyId;
const DEFAULT = TEMPLATE_LIBRARY.defaultTemplateId;
const KIND = 'event_types';

/** An event types payload the publish check accepts, named so two editors' words tell apart. */
const eventTypes = (label: string) => ({
  types: [{ code: 'TRAINING', label }],
});

/**
 * **The Super Admin's template sections: the live version beside the draft, and a stale draft save refused** (P19-T6
 * AC-2, AC-3; the 11-03 handover's B1-10 — *the Default template API returns only drafts*, *saves have no conflict
 * check*). Over HTTP through `AdminController`'s template routes, the guard, the pipe and the filter real, on the
 * platform's own **Default template** as migration 0037 makes it on every environment: each kind published as version 1.
 */
describe('a template section’s read and its draft save (P19-T6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    // The one-version-per-kind index is what refuses a second first draft: built before any test writes.
    await syncIndexes();
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: TemplateService, useValue: wired.templateService }],
    })
      .useMocker(() => ({}))
      .compile();
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
    await templateCompany(mongoose.connection.db as mongoose.mongo.Db, NOW);
  });

  const api = () => request(app.getHttpServer());
  /** The Default template's drafts of the kind, counted where they are stored. */
  const drafts = () => mongoose.connection.collection('companyTemplates')
    .countDocuments({ companyId: LIBRARY, templateId: DEFAULT, kind: KIND, status: 'draft', deletedAt: null });
  const at = (kind = KIND) => `/admin/companies/${LIBRARY}/template/${kind}?templateId=${DEFAULT}`;
  const read = async (kind = KIND) => (await api().get(at(kind)).expect(200)).body;
  const save = (body: Record<string, unknown>, kind = KIND) => api().put(at(kind)).send(body);
  const publish = (kind = KIND) => api().post(`/admin/companies/${LIBRARY}/template/${kind}/publish?templateId=${DEFAULT}`);

  describe('AC-3: the Default template’s read', () => {
    it('P19-T6 AC-3 returns the published version beside the draft, where it returned only the draft', async () => {
      const live = await read();
      expect(live).toMatchObject({ status: 'published', version: 1, published: { version: 1, payload: live.payload } });

      await save({ payload: eventTypes('Pelatihan baru') }).expect(200);
      const view = await read();
      // The draft, as before …
      expect(view).toMatchObject({ status: 'draft', version: 2, publishedVersion: 1, payload: eventTypes('Pelatihan baru') });
      // … and the live version beside it: what offices are made from today.
      expect(view.published).toMatchObject({ version: 1, payload: live.payload });
      expect(view.published.publishedAt).toBe(NOW.toISOString());
    });

    it('P19-T6 AC-3 carries the newest published version once the draft is published, and null where nothing is', async () => {
      await save({ payload: eventTypes('Pelatihan v2') }).expect(200);
      await publish().expect(201);
      expect(await read()).toMatchObject({ status: 'published', version: 2, published: { version: 2 } });

      // `campaign_kinds` is the company's and the migration publishes none of it.
      expect((await read('campaign_kinds')).published).toBeNull();
    });
  });

  describe('AC-2: a stale draft save is refused', () => {
    it('P19-T6 AC-2 lands a save carrying the revision read, and moves the revision on every save', async () => {
      expect((await read()).revision).toBe(0);
      let res = await save({ payload: eventTypes('Satu'), expectedRevision: 0 }).expect(200);
      expect(res.body).toMatchObject({ status: 'draft', version: 2, revision: 1 });
      res = await save({ payload: eventTypes('Dua'), expectedRevision: 1 }).expect(200);
      // The version is the number the draft will be published as, and does not move; the revision does.
      expect(res.body).toMatchObject({ status: 'draft', version: 2, revision: 2, payload: eventTypes('Dua') });
    });

    it('P19-T6 AC-2 refuses a save carrying a revision somebody else saved past: 409, both revisions, nothing written', async () => {
      await save({ payload: eventTypes('Dibuka'), expectedRevision: 0 }).expect(200);
      // Two Super Admins open the draft at revision 1. The other one saves first …
      await save({ payload: eventTypes('Milik mereka'), expectedRevision: 1 }).expect(200);

      // … and this one, still at revision 1, saves over it.
      const res = await save({ payload: eventTypes('Milik saya'), expectedRevision: 1 }).expect(409);
      expect(res.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        message: 'Someone else saved this section after you opened it, and nothing was saved. Reload to see what is stored now.',
        details: { expectedRevision: 1, actualRevision: 2 },
      });
      expect((await read()).payload).toEqual(eventTypes('Milik mereka'));
    });

    it('P19-T6 AC-2 refuses a first draft over a version somebody else has drafted since it was opened', async () => {
      // Both open the published version 1, revision 0. The other one starts a draft.
      await save({ payload: eventTypes('Milik mereka'), expectedRevision: 0 }).expect(200);
      const res = await save({ payload: eventTypes('Milik saya'), expectedRevision: 0 }).set(...IN_INDONESIAN).expect(409);
      expect(res.body.error.message).toBe(
        'Orang lain menyimpan bagian ini setelah Anda membukanya, dan tidak ada yang disimpan. '
          + 'Muat ulang untuk melihat yang tersimpan sekarang.',
      );
      expect((await read()).payload).toEqual(eventTypes('Milik mereka'));
    });

    it('P19-T6 AC-2 lands a save after somebody published the very draft it was opened at: the content did not move', async () => {
      await save({ payload: eventTypes('Draf'), expectedRevision: 0 }).expect(200);
      await publish().expect(201);
      // Published keeps its revision, so an editor still at revision 1 starts the next draft from it.
      const res = await save({ payload: eventTypes('Berikutnya'), expectedRevision: 1 }).expect(200);
      expect(res.body).toMatchObject({ status: 'draft', version: 3, revision: 2 });
    });

    it('P19-T6 AC-2 refuses a save after somebody published and then drafted again', async () => {
      await save({ payload: eventTypes('Draf'), expectedRevision: 0 }).expect(200);
      await publish().expect(201);
      await save({ payload: eventTypes('Milik mereka'), expectedRevision: 1 }).expect(200);
      await save({ payload: eventTypes('Milik saya'), expectedRevision: 1 }).expect(409);
    });

    it('P19-T6 AC-2 lets exactly one of two saves racing on one draft land', async () => {
      await save({ payload: eventTypes('Dibuka'), expectedRevision: 0 }).expect(200);
      const answers = await Promise.all(['A', 'B'].map((who) => save({ payload: eventTypes(who), expectedRevision: 1 })));
      expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await read()).revision).toBe(2);
    });

    it('P19-T6 AC-2 answers two first drafts made at once on one revision with one draft and a 409, never a 500', async () => {
      const answers = await Promise.all(['A', 'B'].map((who) => save({ payload: eventTypes(who), expectedRevision: 0 })));
      expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await drafts()).toBe(1);
    });

    it('P19-T6 AC-2 never answers 500 to two unpinned first drafts at once: the one-version index refusal is a 409', async () => {
      // Sequenced, the second finds the first's draft and saves over it, as an unpinned save always did; interleaved,
      // both try to make the draft and the index refuses one — which answered `500` before the pin.
      const answers = await Promise.all(['A', 'B'].map((who) => save({ payload: eventTypes(who) })));
      for (const { status } of answers) expect([200, 409]).toContain(status);
      expect(answers.some((r) => r.status === 200)).toBe(true);
      expect(await drafts()).toBe(1);
    });

    it('P19-T6 AC-2 lands a save with no revision, as API callers before the pin do', async () => {
      await save({ payload: eventTypes('Satu') }).expect(200);
      const res = await save({ payload: eventTypes('Dua') }).expect(200);
      expect(res.body).toMatchObject({ revision: 2, payload: eventTypes('Dua') });
    });

    it('P19-T6 AC-2 starts a company with nothing published at revision 0', async () => {
      const view = await read('campaign_kinds');
      expect(view).toMatchObject({ id: '', version: 0, revision: 0 });
    });

    it.each([['a negative', -1], ['a fraction', 0.5], ['a string', '0']])(
      'P19-T6 AC-2 refuses %s for the revision, 400, nothing written',
      async (_label, expectedRevision) => {
        const res = await save({ payload: eventTypes('X'), expectedRevision }).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(await read()).toMatchObject({ status: 'published', revision: 0 });
      },
    );

    it('P19-T6 AC-2 answers 404, not 409, for the Default template named under another company, whatever revision', async () => {
      const other = '66f0000000000000000000c9';
      await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create({ _id: other, name: 'Sequis', slug: 'sequis' });
      await api().put(`/admin/companies/${other}/template/${KIND}?templateId=${DEFAULT}`)
        .send({ payload: eventTypes('X'), expectedRevision: 7 }).expect(404);
      expect(await read()).toMatchObject({ status: 'published', revision: 0 });
    });

    it.each(EVERY_MEMBER)('P19-T6 AC-2 still refuses %s, a correct revision or not, 403', async (_name, who) => {
      session.current = who;
      await save({ payload: eventTypes('X'), expectedRevision: 0 }).expect(403);
      await api().get(at()).expect(403);
      session.current = SUPER_ADMIN;
      expect(await read()).toMatchObject({ status: 'published', revision: 0 });
    });
  });
});
