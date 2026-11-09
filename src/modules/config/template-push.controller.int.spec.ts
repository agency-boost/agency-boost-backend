import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { SEED_TRAINING_MODULES } from '@/domain/constants';
import { TrainingController } from '@/modules/training/training.controller';
import { TrainingService } from '@/modules/training/training.service';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, SUPER_ADMIN, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { NamedTemplateController } from './named-template.controller';
import { NamedTemplateService } from './named-template.service';
import { TemplateCopyService } from './template-copy.service';
import { TemplateService } from './template.service';
import { TemplateMaterialService } from './template-material.service';
import { TemplatePushService } from './template-push.service';

const NOW = new Date('2026-11-05T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';
const MODULE = SEED_TRAINING_MODULES.find((m) => m.publishState === 'published')!.code;

/** A support session as `who`, read-only (§3.13). */
const supporting = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'u-support', null, false, true);

/**
 * **The Training section's material and the push over HTTP** (P19.4-T1 AC-1, AC-6, AC-10; ADR-0208) — behind the real
 * `PermissionsGuard` and the production pipe, as the app serves them.
 */
describe('P19.4-T1 the template’s material and the push over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let templateId: string;
  let otherTemplateId: string;
  const http = () => request(app.getHttpServer());
  const base = () => `/admin/companies/${COMPANY}/templates/${templateId}`;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [NamedTemplateController, TrainingController],
      providers: [
        { provide: NamedTemplateService, useValue: wired.namedTemplates },
        { provide: TemplateCopyService, useValue: wired.templateCopies },
        { provide: TemplateService, useValue: wired.templateService },
        { provide: TemplateMaterialService, useValue: wired.templateMaterial },
        { provide: TemplatePushService, useValue: wired.templatePush },
        { provide: TrainingService, useValue: wired.training },
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
    await clearCollections();
    session.current = SUPER_ADMIN;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    const allianz = await companies.create({ _id: OTHER_COMPANY, name: 'Allianz Life', slug: 'allianz' } as never);
    templateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, prudential as never))._id);
    otherTemplateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, allianz as never))._id);
    // The fixture office, made from Prudential's template: the one every tenant role below belongs to.
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const startFrom = { kind: 'template' as const, templateId };
    const plan = await wired.provisioning.planFor(COMPANY, startFrom);
    await kpms.create({ _id: FIXTURE_KPM, companyId: COMPANY, code: '0417', branchName: 'BSD', startedFrom: plan.startedFrom } as never);
    const done = await provisionFrom(wired, FIXTURE_KPM, COMPANY, startFrom);
    await kpms.updateOne({ _id: FIXTURE_KPM } as never, { $set: { seededFrom: done.seededFrom } } as never);
    await wired.provisioning.publishInitialSnapshotFor(FIXTURE_KPM, RequestContext.superAdminInTenant('root', FIXTURE_KPM));
  });

  /** Upload, confirm, attach to `MODULE` and publish, over HTTP: what the section's editor does. */
  async function materialPublished(): Promise<string> {
    const signed = await http().post(`${base()}/training/uploads`)
      .send({ filename: 'Modul.pdf', mimeType: 'application/pdf', bytes: 2048 }).expect(201);
    expect(signed.body).toMatchObject({ storageKey: expect.any(String), fields: expect.any(Object) });
    const confirmed = await http().post(`${base()}/training/uploads/confirm`).send({ storageKey: signed.body.storageKey }).expect(200);
    expect(confirmed.body).toEqual({ storageKey: signed.body.storageKey, mimeType: 'application/pdf', bytes: 1024 });
    const draft = await http().put(`${base()}/training/modules/${MODULE}/content`)
      .send({ files: [{ label: 'Modul.pdf', ...confirmed.body }], links: [{ label: 'Bacaan', url: 'https://example.com/' }] })
      .expect(200);
    expect(draft.body).toMatchObject({ kind: 'training_taxonomy', status: 'draft' });
    await wired.templateService.publish(SUPER_ADMIN, COMPANY, 'training_taxonomy', templateId);
    return signed.body.storageKey as string;
  }

  describe('as the Super Admin', () => {
    it('P19.4-T1 AC-1 uploads, confirms and attaches material to a module of the draft, by code', async () => {
      const key = await materialPublished();
      const published = await wired.templateService.read(COMPANY, 'training_taxonomy', templateId);
      const module = (published.payload.modules as { code: string; content?: { files: { storageKey: string }[] } }[])
        .find((m) => m.code === MODULE)!;
      expect(module.content!.files[0].storageKey).toBe(key);
    });

    it('P19.4-T1 AC-1 refuses, through the pipe, a file type the list lacks, a module the section lacks, and a stale revision', async () => {
      // `text/html` joined the list on 2026-11-06 (P19.6-T2, ADR-0217 §1); an archive never did.
      await http().post(`${base()}/training/uploads`).send({ filename: 'x.zip', mimeType: 'application/zip', bytes: 10 }).expect(400);
      await http().put(`${base()}/training/modules/NO_SUCH/content`).send({ links: [] }).expect(400);
      await http().put(`${base()}/training/modules/${MODULE}/content`).send({ links: [], expectedRevision: 7 }).expect(409);
      // An unknown field is refused, not ignored.
      await http().put(`${base()}/training/modules/${MODULE}/content`).send({ html: [] }).expect(400);
    });

    it('P19.4-T1 AC-6 lists the KPMs with ?kind= and applies the newest version to the ones ticked', async () => {
      await materialPublished();
      const list = await http().get(`${base()}/offices?kind=training_taxonomy`).expect(200);
      expect(list.body).toEqual([expect.objectContaining({
        id: FIXTURE_KPM, code: '0417', state: 'unchanged',
        kinds: [expect.objectContaining({ kind: 'training_taxonomy', state: 'unchanged', givenVersion: 1, newestVersion: 2 })],
      })]);
      // Without ?kind= the list is ADR-0185 §4's, as before.
      const plain = await http().get(`${base()}/offices`).expect(200);
      expect(plain.body[0]).not.toHaveProperty('kinds');

      const applied = await http().post(`${base()}/apply`).send({ kinds: ['training_taxonomy'], kpmIds: [FIXTURE_KPM] }).expect(200);
      expect(applied.body).toEqual({
        templateId,
        offices: [{
          id: FIXTURE_KPM, code: '0417', branchName: 'BSD', awaitingPublish: false,
          results: [{ kind: 'training_taxonomy', outcome: 'applied', version: 2, replaced: false }],
        }],
      });
    });

    it('P19.4-T1 AC-8 a changed KPM unconfirmed is 409 TEMPLATE_APPLY_UNCONFIRMED, said in Indonesian, naming it', async () => {
      await materialPublished();
      await mongoose.connection.db!.collection('trainingModules').updateOne(
        { kpmId: FIXTURE_KPM, code: MODULE }, { $set: { officeContent: { files: [], videos: [], links: [{ id: 'x', label: 'Milik KPM', url: 'https://kpm.example/' }] } } },
      );
      const refused = await http().post(`${base()}/apply`).set(...IN_INDONESIAN)
        .send({ kinds: ['training_taxonomy'], kpmIds: [FIXTURE_KPM] }).expect(409);
      expect(refused.body.error).toMatchObject({
        code: 'TEMPLATE_APPLY_UNCONFIRMED', details: { codes: ['0417'], kpmIds: [FIXTURE_KPM] },
      });
      expect(refused.body.error.message).toMatch(/^KPM 0417 sudah mengubah bagian ini sendiri/);
      await http().post(`${base()}/apply`).send({ kinds: ['training_taxonomy'], kpmIds: [FIXTURE_KPM], replaceChanged: [FIXTURE_KPM] })
        .expect(200);
    });

    it('P19.4-T1 AC-10 another company’s template is 404; so is another company’s KPM, and a malformed body is 400', async () => {
      const theirs = `/admin/companies/${COMPANY}/templates/${otherTemplateId}`;
      await http().get(`${theirs}/offices?kind=training_taxonomy`).expect(404);
      await http().post(`${theirs}/apply`).send({ kinds: ['training_taxonomy'], kpmIds: [FIXTURE_KPM] }).expect(404);
      await http().post(`${theirs}/training/uploads`).send({ filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1 }).expect(404);
      await http().put(`${theirs}/training/modules/${MODULE}/content`).send({ links: [] }).expect(404);
      await materialPublished();
      await http().post(`${base()}/apply`).send({ kinds: ['training_taxonomy'], kpmIds: ['66f0000000000000000000ff'] }).expect(404);
      await http().post(`${base()}/apply`).send({ kinds: ['nonsense'], kpmIds: [FIXTURE_KPM] }).expect(400);
      await http().post(`${base()}/apply`).send({ kinds: ['training_taxonomy'], kpmIds: ['not-an-id'] }).expect(400);
      await http().get(`${base()}/offices?kind=nonsense`).expect(400);
    });
  });

  describe('P19.4-T1 AC-10 refused 403 to every tenant role and inside a view-as session', () => {
    const refused: [string, RequestContext][] = [
      ['the Owner', OWNER], ['the Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a view-as session', supporting(OWNER)],
    ];

    it.each(refused)('P19.4-T1 AC-10 %s', async (_who, ctx) => {
      session.current = ctx;
      for (const call of [
        http().get(`${base()}/offices?kind=training_taxonomy`),
        http().post(`${base()}/apply`).send({ kinds: ['training_taxonomy'], kpmIds: [FIXTURE_KPM] }),
        http().post(`${base()}/training/uploads`).send({ filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1 }),
        http().post(`${base()}/training/uploads/confirm`).send({ storageKey: 'dev/x' }),
        http().put(`${base()}/training/modules/${MODULE}/content`).send({ links: [] }),
      ]) {
        const res = await call;
        expect([res.status, res.body.error?.code]).toEqual([403, 'PERM_DENIED']);
      }
      expect(await mongoose.connection.db!.collection('assets').countDocuments({})).toBe(0);
      expect(await mongoose.connection.db!.collection('auditLog').countDocuments({ action: /^company_template\./ })).toBe(0);
    });
  });

  describe('P19.4-T1 AC-10 the KPM’s revert stays the Owner’s and the Admin’s', () => {
    it.each([['the Owner', OWNER], ['the Admin', ADMIN]] as const)('P19.4-T1 AC-10 %s may revert', async (_who, ctx) => {
      session.current = ctx;
      const res = await http().delete(`/kpm/settings/training/modules/${MODULE}/content`).expect(200);
      expect(res.body).toMatchObject({ moduleCode: MODULE, overridden: false });
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT], ['the Super Admin', SUPER_ADMIN]] as const)(
      'P19.4-T1 AC-10 %s may not', async (_who, ctx) => {
        session.current = ctx;
        const res = await http().delete(`/kpm/settings/training/modules/${MODULE}/content`);
        expect(res.status).toBe(403);
      },
    );

    it('P19.4-T1 AC-10 the settings list says where each module’s material comes from, for the Owner', async () => {
      session.current = OWNER;
      const res = await http().get('/kpm/settings/training').expect(200);
      const modules = res.body.flatMap((c: { skills: { modules: { material: string }[] }[] }) => c.skills.flatMap((s) => s.modules));
      expect(modules.every((m: { material: string }) => ['own', 'company', 'none'].includes(m.material))).toBe(true);
    });
  });
});
