import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { RequestContext } from '@/common/context/request-context';
import { ProductDraftController } from '@/modules/products/product-draft.controller';
import { ProductDraftService } from '@/modules/products/product-draft.service';
import {
  AAB, AB, ADMIN, AGENT, FIXTURE_KPM, OWNER, SUPER_ADMIN, productionPipe, session, StubAuth,
} from '../../../test/http-permissions';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { listenOnLoopback } from '../../../test/listen';
import { CompanyPublicationController } from './company-publication.controller';
import { CompanyPublicationService, behind, kpmView, type PublicationChange } from './company-publication.service';
import { KpmOfficeCounter } from './office-counter';

/** Far after the KPMs below were made, so a product first published "now" is not a KPM's by its age. */
const NOW = new Date('2027-06-01T03:00:00Z');
const MADE = new Date('2026-01-05T03:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const OTHER_COMPANY = '66f0000000000000000000c2';
const LIBRARY = '66f0000000000000000000c3';
const TANGERANG = '66f0000000000000000000a2';
const ALLIANZ_KPM = '66f0000000000000000000a3';

const inKpm = (kpmId: string) => RequestContext.superAdminInTenant('root', kpmId);

/**
 * ***Terbitkan ke KPM* and a product's draft over HTTP** (P19.23-T4 AC-3, AC-5; ADR-0278 §4–§7) — behind the real
 * `PermissionsGuard` and the production pipe. Prudential has two KPMs made from its template, BSD (the fixture KPM, which
 * changes its lead statuses itself) and Tangerang; Allianz has one, which nothing here may reach.
 */
describe('P19.23-T4 Terbitkan ke KPM and product drafts over HTTP', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let templateId: string;
  const http = () => request(app.getHttpServer());
  const base = `/admin/companies/${COMPANY}`;
  const leadStatuses = () => mongoose.model('LeadStatusModel');
  const productRows = () => mongoose.model('ProductModel');

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const drafts = new ProductDraftService(
      productRows() as never, wired.companies as never, wired.products, wired.audit, wired.clock,
    );
    const publication = new CompanyPublicationService(
      wired.templates as never, wired.companies as never, wired.kpms as never, wired.namedTemplates,
      wired.templateService, wired.templatePush, new KpmOfficeCounter(wired.kpms as never), drafts, wired.audit,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [CompanyPublicationController, ProductDraftController],
      providers: [
        { provide: CompanyPublicationService, useValue: publication },
        { provide: ProductDraftService, useValue: drafts },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    const { DomainExceptionFilter } = await import('@/common/errors/error.filter');
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
    await stopMongo();
  });

  /** One KPM of `companyId` made from `template`, its seed record kept, as `createKpm` leaves it. */
  async function kpmFrom(companyId: string, template: string, id: string, code: string, branchName: string) {
    const kpms = wired.kpms as unknown as mongoose.Model<never>;
    const startFrom = { kind: 'template' as const, templateId: template };
    const plan = await wired.provisioning.planFor(companyId, startFrom);
    await kpms.create({ _id: id, companyId, code, branchName, startedFrom: plan.startedFrom } as never);
    const done = await provisionFrom(wired, id, companyId, startFrom);
    await kpms.updateOne({ _id: id } as never, { $set: { seededFrom: done.seededFrom } } as never);
    await kpms.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { createdAt: MADE } });
  }

  beforeEach(async () => {
    await clearCollections();
    session.current = SUPER_ADMIN;
    const companies = wired.companies as unknown as mongoose.Model<never>;
    const prudential = await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    const allianz = await companies.create({ _id: OTHER_COMPANY, name: 'Allianz Life', slug: 'allianz' } as never);
    await companies.create({ _id: LIBRARY, name: 'Template', slug: 'template', kind: 'template' } as never);
    templateId = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, prudential as never))._id);
    const allianzTemplate = String((await wired.namedTemplates.createFirst(SUPER_ADMIN, allianz as never))._id);
    await kpmFrom(COMPANY, templateId, FIXTURE_KPM, '0417', 'BSD City Branch');
    await kpmFrom(COMPANY, templateId, TANGERANG, '0418', 'Tangerang Branch');
    await kpmFrom(OTHER_COMPANY, allianzTemplate, ALLIANZ_KPM, '0901', 'Allianz Jakarta');
  });

  /** The template's lead statuses with the first one renamed: a draft of *Lead statuses*. */
  async function leadDraft(label: string): Promise<string> {
    const read = await wired.templateService.read(COMPANY, 'lead_pipeline', templateId);
    const payload = structuredClone(read.payload) as { statuses: { code: string; label: string }[] };
    payload.statuses[0].label = label;
    await wired.templateService.saveDraft(SUPER_ADMIN, COMPANY, 'lead_pipeline', payload as never, templateId);
    return payload.statuses[0].code;
  }

  const labelIn = async (kpmId: string, code: string) =>
    ((await leadStatuses().findOne({ kpmId, code }).lean().exec()) as { label?: string } | null)?.label;

  const shelfOf = async (kpmId: string) => (await wired.kpmProducts.list(inKpm(kpmId))).map((p) => p.code);

  describe('as the Super Admin', () => {
    it('P19.23-T4 AC-5 lists nothing while every KPM holds the newest version and no draft waits', async () => {
      const { body } = await http().get(`${base}/publication`).expect(200);
      expect(body.changes).toEqual([]);
      expect(body.kpms.map((k: { name: string }) => k.name)).toEqual(['BSD City Branch', 'Tangerang Branch']);
      const summary = await http().get(`${base}/publication?summary=true`).expect(200);
      expect(summary.body).toEqual({ companyId: COMPANY, changes: 0, templateEmpty: false, kpms: 2 });
    });

    it('P19.23-T4 AC-5 lists a settings draft, and marks a KPM that changed the setting itself (akan tertimpa)', async () => {
      const code = await leadDraft('Prospek baru');
      await leadStatuses().updateOne({ kpmId: FIXTURE_KPM, code }, { $set: { label: 'Diubah BSD' } }).exec();

      const { body } = await http().get(`${base}/publication`).expect(200);
      expect(body.changes).toEqual([expect.objectContaining({
        id: 'setting:lead_statuses', type: 'setting', draft: true, reach: 'chosen', overwrites: true, changed: 1,
      })]);
      const bsd = body.kpms.find((k: { id: string }) => k.id === FIXTURE_KPM);
      const tangerang = body.kpms.find((k: { id: string }) => k.id === TANGERANG);
      expect(bsd.ownEdits).toEqual(['setting:lead_statuses']);
      expect(tangerang.ownEdits).toEqual([]);
    });

    it('P19.23-T4 AC-5 publishes a setting to the KPM chosen only — nothing automatic, the other KPM unchanged', async () => {
      const code = await leadDraft('Prospek baru');
      const before = await labelIn(FIXTURE_KPM, code);

      const { body } = await http().post(`${base}/publication`)
        .send({ changes: ['setting:lead_statuses'], kpmIds: [TANGERANG] }).expect(200);
      expect(body.results).toEqual([{ id: 'setting:lead_statuses', outcome: 'published' }]);
      expect(await labelIn(TANGERANG, code)).toBe('Prospek baru');
      expect(await labelIn(FIXTURE_KPM, code)).toBe(before);
      // Allianz's KPM was never one of Prudential's to reach.
      expect(await labelIn(ALLIANZ_KPM, code)).not.toBe('Prospek baru');

      // Published, but BSD still lacks the version: the change stays listed until it reaches it.
      const after = await http().get(`${base}/publication`).expect(200);
      expect(after.body.changes).toEqual([expect.objectContaining({ id: 'setting:lead_statuses', draft: false, missing: 1 })]);
      expect(after.body.kpms.find((k: { id: string }) => k.id === TANGERANG).upToDate).toEqual(['setting:lead_statuses']);
    });

    it('P19.23-T4 AC-5 refuses to overwrite a KPM’s own setting without the tick, and overwrites it with', async () => {
      const code = await leadDraft('Prospek baru');
      await leadStatuses().updateOne({ kpmId: FIXTURE_KPM, code }, { $set: { label: 'Diubah BSD' } }).exec();

      const refused = await http().post(`${base}/publication`)
        .send({ changes: ['setting:lead_statuses'], kpmIds: [FIXTURE_KPM, TANGERANG] }).expect(409);
      expect(refused.body.error).toMatchObject({ code: 'TEMPLATE_APPLY_UNCONFIRMED', details: { kpmIds: [FIXTURE_KPM] } });
      // Nothing written: the draft is still a draft, and neither KPM moved.
      expect(await labelIn(FIXTURE_KPM, code)).toBe('Diubah BSD');
      expect(await labelIn(TANGERANG, code)).not.toBe('Prospek baru');
      expect((await wired.templateService.read(COMPANY, 'lead_pipeline', templateId)).status).toBe('draft');

      await http().post(`${base}/publication`)
        .send({ changes: ['setting:lead_statuses'], kpmIds: [FIXTURE_KPM, TANGERANG], overwriteConfirmed: true })
        .expect(200);
      expect(await labelIn(FIXTURE_KPM, code)).toBe('Prospek baru');
      expect(await labelIn(TANGERANG, code)).toBe('Prospek baru');
    });

    it('P19.23-T4 AC-3 AC-5 a new product is in no KPM until published, then only adds to the KPMs chosen', async () => {
      const made = await http().post(`${base}/products/drafts`)
        .send({ code: 'PRUWELL_MEDICAL', name: 'PRUWell Medical', channel: 'conventional', category: 'health' })
        .expect(201);
      expect(await shelfOf(FIXTURE_KPM)).not.toContain('PRUWELL_MEDICAL');
      const listed = await http().get(`${base}/products/drafts`).expect(200);
      expect(listed.body).toEqual([expect.objectContaining({ code: 'PRUWELL_MEDICAL', state: 'unpublished', releasedTo: [] })]);

      // Edited while nobody has it: written straight to the product.
      await http().put(`${base}/products/${made.body.id}/draft`).send({ tagline: 'Rawat inap as-billed' }).expect(200);

      const read = await http().get(`${base}/publication`).expect(200);
      const change = read.body.changes.find((c: PublicationChange) => c.productId === made.body.id);
      expect(change).toMatchObject({ type: 'product_new', reach: 'chosen', overwrites: false, missing: 2 });

      await http().post(`${base}/publication`).send({ changes: [change.id], kpmIds: [FIXTURE_KPM] }).expect(200);
      expect(await shelfOf(FIXTURE_KPM)).toContain('PRUWELL_MEDICAL');
      expect(await shelfOf(TANGERANG)).not.toContain('PRUWELL_MEDICAL');
      expect(await shelfOf(ALLIANZ_KPM)).not.toContain('PRUWELL_MEDICAL');

      // Still a change, for the KPM that lacks it; BSD has it.
      const again = await http().get(`${base}/publication`).expect(200);
      expect(again.body.changes.find((c: PublicationChange) => c.id === change.id)).toMatchObject({ missing: 1 });
      expect(again.body.kpms.find((k: { id: string }) => k.id === FIXTURE_KPM).upToDate).toContain(change.id);
    });

    it('P19.23-T4 AC-3 a published product’s draft waits unread by any KPM, and reaches every KPM that has it', async () => {
      const made = await wired.products.create(SUPER_ADMIN, COMPANY, {
        code: 'PRUSEHAT', name: 'PRUSehat', channel: 'conventional', category: 'health',
      });
      await wired.products.create(SUPER_ADMIN, COMPANY, {
        code: 'PRUWELL_HEALTH', name: 'PRUWell Health', channel: 'conventional', category: 'health',
      });
      await http().put(`${base}/products/${made.id}/draft`)
        .send({ name: 'PRUSehat Plus', alsoFits: ['pruwell_health'] }).expect(200);
      const names = async (kpmId: string) => (await wired.kpmProducts.list(inKpm(kpmId)))
        .find((p) => p.code === 'PRUSEHAT')?.displayName.value;
      expect(await names(FIXTURE_KPM)).toBe('PRUSehat');

      const read = await http().get(`${base}/publication`).expect(200);
      const change = read.body.changes.find((c: PublicationChange) => c.productId === made.id);
      expect(change).toMatchObject({ type: 'product_change', reach: 'all', draft: true });

      // Reaching every KPM that has it by itself, it needs no KPM chosen.
      await http().post(`${base}/publication`).send({ changes: [change.id], kpmIds: [] }).expect(200);
      expect(await names(FIXTURE_KPM)).toBe('PRUSehat Plus');
      expect(await names(TANGERANG)).toBe('PRUSehat Plus');
      const row = await productRows().findById(made.id).lean().exec() as unknown as { draft: unknown; alsoFits: string[] };
      expect(row).toMatchObject({ draft: null, alsoFits: ['PRUWELL_HEALTH'] });
    });

    it('P19.23-T4 AC-3 discards a draft, and refuses an empty draft and a Juga sesuai naming a stranger', async () => {
      const made = await wired.products.create(SUPER_ADMIN, COMPANY, {
        code: 'PRUSEHAT', name: 'PRUSehat', channel: 'conventional', category: 'health',
      });
      await http().put(`${base}/products/${made.id}/draft`).send({}).expect(400);
      await http().put(`${base}/products/${made.id}/draft`).send({ alsoFits: ['PRUSEHAT'] }).expect(400);
      await http().put(`${base}/products/${made.id}/draft`).send({ alsoFits: ['NO_SUCH'] }).expect(400);
      await http().delete(`${base}/products/${made.id}/draft`).expect(400);
      await http().put(`${base}/products/${made.id}/draft`).send({ name: 'X' }).expect(200);
      const discarded = await http().delete(`${base}/products/${made.id}/draft`).expect(200);
      expect(discarded.body).toMatchObject({ state: 'published', draft: null });
    });
  });

  describe('validation and tenancy', () => {
    it('P19.23-T4 AC-5 refuses nothing chosen, a change that is not waiting, and a setting with no KPM', async () => {
      await leadDraft('Prospek baru');
      await http().post(`${base}/publication`).send({ changes: [], kpmIds: [TANGERANG] }).expect(400);
      await http().post(`${base}/publication`).send({ changes: ['setting:events'], kpmIds: [TANGERANG] }).expect(400);
      await http().post(`${base}/publication`).send({ changes: ['setting:lead_statuses'], kpmIds: [] }).expect(400);
      await http().post(`${base}/publication`).send({ changes: ['setting:lead_statuses'], kpmIds: ['nope'] }).expect(400);
    });

    it('P19.23-T4 AC-5 cross-tenant: another company’s KPM is 404, and nothing is written', async () => {
      const code = await leadDraft('Prospek baru');
      await http().post(`${base}/publication`)
        .send({ changes: ['setting:lead_statuses'], kpmIds: [TANGERANG, ALLIANZ_KPM] }).expect(404);
      expect(await labelIn(TANGERANG, code)).not.toBe('Prospek baru');
      expect(await labelIn(ALLIANZ_KPM, code)).not.toBe('Prospek baru');
      expect((await wired.templateService.read(COMPANY, 'lead_pipeline', templateId)).status).toBe('draft');
      // Another company's product is not this company's to draft.
      const allianz = await wired.products.create(SUPER_ADMIN, OTHER_COMPANY, {
        code: 'AZ_LIFE', name: 'Allianz Life', channel: 'conventional', category: 'life',
      });
      await http().put(`${base}/products/${allianz.id}/draft`).send({ name: 'X' }).expect(404);
    });

    it('P19.23-T4 AC-5 refuses the Default template, which has no KPM', async () => {
      await http().post(`/admin/companies/${LIBRARY}/publication`)
        .send({ changes: ['setting:lead_statuses'], kpmIds: [] }).expect(400);
      await http().get('/admin/companies/66f0000000000000000000ff/publication').expect(404);
    });
  });

  describe('permissions: the Super Admin alone', () => {
    it.each([
      ['an Owner', OWNER], ['an Admin', ADMIN], ['an AB', AB], ['an AAB', AAB], ['an Agent', AGENT],
    ])('P19.23-T4 AC-5 refuses %s every route', async (_who, who) => {
      session.current = who;
      await http().get(`${base}/publication`).expect(403);
      await http().post(`${base}/publication`).send({ changes: ['setting:lead_statuses'], kpmIds: [FIXTURE_KPM] }).expect(403);
      await http().get(`${base}/products/drafts`).expect(403);
      await http().post(`${base}/products/drafts`)
        .send({ code: 'X1', name: 'X', channel: 'conventional', category: 'health' }).expect(403);
      await http().put(`${base}/products/66f00000000000000000ab01/draft`).send({ name: 'X' }).expect(403);
      await http().delete(`${base}/products/66f00000000000000000ab01/draft`).expect(403);
    });
  });
});

