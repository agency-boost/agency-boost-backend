import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, SUPER_ADMIN, declaredPermissions, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { NamedTemplateController } from './named-template.controller';
import { NamedTemplateService } from './named-template.service';
import { TemplateCopyService } from './template-copy.service';
import { TemplateService } from './template.service';
import { platformDefaultPayload } from './template-defaults';
import { ActivityConfigService } from './activity.service';
import { ConfigChangeService } from './changes.service';
import { LeadStatusService } from './lead-status.service';
import { RatioService } from './ratio.service';
import { TenantConfigService } from './tenant-config.service';
import { TenantConfigController } from './config.controller';
import { TenantService } from '@/modules/tenants/tenant.service';

const NOW = new Date('2026-10-07T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';

/** A support session as `who`: elevated unless `readOnly` (§3.13). */
const supporting = (who: RequestContext, readOnly: boolean) =>
  new RequestContext(who.userId, 'none', who.membership, 'u-support', null, false, readOnly);

/**
 * **A company's named templates over HTTP** (P13.2-T6 AC-5), and the cascade types' archive refusal by
 * every role that may archive at all (AC-3) — behind the real `PermissionsGuard` and the production pipe.
 */
describe('named templates and the reserved activity types over HTTP (P13.2-T6)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  const http = () => request(app.getHttpServer());
  const base = `/admin/companies/${COMPANY}/templates`;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [NamedTemplateController, TenantConfigController],
      providers: [
        { provide: NamedTemplateService, useValue: wired.namedTemplates },
        { provide: TemplateCopyService, useValue: wired.templateCopies },
        { provide: TemplateService, useValue: wired.templateService },
        { provide: ActivityConfigService, useValue: wired.activity },
        { provide: LeadStatusService, useValue: wired.leads },
        { provide: RatioService, useValue: wired.ratios },
        { provide: TenantConfigService, useValue: wired.config },
        { provide: ConfigChangeService, useValue: wired.changes },
        { provide: TenantService, useValue: {} },
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
    for (const [_id, name] of [[COMPANY, 'Prudential'], [OTHER_COMPANY, 'Allianz Life']]) {
      const company = await companies.create({ _id, name, slug: name.toLowerCase().replace(/\s/g, '-') } as never);
      await wired.namedTemplates.createFirst(SUPER_ADMIN, company as never);
    }
  });

  it('declares company_template:read and :write on its routes, and nothing else', () => {
    expect(declaredPermissions(NamedTemplateController)).toEqual({
      list: 'company_template:read',
      create: 'company_template:write',
      // P13.2-T7: *Import from another company*.
      importFrom: 'company_template:write',
      update: 'company_template:write',
      // ADR-0185: *Terbitkan semua*, and the offices behind the checklist's count.
      publishAll: 'company_template:write',
      offices: 'company_template:read',
      archive: 'company_template:write',
    });
  });

  describe('AC-5: refused 403 to every tenant role and a support session', () => {
    const refused: [string, RequestContext][] = [
      ['the Owner', OWNER], ['the Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a read-only support session', supporting(OWNER, true)],
      ['an elevated support session', supporting(OWNER, false)],
    ];

    it.each(refused)('%s', async (_who, ctx) => {
      const defaultId = String((await wired.namedTemplates.resolve(COMPANY))._id);
      session.current = ctx;
      for (const call of [
        http().get(base),
        http().post(base).send({ name: 'Mine', from: 'empty' }),
        http().patch(`${base}/${defaultId}`).send({ name: 'Renamed' }),
        http().post(`${base}/${defaultId}/archive`),
        // ADR-0185.
        http().post(`${base}/${defaultId}/publish`),
        http().get(`${base}/${defaultId}/offices`),
      ]) {
        const res = await call;
        expect([res.status, res.body.error?.code]).toEqual([403, 'PERM_DENIED']);
      }
      expect(await (wired.namedTemplateRows as unknown as mongoose.Model<{ companyId: string }>).countDocuments({ companyId: COMPANY })).toBe(1);
    });
  });

  describe('as the Super Admin', () => {
    it('lists the company’s templates, the default first, and refuses another company’s template as 404', async () => {
      const made = await http().post(base).send({ name: 'Jakarta branches', from: 'defaults' }).expect(201);
      expect(made.body).toMatchObject({
        name: 'Jakarta branches', isDefault: false, status: 'active', origin: { kind: 'defaults' }, officeCount: 0,
      });
      expect(Object.values(made.body.publishedVersions)).toEqual(Array(7).fill(1));

      const list = await http().get(base).expect(200);
      expect(list.body.map((t: { name: string; isDefault: boolean }) => [t.name, t.isDefault])).toEqual([
        ['Prudential template', true], ['Jakarta branches', false],
      ]);

      const theirs = String((await wired.namedTemplates.resolve(OTHER_COMPANY))._id);
      await http().patch(`${base}/${theirs}`).send({ name: 'Taken over' }).expect(404);
      await http().post(`${base}/${theirs}/archive`).expect(404);
      await http().patch(`${base}/not-an-id`).send({ name: 'x' }).expect(404);
    });

    it('refuses a name an active template has, ignoring case — 409 TEMPLATE_NAME_TAKEN', async () => {
      const res = await http().post(base).send({ name: 'prudential TEMPLATE', from: 'empty' }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', details: { name: 'prudential TEMPLATE' } });
    });

    it('P18.98-T5 AC-7 refuses a taken name, archiving the default and a start it cannot read, in Indonesian', async () => {
      const taken = await http().post(base).set(...IN_INDONESIAN).send({ name: 'prudential TEMPLATE', from: 'empty' }).expect(409);
      expect(taken.body.error).toMatchObject({
        code: 'TEMPLATE_NAME_TAKEN',
        message: 'Perusahaan ini sudah memiliki template bernama prudential TEMPLATE. Pilih nama lain.',
        details: { name: 'prudential TEMPLATE' },
      });

      const defaultId = String((await wired.namedTemplates.resolve(COMPANY))._id);
      const archive = await http().post(`${base}/${defaultId}/archive`).set(...IN_INDONESIAN).expect(409);
      expect(archive.body.error).toMatchObject({
        code: 'TEMPLATE_IS_DEFAULT',
        message: 'Prudential template adalah template default perusahaan ini, jadi tidak dapat diarsipkan. Jadikan '
          + 'template lain sebagai default terlebih dahulu, lalu arsipkan template ini.',
      });

      // The DTO's own decorator sentence (`field`), in `details.violations` and the message alike.
      const start = await http().post(base).set(...IN_INDONESIAN).send({ name: 'x', from: 'somewhere' }).expect(400);
      expect(start.body.error.details.violations).toEqual([
        'from harus "empty", "defaults", atau { templateId } yang menyebut salah satu template perusahaan',
      ]);
    });

    it('validates the body: a name, and one of the two starts', async () => {
      await http().post(base).send({ name: '', from: 'empty' }).expect(400);
      await http().post(base).send({ name: 'x', from: 'somewhere' }).expect(400);
      await http().post(base).send({ name: 'x', from: 'empty', extra: true }).expect(400);
    });

    it('moves the default with Make default, refuses un-defaulting the default, and refuses archiving it', async () => {
      const defaultId = String((await wired.namedTemplates.resolve(COMPANY))._id);
      const other = (await http().post(base).send({ name: 'Second', from: 'empty' }).expect(201)).body;

      const unDefault = await http().patch(`${base}/${defaultId}`).send({ isDefault: false }).expect(409);
      expect(unDefault.body.error.code).toBe('TEMPLATE_IS_DEFAULT');
      const archiveDefault = await http().post(`${base}/${defaultId}/archive`).expect(409);
      expect(archiveDefault.body.error.code).toBe('TEMPLATE_IS_DEFAULT');

      await http().patch(`${base}/${other.id}`).send({ isDefault: true }).expect(200);
      const list = (await http().get(base).expect(200)).body as { id: string; isDefault: boolean }[];
      expect(list.filter((t) => t.isDefault).map((t) => t.id)).toEqual([other.id]);

      // The old default is an ordinary template now, and can be archived.
      const archived = await http().post(`${base}/${defaultId}/archive`).expect(200);
      expect(archived.body).toMatchObject({ status: 'archived', isDefault: false });
    });
  });

  /**
   * **ADR-0185: a template as a checklist of its sections** — what each kind holds and whether a draft waits, every
   * kind with a draft published at once, and the offices the template answers for with what each is behind on.
   */
  describe('ADR-0185: sections, Terbitkan semua and the offices behind', () => {
    const save = (templateId: string, kind: Parameters<TemplateService['saveDraft']>[2], payload: Record<string, unknown>) =>
      wired.templateService.saveDraft(SUPER_ADMIN, COMPANY, kind, payload, templateId);

    it('lists each kind’s newest published version and whether a draft waits', async () => {
      const made = (await http().post(base).send({ name: 'Jakarta branches', from: 'defaults' }).expect(201)).body;
      const empty = (await http().post(base).send({ name: 'Nothing yet', from: 'empty' }).expect(201)).body;
      await save(made.id, 'lead_pipeline', platformDefaultPayload('lead_pipeline'));

      const list = (await http().get(base).expect(200)).body as {
        id: string; sections: Record<string, { publishedVersion: number | null; hasDraft: boolean }>;
      }[];
      const jakarta = list.find((t) => t.id === made.id)!;
      expect(jakarta.sections.lead_pipeline).toEqual({ publishedVersion: 1, hasDraft: true });
      expect(jakarta.sections.activity_taxonomy).toEqual({ publishedVersion: 1, hasDraft: false });
      expect(Object.keys(jakarta.sections)).toHaveLength(7);

      // A template made empty: every kind *Kosong*.
      const nothing = list.find((t) => t.id === empty.id)!;
      expect(Object.values(nothing.sections)).toEqual(Array(7).fill({ publishedVersion: null, hasDraft: false }));
    });

    it('publishes every kind with a draft, the taxonomy before the ratios built on it, and reports a refusal without stopping the rest', async () => {
      const made = (await http().post(base).send({ name: 'From scratch', from: 'empty' }).expect(201)).body;
      // The ratios name types only the draft taxonomy declares: published in that order, both go out.
      await save(made.id, 'ratio_set', platformDefaultPayload('ratio_set'));
      await save(made.id, 'activity_taxonomy', platformDefaultPayload('activity_taxonomy'));
      // An empty ladder is refused, as its own publish refuses it.
      await save(made.id, 'lead_pipeline', { statuses: [] });

      const res = await http().post(`${base}/${made.id}/publish`).expect(200);
      expect(res.body.results).toEqual([
        { kind: 'activity_taxonomy', outcome: 'published', version: 1 },
        { kind: 'ratio_set', outcome: 'published', version: 1 },
        {
          kind: 'lead_pipeline', outcome: 'refused',
          error: { code: 'VALIDATION_FAILED', message: 'The sales pipeline has no stages.' },
        },
        { kind: 'training_taxonomy', outcome: 'skipped', reason: 'no_changes' },
        { kind: 'activation_checklist', outcome: 'skipped', reason: 'no_changes' },
        { kind: 'capability_ladder', outcome: 'skipped', reason: 'no_changes' },
        { kind: 'event_types', outcome: 'skipped', reason: 'no_changes' },
      ]);
      expect(res.body.template).toMatchObject({ id: made.id, name: 'From scratch' });
      expect(res.body.template.sections.activity_taxonomy).toEqual({ publishedVersion: 1, hasDraft: false });
      // Refused, it is still a draft, waiting to be fixed.
      expect(res.body.template.sections.lead_pipeline).toEqual({ publishedVersion: null, hasDraft: true });

      // Nothing waits but the refused one: a second press publishes nothing new.
      const again = await http().post(`${base}/${made.id}/publish`).expect(200);
      expect(again.body.results.filter((r: { outcome: string }) => r.outcome === 'published')).toEqual([]);
    });

    it('P18.98-T5 says a refused kind in the reader’s language', async () => {
      const made = (await http().post(base).send({ name: 'Kosong', from: 'empty' }).expect(201)).body;
      await save(made.id, 'lead_pipeline', { statuses: [] });
      const res = await http().post(`${base}/${made.id}/publish`).set(...IN_INDONESIAN).expect(200);
      expect(res.body.results.find((r: { kind: string }) => r.kind === 'lead_pipeline')).toEqual({
        kind: 'lead_pipeline', outcome: 'refused',
        error: { code: 'VALIDATION_FAILED', message: 'Pipeline sales tidak memiliki tahap.' },
      });
    });

    it('refuses an archived template 400 and another company’s template 404, writing nothing', async () => {
      const made = (await http().post(base).send({ name: 'Old', from: 'empty' }).expect(201)).body;
      await save(made.id, 'event_types', platformDefaultPayload('event_types'));
      await http().post(`${base}/${made.id}/archive`).expect(200);
      const archived = await http().post(`${base}/${made.id}/publish`).expect(400);
      expect(archived.body.error.code).toBe('VALIDATION_FAILED');

      const theirs = String((await wired.namedTemplates.resolve(OTHER_COMPANY))._id);
      await http().post(`${base}/${theirs}/publish`).expect(404);
      await http().get(`${base}/${theirs}/offices`).expect(404);
      await http().post(`${base}/not-an-id/publish`).expect(404);
      await http().post(`/admin/companies/66f0000000000000000000ff/templates/${made.id}/publish`).expect(404);

      const rows = wired.templates as unknown as mongoose.Model<{ templateId: string; status: string }>;
      expect(await rows.countDocuments({ templateId: made.id, status: 'published' })).toBe(0);
    });

    it('lists the offices a template answers for, by code, with the kinds each is behind on and has no record of', async () => {
      const made = (await http().post(base).send({ name: 'Branches', from: 'defaults' }).expect(201)).body;
      const other = (await http().post(base).send({ name: 'Elsewhere', from: 'defaults' }).expect(201)).body;
      const kpms = wired.kpms as unknown as mongoose.Model<Record<string, unknown>>;
      const office = (code: string, templateId: string, seededFrom: Record<string, unknown>, deletedAt: Date | null = null) =>
        kpms.create({
          companyId: COMPANY, code, branchName: `Branch ${code}`, timezone: 'Asia/Jakarta', deletedAt,
          startedFrom: { source: 'template', templateId, templateName: 'x' }, seededFrom,
        });
      const v1 = { templateId: made.id, version: 1 };
      const all = Object.fromEntries(Object.keys(made.sections).map((kind) => [kind, v1]));
      await office('0902', made.id, all);
      // Built when the template held no event types, and before its checklist was recorded.
      const { activation_checklist: _unrecorded, ...rest } = all;
      await office('0901', made.id, { ...rest, event_types: { templateId: made.id, version: null } });
      await office('0903', other.id, all);
      await office('0904', made.id, all, NOW);

      // A newer taxonomy: both of the template's live offices are behind on it.
      await save(made.id, 'activity_taxonomy', platformDefaultPayload('activity_taxonomy'));
      await http().post(`${base}/${made.id}/publish`).expect(200);

      const res = await http().get(`${base}/${made.id}/offices`).expect(200);
      expect(res.body.map((o: { code: string }) => o.code)).toEqual(['0901', '0902']);
      expect(res.body[0]).toMatchObject({
        code: '0901', branchName: 'Branch 0901',
        behind: ['activity_taxonomy', 'event_types'], unrecorded: ['activation_checklist'],
      });
      expect(res.body[1]).toMatchObject({ code: '0902', behind: ['activity_taxonomy'], unrecorded: [] });

      // Nothing changed in any office: information only.
      const untouched = await kpms.findOne({ code: '0902' }).lean().exec();
      expect((untouched!.seededFrom as Record<string, { version: number }>).activity_taxonomy.version).toBe(1);
    });
  });

  describe('AC-3: archiving a cascade type, or its section, is 409 for every role that may archive', () => {
    beforeEach(async () => { await provisionOffice(wired, FIXTURE_KPM, COMPANY); });

    it.each([
      ['the Owner', OWNER], ['the Admin', ADMIN], ['an elevated support session', supporting(OWNER, false)],
    ] as [string, RequestContext][])('%s', async (_who, ctx) => {
      session.current = ctx;
      const sections = (await http().get('/kpm/settings/activity-types').expect(200)).body as {
        id: string; code: string; types: { id: string; code: string }[];
      }[];
      const selling = sections.find((c) => c.code === 'SELLING')!;
      const leads = sections.find((c) => c.code === 'LEADS_GENERATION')!;

      for (const code of ['SELL_PRESENTATION', 'SELL_SUBMISSION']) {
        const type = selling.types.find((t) => t.code === code)!;
        const res = await http().delete(`/kpm/settings/activity-types/${type.id}`).expect(409);
        expect(res.body.error).toMatchObject({ code: 'ACTIVITY_TYPE_BOUND', details: { codes: [code] } });
      }
      const contacted = leads.types.find((t) => t.code === 'LEADS_CONTACTED')!;
      await http().delete(`/kpm/settings/activity-types/${contacted.id}`).expect(409);
      const section = await http().delete(`/kpm/settings/activity-categories/${leads.id}`).expect(409);
      expect(section.body.error.details.codes).toEqual(['LEADS_CONTACTED']);

      // Renaming, describing, reordering and moving it are served.
      await http().patch(`/kpm/settings/activity-types/${contacted.id}`)
        .send({ label: 'Follow-up prospek', description: 'Telepon atau WhatsApp' }).expect(200);
      const all = sections.flatMap((c) => c.types).map((t) => t.id);
      await http().patch('/kpm/settings/activity-types/reorder').send({ ids: [...all].reverse() }).expect(200);
      await http().patch(`/kpm/settings/activity-types/${contacted.id}`).send({ categoryCode: 'SELLING' }).expect(200);
      // Moved out, its old section can be archived.
      await http().delete(`/kpm/settings/activity-categories/${leads.id}`).expect(200);
    });
  });
});
