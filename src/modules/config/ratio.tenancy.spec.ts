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
  let wired: ReturnType<typeof configModule>;

  async function provision(kpmId: string, companyId = COMPANY) {
    const seeded = await provisioning.seedActivityTaxonomy(kpmId, companyId);
    return provisioning.seedRatioDefinitions(kpmId, companyId, seeded.typeCodes);
  }

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
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
      /*
       * This rebound `LEADS_PER_ACTIVITY` until P4-T15. ADR-0021 made the seeded five
       * platform-standard, so their formulas are no longer a tenant's to change and that
       * refusal is asserted in this file's P4-T15 section.
       *
       * The rule *this* test exists for — a formula follows the taxonomy rather than
       * rotting against it — is unchanged and still worth pinning, so it moves to the
       * ratios an office owns, where rebinding remains free.
       */
      const mine = await ratios.create(ctx(KPM_A), {
        code: 'OWN_RATE', label: 'Our own rate',
        numerator: ['LEADS_NEW_PROSPECT'], denominator: ['LEADS_GEN_ACTIVITY'],
        benchmark: 1, comparison: 'gte',
      });
      const updated = await ratios.update(ctx(KPM_A), mine.id, {
        denominator: ['LEADS_CONTACTED'],
      });
      expect(updated.denominator).toEqual(['LEADS_CONTACTED']);
      expect(updated.code).toBe('OWN_RATE');
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
      // A band is judged in points, so the unit follows without being asked (P4-T25).
      expect(updated.displayUnit).toBe('points');
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


  /**
   * P4-T15 — ADR-0020 and ADR-0021.
   *
   * Both add a field, and the two interact: applicability is editable on a platform ratio
   * while its formula is not, so the tests that matter are the ones that cross.
   */
  describe('how a benchmark is written (P4-T25)', () => {
    /*
     * The screens printed the stored value, so an Owner read `0.15` where the registry and
     * the prototype both say `15.0%`. The unit cannot be worked out from the number — `0.30`
     * is a percentage on one ratio and a plain number on another — so it is stored, and it
     * always agrees with the rule.
     */
    beforeEach(() => provision(KPM_A));

    const create = (over: Record<string, unknown>) => ratios.create(ctx(KPM_A), {
      code: 'REFERRAL_RATE', label: 'Referral rate',
      numerator: ['SELL_SUBMISSION'], denominator: ['LEADS_CONTACTED'],
      benchmark: 0.2, comparison: 'gte', ...over,
    } as never);

    it('provisions each of the five in the unit the registry states', async () => {
      const byCode = Object.fromEntries(
        (await ratios.list(ctx(KPM_A))).map((r) => [r.code, r.displayUnit]),
      );
      expect(byCode).toEqual({
        SELLING_VS_RECRUITMENT: 'points',
        SELLING_SUCCESS_RATE: 'percent',
        RECRUITMENT_SUCCESS_RATE: 'percent',
        LEADS_PER_ACTIVITY: 'decimal',
        MEETING_PER_APPROACH: 'decimal',
      });
    });

    it('starts an office’s own ratio as decimal, which writes the stored value unchanged', async () => {
      expect((await create({})).displayUnit).toBe('decimal');
    });

    it('takes the unit an Owner chooses', async () => {
      expect((await create({ displayUnit: 'percent' })).displayUnit).toBe('percent');
    });

    it('makes a band ratio points without being asked', async () => {
      expect((await create({ comparison: 'band', benchmark: 20 })).displayUnit).toBe('points');
    });

    it('refuses points on an at-or-above ratio, naming it, and writes nothing', async () => {
      await expect(create({ displayUnit: 'points' }))
        .rejects.toMatchObject({ code: 'CONFIG_RATIO_UNIT_MISMATCH' });
      expect((await ratios.list(ctx(KPM_A))).map((r) => r.code)).not.toContain('REFERRAL_RATE');
    });

    it('refuses a percentage on a band ratio rather than quietly saving points', async () => {
      // Correcting it silently would save something other than what the Owner chose, and
      // they would find out by reading the card.
      await expect(create({ comparison: 'band', displayUnit: 'percent' }))
        .rejects.toThrow(/REFERRAL_RATE: A balance ratio is judged in percentage points/);
    });

    it('lets an office change how a platform ratio is written — presentation, not formula', async () => {
      const leads = (await ratios.list(ctx(KPM_A))).find((r) => r.code === 'LEADS_PER_ACTIVITY')!;
      const updated = await ratios.update(ctx(KPM_A), leads.id, { displayUnit: 'percent' });
      expect(updated.displayUnit).toBe('percent');
      expect(updated.benchmark).toBe(leads.benchmark);
    });

    it('keeps a percentage when only the benchmark moves', async () => {
      const selling = (await ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_SUCCESS_RATE')!;
      expect((await ratios.update(ctx(KPM_A), selling.id, { benchmark: 0.2 })).displayUnit)
        .toBe('percent');
    });

    it('drops points when a band stops being one', async () => {
      const balance = (await ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_VS_RECRUITMENT')!;
      expect((await ratios.update(ctx(KPM_A), balance.id, { comparison: 'gte' })).displayUnit)
        .toBe('decimal');
    });

    it('provisions from a template published before units existed', async () => {
      // A published version is immutable, so it was never rewritten. The platform's unit
      // for a code it seeded stands in, and the rule's default for anything else.
      await clearCollections();
      await templates.create({
        companyId: COMPANY, kind: 'ratio_set', version: 1, status: 'published', publishedAt: NOW,
        payload: {
          ratios: [
            {
              code: 'SELLING_SUCCESS_RATE', label: 'Selling success rate',
              numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION'],
              benchmark: 0.15, comparison: 'gte', displayOrder: 1,
            },
            {
              code: 'REFERRAL_RATE', label: 'Referral rate',
              numerator: ['SELL_SUBMISSION'], denominator: ['LEADS_CONTACTED'],
              benchmark: 0.3, comparison: 'gte', displayOrder: 2,
            },
          ],
        },
      } as never);
      await provision(KPM_B);

      const byCode = Object.fromEntries(
        (await ratios.list(ctx(KPM_B))).map((r) => [r.code, r.displayUnit]),
      );
      expect(byCode).toEqual({ SELLING_SUCCESS_RATE: 'percent', REFERRAL_RATE: 'decimal' });
    });
  });

  describe('who a ratio is for, and who owns its formula (P4-T15)', () => {
    /** The company ladder an office's applicability is checked against (ADR-0012). */
    /** The harness returns its models untyped, so the cast is at the use site as elsewhere. */
    const companies = () => wired.companies as mongoose.Model<never>;
    const kpms = () => wired.kpms as mongoose.Model<never>;

    async function publishLadder(companyId = COMPANY, codes = ['AGENT', 'AAB', 'AB']) {
      await companies().create({ _id: companyId, name: 'Prudential', slug: `p-${companyId}` } as never);
      const sa = RequestContext.platform('root');
      for (const [i, code] of codes.entries()) {
        await wired.orgLevels.create(sa, {
          companyId, code, label: code, displayOrder: i + 1,
        });
      }
      await kpms().create({
        _id: KPM_A, companyId, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
      } as never);
    }

    beforeEach(async () => {
      await publishLadder();
      await provision(KPM_A);
    });

    describe('AC-2: everything provisioning writes is the platform’s', () => {
      it('marks the seeded five `platform`, and an Owner’s own `office`', async () => {
        const seeded = await ratios.list(ctx(KPM_A));
        expect(seeded.every((r) => r.origin === 'platform')).toBe(true);

        const mine = await ratios.create(ctx(KPM_A), {
          code: 'REFERRAL_RATE', label: 'Referral rate',
          numerator: ['LEADS_NEW_PROSPECT'], denominator: ['LEADS_CONTACTED'],
          benchmark: 0.2, comparison: 'gte',
        });
        expect(mine.origin).toBe('office');
      });
    });

    describe('AC-3: the formula is the office’s, and a divergence is flagged (ADR-0024)', () => {
      const platform = async () =>
        (await ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_SUCCESS_RATE')!;

      /*
       * This was a refusal until ADR-0024, on the reasoning that a fixed formula is what
       * makes two offices' figures comparable. The comparison that argument protects reads
       * the *seeded* formula, which the row records — not the row's current one. What an
       * Owner writes here is what their own people are measured by.
       */
      it('accepts a formula change on a provisioned ratio, and says it has diverged', async () => {
        const row = await platform();
        expect(row.divergesFromStandard).toBe(false);

        const updated = await ratios.update(ctx(KPM_A), row.id, {
          denominator: ['SELL_PRESENTATION'],
        });

        expect(updated.denominator).toEqual(['SELL_PRESENTATION']);
        expect(updated.divergesFromStandard).toBe(true);
      });

      it('keeps the seeded formula, so an Owner can see what they moved away from', async () => {
        const row = await platform();
        const updated = await ratios.update(ctx(KPM_A), row.id, { numerator: ['SELL_PRESENTATION'] });

        expect(updated.standardNumerator).toEqual(['SELL_SUBMISSION']);
        expect(updated.standardDenominator).toEqual(['SELL_PRESENTATION', 'SELL_FOLLOWUP']);
      });

      it('stops saying so when the formula is put back', async () => {
        const row = await platform();
        await ratios.update(ctx(KPM_A), row.id, { numerator: ['SELL_PRESENTATION'] });
        const back = await ratios.update(ctx(KPM_A), row.id, { numerator: ['SELL_SUBMISSION'] });

        expect(back.divergesFromStandard).toBe(false);
      });

      it('does not call a reordered formula a divergence — order is display, not meaning', async () => {
        const row = await platform();
        const updated = await ratios.update(ctx(KPM_A), row.id, {
          denominator: ['SELL_FOLLOWUP', 'SELL_PRESENTATION'],
        });

        expect(updated.divergesFromStandard).toBe(false);
      });

      it('flags nothing on a ratio the office created — it never had a standard', async () => {
        // Not the same as agreeing with one, and the card must not imply that it is.
        const mine = await ratios.create(ctx(KPM_A), {
          code: 'REFERRAL_RATE', label: 'Referral rate',
          numerator: ['LEADS_NEW_PROSPECT'], denominator: ['LEADS_CONTACTED'],
          benchmark: 0.2, comparison: 'gte',
        });
        const updated = await ratios.update(ctx(KPM_A), mine.id, { numerator: ['SELL_SUBMISSION'] });

        expect(updated).toMatchObject({
          divergesFromStandard: false, standardNumerator: null, standardDenominator: null,
        });
      });

      it('accepts the benchmark, the label and the applicability on the same row', async () => {
        const row = await platform();
        const updated = await ratios.update(ctx(KPM_A), row.id, {
          benchmark: 0.42, label: 'Closing rate', appliesToOrgLevelCodes: ['AGENT'],
        });
        expect(updated).toMatchObject({
          benchmark: 0.42, label: 'Closing rate', appliesToOrgLevelCodes: ['AGENT'],
          // The identity never moves, whatever the label says (invariant §4).
          code: 'SELLING_SUCCESS_RATE',
        });
      });

      it('lets an office change its own ratio’s formula', async () => {
        const mine = await ratios.create(ctx(KPM_A), {
          code: 'REFERRAL_RATE', label: 'Referral rate',
          numerator: ['LEADS_NEW_PROSPECT'], denominator: ['LEADS_CONTACTED'],
          benchmark: 0.2, comparison: 'gte',
        });
        const updated = await ratios.update(ctx(KPM_A), mine.id, {
          numerator: ['SELL_SUBMISSION'],
        });
        expect(updated.numerator).toEqual(['SELL_SUBMISSION']);
      });

      it('404s another office’s ratio, whatever it is asked to change', async () => {
        // A write must not become a way to learn that a ratio exists elsewhere.
        await kpms().create({
          _id: KPM_B, companyId: COMPANY, code: '0418', branchName: 'B', timezone: 'Asia/Jakarta',
        } as never);
        await provision(KPM_B);
        const theirs = (await ratios.list(ctx(KPM_B)))[0];
        await expect(ratios.update(ctx(KPM_A), theirs.id, { numerator: ['SELL_SUBMISSION'] }))
          .rejects.toThrow('Ratio');
      });
    });

    describe('AC-1: applicability binds to the company’s ladder', () => {
      it('seeds the two recruitment ratios to the rungs that recruit (AC-4)', async () => {
        const byCode = new Map((await ratios.list(ctx(KPM_A))).map((r) => [r.code, r]));
        expect(byCode.get('SELLING_VS_RECRUITMENT')!.appliesToOrgLevelCodes).toEqual(['AB', 'AAB']);
        expect(byCode.get('RECRUITMENT_SUCCESS_RATE')!.appliesToOrgLevelCodes).toEqual(['AB', 'AAB']);
      });

      it('leaves every other ratio applying to every rung', async () => {
        const byCode = new Map((await ratios.list(ctx(KPM_A))).map((r) => [r.code, r]));
        // Empty is the common case and means "everyone" — an office that never opens the
        // control never has to understand it.
        expect(byCode.get('SELLING_SUCCESS_RATE')!.appliesToOrgLevelCodes).toEqual([]);
      });

      it('refuses a rung the company does not have, naming it', async () => {
        const row = (await ratios.list(ctx(KPM_A)))[0];
        await expect(ratios.update(ctx(KPM_A), row.id, { appliesToOrgLevelCodes: ['DIRECTOR'] }))
          .rejects.toThrow(/DIRECTOR is not an active rung/);
      });

      it('refuses a rung the company has archived', async () => {
        /*
         * The sharp one: an archived rung is still readable, so a naive "does it exist"
         * check passes and the ratio silently applies to nobody.
         */
        const sa = RequestContext.platform('root');
        const ladder = await wired.orgLevels.list(sa, COMPANY);
        const aab = ladder.find((l) => l.code === 'AAB')!;
        await wired.orgLevels.update(sa, aab.orgLevelId, { status: 'archived' });

        const row = (await ratios.list(ctx(KPM_A)))[0];
        await expect(ratios.update(ctx(KPM_A), row.id, { appliesToOrgLevelCodes: ['AAB'] }))
          .rejects.toThrow(/AAB is not an active rung/);
      });

      it('normalises case and drops a repeat', async () => {
        const row = (await ratios.list(ctx(KPM_A)))[0];
        const updated = await ratios.update(ctx(KPM_A), row.id, {
          appliesToOrgLevelCodes: ['ab', 'AB', 'aab'],
        });
        expect(updated.appliesToOrgLevelCodes).toEqual(['AB', 'AAB']);
      });

      it('accepts an empty list without reading the ladder at all', async () => {
        const row = (await ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_VS_RECRUITMENT')!;
        const updated = await ratios.update(ctx(KPM_A), row.id, { appliesToOrgLevelCodes: [] });
        expect(updated.appliesToOrgLevelCodes).toEqual([]);
      });
    });
  });
});
