import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { up as namedTemplates } from '@/migrations/0023-named-templates';
import { SEED_CAPABILITY_STAGES, SEED_PRODUCTS } from '@/domain/constants';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';
import { OFFICE_TEMPLATE_KINDS } from '@/modules/config/template-defaults';

/** The seven office kinds and the recruitment playbook (ADR-0210 §1): what this spec counts, whatever a later kind adds. */
const T5_KINDS = [...OFFICE_TEMPLATE_KINDS, 'recruitment_playbook'] as const;
import { BLANK_COMPANY, EMPTY_OFFICE } from '../template-fixture';
import { BSD_CITY_SETTINGS, seedTemplateCopyFixture } from '../template-copy-fixture';
import { seedDemo } from '../demo';

/**
 * **P13.2-T6 — named templates and an office started *Empty*, seeded** (Phase 13.2, *Seed*;
 * `template-fixture.ts`).
 *
 * Run as the command runs it and read back through the services the screens read, so what is asserted is
 * what the Super Admin's template screen and 0701's two people see.
 */
const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

async function as(email: string, owner = false): Promise<RequestContext> {
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
    hierarchyRole: member.role, status: 'active', isKpmOwner: owner, isKpmAdmin: false, directCount: 0,
  } as never);
}

describe('P13.2-T6 the template seed — a run at 10:00 on 7 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-07T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let prudentialId: string;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    prudentialId = String((await col('companies').findOne({ slug: 'prudential' }))!._id);
  }, RUN_MS);
  afterAll(stopMongo);

  it('gives Prudential its migration template, the default, holding every kind and answering for its offices', async () => {
    const [template] = await wired.namedTemplates.list(prudentialId);
    expect(template).toMatchObject({
      name: 'Prudential template', isDefault: true, status: 'active', origin: { kind: 'migration' },
    });
    // Each kind published: the seed's own event types, and the rest as version 1 of the defaults.
    // *Amended 2026-11-05 (P19.4-T1, ADR-0208 §1):* training is version 2, the version that carries the company's
    // material (`training-fixture.ts`, `seedTemplateMaterial`; pinned in `training-seed.spec.ts`).
    // *Amended 2026-11-06 (P19.6-T4, ADR-0220 §4):* training is version 3 and capability version 2 — the newer names
    // `training-names-fixture.ts` publishes so 0417's Owner has something for *Sinkron dari template* to show.
    // *Amended 2026-11-06 (P19.6-T1, ADR-0218 §3):* the ninth section, *Tampilan* (`branding`), is never published by
    // the migration or the seed — its default is "nothing set", so 0417 and the others show AgencyBoost's look; the
    // seed brands 0555 itself (`branding-fixture.ts`), not the template.
    const {
      training_taxonomy: training, capability_ladder: capability, branding, ...rest
    } = template.publishedVersions;
    expect(Object.values(rest).every((v) => v === 1)).toBe(true);
    expect(training).toBe(3);
    expect(capability).toBe(2);
    expect(branding).toBeNull();
    // The offices created before named templates — 0417, 0555, 0999, 0601, 0602 — are its.
    expect(template.officeCount).toBe(await col('kpms').countDocuments({ companyId: prudentialId, deletedAt: null }));

    const events = await wired.templateService.read(prudentialId, 'event_types');
    expect((events.payload as { types: { label: string }[] }).types.map((t) => t.label)).toContain('Pelatihan');
  });

  it('gives Sejahtera Baru Life, started blank, a default template that holds nothing', async () => {
    const company = await col('companies').findOne({ slug: BLANK_COMPANY.slug });
    expect(company).toMatchObject({ name: BLANK_COMPANY.name, usesPlatformDefaults: false });
    expect(await col('products').countDocuments({ companyId: BLANK_COMPANY._id })).toBe(0);

    const templates = await wired.namedTemplates.list(BLANK_COMPANY._id);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      name: 'Sejahtera Baru Life template', isDefault: true, origin: { kind: 'empty' }, officeCount: 0,
    });
    // Nothing but *Advanced analytics*, whose four system columns are never missing (P19.5-T1; ADR-0214 §9).
    const { advanced_analytics: analytics, ...rest } = templates[0].publishedVersions;
    expect(Object.values(rest).every((v) => v === null)).toBe(true);
    expect(analytics).toBe(1);
  });

  it('puts every template row under a template, and campaign kinds under none', async () => {
    expect(await col('companyTemplates').countDocuments({ kind: { $ne: 'campaign_kinds' }, templateId: null })).toBe(0);
    expect(await col('companyTemplates').countDocuments({ kind: 'campaign_kinds', templateId: { $ne: null } })).toBe(0);
  });

  describe('office 0701, started Empty', () => {
    it('records where it started, that every kind came empty, and that the ladder was supplied (ADR-0116)', async () => {
      const kpm = await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(EMPTY_OFFICE._id) });
      expect(kpm).toMatchObject({
        code: '0701', companyId: BLANK_COMPANY._id,
        startedFrom: { source: 'empty', templateId: null, templateName: null },
      });
      const { capability_ladder: ladder, ...rest } = kpm!.seededFrom as Record<string, unknown>;
      expect(Object.values(rest)).toEqual(Array(6).fill({ templateId: null, version: null }));
      expect(ladder).toEqual({ templateId: null, version: null, platformSupplied: true });
    });

    it('holds the three cascade activity types and the platform capability ladder, and nothing else', async () => {
      const owner = await as('owner@kpm0701.test', true);
      const taxonomy = await wired.activity.list(owner);
      expect(taxonomy.map((c) => c.code)).toEqual(['LEADS_GENERATION', 'SELLING']);
      expect(taxonomy.flatMap((c) => c.types).map((t) => t.code))
        .toEqual(['LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION']);

      // Both pipelines, each with no stage yet.
      expect((await wired.leads.list(owner)).flatMap((p) => p.statuses)).toEqual([]);
      expect(await wired.ratios.list(owner)).toEqual([]);
      expect(await wired.training.list(owner)).toEqual([]);
      expect(await wired.events.listTypes(owner)).toEqual([]);
      // ADR-0116: the platform ladder, the office's own — Capability Mapping and Leader Notes have it.
      const ladder = await wired.capability.read(owner);
      expect(ladder.stages.map((st) => st.code)).toEqual(SEED_CAPABILITY_STAGES.map((st) => st.code));
      expect([ladder.milestones.length, ladder.grids.length]).toEqual([5, 4]);
      expect(await wired.capability.own(owner)).not.toBeNull();
      // The checklist screen opens on nothing to author from, not on the platform's sixteen items.
      expect(await wired.activation.read(owner)).toMatchObject({ published: null, draft: null });
    });

    it('is published: its Agent reads the three on Log Activity, and has no activation', async () => {
      const agent = await as('agent@kpm0701.test');
      const published = await wired.config.readPublished(agent);
      expect(published.activity.flatMap((c) => c.types).map((t) => t.code))
        .toEqual(['LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION']);
      expect(published.activationChecklist).toBeNull();

      await expect(wired.activationProgress.mine(agent)).rejects.toThrow('Activation');
      expect(await col('activationProgress').countDocuments({ kpmId: EMPTY_OFFICE._id })).toBe(0);
    });
  });

  it('migration 0023 run twice over the seed writes nothing, touches no office and reports nothing archived', async () => {
    const offices = await col('kpms').find({}).toArray();
    for (let run = 0; run < 2; run += 1) {
      expect(await namedTemplates(mongoose.connection.db!, clock.now())).toMatchObject({
        templatesCreated: 0, rowsAssigned: 0, campaignRowsMarked: 0, defaultsPublished: 0, draftsRenumbered: 0,
        cascadeArchived: [],
      });
    }
    expect(await col('kpms').find({}).toArray()).toEqual(offices);
  });

  it('writes nothing on a second run without --reset', async () => {
    const [templates, rows, kpms] = await Promise.all(['templates', 'companyTemplates', 'kpms'].map((c) => col(c).countDocuments({})));
    const again = await seedDemo({ clock, log: quiet });
    expect(again.written).not.toHaveProperty('templates');
    expect(await col('templates').countDocuments({})).toBe(templates);
    expect(await col('companyTemplates').countDocuments({})).toBe(rows);
    expect(await col('kpms').countDocuments({})).toBe(kpms);
    // A walk that renamed nothing finds the default where it was.
    expect((await wired.namedTemplates.resolve(BLANK_COMPANY._id)).name).toBe('Sejahtera Baru Life template');
  }, RUN_MS);

  it('AC-9: once 0701’s Owner publishes a first checklist, its Agent has an activation at her next read, from her join date', async () => {
    const owner = await as('owner@kpm0701.test', true);
    await wired.activation.saveDraft(owner, {
      aspects: [{ code: 'FIRST_STEPS', label: 'First steps', items: [{ code: 'MEET_LEADER', label: 'Meet your leader' }] }],
    });
    await wired.activation.publish(owner);

    const view = await wired.activationProgress.mine(await as('agent@kpm0701.test'));
    // Placed a week before the run: 30 September in Jakarta.
    expect(view).toMatchObject({ startDate: '2026-09-30', state: 'open', total: 1 });
  });

  it('P19.4-T5 AC-2 gives Allianz Life an archived rung nothing names — ABP, which /admin/org-levels lets the Super Admin delete', async () => {
    const allianz = String((await col('companies').findOne({ slug: 'allianz-life' }))!._id);
    expect(await col('companyOrgLevels').findOne({ companyId: allianz, code: 'ABP', deletedAt: null }))
      .toMatchObject({ label: 'Associate Business Partner', status: 'archived' });
    const named = { $or: [{ orgLevelCode: 'ABP' }, { appliesToOrgLevelCodes: 'ABP' }, { 'payload.ratios.appliesToOrgLevelCodes': 'ABP' }] };
    for (const name of ['memberships', 'ratioDefinitions', 'activityCategories', 'companyTemplates', 'qualificationRules']) {
      expect([name, await col(name).countDocuments(named)]).toEqual([name, 0]);
    }
  });

  describe('P13.2-T7: BSD City settings, saved from 0417 into Prudential', () => {
    const kpm0417 = async () => String((await col('kpms').findOne({ code: '0417' }))!._id);

    it('is Prudential\u2019s second template, from the office, every kind a published version 1, no office yet', async () => {
      const templates = await wired.namedTemplates.list(prudentialId);
      expect(templates.map((t) => [t.name, t.isDefault])).toEqual([
        ['Prudential template', true], ['BSD City settings', false],
      ]);
      const saved = templates[1];
      expect(saved).toMatchObject({
        id: BSD_CITY_SETTINGS._id, status: 'active', officeCount: 0,
        origin: { kind: 'office', kpmId: await kpm0417(), companyId: prudentialId },
      });
      // Saved from an office, which holds no playbook (ADR-0210 §4): its *Rekrutmen* is *Kosong*.
      expect(OFFICE_TEMPLATE_KINDS.map((kind) => saved.publishedVersions[kind])).toEqual(Array(7).fill(1));
      expect(saved.publishedVersions.recruitment_playbook).toBeNull();
    });

    it('ADR-0185: holds one change waiting — its lead stages a draft version 2, the rest as published', async () => {
      const saved = (await wired.namedTemplates.list(prudentialId)).find((t) => t.id === BSD_CITY_SETTINGS._id)!;
      expect(saved.sections.lead_pipeline).toEqual({ publishedVersion: 1, hasDraft: true });
      expect(Object.values(saved.sections).filter((s) => s.hasDraft)).toHaveLength(1);
      const draft = await wired.templateService.read(prudentialId, 'lead_pipeline', BSD_CITY_SETTINGS._id);
      expect(draft).toMatchObject({ status: 'draft', version: 2, publishedVersion: 1 });
      // The default stays as published: one template of each kind for the walk to compare — but *Advanced analytics*,
      // where migration 0057 offers Prudential's §3 seed (`^[0-9]{8}$`) as a draft beside version 1 (P19.5-T1 AC-3).
      const prudential = (await wired.namedTemplates.list(prudentialId)).find((t) => t.isDefault)!;
      const { advanced_analytics: analytics, ...rest } = prudential.sections;
      expect(Object.values(rest).some((s) => s.hasDraft)).toBe(false);
      expect(analytics).toEqual({ publishedVersion: 1, hasDraft: true });
    });

    it('holds what 0417\u2019s agents read: its published activity types, by code', async () => {
      const snapshot = (await col('configSnapshots').find({ kpmId: await kpm0417() }).sort({ version: -1 }).limit(1).toArray())[0];
      const published = (snapshot.payload.activity as { types: { code: string }[] }[]).flatMap((c) => c.types.map((t) => t.code));
      const taxonomy = await wired.templateService.read(prudentialId, 'activity_taxonomy', BSD_CITY_SETTINGS._id);
      expect((taxonomy.payload.types as { code: string }[]).map((t) => t.code).sort()).toEqual([...published].sort());
    });

    it('is a template an office can be started from — the whole-source check passes', async () => {
      const kpmId = '66f0000000000000000007a1';
      const done = await provisionFrom(wired, kpmId, prudentialId, { kind: 'template', templateId: BSD_CITY_SETTINGS._id });
      expect(done.seededFrom.activity_taxonomy).toEqual({ templateId: BSD_CITY_SETTINGS._id, version: 1 });
      // Not left behind for the walk: the office was never made, only its rows.
      for (const name of ['activityCategories', 'activityTypes', 'leadStatuses', 'ratioDefinitions', 'trainingCategories',
        'trainingSkills', 'trainingModules', 'activationTemplates', 'eventTypes', 'capabilityCatalogs']) {
        await col(name).deleteMany({ kpmId });
      }
    });

    it('writes nothing when it runs again', async () => {
      const again = await seedTemplateCopyFixture({ clock, companyId: prudentialId, kpm0417: await kpm0417() });
      expect(again).toMatchObject({ templateId: BSD_CITY_SETTINGS._id, written: 0 });
    });
  });

  /** Last, because its `--reset` run starts the database over. */
  describe('P18.6-T3: the Template company (ADR-0164), made by migration 0037', () => {
    const library = TEMPLATE_LIBRARY.companyId;

    async function expectTheLibrary() {
      expect(await col('companies').findOne({ slug: 'template', deletedAt: null }))
        .toMatchObject({ name: 'Template', kind: 'template', usesPlatformDefaults: true, status: 'active' });
      const templates = await wired.namedTemplates.list(library);
      expect(templates).toHaveLength(1);
      expect(templates[0]).toMatchObject({
        id: TEMPLATE_LIBRARY.defaultTemplateId, name: 'Default template', isDefault: true,
        origin: { kind: 'defaults' }, officeCount: 0,
      });
      // Seven kinds and, since migration 0056 ran in the seed, the playbook moved into it (ADR-0210 §5).
      expect(T5_KINDS.map((kind) => templates[0].publishedVersions[kind])).toEqual(Array(8).fill(1));
      expect(await col('products').countDocuments({ companyId: library, deletedAt: null })).toBe(SEED_PRODUCTS.length);
      expect(await col('recruitmentPlaybooks').countDocuments({ companyId: library, deletedAt: null })).toBe(1);
      expect(await col('recruitmentPlaybooks').findOne({ companyId: library }))
        .toMatchObject({ migratedTo: { templateId: TEMPLATE_LIBRARY.defaultTemplateId, version: 1 } });
      expect(await col('qualificationRules').countDocuments({ companyId: library, deletedAt: null })).toBeGreaterThan(0);
      const ladder = await col('companyOrgLevels').find({ companyId: library, deletedAt: null }).sort({ displayOrder: 1 }).toArray();
      expect(ladder.map((r) => [r.code, r.leaderTier])).toEqual([['AGENT', null], ['AAB', 'associate'], ['AB', 'senior']]);
      // It holds no office, and nobody works for it.
      expect(await col('kpms').countDocuments({ companyId: library })).toBe(0);
      expect(await col('users').countDocuments({ companyId: library })).toBe(0);
    }

    it('AC-7 is in the seed: the library, its company data, and Default template — the default, every kind published', expectTheLibrary);

    it('AC-7 a --reset run empties it with everything else and makes it again, once', async () => {
      await seedDemo({ clock, reset: true, log: quiet });
      await expectTheLibrary();
      expect(await col('companies').countDocuments({ kind: 'template' })).toBe(1);
      expect(await col('companyTemplates').countDocuments({ companyId: library, kind: { $in: [...T5_KINDS] } }))
        .toBe(8);
    }, RUN_MS);
  });
});
