import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { configModule, provisionOffice } from '../../test/config-module';
import { up } from './0021-activity-category-summary-group';

const NOW = new Date('2026-09-30T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const owner = (kpmId: string) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
});

/** The tiles a set of sections draws: code → label, in the order first met. */
const tilesOf = (rows: { code: string; summaryGroupCode?: string | null; summaryGroupLabel?: string | null }[]) =>
  Object.fromEntries(rows.map((r) => [r.code, [r.summaryGroupCode ?? null, r.summaryGroupLabel ?? null]]));

/**
 * ADR-0064, P10.1-T5 AC-5. Existing offices get the prototype's four tiles in what their Owner edits
 * **and** in what their agents already read, with no version moving — so the strip changes without
 * anybody publishing, and the publish bar says nothing it did not say before.
 */
describe('0021 — the summary tiles for offices and templates that already exist', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const categories = () => db().collection('activityCategories');
  const snapshots = () => db().collection('configSnapshots');
  const templates = () => db().collection('companyTemplates');

  /** Rows as they were before the field existed: no key at all, in the working copy and the snapshot. */
  async function beforeTheField(kpmId: string): Promise<void> {
    await categories().updateMany({ kpmId }, { $unset: { summaryGroupCode: '', summaryGroupLabel: '' } });
    await snapshots().updateMany({ kpmId }, {
      $unset: { 'payload.activity.$[].summaryGroupCode': '', 'payload.activity.$[].summaryGroupLabel': '' },
    });
  }

  /** An office provisioned, given a section of its own, published, and then aged to before 0021. */
  async function existingOffice(kpmId: string, code: string): Promise<void> {
    await (wired.kpms as unknown as mongoose.Model<never>).create({
      _id: kpmId, companyId: COMPANY, code, branchName: code, timezone: 'Asia/Jakarta',
    } as never);
    await provisionOffice(wired, kpmId, COMPANY);
    await wired.activity.createCategory(owner(kpmId), { code: 'REFERRALS', label: 'Referrals' });
    await wired.config.publish(owner(kpmId));
    await beforeTheField(kpmId);
  }

  const working = async (kpmId: string) =>
    (await categories().find({ kpmId }).sort({ displayOrder: 1 }).toArray()) as never as {
      code: string; label: string; version: number; summaryGroupCode?: string | null; summaryGroupLabel?: string | null;
    }[];
  const published = async (kpmId: string) =>
    ((await snapshots().find({ kpmId }).sort({ version: -1 }).limit(1).toArray())[0]
      .payload as { activity: { code: string; summaryGroupCode?: string | null; summaryGroupLabel?: string | null }[] })
      .activity;

  // A tile of one carries neither field (OD-101): its label is its section's, and follows it.
  const SEEDED = {
    LEADS_GENERATION: [null, null],
    SELLING: [null, null],
    RECRUITMENT: [null, null],
    PERSONAL_DEVELOPMENT: ['DEVELOPMENT', 'Development'],
    TEAM_DEVELOPMENT: ['DEVELOPMENT', 'Development'],
  };

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as unknown as mongoose.Model<never>).create({ _id: COMPANY, name: 'Prudential', slug: 'p' } as never);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
  });

  describe('an office', () => {
    it('gets the seed’s tiles in the working copy and in what agents read; its own section, none', async () => {
      await existingOffice(KPM_A, '0417');
      expect((await working(KPM_A)).every((r) => !('summaryGroupCode' in r))).toBe(true);

      expect(await up(db())).toEqual({ offices: 1, categories: 6, snapshots: 1, templates: 0 });

      const expected = { ...SEEDED, REFERRALS: [null, null] };
      expect(tilesOf(await working(KPM_A))).toEqual(expected);
      expect(tilesOf(await published(KPM_A))).toEqual(expected);

      // What `GET /kpm/config` serves: the published copy, with the strip's four tiles.
      const served = (await wired.config.readPublished(owner(KPM_A))).activity;
      expect(tilesOf(served)).toEqual(expected);
    });

    it('moves no version, and leaves the publish bar as it was', async () => {
      await existingOffice(KPM_A, '0417');
      const versions = (await working(KPM_A)).map((r) => [r.code, r.version]);
      const [snapshot] = await snapshots().find({ kpmId: KPM_A }).toArray();
      expect((await wired.config.state(owner(KPM_A))).hasUnpublishedChanges).toBe(false);

      await up(db());

      expect((await working(KPM_A)).map((r) => [r.code, r.version])).toEqual(versions);
      const after = await snapshots().find({ kpmId: KPM_A }).toArray();
      expect(after.map((s) => s.version)).toEqual([snapshot.version]);
      expect((await wired.config.state(owner(KPM_A))).hasUnpublishedChanges).toBe(false);
    });

    it('keeps a pending change pending, and nothing more', async () => {
      await existingOffice(KPM_A, '0417');
      const selling = (await wired.activity.list(owner(KPM_A))).find((c) => c.code === 'SELLING')!;
      await wired.activity.updateCategory(owner(KPM_A), selling.id, { label: 'Penjualan langsung' });
      await beforeTheField(KPM_A);

      await up(db());

      expect((await wired.config.state(owner(KPM_A))).hasUnpublishedChanges).toBe(true);
      // A tile of one carries neither field in either copy: its label is the section's, so the
      // Owner's unpublished rename is the only thing pending, and the tile follows it on publish.
      expect(tilesOf(await working(KPM_A)).SELLING).toEqual([null, null]);
      expect(tilesOf(await published(KPM_A)).SELLING).toEqual([null, null]);
      const label = async () => ((await published(KPM_A)) as { code: string; label?: string }[])
        .find((r) => r.code === 'SELLING')!.label;
      expect(await label()).toBe(selling.label);
      await wired.config.publish(owner(KPM_A));
      expect(await label()).toBe('Penjualan langsung');
    });

    it('does not relabel a development section the office holds alone', async () => {
      await existingOffice(KPM_A, '0417');
      await categories().updateOne({ kpmId: KPM_A, code: 'TEAM_DEVELOPMENT' }, { $set: { code: 'COACHING' } });

      await up(db());

      const tiles = tilesOf(await working(KPM_A));
      expect(tiles.PERSONAL_DEVELOPMENT).toEqual([null, null]);
      expect(tiles.COACHING).toEqual([null, null]);
      expect(tiles.SELLING).toEqual([null, null]);
    });

    it('leaves a decided section alone, and never joins a tile code the office already uses', async () => {
      await existingOffice(KPM_A, '0417');
      await categories().updateOne(
        { kpmId: KPM_A, code: 'REFERRALS' },
        { $set: { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Growth' } },
      );

      await up(db());

      const tiles = tilesOf(await working(KPM_A));
      expect(tiles.REFERRALS).toEqual(['DEVELOPMENT', 'Growth']);
      // Joining would split *Growth* and *Development* across one tile: each keeps a tile of its own.
      expect(tiles.PERSONAL_DEVELOPMENT).toEqual([null, null]);
      expect(tiles.TEAM_DEVELOPMENT).toEqual([null, null]);
    });

    it('counts archived sections, which still render the days they hold', async () => {
      await existingOffice(KPM_A, '0417');
      await categories().updateOne({ kpmId: KPM_A, code: 'TEAM_DEVELOPMENT' }, { $set: { status: 'archived' } });

      await up(db());

      expect(tilesOf(await working(KPM_A)).TEAM_DEVELOPMENT).toEqual(['DEVELOPMENT', 'Development']);
    });

    it('reaches every office, and each by its own rows', async () => {
      await existingOffice(KPM_A, '0417');
      await existingOffice(KPM_B, '0555');
      await categories().updateOne({ kpmId: KPM_B, code: 'RECRUITMENT' }, { $set: { label: 'Rekrutmen' } });

      expect(await up(db())).toMatchObject({ offices: 2, categories: 12, snapshots: 2 });
      // Each office's own rows decide it: B's *Rekrutmen* keeps its name, and its tile is that name.
      expect(tilesOf(await working(KPM_A)).RECRUITMENT).toEqual([null, null]);
      expect(tilesOf(await working(KPM_B)).RECRUITMENT).toEqual([null, null]);
      expect((await working(KPM_B)).find((r) => r.code === 'RECRUITMENT')!.label).toBe('Rekrutmen');
    });
  });

  describe('Company templates', () => {
    const payload = () => ({
      categories: [
        { code: 'LEADS_GENERATION', label: 'Leads Generation', displayOrder: 1 },
        { code: 'SELLING', label: 'Selling', displayOrder: 2 },
        { code: 'PERSONAL_DEVELOPMENT', label: 'Personal Development', displayOrder: 3 },
        { code: 'TEAM_DEVELOPMENT', label: 'Team Development', displayOrder: 4 },
        { code: 'BRANDING', label: 'Branding', displayOrder: 5 },
      ],
      types: [{ code: 'X_ONE', categoryCode: 'SELLING', label: 'x', displayOrder: 1 }],
    });

    it('get the seed’s tiles, draft and published, with no version moving', async () => {
      await templates().insertMany([
        { companyId: COMPANY, kind: 'activity_taxonomy', status: 'published', version: 3, deletedAt: null, payload: payload() },
        { companyId: COMPANY, kind: 'activity_taxonomy', status: 'draft', version: 4, deletedAt: null, payload: payload() },
        { companyId: COMPANY, kind: 'lead_pipeline', status: 'published', version: 1, deletedAt: null, payload: { statuses: [] } },
      ]);

      expect(await up(db())).toEqual({ offices: 0, categories: 0, snapshots: 0, templates: 2 });

      for (const row of await templates().find({ kind: 'activity_taxonomy' }).toArray()) {
        expect(tilesOf((row.payload as ReturnType<typeof payload>).categories)).toEqual({
          LEADS_GENERATION: [null, null],
          SELLING: [null, null],
          PERSONAL_DEVELOPMENT: ['DEVELOPMENT', 'Development'],
          TEAM_DEVELOPMENT: ['DEVELOPMENT', 'Development'],
          BRANDING: [null, null],
        });
        // `RECRUITMENT` is absent from this template, so it is simply not there to group.
        expect(row.payload.types).toEqual(payload().types);
      }
      expect((await templates().find({ kind: 'activity_taxonomy' }).sort({ version: 1 }).toArray())
        .map((t) => [t.status, t.version])).toEqual([['published', 3], ['draft', 4]]);
      expect((await templates().findOne({ kind: 'lead_pipeline' }))!.payload).toEqual({ statuses: [] });
    });

    it('and a new office built from one starts on them', async () => {
      await templates().insertOne({
        companyId: COMPANY, kind: 'activity_taxonomy', status: 'published', version: 1, deletedAt: null, payload: payload(),
      });
      await up(db());
      await (wired.kpms as unknown as mongoose.Model<never>).create({
        _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
      } as never);

      // Built from the template itself, as provisioning hands it a source: the platform's defaults say *Pengembangan*
      // since P18.10-T7, so only the template's own tile reads *Development*.
      const template = await templates().findOne({ kind: 'activity_taxonomy' });
      await wired.provisioning.seedActivityTaxonomy(KPM_A, {
        payload: template!.payload as Record<string, unknown>, seededFrom: { templateId: null, version: 1 },
      });

      expect(tilesOf(await working(KPM_A)).TEAM_DEVELOPMENT).toEqual(['DEVELOPMENT', 'Development']);
    });
  });

  describe('safe to run twice', () => {
    it('writes nothing the second time', async () => {
      await existingOffice(KPM_A, '0417');
      await templates().insertOne({
        companyId: COMPANY, kind: 'activity_taxonomy', status: 'draft', version: 1, deletedAt: null,
        payload: { categories: [{ code: 'SELLING', label: 'Selling', displayOrder: 1 }], types: [] },
      });
      await up(db());
      const [rows, snapshot, template] = await Promise.all([
        working(KPM_A), published(KPM_A), templates().findOne({}),
      ]);

      expect(await up(db())).toEqual({ offices: 0, categories: 0, snapshots: 0, templates: 0 });
      expect(await working(KPM_A)).toEqual(rows);
      expect(await published(KPM_A)).toEqual(snapshot);
      expect(await templates().findOne({})).toEqual(template);
    });

    it('finishes a run stopped after the snapshot, from the same decision', async () => {
      await existingOffice(KPM_A, '0417');
      await up(db());
      // As if the run had stopped between the two writes.
      await categories().updateMany({ kpmId: KPM_A }, { $unset: { summaryGroupCode: '', summaryGroupLabel: '' } });

      expect(await up(db())).toMatchObject({ offices: 1, categories: 6, snapshots: 0 });
      expect(tilesOf(await working(KPM_A))).toEqual(tilesOf(await published(KPM_A)));
      expect((await wired.config.state(owner(KPM_A))).hasUnpublishedChanges).toBe(false);
    });

    it('does nothing to an empty database', async () => {
      expect(await up(db())).toEqual({ offices: 0, categories: 0, snapshots: 0, templates: 0 });
    });
  });
});