/** The rules step 2 reads, by themselves (ADR-0278 §6). */
describe('P19.23-T4 AC-5 who is behind and who would be overwritten', () => {
  const kpm = (version: number | null) => ({
    id: 'k1', code: '0001', name: 'K1', createdAt: null,
    seededFrom: { lead_pipeline: { version, templateId: 't1' } },
  });
  const setting = (draft: boolean): PublicationChange => ({
    id: 'setting:lead_statuses', type: 'setting', setting: 'lead_statuses', kinds: ['lead_pipeline'], productId: null,
    productCode: null, productName: null, draft, reach: 'chosen', overwrites: true, added: 0, changed: 0, removed: 0, missing: 0,
  });
  const at = { templateId: 't1', versions: { lead_pipeline: 2 }, holders: new Map<string, Set<string>>() };

  it('P19.23-T4 AC-5 is behind on an older version, none, or another template’s, and not on the newest', () => {
    expect(behind(kpm(1), 'lead_pipeline', 2, 't1')).toBe(true);
    expect(behind(kpm(null), 'lead_pipeline', 2, 't1')).toBe(true);
    expect(behind(kpm(2), 'lead_pipeline', 2, 't1')).toBe(false);
    expect(behind(kpm(2), 'lead_pipeline', 2, 't2')).toBe(true);
    expect(behind(kpm(1), 'lead_pipeline', undefined, 't1')).toBe(false);
    expect(behind(kpm(1), 'campaign_kinds', 2, 't1')).toBe(false);
  });

  it('P19.23-T4 AC-5 marks a KPM’s own edits only where something would reach it', () => {
    // Current, no draft: nothing would reach it, so its own words are safe.
    expect(kpmView(kpm(2), [setting(false)], ['lead_pipeline'], at)).toMatchObject({ upToDate: ['setting:lead_statuses'], ownEdits: [] });
    // A draft will be published, and pushed to it: its words would go.
    expect(kpmView(kpm(2), [setting(true)], ['lead_pipeline'], at)).toMatchObject({ upToDate: [], ownEdits: ['setting:lead_statuses'] });
    // Behind and edited.
    expect(kpmView(kpm(1), [setting(false)], ['lead_pipeline'], at).ownEdits).toEqual(['setting:lead_statuses']);
    // Behind, unedited.
    expect(kpmView(kpm(1), [setting(false)], [], at)).toMatchObject({ upToDate: [], ownEdits: [] });
  });
});
