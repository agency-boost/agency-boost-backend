import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { up as namedTemplates } from '@/migrations/0023-named-templates';
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
    expect(Object.values(template.publishedVersions).every((v) => v === 1)).toBe(true);
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
    expect(Object.values(templates[0].publishedVersions).every((v) => v === null)).toBe(true);
  });

  it('puts every template row under a template, and campaign kinds under none', async () => {
    expect(await col('companyTemplates').countDocuments({ kind: { $ne: 'campaign_kinds' }, templateId: null })).toBe(0);
    expect(await col('companyTemplates').countDocuments({ kind: 'campaign_kinds', templateId: { $ne: null } })).toBe(0);
  });

  describe('office 0701, started Empty', () => {
    it('records where it started, and that every kind came empty', async () => {
      const kpm = await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(EMPTY_OFFICE._id) });
      expect(kpm).toMatchObject({
        code: '0701', companyId: BLANK_COMPANY._id,
        startedFrom: { source: 'empty', templateId: null, templateName: null },
      });
      expect(Object.values(kpm!.seededFrom as Record<string, unknown>))
        .toEqual(Array(7).fill({ templateId: null, version: null }));
    });

    it('holds the three cascade activity types and nothing else', async () => {
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
      expect(await wired.capability.read(owner)).toMatchObject({ stages: [], milestones: [], grids: [] });
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
      expect(Object.values(saved.publishedVersions)).toEqual(Array(7).fill(1));
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
});
