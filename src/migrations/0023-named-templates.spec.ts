import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { configModule } from '../../test/config-module';
import { OFFICE_TEMPLATE_KINDS, platformDefaultPayload } from '@/modules/config/template-defaults';
import { defaultSource, type ProvisioningPlan } from '@/modules/config/provisioning.service';

type KindSourceMap = ProvisioningPlan['kinds'];
import { up } from './0023-named-templates';

const NOW = new Date('2026-10-07T03:00:00Z');
const DEFAULTS_CO = '66f0000000000000000000c1';
const BLANK_CO = '66f0000000000000000000c2';
const OLD_CO = '66f0000000000000000000c3';
const col = (name: string) => mongoose.connection.db!.collection(name);
const db = () => mongoose.connection.db as mongoose.mongo.Db;

/** A pre-13.2 template row: no `templateId`, keyed by company and kind alone. */
const legacyRow = (companyId: string, kind: string, version: number, status: string, payload: Record<string, unknown>) => ({
  companyId, kind, version, status, payload, publishedAt: status === 'published' ? NOW : null,
  deletedAt: null, createdBy: null, updatedBy: null, createdAt: NOW, updatedAt: NOW, __v: 0,
});

const TOWN_HALL = { types: [{ code: 'TOWN_HALL', label: 'Town hall', emoji: '📣', color: '#2D9CDB', displayOrder: 1 }] };

/**
 * **Migration 0023 — named templates** (ADR-0115 §3; P13.2-T6 AC-1), over a database built the way 13.1
 * left one: three companies, their rows with no template, the old one-version-per-company index, and
 * offices — one with a cascade type archived.
 */
