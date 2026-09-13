import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { SEED_ACTIVITY_TYPES } from '@/domain/constants';
import { CompanyTemplate, CompanyTemplateSchema } from './company-template.schema';
import { TemplateService } from './template.service';
import { KpmOfficeCounter } from './office-counter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const NOW = new Date('2026-09-11T02:00:00Z');

function ctx() {
  return new RequestContext('u-root', 'super_admin', null);
}

describe('a company’s KPM template (P4-T8, ADR-0018)', () => {
  let service: TemplateService;
  let companies: mongoose.Model<never>;
  let kpms: mongoose.Model<never>;
  let companyId: string;

  beforeAll(async () => {
    await startMongo();
    companies = mongoose.model(Company.name, CompanySchema) as never;
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
    service = new TemplateService(
      mongoose.model(CompanyTemplate.name, CompanyTemplateSchema) as never,
      companies as never,
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      new FixedClock(NOW),
      new KpmOfficeCounter(kpms as never),
    );
  });

  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const company = await companies.create({
      name: 'Prudential', slug: 'prudential', defaultCurrency: 'IDR',
      defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active',
    } as never);
    companyId = String((company as unknown as { _id: unknown })._id);
  });

  describe('what a Super Admin opens', () => {
    it('hands back a starting point rather than an empty box', async () => {
      /*
       * A company with nothing published is the normal state of a new insurer. An empty
       * answer would mean the first thing a Super Admin does is retype twelve activity
       * types out of a PDF.
       */
      const view = await service.read(companyId, 'activity_taxonomy');
      expect(view.status).toBe('draft');
      expect(view.version).toBe(0);
      expect((view.payload.types as unknown[])).toHaveLength(SEED_ACTIVITY_TYPES.length);
      expect(view.publishedVersion).toBeNull();
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

    it('counts an office built before anything was published', async () => {
      /*
       * Its `seededFromVersion` is null: the company had published nothing when it was
       * created, so it runs a taxonomy the company never chose. That is exactly the case
       * a Super Admin wants to see.
       */
      await kpms.create(office({ seededFromVersion: null }) as never);
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
      await kpms.create(office({ seededFromVersion: 1 }) as never);

      const view = await service.read(companyId, 'activity_taxonomy');
      expect(view.officesBehind).toBe(0);
    });

    it('ignores another company’s offices', async () => {
      const other = await companies.create({
        name: 'Allianz', slug: 'allianz', defaultCurrency: 'IDR',
        defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active',
      } as never);
      await kpms.create({
        ...office({ seededFromVersion: null }),
        companyId: String((other as unknown as { _id: unknown })._id),
      } as never);

      await service.saveDraft(ctx(), companyId, 'activity_taxonomy', {
        categories: [{ code: 'A', label: 'A', displayOrder: 1 }],
        types: [{ code: 'B', categoryCode: 'A', label: 'B', description: null, displayOrder: 1 }],
      });
      const published = await service.publish(ctx(), companyId, 'activity_taxonomy');
      expect(published.officesBehind).toBe(0);
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

    it('accepts codes the platform defaults declare, when the company has published none', async () => {
      // The fallback provisioning itself uses. Refusing here would make the first ratio
      // set of every new company unpublishable.
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

    it('refuses a ratio set with no ratios at all', async () => {
      await service.saveDraft(ctx(), companyId, 'ratio_set', { ratios: [] });
      await expect(service.publish(ctx(), companyId, 'ratio_set'))
        .rejects.toThrow(/nothing to measure/);
    });
  });
});
