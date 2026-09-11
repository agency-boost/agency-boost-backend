import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { RATIO_BENCHMARKS, SEED_ACTIVITY_TYPES } from '@/domain/constants';
import { ActivityConfigService } from './activity.service';
import { RatioService } from './ratio.service';
import { ProvisioningService } from './provisioning.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

function ctx(kpmId: string) {
  return new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });
}

describe('the office ratio definitions (P4-T2)', () => {
  let ratios: RatioService;
  let activity: ActivityConfigService;
  let provisioning: ProvisioningService;
  let templates: mongoose.Model<never>;

  async function provision(kpmId: string, companyId = COMPANY) {
    const seeded = await provisioning.seedActivityTaxonomy(kpmId, companyId);
    return provisioning.seedRatioDefinitions(kpmId, companyId, seeded.typeCodes);
  }

  beforeAll(async () => {
    await startMongo();
    const wired = configModule(NOW);
    ratios = wired.ratios;
    activity = wired.activity;
    provisioning = wired.provisioning;
    templates = wired.templates as never;
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  describe('the seeded five (AC-1, AC-2, AC-3)', () => {
    beforeEach(() => provision(KPM_A));

    it('binds every formula to activity codes, not to the prototype’s numbers', async () => {
      /*
       * `Overall.html` writes these as `6 / (4+5)` and the same prototype lets an Owner
       * reorder those items. Dragging a row would have rebound every formula in the
       * office — invariant §4 exists because of exactly this.
       */
      const list = await ratios.list(ctx(KPM_A));
      const byCode = new Map(list.map((r) => [r.code, r]));
      expect(byCode.get('SELLING_SUCCESS_RATE')).toMatchObject({
        numerator: ['SELL_SUBMISSION'],
        denominator: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'],
      });
      expect(byCode.get('LEADS_PER_ACTIVITY')).toMatchObject({
        numerator: ['LEADS_NEW_PROSPECT'], denominator: ['LEADS_GEN_ACTIVITY'],
      });
    });

    it('copies the benchmarks the constants module pins (AC-2)', async () => {
      const list = await ratios.list(ctx(KPM_A));
      const byCode = new Map(list.map((r) => [r.code, r]));
      expect(byCode.get('SELLING_SUCCESS_RATE')!.benchmark)
        .toBe(RATIO_BENCHMARKS.SELLING_SUCCESS_RATE);
      expect(byCode.get('MEETING_PER_APPROACH')!.benchmark)
        .toBe(RATIO_BENCHMARKS.MEETING_PER_APPROACH);
      expect(byCode.get('SELLING_VS_RECRUITMENT')!.benchmark)
        .toBe(RATIO_BENCHMARKS.BALANCE_BAND_PP);
    });

    it('makes the balance ratio a band and the other four gte (AC-3)', async () => {
      const list = await ratios.list(ctx(KPM_A));
      expect(list.filter((r) => r.comparison === 'band').map((r) => r.code))
        .toEqual(['SELLING_VS_RECRUITMENT']);
      expect(list.filter((r) => r.comparison === 'gte')).toHaveLength(4);
    });

    it('names only codes the office actually has', async () => {
      const available = new Set(SEED_ACTIVITY_TYPES.map((t) => t.code));
      for (const ratio of await ratios.list(ctx(KPM_A))) {
        for (const code of [...ratio.numerator, ...ratio.denominator]) {
          expect(available.has(code)).toBe(true);
        }
      }
    });
  });

  describe('binding a formula (AC-4)', () => {
    beforeEach(() => provision(KPM_A));

    it('refuses an unknown code and names it', async () => {
      // "Invalid formula" would send an Owner to compare two lists by eye.
      await expect(ratios.create(ctx(KPM_A), {
        code: 'MADE_UP', label: 'Made up', numerator: ['NOT_A_THING'],
        denominator: ['SELL_SUBMISSION'], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('names NOT_A_THING');
    });

    it('refuses a code that is archived, which is a code with history and no future', async () => {
      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)
        .find((t) => t.code === 'SELL_FOLLOWUP')!;
      await activity.archiveType(ctx(KPM_A), type.id);

      await expect(ratios.create(ctx(KPM_A), {
        code: 'USES_ARCHIVED', label: 'x', numerator: ['SELL_FOLLOWUP'],
        denominator: ['SELL_SUBMISSION'], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('SELL_FOLLOWUP');
    });

    it('leaves an existing ratio alone when a type it names is archived', async () => {
      /*
       * Archiving a type does not break the ratios that already name it: the type still
       * has history, and the ratio still has to compute over the window covering it.
       * What is refused is binding something *new* to it.
       */
      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)
        .find((t) => t.code === 'SELL_FOLLOWUP')!;
      await activity.archiveType(ctx(KPM_A), type.id);

      const list = await ratios.list(ctx(KPM_A));
      expect(list.find((r) => r.code === 'SELLING_SUCCESS_RATE')!.denominator)
        .toContain('SELL_FOLLOWUP');
    });

    it('refuses an empty denominator, which is a division by zero dressed as config', async () => {
      await expect(ratios.create(ctx(KPM_A), {
        code: 'NO_BOTTOM', label: 'x', numerator: ['SELL_SUBMISSION'],
        denominator: [], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('at least one activity type in its denominator');
    });

    it('refuses the same type twice on one side, which silently doubles its weight', async () => {
      await expect(ratios.create(ctx(KPM_A), {
        code: 'DOUBLED', label: 'x',
        numerator: ['SELL_SUBMISSION', 'SELL_SUBMISSION'],
        denominator: ['SELL_PRESENTATION'], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('appears twice in the numerator');
    });

    it('rebinds a formula rather than leaving it pointing at nothing', async () => {
      const ratio = (await ratios.list(ctx(KPM_A)))
        .find((r) => r.code === 'LEADS_PER_ACTIVITY')!;
      const updated = await ratios.update(ctx(KPM_A), ratio.id, {
        denominator: ['LEADS_CONTACTED'],
      });
      expect(updated.denominator).toEqual(['LEADS_CONTACTED']);
      expect(updated.code).toBe('LEADS_PER_ACTIVITY');
      expect(updated.version).toBe(2);
    });

    it('changes a benchmark without touching the formula', async () => {
      const ratio = (await ratios.list(ctx(KPM_A)))
        .find((r) => r.code === 'SELLING_SUCCESS_RATE')!;
      const updated = await ratios.update(ctx(KPM_A), ratio.id, { benchmark: 0.25 });
      expect(updated.benchmark).toBe(0.25);
      expect(updated.numerator).toEqual(ratio.numerator);
    });
  });

  describe('provisioning and isolation', () => {
    it('refuses a ratio template that disagrees with the taxonomy template', async () => {
      // Two templates that disagree produce a ratio reading 0.0% on every agent's screen,
      // which looks like an agent problem rather than a template one.
      await templates.create({
        companyId: COMPANY, kind: 'ratio_set', version: 1, status: 'published',
        publishedAt: NOW,
        payload: {
          ratios: [{
            code: 'BROKEN', label: 'Broken', numerator: ['NOT_IN_TAXONOMY'],
            denominator: ['SELL_SUBMISSION'], benchmark: 1, comparison: 'gte', displayOrder: 1,
          }],
        },
      } as never);

      await expect(provision(KPM_A)).rejects.toThrow(/NOT_IN_TAXONOMY/);
    });

    it('keeps two offices’ benchmarks apart', async () => {
      await provision(KPM_A);
      await provision(KPM_B);
      const mine = (await ratios.list(ctx(KPM_A)))
        .find((r) => r.code === 'SELLING_SUCCESS_RATE')!;
      await ratios.update(ctx(KPM_A), mine.id, { benchmark: 0.5 });

      const theirs = (await ratios.list(ctx(KPM_B)))
        .find((r) => r.code === 'SELLING_SUCCESS_RATE')!;
      expect(theirs.benchmark).toBe(RATIO_BENCHMARKS.SELLING_SUCCESS_RATE);
    });

    it('cannot change another office’s ratio — 404, never 403', async () => {
      await provision(KPM_A);
      await provision(KPM_B);
      const theirs = (await ratios.list(ctx(KPM_B)))[0];
      await expect(ratios.update(ctx(KPM_A), theirs.id, { benchmark: 9 }))
        .rejects.toThrow('Ratio');
    });

    it('validates a formula against the caller’s own taxonomy, not another office’s', async () => {
      await provision(KPM_A);
      await provision(KPM_B);
      // B archives a type; A must still be able to bind to its own copy of that code.
      const theirs = (await activity.list(ctx(KPM_B))).flatMap((c) => c.types)
        .find((t) => t.code === 'SELL_FOLLOWUP')!;
      await activity.archiveType(ctx(KPM_B), theirs.id);

      await expect(ratios.create(ctx(KPM_A), {
        code: 'MINE', label: 'Mine', numerator: ['SELL_FOLLOWUP'],
        denominator: ['SELL_SUBMISSION'], benchmark: 1, comparison: 'gte',
      })).resolves.toMatchObject({ code: 'MINE' });
    });
  });
  describe('the rest of the writes (P4-T12)', () => {
    beforeEach(() => provision(KPM_A));

    it('appends a new ratio and normalises its code', async () => {
      const created = await ratios.create(ctx(KPM_A), {
        code: 'referral_rate', label: 'Referral rate',
        numerator: ['sell_submission'], denominator: ['leads_contacted'],
        benchmark: 0.2, comparison: 'gte',
      });
      expect(created.code).toBe('REFERRAL_RATE');
      // The formula's codes are normalised too, so a lower-case paste binds correctly.
      expect(created.numerator).toEqual(['SELL_SUBMISSION']);
      expect(created.displayOrder).toBe(6);
    });

    it('refuses a duplicate ratio code', async () => {
      await expect(ratios.create(ctx(KPM_A), {
        code: 'SELLING_SUCCESS_RATE', label: 'Again', numerator: ['SELL_SUBMISSION'],
        denominator: ['SELL_PRESENTATION'], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('already has a ratio called SELLING_SUCCESS_RATE');
    });

    it('refuses a ratio code that is not a code', async () => {
      await expect(ratios.create(ctx(KPM_A), {
        code: 'has spaces', label: 'x', numerator: ['SELL_SUBMISSION'],
        denominator: ['SELL_PRESENTATION'], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('3–40 characters');
    });

    it('refuses an empty numerator, for the same reason as an empty denominator', async () => {
      await expect(ratios.create(ctx(KPM_A), {
        code: 'NO_TOP', label: 'x', numerator: [],
        denominator: ['SELL_PRESENTATION'], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('at least one activity type in its numerator');
    });

    it('refuses the same type twice on the denominator too', async () => {
      await expect(ratios.create(ctx(KPM_A), {
        code: 'DOUBLED_BOTTOM', label: 'x', numerator: ['SELL_SUBMISSION'],
        denominator: ['SELL_PRESENTATION', 'SELL_PRESENTATION'], benchmark: 1, comparison: 'gte',
      })).rejects.toThrow('appears twice in the denominator');
    });

    it('renames a ratio and changes its comparison without touching the formula', async () => {
      const ratio = (await ratios.list(ctx(KPM_A)))
        .find((r) => r.code === 'LEADS_PER_ACTIVITY')!;
      const updated = await ratios.update(ctx(KPM_A), ratio.id, {
        label: '  Prospek per aktivitas  ', comparison: 'band',
      });
      expect(updated.label).toBe('Prospek per aktivitas');
      expect(updated.comparison).toBe('band');
      expect(updated.numerator).toEqual(ratio.numerator);
    });

    it('refuses an update that changes nothing', async () => {
      const ratio = (await ratios.list(ctx(KPM_A)))[0];
      await expect(ratios.update(ctx(KPM_A), ratio.id, {})).rejects.toThrow('Nothing to change');
    });

    it('archives a ratio and brings it back', async () => {
      const ratio = (await ratios.list(ctx(KPM_A)))[0];
      const archived = await ratios.archive(ctx(KPM_A), ratio.id);
      expect(archived.status).toBe('archived');
      expect((await ratios.list(ctx(KPM_A))).map((r) => r.code)).not.toContain(ratio.code);
      expect((await ratios.list(ctx(KPM_A), true)).map((r) => r.code)).toContain(ratio.code);

      const restored = await ratios.restore(ctx(KPM_A), ratio.id);
      expect(restored.status).toBe('active');
    });

    it('refuses to archive or restore another office’s ratio', async () => {
      await provision(KPM_B);
      const theirs = (await ratios.list(ctx(KPM_B)))[0];
      await expect(ratios.archive(ctx(KPM_A), theirs.id)).rejects.toThrow('Ratio');
      await expect(ratios.restore(ctx(KPM_A), theirs.id)).rejects.toThrow('Ratio');
    });
  });

});