describe('0023 — every company gets its default template', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['templates', 'companies', 'companyTemplates', 'kpms', 'activityTypes']) {
      await col(name).deleteMany({});
    }
    await col('companyTemplates').dropIndexes().catch(() => undefined);
    await col('companies').insertMany([
      { _id: new mongoose.Types.ObjectId(DEFAULTS_CO), name: 'Prudential', slug: 'prudential', usesPlatformDefaults: true, deletedAt: null },
      { _id: new mongoose.Types.ObjectId(BLANK_CO), name: 'Blank Co', slug: 'blank-co', usesPlatformDefaults: false, deletedAt: null },
      // Created before `usesPlatformDefaults` existed and missed by nothing: absent is true (0017).
      { _id: new mongoose.Types.ObjectId(OLD_CO), name: 'Allianz Life', slug: 'allianz-life', deletedAt: null },
    ]);
    // The old unique index, as 13.1 left it.
    await col('companyTemplates').createIndex(
      { companyId: 1, kind: 1, version: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } },
    );
    await col('companyTemplates').insertMany([
      legacyRow(DEFAULTS_CO, 'event_types', 1, 'published', TOWN_HALL),
      // A draft of a kind never published carries the version it will be: 1.
      legacyRow(DEFAULTS_CO, 'activity_taxonomy', 1, 'draft', { categories: [], types: [] }),
      legacyRow(DEFAULTS_CO, 'campaign_kinds', 1, 'published', { rules: [] }),
      legacyRow(BLANK_CO, 'event_types', 1, 'draft', TOWN_HALL),
    ]);
    await col('kpms').insertMany([
      { companyId: DEFAULTS_CO, code: '0417', branchName: 'BSD', seededFrom: {}, deletedAt: null },
      { companyId: BLANK_CO, code: '0100', branchName: 'Blank office', seededFrom: {}, deletedAt: null },
    ]);
    const kpm = (await col('kpms').findOne({ code: '0417' }))!;
    await col('activityTypes').insertMany([
      { kpmId: String(kpm._id), code: 'SELL_SUBMISSION', categoryCode: 'SELLING', status: 'archived', deletedAt: null },
      { kpmId: String(kpm._id), code: 'SELL_FOLLOWUP', categoryCode: 'SELLING', status: 'archived', deletedAt: null },
      { kpmId: String(kpm._id), code: 'LEADS_CONTACTED', categoryCode: 'LEADS_GENERATION', status: 'active', deletedAt: null },
    ]);
  });

  const templateOf = (companyId: string) => col('templates').findOne({ companyId, isDefault: true });

  it('names each company’s default "{name} template", holding every row it had', async () => {
    const result = await up(db(), NOW);
    expect(result).toMatchObject({ companies: 3, templatesCreated: 3, rowsAssigned: 3, campaignRowsMarked: 1 });

    for (const [companyId, name] of [[DEFAULTS_CO, 'Prudential'], [BLANK_CO, 'Blank Co'], [OLD_CO, 'Allianz Life']]) {
      expect(await templateOf(companyId)).toMatchObject({
        name: `${name} template`, isDefault: true, status: 'active', origin: { kind: 'migration' }, deletedAt: null,
      });
    }
    const pru = String((await templateOf(DEFAULTS_CO))!._id);
    expect(await col('companyTemplates').findOne({ companyId: DEFAULTS_CO, kind: 'event_types', version: 1 }))
      .toMatchObject({ templateId: pru, payload: TOWN_HALL });
    // Campaign kinds are the company's: under no template, but the field is there.
    expect(await col('companyTemplates').findOne({ companyId: DEFAULTS_CO, kind: 'campaign_kinds' }))
      .toMatchObject({ templateId: null });
  });

  it('publishes each kind a defaults company never published as version 1 of the defaults; a blank company nothing', async () => {
    const result = await up(db(), NOW);
    // Prudential: six of seven (event types it had); Allianz, absent meaning true: all seven.
    expect(result.defaultsPublished).toBe(13);
    expect(result.draftsRenumbered).toBe(1);

    const pru = String((await templateOf(DEFAULTS_CO))!._id);
    for (const kind of OFFICE_TEMPLATE_KINDS.filter((k) => k !== 'event_types')) {
      expect(await col('companyTemplates').findOne({ templateId: pru, kind, status: 'published' }))
        .toMatchObject({ version: 1, payload: platformDefaultPayload(kind), publishedAt: NOW });
    }
    // The draft moved to 2, making room; publishing it later numbers it from the published one anyway.
    expect(await col('companyTemplates').findOne({ templateId: pru, kind: 'activity_taxonomy', status: 'draft' }))
      .toMatchObject({ version: 2 });

    const blank = String((await templateOf(BLANK_CO))!._id);
    expect(await col('companyTemplates').find({ companyId: BLANK_CO }).toArray())
      .toEqual([expect.objectContaining({ templateId: blank, kind: 'event_types', status: 'draft' })]);
  });

  it('moves the unique index to the template, so a second template can have its own version 1', async () => {
    const result = await up(db(), NOW);
    expect(result.oldIndexDropped).toBe(true);
    const names = (await col('companyTemplates').indexes()).map((i) => i.name);
    expect(names).not.toContain('companyId_1_kind_1_version_1');
    expect(names).toContain('companyId_1_templateId_1_kind_1_version_1');
    await expect(col('companyTemplates').insertOne(
      { ...legacyRow(DEFAULTS_CO, 'event_types', 1, 'published', TOWN_HALL), templateId: 'another' },
    )).resolves.toBeTruthy();
  });

  it('touches no office, and reports one with a cascade type archived', async () => {
    const before = await col('kpms').find({}).toArray();
    const types = await col('activityTypes').find({}).toArray();
    const result = await up(db(), NOW);

    const kpm = (await col('kpms').findOne({ code: '0417' }))!;
    expect(result.cascadeArchived).toEqual([{ kpmId: String(kpm._id), codes: ['SELL_SUBMISSION'] }]);
    expect(await col('kpms').find({}).toArray()).toEqual(before);
    expect(await col('activityTypes').find({}).toArray()).toEqual(types);
  });

  it('is idempotent: a second run writes nothing', async () => {
    await up(db(), NOW);
    const templates = await col('templates').find({}).toArray();
    const rows = await col('companyTemplates').find({}).toArray();

    expect(await up(db(), NOW)).toMatchObject({
      templatesCreated: 0, rowsAssigned: 0, campaignRowsMarked: 0, defaultsPublished: 0, draftsRenumbered: 0,
      oldIndexDropped: false,
    });
    expect(await col('templates').find({}).toArray()).toEqual(templates);
    expect(await col('companyTemplates').find({}).toArray()).toEqual(rows);
  });

  it('leaves a company that already has a default — one made by createCompany since — as it is', async () => {
    await col('templates').insertOne({
      companyId: BLANK_CO, name: 'Ours', isDefault: true, status: 'active', origin: { kind: 'empty' }, deletedAt: null,
    });
    const result = await up(db(), NOW);
    expect(result.templatesCreated).toBe(2);
    expect(await templateOf(BLANK_CO)).toMatchObject({ name: 'Ours', origin: { kind: 'empty' } });
  });
});

