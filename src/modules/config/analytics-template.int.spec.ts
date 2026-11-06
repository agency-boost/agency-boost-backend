import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { AdminController } from '@/modules/tenants/admin.controller';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, SUPER_ADMIN, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import type { AdvancedAnalyticsConfig, UploadField } from './analytics-config';
import { AnalyticsTemplateController } from './analytics-template.controller';
import { AnalyticsTemplateService } from './analytics-template.service';
import { NamedTemplateController } from './named-template.controller';
import { NamedTemplateService } from './named-template.service';
import { TemplateCopyService } from './template-copy.service';
import { TemplateMaterialService } from './template-material.service';
import { TemplatePushService } from './template-push.service';
import { TemplateService } from './template.service';

const NOW = new Date('2026-11-05T03:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const KPM_B = '66f0000000000000000000a2'; // Prudential, made from the same template, earlier
const KPM_ALLIANZ = '66f0000000000000000000a3';
/** The people, by account id: the roster reads their names. */
const U_OWNER_B = '66f0000000000000000000e4';
const U_OWNER_C = '66f0000000000000000000e6';
const U_AGENT_B = '66f0000000000000000000e5';
const U_OWNER = '66f0000000000000000000e1';
const U_ADMIN = '66f0000000000000000000e2';
const U_AGENT = '66f0000000000000000000e3';

/** A view-as session as `who`: it only looks (ADR-0206). */
const viewAs = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'u-support', null, false, true);

const fyc = (over: Partial<UploadField> = {}): UploadField => ({
  kode: 'FYC', system: false, label: { id: 'Komisi tahun pertama', en: 'First year commission' }, labelAliases: [],
  unit: 'rp_million', ytd: 'sum', min: 0, max: null, required: true, rows: 'all', effectiveFrom: '2026-12',
  tip: { id: '', en: '' }, ...over,
});

/**
 * **P19.5-T1 — the template's *Advanced analytics* section over HTTP** (ADR-0214 §1 to §4, §7, §9): its kind routes, the
 * editor's two reads, the locks and the system columns, the pattern test over every KPM's codes, a publish live at once
 * for every KPM on the template through the one reader, the notice, the push that never carries it — behind the real
 * `PermissionsGuard` and the production pipe. Super Admin only; every office role `403`.
 */
