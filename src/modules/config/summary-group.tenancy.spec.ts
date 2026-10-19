import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, givenDefaultTemplate, provisionOffice } from '../../../test/config-module';
import type { ActivityCategoryView } from './activity.service';

const NOW = new Date('2026-03-11T02:00:00Z');
const TODAY = '2026-03-11';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const ctxFor = (kpmId: string, over: Record<string, unknown> = {}) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
} as never);
const owner = (kpmId = KPM_A) => ctxFor(kpmId, { orgLevelCode: 'AB', hierarchyRole: 'ab', isKpmOwner: true });
const agent = (kpmId = KPM_A) => ctxFor(kpmId);

/** A refusal's code, status and details — or a failure when the call was accepted. */
const refusalOf = (promise: Promise<unknown>) => promise.then(
  () => { throw new Error('the write was accepted'); },
  (e: { code: string; message: string; details?: Record<string, unknown>; getStatus(): number }) => ({
    code: e.code, status: e.getStatus(), details: e.details, message: e.message,
  }),
);

/**
 * The strip a reader is drawn, derived the way the frontend's helper derives it (ADR-0064): a
 * tile where its first section sits, the group's label or the section's own, and only the sections
 * this rung is shown. The total is not a tile of configuration and is not here.
 */
function stripOf(sections: ActivityCategoryView[], rung: string): { label: string; codes: string[] }[] {
  const tiles = new Map<string, { label: string; codes: string[] }>();
  for (const section of [...sections].sort((a, b) => a.displayOrder - b.displayOrder)) {
    const shown = section.appliesToOrgLevelCodes.length === 0 || section.appliesToOrgLevelCodes.includes(rung);
    if (!shown) continue;
    const key = section.summaryGroupCode ? `group:${section.summaryGroupCode}` : `section:${section.code}`;
    const tile = tiles.get(key) ?? { label: section.summaryGroupLabel ?? section.label, codes: [] };
    tile.codes.push(section.code);
    tiles.set(key, tile);
  }
  return [...tiles.values()];
}

/**
 * ADR-0064, P10.1-T5 AC-4 and AC-5: an activity category may declare the summary tile it counts
 * toward. The office owns the grouping; the seed sets it to the prototype's strip; one tile carries
 * one label; regrouping is published like every other change; and no metric reads it.
 */
