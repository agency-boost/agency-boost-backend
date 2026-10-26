import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0034-activity-bindings';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const NOW = new Date('2026-10-26T02:00:00.000Z');
const TODAY = { leads: ['LEADS_CONTACTED'], appointments: ['SELL_PRESENTATION'], closings: ['SELL_SUBMISSION'] };

/**
 * **ADR-0163 §1 for offices and templates that already exist** (P18.9-T2 AC-1): every office is given a binding of
 * today's three codes in its working copy and its newest snapshot, and every `activity_taxonomy` template the same
 * three — each only where none is held, so an office already rebound keeps its binding and a second run does nothing.
 */
describe('0034 — every office and template binds today’s codes (ADR-0163 §1)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const snapshot = (kpmId: string, version: number) => ({
    kpmId, version, sourceVersion: 1, publishedAt: NOW, publishedBy: null, deletedAt: null, payload: { activity: [] },
  });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['kpms', 'activityBindings', 'configSnapshots', 'companyTemplates']) {
      await db().collection(name).deleteMany({});
    }
    await db().collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(KPM_A), code: '0417', deletedAt: null },
      { _id: new mongoose.Types.ObjectId(KPM_B), code: '0418', deletedAt: null },
      // A deleted office is given nothing.
      { _id: new mongoose.Types.ObjectId(), code: '0419', deletedAt: NOW },
    ]);
    // B was provisioned after the code shipped, and its Super Admin has already rebound it.
    await db().collection('activityBindings').insertOne({
      kpmId: KPM_B, leads: ['LEADS_CONTACTED'], appointments: ['SELL_PRESENTATION', 'SALES_MEETING'],
      closings: ['SELL_SUBMISSION'], version: 2, status: 'active', archivedAt: null, deletedAt: null,
      createdAt: NOW, updatedAt: NOW,
    });
    await db().collection('configSnapshots').insertMany([snapshot(KPM_A, 1), snapshot(KPM_A, 2), snapshot(KPM_B, 1)]);
    await db().collection('companyTemplates').insertMany([
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'published', version: 1, payload: { categories: [], types: [] }, deletedAt: null },
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'draft', version: 2, payload: { categories: [], types: [] }, deletedAt: null },
      // A template already carrying its own binding keeps it; another kind is not touched.
      {
        companyId: 'c1', kind: 'activity_taxonomy', status: 'draft', version: 3, deletedAt: null,
        payload: { categories: [], types: [], bindings: { ...TODAY, leads: ['CALLS'] } },
      },
      { companyId: 'c1', kind: 'ratio_set', status: 'published', version: 1, payload: { ratios: [] }, deletedAt: null },
    ]);
  });

  it('P18.9-T2 AC-1 writes today’s three into every office, its newest snapshot and every template, and only there', async () => {
    expect(await up(db(), NOW)).toEqual({ offices: 1, snapshots: 2, templates: 2 });

    const a = await db().collection('activityBindings').findOne({ kpmId: KPM_A });
    expect(a).toMatchObject({ ...TODAY, version: 1, status: 'active', archivedAt: null, deletedAt: null });
    // B's own binding stands.
    const b = await db().collection('activityBindings').findOne({ kpmId: KPM_B });
    expect(b).toMatchObject({ appointments: ['SELL_PRESENTATION', 'SALES_MEETING'], version: 2 });
    expect(await db().collection('activityBindings').countDocuments({})).toBe(2);

    // The newest snapshot records the binding the office holds; the older one is history.
    const snaps = await db().collection('configSnapshots').find({ kpmId: KPM_A }).sort({ version: 1 }).toArray();
    expect(snaps[0].payload.activityBinding).toBeUndefined();
    expect(snaps[1].payload.activityBinding).toEqual({ ...TODAY, version: 1, updatedAt: NOW.toISOString() });
    const bSnap = await db().collection('configSnapshots').findOne({ kpmId: KPM_B });
    expect(bSnap?.payload.activityBinding).toMatchObject({ appointments: ['SELL_PRESENTATION', 'SALES_MEETING'], version: 2 });

    const templates = await db().collection('companyTemplates').find({}).sort({ version: 1, kind: 1 }).toArray();
    expect(templates.map((t) => [t.kind, t.version, t.payload.bindings])).toEqual([
      ['activity_taxonomy', 1, TODAY],
      ['ratio_set', 1, undefined],
      ['activity_taxonomy', 2, TODAY],
      ['activity_taxonomy', 3, { ...TODAY, leads: ['CALLS'] }],
    ]);
  });

  it('P18.9-T2 AC-1 a second run writes nothing', async () => {
    await up(db(), NOW);
    expect(await up(db(), new Date('2026-10-27T02:00:00.000Z'))).toEqual({ offices: 0, snapshots: 0, templates: 0 });
    const a = await db().collection('activityBindings').findOne({ kpmId: KPM_A });
    expect(a?.updatedAt).toEqual(NOW);
  });
});
