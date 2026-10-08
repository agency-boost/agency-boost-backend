import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionFrom } from '../../../test/config-module';
import { SEED_CAPABILITY_GRIDS, SEED_CAPABILITY_MILESTONES, SEED_CAPABILITY_STAGES } from '@/domain/constants';
import { OFFICE_TEMPLATE_KINDS, type OfficeTemplateKind } from './template-defaults';

const NOW = new Date('2026-10-07T03:00:00Z');
const TODAY = '2026-10-07';
const COMPANY = '66f0000000000000000000c1';
const KPM_E = '66f0000000000000000000e1';
const col = (name: string) => mongoose.connection.db!.collection(name);
const sa = RequestContext.platform('root');
const CASCADE = ['LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION'];
/** The platform ladder's stage codes, in order: what an office with no ladder is given (ADR-0116). */
const PLATFORM_STAGES = SEED_CAPABILITY_STAGES.map((st) => st.code);

const member = (over: Record<string, unknown> = {}) => new RequestContext('u-e', 'none', {
  membershipId: 'mem-agent', kpmId: KPM_E, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
} as never);
const AGENT = member();
const OWNER = member({ membershipId: 'mem-owner', orgLevelCode: 'AB', hierarchyRole: 'ab', isKpmOwner: true });

/**
 * **Empty means empty, and an empty office works** (ADR-0115 §1, §2, §8; P13.2-T6 AC-2, AC-8).
 *
 * A kind its source holds none of is empty in the office — a test per kind, so no fallback can hide in
 * one of them — and an office started *Empty* is usable: each settings screen's service authors its first
 * row from nothing, and each field read answers its empty state, never an error.
 *
 * **Two exceptions are structural**: the three cascade activity types (ADR-0115 §2), and the capability
 * ladder, the platform's where the source has none (ADR-0116, 2026-10-08) — so *Leader Notes* works in
 * every office.
 */