describe('the summary tile a section counts toward (ADR-0064)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as unknown as mongoose.Model<never>).create({ _id: COMPANY, name: 'Prudential', slug: 'p' } as never);
    // The company's default template, which the template routes read when none is named (ADR-0115 §3).
    await givenDefaultTemplate(wired, COMPANY);
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
  });

  const section = async (code: string, kpmId = KPM_A) =>
    (await wired.activity.list(owner(kpmId), true)).find((c) => c.code === code)!;
  const served = async (kpmId = KPM_A) => (await wired.config.readPublished(agent(kpmId))).activity;

  describe('the seed, as agents are served it', () => {
    it('draws the prototype’s strip: four tiles, Development taking both of its sections', async () => {
      await wired.config.publish(owner());

      // `Overall.html:2720-2726`, and `activity-taxonomy.spec.ts` reads the prototype itself.
      expect(stripOf(await served(), 'AGENT')).toEqual([
        { label: 'Leads Generation', codes: ['LEADS_GENERATION'] },
        { label: 'Selling', codes: ['SELLING'] },
        { label: 'Recruitment', codes: ['RECRUITMENT'] },
        { label: 'Development', codes: ['PERSONAL_DEVELOPMENT', 'TEAM_DEVELOPMENT'] },
      ]);
    });

    it('serves a section with no tile as null on both, which draws a tile of its own under its label', async () => {
      await wired.activity.createCategory(owner(), { code: 'REFERRALS', label: 'Referrals' });
      await wired.config.publish(owner());

      const referrals = (await served()).find((c) => c.code === 'REFERRALS')!;
      expect(referrals).toMatchObject({ summaryGroupCode: null, summaryGroupLabel: null });
      expect(stripOf(await served(), 'AGENT').at(-1)).toEqual({ label: 'Referrals', codes: ['REFERRALS'] });
    });

    it('drops a section from its tile for a rung it is not shown, and the tile when none is', async () => {
      // The two development sections: the seeded ratios count none of their types, so narrowing
      // them strands no ratio (ADR-0020's refusal is not this test's subject).
      const team = await section('TEAM_DEVELOPMENT');
      await wired.activity.updateCategory(owner(), team.id, { appliesToOrgLevelCodes: ['AB', 'AAB'] });
      await wired.config.publish(owner());
      expect(stripOf(await served(), 'AGENT').find((t) => t.label === 'Development')!.codes)
        .toEqual(['PERSONAL_DEVELOPMENT']);

      const personal = await section('PERSONAL_DEVELOPMENT');
      await wired.activity.updateCategory(owner(), personal.id, { appliesToOrgLevelCodes: ['AB'] });
      await wired.config.publish(owner());
      expect(stripOf(await served(), 'AGENT').map((t) => t.label))
        .toEqual(['Leads Generation', 'Selling', 'Recruitment']);
      expect(stripOf(await served(), 'AAB').find((t) => t.label === 'Development')!.codes)
        .toEqual(['TEAM_DEVELOPMENT']);
      expect(stripOf(await served(), 'AB').map((t) => t.label))
        .toEqual(['Leads Generation', 'Selling', 'Recruitment', 'Development']);
    });

    it('places a tile where its first section sits, so reordering the sections reorders the tiles', async () => {
      const ids = (await wired.activity.list(owner(), true)).map((c) => c.id);
      // Team Development first: *Development* now leads the strip, with both sections in it.
      await wired.activity.reorderCategories(owner(), [ids[4], ...ids.slice(0, 4)]);

      expect(stripOf(await wired.activity.list(owner()), 'AGENT').map((t) => t.label))
        .toEqual(['Development', 'Leads Generation', 'Selling', 'Recruitment']);
    });
  });

  describe('the category routes', () => {
    it('regroups a section, bumping its version', async () => {
      const selling = await section('SELLING');
      const updated = await wired.activity.updateCategory(owner(), selling.id, {
        summaryGroupCode: 'development', summaryGroupLabel: ' Development ',
      });

      expect(updated).toMatchObject({
        summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development', version: selling.version + 1,
      });
      expect(stripOf(await wired.activity.list(owner()), 'AGENT').map((t) => t.label))
        .toEqual(['Leads Generation', 'Development', 'Recruitment']);
    });

    it('renames a section’s own tile with the section, and leaves a shared tile’s label alone (OD-101)', async () => {
      // A tile of one carries neither field, so its label *is* the section's: renaming *Selling*
      // renames the tile, with no second field for the Owner to remember.
      const selling = await section('SELLING');
      await wired.activity.updateCategory(owner(), selling.id, { label: 'Penjualan' });
      // A shared tile is the office's own name for the group, and a section's rename leaves it.
      const personal = await section('PERSONAL_DEVELOPMENT');
      await wired.activity.updateCategory(owner(), personal.id, { label: 'Pengembangan Diri' });

      expect(stripOf(await wired.activity.list(owner()), 'AGENT').map((tile) => tile.label))
        .toEqual(['Leads Generation', 'Penjualan', 'Recruitment', 'Development']);
    });

    it('creates a section in a tile, and clears one back to a tile of its own', async () => {
      const made = await wired.activity.createCategory(owner(), {
        code: 'REFERRALS', label: 'Referrals', summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development',
      });
      expect(made).toMatchObject({ summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' });

      const cleared = await wired.activity.updateCategory(owner(), made.id, {
        summaryGroupCode: null, summaryGroupLabel: null,
      });
      expect(cleared).toMatchObject({ summaryGroupCode: null, summaryGroupLabel: null, version: 2 });
    });

    it('refuses a label the tile’s other sections do not carry — 422, naming the tile and both labels', async () => {
      const selling = await section('SELLING');
      const refused = await refusalOf(wired.activity.updateCategory(owner(), selling.id, {
        summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth',
      }));

      expect(refused).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH',
        status: 422,
        // In display order: *Selling* sits above both development sections.
        details: { summaryGroupCode: 'DEVELOPMENT', labels: ['Growth', 'Development'] },
      });
      expect(await section('SELLING')).toMatchObject({ summaryGroupCode: null, version: selling.version });

      await expect(wired.activity.createCategory(owner(), {
        code: 'REFERRALS', label: 'Referrals', summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth',
      })).rejects.toMatchObject({ code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH' });
      expect(await section('REFERRALS')).toBeUndefined();
    });

    it('refuses a new section under a shared tile’s code, in a tile or not — 422, naming the tile (P10.1-T6)', async () => {
      // Its own tile would be a second *DEVELOPMENT* beside the shared one: two chips, one code.
      const refused = await refusalOf(wired.activity.createCategory(owner(), { code: 'DEVELOPMENT', label: 'Growth' }));
      expect(refused).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN',
        status: 422,
        details: { summaryGroupCode: 'DEVELOPMENT', label: 'Development' },
      });
      await expect(wired.activity.createCategory(owner(), {
        code: 'DEVELOPMENT', label: 'Growth', summaryGroupCode: 'SALES', summaryGroupLabel: 'Sales',
      })).rejects.toMatchObject({ code: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN' });
      expect(await section('DEVELOPMENT')).toBeUndefined();

      // Inside the tile it names, the code collides with nothing.
      const inside = await wired.activity.createCategory(owner(), {
        code: 'DEVELOPMENT', label: 'Growth', summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development',
      });
      expect(inside).toMatchObject({ code: 'DEVELOPMENT', summaryGroupCode: 'DEVELOPMENT' });
    });

    it('refuses moving sections into a shared tile under another section’s code, archived included', async () => {
      // *Recruitment*: *Selling* holds cascade types and cannot be archived (ADR-0115 §2).
      const [personal, recruitment] = [await section('PERSONAL_DEVELOPMENT'), await section('RECRUITMENT')];
      await wired.activity.archiveCategory(owner(), recruitment.id);

      expect(await refusalOf(wired.activity.updateCategory(owner(), personal.id, {
        summaryGroupCode: 'RECRUITMENT', summaryGroupLabel: 'Recruitment',
      }))).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN', status: 422, details: { summaryGroupCode: 'RECRUITMENT' },
      });
      expect(await section('PERSONAL_DEVELOPMENT')).toMatchObject({ summaryGroupCode: 'DEVELOPMENT', version: personal.version });
    });

    it('counts an archived section, which still renders the days it holds', async () => {
      const personal = await section('PERSONAL_DEVELOPMENT');
      await wired.activity.archiveCategory(owner(), personal.id);
      const team = await section('TEAM_DEVELOPMENT');

      await expect(wired.activity.updateCategory(owner(), team.id, {
        summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Pengembangan',
      })).rejects.toMatchObject({ code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH' });
    });

    it('refuses a code without a label, a label without a code, and half a clear', async () => {
      const selling = await section('SELLING');
      for (const body of [
        { summaryGroupCode: 'SALES' },
        { summaryGroupLabel: 'Sales' },
        { summaryGroupCode: null, summaryGroupLabel: 'Sales' },
        { summaryGroupCode: 'SALES', summaryGroupLabel: null },
      ]) {
        const refused = await refusalOf(wired.activity.updateCategory(owner(), selling.id, body));
        expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
        expect(refused.details!.violations).toContain(
          'summaryGroupCode and summaryGroupLabel are set together, or cleared together with null.',
        );
      }
      await expect(wired.activity.createCategory(owner(), {
        code: 'REFERRALS', label: 'Referrals', summaryGroupCode: 'SALES',
      })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('refuses a code in the wrong shape and a label that is blank or too long', async () => {
      const selling = await section('SELLING');
      for (const body of [
        { summaryGroupCode: 'no spaces', summaryGroupLabel: 'Sales' },
        { summaryGroupCode: 'SALES', summaryGroupLabel: '   ' },
        { summaryGroupCode: 'SALES', summaryGroupLabel: 'x'.repeat(81) },
      ]) {
        await expect(wired.activity.updateCategory(owner(), selling.id, body))
          .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
    });
  });

  describe('the staged batch', () => {
    it('renames a tile of two sections in one batch, which two single writes could not', async () => {
      const [personal, team] = [await section('PERSONAL_DEVELOPMENT'), await section('TEAM_DEVELOPMENT')];
      const rename = { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Pengembangan' };

      // One at a time, the first leaves the tile split, and is refused.
      await expect(wired.activity.updateCategory(owner(), personal.id, rename))
        .rejects.toMatchObject({ code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH' });

      await wired.changes.apply(owner(), [
        { op: 'category.update', id: personal.id, expectedVersion: personal.version, body: rename },
        { op: 'category.update', id: team.id, expectedVersion: team.version, body: rename },
      ]);
      expect(stripOf(await wired.activity.list(owner()), 'AGENT').at(-1))
        .toEqual({ label: 'Pengembangan', codes: ['PERSONAL_DEVELOPMENT', 'TEAM_DEVELOPMENT'] });
    });

    it('refuses a batch that leaves a tile split, naming the op, and writes none of it', async () => {
      const personal = await section('PERSONAL_DEVELOPMENT');
      const refused = await refusalOf(wired.changes.apply(owner(), [
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
        {
          op: 'category.update', id: personal.id, expectedVersion: personal.version,
          body: { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Pengembangan' },
        },
      ]));

      expect(refused).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH',
        status: 422,
        details: { summaryGroupCode: 'DEVELOPMENT', labels: ['Pengembangan', 'Development'] },
      });
      expect(refused.message).toMatch(/^Change 2 \(category\.update\): /);
      expect(await section('REFERRALS')).toBeUndefined();
      expect(await section('PERSONAL_DEVELOPMENT')).toMatchObject({ summaryGroupLabel: 'Development', version: personal.version });
    });

    it('refuses a new section joining a tile under another label', async () => {
      await expect(wired.changes.apply(owner(), [{
        op: 'category.create',
        body: { code: 'REFERRALS', label: 'Referrals', summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth' },
      }])).rejects.toMatchObject({ code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH' });
    });

    it('refuses a batch that creates a section under a shared tile’s code, naming that op, and writes none of it', async () => {
      const refused = await refusalOf(wired.changes.apply(owner(), [
        { op: 'category.create', body: { code: 'DEVELOPMENT', label: 'Growth' } },
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
      ]));
      expect(refused).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN',
        status: 422,
        details: { summaryGroupCode: 'DEVELOPMENT', label: 'Development' },
      });
      // The op that created it, not the batch's last.
      expect(refused.message).toMatch(/^Change 1 \(category\.create\): /);
      expect(await section('REFERRALS')).toBeUndefined();
    });

    it('lets a batch take a section out of the tile its code names, and refuses the state that leaves', async () => {
      // Two sections in a tile called *SELLING*, then *SELLING* leaves it: the tile outlives the section it is named for.
      const [selling, personal] = [await section('SELLING'), await section('PERSONAL_DEVELOPMENT')];
      const body = { summaryGroupCode: 'SELLING', summaryGroupLabel: 'Sales' };
      await wired.changes.apply(owner(), [
        { op: 'category.update', id: selling.id, expectedVersion: selling.version, body },
        { op: 'category.update', id: personal.id, expectedVersion: personal.version, body },
      ]);
      const team = await section('TEAM_DEVELOPMENT');
      const moved = await section('SELLING');
      const refused = await refusalOf(wired.changes.apply(owner(), [
        { op: 'category.update', id: team.id, expectedVersion: team.version, body },
        {
          op: 'category.update', id: moved.id, expectedVersion: moved.version,
          body: { summaryGroupCode: null, summaryGroupLabel: null },
        },
      ]));
      expect(refused).toMatchObject({ code: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN', details: { summaryGroupCode: 'SELLING' } });
      expect(refused.message).toMatch(/^Change 2 \(category\.update\): /);
    });

    it('refuses half a pair before anything is written', async () => {
      const selling = await section('SELLING');
      await expect(wired.changes.apply(owner(), [
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
        { op: 'category.update', id: selling.id, expectedVersion: selling.version, body: { summaryGroupCode: 'SALES' } },
      ])).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('Change 2 (category.update)') });
      expect(await section('REFERRALS')).toBeUndefined();
    });

    it('lets a batch move a section out of a tile and another in, by the state it leaves', async () => {
      const [selling, team] = [await section('SELLING'), await section('TEAM_DEVELOPMENT')];
      await wired.changes.apply(owner(), [
        {
          op: 'category.update', id: team.id, expectedVersion: team.version,
          body: { summaryGroupCode: null, summaryGroupLabel: null },
        },
        {
          op: 'category.update', id: selling.id, expectedVersion: selling.version,
          body: { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' },
        },
      ]);
      expect(stripOf(await wired.activity.list(owner()), 'AGENT').map((t) => [t.label, t.codes])).toEqual([
        ['Leads Generation', ['LEADS_GENERATION']],
        ['Development', ['SELLING', 'PERSONAL_DEVELOPMENT']],
        ['Recruitment', ['RECRUITMENT']],
        ['Team Development', ['TEAM_DEVELOPMENT']],
      ]);
    });
  });

  describe('another office', () => {
    it('cannot regroup this office’s section — 404, and the section is as it was', async () => {
      const theirs = await section('SELLING', KPM_B);
      const body = { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' };

      const viaBatch = await refusalOf(wired.changes.apply(owner(KPM_A), [
        { op: 'category.update', id: theirs.id, expectedVersion: theirs.version, body },
      ]));
      expect(viaBatch).toMatchObject({ code: 'NOT_FOUND', status: 404 });

      expect(await refusalOf(wired.activity.updateCategory(owner(KPM_A), theirs.id, body)))
        .toMatchObject({ status: 404 });
      expect(await section('SELLING', KPM_B)).toMatchObject({
        summaryGroupCode: null, summaryGroupLabel: null, version: theirs.version,
      });
    });

    it('does not count its labels against this office’s tiles', async () => {
      const theirs = await section('PERSONAL_DEVELOPMENT', KPM_B);
      const team = await section('TEAM_DEVELOPMENT', KPM_B);
      await wired.changes.apply(owner(KPM_B), [
        { op: 'category.update', id: theirs.id, expectedVersion: theirs.version, body: { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth' } },
        { op: 'category.update', id: team.id, expectedVersion: team.version, body: { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth' } },
      ]);

      // *Development* in A and *Growth* in B share a code and are two offices' tiles.
      const selling = await section('SELLING');
      await wired.activity.updateCategory(owner(), selling.id, {
        summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development',
      });
      expect((await section('SELLING')).summaryGroupLabel).toBe('Development');
    });
  });

  describe('reaching agents (P4-T6)', () => {
    it('shows on the publish bar, and reaches agents only when published', async () => {
      await wired.config.publish(owner());
      const selling = await section('SELLING');
      await wired.activity.updateCategory(owner(), selling.id, {
        summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development',
      });

      expect((await wired.config.state(owner())).hasUnpublishedChanges).toBe(true);
      expect((await served()).find((c) => c.code === 'SELLING')!.summaryGroupCode).toBeNull();

      await wired.config.publish(owner());
      expect((await wired.config.state(owner())).hasUnpublishedChanges).toBe(false);
      expect((await served()).find((c) => c.code === 'SELLING')!.summaryGroupCode).toBe('DEVELOPMENT');
    });

    it('fingerprints the tile by value, so a regroup with no version bump still shows', async () => {
      // The second lock: nothing writes this way, and if something did, agents would otherwise
      // stay on the old strip under a silent publish bar.
      await wired.config.publish(owner());
      await mongoose.connection.db!.collection('activityCategories').updateOne(
        { kpmId: KPM_A, code: 'SELLING' },
        { $set: { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' } },
      );
      expect((await wired.config.state(owner())).hasUnpublishedChanges).toBe(true);
    });

    it('reads a snapshot published before the field as null on both, and calls nothing changed', async () => {
      await wired.config.publish(owner());
      const db = mongoose.connection.db!;
      await db.collection('configSnapshots').updateMany({ kpmId: KPM_A }, {
        $unset: { 'payload.activity.$[].summaryGroupCode': '', 'payload.activity.$[].summaryGroupLabel': '' },
      });
      await db.collection('activityCategories').updateMany(
        { kpmId: KPM_A }, { $unset: { summaryGroupCode: '', summaryGroupLabel: '' } },
      );

      expect((await served()).every((c) => c.summaryGroupCode === null && c.summaryGroupLabel === null)).toBe(true);
      expect((await wired.activity.list(owner())).every((c) => c.summaryGroupCode === null)).toBe(true);
      expect((await wired.config.state(owner())).hasUnpublishedChanges).toBe(false);
    });
  });

  describe('presentation, never a metric input', () => {
    /** One stored day, written straight in: the metrics read what is stored. */
    const day = (localDate: string, counts: Record<string, number>) =>
      mongoose.connection.db!.collection('activityLogs').insertOne({
        kpmId: KPM_A, membershipId: `mem-${KPM_A}`, localDate,
        entries: Object.entries(counts).map(([code, count]) => ({ activityTypeId: `type-${code}`, activityTypeCode: code, count })),
        totalCount: Object.values(counts).reduce((t, n) => t + n, 0),
        source: 'self', version: 1, frozenAt: null, corrections: [], deletedAt: null,
      } as never);

    /**
     * Every figure the activity module computes for one member. The summary's `sections` are left out:
     * since P11-T4 they are the tiles themselves — the grouping this test changes — and a regrouping is
     * meant to move a count between them. `sectionChips`' own spec holds them to the same rows.
     */
    const metrics = async () => ({
      summary: await wired.activityLogs.summary(agent(), { period: 'ROLLING_30D' })
        .then(({ sections: _tiles, ...figures }) => figures),
      dashboard7: await wired.activityLogs.dashboard(agent(), {}),
      dashboard30: await wired.activityLogs.dashboard(agent(), { range: 'ROLLING_30D' }),
      ratios: await wired.activityLogs.ratios(agent()),
      compliance: await wired.activityLogs.compliance(agent(), {}),
    });

    it('changes no figure when every section is regrouped', async () => {
      await day(TODAY, {
        LEADS_GEN_ACTIVITY: 4, LEADS_NEW_PROSPECT: 2, LEADS_CONTACTED: 6, SELL_PRESENTATION: 3,
        SELL_SUBMISSION: 1, RECRUIT_PRESENTATION: 2, DEV_TRAINING_ATTEND: 1, DEV_TEAM_ACTIVITY: 2,
      });
      await day('2026-03-02', { SELL_FOLLOWUP: 5, RECRUIT_AGENT_CODE: 1, DEV_COACHING_RECEIVED: 1 });
      const before = await metrics();
      expect(before.summary.totalCount).toBe(28);

      const rows = await wired.activity.list(owner(), true);
      const one = { summaryGroupCode: 'EVERYTHING', summaryGroupLabel: 'Everything' };
      await wired.changes.apply(owner(), rows.map((c) => ({
        op: 'category.update' as const, id: c.id, expectedVersion: c.version,
        body: c.code === 'TEAM_DEVELOPMENT' ? { summaryGroupCode: null, summaryGroupLabel: null } : one,
      })));
      await wired.config.publish(owner());

      expect(stripOf(await served(), 'AGENT').map((t) => t.label)).toEqual(['Everything', 'Team Development']);
      expect(await metrics()).toEqual(before);
    });
  });

  describe('the Company template (ADR-0018)', () => {
    const sa = RequestContext.platform('root');
    const taxonomy = (categories: Record<string, unknown>[]) => ({
      categories,
      types: [{ code: 'SELL_X', categoryCode: 'SELLING', label: 'x', description: null, displayOrder: 1 }],
    });

    it('starts a template made from the defaults with the seed’s tiles', async () => {
      const made = await wired.namedTemplates.create(sa, COMPANY, { name: 'Defaults', from: 'defaults' });
      const view = await wired.templateService.read(COMPANY, 'activity_taxonomy', made.id);
      expect((view.payload.categories as Record<string, unknown>[]).map((c) => c.summaryGroupCode))
        .toEqual([null, null, null, 'DEVELOPMENT', 'DEVELOPMENT']);
    });

    it('saves a draft with its tiles normalised, the way an office’s own write is', async () => {
      const saved = await wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', taxonomy([
        { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: ' core ', summaryGroupLabel: ' Core ' },
        { code: 'REFERRALS', label: 'Referrals', displayOrder: 2 },
      ]));
      expect((saved.payload.categories as Record<string, unknown>[]).map((c) => [c.summaryGroupCode, c.summaryGroupLabel]))
        .toEqual([['CORE', 'Core'], [null, null]]);
    });

    it('refuses a draft whose tile carries two labels — 422, with the tile and its labels', async () => {
      const refused = await refusalOf(wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', taxonomy([
        { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2, summaryGroupCode: 'CORE', summaryGroupLabel: 'Inti' },
      ])));
      expect(refused).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH', status: 422,
        details: { summaryGroupCode: 'CORE', labels: ['Core', 'Inti'] },
      });
    });

    it('refuses a draft whose shared tile carries the code of a section outside it — 422', async () => {
      const refused = await refusalOf(wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', taxonomy([
        { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'CORE', label: 'Core skills', displayOrder: 3 },
      ])));
      expect(refused).toMatchObject({
        code: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN', status: 422, details: { summaryGroupCode: 'CORE', label: 'Core' },
      });
    });

    it('refuses half a pair, a code nothing could store and a blank label, naming each section', async () => {
      const refused = await refusalOf(wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', taxonomy([
        { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: 'CORE' },
        { code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2, summaryGroupCode: 'no spaces', summaryGroupLabel: 'x' },
        { code: 'BRANDING', label: 'Branding', displayOrder: 3, summaryGroupCode: 'BRAND', summaryGroupLabel: ' ' },
      ])));
      expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(refused.details!.violations).toEqual([
        expect.stringMatching(/^categories\[0\] \(SELLING\): summaryGroupCode and summaryGroupLabel/),
        expect.stringMatching(/^categories\[1\] \(RECRUITMENT\): summaryGroupCode: A code is/),
        'categories[2] (BRANDING): summaryGroupLabel must be 1–80 characters.',
      ]);
    });

    it('refuses to publish a draft that broke the rule before it existed', async () => {
      await wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', taxonomy([
        { code: 'SELLING', label: 'Selling', displayOrder: 1 },
      ]));
      await mongoose.connection.db!.collection('companyTemplates').updateOne(
        { companyId: COMPANY, kind: 'activity_taxonomy', status: 'draft' },
        {
          $set: {
            payload: taxonomy([
              { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
              { code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2, summaryGroupCode: 'CORE', summaryGroupLabel: 'Inti' },
            ]),
          },
        },
      );
      await expect(wired.templateService.publish(sa, COMPANY, 'activity_taxonomy'))
        .rejects.toMatchObject({ code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH' });
    });

    it('builds a new office on the published tiles', async () => {
      await wired.templateService.saveDraft(sa, COMPANY, 'activity_taxonomy', taxonomy([
        { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'REFERRALS', label: 'Referrals', displayOrder: 3 },
      ]));
      await wired.templateService.publish(sa, COMPANY, 'activity_taxonomy');
      const KPM_C = '66f0000000000000000000d1';
      await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create({
        _id: KPM_C, companyId: COMPANY, code: '0600', branchName: 'C', timezone: 'Asia/Jakarta',
      });

      const plan = await wired.provisioning.planFor(COMPANY);
      await wired.provisioning.seedActivityTaxonomy(KPM_C, plan.kinds.activity_taxonomy);

      expect(stripOf(await wired.activity.list(owner(KPM_C)), 'AGENT')).toEqual([
        { label: 'Core', codes: ['SELLING', 'RECRUITMENT'] },
        { label: 'Referrals', codes: ['REFERRALS'] },
        // The template lacked `LEADS_CONTACTED`, so its platform section came with it (ADR-0115 §2).
        { label: 'Leads Generation', codes: ['LEADS_GENERATION'] },
      ]);
    });

    it('refuses to build an office from a published template older than the rule', async () => {
      const templateId = String((await wired.namedTemplates.resolve(COMPANY))._id);
      await (wired.templates as unknown as mongoose.Model<never>).create({
        companyId: COMPANY, templateId, kind: 'activity_taxonomy', status: 'published', version: 1, deletedAt: null,
        payload: taxonomy([
          { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
          { code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2, summaryGroupCode: 'CORE', summaryGroupLabel: 'Inti' },
        ]),
      } as never);

      // Checked whole before the office row is written (ADR-0115 §4)…
      await expect(wired.provisioning.planFor(COMPANY))
        .rejects.toThrow(/the summary tile CORE is labelled Core and Inti/);
      // …and by the seed itself, for a caller that hands it a source directly.
      const source = { payload: (await (wired.templates as unknown as mongoose.Model<{ payload: Record<string, unknown> }>)
        .findOne({ companyId: COMPANY }).lean().exec())!.payload, seededFrom: { templateId, version: 1 } };
      await expect(wired.provisioning.seedActivityTaxonomy('66f0000000000000000000d1', source))
        .rejects.toThrow(/labels the summary tile CORE as Core and Inti/);
    });

    it('refuses to build an office from a published template whose tile code a section outside it carries', async () => {
      const payload = taxonomy([
        { code: 'SELLING', label: 'Selling', displayOrder: 1, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'RECRUITMENT', label: 'Recruitment', displayOrder: 2, summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'CORE', label: 'Core skills', displayOrder: 3 },
      ]);

      await expect(wired.provisioning.seedActivityTaxonomy('66f0000000000000000000d1', {
        payload, seededFrom: { templateId: null, version: 1 },
      })).rejects.toThrow(/gives the summary tile CORE the code of a section outside it/);
    });
  });
});
