import mongoose from 'mongoose';
import { SEEDED_SALES_SUBTITLE_BEFORE_OD_150 } from '@/domain/constants/training-taxonomy';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0029-training-sales-subtitle';

const OLD = SEEDED_SALES_SUBTITLE_BEFORE_OD_150;
const NEW = 'Structured modules — tracked here.';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * **OD-150 for offices that already exist** (P18.5-T1): Sales's seeded subtitle loses its Skill Tracker promise in
 * the working copy, the newest snapshot agents read, and every Company template — only where the words are still the
 * seeded ones, with no version moving, and a second run doing nothing.
 */
describe('0029 — Sales’s subtitle without the Skill Tracker promise (OD-150)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const category = (kpmId: string, description: string | null) => ({
    kpmId, code: 'SALES', label: 'Sales', description, displayOrder: 1, version: 3, status: 'active', archivedAt: null, deletedAt: null,
  });
  const snapshot = (kpmId: string, version: number, description: string | null) => ({
    kpmId, version, sourceVersion: 1, publishedAt: new Date(), publishedBy: null, deletedAt: null,
    payload: { training: [{ code: 'SALES', label: 'Sales', description, version: 3 }, { code: 'PRODUCT', description: OLD }] },
  });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await db().collection('trainingCategories').insertMany([category(KPM_A, OLD), category(KPM_B, 'Our own words.')]);
    await db().collection('configSnapshots').insertMany([
      snapshot(KPM_A, 1, OLD), snapshot(KPM_A, 2, OLD), snapshot(KPM_B, 1, 'Our own words.'),
    ]);
    await db().collection('companyTemplates').insertMany([
      { companyId: 'c1', kind: 'training_taxonomy', status: 'published', version: 2, payload: { categories: [{ code: 'SALES', label: 'Sales', description: OLD }] } },
      { companyId: 'c1', kind: 'training_taxonomy', status: 'draft', version: 3, payload: { categories: [{ code: 'SALES', label: 'Sales', description: 'Edited.' }] } },
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'published', version: 1, payload: { categories: [{ code: 'SALES', description: OLD }] } },
    ]);
  });

  it('P18.5-T1 OD-150 rewrites the seeded words in the working copy, the newest snapshot and the templates, versions kept', async () => {
    expect(await up(db())).toEqual({ categories: 1, snapshots: 1, templates: 1 });

    const a = await db().collection('trainingCategories').findOne({ kpmId: KPM_A });
    expect(a).toMatchObject({ description: NEW, version: 3 });
    const snaps = await db().collection('configSnapshots').find({ kpmId: KPM_A }).sort({ version: 1 }).toArray();
    // The newest, which agents read; the older one is history.
    expect(snaps.map((s) => s.payload.training[0].description)).toEqual([OLD, NEW]);
    // Only Sales: another category holding the same words is not the seeded Sales subtitle.
    expect(snaps[1].payload.training[1].description).toBe(OLD);
    const templates = await db().collection('companyTemplates').find({}).sort({ version: 1 }).toArray();
    expect(templates.map((t) => [t.kind, t.version, t.payload.categories[0].description])).toEqual([
      ['activity_taxonomy', 1, OLD], ['training_taxonomy', 2, NEW], ['training_taxonomy', 3, 'Edited.'],
    ]);
  });

  it('P18.5-T1 OD-150 leaves an office’s own words alone', async () => {
    await up(db());
    expect(await db().collection('trainingCategories').findOne({ kpmId: KPM_B })).toMatchObject({ description: 'Our own words.' });
    expect((await db().collection('configSnapshots').findOne({ kpmId: KPM_B }))!.payload.training[0].description).toBe('Our own words.');
  });

  it('P18.5-T1 OD-150 is idempotent: a second run writes nothing', async () => {
    await up(db());
    expect(await up(db())).toEqual({ categories: 0, snapshots: 0, templates: 0 });
  });
});
