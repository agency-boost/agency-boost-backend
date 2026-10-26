import mongoose from 'mongoose';
import {
  DEFAULT_ORG_LADDER, SEED_PRODUCTS, SEED_RECRUITMENT_PLAYBOOK, RATIO_BENCHMARKS,
} from '@/domain/constants';
import { defaultBinding } from '@/modules/config/activity-binding';
import { OFFICE_TEMPLATE_KINDS, platformDefaultPayload } from '@/modules/config/template-defaults';
import {
  defaultCampaignKinds, qualificationRuleSeedDocuments,
} from '@/modules/campaigns/campaign-kinds-payload';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up as membershipOrgLevel } from './0001-membership-org-level';
import { up as seedProductCatalog } from './0013-seed-product-catalog';
import { up as namedTemplates } from './0023-named-templates';
import { up as recruitmentPlaybook } from './0025-recruitment-playbook';
import { up as orgLevelLeaderTier } from './0030-org-level-leader-tier';
import { up as activityBindings } from './0034-activity-bindings';
import { up as companyKind } from './0036-company-kind';
import { up } from './0037-template-company';

const NOW = new Date('2026-10-26T02:00:00Z');
const LATER = new Date('2026-10-27T02:00:00Z');

/**
 * **P18.9-T3 AC-2 — the *Template* company** (ADR-0164 §1, §2).
 *
 * Made once, from the AgencyBoost defaults as Phase 18.8 left them, with everything a company created with the
 * defaults is given — so the migrations before it find each part on their next run and add nothing — and never
 * again: a second run, and every run after the Super Admin has changed it, writes nothing. Another company
 * holding the slug stops it, naming that company. (The whole list twice on an empty database:
 * `migrations.empty-db.spec.ts`. Over the demo seed: `template-seed.spec.ts`.)
 */
