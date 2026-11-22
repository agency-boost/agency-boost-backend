import mongoose from 'mongoose';
import { startMongo, stopMongo } from '../../test/mongo';
import { up } from './0062-subgroup-targets-by-year';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

/**
 * **ADR-0253 §4 for the targets that came before** (P19.13-T3 AC-2; UI-199, D2): each sub-group row given its office's
 * current year; the one-per-leader-and-year index built and the one-per-head index dropped; a MAPA row untouched; a second
 * run does nothing.
 */
describe('0062 — sub-group targets per leader per year (ADR-0253 §4)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const targets = () => db().collection('analyticsTargets');

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.13-T3 AC-2 dates every sub-group row in its office’s year, swaps the index, leaves MAPA alone; twice is once', async () => {
    // 31 December 2026 at 18:00 UTC is already 2027 in Jakarta — the office's clock decides, never the server's.
    const NOW = new Date('2026-12-31T18:00:00Z');
    await db().collection('kpms').insertMany([
      { _id: new mongoose.Types.ObjectId(KPM_A), timezone: 'Asia/Jakarta' },
      { _id: new mongoose.Types.ObjectId(KPM_B) },
    ]);
    await targets().createIndex(
      { kpmId: 1, kind: 1, headMembershipId: 1 },
      { unique: true, partialFilterExpression: { deletedAt: null, kind: 'subgroup' } },
    );
    await targets().insertMany([
      { kpmId: KPM_A, kind: 'subgroup', headMembershipId: 'agus', aaTarget: 4, recTarget: 8, month: null, row: null, deletedAt: null },
      { kpmId: KPM_B, kind: 'subgroup', headMembershipId: 'lina', aaTarget: 2, recTarget: 3, month: null, row: null, deletedAt: null },
      { kpmId: KPM_A, kind: 'subgroup', headMembershipId: 'dated', year: '2026', aaTarget: 1, recTarget: 1, deletedAt: null },
      { kpmId: KPM_A, kind: 'mapa', month: '2026-11', row: 'ape', value: 1, headMembershipId: null, deletedAt: null },
    ]);

    expect(await up(db(), NOW)).toEqual({ dated: 2, created: true, dropped: true });
    expect(await targets().findOne({ headMembershipId: 'agus' })).toMatchObject({ year: '2027', aaTarget: 4, recTarget: 8 });
    expect(await targets().findOne({ headMembershipId: 'lina' })).toMatchObject({ year: '2027' });
    expect(await targets().findOne({ headMembershipId: 'dated' })).toMatchObject({ year: '2026' });
    expect(await targets().findOne({ kind: 'mapa' })).not.toHaveProperty('year');
    const names = (await targets().indexes()).map((i) => i.name);
    expect(names).toContain('one_subgroup_target_per_leader_and_year');
    expect(names).not.toContain('kpmId_1_kind_1_headMembershipId_1');

    // A leader may now hold a row for another year; the same leader and year twice is still refused.
    await targets().insertOne({ kpmId: KPM_A, kind: 'subgroup', headMembershipId: 'agus', year: '2028', aaTarget: 1, recTarget: 1, deletedAt: null });
    await expect(targets().insertOne({ kpmId: KPM_A, kind: 'subgroup', headMembershipId: 'agus', year: '2028', deletedAt: null }))
      .rejects.toMatchObject({ code: 11000 });

    expect(await up(db(), NOW)).toEqual({ dated: 0, created: false, dropped: false });
  });

  it('does nothing with no analyticsTargets collection, and makes none', async () => {
    expect(await up(db(), new Date())).toEqual({ dated: 0, created: false, dropped: false });
    expect(await db().listCollections({ name: 'analyticsTargets' }).toArray()).toEqual([]);
  });
});
