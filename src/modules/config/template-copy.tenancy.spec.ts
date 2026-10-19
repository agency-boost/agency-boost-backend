import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SEED_EVENT_TYPES } from '@/domain/constants';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { AssetRepository } from '@/modules/assets/asset.repository';
import { AssetService } from '@/modules/assets/asset.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom, provisionOffice } from '../../../test/config-module';
import { OFFICE_TEMPLATE_KINDS } from './template-defaults';

const NOW = new Date('2026-10-07T03:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const KPM = '66f0000000000000000000a1';
const OTHER_KPM = '66f0000000000000000000a2';
const NEW_KPM = '66f0000000000000000000a9';
const sa = RequestContext.platform('root');
const col = (name: string) => mongoose.connection.db!.collection(name);

const member = (kpmId: string, over: Record<string, unknown> = {}) => new RequestContext('u-owner', 'none', {
  membershipId: 'mem-owner', kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0, ...over,
} as never);
const OWNER = member(KPM);

type Payload = Record<string, unknown>;
type Module = { code: string; content?: { files: { storageKey: string }[]; links: { url: string }[] } };

/**
 * **Copies: of a template, of an office, from another company** (ADR-0115 §5, §6; P13.2-T7 AC-1 to AC-6).
 *
 * Through the real services over a real database, storage doubled at its port. Each copy is a copy and
 * never a link — an edit on either side after it reaches nothing on the other — and nothing is ever
 * half-made.
 */
describe('template copies (P13.2-T7)', () => {
  let wired: ReturnType<typeof configModule>;
  let prudentialDefault: string;
  let allianzDefault: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    wired.storage.resetCopies();
    const companies = wired.companies as unknown as mongoose.Model<never>;
    for (const [_id, name] of [[PRUDENTIAL, 'Prudential'], [ALLIANZ, 'Allianz Life']]) {
      const company = await companies.create({ _id, name, slug: name.toLowerCase().replace(/\s/g, '-') } as never);
      await wired.orgLevels.seedDefaultLadder(_id);
      await wired.namedTemplates.createFirst(sa, company as never);
    }
    prudentialDefault = String((await wired.namedTemplates.resolve(PRUDENTIAL))._id);
    allianzDefault = String((await wired.namedTemplates.resolve(ALLIANZ))._id);
  });

  const read = async (companyId: string, kind: (typeof OFFICE_TEMPLATE_KINDS)[number], templateId: string) =>
    (await wired.templateService.read(companyId, kind, templateId)).payload;
  const edit = async (
    companyId: string, kind: (typeof OFFICE_TEMPLATE_KINDS)[number], templateId: string, change: (p: Payload) => Payload,
  ) => {
    const current = await read(companyId, kind, templateId);
    await wired.templateService.saveDraft(sa, companyId, kind, change(structuredClone(current)), templateId);
    return wired.templateService.publish(sa, companyId, kind, templateId);
  };
  const templateCreated = (targetId: string) => col('auditLog').find({ action: 'template.created', targetId }).toArray();
  const liveTemplates = (companyId: string) => col('templates').countDocuments({ companyId, deletedAt: null });
  const liveRows = (companyId: string) => col('companyTemplates').countDocuments({ companyId, deletedAt: null });

  /** A company file, uploaded and confirmed, as the company's shared training material. */
  async function companyFile(companyId: string) {
    const signed = await wired.assets.requestCompanyUpload(companyId, {
      folder: 'training', filename: 'brochure.pdf', mimeType: 'application/pdf', bytes: 1024,
    });
    await wired.assets.confirmCompanyUpload(companyId, signed.storageKey);
    return signed.storageKey;
  }

  // ------------------------------------------------------------------------------------------- AC-1

  describe('AC-1: a copy within a company', () => {
    it('makes each kind’s newest published version the copy’s version 1 — drafts not copied, codes kept', async () => {
      // The source moves on: a second published taxonomy, and a draft of its event types nobody published.
      await edit(PRUDENTIAL, 'activity_taxonomy', prudentialDefault, (p) => {
        (p.types as Payload[])[0].label = 'Prospek dihubungi';
        return p;
      });
      await wired.templateService.saveDraft(sa, PRUDENTIAL, 'event_types', {
        types: [{ code: 'DRAFT_ONLY', label: 'Draft only' }],
      }, prudentialDefault);

      const copy = await wired.namedTemplates.create(sa, PRUDENTIAL, {
        name: 'Jakarta branches', from: { templateId: prudentialDefault },
      });

      expect(copy).toMatchObject({
        name: 'Jakarta branches', isDefault: false, status: 'active',
        origin: { kind: 'copy', templateId: prudentialDefault },
      });
      expect(copy.publishedVersions).toEqual(Object.fromEntries(OFFICE_TEMPLATE_KINDS.map((k) => [k, 1])));
      // The newest published taxonomy, with its codes.
      expect(await read(PRUDENTIAL, 'activity_taxonomy', copy.id))
        .toEqual(await read(PRUDENTIAL, 'activity_taxonomy', prudentialDefault));
      const sourceTypes = (await read(PRUDENTIAL, 'activity_taxonomy', prudentialDefault)).types as Payload[];
      expect(((await read(PRUDENTIAL, 'activity_taxonomy', copy.id)).types as Payload[])[0])
        .toMatchObject({ code: sourceTypes[0].code, label: 'Prospek dihubungi' });
      // Not the draft: the copy has the published event types, and no draft of its own.
      const events = await wired.templateService.read(PRUDENTIAL, 'event_types', copy.id);
      expect(events).toMatchObject({ status: 'published', version: 1 });
      expect((events.payload.types as Payload[]).map((t) => t.code)).not.toContain('DRAFT_ONLY');

      // One audit row, naming the source and the copy.
      const rows = await templateCreated(copy.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({
        companyId: PRUDENTIAL, name: 'Jakarta branches', from: 'copy',
        source: { companyId: PRUDENTIAL, templateId: prudentialDefault, name: 'Prudential template', versions: { activity_taxonomy: 2 } },
      });
    });

    it('stays its own: a later edit and publish on either side never reaches the other — both ways', async () => {
      const copy = await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Copy', from: { templateId: prudentialDefault } });
      const sourceRatios = await read(PRUDENTIAL, 'ratio_set', prudentialDefault);
      const copyPipelines = await read(PRUDENTIAL, 'lead_pipeline', copy.id);

      // The source edits and publishes its ratios: the copy's stay as they were.
      await edit(PRUDENTIAL, 'ratio_set', prudentialDefault, (p) => {
        (p.ratios as Payload[])[0].benchmark = 0.5;
        return p;
      });
      expect(await read(PRUDENTIAL, 'ratio_set', copy.id)).toEqual(sourceRatios);

      // The copy edits and publishes its pipelines: the source's stay as they were.
      const sourcePipelines = await read(PRUDENTIAL, 'lead_pipeline', prudentialDefault);
      await edit(PRUDENTIAL, 'lead_pipeline', copy.id, (p) => {
        (p.statuses as Payload[])[0].label = 'Kontak pertama';
        return p;
      });
      expect(await read(PRUDENTIAL, 'lead_pipeline', prudentialDefault)).toEqual(sourcePipelines);
      expect(await read(PRUDENTIAL, 'lead_pipeline', copy.id)).not.toEqual(copyPipelines);
      expect((await wired.namedTemplates.list(PRUDENTIAL)).find((t) => t.id === copy.id)!.publishedVersions)
        .toMatchObject({ lead_pipeline: 2, ratio_set: 1 });
    });

    it('references the company’s training files rather than duplicating them', async () => {
      const key = await companyFile(PRUDENTIAL);
      await edit(PRUDENTIAL, 'training_taxonomy', prudentialDefault, (p) => {
        (p.modules as Payload[])[0].content = {
          files: [{ id: 'f1', label: 'Brochure', storageKey: key, mimeType: 'application/pdf', bytes: 1024 }],
          videos: [], links: [{ id: 'l1', label: 'Portal', url: 'https://portal.test' }],
        };
        return p;
      });
      const copy = await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Copy', from: { templateId: prudentialDefault } });

      const module = ((await read(PRUDENTIAL, 'training_taxonomy', copy.id)).modules as Module[])[0];
      expect(module.content!.files.map((f) => f.storageKey)).toEqual([key]);
      expect(module.content!.links.map((l) => l.url)).toEqual(['https://portal.test']);
      expect(wired.storage.copies).toEqual([]);
    });

    it('copies an empty template as empty, and an archived one too', async () => {
      const empty = await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Empty', from: 'empty' });
      await wired.namedTemplates.archive(sa, PRUDENTIAL, empty.id);
      const copy = await wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Revived', from: { templateId: empty.id } });
      expect(Object.values(copy.publishedVersions)).toEqual(Array(7).fill(null));
      expect(copy.status).toBe('active');
    });

    it('refuses another company’s template as 404, and a taken name 409 — writing nothing', async () => {
      const before = await liveRows(PRUDENTIAL);
      await expect(wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'Theirs', from: { templateId: allianzDefault } }))
        .rejects.toMatchObject({ status: 404 });
      await expect(wired.namedTemplates.create(sa, PRUDENTIAL, { name: 'prudential TEMPLATE', from: { templateId: prudentialDefault } }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', status: 409 });
      expect(await liveTemplates(PRUDENTIAL)).toBe(1);
      expect(await liveRows(PRUDENTIAL)).toBe(before);
    });
  });

  // ------------------------------------------------------------------------------------------- AC-2

  describe('AC-2: from an office', () => {
    beforeEach(async () => {
      const kpms = wired.kpms as unknown as mongoose.Model<never>;
      for (const [_id, code] of [[KPM, '0417'], [OTHER_KPM, '0555']]) {
        await kpms.create({
          _id, companyId: PRUDENTIAL, code, branchName: `${code} Branch`, timezone: 'Asia/Jakarta', status: 'active',
        } as never);
        await provisionOffice(wired, _id);
        await wired.config.publish(member(_id));
      }
    });

    it('takes what its agents read, never the Owner’s draft or anything archived', async () => {
      // Archived rows, published: agents no longer see them.
      await col('eventTypes').updateOne({ kpmId: KPM, code: 'RECOGNITION' }, { $set: { status: 'archived' } });
      await col('trainingModules').updateOne({ kpmId: KPM, code: 'CLIENT_RETENTION' }, { $set: { status: 'archived' } });
      await col('trainingModules').updateOne({ kpmId: KPM, code: 'CROSS_SELL_OPPORTUNITIES' }, { $set: { publishState: 'draft' } });
      await col('capabilityCatalogs').updateOne({ kpmId: KPM }, { $set: { 'grids.0.items.0.status': 'archived' } });
      await wired.config.publish(OWNER);
      // After the publish: a live rename nobody published, and a draft checklist.
      await col('activityTypes').updateOne({ kpmId: KPM, code: 'LEADS_CONTACTED' }, { $set: { label: 'Unpublished rename' } });
      const published = await col('activationTemplates').findOne({ kpmId: KPM, status: 'published' });
      await col('activationTemplates').insertOne({
        kpmId: KPM, version: 2, status: 'draft', publishedAt: null, deletedAt: null,
        aspects: [{ code: 'DRAFT_ASPECT', label: 'Draft', displayOrder: 1, items: [] }],
      });
      // Business data the copy must never read.
      await col('leads').insertOne({ kpmId: KPM, name: 'Ibu Sari', deletedAt: null });
      await col('memberships').insertOne({ kpmId: KPM, userId: 'u1', status: 'active', deletedAt: null });

      const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'BSD City settings', companyId: PRUDENTIAL });

      expect(saved).toMatchObject({
        name: 'BSD City settings', isDefault: false, companyId: PRUDENTIAL,
        origin: { kind: 'office', kpmId: KPM, companyId: PRUDENTIAL },
      });
      expect(Object.values(saved.publishedVersions)).toEqual(Array(7).fill(1));

      const taxonomy = await read(PRUDENTIAL, 'activity_taxonomy', saved.id);
      expect((taxonomy.types as Payload[]).find((t) => t.code === 'LEADS_CONTACTED')!.label).not.toBe('Unpublished rename');
      const events = await read(PRUDENTIAL, 'event_types', saved.id);
      expect((events.types as Payload[]).map((t) => t.code))
        .toEqual(SEED_EVENT_TYPES.map((t) => t.code).filter((code) => code !== 'RECOGNITION'));
      const training = await read(PRUDENTIAL, 'training_taxonomy', saved.id);
      const modules = (training.modules as Module[]).map((m) => m.code);
      expect(modules).not.toContain('CLIENT_RETENTION');
      expect(modules).not.toContain('CROSS_SELL_OPPORTUNITIES');
      expect(modules).toContain('PROSPECT_LIST');
      const ladder = await read(PRUDENTIAL, 'capability_ladder', saved.id);
      const archivedItem = (await col('capabilityCatalogs').findOne({ kpmId: KPM }))!.grids[0].items[0].code;
      expect(JSON.stringify(ladder)).not.toContain(`"${archivedItem}"`);
      const checklist = await read(PRUDENTIAL, 'activation_checklist', saved.id);
      expect((checklist.aspects as Payload[]).map((a) => a.code))
        .toEqual((published!.aspects as Payload[]).map((a) => a.code));

      // One audit row, naming the office and the destination.
      const rows = await templateCreated(saved.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({
        companyId: PRUDENTIAL, from: 'office', source: { kpmId: KPM, kpmCode: '0417', companyId: PRUDENTIAL }, filesDuplicated: 0,
        dropped: [],
      });
      expect(saved.dropped).toEqual([]);
    });

    /*
     * **Exit review of P13.2, finding 1.** The Owner's staged batch writes the live training, event-type and
     * capability rows before Publish; the template read them, while the office's agents read the snapshot.
     * Each is staged here through the service an Owner's screen calls, and none reaches the template until
     * the office publishes it.
     */
    it('exit review, finding 1: an unpublished module, event type or capability item never reaches the template', async () => {
      const skillCode = (await col('trainingModules').findOne({ kpmId: KPM, code: 'PROSPECT_LIST' }))!.skillCode as string;
      const gridCode = (await col('capabilityCatalogs').findOne({ kpmId: KPM }))!.grids[0].code as string;
      await wired.training.createModule(OWNER, { code: 'NOT_YET_PUBLISHED', skillCode, title: 'Not yet', publishState: 'published' });
      await wired.events.createType(OWNER, { code: 'TOWN_HALL', label: 'Town hall', emoji: '📣', color: '#2D9CDB' });
      const recognition = (await col('eventTypes').findOne({ kpmId: KPM, code: 'RECOGNITION' }))!;
      await wired.events.archiveType(OWNER, String(recognition._id));
      await wired.capability.add(OWNER, 'item', 'NEW_ITEM', 'Not yet assessed', gridCode);

      const before = await wired.templateCopies.saveOffice(sa, KPM, { name: 'Before publish', companyId: PRUDENTIAL });
      const kinds = async (id: string) => JSON.stringify(await Promise.all(
        (['training_taxonomy', 'event_types', 'capability_ladder'] as const).map((kind) => read(PRUDENTIAL, kind, id)),
      ));
      const unpublished = await kinds(before.id);
      for (const code of ['NOT_YET_PUBLISHED', 'TOWN_HALL', 'NEW_ITEM']) expect(unpublished).not.toContain(`"${code}"`);
      // The archive is unpublished too: agents still see RECOGNITION, so the template has it.
      expect(unpublished).toContain('"RECOGNITION"');

      // Published, each is what agents read — and what the next template holds.
      await wired.config.publish(OWNER);
      const after = await kinds((await wired.templateCopies.saveOffice(sa, KPM, { name: 'After publish', companyId: PRUDENTIAL })).id);
      for (const code of ['NOT_YET_PUBLISHED', 'TOWN_HALL', 'NEW_ITEM']) expect(after).toContain(`"${code}"`);
      expect(after).not.toContain('"RECOGNITION"');
    });

    it('reads no collection outside configuration', async () => {
      // Compiling the services' models builds their indexes in the background (`autoIndex`): settle that first,
      // so an index build on a collection the copy never reads is not counted as a read of it (2026-10-09, when
      // the wiring gained the reporting module's models and the build moved into this window).
      await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
      const touched = new Set<string>();
      mongoose.set('debug', (collection: string) => { touched.add(collection); });
      try {
        await wired.templateCopies.saveOffice(sa, KPM, { name: 'Read check', companyId: PRUDENTIAL });
      } finally {
        mongoose.set('debug', false);
      }
      const configuration = new Set([
        'kpms', 'companies', 'companyOrgLevels', 'templates', 'companyTemplates', 'auditLog', 'assets',
        'configSnapshots', 'activationTemplates', 'trainingCategories', 'trainingSkills', 'trainingModules',
        'eventTypes', 'capabilityCatalogs',
      ]);
      expect(touched.has('configSnapshots')).toBe(true);
      expect([...touched].filter((name) => !configuration.has(name))).toEqual([]);
    });

    it('is a template an office can be made from, and starts that office as the source’s agents read it', async () => {
      const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'BSD', companyId: PRUDENTIAL });
      await provisionFrom(wired, NEW_KPM, PRUDENTIAL, { kind: 'template', templateId: saved.id });
      const codes = async (kpmId: string) => (await col('activityTypes').find({ kpmId }).toArray()).map((t) => t.code).sort();
      expect(await codes(NEW_KPM)).toEqual(await codes(KPM));
      expect(await col('ratioDefinitions').countDocuments({ kpmId: NEW_KPM }))
        .toBe(await col('ratioDefinitions').countDocuments({ kpmId: KPM }));
    });

    it('carries a section’s rungs and description into the template, and into an office made from it', async () => {
      await col('configSnapshots').updateOne({ kpmId: KPM }, {
        $set: { 'payload.activity.0.appliesToOrgLevelCodes': ['AB'], 'payload.activity.0.description': 'Untuk AB' },
      });
      const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'With rungs', companyId: PRUDENTIAL });
      await provisionFrom(wired, NEW_KPM, PRUDENTIAL, { kind: 'template', templateId: saved.id });
      const section = await col('activityCategories').findOne({ kpmId: NEW_KPM, code: 'LEADS_GENERATION' });
      expect(section).toMatchObject({ appliesToOrgLevelCodes: ['AB'], description: 'Untuk AB' });
    });

    /*
     * **Exit review of P13.2, finding 2.** States an office may legally be in, which the whole-source check
     * refused: what archiving leaves behind is dropped, and listed in the answer and the audit row.
     */
    describe('exit review, finding 2: what archiving left behind is dropped and listed, never refused', () => {
      const typeId = async (code: string) => String((await col('activityTypes').findOne({ kpmId: KPM, code }))!._id);

      it('a ratio naming an archived activity type: the type out of it, a ratio left counting nothing out', async () => {
        // `ActivityConfigService.archiveType` allows archiving a type a ratio names; the office publishes.
        await wired.activity.archiveType(OWNER, await typeId('SELL_FOLLOWUP'));
        await wired.activity.archiveType(OWNER, await typeId('LEADS_NEW_PROSPECT'));
        await wired.config.publish(OWNER);

        const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'After archiving', companyId: PRUDENTIAL });

        expect(saved.dropped).toHaveLength(3);
        expect(saved.dropped).toEqual(expect.arrayContaining([
          { kind: 'ratio_set', code: 'SELLING_VS_RECRUITMENT', reason: expect.stringContaining('no longer counts SELL_FOLLOWUP') },
          { kind: 'ratio_set', code: 'SELLING_SUCCESS_RATE', reason: expect.stringContaining('no longer counts SELL_FOLLOWUP') },
          { kind: 'ratio_set', code: 'LEADS_PER_ACTIVITY', reason: expect.stringContaining('Ratio LEADS_PER_ACTIVITY was left out') },
        ]));
        const ratios = (await read(PRUDENTIAL, 'ratio_set', saved.id)).ratios as Payload[];
        expect(ratios.map((r) => r.code)).not.toContain('LEADS_PER_ACTIVITY');
        expect(JSON.stringify(ratios)).not.toContain('SELL_FOLLOWUP');
        // Recorded where the audit log can answer for it.
        expect((await templateCreated(saved.id))[0].after.dropped).toEqual(saved.dropped);
        // And an office can be made from it.
        await expect(provisionFrom(wired, NEW_KPM, PRUDENTIAL, { kind: 'template', templateId: saved.id })).resolves.toBeDefined();
      });

      it('a capability stage whose every required milestone is archived: left out, the others keep their rest', async () => {
        await col('configSnapshots').updateMany(
          { kpmId: KPM },
          { $set: { 'payload.capability.milestones.$[m].status': 'archived' } },
          { arrayFilters: [{ 'm.code': 'SELLS_INDEPENDENTLY' }] },
        );

        const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'Ladder', companyId: PRUDENTIAL });

        expect(saved.dropped).toEqual(expect.arrayContaining([
          { kind: 'capability_ladder', code: 'COMPETENT_PRODUCER', reason: expect.stringContaining('was left out') },
          { kind: 'capability_ladder', code: 'INDEPENDENT_PRODUCER', reason: expect.stringContaining('no longer requires SELLS_INDEPENDENTLY') },
        ]));
        const ladder = await read(PRUDENTIAL, 'capability_ladder', saved.id) as { stages: { code: string; requiredMilestoneCodes: string[] }[] };
        expect(ladder.stages.map((st) => st.code)).not.toContain('COMPETENT_PRODUCER');
        expect(ladder.stages.find((st) => st.code === 'INDEPENDENT_PRODUCER')!.requiredMilestoneCodes).toEqual(['SELLS_OUTSIDE_NETWORK']);
        await expect(provisionFrom(wired, NEW_KPM, PRUDENTIAL, { kind: 'template', templateId: saved.id })).resolves.toBeDefined();
      });

      it('ADR-0116: every stage archived — the whole ladder left out, and an office made from it given the platform’s', async () => {
        await col('configSnapshots').updateMany(
          { kpmId: KPM }, { $set: { 'payload.capability.stages.$[].status': 'archived' } },
        );

        const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'No stages', companyId: PRUDENTIAL });

        expect(saved.dropped).toEqual(expect.arrayContaining([{
          kind: 'capability_ladder', code: null,
          reason: expect.stringContaining('An office made from the template starts with AgencyBoost’s standard capability ladder instead.'),
        }]));
        // The template leaves the kind unpublished, which is how a template says it holds none.
        expect(await col('companyTemplates').countDocuments({ templateId: saved.id, kind: 'capability_ladder' })).toBe(0);

        const done = await provisionFrom(wired, NEW_KPM, PRUDENTIAL, { kind: 'template', templateId: saved.id });

        const catalog = (await col('capabilityCatalogs').findOne({ kpmId: NEW_KPM }))!;
        expect(catalog.stages.map((st: { code: string; status: string }) => [st.code, st.status])).toEqual([
          ['COMPETENT_PRODUCER', 'active'], ['INDEPENDENT_PRODUCER', 'active'],
          ['PRODUCTIVE_TEAM_BUILDER', 'active'], ['TRANSFORMATIVE_TEAM_BUILDER', 'active'],
        ]);
        expect(done.seededFrom.capability_ladder).toEqual({ templateId: saved.id, version: null, platformSupplied: true });
        expect(done.capabilityLadderSupplied).toBe(true);
      });

      it('a published checklist item linking to a module archived since: kept, as a manual item', async () => {
        const module = (await col('trainingModules').findOne({ kpmId: KPM, code: 'PROSPECT_LIST' }))!;
        const published = (await col('activationTemplates').findOne({ kpmId: KPM, status: 'published' }))!;
        const item = (published.aspects as { items: { code: string }[] }[])[0].items[0].code;
        await col('activationTemplates').updateOne(
          { _id: published._id }, { $set: { 'aspects.0.items.0.autoLink': 'training:PROSPECT_LIST' } },
        );
        await wired.training.archiveModule(OWNER, String(module._id));
        await wired.config.publish(OWNER);

        const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'Checklist', companyId: PRUDENTIAL });

        expect(saved.dropped).toEqual([{
          kind: 'activation_checklist', code: item,
          reason: `Checklist item ${item} is kept as a manual item: the training module PROSPECT_LIST it linked to is not offered in this office.`,
        }]);
        const checklist = await read(PRUDENTIAL, 'activation_checklist', saved.id) as { aspects: { items: Payload[] }[] };
        expect(checklist.aspects[0].items[0]).toMatchObject({ code: item, autoLink: null });
        await expect(provisionFrom(wired, NEW_KPM, PRUDENTIAL, { kind: 'template', templateId: saved.id })).resolves.toBeDefined();
      });
    });

    it('refuses settings that would make a broken office (400) — before any write', async () => {
      // Not what archiving leaves behind (that is dropped, above): a pipeline no office may hold — two
      // stages that each close it, which nothing an Owner can do produces, only a damaged snapshot.
      await col('configSnapshots').updateMany({ kpmId: KPM }, { $set: { 'payload.leadPipelines.0.statuses.0.isTerminal': true } });
      const rows = await liveRows(PRUDENTIAL);
      await expect(wired.templateCopies.saveOffice(sa, KPM, { name: 'Broken', companyId: PRUDENTIAL }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('KPM 0417’s published settings would produce a broken office') });
      expect(await liveTemplates(PRUDENTIAL)).toBe(1);
      expect(await liveRows(PRUDENTIAL)).toBe(rows);
    });

    it('answers 404 for an office or a company that does not exist, and 409 for a taken name', async () => {
      await expect(wired.templateCopies.saveOffice(sa, '66f00000000000000000ffff', { name: 'x', companyId: PRUDENTIAL }))
        .rejects.toMatchObject({ status: 404 });
      await expect(wired.templateCopies.saveOffice(sa, 'not-an-id', { name: 'x', companyId: PRUDENTIAL }))
        .rejects.toMatchObject({ status: 404 });
      await expect(wired.templateCopies.saveOffice(sa, KPM, { name: 'x', companyId: '66f00000000000000000eeee' }))
        .rejects.toMatchObject({ status: 404 });
      await expect(wired.templateCopies.saveOffice(sa, KPM, { name: 'Prudential Template', companyId: PRUDENTIAL }))
        .rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', status: 409 });
    });

    // ----------------------------------------------------------------------------------------- AC-3

    describe('AC-3: files across an owner boundary are duplicated; within a company, referenced', () => {
      let companyKey: string;
      let officeKey: string;

      beforeEach(async () => {
        companyKey = await companyFile(PRUDENTIAL);
        const signed = await wired.assets.requestUpload(OWNER, {
          folder: 'training', filename: 'ours.pdf', mimeType: 'application/pdf', bytes: 1024,
        });
        await wired.assets.confirmUpload(OWNER, signed.storageKey);
        officeKey = signed.storageKey;
        const file = (storageKey: string, label: string) => ({ id: label, label, storageKey, mimeType: 'application/pdf', bytes: 1024 });
        await col('trainingModules').updateOne({ kpmId: KPM, code: 'PROSPECT_LIST' }, {
          $set: { companyContent: { files: [file(companyKey, 'Company brochure')], videos: [], links: [] }, officeContent: null },
        });
        await col('trainingModules').updateOne({ kpmId: KPM, code: 'REFERRAL_GENERATION' }, {
          $set: {
            companyContent: { files: [file(companyKey, 'Replaced')], videos: [], links: [] },
            officeContent: { files: [file(officeKey, 'Our own')], videos: [], links: [{ id: 'l', label: 'Portal', url: 'https://portal.test' }] },
          },
        });
      });

      const contentOf = async (companyId: string, templateId: string, code: string) =>
        ((await read(companyId, 'training_taxonomy', templateId)).modules as Module[]).find((m) => m.code === code)!.content!;

      it('within its own company: the company’s file referenced, the office’s own duplicated', async () => {
        const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'Own company', companyId: PRUDENTIAL });

        expect((await contentOf(PRUDENTIAL, saved.id, 'PROSPECT_LIST')).files[0].storageKey).toBe(companyKey);
        const own = await contentOf(PRUDENTIAL, saved.id, 'REFERRAL_GENERATION');
        const copied = own.files[0].storageKey;
        expect(copied).toMatch(new RegExp(`^dev/company/${PRUDENTIAL}/training/`));
        expect(own.links.map((l) => l.url)).toEqual(['https://portal.test']);
        expect(wired.storage.copies).toEqual([{ from: officeKey, to: copied }]);
        // The copy is the company's, and the template names it.
        expect(await wired.assets.companyAsset(PRUDENTIAL, copied)).toMatchObject({
          companyId: PRUDENTIAL, kpmId: null, refCount: 1, uploadState: 'confirmed', originalFilename: 'ours.pdf',
        });
        expect((await templateCreated(saved.id))[0].after).toMatchObject({ filesDuplicated: 1 });
      });

      it('into another company: every file duplicated into that company’s assets', async () => {
        const saved = await wired.templateCopies.saveOffice(sa, KPM, { name: 'For Allianz', companyId: ALLIANZ });

        expect(saved).toMatchObject({ companyId: ALLIANZ, origin: { kind: 'office', kpmId: KPM, companyId: PRUDENTIAL } });
        const theirs = (await contentOf(ALLIANZ, saved.id, 'PROSPECT_LIST')).files[0].storageKey;
        const own = (await contentOf(ALLIANZ, saved.id, 'REFERRAL_GENERATION')).files[0].storageKey;
        for (const key of [theirs, own]) {
          expect(key).toMatch(new RegExp(`^dev/company/${ALLIANZ}/training/`));
          expect(await wired.assets.companyAsset(ALLIANZ, key)).toMatchObject({ refCount: 1 });
        }
        expect(wired.storage.copies.map((c) => c.from).sort()).toEqual([companyKey, officeKey].sort());
        // Nothing of Prudential's is referenced from Allianz's template.
        expect(JSON.stringify(await read(ALLIANZ, 'training_taxonomy', saved.id))).not.toContain(PRUDENTIAL);
      });

      it('AC-5: a failed copy leaves no template, and the file copied before it is an orphan the sweep finds', async () => {
        wired.storage.failCopyOf(officeKey);
        const rows = await liveRows(ALLIANZ);

        await expect(wired.templateCopies.saveOffice(sa, KPM, { name: 'Half', companyId: ALLIANZ })).rejects.toThrow();

        expect(await liveTemplates(ALLIANZ)).toBe(1);
        expect(await liveRows(ALLIANZ)).toBe(rows);
        expect(await col('auditLog').countDocuments({ action: 'template.created', 'after.name': 'Half' })).toBe(0);
        // The company file was copied first, and nothing names it.
        expect(wired.storage.copies).toHaveLength(1);
        const orphan = wired.storage.copies[0].to;
        expect(await wired.assets.companyAsset(ALLIANZ, orphan)).toMatchObject({ refCount: 0 });
        const later = new AssetService(
          new AssetRepository(wired.assetRows as never), wired.storage, new FixedClock(new Date('2099-01-01T00:00:00Z')),
        );
        expect((await later.findOrphans(sa)).map((o) => o.storageKey)).toContain(orphan);
      });

      it('AC-5: a file that never finished uploading refuses the copy before a byte is copied', async () => {
        await col('assets').updateOne({ storageKey: officeKey }, { $set: { uploadState: 'pending' } });
        await expect(wired.templateCopies.saveOffice(sa, KPM, { name: 'Pending', companyId: PRUDENTIAL }))
          .rejects.toMatchObject({ code: 'ASSET_NOT_CONFIRMED', status: 409, details: { moduleCode: 'REFERRAL_GENERATION' } });
        expect(wired.storage.copies).toEqual([]);
        expect(await liveTemplates(PRUDENTIAL)).toBe(1);
      });

      it('AC-6: reads only the named office’s files — another office’s key is not the office’s', async () => {
        // 0555's upload, planted in 0417's module: 0417's settings cannot reach a file it does not own.
        const signed = await wired.assets.requestUpload(member(OTHER_KPM), {
          folder: 'training', filename: 'theirs.pdf', mimeType: 'application/pdf', bytes: 1024,
        });
        await wired.assets.confirmUpload(member(OTHER_KPM), signed.storageKey);
        await col('trainingModules').updateOne({ kpmId: KPM, code: 'REFERRAL_GENERATION' }, {
          $set: { 'officeContent.files.0.storageKey': signed.storageKey },
        });
        await expect(wired.templateCopies.saveOffice(sa, KPM, { name: 'Leak', companyId: PRUDENTIAL }))
          .rejects.toMatchObject({ code: 'ASSET_NOT_CONFIRMED' });
        expect(wired.storage.copies).toEqual([]);
      });
    });

    // ----------------------------------------------------------------------------------------- AC-4

    it('AC-4: into another company, a rung its ladder lacks refuses the copy, naming it — before any write', async () => {
      await (mongoose.connection.db!.collection('companyOrgLevels')).insertOne({
        companyId: PRUDENTIAL, code: 'SM', label: 'Sales Manager', displayOrder: 4, status: 'active',
        archivedAt: null, deletedAt: null,
      });
      await col('configSnapshots').updateOne({ kpmId: KPM }, { $set: { 'payload.ratios.0.appliesToOrgLevelCodes': ['SM', 'AB'] } });
      const rows = await liveRows(ALLIANZ);

      const refused = wired.templateCopies.saveOffice(sa, KPM, { name: 'For Allianz', companyId: ALLIANZ });
      await expect(refused).rejects.toMatchObject({
        code: 'TEMPLATE_RUNG_UNKNOWN', status: 409, details: { codes: ['SM'] },
      });
      expect(await liveTemplates(ALLIANZ)).toBe(1);
      expect(await liveRows(ALLIANZ)).toBe(rows);
      expect(wired.storage.copies).toEqual([]);

      // Within its own company the ladder is shared, and it is never raised.
      await expect(wired.templateCopies.saveOffice(sa, KPM, { name: 'Own', companyId: PRUDENTIAL })).resolves.toBeDefined();
    });

    it('AC-6: only a Super Admin reads an office’s settings — a tenant context is refused at the repository', async () => {
      await expect(wired.officeSettings.publishedSettingsOf(member(OTHER_KPM), KPM)).rejects.toThrow(MissingTenantContextError);
      await expect(wired.officeSettings.publishedSettingsOf(OWNER, KPM)).rejects.toThrow(MissingTenantContextError);
      expect(await liveTemplates(PRUDENTIAL)).toBe(1);
    });

    it('exit review, N3: the service refuses anybody without company_template:write, before it reads anything', async () => {
      const touched = new Set<string>();
      mongoose.set('debug', (collection: string) => { touched.add(collection); });
      try {
        await expect(wired.templateCopies.saveOffice(OWNER, KPM, { name: 'Mine', companyId: PRUDENTIAL }))
          .rejects.toMatchObject({ code: 'PERM_DENIED', status: 403 });
        await expect(wired.templateCopies.importFrom(member(OTHER_KPM), PRUDENTIAL, {
          fromCompanyId: ALLIANZ, templateId: allianzDefault, name: 'Theirs',
        })).rejects.toMatchObject({ code: 'PERM_DENIED', status: 403 });
      } finally {
        mongoose.set('debug', false);
      }
      expect([...touched]).toEqual([]);
      expect(await liveTemplates(PRUDENTIAL)).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------- import

  describe('AC-4, AC-3: import from another company', () => {
    it('makes one of their templates a new one of ours — its files duplicated, nothing linked back', async () => {
      const key = await companyFile(ALLIANZ);
      await edit(ALLIANZ, 'training_taxonomy', allianzDefault, (p) => {
        (p.modules as Payload[])[0].content = {
          files: [{ id: 'f1', label: 'Brochure', storageKey: key, mimeType: 'application/pdf', bytes: 1024 }],
          videos: [], links: [{ id: 'l1', label: 'Portal', url: 'https://portal.test' }],
        };
        return p;
      });

      const imported = await wired.templateCopies.importFrom(sa, PRUDENTIAL, {
        fromCompanyId: ALLIANZ, templateId: allianzDefault, name: 'From Allianz',
      });

      expect(imported).toMatchObject({
        companyId: PRUDENTIAL, name: 'From Allianz', isDefault: false,
        origin: { kind: 'import', templateId: allianzDefault, companyId: ALLIANZ },
      });
      expect(Object.values(imported.publishedVersions)).toEqual(Array(7).fill(1));
      const content = ((await read(PRUDENTIAL, 'training_taxonomy', imported.id)).modules as Module[])[0].content!;
      expect(content.files[0].storageKey).toMatch(new RegExp(`^dev/company/${PRUDENTIAL}/training/`));
      expect(content.links.map((l) => l.url)).toEqual(['https://portal.test']);
      expect(await wired.assets.companyAsset(PRUDENTIAL, content.files[0].storageKey)).toMatchObject({ refCount: 1 });

      // Their later publish never reaches ours.
      const ours = await read(PRUDENTIAL, 'event_types', imported.id);
      await edit(ALLIANZ, 'event_types', allianzDefault, (p) => {
        (p.types as Payload[])[0].label = 'Changed at Allianz';
        return p;
      });
      expect(await read(PRUDENTIAL, 'event_types', imported.id)).toEqual(ours);

      const rows = await templateCreated(imported.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({
        companyId: PRUDENTIAL, from: 'import', filesDuplicated: 1,
        source: { companyId: ALLIANZ, templateId: allianzDefault, name: 'Allianz Life template' },
      });
    });

    it('refuses a rung our ladder lacks or has archived, naming every one, before any file is copied', async () => {
      const key = await companyFile(ALLIANZ);
      await edit(ALLIANZ, 'training_taxonomy', allianzDefault, (p) => {
        (p.modules as Payload[])[0].content = {
          files: [{ id: 'f1', label: 'Brochure', storageKey: key, mimeType: 'application/pdf', bytes: 1024 }],
          videos: [], links: [],
        };
        return p;
      });
      await edit(ALLIANZ, 'ratio_set', allianzDefault, (p) => {
        (p.ratios as Payload[])[0].appliesToOrgLevelCodes = ['SM', 'AAB'];
        return p;
      });
      await col('companyOrgLevels').updateOne({ companyId: PRUDENTIAL, code: 'AAB' }, { $set: { status: 'archived' } });

      await expect(wired.templateCopies.importFrom(sa, PRUDENTIAL, {
        fromCompanyId: ALLIANZ, templateId: allianzDefault, name: 'From Allianz',
      })).rejects.toMatchObject({ code: 'TEMPLATE_RUNG_UNKNOWN', status: 409, details: { codes: ['AAB', 'SM'] } });
      expect(wired.storage.copies).toEqual([]);
      expect(await liveTemplates(PRUDENTIAL)).toBe(1);
    });

    it('refuses its own company as the source (400), and a template that is not the source company’s (404)', async () => {
      await expect(wired.templateCopies.importFrom(sa, PRUDENTIAL, {
        fromCompanyId: PRUDENTIAL, templateId: prudentialDefault, name: 'Self',
      })).rejects.toMatchObject({ status: 400 });
      await expect(wired.templateCopies.importFrom(sa, PRUDENTIAL, {
        fromCompanyId: ALLIANZ, templateId: prudentialDefault, name: 'Wrong',
      })).rejects.toMatchObject({ status: 404 });
      await expect(wired.templateCopies.importFrom(sa, PRUDENTIAL, {
        fromCompanyId: '66f00000000000000000eeee', templateId: allianzDefault, name: 'Nobody',
      })).rejects.toMatchObject({ status: 404 });
      expect(await liveTemplates(PRUDENTIAL)).toBe(1);
    });
  });
});