describe('0037 — the Template company', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const col = (name: string) => db().collection(name);
  const libraryId = TEMPLATE_LIBRARY.companyId;
  const templateId = TEMPLATE_LIBRARY.defaultTemplateId;
  const OWNED = ['companies', 'companyOrgLevels', 'products', 'qualificationRules', 'recruitmentPlaybooks',
    'companyTemplates', 'templates'];

  beforeEach(async () => {
    await clearCollections();
    // Written through the driver, so `clearCollections` (the models' collections) does not reach every one.
    for (const name of [...OWNED, 'memberships', 'kpms', 'activityBindings', 'configSnapshots', 'activityTypes']) {
      await col(name).deleteMany({});
    }
  });

  /** Every row of every collection the migration writes, so a second run can be compared with the first. */
  async function everything() {
    const state: Record<string, unknown[]> = {};
    for (const name of OWNED) state[name] = await col(name).find({}).sort({ _id: 1 }).toArray();
    return state;
  }

  it('P18.9-T3 AC-2 makes the company: kind template, slug template, the defaults recorded, last of its parts', async () => {
    expect(await up(db(), NOW)).toEqual({
      created: true,
      rungs: DEFAULT_ORG_LADDER.length,
      products: SEED_PRODUCTS.length,
      carrierRules: defaultCampaignKinds().rules.length,
      playbook: true,
      kinds: OFFICE_TEMPLATE_KINDS.length,
      template: true,
    });
    const company = await col('companies').findOne({ _id: new mongoose.Types.ObjectId(libraryId) });
    expect(company).toMatchObject({
      name: 'Template', slug: 'template', kind: 'template', status: 'active', usesPlatformDefaults: true,
      defaultCurrency: 'IDR', defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', deletedAt: null,
      createdAt: NOW, updatedAt: NOW,
    });
  });

  it('P18.9-T3 AC-2 gives it the ladder with its leader tiers, the products, the carrier rules and the playbook', async () => {
    await up(db(), NOW);

    const rungs = await col('companyOrgLevels').find({ companyId: libraryId }).sort({ displayOrder: 1 }).toArray();
    expect(rungs.map((r) => [r.code, r.label, r.leaderTier, r.status])).toEqual(
      DEFAULT_ORG_LADDER.map((r) => [r.code, r.label, r.leaderTier, 'active']),
    );
    // Stored explicitly, `null` included, so 0030 finds no rung without a tier.
    expect(rungs.every((r) => 'leaderTier' in r)).toBe(true);

    const products = await col('products').find({ companyId: libraryId }).toArray();
    expect(products.map((p) => p.code).sort()).toEqual(SEED_PRODUCTS.map((p) => p.code).sort());
    expect(products.every((p) => p.commissionSchedule.length === 0 && p.version === 1)).toBe(true);

    const rules = await col('qualificationRules').find({ companyId: libraryId }).toArray();
    expect(rules.map((r) => `${r.kind}:${r.code}`).sort()).toEqual(
      qualificationRuleSeedDocuments(libraryId, defaultCampaignKinds()).map((r) => `${r.kind}:${r.code}`).sort(),
    );
    // MOC carries persistency already, so 0026 has nothing to add.
    for (const rule of rules.filter((r) => r.kind === 'moc')) {
      expect(rule.criteriaGroups[0].criteria.map((c: { metricKey: string }) => c.metricKey)).toContain('MOC_PERSISTENCY');
    }

    expect(await col('recruitmentPlaybooks').findOne({ companyId: libraryId }))
      .toMatchObject({ body: SEED_RECRUITMENT_PLAYBOOK, version: 1, deletedAt: null });
  });

  it('P18.9-T3 AC-2 holds Default template, the default, each kind published as version 1 of the defaults as 18.8 left them', async () => {
    await up(db(), NOW);

    const template = await col('templates').findOne({ _id: new mongoose.Types.ObjectId(templateId) });
    expect(template).toMatchObject({
      companyId: libraryId, name: 'Default template', isDefault: true, status: 'active', origin: { kind: 'defaults' },
    });

    const rows = await col('companyTemplates').find({ companyId: libraryId }).toArray();
    expect(rows.map((r) => r.kind).sort()).toEqual([...OFFICE_TEMPLATE_KINDS].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ templateId, version: 1, status: 'published', publishedAt: NOW, deletedAt: null });
      expect(row.payload).toEqual(platformDefaultPayload(row.kind));
    }
    // No `campaign_kinds` row: the tab reads the platform's, as every company made with the defaults does.
    expect(rows.some((r) => r.kind === 'campaign_kinds')).toBe(false);

    // Phase 18.8 and P18.9-T2, as they stand: the client's words, the new benchmarks and the binding.
    const taxonomy = rows.find((r) => r.kind === 'activity_taxonomy')!.payload;
    expect(taxonomy.bindings).toEqual(defaultBinding());
    expect(taxonomy.types.find((t: { code: string }) => t.code === 'LEADS_CONTACTED').label).toBe('Set Appointment');
    const ratios = rows.find((r) => r.kind === 'ratio_set')!.payload.ratios as { code: string; benchmark: number }[];
    expect(ratios.find((r) => r.code === 'SELLING_SUCCESS_RATE')!.benchmark).toBe(RATIO_BENCHMARKS.SELLING_SUCCESS_RATE);
  });

  it('P18.9-T3 AC-2 runs twice with the same result as running once', async () => {
    await up(db(), NOW);
    const first = await everything();

    expect(await up(db(), LATER)).toEqual({
      created: false, rungs: 0, products: 0, carrierRules: 0, playbook: false, kinds: 0, template: false,
    });
    expect(await everything()).toEqual(first);
  });

  it('P18.9-T3 AC-2 leaves the earlier migrations nothing to give it on their next run', async () => {
    await companyKind(db());
    await up(db(), NOW);
    const first = await everything();

    expect(await membershipOrgLevel(db(), LATER)).toEqual({ ladders: 0, memberships: 0 });
    expect(await seedProductCatalog(db(), LATER)).toMatchObject({ seeded: 0 });
    expect(await namedTemplates(db(), LATER)).toMatchObject({
      templatesCreated: 0, rowsAssigned: 0, campaignRowsMarked: 0, defaultsPublished: 0, draftsRenumbered: 0,
    });
    expect(await recruitmentPlaybook(db(), LATER)).toMatchObject({ given: 0 });
    expect(await orgLevelLeaderTier(db())).toMatchObject({ senior: 0, associate: 0, none: 0 });
    expect(await activityBindings(db(), LATER)).toEqual({ offices: 0, snapshots: 0, templates: 0 });
    expect(await companyKind(db())).toEqual({ updated: 0 });

    const after = await everything();
    // 0023 builds its two indexes on every run and changes no row: the rows are what they were.
    expect(after).toEqual(first);
  });

  it('P18.9-T3 AC-2 touches no company that is already there', async () => {
    const { insertedId } = await col('companies').insertOne({
      name: 'Prudential', slug: 'prudential', kind: 'insurer', usesPlatformDefaults: true, deletedAt: null,
    });
    const before = await col('companies').findOne({ _id: insertedId });

    await up(db(), NOW);

    expect(await col('companies').findOne({ _id: insertedId })).toEqual(before);
    for (const name of OWNED.filter((n) => n !== 'companies' && n !== 'templates')) {
      expect([name, await col(name).countDocuments({ companyId: { $ne: libraryId } })]).toEqual([name, 0]);
    }
  });

  it('P18.9-T3 AC-2 does nothing once the company exists, its slug changed and its parts edited since', async () => {
    await up(db(), NOW);
    await col('companies').updateOne({ _id: new mongoose.Types.ObjectId(libraryId) }, { $set: { slug: 'template-library' } });
    await col('products').updateMany({ companyId: libraryId, code: SEED_PRODUCTS[0].code }, { $set: { deletedAt: LATER } });
    await col('recruitmentPlaybooks').updateOne({ companyId: libraryId }, { $set: { body: { nextAction: 'Ours.' }, version: 2 } });
    const edited = await everything();

    expect(await up(db(), LATER)).toMatchObject({ created: false, products: 0, playbook: false });
    expect(await everything()).toEqual(edited);
  });

  it('P18.9-T3 AC-2 finishes a run that stopped part-way, under the same ids, without a second of anything', async () => {
    // A run that wrote the ladder, three products and the first kind, and stopped before the company.
    await up(db(), NOW);
    await col('companies').deleteMany({});
    await col('templates').deleteMany({});
    await col('recruitmentPlaybooks').deleteMany({});
    await col('qualificationRules').deleteMany({});
    await col('products').deleteMany({ code: { $nin: SEED_PRODUCTS.slice(0, 3).map((p) => p.code) } });
    await col('companyTemplates').deleteMany({ kind: { $ne: OFFICE_TEMPLATE_KINDS[0] } });

    expect(await up(db(), LATER)).toEqual({
      created: true,
      rungs: 0,
      products: SEED_PRODUCTS.length - 3,
      carrierRules: defaultCampaignKinds().rules.length,
      playbook: true,
      kinds: OFFICE_TEMPLATE_KINDS.length - 1,
      template: true,
    });
    expect(await col('companies').countDocuments({ kind: 'template' })).toBe(1);
    expect(await col('products').countDocuments({ companyId: libraryId })).toBe(SEED_PRODUCTS.length);
    expect(await col('companyTemplates').countDocuments({ companyId: libraryId, templateId })).toBe(OFFICE_TEMPLATE_KINDS.length);
  });

  it('P18.9-T3 AC-2 stops, naming the company, when an insurer already holds the slug — and writes nothing', async () => {
    await col('companies').insertOne({ name: 'Template Life', slug: 'template', kind: 'insurer', deletedAt: null });

    await expect(up(db(), NOW)).rejects.toThrow(
      /the slug "template" already belongs to Template Life .*Give that company another slug at \/admin\/companies/,
    );
    for (const name of OWNED.filter((n) => n !== 'companies')) {
      expect([name, await col(name).countDocuments({})]).toEqual([name, 0]);
    }
    expect(await col('companies').countDocuments({})).toBe(1);
  });

  it('P18.9-T3 AC-2 is not stopped by a deleted company that once held the slug', async () => {
    await col('companies').insertOne({ name: 'Old Template', slug: 'template', kind: 'insurer', deletedAt: NOW });
    expect(await up(db(), NOW)).toMatchObject({ created: true });
  });
});
