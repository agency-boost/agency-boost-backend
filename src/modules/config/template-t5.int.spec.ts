import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AdminController } from '@/modules/tenants/admin.controller';
import { defaultPlaybookBody } from '@/modules/recruitment/recruitment-playbook-defaults';
import {
  AAB, AB, ADMIN, AGENT, OWNER, SUPER_ADMIN, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { NamedTemplateController } from './named-template.controller';
import { NamedTemplateService } from './named-template.service';
import { TemplateCopyService } from './template-copy.service';
import { platformDefaultPayload } from './template-defaults';
import { TemplateMaterialService } from './template-material.service';
import { TemplatePushService } from './template-push.service';
import { TemplateService } from './template.service';

const NOW = new Date('2026-11-05T03:00:00Z');
const MANULIFE = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';

/** A view-as session as `who`: it only looks (ADR-0206). */
const viewAs = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'u-support', null, false, true);

/**
 * **Templates over HTTP, as P19.4-T5 changes them** (AC-4, AC-6, AC-9, AC-11; ADR-0210, ADR-0213 §4): *Salin dari…*'s rung
 * map on both copy routes, the *Rekrutmen* section through the template's kind routes, a ratio set published straight
 * after its draft save (B1-10), and who may — behind the real `PermissionsGuard` and the production pipe.
 */
