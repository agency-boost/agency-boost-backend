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
import { NamedTemplateController } from './named-template.controller';
import { NamedTemplateService } from './named-template.service';
import { TemplateCopyService } from './template-copy.service';
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
        expect(res.body.error).toMatchObject({ code: 'ACTIVITY_TYPE_RESERVED', details: { codes: [code] } });
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
