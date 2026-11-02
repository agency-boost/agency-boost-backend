import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { SEED_ACTIVITY_TYPES, SEED_TRAINING_MODULES } from '@/domain/constants';
import { CompanyTemplate, CompanyTemplateSchema } from './company-template.schema';
import { TemplateService } from './template.service';
import { KpmOfficeCounter } from './office-counter';
import { NamedTemplate, NamedTemplateSchema } from './named-template.schema';
import { NamedTemplateService } from './named-template.service';
import { platformDefaultPayload } from './template-defaults';
import { standingOf } from './office-counter.port';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AGENT, OWNER } from '../../../test/http-permissions';

const NOW = new Date('2026-09-11T02:00:00Z');

function ctx() {
  return new RequestContext('u-root', 'super_admin', null);
}

describe('a company’s KPM template (P4-T8, ADR-0018)', () => {
  let service: TemplateService;
  let named: NamedTemplateService;
  let companies: mongoose.Model<never>;
  let kpms: mongoose.Model<never>;
  let companyId: string;
  /** The company's default template, as migration `0023` leaves one (ADR-0115 §3). */
  let defaultId: string;
  /**
   * What publishing `campaign_kinds` handed on (P5-T9 AC-4).
   *
   * A fake rather than a real `ProvisioningService`: the port exists so this spec can assert the
   * *hand-off* — that publishing applies it, and only for this kind — while the writing itself is
   * tested against a real database in the provisioning spec, where the rows are.
   */
  const applied: { companyId: string; codes: string[] }[] = [];
  const applier = {
    applyCampaignKinds: async (
      company: string, payload: { rules: { code: string }[] },
    ) => {
      applied.push({ companyId: company, codes: payload.rules.map((r) => r.code) });
      return { written: payload.rules.length, retired: 0 };
    },
  };

  beforeAll(async () => {
    await startMongo();
    companies = mongoose.model(Company.name, CompanySchema) as never;
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    named = new NamedTemplateService(
      mongoose.model(NamedTemplate.name, NamedTemplateSchema) as never,
      mongoose.model(CompanyTemplate.name, CompanyTemplateSchema) as never,
      companies as never,
      new KpmOfficeCounter(kpms as never),
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      new FixedClock(NOW),
    );
    service = new TemplateService(
      mongoose.model(CompanyTemplate.name, CompanyTemplateSchema) as never,
      companies as never,
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      new FixedClock(NOW),
      new KpmOfficeCounter(kpms as never),
      applier,
      named,
    );
  });

  /** A default template for a company, as the migration gives every existing one. */
  const defaultTemplateFor = async (company: string) => String((await mongoose.model(NamedTemplate.name, NamedTemplateSchema).create({
    companyId: company, name: 'Company template', isDefault: true, status: 'active',
    origin: { kind: 'migration' }, deletedAt: null,
  }))._id);

  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await companies.create({
      name: 'Prudential', slug: 'prudential', defaultCurrency: 'IDR',
      defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active',
    } as never);
    companyId = String((company as unknown as { _id: unknown })._id);
    defaultId = await defaultTemplateFor(companyId);
  });

  describe('what a Super Admin opens', () => {
    it('reads nothing for a kind the template never published — what its offices get (ADR-0115 §1)', async () => {
      /*
       * It handed back the platform's twelve as a starting point, which made a template with nothing
       * published look as if it held them — while its offices got them by a fallback nobody chose.
       * *New template from the AgencyBoost defaults* is how a template holds them now.
       */
      const view = await service.read(companyId, 'activity_taxonomy');
      expect(view).toMatchObject({
        status: 'draft', version: 0, payload: {}, publishedVersion: null, templateId: defaultId,
      });
    });

    it('reads a template made from the AgencyBoost defaults as its published version 1', async () => {
      const made = await named.create(ctx(), companyId, { name: 'From the defaults', from: 'defaults' });

      const view = await service.read(companyId, 'activity_taxonomy', made.id);
      expect(view).toMatchObject({ status: 'published', version: 1, templateId: made.id });
      expect((view.payload.types as unknown[])).toHaveLength(SEED_ACTIVITY_TYPES.length);
      // The default template is another template, and still holds nothing.
      expect((await service.read(companyId, 'activity_taxonomy')).payload).toEqual({});
    });

    it('refuses a company that does not exist, without a CastError', async () => {
      // These ids arrive from a URL. An uncaught cast is a 500 and a log line about an
      // unhandled error, which is the wrong story about a typo.
      await expect(service.read('not-an-id', 'activity_taxonomy'))
        .rejects.toThrow('Company');
    });

    it('shows the draft once there is one, not the published version', async () => {
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', { categories: [], types: [] });
      const view = await service.read(companyId, 'activity_taxonomy');
      expect(view.status).toBe('draft');
      expect(view.payload).toEqual({ categories: [], types: [] });
    });

    it('hands a blank company nothing, on every kind (client feedback, 2026-09-24)', async () => {
      /*
       * The starting point above is right almost every time and wrong for the one case a
       * Super Admin authoring an insurer's presets from scratch is in: the eight kinds are
       * computed here rather than written at creation, so declining the defaults has to
       * reach *this* method or the twelve activity types turn up anyway.
       */
      const blank = await companies.create({
        name: 'Blank Co', slug: 'blank-co', defaultCurrency: 'IDR',
        defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active',
        usesPlatformDefaults: false,
      } as never);
      const blankId = String((blank as unknown as { _id: unknown })._id);
      await defaultTemplateFor(blankId);

      for (const kind of [
        'activity_taxonomy', 'ratio_set', 'lead_pipeline', 'training_taxonomy',
        'activation_checklist', 'capability_ladder', 'event_types', 'campaign_kinds',
      ] as const) {
        expect(await service.read(blankId, kind)).toMatchObject({ version: 0, payload: {} });
      }
    });

    it('still hands a draft to a blank company once it has authored one', async () => {
      // Blank is where it starts, not a permanent state.
      const blank = await companies.create({
        name: 'Blank Two', slug: 'blank-two', defaultCurrency: 'IDR',
        defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active',
        usesPlatformDefaults: false,
      } as never);
      const blankId = String((blank as unknown as { _id: unknown })._id);
      await defaultTemplateFor(blankId);

      await service.saveDraft(ctx(), blankId, 'activity_taxonomy', {
        categories: [{ code: 'OWN', label: 'Our own', displayOrder: 1 }], types: [],
      });

      const view = await service.read(blankId, 'activity_taxonomy');
      expect((view.payload.categories as { code: string }[])[0].code).toBe('OWN');
    });
  });

  describe('publishing', () => {
    const taxonomy = {
      categories: [{ code: 'SELLING', label: 'Selling', displayOrder: 1 }],
      types: [{
        code: 'SELL_SUBMISSION', categoryCode: 'SELLING', label: 'Submission polis',
        description: null, displayOrder: 1,
      }],
    };

    it('makes the draft version 1, and records when', async () => {
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', taxonomy);
      const published = await service.publish(ctx(), companyId, 'activity_taxonomy');

      expect(published.status).toBe('published');
      expect(published.version).toBe(1);
      expect(published.publishedAt).toBe(NOW.toISOString());
    });

    it('refuses to publish when nothing has changed', async () => {
      // A published version is immutable, because offices record which one they were
      // built from. Re-publishing an unchanged one would mint a version that means
      // nothing.
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', taxonomy);
      await service.publish(ctx(), companyId, 'activity_taxonomy');

      await expect(service.publish(ctx(), companyId, 'activity_taxonomy'))
        .rejects.toThrow('nothing to publish');
    });

    it('starts a new draft on the next edit, and publishes it as version 2', async () => {
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', taxonomy);
      await service.publish(ctx(), companyId, 'activity_taxonomy');

      const draft = await service.saveDraft(ctx(), companyId, 'activity_taxonomy', {
        ...taxonomy,
        types: [...taxonomy.types, {
          code: 'SELL_REFERRAL', categoryCode: 'SELLING', label: 'Referral',
          description: null, displayOrder: 2,
        }],
      });
      expect(draft.status).toBe('draft');
      expect(draft.version).toBe(2);

      const second = await service.publish(ctx(), companyId, 'activity_taxonomy');
      expect(second.version).toBe(2);

      // And version 1 is still there, unchanged, because an office records it.
      const history = await service.history(companyId, 'activity_taxonomy');
      expect(history.map((h) => h.version)).toEqual([2, 1]);
      expect((history[1].payload.types as unknown[])).toHaveLength(1);
    });

    it('refuses a taxonomy that would give every new office an empty capture screen', async () => {
      // Discovering this at provisioning is the worst possible moment: a Super Admin
      // creating an office for a real branch, failing on a template published weeks ago.
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', { categories: [], types: [] });
      await expect(service.publish(ctx(), companyId, 'activity_taxonomy'))
        .rejects.toThrow('empty Log Activity screen');
    });

    it('refuses a pipeline with no stage that closes it', async () => {
      await service.saveDraft(ctx(), companyId, 'lead_pipeline', {
        statuses: [
          { pipeline: 'sales', code: 'A', label: 'A', rank: 1, isTerminal: false },
          { pipeline: 'recruitment', code: 'B', label: 'B', rank: 1, isTerminal: true },
        ],
      });
      await expect(service.publish(ctx(), companyId, 'lead_pipeline'))
        .rejects.toThrow('sales pipeline needs exactly one stage that closes it');
    });

    it('refuses a pipeline with two', async () => {
      await service.saveDraft(ctx(), companyId, 'lead_pipeline', {
        statuses: [
          { pipeline: 'sales', code: 'A', label: 'A', rank: 1, isTerminal: true },
          { pipeline: 'sales', code: 'B', label: 'B', rank: 2, isTerminal: true },
          { pipeline: 'recruitment', code: 'C', label: 'C', rank: 1, isTerminal: true },
        ],
      });
      await expect(service.publish(ctx(), companyId, 'lead_pipeline'))
        .rejects.toThrow('exactly one stage that closes it');
    });
  });

  describe('how many offices are behind', () => {
    const office = (over: Record<string, unknown>) => ({
      companyId, code: String(Math.random()).slice(2, 6), branchName: 'B',
      timezone: 'Asia/Jakarta', locale: 'id-ID', currency: 'IDR', status: 'active', ...over,
    });
    /** An office's record for one kind, as provisioning writes it since P5-T12. */
    const seeded = (kinds: Record<string, number | null>) => ({
      seededFrom: Object.fromEntries(Object.entries(kinds).map(([kind, version]) => [
        kind, { templateId: version === null ? null : `tpl-${kind}-${version}`, version },
      ])),
    });
    const taxonomy = {
      categories: [{ code: 'A', label: 'A', displayOrder: 1 }],
      types: [{ code: 'B', categoryCode: 'A', label: 'B', description: null, displayOrder: 1 }],
    };
    const publishTimes = async (kind: 'activity_taxonomy' | 'lead_pipeline', times: number) => {
      for (let i = 0; i < times; i += 1) {
        const payload = kind === 'activity_taxonomy'
          ? taxonomy
          : platformDefaultPayload('lead_pipeline');
        await service.saveDraft(ctx(), companyId, kind, payload);
        await service.publish(ctx(), companyId, kind);
      }
    };

    it('counts an office built before anything was published', async () => {
      /*
       * Its record for the taxonomy has a null version: the company had published nothing
       * when it was created, so it runs a taxonomy the company never chose. That is exactly
       * the case a Super Admin wants to see.
       */
      await kpms.create(office(seeded({ activity_taxonomy: null })) as never);
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', {
        categories: [{ code: 'A', label: 'A', displayOrder: 1 }],
        types: [{ code: 'B', categoryCode: 'A', label: 'B', description: null, displayOrder: 1 }],
      });
      const published = await service.publish(ctx(), companyId, 'activity_taxonomy');
      expect(published.officesBehind).toBe(1);
    });

    it('does not count an office already on the current version', async () => {
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', {
        categories: [{ code: 'A', label: 'A', displayOrder: 1 }],
        types: [{ code: 'B', categoryCode: 'A', label: 'B', description: null, displayOrder: 1 }],
      });
      await service.publish(ctx(), companyId, 'activity_taxonomy');
      await kpms.create(office(seeded({ activity_taxonomy: 1 })) as never);

      const view = await service.read(companyId, 'activity_taxonomy');
      expect(view.officesBehind).toBe(0);
    });

    it('ignores another company’s offices', async () => {
      const other = await companies.create({
        name: 'Allianz', slug: 'allianz', defaultCurrency: 'IDR',
        defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active',
      } as never);
      await kpms.create({
        ...office(seeded({ activity_taxonomy: null })),
        companyId: String((other as unknown as { _id: unknown })._id),
      } as never);

      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', {
        categories: [{ code: 'A', label: 'A', displayOrder: 1 }],
        types: [{ code: 'B', categoryCode: 'A', label: 'B', description: null, displayOrder: 1 }],
      });
      const published = await service.publish(ctx(), companyId, 'activity_taxonomy');
      expect(published.officesBehind).toBe(0);
    });

    describe('per template kind (P5-T12)', () => {
      /*
       * `countBehind` took no kind and compared one `seededFromVersion` — written from the
       * activity taxonomy's seed alone — against whichever kind's version it was handed, while
       * template versions count separately per kind. Every tab but Activity types counted
       * against the wrong template.
       */
      it('AC-3: counts each tab against its own kind’s version', async () => {
        await publishTimes('activity_taxonomy', 3);
        await publishTimes('lead_pipeline', 1);
        await kpms.create(office(seeded({
          activity_taxonomy: 3, lead_pipeline: 1, ratio_set: null,
        })) as never);

        expect((await service.read(companyId, 'activity_taxonomy')).officesBehind).toBe(0);
        expect((await service.read(companyId, 'lead_pipeline')).officesBehind).toBe(0);

        await publishTimes('lead_pipeline', 1);

        // Behind on the one it is behind on, and still current on the other.
        expect((await service.read(companyId, 'lead_pipeline')).officesBehind).toBe(1);
        expect((await service.read(companyId, 'activity_taxonomy')).officesBehind).toBe(0);
      });

      it('AC-1: no longer reads a lead pipeline tab against the taxonomy’s version', async () => {
        /*
         * The case the old comparison got wrong in the loud direction: the office is on the
         * current lead pipeline (v3), but its *taxonomy* record is v1, and v1 < 3 — so it was
         * reported behind on a tab where it is not.
         */
        await publishTimes('activity_taxonomy', 1);
        await publishTimes('lead_pipeline', 3);
        await kpms.create(office(seeded({ activity_taxonomy: 1, lead_pipeline: 3 })) as never);

        expect((await service.read(companyId, 'lead_pipeline')).officesBehind).toBe(0);
      });

      it('AC-2: counts an office built from the platform defaults as behind', async () => {
        await publishTimes('lead_pipeline', 1);
        await kpms.create(office(seeded({ activity_taxonomy: null, lead_pipeline: null })) as never);

        const view = await service.read(companyId, 'lead_pipeline');
        expect(view).toMatchObject({ officesBehind: 1, officesUnrecorded: 0 });
      });

      it('AC-2: counts an office with no record for the kind apart, as unrecorded', async () => {
        /*
         * Created before provisioning recorded this kind. It may be entirely current, so it
         * is not "running something older" — folding it into that number would have told a
         * Super Admin every existing office was behind on this tab.
         */
        await publishTimes('lead_pipeline', 1);
        await kpms.create(office(seeded({ activity_taxonomy: 1 })) as never);

        const view = await service.read(companyId, 'lead_pipeline');
        expect(view).toMatchObject({ officesBehind: 0, officesUnrecorded: 1 });
      });

      it('reports nothing for a kind nothing has been published of', async () => {
        await kpms.create(office(seeded({ activity_taxonomy: 1 })) as never);

        expect(await service.read(companyId, 'lead_pipeline'))
          .toMatchObject({ officesBehind: 0, officesUnrecorded: 0 });
      });

      it('ignores a deleted office, on both counts', async () => {
        await publishTimes('lead_pipeline', 2);
        await kpms.create({ ...office(seeded({ lead_pipeline: 1 })), deletedAt: NOW } as never);
        await kpms.create({ ...office({}), deletedAt: NOW } as never);

        expect(await service.read(companyId, 'lead_pipeline'))
          .toMatchObject({ officesBehind: 0, officesUnrecorded: 0 });
      });
    });
  });

  describe('a ratio set is refused at publish, not at office creation (P4-T20)', () => {
    /*
     * `super-admin/08` promises the refusal happens here — the alternative is a Super
     * Admin discovering it midway through setting up a real branch. `ratio_set` had no
     * validation branch at all, so it was the one kind the promise did not cover.
     */
    const ratioSet = (codes: string[]) => ({
      ratios: [{
        code: 'REFERRAL_RATE', label: 'Referral rate',
        numerator: [codes[0]], denominator: [codes[1] ?? codes[0]],
        benchmark: 0.3, comparison: 'gte', displayOrder: 1,
      }],
    });

    it('refuses a code the published taxonomy does not declare, naming it', async () => {
      await service.saveDraft(ctx(), companyId, 'ratio_set', ratioSet(['NO_SUCH_CODE', 'SELL_SUBMISSION']));
      await expect(service.publish(ctx(), companyId, 'ratio_set'))
        .rejects.toThrow(/NO_SUCH_CODE is named by a ratio/);
    });

    it('accepts the three cascade codes with no taxonomy published — every office has them (ADR-0115 §2)', async () => {
      // There is no platform fallback any more; these three are given to every office whatever its
      // source, so a ratio over them builds a working office from any template.
      await service.saveDraft(ctx(), companyId, 'ratio_set', ratioSet(['SELL_SUBMISSION', 'SELL_PRESENTATION']));
      await expect(service.publish(ctx(), companyId, 'ratio_set')).resolves.toMatchObject({
        kind: 'ratio_set', status: 'published', version: 1,
      });
    });

    it('checks the published taxonomy, not the draft — provisioning reads the published one', async () => {
      /*
       * The trap. A taxonomy draft declaring a code makes the ratio look fine here and
       * still breaks the office, because `ProvisioningService` reads
       * `status: 'published'`. Getting this backwards reproduces the defect.
       */
      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', {
        categories: [{ code: 'REFERRALS', label: 'Referrals', displayOrder: 1 }],
        types: [{ code: 'REF_INTRO', categoryCode: 'REFERRALS', label: 'Intro', displayOrder: 1 }],
      });
      await service.saveDraft(ctx(), companyId, 'ratio_set', ratioSet(['REF_INTRO', 'REF_INTRO']));

      await expect(service.publish(ctx(), companyId, 'ratio_set'))
        .rejects.toThrow(/REF_INTRO is named by a ratio/);

      // Publish the taxonomy and the same ratio set goes through.
      await service.publish(ctx(), companyId, 'activity_taxonomy');
      await expect(service.publish(ctx(), companyId, 'ratio_set')).resolves.toMatchObject({
        status: 'published',
      });
    });

    it('refuses an empty denominator, which renders as ∞ on every agent’s screen', async () => {
      await service.saveDraft(ctx(), companyId, 'ratio_set', {
        ratios: [{
          code: 'BROKEN', label: 'Broken', numerator: ['SELL_SUBMISSION'], denominator: [],
          benchmark: 1, comparison: 'gte', displayOrder: 1,
        }],
      });
      await expect(service.publish(ctx(), companyId, 'ratio_set'))
        .rejects.toThrow(/BROKEN has nothing in its denominator/);
    });

    it('refuses a ratio shown in a unit its rule cannot have (P4-T25)', async () => {
      // Provisioning would otherwise throw it at a Super Admin creating a real branch.
      await service.saveDraft(ctx(), companyId, 'ratio_set', {
        ratios: [{
          code: 'LEAN', label: 'Lean', numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION'],
          benchmark: 30, comparison: 'band', displayUnit: 'percent', displayOrder: 1,
        }],
      });
      await expect(service.publish(ctx(), companyId, 'ratio_set'))
        .rejects.toThrow(/LEAN: A balance ratio is judged in percentage points/);
    });

    it('accepts a ratio set that says nothing about units — provisioning resolves one', async () => {
      await service.saveDraft(ctx(), companyId, 'ratio_set', ratioSet(['SELL_SUBMISSION', 'SELL_PRESENTATION']));
      await expect(service.publish(ctx(), companyId, 'ratio_set')).resolves.toMatchObject({
        status: 'published',
      });
    });

    it('starts a ratio set made from the defaults with the platform’s units', async () => {
      const made = await named.create(ctx(), companyId, { name: 'Defaults', from: 'defaults' });
      const draft = await service.read(companyId, 'ratio_set', made.id);
      const units = (draft.payload as { ratios: { code: string; displayUnit: string }[] }).ratios
        .map((r) => [r.code, r.displayUnit]);
      expect(Object.fromEntries(units)).toMatchObject({
        SELLING_SUCCESS_RATE: 'percent', SELLING_VS_RECRUITMENT: 'points', LEADS_PER_ACTIVITY: 'decimal',
      });
    });

    it('refuses a ratio set with no ratios at all', async () => {
      await service.saveDraft(ctx(), companyId, 'ratio_set', { ratios: [] });
      await expect(service.publish(ctx(), companyId, 'ratio_set'))
        .rejects.toThrow(/nothing to measure/);
    });
  });
  describe('the training taxonomy (P5-T1)', () => {
    it('holds the domain defaults in a template made from them', async () => {
      const made = await named.create(ctx(), companyId, { name: 'Defaults', from: 'defaults' });
      const view = await service.read(companyId, 'training_taxonomy', made.id);
      expect((view.payload.modules as unknown[])).toHaveLength(SEED_TRAINING_MODULES.length);
      expect((view.payload.categories as { code: string }[])[0].code).toBe('SALES');
    });

    it('publishes an empty taxonomy, and refuses one that would build a broken tree, naming what', async () => {
      await service.saveDraft(ctx(), companyId, 'training_taxonomy', { categories: [], skills: [], modules: [] });
      await expect(service.publish(ctx(), companyId, 'training_taxonomy'))
        .resolves.toMatchObject({ status: 'published', version: 1 });

      await service.saveDraft(ctx(), companyId, 'training_taxonomy', {
        categories: [{ code: 'SALES', label: 'Sales' }],
        skills: [{ code: 'CLOSING', categoryCode: 'SALES', label: 'Closing' }],
        modules: [{ code: 'ORPHAN', skillCode: 'MISSING', title: 'Orphan' }],
      });
      await expect(service.publish(ctx(), companyId, 'training_taxonomy'))
        .rejects.toThrow('The module ORPHAN names MISSING, which no skill in this taxonomy is.');
    });
  });

  describe('the activation checklist (P5-T3)', () => {
    it('holds the seed in a template made from the defaults: sixteen items in five aspects', async () => {
      const made = await named.create(ctx(), companyId, { name: 'Defaults', from: 'defaults' });
      const view = await service.read(companyId, 'activation_checklist', made.id);
      const aspects = view.payload.aspects as { code: string; items: unknown[] }[];

      expect(aspects).toHaveLength(5);
      expect(aspects.flatMap((a) => a.items)).toHaveLength(16);
      expect(aspects[0].code).toBe('INTRODUCTION');
    });

    it('refuses a checklist an office could not have saved, through the same checker', async () => {
      await service.saveDraft(ctx(), companyId, 'activation_checklist', { aspects: [] });
      await expect(service.publish(ctx(), companyId, 'activation_checklist'))
        .rejects.toThrow(/1–20 aspects/);

      await service.saveDraft(ctx(), companyId, 'activation_checklist', {
        aspects: [{
          code: 'INTRODUCTION',
          label: '1. Introduction',
          items: [
            { code: 'SAME_CODE', label: 'One' },
            { code: 'SAME_CODE', label: 'Two', autoLink: 'feature:nothing' },
          ],
        }],
      });
      await expect(service.publish(ctx(), companyId, 'activation_checklist'))
        .rejects.toThrow(/The item code SAME_CODE is used twice/);
    });

    /*
     * A template has no office whose modules it could name, so the code's shape is all that can be
     * checked here. Whether the office is given that module is provisioning's question (AC-5).
     */
    it('publishes a training link, leaving it for provisioning to resolve', async () => {
      await service.saveDraft(ctx(), companyId, 'activation_checklist', {
        aspects: [{
          code: 'TRAINING_AND_CERTIFICATION',
          label: '3. Training & Certification',
          items: [{ code: 'MANDATORY_TRAINING', label: 'Mandatory training', autoLink: 'training:PROSPECT_LIST' }],
        }],
      });

      await expect(service.publish(ctx(), companyId, 'activation_checklist'))
        .resolves.toMatchObject({ status: 'published', version: 1 });
    });
  });

  /**
   * **ADR-0185 §3–§4: Terbitkan semua, and the offices behind**, at the service: the permission refused before
   * anything is read, a company's own template only, and the offices counted the way `standing` counts them.
   */
  describe('Terbitkan semua and the offices behind (ADR-0185)', () => {
    it('refuses publishing every kind without company_template:write, before anything is read', async () => {
      await service.saveDraft(ctx(), companyId, 'event_types', platformDefaultPayload('event_types'), defaultId);
      for (const who of [OWNER, AGENT]) {
        await expect(service.publishAll(who, companyId, defaultId)).rejects.toMatchObject({ code: 'PERM_DENIED' });
      }
      const rows = mongoose.model(CompanyTemplate.name, CompanyTemplateSchema);
      expect(await rows.countDocuments({ templateId: defaultId, status: 'published' })).toBe(0);
    });

    it('S6 refuses the offices behind without company_template:read, before anything is read', async () => {
      // An Owner, an Agent, and an Owner's own office among them: the list is the platform's, never an office's.
      await kpms.create({
        companyId, code: '0417', branchName: 'BSD City', timezone: 'Asia/Jakarta', startedFrom: null,
        seededFrom: {},
      } as never);
      for (const who of [OWNER, AGENT]) {
        await expect(named.offices(who, companyId, defaultId)).rejects.toMatchObject({
          code: 'PERM_DENIED', details: { permission: 'company_template:read' },
        });
      }
      // A company that does not exist is refused the same, by permission, not by a 404 that would say it does not.
      await expect(named.offices(OWNER, String(new mongoose.Types.ObjectId()), defaultId))
        .rejects.toMatchObject({ code: 'PERM_DENIED' });
      await expect(named.offices(ctx(), companyId, defaultId)).resolves.toHaveLength(1);
    });

    it('publishes only the company’s own template — another company’s is not found', async () => {
      const other = await companies.create({
        name: 'Allianz', slug: 'allianz', defaultCurrency: 'IDR', defaultLocale: 'id-ID',
        defaultTimezone: 'Asia/Jakarta', status: 'active',
      } as never);
      const theirs = await defaultTemplateFor(String((other as unknown as { _id: unknown })._id));
      await expect(service.publishAll(ctx(), companyId, theirs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(named.offices(ctx(), companyId, theirs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('counts the offices created before templates were named against the migration’s template', async () => {
      await service.saveDraft(ctx(), companyId, 'event_types', platformDefaultPayload('event_types'), defaultId);
      await service.publishAll(ctx(), companyId, defaultId);
      await kpms.create({
        companyId, code: '0417', branchName: 'BSD City', timezone: 'Asia/Jakarta', startedFrom: null,
        seededFrom: { event_types: { templateId: null, version: null } },
      } as never);
      const offices = await named.offices(ctx(), companyId, defaultId);
      expect(offices).toEqual([
        expect.objectContaining({ code: '0417', behind: ['event_types'], unrecorded: [] }),
      ]);
    });

    it('stands an office against a version the way the counts do (P5-T12)', () => {
      expect(standingOf(undefined, 2)).toBe('unrecorded');
      expect(standingOf({ version: null }, 1)).toBe('behind');
      expect(standingOf({ version: 1 }, 2)).toBe('behind');
      expect(standingOf({ version: 2 }, 2)).toBe('current');
      expect(standingOf({ version: 3 }, 2)).toBe('current');
    });
  });
});