describe('P19.5-T1 the template’s Advanced analytics section over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let templateId = '';
  let allianzTemplate = '';
  const http = () => request(app.getHttpServer());
  const kind = (companyId = PRUDENTIAL) => `/admin/companies/${companyId}/template/advanced_analytics`;
  const q = (id = templateId) => `?templateId=${id}`;
  const col = (name: string) => mongoose.connection.collection(name);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await syncIndexes();
    const moduleRef = await Test.createTestingModule({
      controllers: [NamedTemplateController, AdminController, AnalyticsTemplateController],
      providers: [
        { provide: NamedTemplateService, useValue: wired.namedTemplates },
        { provide: TemplateCopyService, useValue: wired.templateCopies },
        { provide: TemplateService, useValue: wired.templateService },
        { provide: TemplateMaterialService, useValue: wired.templateMaterial },
        { provide: TemplatePushService, useValue: wired.templatePush },
        { provide: AnalyticsTemplateService, useValue: wired.analyticsTemplates },
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

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['memberships', 'monthlyAgentData']) await col(name).deleteMany({});
    wired.sentNotifications.length = 0;
    session.current = SUPER_ADMIN;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' } as never);
    const allianz = await companies.create({ _id: ALLIANZ, name: 'Allianz Life', slug: 'allianz' } as never);
    templateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, prudential as never))._id);
    allianzTemplate = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, allianz as never))._id);
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const startedFrom = (id: string) => ({ source: 'template', templateId: id, templateName: 'x' });
    await kpms.create([
      { _id: FIXTURE_KPM, companyId: PRUDENTIAL, code: '0417', branchName: 'BSD', startedFrom: startedFrom(templateId), ownerUserId: U_OWNER },
      // Made before templates were recorded: reads its company's default, the same template.
      { _id: KPM_B, companyId: PRUDENTIAL, code: '0555', branchName: 'Kelapa Gading', startedFrom: null, ownerUserId: U_OWNER_B },
      { _id: KPM_ALLIANZ, companyId: ALLIANZ, code: '0701', branchName: 'Allianz', startedFrom: startedFrom(allianzTemplate), ownerUserId: U_OWNER_C },
    ] as never);
    const member = (kpmId: string, userId: string, agentCode: string, isKpmAdmin = false) => ({
      kpmId, userId, agentCode, leaderCode: `L-${userId}`, status: 'active', adminAccess: { isKpmAdmin }, deletedAt: null,
    });
    await col('memberships').insertMany([
      // The Owner of 0417 is an Admin of it too: told once.
      member(FIXTURE_KPM, U_OWNER, '70012345', true),
      member(FIXTURE_KPM, U_ADMIN, '70012388', true),
      member(FIXTURE_KPM, U_AGENT, '80777'),
      member(KPM_B, U_OWNER_B, '70013011'),
      member(KPM_B, U_AGENT_B, '12345'),
      // Another company's codes are never this template's.
      member(KPM_ALLIANZ, U_OWNER_C, 'AL-1', true),
    ]);
  });

  const read = async () => (await http().get(`${kind()}${q()}`).expect(200)).body as {
    version: number; revision: number; status: string; payload: AdvancedAnalyticsConfig;
    analytics: { kpms: number; held: Record<string, string>; nextMonth: string; readers: Record<string, unknown> };
  };
  const save = (payload: AdvancedAnalyticsConfig, revision?: number) =>
    http().put(`${kind()}${q()}`).send({ payload, ...(revision !== undefined ? { expectedRevision: revision } : {}) });
  const publish = () => http().post(`${kind()}/publish${q()}`);
  const published201 = () => publish().expect(201);

  describe('as the Super Admin', () => {
    it('P19.5-T1 AC-1 reads the section: version 1’s seven columns, the KPMs on the template, Dipakai di, next month', async () => {
      const view = await read();
      expect(view).toMatchObject({ version: 1, status: 'published' });
      expect(view.payload.uploadFields.map((f) => f.kode)).toEqual(
        ['APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'FYP', 'POLICY_COUNT', 'UNIT_PERSISTENCY'],
      );
      expect(view.analytics).toMatchObject({ kpms: 2, held: {}, nextMonth: '2026-12' });
      expect(view.analytics.readers).toHaveProperty('APE');
    });

    it('P19.5-T1 AC-5 refuses deleting a system column (409 ANALYTICS_SYSTEM_COLUMN) and lets APE be renamed', async () => {
      const view = await read();
      const without = structuredClone(view.payload);
      without.uploadFields = without.uploadFields.filter((f) => f.kode !== 'APE');
      const refused = await save(without).expect(409);
      expect(refused.body.error).toMatchObject({ code: 'ANALYTICS_SYSTEM_COLUMN', details: { kode: 'APE' } });
      const id = await save(without).set(...IN_INDONESIAN).expect(409);
      expect(id.body.error.message).toBe('APE adalah kolom sistem: bisa diganti nama, tidak bisa dihapus.');

      const renamed = structuredClone(view.payload);
      renamed.uploadFields[0].label = { id: 'APE bersih', en: 'APE net' };
      const saved = await save(renamed, view.revision).expect(200);
      expect(saved.body.payload.uploadFields[0]).toMatchObject({ label: { id: 'APE bersih', en: 'APE net' } });
      expect(saved.body.payload.uploadFields[0].labelAliases).toContain('APE');
      expect(saved.body.analytics.kpms).toBe(2);
    });

    it('P19.5-T1 AC-7 locks the unit of a kode a KPM on the template holds data for (409 ANALYTICS_UNIT_LOCKED)', async () => {
      await col('monthlyAgentData').insertOne({
        kpmId: KPM_B, membershipId: 'm-b', agentCode: '70013011', month: '2026-08',
        persistencyMonthly: { value: 92, provenance: 'imported' }, deletedAt: null,
      });
      // Another company's figures lock nothing here.
      await col('monthlyAgentData').insertOne({
        kpmId: KPM_ALLIANZ, membershipId: 'm-c', agentCode: 'AL-1', month: '2026-01',
        fypMonthly: { value: 1, provenance: 'imported' }, deletedAt: null,
      });
      const view = await read();
      expect(view.analytics.held).toEqual({ PERSISTENCY: '2026-08' });
      const changed = structuredClone(view.payload);
      changed.uploadFields[1] = { ...changed.uploadFields[1], unit: 'count', max: null };
      const refused = await save(changed).expect(409);
      expect(refused.body.error).toMatchObject({
        code: 'ANALYTICS_UNIT_LOCKED', details: { field: 'uploadFields.1.unit', kode: 'PERSISTENCY' },
      });
      // FYP holds no figure on this template: its unit may change.
      const fyp = structuredClone(view.payload);
      fyp.uploadFields[4] = { ...fyp.uploadFields[4], unit: 'count' };
      await save(fyp).expect(200);
    });

    it('P19.5-T1 AC-6 refuses a field that breaks the type, 400 VALIDATION_FAILED naming it', async () => {
      const view = await read();
      const bad = structuredClone(view.payload);
      bad.uploadFields.push(fyc({ kode: 'fyc', unit: 'percent', max: 120 }));
      const refused = await save(bad).expect(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
      expect(refused.body.error.details.violations.map((v: { field: string }) => v.field))
        .toEqual(['uploadFields.7.kode', 'uploadFields.7.max']);
    });

    it('P19.5-T1 AC-11 tests a pattern over every registered code of the template’s KPMs, and refuses one it cannot read', async () => {
      const check = await http().get(`${kind()}/code-check${q()}&pattern=${encodeURIComponent('^[0-9]{8}$')}`).expect(200);
      expect(check.body).toEqual({ mismatched: 2, total: 5, examples: ['12345', '80777'] });
      const all = await http().get(`${kind()}/code-check${q()}&pattern=${encodeURIComponent('^\\d{3,32}$')}`).expect(200);
      expect(all.body).toEqual({ mismatched: 0, total: 5, examples: [] });
      // The field's *Contoh yang cocok*, answered beside the count.
      const example = await http()
        .get(`${kind()}/code-check${q()}&pattern=${encodeURIComponent('^[0-9]{8}$')}&example=7001`).expect(200);
      expect(example.body).toMatchObject({ mismatched: 2, exampleMatches: false });
      const unreadable = await http().get(`${kind()}/code-check${q()}&pattern=${encodeURIComponent('^(a)\\1$')}`).expect(400);
      expect(unreadable.body.error.code).toBe('VALIDATION_FAILED');
      await http().get(`${kind()}/code-check${q()}`).expect(400);
    });

    it('P19.5-T1 AC-11 (AT-10, Case 10) refuses a publish whose pattern registered codes do not match: 409, the count, five examples, nothing published', async () => {
      const view = await read();
      const eight = structuredClone(view.payload);
      eight.uploadRules = { ...eight.uploadRules, agentCodePattern: '^[0-9]{8}$', agentCodeExample: '70012345' };
      await save(eight).expect(200);
      const refused = await publish().expect(409);
      expect(refused.body.error).toMatchObject({
        code: 'ANALYTICS_CODE_PATTERN_MISMATCH', details: { mismatched: 2, total: 5, examples: ['12345', '80777'] },
      });
      const id = await publish().set(...IN_INDONESIAN).expect(409);
      expect(id.body.error.message).toContain('2 kode agen yang sudah terdaftar tidak cocok dengan format baru');
      expect((await read()).status).toBe('draft');
      expect((await wired.analyticsConfig.forOffice(FIXTURE_KPM)).version).toBe(1);
    });

    it('P19.5-T1 AC-2, AC-15 publishes v2, read at once by every KPM on the template — existing ones too — and by no other', async () => {
      const view = await read();
      const next = structuredClone(view.payload);
      next.uploadFields.push(fyc());
      await save(next, view.revision).expect(200);
      const published = await published201();
      expect(published.body).toMatchObject({ version: 2, status: 'published', analytics: { kpms: 2 } });

      for (const kpmId of [FIXTURE_KPM, KPM_B]) {
        const live = await wired.analyticsConfig.forOffice(kpmId);
        expect(live).toMatchObject({ templateId, templateName: 'Prudential template', version: 2 });
        expect(live.config.uploadFields.map((f) => f.kode)).toContain('FYC');
      }
      expect((await wired.analyticsConfig.forOffice(KPM_ALLIANZ)).config.uploadFields.map((f) => f.kode)).not.toContain('FYC');
      // Every version is kept.
      const history = await http().get(`${kind()}/history${q()}`).expect(200);
      expect(history.body.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    });

    it('P19.5-T1 AC-17 (AA UI-019) tells each Owner and Admin of every KPM on the template once — never someone who is both twice', async () => {
      const view = await read();
      const next = structuredClone(view.payload);
      next.uploadFields.push(fyc());
      await save(next).expect(200);
      await published201();
      const notices = wired.sentNotifications.filter((n) => n.templateId === NotificationTemplate.ANALYTICS_TEMPLATE_PUBLISHED);
      expect(notices.map((n) => [n.kpmId, n.userId]).sort()).toEqual([
        [FIXTURE_KPM, U_ADMIN], [FIXTURE_KPM, U_OWNER], [KPM_B, U_OWNER_B],
      ].sort());
      expect(notices[0].payload).toMatchObject({
        templateId, templateName: 'Prudential template', version: 2,
        newColumns: [{ kode: 'FYC', label: { id: 'Komisi tahun pertama', en: 'First year commission' }, effectiveFrom: '2026-12' }],
      });
    });

    it('P19.5-T1 AC-17 tells nobody of a publish that changes only the sections, the surveys or the thresholds', async () => {
      const view = await read();
      const next = structuredClone(view.payload);
      next.sections[0].enabled = false;
      next.thresholds.qualBigPct = 70;
      await save(next).expect(200);
      await published201();
      expect(wired.sentNotifications.filter((n) => n.templateId === NotificationTemplate.ANALYTICS_TEMPLATE_PUBLISHED)).toEqual([]);
    });

    it('P19.5-T1 AC-17 names the template and its version on the KPM’s month read (the Data upload banner)', async () => {
      const month = await wired.production.readMonth(OWNER, '2026-10');
      // P19.5-T2 adds the columns, the history's start and the completeness threshold to the same object (ADR-0214 §5).
      expect(month.config).toMatchObject({ templateId, templateName: 'Prudential template', version: 1 });
    });

    it('P19.5-T1 AC-16 publishes the section last in Terbitkan semua', async () => {
      const view = await read();
      const next = structuredClone(view.payload);
      next.sections.reverse();
      await save(next).expect(200);
      const all = await http().post(`/admin/companies/${PRUDENTIAL}/templates/${templateId}/publish`).expect(200);
      const results = all.body.results as { kind: string; outcome: string }[];
      expect(results[results.length - 1]).toEqual({ kind: 'advanced_analytics', outcome: 'published', version: 2 });
    });

    it('P19.5-T1 the push never carries it: every KPM answers current, and an apply naming it is 400', async () => {
      const offices = await http()
        .get(`/admin/companies/${PRUDENTIAL}/templates/${templateId}/offices?kind=advanced_analytics`).expect(200);
      // 0417, made from it: current, with no kind to list.
      expect(offices.body.map((o: { id: string; state: string; kinds: unknown[] }) => [o.id, o.state, o.kinds])).toEqual([
        [FIXTURE_KPM, 'current', []],
      ]);
      const apply = await http().post(`/admin/companies/${PRUDENTIAL}/templates/${templateId}/apply`)
        .send({ kinds: ['advanced_analytics'], kpmIds: [FIXTURE_KPM] }).expect(400);
      expect(apply.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('P19.5-T1 answers no open survey run until runs exist (ADR-0216 §2)', async () => {
      const runs = await http().get(`${kind()}/open-runs${q()}`).expect(200);
      expect(runs.body).toEqual({ nps: { runs: 0, kpms: 0 }, qual: { runs: 0, kpms: 0 } });
    });

    it('P19.5-T1 AC-20 audits every draft save and publish: who, when and the version', async () => {
      const view = await read();
      const next = structuredClone(view.payload);
      next.thresholds.subgroupOkPct = 75;
      await save(next).expect(200);
      await published201();
      const entries = await col('auditLog').find({ 'after.kind': 'advanced_analytics' }).sort({ createdAt: 1 }).toArray();
      expect(entries.map((e) => [e.action, e.after.version, e.actorUserId ?? e.realActorUserId ?? e.userId]))
        .toEqual([['company_template.draft_saved', 2, 'root'], ['company_template.published', 2, 'root']]);
    });

    it('P19.5-T1 refuses a stale draft save 409 VERSION_CONFLICT, as every section does', async () => {
      const view = await read();
      await save(view.payload, view.revision).expect(200);
      const stale = await save(view.payload, view.revision).expect(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('P19.5-T1 answers 404 for another company’s template, on every route', async () => {
      await http().get(`${kind()}${q(allianzTemplate)}`).expect(404);
      await http().get(`${kind()}/code-check${q(allianzTemplate)}&pattern=${encodeURIComponent('^.+$')}`).expect(404);
      await http().get(`${kind()}/open-runs${q(allianzTemplate)}`).expect(404);
      await http().post(`${kind()}/publish${q(allianzTemplate)}`).expect(404);
    });
  });

  describe('P19.5-T1 AC-2: no office role reaches it — 403 on every route, a view-as session too', () => {
    const roles: [string, RequestContext][] = [
      ['the Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
      ['a view-as session', viewAs(OWNER)],
    ];
    it.each(roles)('P19.5-T1 AC-2 refuses %s', async (_name, who) => {
      const payload = (await read()).payload;
      session.current = who;
      await http().get(`${kind()}${q()}`).expect(403);
      await http().put(`${kind()}${q()}`).send({ payload }).expect(403);
      await http().post(`${kind()}/publish${q()}`).expect(403);
      await http().get(`${kind()}/code-check${q()}&pattern=${encodeURIComponent('^.+$')}`).expect(403);
      await http().get(`${kind()}/open-runs${q()}`).expect(403);
      session.current = SUPER_ADMIN;
      expect((await read()).version).toBe(1);
    });
  });
});