describe('an office started from nothing (P13.2-T6)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await (wired.companies as unknown as mongoose.Model<never>)
      .create({ _id: COMPANY, name: 'Prudential', slug: 'prudential' } as never);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await wired.namedTemplates.createFirst(sa, company as never);
    await (wired.kpms as unknown as mongoose.Model<never>).create({
      _id: KPM_E, companyId: COMPANY, code: '0701', branchName: 'Empty', timezone: 'Asia/Jakarta',
      startedFrom: { source: 'empty', templateId: null, templateName: null },
    } as never);
  });

  /** What one kind's rows are in the office, as a count — or, for the taxonomy, its type codes. */
  const holding: Record<OfficeTemplateKind, () => Promise<unknown>> = {
    activity_taxonomy: async () => (await col('activityTypes').find({ kpmId: KPM_E }).sort({ displayOrder: 1 }).toArray()).map((t) => t.code),
    lead_pipeline: () => col('leadStatuses').countDocuments({ kpmId: KPM_E }),
    ratio_set: () => col('ratioDefinitions').countDocuments({ kpmId: KPM_E }),
    training_taxonomy: () => col('trainingCategories').countDocuments({ kpmId: KPM_E }),
    activation_checklist: () => col('activationTemplates').countDocuments({ kpmId: KPM_E }),
    event_types: () => col('eventTypes').countDocuments({ kpmId: KPM_E }),
    capability_ladder: async () => ((await col('capabilityCatalogs').findOne({ kpmId: KPM_E }))?.stages ?? [])
      .map((st: { code: string }) => st.code),
  };
  /** What a kind the source holds none of is in the office: nothing, but for the two structural ones. */
  const EMPTY: Record<OfficeTemplateKind, unknown> = {
    activity_taxonomy: CASCADE, lead_pipeline: 0, ratio_set: 0, training_taxonomy: 0,
    activation_checklist: 0, event_types: 0, capability_ladder: PLATFORM_STAGES,
  };

  describe('AC-2: a kind the template never published is empty — a test per kind, no fallback', () => {
    it.each(OFFICE_TEMPLATE_KINDS.map((kind) => [kind]))('%s', async (kind) => {
      const template = await wired.namedTemplates.create(sa, COMPANY, { name: `All but ${kind}`, from: 'defaults' });
      // The kind unpublished; a ratio set over the twelve needs their taxonomy, so it goes with it.
      const gone = kind === 'activity_taxonomy' ? ['activity_taxonomy', 'ratio_set'] : [kind];
      await col('companyTemplates').updateMany(
        { templateId: template.id, kind: { $in: gone } }, { $set: { deletedAt: NOW } },
      );

      const done = await provisionFrom(wired, KPM_E, COMPANY, { kind: 'template', templateId: template.id });

      expect(await holding[kind]()).toEqual(EMPTY[kind]);
      // The ladder is the one kind given all the same, and its record says so (ADR-0116).
      expect(done.seededFrom[kind]).toEqual(kind === 'capability_ladder'
        ? { templateId: template.id, version: null, platformSupplied: true }
        : { templateId: template.id, version: null });
      expect(done.capabilityLadderSupplied).toBe(kind === 'capability_ladder');
      // Every other kind arrived, from the template.
      for (const other of OFFICE_TEMPLATE_KINDS.filter((k) => !gone.includes(k))) {
        expect({ other, record: done.seededFrom[other] }).toEqual({ other, record: { templateId: template.id, version: 1 } });
        // This template's ladder is the platform's, so the rows cannot tell the two apart; the record does.
        if (other !== 'capability_ladder') {
          expect({ other, held: await holding[other]() }).not.toEqual({ other, held: EMPTY[other] });
        }
      }
    });
  });

  /*
   * **ADR-0116: every office has a capability ladder.** The platform's where the source has none, and the
   * source's own, whole, where it has one — nothing is merged.
   */
  describe('ADR-0116: the capability ladder', () => {
    const catalog = () => col('capabilityCatalogs').findOne({ kpmId: KPM_E });

    it('an Empty office has the platform’s four stages, five milestones and four grids, recorded as supplied', async () => {
      const done = await provisionFrom(wired, KPM_E, COMPANY, { kind: 'empty' });

      const row = (await catalog())!;
      expect(row.stages.map((st: { code: string }) => st.code)).toEqual(PLATFORM_STAGES);
      expect(row.milestones.map((m: { code: string }) => m.code)).toEqual(SEED_CAPABILITY_MILESTONES.map((m) => m.code));
      expect(row.grids.map((g: { code: string }) => g.code)).toEqual(SEED_CAPABILITY_GRIDS.map((g) => g.code));
      expect(row.stages.every((st: { status: string }) => st.status === 'active')).toBe(true);
      expect(done.seededFrom.capability_ladder).toEqual({ templateId: null, version: null, platformSupplied: true });
      expect(done.capabilityLadderSupplied).toBe(true);
    });

    it('a template with a ladder of its own keeps it, whole — nothing of the platform’s is merged in', async () => {
      const own = await wired.namedTemplates.create(sa, COMPANY, { name: 'Own ladder', from: 'empty' });
      const ladder = {
        stages: [{ code: 'ROOKIE', label: 'Rookie', requiredMilestoneCodes: ['FIRST_SALE'], stageOrder: 1 }],
        milestones: [{ code: 'FIRST_SALE', label: 'First sale' }],
        grids: [{ code: 'BASICS', label: 'Basics', items: [{ code: 'PROSPECTING', label: 'Prospecting' }] }],
      };
      await wired.templateService.saveDraft(sa, COMPANY, 'capability_ladder', ladder, own.id);
      await wired.templateService.publish(sa, COMPANY, 'capability_ladder', own.id);

      const done = await provisionFrom(wired, KPM_E, COMPANY, { kind: 'template', templateId: own.id });

      const row = (await catalog())!;
      expect(row.stages.map((st: { code: string }) => st.code)).toEqual(['ROOKIE']);
      expect(row.milestones.map((m: { code: string }) => m.code)).toEqual(['FIRST_SALE']);
      expect(row.grids.map((g: { code: string }) => g.code)).toEqual(['BASICS']);
      expect(done.seededFrom.capability_ladder).toEqual({ templateId: own.id, version: 1 });
      expect(done.capabilityLadderSupplied).toBe(false);
    });

    it('the AgencyBoost defaults are unchanged: the platform ladder as the source’s own, not supplied', async () => {
      const done = await provisionFrom(wired, KPM_E, COMPANY, { kind: 'defaults' });

      expect((await catalog())!.stages.map((st: { code: string }) => st.code)).toEqual(PLATFORM_STAGES);
      expect(done.seededFrom.capability_ladder).toEqual({ templateId: null, version: null });
      expect(done.capabilityLadderSupplied).toBe(false);
    });
  });

  describe('AC-8: an Empty office works', () => {
    beforeEach(async () => {
      await provisionFrom(wired, KPM_E, COMPANY, { kind: 'empty' });
      await wired.config.publish(OWNER);
    });

    it('holds the three cascade types and the platform ladder, and nothing else, published', async () => {
      for (const kind of OFFICE_TEMPLATE_KINDS) expect(await holding[kind]()).toEqual(EMPTY[kind]);
      const published = await wired.config.readPublished(AGENT);
      expect(published.activity.flatMap((c) => c.types).map((t) => t.code)).toEqual(CASCADE);
      expect(published).toMatchObject({ ratios: [], training: [], eventTypes: [], activationChecklist: null });
      expect(published.capability!.stages.map((st) => st.code)).toEqual(PLATFORM_STAGES);
      expect(published.leadPipelines.flatMap((p) => p.statuses)).toEqual([]);
    });

    describe('each field screen reads its empty state, never an error', () => {
      it('Log Activity: the three, and a day logged against them', async () => {
        const day = await wired.activityLogs.saveDay(AGENT, { date: TODAY, counts: { LEADS_CONTACTED: 2, SELL_SUBMISSION: 1 } });
        expect(day.totalCount).toBe(3);
      });

      it('Leads: an empty list, and a lead added with no stage to stand on', async () => {
        expect((await wired.leadRecords.list(AGENT)).rows).toEqual([]);
        const lead = await wired.leadRecords.create(AGENT, { name: 'Ibu Sari' });
        expect(lead).toMatchObject({ name: 'Ibu Sari', statusCode: null });
      });

      it('Ratios: no ratio, and no error', async () => {
        await expect(wired.activityLogs.ratios(AGENT)).resolves.toMatchObject({ ratios: [] });
      });

      it('Training: no category', async () => {
        expect(await wired.training.list(AGENT)).toEqual([]);
      });

      it('Events: no type to file under, and no event', async () => {
        expect(await wired.events.listTypes(AGENT)).toEqual([]);
        expect(await wired.events.list(AGENT)).toEqual([]);
      });

      it('Capability (ADR-0116): the platform’s ladder, the office’s own, and a stage reached on it', async () => {
        const view = await wired.capability.read(AGENT);
        expect(view.stages.map((st) => st.code)).toEqual(PLATFORM_STAGES);
        expect(view).toMatchObject({ version: 1 });
        expect(view.milestones).toHaveLength(SEED_CAPABILITY_MILESTONES.length);
        expect(view.grids).toHaveLength(SEED_CAPABILITY_GRIDS.length);
        // The office's own catalog, not `read`'s fallback for an office that has none.
        expect(await wired.capability.own(AGENT)).not.toBeNull();
        expect(await wired.capability.stageFor(AGENT, [])).toBeNull();
        const first = SEED_CAPABILITY_STAGES[0];
        expect(await wired.capability.stageFor(AGENT, [...first.requiredMilestoneCodes]))
          .toMatchObject({ code: first.code });
      });

      it('Activation (ADR-0115 §8): none, and the checklist screen opens on nothing', async () => {
        // A real Agent, placed under a leader within an activation's life: the one who would have one.
        const hire = await mongoose.model('Membership').create({
          kpmId: KPM_E, userId: 'u-hire', role: 'agent', orgLevelCode: 'AGENT', orgLevelId: 'lvl-agent',
          status: 'active', agentCode: 'SBL-1', agentSeq: 1, leaderCode: 'LCHIRE01', leaderId: 'mem-owner',
          joinedAt: new Date('2026-10-01T03:00:00Z'), deletedAt: null,
        });
        const asHire = member({ membershipId: String(hire._id) });
        await expect(wired.activationProgress.mine(asHire)).rejects.toMatchObject({ status: 404 });
        expect(await col('activationProgress').countDocuments({ kpmId: KPM_E })).toBe(0);
        expect(await wired.activation.read(OWNER)).toMatchObject({ published: null, draft: null });
      });
    });

    describe('each Owner settings screen authors its first row from nothing', () => {
      it('lead statuses: a first stage in each pipeline, made the one that closes it', async () => {
        for (const pipeline of ['sales', 'recruitment'] as const) {
          await wired.leads.create(OWNER, { pipeline, code: `${pipeline.toUpperCase()}_FIRST`, label: 'First contact' });
          const closing = await wired.leads.create(OWNER, { pipeline, code: `${pipeline.toUpperCase()}_DONE`, label: 'Closed' });
          const view = await wired.leads.setTerminal(OWNER, closing.id);
          expect(view.statuses.map((s) => [s.code, s.isTerminal])).toEqual([
            [`${pipeline.toUpperCase()}_FIRST`, false], [`${pipeline.toUpperCase()}_DONE`, true],
          ]);
        }
      });

      it('activity types: a section and a type of its own beside the three', async () => {
        await wired.activity.createCategory(OWNER, { code: 'REFERRALS', label: 'Referrals' });
        await wired.activity.createType(OWNER, { code: 'REF_INTRO', categoryCode: 'REFERRALS', label: 'Intro' });
        expect((await wired.activity.list(OWNER)).flatMap((c) => c.types)).toHaveLength(4);
      });

      it('ratio benchmarks: a first ratio over the three', async () => {
        const ratio = await wired.ratios.create(OWNER, {
          code: 'CLOSING_RATE', label: 'Closing rate', numerator: ['SELL_SUBMISSION'],
          denominator: ['SELL_PRESENTATION'], benchmark: 0.2, comparison: 'gte',
        });
        expect(ratio).toMatchObject({ code: 'CLOSING_RATE', origin: 'office' });
      });

      it('training: a category, a skill and a module', async () => {
        await wired.training.createCategory(OWNER, { code: 'ONBOARDING', label: 'Onboarding' });
        await wired.training.createSkill(OWNER, { code: 'FIRST_WEEK', categoryCode: 'ONBOARDING', label: 'First week' });
        await wired.training.createModule(OWNER, { code: 'WELCOME', skillCode: 'FIRST_WEEK', title: 'Welcome' });
        expect((await wired.training.list(OWNER)).map((c) => c.code)).toEqual(['ONBOARDING']);
      });

      it('event types: a first type', async () => {
        await wired.events.createType(OWNER, { code: 'TOWN_HALL', label: 'Town hall', emoji: '📣', color: '#2D9CDB' });
        expect((await wired.events.listTypes(OWNER)).map((t) => t.code)).toEqual(['TOWN_HALL']);
      });

      it('activation checklist: a first aspect and item, published as version 1', async () => {
        await wired.activation.saveDraft(OWNER, {
          aspects: [{ code: 'FIRST_STEPS', label: 'First steps', items: [{ code: 'MEET_LEADER', label: 'Meet your leader' }] }],
        });
        const view = await wired.activation.publish(OWNER);
        expect(view.published).toMatchObject({ version: 1 });
      });

      it('capability mapping (ADR-0116): the platform ladder, edited as any office edits its own', async () => {
        const [first] = SEED_CAPABILITY_STAGES;
        const renamed = await wired.capability.rename(OWNER, 'stage', first.code, 'Produsen Kompeten');
        expect(renamed.stages.find((st) => st.code === first.code)).toMatchObject({ label: 'Produsen Kompeten' });
        const view = await wired.capability.add(OWNER, 'milestone', 'FIRST_SALE', 'First sale');
        expect(view.milestones.map((m) => m.code))
          .toEqual([...SEED_CAPABILITY_MILESTONES.map((m) => m.code), 'FIRST_SALE']);
      });
    });
  });
});