/**
 * **AC-1: an office created after the migration, for a defaults company, has the same configuration as
 * one created before it.** *Before* is provisioning as 13.1 ran it — each kind the company's newest
 * published version, or the platform defaults where it had none; *after* is the company's default
 * template, as `createKpm` resolves it now.
 */
describe('0023 — what a defaults company’s next office gets does not change', () => {
  let wired: ReturnType<typeof configModule>;
  const BEFORE = '66f0000000000000000000a1';
  const AFTER = '66f0000000000000000000a2';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  /** Everything an office's configuration is, without what makes two rows different rows. */
  async function configurationOf(kpmId: string) {
    const strip = (rows: Record<string, unknown>[]) => rows.map(({
      _id, kpmId: _k, createdAt: _c, updatedAt: _u, __v: _v, publishedAt: _p, ...rest
    }) => rest).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const of = async (name: string) => strip(await col(name).find({ kpmId }).toArray() as Record<string, unknown>[]);
    return {
      categories: await of('activityCategories'),
      types: await of('activityTypes'),
      statuses: await of('leadStatuses'),
      ratios: await of('ratioDefinitions'),
      trainingCategories: await of('trainingCategories'),
      skills: await of('trainingSkills'),
      modules: await of('trainingModules'),
      checklist: await of('activationTemplates'),
      events: await of('eventTypes'),
      capability: await of('capabilityCatalogs'),
    };
  }

  it('gives the office made after it exactly what the office made before it got', async () => {
    await clearCollections();
    for (const name of ['templates', 'companies', 'companyTemplates']) await col(name).deleteMany({});
    await col('companies').insertOne({
      _id: new mongoose.Types.ObjectId(DEFAULTS_CO), name: 'Prudential', slug: 'prudential', usesPlatformDefaults: true, deletedAt: null,
    });
    await col('companyTemplates').insertOne(legacyRow(DEFAULTS_CO, 'event_types', 1, 'published', TOWN_HALL));

    // Before: the company's published event types, and the platform's defaults for the rest.
    const before: KindSourceMap = Object.fromEntries(OFFICE_TEMPLATE_KINDS.map((kind) => [kind, defaultSource(kind)])) as KindSourceMap;
    before.event_types = { payload: TOWN_HALL, seededFrom: { templateId: 'row', version: 1 } };
    await wired.provisioning.provision(BEFORE, {
      startedFrom: { source: 'template', templateId: null, templateName: null }, kinds: before,
    });

    await up(db(), NOW);
    // After: no `startFrom`, as approving a KPM request does — the company's default template.
    await wired.provisioning.provision(AFTER, await wired.provisioning.planFor(DEFAULTS_CO));

    expect(await configurationOf(AFTER)).toEqual(await configurationOf(BEFORE));
    expect((await configurationOf(AFTER)).types).toHaveLength(12);
  });
});
