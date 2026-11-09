import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0033-ratio-benchmarks-iv';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * **ADR-0160 §2 for offices that already exist** (P18.5-T9 AC-2): the four benchmarks, *Set appointment to
 * meeting*'s name and its unit move in the working copy, the newest snapshot agents read, and every Company
 * template — each only where it still holds the seeded value, the formula untouched, no version moving, and a
 * second run doing nothing.
 */
describe('0033 — the client’s benchmarks and Set appointment to meeting (ADR-0160 §2)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const ratio = (code: string, over: Record<string, unknown> = {}) => ({
    code, label: code, numerator: ['A'], denominator: ['B'], benchmark: 0.15, comparison: 'gte', displayUnit: 'percent',
    displayOrder: 1, version: 2, status: 'active', archivedAt: null, deletedAt: null, ...over,
  });
  /** The five as the seed gave them before ADR-0160. */
  const seeded = () => [
    ratio('SELLING_VS_RECRUITMENT', { label: 'Selling vs Recruitment', benchmark: 30, comparison: 'band', displayUnit: 'points' }),
    ratio('SELLING_SUCCESS_RATE', { label: 'Selling success rate' }),
    ratio('RECRUITMENT_SUCCESS_RATE', { label: 'Recruitment success rate' }),
    ratio('LEADS_PER_ACTIVITY', { label: 'Leads per activity', benchmark: 0.3, displayUnit: 'decimal' }),
    ratio('MEETING_PER_APPROACH', {
      label: 'Meeting per approach', numerator: ['SELL_PRESENTATION', 'RECRUIT_PRESENTATION'], denominator: ['LEADS_CONTACTED'],
      benchmark: 1.5, displayUnit: 'decimal',
    }),
  ];
  const fields = (rows: Record<string, unknown>[]) => rows.map((r) => [r.code, r.label, r.benchmark, r.displayUnit]);
  const NEW = [
    ['SELLING_VS_RECRUITMENT', 'Selling vs Recruitment', 30, 'points'],
    ['SELLING_SUCCESS_RATE', 'Selling success rate', 0.3, 'percent'],
    ['RECRUITMENT_SUCCESS_RATE', 'Recruitment success rate', 0.3, 'percent'],
    ['LEADS_PER_ACTIVITY', 'Leads per activity', 1, 'decimal'],
    ['MEETING_PER_APPROACH', 'Set appointment to meeting', 0.5, 'percent'],
  ];
  const snapshot = (kpmId: string, version: number, ratios: Record<string, unknown>[]) => ({
    kpmId, version, sourceVersion: 2, publishedAt: new Date(), publishedBy: null, deletedAt: null, payload: { activity: [], ratios },
  });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    // No model is registered for these in this file, so `clearCollections` does not reach them.
    for (const name of ['ratioDefinitions', 'configSnapshots', 'companyTemplates']) await db().collection(name).deleteMany({});
    await db().collection('ratioDefinitions').insertMany([
      ...seeded().map((r, i) => ({ kpmId: KPM_A, ...r, displayOrder: i + 1 })),
      // B: an Owner who set their own selling benchmark, renamed the fifth and left its benchmark and unit.
      { kpmId: KPM_B, ...ratio('SELLING_SUCCESS_RATE', { label: 'Selling success rate', benchmark: 0.2 }) },
      { kpmId: KPM_B, ...ratio('MEETING_PER_APPROACH', { label: 'Approach ratio', benchmark: 1.5, displayUnit: 'decimal' }) },
      // An office's own ratio holding the seeded number is not one of the five.
      { kpmId: KPM_B, ...ratio('REFERRAL_RATE', { benchmark: 0.15 }) },
    ]);
    await db().collection('configSnapshots').insertMany([
      snapshot(KPM_A, 1, seeded()), snapshot(KPM_A, 2, seeded()),
      snapshot(KPM_B, 1, [ratio('SELLING_SUCCESS_RATE', { label: 'Selling success rate', benchmark: 0.2 })]),
    ]);
    await db().collection('companyTemplates').insertMany([
      { companyId: 'c1', kind: 'ratio_set', status: 'published', version: 2, payload: { ratios: seeded() } },
      { companyId: 'c1', kind: 'ratio_set', status: 'draft', version: 3, payload: { ratios: [ratio('SELLING_SUCCESS_RATE', { benchmark: 0.25 })] } },
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'published', version: 1, payload: { ratios: seeded() } },
    ]);
  });

  it('P18.5-T9 AC-2 moves the seeded values in the working copy, the newest snapshot and the templates, versions kept', async () => {
    // A's four; B's fifth, whose benchmark and unit are the seed's though its name is the Owner's.
    expect(await up(db())).toEqual({ ratios: 5, snapshots: 1, templates: 1 });

    const a = await db().collection('ratioDefinitions').find({ kpmId: KPM_A }).sort({ displayOrder: 1 }).toArray();
    expect(fields(a)).toEqual(NEW);
    expect(a.every((r) => r.version === 2)).toBe(true);
    // The formula is not touched.
    expect(a[4]).toMatchObject({ numerator: ['SELL_PRESENTATION', 'RECRUIT_PRESENTATION'], denominator: ['LEADS_CONTACTED'], comparison: 'gte' });

    const snaps = await db().collection('configSnapshots').find({ kpmId: KPM_A }).sort({ version: 1 }).toArray();
    // The newest, which agents read; the older one is history.
    expect(fields(snaps[0].payload.ratios)[4]).toEqual(['MEETING_PER_APPROACH', 'Meeting per approach', 1.5, 'decimal']);
    expect(fields(snaps[1].payload.ratios)).toEqual(NEW);

    const templates = await db().collection('companyTemplates').find({}).sort({ version: 1 }).toArray();
    expect(templates.map((t) => [t.kind, t.version])).toEqual([['activity_taxonomy', 1], ['ratio_set', 2], ['ratio_set', 3]]);
    // Another kind holding the same values is not a ratio set.
    expect(templates[0].payload.ratios[1].benchmark).toBe(0.15);
    expect(fields(templates[1].payload.ratios)).toEqual(NEW);
    expect(templates[2].payload.ratios[0].benchmark).toBe(0.25);
  });

  it('P18.5-T9 AC-2 leaves an Owner’s own values alone, each field on its own', async () => {
    await up(db());
    const b = await db().collection('ratioDefinitions').find({ kpmId: KPM_B }).toArray();
    expect(fields(b)).toEqual([
      ['SELLING_SUCCESS_RATE', 'Selling success rate', 0.2, 'percent'],
      // Their name stands; the seed's benchmark and unit move.
      ['MEETING_PER_APPROACH', 'Approach ratio', 0.5, 'percent'],
      ['REFERRAL_RATE', 'REFERRAL_RATE', 0.15, 'percent'],
    ]);
    expect((await db().collection('configSnapshots').findOne({ kpmId: KPM_B }))!.payload.ratios[0].benchmark).toBe(0.2);
  });

  it('P18.5-T9 AC-2 moves no unit onto a ratio an Owner turned into a balance', async () => {
    await db().collection('ratioDefinitions').updateOne(
      { kpmId: KPM_A, code: 'MEETING_PER_APPROACH' }, { $set: { comparison: 'band', displayUnit: 'decimal' } },
    );
    await up(db());
    expect(await db().collection('ratioDefinitions').findOne({ kpmId: KPM_A, code: 'MEETING_PER_APPROACH' }))
      .toMatchObject({ comparison: 'band', displayUnit: 'decimal', benchmark: 0.5 });
  });

  it('P18.5-T9 AC-2 is idempotent: a second run writes nothing', async () => {
    await up(db());
    expect(await up(db())).toEqual({ ratios: 0, snapshots: 0, templates: 0 });
  });

  it('P18.5-T9 AC-2 passes over a snapshot published without ratios', async () => {
    await db().collection('configSnapshots').insertOne({
      kpmId: KPM_B, version: 2, sourceVersion: 1, publishedAt: new Date(), publishedBy: null, deletedAt: null, payload: { activity: [] },
    });
    await expect(up(db())).resolves.toMatchObject({ snapshots: 1 });
    expect((await db().collection('configSnapshots').findOne({ kpmId: KPM_B, version: 2 }))!.payload).toEqual({ activity: [] });
  });
});
