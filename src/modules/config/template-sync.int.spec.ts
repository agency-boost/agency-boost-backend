import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { defaultCapabilityLadder } from '@/modules/capability/capability-payload';
import { defaultTrainingTaxonomy } from '@/modules/training/training-payload';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, SUPER_ADMIN, declaredPermissions, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { IN_INDONESIAN } from '../../../test/i18n';
import { TemplateSyncController } from './template-sync.controller';
import { TemplateSyncService } from './template-sync.service';

const NOW = new Date('2026-11-06T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_KPM = '66f0000000000000000000b2';
const db = () => mongoose.connection.db!;

/** A support session as `who`, read-only (ADR-0206 §1). */
const supporting = (who: RequestContext) => new RequestContext(who.userId, 'none', who.membership, 'u-support', null, false, true);

/** The Owner of another KPM made from the same template. */
const OTHER_OWNER = new RequestContext('u-owner-b', 'none', {
  membershipId: 'mem-b', kpmId: OTHER_KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/** The template's next Training: one skill and one module renamed, with descriptions; a module only the template has. */
function renamedTraining() {
  const payload = defaultTrainingTaxonomy();
  const prospecting = payload.skills.find((s) => s.code === 'PROSPECTING')!;
  prospecting.label = 'Leads generation';
  prospecting.description = '8 cara mendapat calon nasabah';
  const list = payload.modules.find((m) => m.code === 'PROSPECT_LIST')!;
  list.description = 'Daftar 100 nama untuk dihubungi';
  // Only the template has it: a push's to add, never a sync's.
  payload.modules.push({ code: 'TEMPLATE_ONLY', skillCode: 'PROSPECTING', title: 'Hanya di template', publishState: 'published' });
  return payload;
}

/** The template's next Capability: one item named as the skill. */
function renamedCapability() {
  const payload = defaultCapabilityLadder();
  const grid = payload.grids.find((g) => g.code === 'PERSONAL_SELLING')!;
  grid.items = grid.items.map((i) => (i.code === 'LEADS_GEN' ? { ...i, label: 'Leads generation' } : i));
  return payload;
}

/**
 * ***Sinkron dari template* over HTTP** (P19.6-T4 AC-3, AC-5; ADR-0220 §4; OD-270, UI-161) — behind the stubbed sign-in,
 * the view-as guard and the real `PermissionsGuard`, with the production pipe.
 */
describe('P19.6-T4 Sinkron dari template over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let templateId: string;
  const http = () => request(app.getHttpServer());
  const URL = '/kpm/settings/training/template-sync';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [TemplateSyncController],
      providers: [{ provide: TemplateSyncService, useValue: wired.templateSync }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(reflector), new PermissionsGuard(reflector));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  /** Publish `payload` as the template's next version of `kind`. */
  async function publish(kind: 'training_taxonomy' | 'capability_ladder', payload: unknown) {
    await wired.templateService.saveDraft(SUPER_ADMIN, COMPANY, kind, payload as never, templateId);
    await wired.templateService.publish(SUPER_ADMIN, COMPANY, kind, templateId);
  }

  /** A KPM made from the template now, with its first published configuration. */
  async function officeFromTemplate(kpmId: string, code: string) {
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const startFrom = { kind: 'template' as const, templateId };
    const plan = await wired.provisioning.planFor(COMPANY, startFrom);
    await kpms.create({ _id: kpmId, companyId: COMPANY, code, branchName: `Kantor ${code}`, startedFrom: plan.startedFrom } as never);
    const done = await provisionFrom(wired, kpmId, COMPANY, startFrom);
    await kpms.updateOne({ _id: kpmId } as never, { $set: { seededFrom: done.seededFrom } } as never);
    await wired.provisioning.publishInitialSnapshotFor(kpmId, RequestContext.superAdminInTenant('root', kpmId));
  }

  beforeEach(async () => {
    await clearCollections();
    session.current = OWNER;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    templateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, prudential as never))._id);
    await publish('training_taxonomy', defaultTrainingTaxonomy());
    await publish('capability_ladder', defaultCapabilityLadder());
    await officeFromTemplate(FIXTURE_KPM, '0417');
    await officeFromTemplate(OTHER_KPM, '0555');
  });

  const newestVersion = async (kind: string) => (await db().collection('companyTemplates')
    .find({ companyId: COMPANY, templateId, kind, status: 'published' }).sort({ version: -1 }).limit(1).toArray())[0].version as number;
  const row = (collection: string, kpmId: string, code: string) => db().collection(collection).findOne({ kpmId, code });

  it('P19.6-T4 routes: the read is training_settings:read, the apply tenant_config:write', () => {
    expect(declaredPermissions(TemplateSyncController)).toEqual({
      read: 'training_settings:read', apply: 'tenant_config:write',
    });
  });

  it('P19.6-T4 AC-3 a KPM in line with its template reads no differences, so the control is not shown', async () => {
    const res = await http().get(URL).expect(200);
    expect(res.body).toEqual({
      template: { id: templateId, name: expect.any(String) },
      templateVersions: { training_taxonomy: await newestVersion('training_taxonomy'), capability_ladder: await newestVersion('capability_ladder') },
      revision: expect.stringMatching(/^[0-9a-f]{16}$/),
      differences: [],
    });
  });

  it('P19.6-T4 AC-3 AC-5 shows by code every name and description that would change, the capability item’s too, and nothing only one side has', async () => {
    await publish('training_taxonomy', renamedTraining());
    await publish('capability_ladder', renamedCapability());
    const res = await http().get(URL).expect(200);
    expect(res.body.differences).toEqual([
      { level: 'skill', code: 'PROSPECTING', field: 'name', from: 'Pencarian prospek', to: 'Leads generation' },
      { level: 'skill', code: 'PROSPECTING', field: 'description', from: null, to: '8 cara mendapat calon nasabah' },
      { level: 'module', code: 'PROSPECT_LIST', field: 'description', from: null, to: 'Daftar 100 nama untuk dihubungi' },
      { level: 'capability_item', code: 'PERSONAL_SELLING:LEADS_GEN', field: 'name', from: 'Konsistensi pencarian leads', to: 'Leads generation' },
    ]);
    // A read writes nothing.
    expect((await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'))!.label).toBe('Pencarian prospek');
  });

  it('P19.6-T4 AC-3 AC-5 applies them — names and descriptions only, each row a new version — publishes with origin template_sync, and audits it', async () => {
    await publish('training_taxonomy', renamedTraining());
    await publish('capability_ladder', renamedCapability());
    const before = {
      skill: await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'),
      module: await row('trainingModules', FIXTURE_KPM, 'PROSPECT_LIST'),
      catalog: await db().collection('capabilityCatalogs').findOne({ kpmId: FIXTURE_KPM }),
      snapshots: await db().collection('configSnapshots').countDocuments({ kpmId: FIXTURE_KPM }),
      modules: await db().collection('trainingModules').countDocuments({ kpmId: FIXTURE_KPM }),
    };
    const preview = (await http().get(URL).expect(200)).body;

    const res = await http().post(URL)
      .send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision }).expect(200);
    expect(res.body).toMatchObject({ outcome: 'published', differences: preview.differences });
    expect(res.body.revision).not.toBe(preview.revision);

    const skill = (await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'))!;
    expect(skill).toMatchObject({
      code: 'PROSPECTING', label: 'Leads generation', description: '8 cara mendapat calon nasabah',
      version: before.skill!.version + 1, status: 'active', displayOrder: before.skill!.displayOrder, categoryCode: 'SALES',
    });
    const module = (await row('trainingModules', FIXTURE_KPM, 'PROSPECT_LIST'))!;
    expect(module).toMatchObject({
      code: 'PROSPECT_LIST', title: before.module!.title, description: 'Daftar 100 nama untuk dihubungi',
      version: before.module!.version + 1, publishState: before.module!.publishState, displayOrder: before.module!.displayOrder,
    });
    // Its material, untouched.
    expect(module.companyContent).toEqual(before.module!.companyContent);
    expect(module.officeContent).toEqual(before.module!.officeContent);
    // An item only the template has is not added.
    expect(await db().collection('trainingModules').countDocuments({ kpmId: FIXTURE_KPM })).toBe(before.modules);
    expect(await row('trainingModules', FIXTURE_KPM, 'TEMPLATE_ONLY')).toBeNull();

    // AC-5: the capability item named as the skill, its code and grid kept; the catalogue one version on.
    const catalog = (await db().collection('capabilityCatalogs').findOne({ kpmId: FIXTURE_KPM }))!;
    const item = (catalog.grids as { code: string; items: { code: string; label: string }[] }[])
      .find((g) => g.code === 'PERSONAL_SELLING')!.items.find((i) => i.code === 'LEADS_GEN')!;
    expect(item.label).toBe('Leads generation');
    expect(catalog.version).toBe(before.catalog!.version + 1);
    expect((catalog.grids as unknown[]).length).toBe((before.catalog!.grids as unknown[]).length);

    // Published as a push is, so agents read the names at once.
    const [newest] = await db().collection('configSnapshots').find({ kpmId: FIXTURE_KPM }).sort({ version: -1 }).limit(1).toArray();
    expect(await db().collection('configSnapshots').countDocuments({ kpmId: FIXTURE_KPM })).toBe(before.snapshots + 1);
    expect(newest.origin).toEqual({ source: 'template_sync', templateId, templateVersions: preview.templateVersions });
    const offered = (newest.payload.training as { skills: { code: string; label: string; description: string | null }[] }[])
      .flatMap((c) => c.skills).find((s) => s.code === 'PROSPECTING')!;
    expect(offered).toMatchObject({ label: 'Leads generation', description: '8 cara mendapat calon nasabah' });

    // `seededFrom` does not move: the KPM took names, not the section.
    const kpm = (await (wired.kpms as unknown as mongoose.Model<{ seededFrom: unknown }>).findById(FIXTURE_KPM).lean().exec())!;
    expect((kpm.seededFrom as Record<string, { version: number }>).training_taxonomy.version)
      .toBeLessThan(preview.templateVersions.training_taxonomy);

    const [audit] = await db().collection('auditLog').find({ action: 'training.template_synced' }).toArray();
    expect(audit).toMatchObject({
      kpmId: FIXTURE_KPM,
      after: expect.objectContaining({
        templateId, outcome: 'published', templateVersions: preview.templateVersions,
        changes: expect.arrayContaining([
          { level: 'skill', code: 'PROSPECTING', field: 'name', from: 'Pencarian prospek', to: 'Leads generation' },
        ]),
      }),
    });

    // A second read finds nothing left to take.
    expect((await http().get(URL).expect(200)).body.differences).toEqual([]);
  });

  it('P19.6-T4 AC-3 a KPM with its own changes waiting keeps them waiting, the names with them — nothing published for it', async () => {
    await publish('training_taxonomy', renamedTraining());
    await wired.training.updateCategory(OWNER, String((await row('trainingCategories', FIXTURE_KPM, 'SALES'))!._id), { label: 'Penjualan' });
    const snapshots = await db().collection('configSnapshots').countDocuments({ kpmId: FIXTURE_KPM });
    const preview = (await http().get(URL).expect(200)).body;
    // The KPM's own category name differs from the template's too, and is listed with the rest.
    expect(preview.differences).toContainEqual({ level: 'category', code: 'SALES', field: 'name', from: 'Penjualan', to: 'Sales' });

    const res = await http().post(URL)
      .send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision }).expect(200);
    expect(res.body.outcome).toBe('awaiting_publish');
    expect(await db().collection('configSnapshots').countDocuments({ kpmId: FIXTURE_KPM })).toBe(snapshots);
    expect((await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'))!.label).toBe('Leads generation');
  });

  it('P19.6-T4 AC-3 is 409 VERSION_CONFLICT when the template published again since the preview, and writes nothing', async () => {
    await publish('training_taxonomy', renamedTraining());
    const preview = (await http().get(URL).expect(200)).body;
    await publish('training_taxonomy', renamedTraining());
    const res = await http().post(URL).set(...IN_INDONESIAN)
      .send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision }).expect(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
    expect(res.body.error.message).toMatch(/^Template diterbitkan lagi/);
    expect((await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'))!.label).toBe('Pencarian prospek');
    expect(await db().collection('auditLog').countDocuments({ action: 'training.template_synced' })).toBe(0);
  });

  it('P19.6-T4 AC-3 is 409 VERSION_CONFLICT when the KPM’s training changed since the preview, and writes nothing', async () => {
    await publish('training_taxonomy', renamedTraining());
    const preview = (await http().get(URL).expect(200)).body;
    await wired.training.updateSkill(OWNER, String((await row('trainingSkills', FIXTURE_KPM, 'CLOSING'))!._id), { label: 'Closing!' });
    const res = await http().post(URL)
      .send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedRevision: preview.revision } });
    expect((await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'))!.label).toBe('Pencarian prospek');
  });

  it('P19.6-T4 AC-3 refuses a malformed body 400 VALIDATION_FAILED: no revision, no versions, an unknown field, a bad version', async () => {
    const preview = (await http().get(URL).expect(200)).body;
    for (const body of [
      { templateVersions: preview.templateVersions },
      { expectedRevision: preview.revision },
      { templateVersions: preview.templateVersions, expectedRevision: preview.revision, replaceAll: true },
      { templateVersions: { training_taxonomy: 'seven', capability_ladder: null }, expectedRevision: preview.revision },
      { templateVersions: preview.templateVersions, expectedRevision: '' },
    ]) {
      const res = await http().post(URL).send(body);
      expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  it('P19.6-T4 AC-3 a KPM made from no template reads none and is refused the apply 400', async () => {
    await (wired.kpms as unknown as mongoose.Model<never>).updateOne(
      { _id: FIXTURE_KPM } as never, { $set: { startedFrom: { source: 'defaults', templateId: null, templateName: null } } } as never,
    ).exec();
    const read = await http().get(URL).expect(200);
    expect(read.body).toMatchObject({ template: null, templateVersions: { training_taxonomy: null, capability_ladder: null }, differences: [] });
    const res = await http().post(URL)
      .send({ templateVersions: { training_taxonomy: null, capability_ladder: null }, expectedRevision: read.body.revision });
    expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('P19.6-T4 AC-3 a KPM made before templates were named reads its company’s migration-made default; with any other default, none', async () => {
    await publish('training_taxonomy', renamedTraining());
    await (wired.kpms as unknown as mongoose.Model<never>).updateOne({ _id: FIXTURE_KPM } as never, { $set: { startedFrom: null } } as never).exec();
    const named = wired.namedTemplateRows as unknown as mongoose.Model<never>;
    await named.updateOne({ _id: templateId } as never, { $set: { origin: { kind: 'empty' } } } as never).exec();
    expect((await http().get(URL).expect(200)).body).toMatchObject({ template: null, differences: [] });
    await named.updateOne({ _id: templateId } as never, { $set: { origin: { kind: 'migration' } } } as never).exec();
    const read = (await http().get(URL).expect(200)).body;
    expect(read.template).toEqual({ id: templateId, name: expect.any(String) });
    expect(read.differences).toContainEqual({ level: 'skill', code: 'PROSPECTING', field: 'name', from: 'Pencarian prospek', to: 'Leads generation' });
  });

  it('P19.6-T4 AC-3 cross-tenant: one KPM’s sync reads and writes its own rows only; the other KPM keeps its names and its list', async () => {
    await publish('training_taxonomy', renamedTraining());
    const preview = (await http().get(URL).expect(200)).body;
    await http().post(URL).send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision }).expect(200);

    expect((await row('trainingSkills', OTHER_KPM, 'PROSPECTING'))!).toMatchObject({ label: 'Pencarian prospek', version: 1 });
    session.current = OTHER_OWNER;
    const theirs = (await http().get(URL).expect(200)).body;
    expect(theirs.differences).toContainEqual(
      { level: 'skill', code: 'PROSPECTING', field: 'name', from: 'Pencarian prospek', to: 'Leads generation' },
    );
    // A's revision is not B's: an apply pinned to A's preview is refused in B, and B is untouched.
    const res = await http().post(URL).send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision });
    expect(res.status).toBe(409);
    expect((await row('trainingSkills', OTHER_KPM, 'PROSPECTING'))!.label).toBe('Pencarian prospek');
    expect(await db().collection('auditLog').countDocuments({ action: 'training.template_synced', kpmId: OTHER_KPM })).toBe(0);
  });

  describe('P19.6-T4 AC-3 who may: the Owner and the Admins', () => {
    it.each([['the Owner', OWNER], ['an Admin', ADMIN]] as const)('P19.6-T4 AC-3 %s reads and applies', async (_who, ctx) => {
      await publish('training_taxonomy', renamedTraining());
      session.current = ctx;
      const preview = (await http().get(URL).expect(200)).body;
      const res = await http().post(URL).send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision });
      expect([res.status, res.body.outcome]).toEqual([200, 'published']);
    });

    it.each([['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT]] as const)('P19.6-T4 AC-3 %s is refused both, 403 PERM_DENIED', async (_who, ctx) => {
      await publish('training_taxonomy', renamedTraining());
      session.current = ctx;
      const read = await http().get(URL);
      const write = await http().post(URL).send({ templateVersions: { training_taxonomy: 2, capability_ladder: 2 }, expectedRevision: 'x' });
      expect([read.status, read.body.error?.code, write.status, write.body.error?.code]).toEqual([403, 'PERM_DENIED', 403, 'PERM_DENIED']);
      expect((await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'))!.label).toBe('Pencarian prospek');
    });

    it('P19.6-T4 AC-3 the Super Admin outside a session may not apply for a KPM, 403', async () => {
      session.current = SUPER_ADMIN;
      const write = await http().post(URL).send({ templateVersions: { training_taxonomy: 2, capability_ladder: 2 }, expectedRevision: 'x' });
      expect(write.status).toBe(403);
    });

    it('P19.6-T4 AC-3 a view-as session reads the list and is refused the apply, 403 IMPERSONATION_READ_ONLY, nothing written', async () => {
      await publish('training_taxonomy', renamedTraining());
      session.current = supporting(OWNER);
      const preview = (await http().get(URL).expect(200)).body;
      expect(preview.differences.length).toBeGreaterThan(0);
      const res = await http().post(URL).send({ templateVersions: preview.templateVersions, expectedRevision: preview.revision });
      expect([res.status, res.body.error?.code]).toEqual([403, 'IMPERSONATION_READ_ONLY']);
      expect((await row('trainingSkills', FIXTURE_KPM, 'PROSPECTING'))!.label).toBe('Pencarian prospek');
      expect(await db().collection('auditLog').countDocuments({ action: 'training.template_synced' })).toBe(0);
    });
  });
});