describe('P19.4-T5 templates over HTTP — the rung map, the Rekrutmen section, a publish that sticks', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let manulifeTemplate = '';
  let allianzTemplate = '';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await syncIndexes();
    const moduleRef = await Test.createTestingModule({
      controllers: [NamedTemplateController, AdminController],
      providers: [
        { provide: NamedTemplateService, useValue: wired.namedTemplates },
        { provide: TemplateCopyService, useValue: wired.templateCopies },
        { provide: TemplateService, useValue: wired.templateService },
        { provide: TemplateMaterialService, useValue: wired.templateMaterial },
        { provide: TemplatePushService, useValue: wired.templatePush },
      ],
    }).useMocker(() => ({})).compile();
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

  /** Manulife's ladder, Agent → BP → SBP; Allianz's, Agent → BP (the 11-03 handover, Part A). */
  async function ladder(companyId: string, codes: string[]) {
    for (const [i, code] of codes.entries()) {
      await mongoose.connection.collection('companyOrgLevels').insertOne({
        companyId, code, label: code, displayOrder: i + 1, leaderTier: null, status: 'active', archivedAt: null,
        deletedAt: null, version: 0,
      });
    }
  }

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    await companies.create({ _id: MANULIFE, name: 'Manulife', slug: 'manulife' } as never);
    await companies.create({ _id: ALLIANZ, name: 'Allianz', slug: 'allianz' } as never);
    await ladder(MANULIFE, ['AGENT', 'BP', 'SBP']);
    await ladder(ALLIANZ, ['AGENT', 'BP']);
    manulifeTemplate = (await wired.namedTemplates.create(SUPER_ADMIN, MANULIFE, { name: 'Manulife template', from: 'defaults' })).id;
    // Its ratios on SBP and BP, as Manulife's own are (Part A).
    const ratios = platformDefaultPayload('ratio_set') as { ratios: { appliesToOrgLevelCodes?: string[] }[] };
    ratios.ratios[0].appliesToOrgLevelCodes = ['SBP'];
    ratios.ratios[1].appliesToOrgLevelCodes = ['SBP', 'BP'];
    await wired.templateService.saveDraft(SUPER_ADMIN, MANULIFE, 'ratio_set', ratios as never, manulifeTemplate);
    await wired.templateService.publish(SUPER_ADMIN, MANULIFE, 'ratio_set', manulifeTemplate);
    allianzTemplate = (await wired.namedTemplates.create(SUPER_ADMIN, ALLIANZ, { name: 'Allianz template', from: 'empty' })).id;
  });

  const importBody = (rungMap?: Record<string, string>) => ({
    fromCompanyId: MANULIFE, templateId: manulifeTemplate, name: 'Dari Manulife', ...(rungMap ? { rungMap } : {}),
  });
  const kind = (companyId: string, k: string, templateId: string, suffix = '') =>
    `/admin/companies/${companyId}/template/${k}${suffix}?templateId=${templateId}`;

  describe('AC-4: Salin dari… maps the rungs the target lacks', () => {
    it('P19.4-T5 AC-4 without a map: 409 TEMPLATE_RUNG_UNKNOWN naming SBP — and the leader sections’ AAB and AB — nothing made', async () => {
      const res = await http().post(`/admin/companies/${ALLIANZ}/templates/import`).send(importBody()).expect(409);
      expect(res.body.error).toMatchObject({ code: 'TEMPLATE_RUNG_UNKNOWN', details: { codes: ['AAB', 'AB', 'SBP'] } });
      // A map that leaves one out is still refused, by that name.
      const partial = await http().post(`/admin/companies/${ALLIANZ}/templates/import`)
        .send(importBody({ AAB: 'BP', AB: 'BP' })).expect(409);
      expect(partial.body.error.details).toEqual({ codes: ['SBP'] });
      expect((await wired.namedTemplates.list(ALLIANZ)).map((t) => t.name)).toEqual(['Allianz template']);
    });

    it('P19.4-T5 AC-4 with SBP → BP: made, every ratio naming SBP now names BP once, and the audit row records the map', async () => {
      const map = { SBP: 'BP', AB: 'BP', AAB: 'BP' };
      const made = (await http().post(`/admin/companies/${ALLIANZ}/templates/import`).send(importBody(map)).expect(201)).body;
      const { kinds } = await wired.namedTemplates.publishedKindsOf(ALLIANZ, made.id);
      const named = (kinds.ratio_set!.ratios as { appliesToOrgLevelCodes: string[] }[]).map((r) => r.appliesToOrgLevelCodes);
      expect(named[0]).toEqual(['BP']);
      expect(named[1]).toEqual(['BP']);
      expect(JSON.stringify(kinds)).not.toContain('SBP');
      const sections = (kinds.activity_taxonomy!.categories as { appliesToOrgLevelCodes: string[] }[])
        .filter((c) => c.appliesToOrgLevelCodes.length);
      expect(sections.every((c) => c.appliesToOrgLevelCodes.join() === 'BP')).toBe(true);
      const audit = await mongoose.connection.collection('auditLog').findOne({ action: 'template.created', targetId: made.id });
      expect(audit!.after).toMatchObject({ from: 'import', rungMap: map });
    });

    it('P19.4-T5 AC-4 a map to a rung Allianz has not got live is 400, naming it; a malformed map is 400', async () => {
      const wrong = await http().post(`/admin/companies/${ALLIANZ}/templates/import`).send(importBody({ SBP: 'SM' })).expect(400);
      expect(wrong.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'rungMap', codes: ['SM'] } });
      await http().post(`/admin/companies/${ALLIANZ}/templates/import`).send({ ...importBody(), rungMap: { SBP: 3 } }).expect(400);
      await http().post(`/admin/companies/${ALLIANZ}/templates/import`).send({ ...importBody(), rungMap: ['BP'] }).expect(400);
    });

    it('P19.4-T5 AC-4 POST …/templates takes from.rungMap: within a company it moves a rung the company archived since', async () => {
      await mongoose.connection.collection('companyOrgLevels').updateOne({ companyId: MANULIFE, code: 'SBP' }, { $set: { status: 'archived' } });
      const made = (await http().post(`/admin/companies/${MANULIFE}/templates`)
        .send({ name: 'Tanpa SBP', from: { templateId: manulifeTemplate, rungMap: { SBP: 'BP' } } }).expect(201)).body;
      const { kinds } = await wired.namedTemplates.publishedKindsOf(MANULIFE, made.id);
      expect(JSON.stringify(kinds.ratio_set)).not.toContain('SBP');
      // Without one, within a company, nothing is refused (the ladder is shared), as before.
      await http().post(`/admin/companies/${MANULIFE}/templates`)
        .send({ name: 'Salinan', from: { templateId: manulifeTemplate } }).expect(201);
      await http().post(`/admin/companies/${MANULIFE}/templates`)
        .send({ name: 'Buruk', from: { templateId: manulifeTemplate, extra: 1 } }).expect(400);
    });
  });

  describe('AC-6, AC-11: the Rekrutmen section through the template’s kind routes', () => {
    it('P19.4-T5 AC-6 the Super Admin reads, drafts and publishes it — and the copy carries it', async () => {
      const read = (await http().get(kind(MANULIFE, 'recruitment_playbook', manulifeTemplate)).expect(200)).body;
      // From the defaults, the template holds the AgencyBoost words, published as version 1.
      expect(read).toMatchObject({ kind: 'recruitment_playbook', status: 'published', version: 1 });
      expect(Object.keys(read.playbook)).toEqual(['defaults', 'vocabulary', 'limits']);
      const body = { ...defaultPlaybookBody(), nextAction: 'Ajak ke BOP Manulife.' };
      const saved = (await http().put(kind(MANULIFE, 'recruitment_playbook', manulifeTemplate))
        .send({ payload: body, expectedRevision: read.revision }).expect(200)).body;
      expect(saved).toMatchObject({ status: 'draft', version: 2 });
      await http().post(kind(MANULIFE, 'recruitment_playbook', manulifeTemplate, '/publish')).expect(201);
      expect((await wired.recruitmentPlaybooks.publishedOf(MANULIFE, manulifeTemplate))!.body.nextAction).toBe('Ajak ke BOP Manulife.');
    });

    it('P19.4-T5 AC-11 another company’s template is 404 on every kind route, nothing written', async () => {
      for (const call of [
        http().get(kind(MANULIFE, 'recruitment_playbook', allianzTemplate)),
        http().put(kind(MANULIFE, 'recruitment_playbook', allianzTemplate)).send({ payload: defaultPlaybookBody() }),
        http().post(kind(MANULIFE, 'recruitment_playbook', allianzTemplate, '/publish')),
      ]) expect((await call).status).toBe(404);
      expect(await mongoose.connection.collection('companyTemplates').countDocuments({ templateId: allianzTemplate, kind: 'recruitment_playbook' })).toBe(0);
    });

    const refused: [string, RequestContext][] = [
      ['the Owner', OWNER], ['the Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a view-as session', viewAs(OWNER)],
    ];
    it.each(refused)('P19.4-T5 AC-11 refuses %s the section, the copies and the map, 403, nothing written', async (_who, who) => {
      session.current = who;
      for (const call of [
        http().get(kind(MANULIFE, 'recruitment_playbook', manulifeTemplate)),
        http().put(kind(MANULIFE, 'recruitment_playbook', manulifeTemplate)).send({ payload: defaultPlaybookBody() }),
        http().post(kind(MANULIFE, 'recruitment_playbook', manulifeTemplate, '/publish')),
        http().post(`/admin/companies/${ALLIANZ}/templates/import`).send(importBody({ SBP: 'BP', AB: 'BP', AAB: 'BP' })),
        http().post(`/admin/companies/${MANULIFE}/templates`).send({ name: 'X', from: { templateId: manulifeTemplate, rungMap: { SBP: 'BP' } } }),
      ]) expect((await call).status).toBe(403);
      session.current = SUPER_ADMIN;
      expect((await wired.namedTemplates.list(ALLIANZ)).length).toBe(1);
    });
  });

  describe('AC-9: a ratio set published straight after its draft save is live (B1-10, the Sequis publish)', () => {
    it('P19.4-T5 AC-9 save, then publish at once: the published version holds the edit and no draft is left', async () => {
      const read = (await http().get(kind(MANULIFE, 'ratio_set', manulifeTemplate)).expect(200)).body;
      const ratios = structuredClone(read.payload) as { ratios: { benchmark: number }[] };
      ratios.ratios[0].benchmark = 0.42;
      await http().put(kind(MANULIFE, 'ratio_set', manulifeTemplate)).send({ payload: ratios, expectedRevision: read.revision }).expect(200);
      await http().post(kind(MANULIFE, 'ratio_set', manulifeTemplate, '/publish')).expect(201);

      const live = (await http().get(kind(MANULIFE, 'ratio_set', manulifeTemplate)).expect(200)).body;
      expect(live).toMatchObject({ status: 'published', version: read.version + 1 });
      expect(live.published.payload.ratios[0].benchmark).toBe(0.42);
      expect(await mongoose.connection.collection('companyTemplates')
        .countDocuments({ companyId: MANULIFE, templateId: manulifeTemplate, kind: 'ratio_set', status: 'draft' })).toBe(0);
    });

    it('P19.4-T5 AC-9 a second editor’s save from before the last save is refused, so the publish stays live', async () => {
      const read = (await http().get(kind(MANULIFE, 'ratio_set', manulifeTemplate)).expect(200)).body;
      const mine = structuredClone(read.payload) as { ratios: { benchmark: number }[] };
      mine.ratios[0].benchmark = 0.42;
      const saved = (await http().put(kind(MANULIFE, 'ratio_set', manulifeTemplate))
        .send({ payload: mine, expectedRevision: read.revision }).expect(200)).body;
      await http().post(kind(MANULIFE, 'ratio_set', manulifeTemplate, '/publish')).expect(201);
      // The other session still holds what it read before this one's save — Part C's parallel sessions.
      const theirs = structuredClone(read.payload) as { ratios: { benchmark: number }[] };
      theirs.ratios[0].benchmark = 0.1;
      await http().put(kind(MANULIFE, 'ratio_set', manulifeTemplate)).send({ payload: theirs, expectedRevision: read.revision }).expect(409);
      const live = (await http().get(kind(MANULIFE, 'ratio_set', manulifeTemplate)).expect(200)).body;
      expect(live).toMatchObject({ status: 'published', revision: saved.revision });
      expect(live.payload.ratios[0].benchmark).toBe(0.42);
    });
  });
});
