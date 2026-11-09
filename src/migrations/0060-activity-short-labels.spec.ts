import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0060-activity-short-labels';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * **ADR-0229 §5 for offices that already exist** (P19.8-T4 AC-13; MOB UI-180): each type of a seeded code with no *Nama
 * singkat* is given the approved words by code, in the working copy and the newest snapshot; an office's own words and
 * its own codes are left alone, a deleted row too; no version moves; a second run writes nothing.
 */
describe('0060 — the activity types’ short names (ADR-0229 §5)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const type = (code: string, extra: Record<string, unknown> = {}) => ({
    code, label: `Label ${code}`, description: null, displayOrder: 1, version: 3, status: 'active', archivedAt: null,
    deletedAt: null, ...extra,
  });
  const snapshot = (kpmId: string, version: number, types: Record<string, unknown>[]) => ({
    kpmId, version, sourceVersion: 3, publishedAt: new Date(), publishedBy: null, deletedAt: null,
    payload: { activity: [{ code: 'SELLING', label: 'Penjualan', types }], ratios: [] },
  });
  const row = (kpmId: string, code: string) => db().collection('activityTypes').findOne({ kpmId, code });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['activityTypes', 'configSnapshots', 'companyTemplates']) await db().collection(name).deleteMany({});
    await db().collection('activityTypes').insertMany([
      // A: provisioned before the field — no key at all; one archived, one blank.
      { kpmId: KPM_A, ...type('SELL_SUBMISSION') },
      { kpmId: KPM_A, ...type('SELL_PRESENTATION', { status: 'archived', archivedAt: new Date() }) },
      { kpmId: KPM_A, ...type('LEADS_CONTACTED', { shortLabel: '' }) },
      // A deleted row is never written.
      { kpmId: KPM_A, ...type('SELL_FOLLOWUP', { deletedAt: new Date() }) },
      // B: an Owner's own short name, a `null` one, and a code of the office's own.
      { kpmId: KPM_B, ...type('SELL_SUBMISSION', { shortLabel: 'SPAJ' }) },
      { kpmId: KPM_B, ...type('DEV_TEAM_ACTIVITY', { shortLabel: null }) },
      { kpmId: KPM_B, ...type('OFFICE_CALLS') },
    ]);
    await db().collection('configSnapshots').insertMany([
      snapshot(KPM_A, 1, [type('SELL_SUBMISSION')]),
      snapshot(KPM_A, 2, [type('SELL_SUBMISSION'), type('OFFICE_CALLS')]),
      snapshot(KPM_B, 1, [type('SELL_SUBMISSION', { shortLabel: 'SPAJ' })]),
    ]);
    await db().collection('companyTemplates').insertOne(
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'published', version: 2, payload: { categories: [], types: [type('SELL_SUBMISSION')] } },
    );
  });

  it('P19.8-T4 AC-13 MOB UI-180 gives a type of a seeded code with none its short name, by code; keeps an office’s own', async () => {
    // A's three (archived and blank included) and B's `null` one.
    expect(await up(db())).toEqual({ types: 4, snapshots: 1 });

    expect(await row(KPM_A, 'SELL_SUBMISSION')).toMatchObject({ shortLabel: 'Submission polis', version: 3 });
    expect(await row(KPM_A, 'SELL_PRESENTATION')).toMatchObject({ shortLabel: 'Presentasi', status: 'archived' });
    expect(await row(KPM_A, 'LEADS_CONTACTED')).toMatchObject({ shortLabel: 'Set appointment' });
    expect(await row(KPM_A, 'SELL_FOLLOWUP')).not.toHaveProperty('shortLabel');
    expect(await row(KPM_B, 'SELL_SUBMISSION')).toMatchObject({ shortLabel: 'SPAJ' });
    expect(await row(KPM_B, 'DEV_TEAM_ACTIVITY')).toMatchObject({ shortLabel: 'Team development' });
    expect(await row(KPM_B, 'OFFICE_CALLS')).not.toHaveProperty('shortLabel');

    // The newest snapshot only; its office's own code untouched.
    const snaps = await db().collection('configSnapshots').find({ kpmId: KPM_A }).sort({ version: 1 }).toArray();
    expect(snaps[0].payload.activity[0].types[0]).not.toHaveProperty('shortLabel');
    expect(snaps[1].payload.activity[0].types).toEqual([
      expect.objectContaining({ code: 'SELL_SUBMISSION', shortLabel: 'Submission polis' }),
      expect.not.objectContaining({ shortLabel: expect.anything() }),
    ]);
    // A template is never written: a type without the key gives the seed's words when it is used.
    const [template] = await db().collection('companyTemplates').find().toArray();
    expect(template.payload.types[0]).not.toHaveProperty('shortLabel');
  });

  it('P19.8-T4 AC-13 MOB UI-180 run twice, the second writes nothing', async () => {
    await up(db());
    const before = await db().collection('activityTypes').find().sort({ kpmId: 1, code: 1 }).toArray();
    expect(await up(db())).toEqual({ types: 0, snapshots: 0 });
    expect(await db().collection('activityTypes').find().sort({ kpmId: 1, code: 1 }).toArray()).toEqual(before);
  });
});
