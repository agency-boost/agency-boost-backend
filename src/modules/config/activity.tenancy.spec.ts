import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SEED_ACTIVITY_TYPES } from '@/domain/constants';
import { ActivityConfigService } from './activity.service';
import { ProvisioningService } from './provisioning.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

function ctx(kpmId: string | null, opts: { owner?: boolean } = {}) {
  return new RequestContext('u1', kpmId ? 'none' : 'super_admin', kpmId ? {
    membershipId: `mem-${kpmId}`,
    kpmId,
    orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active',
    isKpmOwner: opts.owner ?? true,
    isKpmAdmin: false,
    directCount: 0,
  } : null);
}

describe('the office activity taxonomy (P4-T1)', () => {
  let service: ActivityConfigService;
  let provisioning: ProvisioningService;
  let templates: mongoose.Model<never>;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    service = wired.activity;
    provisioning = wired.provisioning;
    templates = wired.templates as never;
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  describe('provisioning (AC-4, AC-5)', () => {
    it('seeds the platform defaults when the company has published nothing', async () => {
      /*
       * AC-5, and it is not a convenience. Refusing here would make the first office of
       * every new insurer unreachable — gated behind somebody remembering to publish a
       * preset before the office can exist at all.
       */
      const result = await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);

      // A record whose version is null: nothing published, so the platform defaults (P5-T12).
      expect(result.seededFrom).toEqual({ templateId: null, version: null });
      expect(result.types).toBe(SEED_ACTIVITY_TYPES.length);
      const taxonomy = await service.list(ctx(KPM_A));
      expect(taxonomy.map((c) => c.code)).toEqual([
        'LEADS_GENERATION', 'SELLING', 'RECRUITMENT',
        'PERSONAL_DEVELOPMENT', 'TEAM_DEVELOPMENT',
      ]);
      expect(taxonomy.flatMap((c) => c.types)).toHaveLength(12);
    });

    it('uses the company\'s own published template when there is one (AC-4)', async () => {
      await templates.create({
        companyId: COMPANY,
        kind: 'activity_taxonomy',
        version: 3,
        status: 'published',
        publishedAt: NOW,
        payload: {
          categories: [{ code: 'ONLY', label: 'Only', displayOrder: 1 }],
          types: [{
            code: 'ONLY_THING', categoryCode: 'ONLY', label: 'The only thing',
            description: null, displayOrder: 1,
          }],
        },
      } as never);

      const result = await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);

      expect(result.seededFrom.version).toBe(3);
      const taxonomy = await service.list(ctx(KPM_A));
      expect(taxonomy).toHaveLength(1);
      expect(taxonomy[0].types.map((t) => t.code)).toEqual(['ONLY_THING']);
    });

    it('takes the newest published version, not the newest row', async () => {
      const common = { companyId: COMPANY, kind: 'activity_taxonomy', publishedAt: NOW };
      await templates.create({
        ...common, version: 1, status: 'published',
        payload: { categories: [{ code: 'OLD', label: 'Old', displayOrder: 1 }], types: [] },
      } as never);
      await templates.create({
        ...common, version: 2, status: 'published',
        payload: { categories: [{ code: 'NEW', label: 'New', displayOrder: 1 }], types: [] },
      } as never);
      // A draft of 3 exists and must not be reached — publishing is the act that matters.
      await templates.create({
        ...common, version: 3, status: 'draft',
        payload: { categories: [{ code: 'DRAFT', label: 'Draft', displayOrder: 1 }], types: [] },
      } as never);

      await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
      expect((await service.list(ctx(KPM_A))).map((c) => c.code)).toEqual(['NEW']);
    });

    it('does not copy a type whose category the template forgot to define', async () => {
      // It would render as a blank heading on the capture screen rather than as the bad
      // template it is.
      await templates.create({
        companyId: COMPANY, kind: 'activity_taxonomy', version: 1, status: 'published',
        publishedAt: NOW,
        payload: {
          categories: [{ code: 'REAL', label: 'Real', displayOrder: 1 }],
          types: [
            { code: 'KEPT', categoryCode: 'REAL', label: 'Kept', description: null, displayOrder: 1 },
            { code: 'ORPHAN', categoryCode: 'GONE', label: 'Orphan', description: null, displayOrder: 2 },
          ],
        },
      } as never);

      const result = await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
      expect(result.types).toBe(1);
      expect((await service.list(ctx(KPM_A)))[0].types.map((t) => t.code)).toEqual(['KEPT']);
    });

    it('gives another company\'s office its own defaults, not this one\'s template', async () => {
      await templates.create({
        companyId: COMPANY, kind: 'activity_taxonomy', version: 1, status: 'published',
        publishedAt: NOW,
        payload: { categories: [{ code: 'PRU_ONLY', label: 'Pru', displayOrder: 1 }], types: [] },
      } as never);

      await provisioning.seedActivityTaxonomy(KPM_B, 'a-different-company');
      expect((await service.list(ctx(KPM_B))).map((c) => c.code)).not.toContain('PRU_ONLY');
    });
  });

  describe('isolation', () => {
    beforeEach(async () => {
      await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
      await provisioning.seedActivityTaxonomy(KPM_B, COMPANY);
    });

    it('shows an office its own taxonomy and nobody else\'s', async () => {
      await service.createType(ctx(KPM_A), {
        code: 'A_ONLY', categoryCode: 'SELLING', label: 'A only',
      });

      const a = (await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code);
      const b = (await service.list(ctx(KPM_B))).flatMap((c) => c.types).map((t) => t.code);
      expect(a).toContain('A_ONLY');
      expect(b).not.toContain('A_ONLY');
    });

    it('cannot archive another office\'s type — 404, never 403', async () => {
      // A 403 would confirm the id exists, which is itself tenant information.
      const theirs = (await service.list(ctx(KPM_B)))[0].types[0];
      await expect(service.archiveType(ctx(KPM_A), theirs.id)).rejects.toThrow('Activity type');
      expect((await service.list(ctx(KPM_B)))[0].types[0].status).toBe('active');
    });

    it('cannot rename another office\'s type', async () => {
      const theirs = (await service.list(ctx(KPM_B)))[0].types[0];
      await expect(service.updateType(ctx(KPM_A), theirs.id, { label: 'mine now' }))
        .rejects.toThrow('Activity type');
    });

    it('lets two offices hold the same code, meaning different things', async () => {
      // The whole point of Phase 4: uniqueness is per office, not per platform.
      await service.createType(ctx(KPM_A), {
        code: 'SHARED', categoryCode: 'SELLING', label: 'A’s version',
      });
      await expect(service.createType(ctx(KPM_B), {
        code: 'SHARED', categoryCode: 'SELLING', label: 'B’s version',
      })).resolves.toMatchObject({ code: 'SHARED' });
    });
  });

  describe('codes and order (AC-2, AC-6)', () => {
    beforeEach(() => provisioning.seedActivityTaxonomy(KPM_A, COMPANY));

    it('refuses a duplicate code, counting archived ones', async () => {
      // A retired code returning as something else would change the meaning of every
      // activity log still pointing at it.
      const type = (await service.list(ctx(KPM_A)))
        .flatMap((c) => c.types).find((t) => t.code === 'SELL_SUBMISSION')!;
      await service.archiveType(ctx(KPM_A), type.id);

      await expect(service.createType(ctx(KPM_A), {
        code: 'SELL_SUBMISSION', categoryCode: 'SELLING', label: 'Something else',
      })).rejects.toThrow('already has an activity type called SELL_SUBMISSION');
    });

    it('refuses a code that is not a code', async () => {
      await expect(service.createType(ctx(KPM_A), {
        code: 'no lowercase or spaces', categoryCode: 'SELLING', label: 'x',
      })).rejects.toThrow('3–40 characters');
    });

    it('refuses a type in a category the office does not have', async () => {
      await expect(service.createType(ctx(KPM_A), {
        code: 'HOMELESS', categoryCode: 'NOT_A_CATEGORY', label: 'x',
      })).rejects.toThrow('No active category called NOT_A_CATEGORY');
    });

    it('archives rather than deletes, and the row is still there to restore', async () => {
      const type = (await service.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await service.archiveType(ctx(KPM_A), type.id);

      expect((await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code))
        .not.toContain(type.code);
      expect((await service.list(ctx(KPM_A), true)).flatMap((c) => c.types).map((t) => t.code))
        .toContain(type.code);

      await service.restoreType(ctx(KPM_A), type.id);
      expect((await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code))
        .toContain(type.code);
    });

    it('reorders by naming the whole list, and changes no code (AC-6)', async () => {
      const before = (await service.list(ctx(KPM_A))).flatMap((c) => c.types);
      const reversed = [...before].reverse().map((t) => t.id);

      const after = await service.reorderTypes(ctx(KPM_A), reversed);

      expect(after.map((t) => t.code)).toEqual([...before].reverse().map((t) => t.code));
      // The identity did not move, which is the invariant: a reorder must rebind nothing.
      expect(new Set(after.map((t) => t.code))).toEqual(new Set(before.map((t) => t.code)));
      // And no version was bumped — dragging a row is not a change to what is counted.
      expect(after.every((t) => t.version === 1)).toBe(true);
    });

    it('refuses a partial reorder rather than guessing at the rest', async () => {
      const types = (await service.list(ctx(KPM_A))).flatMap((c) => c.types);
      await expect(service.reorderTypes(ctx(KPM_A), [types[0].id]))
        .rejects.toThrow('every activity type, once each');
    });

    it('refuses a reorder naming another office\'s type', async () => {
      await provisioning.seedActivityTaxonomy(KPM_B, COMPANY);
      const mine = (await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.id);
      const theirs = (await service.list(ctx(KPM_B))).flatMap((c) => c.types)[0].id;
      await expect(service.reorderTypes(ctx(KPM_A), [...mine.slice(1), theirs]))
        .rejects.toThrow('every activity type, once each');
    });

    it('bumps the version when what the office counts actually changes', async () => {
      const type = (await service.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      const updated = await service.updateType(ctx(KPM_A), type.id, { label: 'Renamed' });
      expect(updated.version).toBe(2);
      expect(updated.code).toBe(type.code);
    });

    it('has no way to change a published code at all', () => {
      // Not "refuses" — the parameter does not exist. A code is what every activity log,
      // ratio formula and goal target holds.
      const update = service.updateType as unknown as (...args: unknown[]) => unknown;
      expect(update.length).toBe(3);
      const source = String(ActivityConfigService.prototype.updateType);
      expect(source).not.toMatch(/set\.code\s*=/);
    });
  });

  describe('the seeded taxonomy itself (AC-2, AC-3)', () => {
    beforeEach(() => provisioning.seedActivityTaxonomy(KPM_A, COMPANY));

    it('is the twelve codes the flow doc names, in display order', async () => {
      const codes = (await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code);
      expect(codes).toEqual([
        'LEADS_GEN_ACTIVITY', 'LEADS_NEW_PROSPECT', 'LEADS_CONTACTED',
        'SELL_PRESENTATION', 'SELL_FOLLOWUP', 'SELL_SUBMISSION',
        'RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP', 'RECRUIT_AGENT_CODE',
        'DEV_TRAINING_ATTEND', 'DEV_COACHING_RECEIVED', 'DEV_TEAM_ACTIVITY',
      ]);
    });

    it('uses the KPM Owner wording where the two prototypes disagree (AC-3)', async () => {
      // The Owner app is the configuration screen — it depicts what an Owner edits — so
      // its wording is authoritative. The agent app has items 7–9 in English.
      const types = (await service.list(ctx(KPM_A))).flatMap((c) => c.types);
      const byCode = new Map(types.map((t) => [t.code, t]));
      expect(byCode.get('RECRUIT_PRESENTATION')!.label).toBe('Presentasi NBO ke calon agen');
      expect(byCode.get('RECRUIT_PRESENTATION')!.description)
        .toBe('secara mandiri atau melalui BOP');
      expect(byCode.get('RECRUIT_AGENT_CODE')!.label).toBe('Proses NPA');
    });

    it('carries the three codes the goal cascade binds to', async () => {
      // `LEADS_CONTACTED`, `SELL_PRESENTATION` and `SELL_SUBMISSION` — not items #3, #4
      // and #6 (invariant §4).
      const codes = await service.activeTypeCodes(ctx(KPM_A));
      expect(codes).toEqual(expect.arrayContaining([
        'LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION',
      ]));
    });
  });
  describe('categories (P4-T12 coverage of the writes)', () => {
    beforeEach(() => provisioning.seedActivityTaxonomy(KPM_A, COMPANY));

    it('appends a new category rather than inserting it', async () => {
      // Somebody adding one has not said where it goes, and guessing would renumber rows
      // they did not touch.
      const created = await service.createCategory(ctx(KPM_A), {
        code: 'referrals', label: 'Referrals',
      });
      expect(created.code).toBe('REFERRALS');
      expect(created.displayOrder).toBe(6);
      expect(created.types).toEqual([]);
    });

    it('refuses a duplicate category code, counting archived ones', async () => {
      await expect(service.createCategory(ctx(KPM_A), { code: 'SELLING', label: 'Again' }))
        .rejects.toThrow('already has a category called SELLING');
    });

    it('refuses a label longer than 80 characters on the service itself (ADR-0030)', async () => {
      await expect(service.createCategory(ctx(KPM_A), { code: 'LONG_ONE', label: 'x'.repeat(81) }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await service.list(ctx(KPM_A), true)).some((c) => c.code === 'LONG_ONE')).toBe(false);
    });

    it('refuses a category code that is not a code', async () => {
      await expect(service.createCategory(ctx(KPM_A), { code: 'no spaces', label: 'x' }))
        .rejects.toThrow('3–40 characters');
    });

    it('renames a category without touching the code its types hold', async () => {
      const category = (await service.list(ctx(KPM_A)))
        .find((c) => c.code === 'SELLING')!;
      const renamed = await service.renameCategory(ctx(KPM_A), category.id, '  Penjualan  ');

      expect(renamed.label).toBe('Penjualan');
      expect(renamed.code).toBe('SELLING');
      expect(renamed.version).toBe(2);
      // The types under it still point at the same code.
      const after = (await service.list(ctx(KPM_A))).find((c) => c.code === 'SELLING')!;
      expect(after.types.length).toBeGreaterThan(0);
    });

    it('refuses to rename another office’s category — 404, never 403', async () => {
      await provisioning.seedActivityTaxonomy(KPM_B, COMPANY);
      const theirs = (await service.list(ctx(KPM_B)))[0];
      await expect(service.renameCategory(ctx(KPM_A), theirs.id, 'mine'))
        .rejects.toThrow('Activity category');
    });

    it('takes a type with a description, and trims an empty one to null', async () => {
      const withText = await service.createType(ctx(KPM_A), {
        code: 'SELL_REFERRAL', categoryCode: 'SELLING', label: 'Referral',
        description: '  from an existing client  ',
      });
      expect(withText.description).toBe('from an existing client');

      const blank = await service.createType(ctx(KPM_A), {
        code: 'SELL_WALKIN', categoryCode: 'SELLING', label: 'Walk-in', description: '   ',
      });
      // A blank description and an absent one are the same fact and should read alike.
      expect(blank.description).toBeNull();
    });

    it('moves a type to another category, and refuses one that is not active', async () => {
      const type = (await service.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      const moved = await service.updateType(ctx(KPM_A), type.id, { categoryCode: 'selling' });
      expect(moved.categoryCode).toBe('SELLING');

      await expect(service.updateType(ctx(KPM_A), type.id, { categoryCode: 'NOT_A_CATEGORY' }))
        .rejects.toThrow('No active category called NOT_A_CATEGORY');
    });

    it('refuses an update that changes nothing', async () => {
      // An audit row about nothing is noise in the one place noise costs most.
      const type = (await service.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await expect(service.updateType(ctx(KPM_A), type.id, {}))
        .rejects.toThrow('Nothing to change');
    });

    it('clears a description back to null through an update', async () => {
      const type = (await service.list(ctx(KPM_A))).flatMap((c) => c.types)
        .find((t) => t.description !== null)!;
      const cleared = await service.updateType(ctx(KPM_A), type.id, { description: '' });
      expect(cleared.description).toBeNull();
    });

    it('refuses to restore a type from another office', async () => {
      await provisioning.seedActivityTaxonomy(KPM_B, COMPANY);
      const theirs = (await service.list(ctx(KPM_B))).flatMap((c) => c.types)[0];
      await expect(service.restoreType(ctx(KPM_A), theirs.id)).rejects.toThrow('Activity type');
    });
  });


  /**
   * P4-T18 — a section says who it is for, and it cascades.
   */
  describe('who a section is for (P4-T18)', () => {
    const companies = () => wired.companies as mongoose.Model<never>;
    const kpms = () => wired.kpms as mongoose.Model<never>;

    async function office(codes = ['AGENT', 'AAB', 'AB']) {
      await companies().create({ _id: COMPANY, name: 'Prudential', slug: `p-${COMPANY}` } as never);
      const sa = RequestContext.platform('root');
      for (const [i, code] of codes.entries()) {
        await wired.orgLevels.create(sa, { companyId: COMPANY, code, label: code, displayOrder: i + 1 });
      }
      await kpms().create({
        _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
      } as never);
      const seeded = await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
      await provisioning.seedRatioDefinitions(KPM_A, COMPANY, seeded.typeCodes);
    }

    beforeEach(() => office());

    it('starts every section applying to everyone', async () => {
      const list = await service.list(ctx(KPM_A));
      expect(list.every((c) => c.appliesToOrgLevelCodes.length === 0)).toBe(true);
    });

    it('cascades a section’s rungs onto every type inside it, and stores them on neither', async () => {
      /*
       * The cascade is resolved in `list()` so `/kpm/config` — and the published snapshot,
       * and Phase 6's capture screen — carries one answer already computed. Three call
       * sites flatten types away from their categories; making each re-find its parent
       * would be three chances to get visibility wrong.
       */
      // `PERSONAL_DEVELOPMENT`, because no seeded ratio counts it — narrowing a section
      // that *is* counted is refused, and that is the test below this one.
      const dev = (await service.list(ctx(KPM_A))).find((c) => c.code === 'PERSONAL_DEVELOPMENT')!;
      await service.updateCategory(ctx(KPM_A), dev.id, { appliesToOrgLevelCodes: ['AB', 'AAB'] });

      const after = (await service.list(ctx(KPM_A))).find((c) => c.code === 'PERSONAL_DEVELOPMENT')!;
      expect(after.appliesToOrgLevelCodes).toEqual(['AB', 'AAB']);
      expect(after.types.every((t) => t.appliesToOrgLevelCodes.join() === 'AB,AAB')).toBe(true);

      // Untouched sections still mean everyone.
      const leads = (await service.list(ctx(KPM_A))).find((c) => c.code === 'LEADS_GENERATION')!;
      expect(leads.types.every((t) => t.appliesToOrgLevelCodes.length === 0)).toBe(true);
    });

    it('refuses a rung the company does not have, naming it', async () => {
      const [first] = await service.list(ctx(KPM_A));
      await expect(
        service.updateCategory(ctx(KPM_A), first.id, { appliesToOrgLevelCodes: ['DIRECTOR'] }),
      ).rejects.toMatchObject({ code: 'CONFIG_RUNG_UNKNOWN' });
    });

    it('takes a description, on create and on update', async () => {
      const made = await service.createCategory(ctx(KPM_A), {
        code: 'REFERRALS', label: 'Referrals', description: '  Who sent them  ',
      });
      expect(made.description).toBe('Who sent them');

      const cleared = await service.updateCategory(ctx(KPM_A), made.id, { description: '' });
      expect(cleared.description).toBeNull();
    });

    describe('narrowing a section is checked against the ratios that count it', () => {
      it('refuses when a ratio would divide by activity its own rungs cannot log', async () => {
        /*
         * The case a naive check misses: the ratio applies to **everyone** because its
         * list is empty, and "empty" reads as unconstrained on both sides. Narrowing
         * SELLING to AB leaves every AGENT measured on a figure with nothing underneath —
         * which is exactly the permanent alert ADR-0020 closed from the other side.
         */
        const selling = (await service.list(ctx(KPM_A))).find((c) => c.code === 'SELLING')!;
        await expect(
          service.updateCategory(ctx(KPM_A), selling.id, { appliesToOrgLevelCodes: ['AB'] }),
        ).rejects.toMatchObject({
          code: 'CONFIG_RATIO_UNREACHABLE_INPUT',
          message: expect.stringContaining('SELLING_SUCCESS_RATE'),
        });
      });

      it('allows it once the ratio is narrowed to the same rungs or fewer', async () => {
        const selling = (await service.list(ctx(KPM_A))).find((c) => c.code === 'SELLING')!;
        for (const r of await wired.ratios.list(ctx(KPM_A))) {
          const counts = [...r.numerator, ...r.denominator]
            .some((c) => selling.types.some((t) => t.code === c));
          if (counts) await wired.ratios.update(ctx(KPM_A), r.id, { appliesToOrgLevelCodes: ['AB'] });
        }

        const ok = await service.updateCategory(ctx(KPM_A), selling.id, {
          appliesToOrgLevelCodes: ['AB'],
        });
        expect(ok.appliesToOrgLevelCodes).toEqual(['AB']);
      });

      it('lets a widening through without reading a single ratio', async () => {
        const selling = (await service.list(ctx(KPM_A))).find((c) => c.code === 'SELLING')!;
        const back = await service.updateCategory(ctx(KPM_A), selling.id, {
          appliesToOrgLevelCodes: [],
        });
        expect(back.appliesToOrgLevelCodes).toEqual([]);
      });
    });

    describe('archiving a section', () => {
      it('takes its types with it, because a live type in a retired section is loggable from nowhere', async () => {
        const selling = (await service.list(ctx(KPM_A))).find((c) => c.code === 'SELLING')!;
        await service.archiveCategory(ctx(KPM_A), selling.id);

        const all = await service.list(ctx(KPM_A), true);
        const after = all.find((c) => c.code === 'SELLING')!;
        expect(after.status).toBe('archived');
        expect(after.types.every((t) => t.status === 'archived')).toBe(true);
        // And it is gone from the active view entirely.
        expect((await service.list(ctx(KPM_A))).some((c) => c.code === 'SELLING')).toBe(false);
      });

      it('brings the section back without its types, which is a separate decision', async () => {
        const selling = (await service.list(ctx(KPM_A))).find((c) => c.code === 'SELLING')!;
        await service.archiveCategory(ctx(KPM_A), selling.id);
        const back = await service.restoreCategory(ctx(KPM_A), selling.id);

        expect(back.status).toBe('active');
        const after = (await service.list(ctx(KPM_A), true)).find((c) => c.code === 'SELLING')!;
        expect(after.types.every((t) => t.status === 'archived')).toBe(true);
      });

      it('404s another office’s section', async () => {
        const selling = (await service.list(ctx(KPM_A)))[0];
        await expect(service.archiveCategory(ctx(KPM_B), selling.id)).rejects.toThrow();
      });
    });

    describe('reordering sections', () => {
      it('names all of them, and bumps no version', async () => {
        const before = await service.list(ctx(KPM_A), true);
        const reversed = [...before].reverse().map((c) => c.id);

        const after = await service.reorderCategories(ctx(KPM_A), reversed);

        expect(after.map((c) => c.code)).toEqual([...before].reverse().map((c) => c.code));
        expect(after.map((c) => c.version)).toEqual([...before].reverse().map((c) => c.version));
      });

      it('refuses a partial list', async () => {
        const all = await service.list(ctx(KPM_A), true);
        await expect(service.reorderCategories(ctx(KPM_A), [all[0].id]))
          .rejects.toThrow(/every section, once each/);
      });
    });
  });
});
